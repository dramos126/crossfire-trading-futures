import { createHash } from "node:crypto";
import { TopstepClient, UnauthorizedError, topstepSessionState } from "./client";
import { log } from "@/lib/logger";
import {
  clearCachedToken,
  getCachedToken,
  jwtExpiry,
  setCachedToken,
} from "@/lib/db/auth";
import {
  resolveTopstepApiKey,
  resolveTopstepUsername,
} from "@/lib/db/settings-cache";

// Match the browser auth route's refresh window so behavior is symmetric.
const REFRESH_WINDOW_SEC = 60 * 60; // 1 hour

// DB-first / env-fallback per docs/proposals/settings-page-plan.md §3.
// `/api/settings` PUT invalidates the settings cache + clears the token
// cache (in that order — see plan §8 race notes) so the next call here
// resolves to the new creds and cold-mints under them.
function credentials(): { userName: string; apiKey: string } | null {
  const userName = resolveTopstepUsername();
  const apiKey = resolveTopstepApiKey();
  if (!userName || !apiKey) return null;
  return { userName, apiKey };
}

/*
 * `inFlightTokenMint` (on `topstepSessionState()`, with the rest of this
 * file's process state — see that accessor for why not a module `let`) is
 * the in-flight Promise of the next token mint, shared across concurrent
 * callers in this Node process. Without this, two parallel requests
 * (e.g. dashboard's /api/auth + /api/engine status both firing on first
 * load) would each see an empty cache, both call /Auth/loginKey, both
 * mint a fresh Topstep session — and Topstep enforces single-session
 * per user, so it kicks the older session. The SQLite cache survives
 * this race for the next caller, but the racing pair always lost.
 *
 * Cleared after the promise settles so a future expired-token refresh
 * gets a fresh attempt.
 */

/**
 * How long `getToken()`'s cold path refuses to call `loginKey` again after
 * one threw. A failed mint leaves the row empty, so without this every
 * caller — each dashboard poll — is a fresh login against a gateway that
 * just refused one. Inside the window the cold path rethrows that failure
 * and makes no call. Short, because the cost of waiting is the whole app
 * staying down for that long after the gateway comes back.
 */
export const FAILED_MINT_BACKOFF_MS = 60 * 1000;

/**
 * The backoff belongs to the credentials that failed. Keyed this way a
 * re-saved key mints at once without Settings having to know the backoff
 * exists, and the first mint of a process has nothing to match. A digest,
 * so the API key is not held a second time on `globalThis`.
 */
function credentialFingerprint(creds: { userName: string; apiKey: string }): string {
  return createHash("sha256").update(`${creds.userName}\0${creds.apiKey}`).digest("hex");
}

/**
 * Hold this process to the cached token: no `loginKey`, no `/Auth/validate`
 * refresh, no drop of a refused row. Set by a standby engine process from its
 * boot until it takes the engine over (engine-boot.md, *Hand-off*). Every one
 * of those calls lands on the one `auth_token` row and the one Topstep
 * session the running engine is using: a mint kicks its hubs, a refresh can
 * rotate the token under them, and a drop sends its next call to a mint.
 */
export function holdTokenRefresh(held: boolean): void {
  topstepSessionState().refreshHeld = held;
}

function refreshHeldError(): Error {
  return new Error(
    "This process is a standby engine: it uses the cached Topstep token and does not refresh or mint one " +
      "until it takes the engine over.",
  );
}

/**
 * Resolve the Topstep token. Shares the on-disk cache with the browser
 * auth route — both paths read/write `auth_token` so a single loginKey
 * covers them both. Concurrent callers across the process funnel through
 * `inFlightTokenMint` so only one loginKey is ever in flight at a time.
 */
