import type { TopstepClient } from "@/lib/brokers/topstep/client";
import { TopstepSignalR } from "@/lib/brokers/topstep/signalr";
import { TradingEngine, type EngineLog } from "@/lib/trading/engine/engine";
import { projectLogRecord, type RingLogEntry, type WireLogRecord } from "@/lib/logging/pipe";
import { getEngineToken } from "@/lib/brokers/topstep/auth";
import { hydrateRings, startEngineLogStore, clearPersistedLogs } from "@/lib/db/engine-logs";
import { setTradeWriteListener } from "@/lib/db/trades";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { holdsLease, reportLeaseRefused } from "@/lib/db/lease";
import { invalidateSettingsCache } from "@/lib/db/settings-cache";
import { EngineNotInThisProcessError, runsEngine } from "@/lib/role";
// Installs the log pipe's ring, store and escalation sinks at import, so they
// exist before any engine line is emitted; the handle imports it too.
import {
  logRings,
  MAX_HEARTBEAT_LOGS,
  MAX_LOGS,
  pushToRing,
} from "@/lib/trading/engine/engine-log-sinks";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { TopstepBrokerPlugin } from "@/lib/brokers/topstep/index";
import type { TradovateBrokerPlugin } from "@/lib/brokers/tradovate/index";
import type { TradovateRealtimeAdapter } from "@/lib/brokers/tradovate/realtime-adapter";

/**
 * Process-wide engine singleton. Lives outside the route file so multiple
 * routes (e.g. /api/engine, /api/engine/stream) can share the same engine
 * and SignalR session without triggering duplicate construction.
 *
 * The rule: one TradingEngine + one TopstepSignalR per process. Two
 * concurrent first-time callers both funnel through `enginePromise` so
 * no construction race opens two hubs on the same Topstep account (CME
 * single-session rule kicks one of them otherwise — observed in prod
 * before this funneling was added).
 *
 * State is parked on `globalThis` so module-level singletons survive across
 * separate module-loader contexts. In dev (Turbopack) and in some prod
 * configurations the instrumentation hook loads modules in a different
 * graph than the route handlers — without this, instrumentation builds
 * one engine + hub, then the first request builds a SECOND, and Topstep
 * kicks one of the two hubs (single-session-per-account rule). globalThis
 * is shared across all module graphs in the same Node process.
 */
interface EngineGlobalState {
  engine: TradingEngine | null;
  enginePromise: Promise<TradingEngine> | null;
  signalr: TopstepSignalR | null;
  /**
   * Whether this process has read the rings back off disk yet.
   *
   * **It is a flag rather than "are the rings empty", and it has to be.**
   * Emptiness answered the question only while the engine's log handler was
   * the rings' one writer. `log.*` lines land in them before the engine is
   * constructed now, so a boot that logs anything at all — every boot —
   * would find a non-empty ring and skip hydration entirely, silently
   * trading a restart's whole history for one boot line.
   */
  hydrated: boolean;
  /** The wake in flight, shared by every caller until it settles. */
  activation: Promise<void> | null;
}

const GLOBAL_KEY = "__topstepEngineState__" as const;
type GlobalWithEngine = typeof globalThis & { [GLOBAL_KEY]?: EngineGlobalState };

function state(): EngineGlobalState {
  const g = globalThis as GlobalWithEngine;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      engine: null,
      enginePromise: null,
      signalr: null,
      hydrated: false,
      activation: null,
    };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * The registered Topstep plugin, or null if it is not registered.
 * `getPlugin` answers `BrokerPlugin | null`, and the `as
 * TopstepBrokerPlugin` that used to sit here erased the null half —
 * silently, on a path browser requests now reach. Both plugins register
 * synchronously at module eval so null is unreachable today; this is a
 * cast the file should not be making, not a live failure.
 * `topstepBrowserToken()` guards the same lookup the same way.
 */
function topstepPlugin(): TopstepBrokerPlugin | null {
  const plugin = brokerRegistry.getPlugin("topstep");
  return plugin instanceof TopstepBrokerPlugin ? plugin : null;
}

