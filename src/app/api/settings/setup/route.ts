import { NextRequest, NextResponse } from "next/server";
import {
  getTopstepApiKey,
  getTopstepUsername,
  getTradovateApiCid,
  getTradovateDeviceId,
  setSetupConfirmedAt,
  setSetupSignature,
  setTopstepWebhookUrl,
  setTradovateDeviceIdUserSet,
} from "@/lib/db/settings";
import { invalidateSettingsCache } from "@/lib/db/settings-cache";
import { getDb } from "@/lib/db/connection";
import { computeConfigSignature } from "@/lib/db/setup-signature";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import {
  getTopstepCredsValidatedSignature,
  setTopstepCredsValidatedSignature,
  getTradovateCredsValidatedSignature,
} from "@/lib/db/cred-validation";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { createWebAccount, hasWebAccount } from "@/lib/db/web-account";
import { passwordProblem, usernameProblem } from "@/lib/auth/web-account-rules";
import { consumeSetupCode, ensureSetupCode, setupCodeMatches } from "@/lib/auth/setup-code";
import { clientAddress, limitedAttempt, rateLimitedResponse } from "@/lib/auth/login-limiter";
import { SETUP_CODE_MISSING_MESSAGE, SETUP_CODE_WRONG_MESSAGE } from "@/lib/auth/sign-in-wire";

const handle = engineHandle();

