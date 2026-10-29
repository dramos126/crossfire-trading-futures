import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";

/**
 * Passthrough: calls /api/Contract/search with the user's exact payload
 * and returns the raw Topstep response unmodified. Used to inspect every
 * field (including ones our typed Contract interface may be dropping).
 *
 * The bearer it forwards is Topstep's own JWT, read from the plugin. It
 * used to arrive in the request header; the token is the same, the browser
 * just no longer has to carry it.
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

  const token = await topstepBrowserToken();
  if (!token) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }

  const res = await fetch("https://api.topstepx.com/api/Contract/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/plain",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return NextResponse.json({ status: res.status, body: parsed });
}