/**
 * Deliberately `as`, not the `instanceof` its Topstep twin above uses, and
 * the asymmetry is not an oversight — it was tried and reverted 2026-08-23.
 *
 * `instanceof` needs the class as a *value*, and `TradovateBrokerPlugin` is
 * imported here as `import type` on purpose: engine-singleton is imported
 * from nearly every route, and a value import drags the Tradovate plugin's
 * whole chain — client, realtime adapter, penalty handler — into all of
 * them. Topstep's class is already a value import for other reasons, which
 * is the only reason its accessor can afford the guard.
 *
 * The cast is unreachable regardless: `registry-singleton` registers both
 * plugins synchronously at module evaluation, so `getPlugin("tradovate")`
 * cannot be null or another type. If that ever stops being true, widen the
 * *registry* to return a typed plugin rather than making this a value
 * import.
 */
function tradovatePlugin(): TradovateBrokerPlugin {
  return brokerRegistry.getPlugin("tradovate") as TradovateBrokerPlugin;
}

/** Returns main + heartbeat rings merged in timestamp order. The /logs
 *  UI's HEARTBEAT chip filters by level; merging here keeps the chip
 *  semantics identical to before the rings were split. */
export function getLogsBuffer(): WireLogRecord[] {
  const s = logRings();
  if (s.heartbeatLogs.length === 0) return s.logs.map(project);
  if (s.logs.length === 0) return s.heartbeatLogs.map(project);
  const merged = s.logs.concat(s.heartbeatLogs);
  merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return merged.map(project);
}

function project(entry: RingLogEntry, index: number): WireLogRecord {
  return projectLogRecord(entry, index);
}

/** Returns the last `limit` entries of each level. Bucketing per-level
 *  (rather than per-ring) keeps low-frequency levels (error, warn) visible
 *  at small limits even when high-frequency levels (info, heartbeat)
 *  dominate the buffer. E.g. limit=25 yields up to 25 errors AND up to 25
 *  infos, instead of the most-recent 25 entries which might all be infos.
 *
 *  The chip counts this was built for are gone — the viewer's lanes face
 *  severity and category now, and the client merges these buckets straight
 *  back into one stream. The **fairness cap** is what survives and why this
 *  still buckets on the legacy level: it is a transport concern, not a
 *  display one, and nothing has re-keyed it onto the pair yet. */
export function getLogsByLevel(limit: number): Record<EngineLog["level"], WireLogRecord[]> {
  const s = logRings();
  const out: Record<EngineLog["level"], WireLogRecord[]> = {
    error: [],
    warn: [],
    connection: [],
    trade: [],
    "trade-skip": [],
    info: [],
    heartbeat: [],
  };
  // Walk both rings newest-first, push into the right bucket until each
  // hits the cap. O(n + m) with early exit when every bucket is full.
  const remaining: Record<EngineLog["level"], number> = {
    error: limit, warn: limit, connection: limit, trade: limit, "trade-skip": limit, info: limit, heartbeat: limit,
  };
  let openBuckets = 7;
  // The ring index rides out as `seq`. The buckets are the payload's shape
  // and the client merges them straight back into one stream, so without an
  // ordinal the only thing left to sort on is the ISO timestamp — and an
  // entry, its brackets and its exit inside one millisecond then land in
  // whatever order the buckets happened to be enumerated in. This is the
  // *only* place that order still exists.
  //
  // The heartbeat ring's indices are offset past the main ring so the merged
  // stream has a total order rather than two colliding index spaces.
  const visit = (arr: RingLogEntry[], offset: number) => {
    for (let i = arr.length - 1; i >= 0 && openBuckets > 0; i--) {
      const e = arr[i];
      if (remaining[e.level] > 0) {
        // Projected here rather than at the route, so a second caller of
        // this accessor cannot ship the structural ids by forgetting to.
        out[e.level].push(projectLogRecord(e, offset + i));
        remaining[e.level]--;
        if (remaining[e.level] === 0) openBuckets--;
      }
    }
  };
  visit(s.logs, 0);
  visit(s.heartbeatLogs, s.logs.length);
  // Each bucket was filled newest-first; reverse so they read oldest→newest
  // like the rest of the UI expects.
  for (const k of Object.keys(out) as EngineLog["level"][]) out[k].reverse();
  return out;
}