/**
 * Phase 6b first-run wizard route. Single-shot: only writes when the DB
 * has no broker creds at all. Returns 409 on retry — drive-by takeover
 * guard so an attacker who races a real operator can't overwrite their
 * setup.
 *
 * Phase E2: **either broker satisfies the wizard.** Topstep used to be
 * required and Tradovate optional, which meant the door to a
 * Tradovate-only install only opened with the credential you did not
 * have. Now the rule is "at least one broker, validated" — supply
 * Topstep, Tradovate, or both. A partially-filled broker is still an
 * error for both of them; half a credential set is unrecoverable from a
 * wizard that has no per-field editing.
 *
 * Auth: NONE. The middleware allowlist + the inner creds-absent check
 * are the gates. Once creds exist, the route is closed — operators use
 * /settings (authenticated) for ongoing edits and /api/settings/reset
 * for destructive teardown.
 *
 * **It also creates the web sign-in account, and closes for good once one
 * exists.** Every body carries `account: { username, password }`. On a
 * fresh install the account is written in the same confirm as the
 * credentials; on an install whose broker already resolves (stored before
 * sign-in existed, or from the environment) a body with no broker fields
 * creates the account alone and touches nothing else — and any body on such
 * an install must carry `setupCode`, the one-time code the process printed
 * to stdout (`src/lib/auth/setup-code.ts`). On an install with no broker, a
 * body with no broker fields is the whole first run: the account is created
 * and setup confirmed, and the browser signs in with no broker to browse the
 * app. Either way a second account cannot be made here: the first check is
 * that none exists.
 *
 * Side-effects on success:
 *  - Write topstep_username + topstep_api_key (+ optional webhook URL)
 *  - Persist setup_confirmed_at (Phase 2.3 also writes the signature)
 *  - Invalidate the settings cache so engine-auth picks up the new creds
 *  - Fire-and-forget engine.activateFromSettings() so the engine wakes
 *    without waiting for the next routine /api/auth tick. Awaiting would
 *    block the route on the full boot sequence (allowlist + migration +
 *    deployment fetch + start) and the wizard's polling UX is designed
 *    to converge on its own.
 *
 * The absent-check and the credential writes are NOT one transaction —
 * `applyCredentials` is async and better-sqlite3 transactions are sync —
 * so two concurrent first-time POSTs can both pass the check. See the
 * note at the check itself for the accepted cost.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Expected object body" }, { status: 400 });
  }
  // Closed once a sign-in account exists, whatever else the body carries:
  // from then on every write goes through a signed-in route.
  if (hasWebAccount()) {
    return NextResponse.json({ error: "Already configured" }, { status: 409 });
  }
  const input = body as {
    account?: unknown;
    setupCode?: unknown;
    topstepUsername?: unknown;
    topstepApiKey?: unknown;
    topstepWebhookUrl?: unknown;
    tradovate?: unknown;
  };
  const account = parseAccount(input.account);
  if ("error" in account) {
    return NextResponse.json({ error: account.error }, { status: 400 });
  }
  // A broker that already resolves means an install upgraded from before the
  // login (or one configured from the environment), whose first run anyone
  // reaching the port could otherwise finish. Every body shape is held here,
  // not only the account-only one: on an env-configured install the
  // credential arm's signature gate adopts whatever Topstep pair it is sent.
  const brokerConfigured = brokerRegistry.allPlugins().some((p) => p.isConfigured());
  if (brokerConfigured) {
    const denied = await refuseWithoutSetupCode(request, input.setupCode);
    if (denied) return denied;
  }
  // Topstep is supplied or it is not; supplying half of it is an error,
  // the same rule Tradovate has always had below.
  const topstepSupplied =
    (typeof input.topstepUsername === "string" && input.topstepUsername.length > 0) ||
    (typeof input.topstepApiKey === "string" && input.topstepApiKey.length > 0);
  let username: string | null = null;
  let apiKey: string | null = null;
  if (topstepSupplied) {
    if (typeof input.topstepUsername !== "string" || input.topstepUsername.length === 0) {
      return NextResponse.json({ error: "topstepUsername required" }, { status: 400 });
    }
    if (input.topstepUsername.length > 128) {
      return NextResponse.json({ error: "topstepUsername must be ≤ 128 chars" }, { status: 400 });
    }
    if (typeof input.topstepApiKey !== "string" || input.topstepApiKey.length === 0) {
      return NextResponse.json({ error: "topstepApiKey required" }, { status: 400 });
    }
    if (input.topstepApiKey.length > 512) {
      return NextResponse.json({ error: "topstepApiKey must be ≤ 512 chars" }, { status: 400 });
    }
    username = input.topstepUsername;
    apiKey = input.topstepApiKey;
  }
  let webhook: string | null = null;
  if (input.topstepWebhookUrl !== undefined && input.topstepWebhookUrl !== null) {
    if (typeof input.topstepWebhookUrl !== "string") {
      return NextResponse.json({ error: "topstepWebhookUrl must be string or null" }, { status: 400 });
    }
    if (input.topstepWebhookUrl.length > 0) {
      if (!input.topstepWebhookUrl.startsWith("https://")) {
        return NextResponse.json({ error: "topstepWebhookUrl must start with https://" }, { status: 400 });
      }
      webhook = input.topstepWebhookUrl;
    }
  }

  // When supplied, ALL Tradovate fields must be present — the
  // partial-creds case is unrecoverable from the wizard since we don't
  // expose individual edits here. Operator finishes the wizard with the
  // other broker and adds this one later via /settings if they only have
  // part of the credential set.
  let tradovate: {
    username: string;
    password: string;
    apiCid: string;
    apiSecret: string;
    appId: string;
    appVersion: string;
    deviceId: string;
  } | null = null;
  if (input.tradovate !== undefined && input.tradovate !== null) {
    if (typeof input.tradovate !== "object") {
      return NextResponse.json({ error: "tradovate must be an object" }, { status: 400 });
    }
    const tv = input.tradovate as Record<string, unknown>;
    const required = [
      "username",
      "password",
      "apiCid",
      "apiSecret",
      "appId",
      "appVersion",
      "deviceId",
    ] as const;
    const missing: string[] = [];
    for (const field of required) {
      const v = tv[field];
      if (typeof v !== "string" || v.length === 0) missing.push(field);
    }
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Tradovate fields incomplete: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
    tradovate = {
      username: tv.username as string,
      password: tv.password as string,
      apiCid: tv.apiCid as string,
      apiSecret: tv.apiSecret as string,
      appId: tv.appId as string,
      appVersion: tv.appVersion as string,
      deviceId: tv.deviceId as string,
    };
  }

  // An install whose broker already resolves — stored before the sign-in
  // account existed, or from the environment — creates the account alone.
  // It writes no credential, so the drive-by guard below has nothing to
  // protect here; the account check and the setup code above are its gate.
  // A webhook in the body is not written: that install edits it signed in.
  if (brokerConfigured && username === null && tradovate === null) {
    return createAccountOnly(account);
  }

  // A fresh install's first run is the sign-in alone (2026-10-29): the
  // account, and the confirm that clears the guard. Brokers are connected
  // later on the signed-in Settings page, so there is nothing to activate.
  if (!brokerConfigured && username === null && tradovate === null) {
    return createAccountAndConfirm(account, webhook);
  }

  // Gate-save: the wizard's Test Connection button persists a sha256 of
  // the cred values it just authenticated. Save proves the operator
  // validated these exact creds by re-computing the signature here (via
  // each plugin) and comparing. The Test Connection endpoint is the
  // single source of truth — Save never re-validates, just trusts the
  // signature.
  //
  // 400 (not 401) because the operator hasn't completed the prerequisite
  // step in the wizard, not because Topstep rejected the credentials.
  const topstepPlugin = brokerRegistry.getPlugin("topstep");
  if (username !== null && apiKey !== null) {
    if (!topstepPlugin) {
      return NextResponse.json({ error: "Topstep broker plugin not registered" }, { status: 500 });
    }
    const expectedTopstepSig = topstepPlugin.computeCredsSignature({
      topstepUsername: username,
      topstepApiKey: apiKey,
    });
    // When the DB is fresh but env creds are already live (e.g. staging reset
    // with creds in .env), the engine authenticated at boot but never wrote a
    // validated sig. Skip the gate and write the sig now so subsequent saves
    // pass the check normally.
    if (getTopstepCredsValidatedSignature() === null && topstepPlugin.isConfigured()) {
      setTopstepCredsValidatedSignature(expectedTopstepSig);
    }
    if (getTopstepCredsValidatedSignature() !== expectedTopstepSig) {
      return NextResponse.json(
        {
          error:
            "Topstep credentials were not validated. Click Test Connection first.",
        },
        { status: 400 },
      );
    }
  }
  const tradovatePlugin = brokerRegistry.getPlugin("tradovate");
  if (tradovate !== null) {
    if (!tradovatePlugin) {
      return NextResponse.json({ error: "Tradovate broker plugin not registered" }, { status: 500 });
    }
    const expectedTradovateSig = tradovatePlugin.computeCredsSignature({
      tradovateUsername: tradovate.username,
      tradovatePassword: tradovate.password,
      tradovateApiCid: tradovate.apiCid,
      tradovateApiSecret: tradovate.apiSecret,
      tradovateAppId: tradovate.appId,
      tradovateAppVersion: tradovate.appVersion,
      tradovateDeviceId: tradovate.deviceId,
    });
    if (getTradovateCredsValidatedSignature() !== expectedTradovateSig) {
      return NextResponse.json(
        {
          error:
            "Tradovate credentials were not validated. Click Test Connection first.",
        },
        { status: 400 },
      );
    }
  }

  // Absent-then-write race protection. The original implementation
  // re-checked inside a SQL txn that wrapped all writes. After the phase
  // 8 step 2 plugin extraction, async plugin.applyCredentials cannot run
  // inside a sync better-sqlite3 txn. Best-effort here: pre-check, then
  // delegate to plugins, then post-write metadata. Race window for two
  // concurrent first-time POSTs widens (the loser overwrites the winner
  // with its own body) but at single-install scale this is acceptable.
  // Cold-start invariant, now across brokers: the wizard is closed once
  // ANY broker's credentials are in the DB. Deliberately reads the DB
  // getters rather than `plugin.isConfigured()`, which also resolves env
  // — an env-only install must still be able to complete the wizard, and
  // the block just below exists to make that work.
  if (getTopstepUsername() || getTopstepApiKey() || getTradovateApiCid()) {
    return NextResponse.json({ error: "Already configured" }, { status: 409 });
  }

  // Capture wizard-prefilled deviceId BEFORE the plugin overwrites it —
  // the user_set flag depends on whether the submitted value diverged
  // from what was prefilled (untouched prefill = AUTO badge stays).
  const prefilledDeviceId = tradovate !== null ? getTradovateDeviceId() : null;

  try {
    if (username !== null && apiKey !== null && topstepPlugin !== null) {
      await topstepPlugin.applyCredentials({
        topstepUsername: username,
        topstepApiKey: apiKey,
      });
    }
    if (tradovate !== null && tradovatePlugin !== null) {
      await tradovatePlugin.applyCredentials({
        tradovateUsername: tradovate.username,
        tradovatePassword: tradovate.password,
        tradovateApiCid: tradovate.apiCid,
        tradovateApiSecret: tradovate.apiSecret,
        tradovateAppId: tradovate.appId,
        tradovateAppVersion: tradovate.appVersion,
        tradovateDeviceId: tradovate.deviceId,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write setup" },
      { status: 500 },
    );
  }

  // After the credentials, so a failed credential write leaves no account
  // behind to close this route on a retry. Validated above, so the only
  // refusal left is a racing create, which is the same 409 a retry sees.
  const created = await createWebAccount(account.username, account.password);
  if (!created.ok) {
    return NextResponse.json({ error: "Already configured" }, { status: 409 });
  }
  consumeSetupCode();

  let confirmedAt: string;
  try {
    const result = getDb().transaction(() => {
      if (webhook !== null) setTopstepWebhookUrl(webhook);
      if (tradovate !== null) {
        setTradovateDeviceIdUserSet(tradovate.deviceId !== prefilledDeviceId);
      }
      const now = new Date().toISOString();
      setSetupConfirmedAt(now);
      // The confirmation signature is Topstep-shaped (it exists to catch
      // an out-of-band Topstep key rotation). On a Tradovate-only setup
      // it records the absence, which is still a stable value <SetupGuard>
      // can compare against.
      const signature = computeConfigSignature({
        username,
        hasDbKey: apiKey !== null,
        hasEnvKey: (process.env.TOPSTEP_API_KEY ?? "").length > 0,
        webhookUrl: webhook ?? (process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? null),
      });
      setSetupSignature(signature);
      return now;
    })();
    confirmedAt = result;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write setup" },
      { status: 500 },
    );
  }

  // Plugin.applyCredentials already invalidated topstep_username/api_key
  // and any tradovate per-broker cache. Webhook URL is route-owned so its
  // cache invalidation lives here.
  if (webhook !== null) invalidateSettingsCache("topstep_webhook_url");

  // Fire-and-forget activation. Failures land in engine logs; the
  // wizard's polling UX detects success/failure via /api/auth.
  void handle.activateFromSettings().catch(() => {
    // Logged inside activateFromSettings via the engine log handler;
    // swallow here so the unhandled rejection doesn't crash the process.
  });

  return NextResponse.json({ ok: true, setupConfirmedAt: confirmedAt });
}

interface AccountInput {
  username: string;
  password: string;
}

function parseAccount(input: unknown): AccountInput | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "A sign-in username and password are required." };
  }
  const { username, password } = input as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    return { error: "A sign-in username and password are required." };
  }
  const problem = usernameProblem(username) ?? passwordProblem(password);
  return problem === null ? { username, password } : { error: problem };
}

async function createAccountOnly(account: AccountInput): Promise<NextResponse> {
  const created = await createWebAccount(account.username, account.password);
  if (!created.ok) {
    return NextResponse.json({ error: "Already configured" }, { status: 409 });
  }
  consumeSetupCode();
  return NextResponse.json({ ok: true, accountCreated: true });
}

/** First run on an install with no broker: the stamp the guard reads, then the
 *  account. The signature records the absence, as a Tradovate-only setup's
 *  does, so the first credential save recomputes it.
 *
 *  Stamp first: an account written ahead of a failed stamp closes this route
 *  and leaves Settings' first-run mode, which will not confirm without a
 *  broker, as the only way on. A stamp with no account is inert — `/api/auth`
 *  answers needsSetup until an account exists — and a retry writes it again. */
