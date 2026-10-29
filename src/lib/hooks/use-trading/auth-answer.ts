import { INVALID_SIGN_IN_MESSAGE, type RateLimitScope } from "@/lib/auth/sign-in-wire";

/**
 * What `POST /api/auth` answered, read once at the boundary, and the words
 * the operator sees for each way it can fail. The provider, the sign-in form
 * and the warning banner all go through here, so one failure never reads two
 * ways and raw server text never reaches the banner.
 */

/** A failure that leaves the provider in `error`: it is about the install
 *  or the network, not about what the person typed. */
export type ConnectFailureKind = "broker-not-configured" | "broker-refused" | "unreachable" | "unknown";

export type AuthFailure =
  | { kind: "invalid-sign-in" }
  | { kind: "rate-limited"; retryAfterSeconds: number; scope: RateLimitScope }
  | { kind: ConnectFailureKind };

export type AuthAnswer =
  | { kind: "signed-in"; engineReady: boolean }
  /** No broker anywhere, or no sign-in account yet — first run fixes both. */
  | { kind: "needs-setup" }
  | { kind: "sign-in-required" }
  | { kind: "failed"; failure: AuthFailure; detail: string };

const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_GATEWAY_STATUSES = new Set([502, 503, 504]);
/** The route's 500 for a Topstep install with no key anywhere. */
const MISSING_CREDENTIALS_RE = /Missing TOPSTEP/;

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

export function readAuthAnswer(status: number, body: unknown): AuthAnswer {
  if (status === 200 && field(body, "signedIn") === true) {
    return { kind: "signed-in", engineReady: field(body, "engineReady") === true };
  }
  if (field(body, "needsSetup") === true || field(body, "needsAccount") === true) {
    return { kind: "needs-setup" };
  }
  if (status === HTTP_UNAUTHORIZED && field(body, "signInRequired") === true) {
    return { kind: "sign-in-required" };
  }
  const error = field(body, "error");
  const detail = typeof error === "string" ? error : `request failed (${status})`;
  return { kind: "failed", failure: failureOf(status, body, detail), detail };
}

function failureOf(status: number, body: unknown, detail: string): AuthFailure {
  if (status === HTTP_UNAUTHORIZED && field(body, "invalidSignIn") === true) {
    return { kind: "invalid-sign-in" };
  }
  if (status === HTTP_TOO_MANY) return rateLimitedFailure(body);
  if (status === HTTP_SERVER_ERROR && MISSING_CREDENTIALS_RE.test(detail)) {
    return { kind: "broker-not-configured" };
  }
  if (status === HTTP_UNAUTHORIZED) return { kind: "broker-refused" };
  if (HTTP_GATEWAY_STATUSES.has(status)) return { kind: "unreachable" };
  return { kind: "unknown" };
}

/** A 429 body from any limited route — sign-in, *Change password*, first
 *  run's setup code. A body that names no lockout reads as the address's. */
export function rateLimitedFailure(body: unknown): AuthFailure {
  const wait = field(body, "retryAfterSeconds");
  const lockout = field(body, "lockout");
  return {
    kind: "rate-limited",
    retryAfterSeconds: typeof wait === "number" ? wait : 0,
    scope: lockout === "server" || lockout === "busy" ? lockout : "address",
  };
}

/** One request to the route. A throw is the network, so it is `unreachable`,
 *  never an exception the caller has to remember to catch. */
export async function postAuth(credentials?: { username: string; password: string }): Promise<AuthAnswer> {
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      ...(credentials
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) }
        : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    return readAuthAnswer(res.status, body);
  } catch (err) {
    return {
      kind: "failed",
      failure: { kind: "unreachable" },
      detail: err instanceof Error ? err.message : "network error",
    };
  }
}

export const BROKER_NOT_CONFIGURED_COPY =
  "No broker connection is set up, so nothing can trade. Add one on the Connections page in Settings.";
export const BROKER_REFUSED_COPY =
  "Your broker turned down the saved credentials, so nothing can trade. Check them on the Connections page in Settings, then reconnect.";
export const UNREACHABLE_COPY =
  "The Crossfire server did not answer. Check that it is running, then reconnect.";
export const UNKNOWN_FAILURE_COPY = "Could not connect. Reconnect to try again.";

const SECONDS_PER_MINUTE = 60;

function waitText(seconds: number): string {
  if (seconds <= 0) return "a moment";
  if (seconds < SECONDS_PER_MINUTE) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / SECONDS_PER_MINUTE);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export const VERIFY_BUSY_COPY = "Another sign-in was being checked at that moment. Try again.";

/** A lockout on every address says so: "from this address" would send the
 *  operator looking for a fault on their own machine. */
function rateLimitedCopy(scope: RateLimitScope, retryAfterSeconds: number): string {
  if (scope === "busy") return VERIFY_BUSY_COPY;
  const where = scope === "server" ? "on this server" : "from this address";
  return `Too many wrong sign-ins ${where}. Try again in ${waitText(retryAfterSeconds)}.`;
}

export function authFailureCopy(failure: AuthFailure): string {
  switch (failure.kind) {
    case "invalid-sign-in":
      return INVALID_SIGN_IN_MESSAGE;
    case "rate-limited":
      return rateLimitedCopy(failure.scope, failure.retryAfterSeconds);
    case "broker-not-configured":
      return BROKER_NOT_CONFIGURED_COPY;
    case "broker-refused":
      return BROKER_REFUSED_COPY;
    case "unreachable":
      return UNREACHABLE_COPY;
    case "unknown":
      return UNKNOWN_FAILURE_COPY;
  }
}

/** Narrows a failure to the kinds that put the provider in `error`. A wrong
 *  pair or a lockout is the sign-in form's to show, not the banner's. */
export function connectFailureKind(failure: AuthFailure): ConnectFailureKind {
  return failure.kind === "invalid-sign-in" || failure.kind === "rate-limited" ? "unknown" : failure.kind;
}
