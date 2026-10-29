import { NextRequest, NextResponse } from "next/server";
import { hashSessionToken, revokeOtherSessions } from "@/lib/db/auth";
import { changeWebAccountPassword, webAccountUsername } from "@/lib/db/web-account";
import { presentedSessionToken, requireSession } from "@/lib/auth/session";
import { clientAddress, limitedAttempt, rateLimitedResponse } from "@/lib/auth/login-limiter";
import { WRONG_CURRENT_PASSWORD_MESSAGE } from "@/lib/auth/sign-in-wire";

/** Its own namespace in the limiter, which also holds sign-in addresses. */
const CHANGE_PASSWORD_KEY_PREFIX = "pw:";

/**
 * Settings' *Change password*. Signed in, and the current password again —
 * a session left open on someone else's screen must not be enough to lock
 * the owner out. Wrong current passwords count against the session that sent
 * them, not its address: the address is whatever `x-forwarded-for` claims, so
 * a borrowed session keyed on it would get a fresh count per forged header.
 * Not against the global ceiling: a guesser flooding `/api/auth` from forged
 * addresses must not also lock the signed-in owner out of changing it.
 *
 * Every other session is dropped on success: whoever else is signed in may
 * be why the password is changing. The caller's session is kept.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { currentPassword, newPassword } = (body ?? {}) as Record<string, unknown>;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return NextResponse.json({ error: "currentPassword and newPassword required" }, { status: 400 });
  }
  const username = webAccountUsername();
  if (username === null) {
    return NextResponse.json({ error: "No sign-in account exists." }, { status: 409 });
  }

  const token = presentedSessionToken(request);
  const attempt = await limitedAttempt(
    limiterKey(token, request.headers),
    () => changeWebAccountPassword(username, currentPassword, newPassword),
    (result) => result.ok || result.reason !== "wrong-password",
    { serverWide: false },
  );
  if (attempt.refusal) return rateLimitedResponse(attempt.refusal);
  const result = attempt.value;
  if (!result.ok) {
    if (result.reason === "invalid") {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }
    return NextResponse.json({ error: WRONG_CURRENT_PASSWORD_MESSAGE }, { status: 403 });
  }
  if (token !== null) revokeOtherSessions(token);
  return NextResponse.json({ changed: true });
}

/** Hashed, so the limiter's map never holds a live session token. The address
 *  fallback cannot be reached: `requireSession` has already refused a request
 *  that presents no token. */
function limiterKey(token: string | null, headers: Headers): string {
  return token === null ? clientAddress(headers) : `${CHANGE_PASSWORD_KEY_PREFIX}${hashSessionToken(token)}`;
}