export async function getToken(): Promise<string> {
  const creds = credentials();
  if (!creds) {
    throw new Error(
      "Missing TOPSTEP_USERNAME or TOPSTEP_API_KEY in environment",
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cached = getCachedToken();

  // Hot path: cache has plenty of life — return without any network call.
  if (cached && cached.expiresAt - nowSec > REFRESH_WINDOW_SEC) {
    return cached.token;
  }

  const session = topstepSessionState();
  if (session.refreshHeld) {
    // A token inside its refresh window is still a token; the running
    // engine refreshes the row, not this process.
    if (cached && cached.expiresAt > nowSec) return cached.token;
    throw refreshHeldError();
  }

  // If a refresh / mint is already in flight, await it instead of
  // starting a second one. This is the whole point of the in-flight
  // guard — without it, two parallel callers race past the cache check
  // and both call loginKey.
  if (session.inFlightTokenMint) {
    return session.inFlightTokenMint;
  }

  session.inFlightTokenMint = (async () => {
    const client = new TopstepClient();

    // Warm path: cached token is near expiry. Validate-and-refresh keeps
    // the same Topstep session active without minting a new one.
    if (cached && cached.expiresAt > nowSec) {
      try {
        client.setToken(cached.token);
        const newToken = await client.validateSession();
        if (newToken) {
          const exp = jwtExpiry(newToken) ?? nowSec + 24 * 60 * 60;
          setCachedToken(newToken, exp);
          return newToken;
        }
      } catch {
        // Fall through to loginKey.
      }
    }

    // Cold path: no usable cache. Mint a fresh session via loginKey —
    // this is the call that creates a new Topstep session, so it should
    // be rare. Anyone else logged in for this user gets kicked.
    const fingerprint = credentialFingerprint(creds);
    const failed = session.lastFailedMint;
    // Outside the `try`: a rethrow must not re-stamp the failure, or steady
    // polling would hold the backoff open for ever.
    if (
      failed &&
      failed.credentials === fingerprint &&
      Date.now() - failed.atMs < FAILED_MINT_BACKOFF_MS
    ) {
      throw failed.error;
    }
    try {
      const token = await client.authenticate(creds);
      const exp = jwtExpiry(token) ?? nowSec + 24 * 60 * 60;
      setCachedToken(token, exp);
      session.lastFailedMint = null;
      // Mark the process as having minted — so the next caller (e.g.
      // validateOrRefreshToken from a hub-connect path) takes the warm
      // /Auth/validate path instead of cold-minting AGAIN and kicking
      // the session we just created. Both this function and
      // validateOrRefreshToken read this flag.
      didMintFreshSessionThisProcess = true;
      return token;
    } catch (err) {
      clearCachedToken();
      session.lastFailedMint = { atMs: Date.now(), credentials: fingerprint, error: err };
      throw err;
    }
  })().finally(() => {
    // Release the slot whether we succeeded or failed; next caller can
    // try again. The cache (or its absence) drives whether they hit
    // hot/warm/cold this time.
    session.inFlightTokenMint = null;
  });

  return session.inFlightTokenMint;
}

/** Backwards-compatible alias — both engine and browser paths call the
 *  same function now. The engine code already imports `getEngineToken`
 *  in many places; keeping the name avoids touching every call site. */
export const getEngineToken = getToken;

/** Has this process already minted a fresh session via loginKey? The
 *  first hub-connect on a cold boot forces loginKey so the hub is bound
 *  to a session the gateway actually tracks — a cached token that only
 *  passes /Auth/validate can leave us with a "zombie" hub (WS open, no
 *  live session bound, no kick ever delivered). Subsequent calls within
 *  the same process can safely use the validate fast-path. */
let didMintFreshSessionThisProcess = false;

/**
 * Validate the cached token against Topstep before using it for a SignalR
 * connection, and mint a fresh one if the session is dead. Caching the
 * JWT works fine for REST (the JWT is what authenticates each request),
 * but the SignalR hub requires a *live session*, and a session can be
 * superseded server-side without invalidating the JWT — e.g. when the
 * user opens the Topstep webapp, then closes it, then we redeploy. The
 * cache thinks our token is valid; Topstep silently kicks the hub.
 *
 * On the first call per process, we force a fresh loginKey rather than
 * trusting the validate fast-path. /Auth/validate only checks JWT crypto
 * + expiry, not whether the session is the one the gateway currently
 * treats as active. A persistent SQLite cache (e.g. Docker with a mounted
 * volume) can survive multiple restarts while its session was displaced
 * long ago; the resulting hub opens cleanly but receives no events and
 * no kick, so we never detect the dead state.
 *
 * Hub-connect callers (MarketHubController.connect() in
 * engine-market-hub.ts, and its reconnect paths) MUST call this before
 * building the hub.
 */
export async function validateOrRefreshToken(): Promise<string> {
  const creds = credentials();
  if (!creds) {
    throw new Error("Missing TOPSTEP_USERNAME or TOPSTEP_API_KEY in environment");
  }
  // Funnel through the in-flight guard so concurrent hub-connect attempts
  // don't double-call validate or loginKey.
  const session = topstepSessionState();
  if (session.refreshHeld) throw refreshHeldError();
  if (session.inFlightTokenMint) {
    return session.inFlightTokenMint;
  }
  session.inFlightTokenMint = (async () => {
    const cached = getCachedToken();
    const nowSec = Math.floor(Date.now() / 1000);
    const client = new TopstepClient();

    // Warm path (in-process reconnects only): cached token exists and we
    // already proved the session is live earlier in this process. Try
    // /Auth/validate to refresh without minting. On a cold boot this
    // branch is skipped so we can't bind the hub to a dead session.
    if (didMintFreshSessionThisProcess && cached && cached.expiresAt > nowSec) {
      try {
        client.setToken(cached.token);
        const newToken = await client.validateSession();
        if (newToken) {
          const exp = jwtExpiry(newToken) ?? nowSec + 24 * 60 * 60;
          setCachedToken(newToken, exp);
          return newToken;
        }
      } catch {
        // fall through
      }
    }
    // Cold boot / dead-session path: mint fresh. This creates a new
    // Topstep session, so anything else logged in for this user gets
    // kicked — which is the whole point on startup. We only hit this
    // branch once per process in the happy path.
    try {
      const token = await client.authenticate(creds);
      const exp = jwtExpiry(token) ?? nowSec + 24 * 60 * 60;
      setCachedToken(token, exp);
      // A login that worked retires any failure `getToken()` is backing
      // off from. This path neither honours nor stamps that backoff.
      session.lastFailedMint = null;
      didMintFreshSessionThisProcess = true;
      return token;
    } catch (err) {
      clearCachedToken();
      throw err;
    }
  })().finally(() => {
    session.inFlightTokenMint = null;
  });
  return session.inFlightTokenMint;
}

// ── Dead cached token ──────────────────────────────────────────────────
//
// The gateway can kill a token long before its `exp`. The hot path cannot
// see that — it reads the row and makes no call — so the row has to be
// dropped by whoever is told: a REST caller whose 401 survived
// `/Auth/validate`. Once it is gone the ordinary cold path does the rest,
// through the same in-flight promise as every other mint.

/**
 * At most one dead-token drop — so at most one mint it causes — per window.
 * The case it exists for is a login that *succeeds* and hands back a token
 * the gateway then refuses (an API key without REST access): without it
 * every request drops the new row and mints again, each one a new Topstep
 * session. A login that *fails* never gets this far — it leaves no row to
 * drop, and `FAILED_MINT_BACKOFF_MS` is what bounds that. Long enough that
 * such a gateway sees a handful of mints an hour; short enough that a second
 * genuine kill the same day is not left for the ~23h the first one was.
 */
export const DEAD_TOKEN_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;

const AUTH_LOG_TAG = "auth";

/** Caller has already established that the cache holds the dead token. */
function dropDeadCachedToken(path: string, whatNext: string): boolean {
  const session = topstepSessionState();
  const now = Date.now();
  if (
    session.lastDeadTokenDropAtMs !== null &&
    now - session.lastDeadTokenDropAtMs < DEAD_TOKEN_RECOVERY_COOLDOWN_MS
  ) {
    log.debug(
      AUTH_LOG_TAG,
      `Topstep refused the cached session token on ${path} inside the dead-token cooldown — left in the cache, no new session minted`,
    );
    return false;
  }
  session.lastDeadTokenDropAtMs = now;
  session.mintAttemptedSinceDrop = false;
  clearCachedToken();
  log.event(
    "broker_token_dead",
    AUTH_LOG_TAG,
    `Topstep refused the cached session token on ${path} before its expiry — dropped it from the cache; ${whatNext}`,
  );
  return true;
}

/**
 * The error's class or HTTP status and nothing else. Its message can carry
 * the gateway's raw body — which echoes the user name — and this line goes
 * to the log stream and to Discord.
 */
function mintFailureKind(err: unknown): string {
  if (err instanceof UnauthorizedError) return "HTTP 401";
  if (!(err instanceof Error)) return typeof err;
  const status = /^Topstep API error (\d{3}) /.exec(err.message)?.[1];
  return status ? `HTTP ${status}` : err.name;
}

/** The one mint a drop is owed. Marked before the call so a caller arriving
 *  after it has failed cannot start another. */
async function mintReplacement(): Promise<string | null> {
  topstepSessionState().mintAttemptedSinceDrop = true;
  try {
    return await getToken();
  } catch (err) {
    log.event(
      "broker_token_recovery_failed",
      AUTH_LOG_TAG,
      `Could not mint a replacement for the dead Topstep session token, so Topstep REST calls keep failing until a login succeeds. The login failed with: ${mintFailureKind(err)}`,
    );
    return null;
  }
}

async function remintDeadToken(deadToken: string, path: string): Promise<string | null> {
  const session = topstepSessionState();
  if (session.refreshHeld) return null;
  const cached = getCachedToken();
  // Someone else's recovery, or an ordinary refresh, already replaced it.
  if (cached && cached.token !== deadToken) return getToken();
  // Already dropped. Ride a mint that is in the air. With none, the drop was
  // a place 401's — which may not mint — or the mint has already failed: the
  // first is owed its one mint, and it is this caller that starts it, since
  // a client still holding the dead token (the engine's, between requests)
  // has no other way back. The second gets nothing, or a failed recovery
  // becomes a mint per refused request.
  if (!cached) {
    if (session.inFlightTokenMint) return session.inFlightTokenMint;
    if (session.mintAttemptedSinceDrop) return null;
    return mintReplacement();
  }
  if (!dropDeadCachedToken(path, "minting a fresh session and retrying the call once")) {
    return null;
  }
  return mintReplacement();
}

function discardDeadToken(deadToken: string, path: string): void {
  if (topstepSessionState().refreshHeld) return;
  if (getCachedToken()?.token !== deadToken) return;
  dropDeadCachedToken(path, "the call is not retried and the next Topstep call mints a fresh session");
}

topstepSessionState().recovery = { remint: remintDeadToken, discard: discardDeadToken };