/**
 * Put a restart's rows in front of the lines this process has already
 * emitted, and trim the oldest end back to the cap.
 *
 * Appending them would put rows from *before* the restart after lines from
 * after it, and both accessors read a ring as oldest-first — `getLogsByLevel`
 * walks it backwards to take the newest N, and `getLogsBuffer` returns the
 * main ring unsorted when there are no heartbeats. The trim comes off the
 * front for the same reason it does on push: the oldest entry is the one the
 * cap gives up.
 */
function prependHydrated(ring: RingLogEntry[], rows: RingLogEntry[], cap: number): void {
  if (rows.length === 0) return;
  ring.unshift(...rows);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

/** Wipe both in-memory rings AND the persisted log table. User-triggered
 *  from the /logs UI "Clear logs" button. Engine keeps running; subsequent
 *  events repopulate from empty. */
export function clearAllLogs(): void {
  const s = logRings();
  s.logs.length = 0;
  s.heartbeatLogs.length = 0;
  clearPersistedLogs();
}

export function getEngineSignalR(): TopstepSignalR | null {
  return state().signalr;
}

/**
 * There is exactly one TopstepClient per process and the absence of a
 * second one is deliberate.
 *
 * This module used to hold a `browserClient` alongside the engine's,
 * with its token re-stamped per request, so that a browser-scoped
 * Topstep JWT and the engine's cached token could not stomp on each
 * other. That split was real before Phase E2, when the browser logged in
 * against Topstep directly and echoed its own JWT back at every route.
 * E2 replaced that with an app session: nothing outside the server has
 * held a Topstep token since, and `getBrowserToken()` and
 * `getEngineToken` are two names for the same cached `getToken()`. Two
 * clients over one token bought a duplicate open-order cache and nothing
 * else. Take `getTopstepClientIfConfigured()` — do not reconstruct the
 * split from the git history without re-checking that premise.
 */

/**
 * Engine-side TopstepClient. Owned by the Topstep plugin; this wrapper
 * refreshes its token from the cache on every call so the hub's
 * accessTokenFactory sees the current value on reconnect. The plugin's
 * `initialize()` constructs the client lazily — first call goes through
 * it; subsequent calls just re-stamp the token on the same instance.
 */
export async function getEngineClient(): Promise<TopstepClient> {
  const plugin = topstepPlugin();
  if (!plugin) {
    throw new Error("Topstep broker plugin is not registered.");
  }
  let client = plugin.getClient();
  if (!client) {
    await plugin.initialize();
    client = plugin.getClient();
    if (!client) {
      throw new Error(
        "Topstep client unavailable — credentials missing. Add them in Settings.",
      );
    }
  }
  const token = await getEngineToken();
  client.setToken(token);
  return client;
}

/**
 * Optional Topstep client — the mirror of `getTradovateClientIfConfigured`
 * below, and the one the engine boot path uses. Returns `null` without
 * throwing when Topstep isn't configured, because a Tradovate-only
 * install is a supported shape as of Phase E3. `getEngineClient()` keeps
 * throwing, for the callers that genuinely cannot proceed without it.
 */
export async function getTopstepClientIfConfigured(): Promise<TopstepClient | null> {
  if (!topstepPlugin()?.isConfigured()) return null;
  return getEngineClient();
}

/**
 * Optional Tradovate client. Returns `null` (without throwing) when
 * Tradovate creds aren't configured — Topstep-only installs are a fully
 * supported v1 path. Wraps the Tradovate plugin's `initialize()` so
 * authentication runs lazily on first request that routes here; failures
 * bubble through the plugin's throttled-alert path.
 */
export async function getTradovateClientIfConfigured(): Promise<TradovateClient | null> {
  const plugin = tradovatePlugin();
  await plugin.initialize();
  return plugin.getClient();
}

/**
 * Why `getTradovateClientIfConfigured()` came back null, or null when no
 * authentication has failed — in which case a null client means the
 * credentials are absent. `initialize()` swallows the auth error so one
 * broker's outage cannot take a route down, and this is where the reason
 * went; without it a `TradovateCaptchaLockoutError`, which has a specific
 * operator recovery, renders as "Tradovate is not configured".
 */
export function tradovateAuthError(): string | null {
  return tradovatePlugin().lastAuthError();
}

/** Drop the cached Tradovate client so the next engine tick re-authenticates
 *  with the current DB creds. Call after writing new Tradovate credentials. */
export function invalidateTradovateClient(): void {
  tradovatePlugin().invalidate();
}

/**
 * Tradovate's account-event adapter, or null before the engine has been
 * constructed. Routes reach it for `resolveDatedSymbol` — the numeric →
 * dated-symbol bridge lives with the transport that produces the numeric
 * ids, not on the broker-agnostic engine.
 */
export function getTradovateRealtimeAdapter(): TradovateRealtimeAdapter | null {
  return tradovatePlugin().realtime ?? null;
}

export async function getEngine(): Promise<TradingEngine> {
  // `getEngine()` *builds* an engine wherever it is called, so a web process
  // must refuse here rather than at `start()`: a constructed engine opens hubs
  // on the broker login the engine process is already using.
  if (!runsEngine()) {
    reportLeaseRefused("getEngine()", "This process runs as the web role and never builds an engine.");
    throw new EngineNotInThisProcessError("getEngine()");
  }
  const s = state();
  if (s.engine) {
    // Refresh the engine client's token from cache on every request so the
    // hub's accessTokenFactory sees the current value on reconnect. Skips
    // silently when Topstep isn't configured — there is no hub.
    await getTopstepClientIfConfigured();
    return s.engine;
  }
  // Construction only: an engine already built here was built under the
  // lease, and a lost one is `stop()`ped by the renew. A boot refused at the
  // bound leaves this process serving, and building here would open hubs on
  // the login the live engine uses and can kick its session.
  if (!s.enginePromise && !holdsLease()) {
    reportLeaseRefused("getEngine()", "No engine was built, so no hub opened on the broker login.");
    throw new EngineNotInThisProcessError("getEngine()", "this process does not hold the engine lease");
  }
  if (!s.enginePromise) {
    s.enginePromise = (async () => {
      // Boot every expected broker plugin via the registry. Each plugin
      // owns its client lifecycle; failures inside `initialize()` are
      // already absorbed (Tradovate throttles-then-swallows; Topstep
      // surfaces missing creds via getEngineClient below). The loop runs
      // before getEngineClient so the Topstep plugin has its client
      // wired before the per-request token-refresh swap.
      for (const plugin of brokerRegistry.allPlugins()) {
        if (plugin.isExpected()) {
          await plugin.initialize();
        }
      }
      const c = await getTopstepClientIfConfigured();
      // The SignalR hubs are Topstep's. No Topstep, no hubs — the engine
      // runs REST-only, which is the same shape as USE_REALTIME_BARS off.
      if (process.env.USE_REALTIME_BARS === "true" && c) {
        s.signalr = new TopstepSignalR(() => c.getToken());
      }
      // Hydrate the in-memory rings from disk so a redeploy lands the
      // /logs UI roughly where it was before restart. hydrateRings returns
      // entries in chronological order, and every row it returns predates
      // this process — so they go in *front* of the boot lines already on
      // the rings, which keeps both accessors' newest-last reading true.
      // The flag is set *after* the prepends. Setting it first was correct
      // only because `hydrateRings` swallows its own failures and returns
      // empty rings — a property of another file, which this one would then
      // depend on for "a failed restore is not remembered as a done one".
      if (!s.hydrated) {
        const hydrated = hydrateRings();
        const rings = logRings();
        prependHydrated(rings.logs, hydrated.main, MAX_LOGS);
        prependHydrated(rings.heartbeatLogs, hydrated.heartbeat, MAX_HEARTBEAT_LOGS);
        s.hydrated = true;
      }
      // Start the flush + retention loops. Idempotent — safe even if
      // somehow re-entered after the engine was stopped + restarted.
      startEngineLogStore();
      // Tradovate client read back from the plugin — null when creds
      // aren't configured. Engine treats `null` as "Tradovate broker
      // unavailable"; any Tradovate-broker deployment auto-pauses on
      // first tick.
      const tc = tradovatePlugin().getClient();
      const built = new TradingEngine(c, tc, s.signalr);
      // Rings only, and the same `pushToRing` the pipe's ring sink uses.
      // Persistence moved to the log pipe's sink, which `db/engine-logs.ts`
      // installs at import time — so a `log.*` line emitted before the
      // engine exists is queued too, and no line is written twice. Do not
      // re-add `persistEngineLog` here, and do not let the pipe push an
      // engine line: this handler is what puts one on a ring, and a second
      // route would double every one of them.
      built.setLogHandler(pushToRing);
      setTradeWriteListener(() => peekBroadcaster()?.emitTradesChanged());
      s.engine = built;
      return built;
    })().catch((err) => {
      s.enginePromise = null;
      throw err;
    });
  }
  return s.enginePromise;
}

export function getEngineIfReady(): TradingEngine | null {
  return state().engine;
}

/**
 * Wake the engine after a first run persists creds. Routes through the
 * shared `runBootSequence` helper so cold-start and first-run-start
 * execute identical logic — drift between the two would be a load-bearing
 * bug (the first-run happy path wouldn't match the redeploy-after-setup
 * happy path).
 *
 * Idempotent: if the engine is already running, the helper returns
 * `{ kind: "already-running" }` and we drop out without calling
 * `eng.start()` a second time. **Single-flight**: a wake already in flight
 * is the answer to every call until it settles. `enginePromise` funnels only
 * the construction; two boot passes side by side would each run
 * `prepareEngineProcess` — the fan-out twice, and a Tradovate login more
 * against a two-session budget.
 *
 * It drops this process's settings cache first. In the split the call is
 * relayed to the engine process, whose cache still holds the empty Topstep
 * pair it read at its no-credentials boot; the web process wrote the new
 * one, and only its own cache was cleared.
 *
 * `rethrowAllowlistFailure: true` makes the helper **return** a
 * `staging-allowlist-empty` result instead of throwing it; this function
 * converts it back into a throw. Read the flag as "let me see the kind",
 * not as "do not swallow" — nothing is swallowed on either arm, since the
 * `false` path throws from inside the helper. It buys nothing here today,
 * because the arm below treats `staging-allowlist-empty` and `error`
 * identically; it is the option to branch on the kind, unexercised.
 *
 * Either way the reason reaches an operator through the boot helper's log
 * line only. Both callers — the setup route's credential confirm and
 * `PUT /api/settings` saving the first broker — fire-and-forget this call
 * and their catches log nothing, so the browser learns nothing beyond its
 * /api/auth poll. Surfacing the reason there is not wired up.
 */
export function activateFromSettings(): Promise<void> {
  const s = state();
  if (s.activation) return s.activation;
  const run = runActivation().finally(() => {
    s.activation = null;
  });
  s.activation = run;
  return run;
}

async function runActivation(): Promise<void> {
  // The lease itself is taken, or refused, by the boot sequence below — this
  // door is how a first-run install that never booted comes to hold it.
  if (!runsEngine()) {
    reportLeaseRefused(
      "activateFromSettings()",
      "This process runs as the web role and never builds an engine.",
    );
    throw new EngineNotInThisProcessError("activateFromSettings()");
  }
  invalidateSettingsCache();
  const { runBootSequence } = await import("@/lib/trading/engine/boot/boot-engine");
  const result = await runBootSequence({ rethrowAllowlistFailure: true });
  if (result.kind === "staging-allowlist-empty" || result.kind === "error") {
    // The helper already logged the error, which is the one line an
    // operator gets: the route's fire-and-forget catch swallows this
    // throw without logging. Thrown anyway so the caller can distinguish
    // a refused boot from a completed one — the wizard itself only sees
    // the /api/auth polling timeout.
    throw new Error(result.message);
  }
}
