import { NextRequest, NextResponse } from "next/server";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import type { TradovateBrokerPlugin } from "@/lib/brokers/tradovate/index";
import { getToken } from "@/lib/brokers/topstep/auth";
import { createSession } from "@/lib/db/auth";
import { hasWebAccount, verifyWebAccount } from "@/lib/db/web-account";
import { hasSession, requestIsHttps, setSessionCookie } from "@/lib/auth/session";
import { clientAddress, limitedAttempt, rateLimitedResponse } from "@/lib/auth/login-limiter";
import { passwordTooLong } from "@/lib/auth/web-account-rules";
import {
  INVALID_SIGN_IN_MESSAGE,
  SIGN_IN_REQUIRED_MESSAGE,
  type SignedInBody,
} from "@/lib/auth/sign-in-wire";
import { log } from "@/lib/logger";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();
/** A guesser rotating addresses trips a lockout per address; the pipe
 *  collapses them into one line. */
const SIGN_IN_LOCKOUT_BURST_KEY = "sign-in-lockout";
/** The address is whatever the client put in `x-forwarded-for`, so the log
 *  line carries a bounded slice of it. */
const LOGGED_ADDRESS_MAX_CHARS = 64;

// The app's only login, and one of the four unauthenticated routes. It mints
// an **app session** — see `src/lib/auth/session.ts` — into an `HttpOnly`
// cookie, never into the body. Two calls share it:
//
//  - **Sign in** — a body `{ username, password }`. A session is minted only
//    when the pair verifies against the one local account *and* a configured
//    broker authenticates. A wrong pair is one 401 body whichever half was
//    wrong, and wrong pairs are rate-limited per address with one check at
//    a time per process (`login-limiter.ts`).
//  - **Resume** — no body. A page load asks whether the browser's cookie is
//    still a session, and the broker check runs as it does on sign-in. It
//    mints nothing, so a reload costs no `app_session` row.
//
// Before either, with no sign-in account yet: `503 { needsSetup }` when no
// broker is configured anywhere, `503 { needsAccount }` when one is. Both send
// the browser to first run on the Settings page.
//
// **With no broker configured the pair alone signs in** (2026-10-29): first run
// asks only for the sign-in, and the install is browsed until a broker is
// connected in Settings. The answer says `brokerConfigured: false`, and there
// is no broker check to run because there is nothing that could trade.
//
// The broker check is otherwise today's: any configured broker authenticating
// is enough. Topstep goes first through the same `getToken()` the engine uses,
// so a cold cache cannot double-mint and kick the engine's session.
// Tradovate is asked for a *live* token, not a client: its plugin keeps
// `_client` through an auth failure, so a non-null client once handed a
// 30-day session over a rotated password.
export async function POST(request: NextRequest) {
  const parsed = await readSignIn(request);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const topstep = brokerRegistry.getPlugin("topstep");
  const tradovate = brokerRegistry.getPlugin("tradovate") as TradovateBrokerPlugin | null;
  const topstepConfigured = topstep?.isConfigured() === true;
  const tradovateConfigured = tradovate?.isConfigured() === true;
  const brokerConfigured = topstepConfigured || tradovateConfigured;
  if (!hasWebAccount()) {
    return NextResponse.json(brokerConfigured ? { needsAccount: true } : { needsSetup: true }, {
      status: 503,
    });
  }

  if (parsed.credentials === null) {
    if (!hasSession(request)) {
      return NextResponse.json(
        { signInRequired: true, error: SIGN_IN_REQUIRED_MESSAGE },
        { status: 401 },
      );
    }
  } else {
    const refused = await refuseSignIn(request, parsed.credentials);
    if (refused) return refused;
  }

  let body: SignedInBody;
  if (brokerConfigured) {
    const brokerFailure = await authenticateBroker(
      topstepConfigured,
      tradovateConfigured ? tradovate : null,
    );
    if (brokerFailure !== null) {
      const status = brokerFailure.message.includes("Missing TOPSTEP") ? 500 : 401;
      return NextResponse.json({ error: brokerFailure.message }, { status });
    }
    const hubsReady = await handle.areHubsReady();
    body = { signedIn: true, engineReady: hubsReady === true, brokerConfigured: true };
  } else {
    body = { signedIn: true, engineReady: false, brokerConfigured: false };
  }
  const response = NextResponse.json(body);
  if (parsed.credentials !== null) {
    setSessionCookie(response, createSession(), requestIsHttps(request));
  }
  return response;
}

interface Credentials {
  username: string;
  password: string;
}

async function readSignIn(
  request: NextRequest,
): Promise<{ credentials: Credentials | null } | { error: string }> {
  const text = await request.text();
  if (text.trim().length === 0) return { credentials: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON" };
  }
  if (typeof body !== "object" || body === null) return { error: "Expected object body" };
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    return { error: "username and password required" };
  }
  return { credentials: { username, password } };
}

/** The rate limit and the pair. `null` when the pair verified. */
async function refuseSignIn(
  request: NextRequest,
  { username, password }: Credentials,
): Promise<NextResponse | null> {
  const address = clientAddress(request.headers);
  const result = await limitedAttempt(
    address,
    async () => !passwordTooLong(password) && (await verifyWebAccount(username, password)),
    (verified) => verified,
  );
  if (result.refusal) return rateLimitedResponse(result.refusal);
  if (result.passed) return null;
  if (result.lockedOut) {
    log.warn(
      "auth",
      `sign-in locked for ${address.slice(0, LOGGED_ADDRESS_MAX_CHARS)}: too many wrong usernames or passwords`,
      undefined,
      SIGN_IN_LOCKOUT_BURST_KEY,
    );
  }
  return NextResponse.json({ invalidSignIn: true, error: INVALID_SIGN_IN_MESSAGE }, { status: 401 });
}

/** Today's broker check, unchanged: the first failure wins the message, and
 *  Tradovate is asked only when Topstep did not already authenticate. */
async function authenticateBroker(
  topstepConfigured: boolean,
  tradovate: TradovateBrokerPlugin | null,
): Promise<Error | null> {
  let failure: Error | null = null;
  if (topstepConfigured) {
    try {
      await getToken();
      return null;
    } catch (err) {
      failure = err instanceof Error ? err : new Error("Authentication failed");
    }
  }
  if (tradovate) {
    // `initialize()` owns the client lifecycle and no-ops on a fresh token,
    // where `testConnection()` would re-authenticate on every page load.
    try {
      await tradovate.initialize();
      if (tradovate.hasLiveToken()) return null;
      return failure ?? new Error("Tradovate authentication failed");
    } catch (err) {
      return failure ?? (err instanceof Error ? err : new Error("Authentication failed"));
    }
  }
  return failure ?? new Error("Authentication failed");
}
