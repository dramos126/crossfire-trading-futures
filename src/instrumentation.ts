/**
 * Next.js instrumentation hook — runs once per server process at boot,
 * before any request is served. Calls into the shared boot helper at
 * `@/lib/trading/boot-engine` so the cold-start path and the wizard's
 * activateFromSettings path execute identical sequences (allowlist +
 * session-migration + orphan check + eng.start).
 *
 * Boot needs ANY configured broker, not Topstep specifically. Topstep's
 * credentials resolve DB-first then fall back to env vars
 * (TOPSTEP_USERNAME + TOPSTEP_API_KEY); Tradovate's are DB-only. If no
 * broker has creds we enter passive-no-creds mode: the engine singleton
 * is NOT constructed, no SignalR, no boot. A first run on the Settings
 * page writes creds via /api/settings/setup which then calls
 * engine.activateFromSettings() to wake the engine.
 *
 * The env→DB promotion below stays Topstep-only because only Topstep has
 * env fallbacks to promote.
 *
 * Lives in src/ (not project root) because this project uses the src/
 * directory convention (see src/middleware.ts) — Next.js looks for
 * instrumentation alongside middleware, and the standalone build only
 * bundles the file from the matching location.
 *
 * Edge runtime is excluded — the engine uses better-sqlite3 + node fetch
 * + SignalR, all Node-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Imported here, inside the branch, and nowhere else in this file: the
    // build compiles this file for the Edge runtime too, removes this branch
    // there, and so never meets the drain's `process.exit` — which it flags
    // when the import sits in a function the branch merely calls.
    const { armShutdownExit } = await import("@/lib/shutdown-drain");
    await registerNode(armShutdownExit);
  }
}

async function registerNode(
  armShutdownExit: (signal: string, finalFlush: () => void, drainsOrderWork: boolean) => void,
): Promise<void> {
  const registerEnteredMs = performance.now();

  // Defer the imports so edge or build-time evaluation doesn't pull
  // SQLite + SignalR into a context that can't load them.
  const { awaitEngineSchema, getDb, markSchemaCurrent, registerAfterCloseHook } = await import(
    "@/lib/db/connection"
  );
  getDb();
  const dbOpenMs = performance.now();
  // Armed ahead of the no-credentials return: the dashboard's streams and
  // polls hold `server.close()` on an unconfigured install too. The boot
  // sequence's import graph loads the log store below anyway; it is named
  // here for the flush the exit makes.
  const { flushBeforeExit, startEngineLogFlush } = await import("@/lib/db/engine-logs");
  const { appRole, bootsAsStandby, readInternalSecret, runsEngine } = await import("@/lib/role");
  registerAfterCloseHook((signal) => armShutdownExit(signal, flushBeforeExit, runsEngine()));

  // The web role migrates nothing and boots nothing: it serves once the
  // engine process has brought the schema to this build's version. Its own
  // log lines still go to `engine_logs`, and only the store's flush timer
  // writes them — which the engine role starts when it builds an engine, and
  // a web process never builds one. Its retention sweep stays the engine's.
  if (!runsEngine()) {
    await awaitEngineSchema();
    startEngineLogFlush();
    return;
  }

  const { log } = await import("@/lib/logger");

  // An engine process without a usable secret would answer every web call
  // 500 and look up. Refused here instead, before the lease, so it builds
  // nothing and the reason is one error line rather than a 500 per request.
  if (appRole() === "engine") {
    const { problem } = readInternalSecret();
    if (problem !== null) {
      const { markBootAssertionFailed } = await import("@/lib/trading/engine/boot/boot-assertion");
      markBootAssertionFailed(problem);
      log.event("boot_refused", "engine", `boot: refused — ${problem}`);
      return;
    }
  }
  const { brokerRegistry } = await import("@/lib/brokers/registry-singleton");
  const { runBootSequence, runStandbyBoot, takeEngineLease } = await import(
    "@/lib/trading/engine/boot/boot-engine"
  );
  // The boot graph has registered — and so run — every migration by now.
  markSchemaCurrent();

  // A standby takes over a running engine (engine-boot.md, *Hand-off*): it is
  // an engine-role process with a broker to trade, or it is refused here and
  // the running engine is left alone.
  const standby = bootsAsStandby();
  const standbyProblem = !standby
    ? null
    : appRole() !== "engine"
      ? "CROSSFIRE_STANDBY=1 needs CROSSFIRE_ROLE=engine"
      : brokerRegistry.allPlugins().some((p) => p.isConfigured())
        ? null
        : "CROSSFIRE_STANDBY=1 on an install with no broker configured, so there is no engine to take over";
  if (standbyProblem) {
    const { markBootAssertionFailed } = await import("@/lib/trading/engine/boot/boot-assertion");
    markBootAssertionFailed(standbyProblem);
    log.event("boot_refused", "engine", `boot: refused — ${standbyProblem}`);
    return;
  }

  // Phase 6b passive-no-creds: if NO broker has credentials, do not boot.
  // A first run on the Settings page activates the engine after its confirm
  // via engine.activateFromSettings().
  //
  // Phase E3 widened this from "no Topstep credentials" to "no broker
  // credentials". It was the first of the four circular blockers: a
  // Tradovate-only install never booted, so `account_brokers` was never
  // seeded, so every account routed to Topstep. Topstep's `isConfigured()`
  // is still exactly `resolveTopstepUsername() && resolveTopstepApiKey()`,
  // so a Topstep-only install takes the identical branch it always did.
  const configured = brokerRegistry.allPlugins().filter((p) => p.isConfigured());
  if (configured.length === 0) {
    log.event(
      "boot_no_credentials",
      "engine",
      "boot: no creds — passive-no-creds mode (waiting for first-run setup on the Settings page)",
    );
    // The dashboard's routes build the engine through `getEngine()` before
    // the wizard boots it, and nothing is built without the lease.
    await takeEngineLease();
    return;
  }
  log.event(
    "boot_brokers_configured",
    "engine",
    `boot: configured brokers — ${configured.map((p) => p.id).join(", ")}`,
  );

  // Phase 6b env→DB credential promotion (post-ship bug fix 2026-05-02):
  // when creds resolved via env (DB rows are still empty), persist them
  // into DB now. Without this, removing the env vars after a successful
  // boot would put the operator back into passive-no-creds + wizard on
  // next restart — the resolver returns null because the DB never got
  // the values it had been seeing all along. Treat env as a one-time
  // bootstrap source: first successful boot promotes to DB, subsequent
  // boots resolve DB-first regardless of env state.
  //
  // Boot-time DB write is safe: instrumentation runs single-threaded
  // before any request handler. Wrapped in try/catch so a write failure
  // can't block engine boot — the env path keeps working as a fallback.
  try {
    const {
      getSetupSignature,
      setSetupSignature,
      setSetupConfirmedAt,
      getSetupConfirmedAt,
      getTopstepApiKey,
      getTopstepUsername,
      getTopstepWebhookUrl,
      setTopstepApiKey,
      setTopstepUsername,
    } = await import("@/lib/db/settings");
    const { invalidateSettingsCache } = await import("@/lib/db/settings-cache");
    const dbUsername = getTopstepUsername();
    const dbApiKey = getTopstepApiKey();
    const envUsername = process.env.TOPSTEP_USERNAME;
    const envApiKey = process.env.TOPSTEP_API_KEY;
    if (dbUsername === null && envUsername && envUsername.length > 0) {
      setTopstepUsername(envUsername);
      invalidateSettingsCache("topstep_username");
      log.event("db_migration_applied", "engine", "boot: promoted TOPSTEP_USERNAME from env to DB");
    }
    if (dbApiKey === null && envApiKey && envApiKey.length > 0) {
      setTopstepApiKey(envApiKey);
      invalidateSettingsCache("topstep_api_key");
      log.event("db_migration_applied", "engine", "boot: promoted TOPSTEP_API_KEY from env to DB");
    }

    // Phase 6b upgrade-path backfill (post-ship 2026-05-02): an existing
    // operator with creds already configured pre-6b has no
    // setup_confirmed_signature row. Without this, every dashboard mount
    // sees state B and the guard would force them through the wizard on
    // first browse after the upgrade. Configured creds are implicit
    // confirmation — compute and persist the signature now so the guard
    // passes through. Runs after the env→DB promotion so the signature
    // inputs (hasDbKey) reflect the post-promotion state.
    if (getSetupSignature() === null) {
      const { computeConfigSignature } = await import("@/lib/db/setup-signature");
      const signature = computeConfigSignature({
        username: getTopstepUsername() ?? (envUsername ?? null),
        hasDbKey: getTopstepApiKey() !== null,
        hasEnvKey: (envApiKey ?? "").length > 0,
        webhookUrl:
          getTopstepWebhookUrl() ?? (process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? null),
      });
      setSetupSignature(signature);
      if (getSetupConfirmedAt() === null) {
        setSetupConfirmedAt(new Date().toISOString());
      }
      log.event(
        "db_migration_applied",
        "engine",
        "boot: backfilled setup_confirmed_signature for pre-6b install",
      );
    }
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: env→DB promotion / signature backfill failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // Cold-start path: rethrowAllowlistFailure stays false so the
    // existing throw-then-log behavior is preserved. The wizard path
    // sets it to true so the route can return the failure inline.
    await (standby ? runStandbyBoot : runBootSequence)({
      rethrowAllowlistFailure: false,
      processMarks: { registerEnteredMs, dbOpenMs },
    });
  } catch (err) {
    // Don't crash the server on a boot-time engine failure — the user
    // can still trigger start manually from the UI.
    log.event("boot_refused", "engine", "boot: auto-start failed", { meta: err });
  }
}
