import { NextResponse } from "next/server";
import { APP_SESSION_TTL_MS, validateSession } from "@/lib/db/auth";
import { log } from "@/lib/logger";

/**
 * The app's request gate. One helper for every gated route, replacing the
 * sixteen copy-pasted `requireToken` functions and the inline header checks
 * that preceded it.
 *
 * Two things changed when this replaced the old broker-JWT header:
 *
 *  1. **It validates.** The old gate checked header presence only, so any
 *     non-empty string authenticated a deployment insert or a factory
 *     reset. Nobody chose that; it fell out of borrowing Topstep's JWT as
 *     the session, and it is not carried forward.
 *  2. **It is not a broker credential.** A Tradovate-only install can hold
 *     a session, which is the whole point of the decoupling — a pure
 *     SQLite read like `GET /api/deployments` has no business demanding a
 *     Topstep token.
 *
 * Transport is an `HttpOnly` cookie: script cannot read it, and it rides
 * every same-origin `fetch` and the SSE stream with nothing to set. The
 * header that carried it before is still read, for one release, so a tab
 * left open across the deploy keeps working until it reloads.
 */
export const SESSION_COOKIE = "crossfire_session";

/** The previous transport. Accepted for one release after the cookie
 *  shipped, then deleted with every mention of it. */
export const LEGACY_SESSION_HEADER = "x-session-token";

interface GatedRequest {
  headers: Headers;
}

let legacyHeaderLogged = false;

function cookieValue(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** The session the request presents, cookie first. The header is the
 *  fallback only when no cookie is sent, so a client that sends both is
 *  judged on the cookie. */
export function presentedSessionToken(request: GatedRequest): string | null {
  return cookieValue(request.headers, SESSION_COOKIE) ?? legacyHeaderValue(request.headers);
}

/** An empty header is no header, as it was when the header was the transport. */
function legacyHeaderValue(headers: Headers): string | null {
  return headers.get(LEGACY_SESSION_HEADER) || null;
}

function holdsSession(request: GatedRequest): boolean {
  const cookie = cookieValue(request.headers, SESSION_COOKIE);
  if (cookie !== null) return validateSession(cookie);
  const header = legacyHeaderValue(request.headers);
  if (header === null || !validateSession(header)) return false;
  if (!legacyHeaderLogged) {
    legacyHeaderLogged = true;
    log.warn(
      "auth",
      `a request signed in with the ${LEGACY_SESSION_HEADER} header, which is deprecated — ` +
        "a browser tab opened before the sign-in cookie shipped; it stops working once the header is removed",
    );
  }
  return true;
}

/** Returns a 401 response to hand straight back, or `null` when the caller
 *  holds a live session. Synchronous — better-sqlite3 is. */
export function requireSession(request: GatedRequest): NextResponse | null {
  if (presentedSessionToken(request) === null) {
    return NextResponse.json({ error: "Missing session token" }, { status: 401 });
  }
  if (!holdsSession(request)) {
    return NextResponse.json({ error: "Invalid session token" }, { status: 401 });
  }
  return null;
}

/** The boolean form, for the routes that branch on authentication rather
 *  than refusing without it: `/api/settings/test-connection` also serves the
 *  unauthenticated first run, and `/api/auth` resumes a signed-in browser. */
export function hasSession(request: GatedRequest): boolean {
  return holdsSession(request);
}

/**
 * `Secure` only when the browser reached us over https. The operator's envs
 * and a public install are often plain http on a LAN, where a `Secure`
 * cookie is never sent back and nobody could sign in. Next fills
 * `x-forwarded-proto` from the socket when no proxy set it — so behind a TLS
 * proxy that does not set it, the socket is plain http and the cookie loses
 * `Secure` while the browser is on https. Such a proxy must send
 * `X-Forwarded-Proto: https` (infra/README).
 */
export function requestIsHttps(request: { headers: Headers; url: string }): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

function cookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  // SameSite=Strict: the app is served and called on one origin, so no
  // legitimate request ever arrives cross-site carrying the cookie.
  const attrs = [`Max-Age=${maxAgeSeconds}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Lives as long as the session row it names. */
export function setSessionCookie(response: NextResponse, token: string, secure: boolean): void {
  const maxAge = Math.floor(APP_SESSION_TTL_MS / 1000);
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieAttributes(secure, maxAge)}`);
}

export function clearSessionCookie(response: NextResponse, secure: boolean): void {
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttributes(secure, 0)}`);
}

/** Test seam: the deprecation line is once per process. */
export function resetLegacyHeaderLogForTests(): void {
  legacyHeaderLogged = false;
}
