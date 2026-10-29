import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";

/**
 * Direct passthrough to /api/Order/place. Returns Topstep's raw response
 * status, headers, and body — whatever they send back, unprocessed. Use
 * this to verify what's actually on the wire when our wrapped client
 * claims "empty body".
 *
 * The bearer it forwards is Topstep's own JWT, read from the plugin rather
 * than from a request header.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = await topstepBrowserToken();
  if (!token) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }

  const acceptOverride = request.headers.get("x-accept-override");

  const res = await fetch("https://api.topstepx.com/api/Order/place", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": acceptOverride ?? "text/plain",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });

  let parsedBody: unknown = rawText;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    /* keep as text */
  }

  return NextResponse.json({
    status: res.status,
    statusText: res.statusText,
    headers: headerObj,
    bodyText: rawText,
    body: parsedBody,
    sentPayload: payload,
    sentAccept: acceptOverride ?? "application/json",
  });
}