async function createAccountAndConfirm(
  account: AccountInput,
  webhook: string | null,
): Promise<NextResponse> {
  let confirmedAt: string;
  try {
    confirmedAt = getDb().transaction(() => {
      if (webhook !== null) setTopstepWebhookUrl(webhook);
      const now = new Date().toISOString();
      setSetupConfirmedAt(now);
      setSetupSignature(
        computeConfigSignature({
          username: null,
          hasDbKey: false,
          hasEnvKey: (process.env.TOPSTEP_API_KEY ?? "").length > 0,
          webhookUrl: webhook ?? (process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? null),
        }),
      );
      return now;
    })();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write setup" },
      { status: 500 },
    );
  }
  if (webhook !== null) invalidateSettingsCache("topstep_webhook_url");
  let created: Awaited<ReturnType<typeof createWebAccount>>;
  try {
    created = await createWebAccount(account.username, account.password);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create the sign-in account" },
      { status: 500 },
    );
  }
  if (!created.ok) {
    return NextResponse.json({ error: "Already configured" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, accountCreated: true, setupConfirmedAt: confirmedAt });
}

/** The code `ensureSetupCode` printed, compared under the sign-in limiter —
 *  a wrong one is a counted failure like a wrong password. A missing one is
 *  refused uncounted: it guesses nothing. */
async function refuseWithoutSetupCode(
  request: NextRequest,
  supplied: unknown,
): Promise<NextResponse | null> {
  ensureSetupCode();
  if (typeof supplied !== "string" || supplied.trim().length === 0) {
    return NextResponse.json(
      { needsSetupCode: true, error: SETUP_CODE_MISSING_MESSAGE },
      { status: 403 },
    );
  }
  const result = await limitedAttempt(
    clientAddress(request.headers),
    async () => setupCodeMatches(supplied),
    (matched) => matched,
  );
  if (result.refusal) return rateLimitedResponse(result.refusal);
  if (result.passed) return null;
  return NextResponse.json({ needsSetupCode: true, error: SETUP_CODE_WRONG_MESSAGE }, { status: 403 });
}
