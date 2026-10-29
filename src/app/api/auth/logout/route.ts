import { NextRequest, NextResponse } from "next/server";
import { revokeSession } from "@/lib/db/auth";
import {
  clearSessionCookie,
  presentedSessionToken,
  requestIsHttps,
  requireSession,
} from "@/lib/auth/session";

/** Sign out: the session row goes and the cookie is cleared. Gated like any
 *  other route — a browser with no session has nothing to sign out of. */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  const token = presentedSessionToken(request);
  if (token !== null) revokeSession(token);
  const response = NextResponse.json({ signedOut: true });
  clearSessionCookie(response, requestIsHttps(request));
  return response;
}
