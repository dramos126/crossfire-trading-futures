import { NextRequest, NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { listRegimeDaysForSession, type RegimeDay } from "@/lib/db/regime-days";
import { log } from "@/lib/logger";
import { CLASSIFIER_VERSION } from "@/lib/trading/regime/classify-regime";
import { sessionDateOf } from "@/lib/trading/regime/session-dates";

/**
 * The board's regime chip: one session day's labels, per instrument, with the
 * features behind each one.
 *
 * **It reads `regime_days` and never classifies.** The label is a record
 * written by the nightly job or the lazy fill; a route that recomputed one
 * would answer a different question from the one the trade rows were stamped
 * against, and would put a year-deep bar read behind a page load.
 *
 * The session day defaults to the one the request lands in, so the chip
 * answers *what is today's regime* without the client doing 18:00-ET
 * arithmetic of its own.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RegimeDayPayload {
  ticker: string;
  label: string;
  vol: string | null;
  range: string | null;
  classifierVersion: string;
  features: RegimeDay["features"];
  computedAt: string;
  source: RegimeDay["source"];
}

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const requested = new URL(request.url).searchParams.get("sessionDate");
  if (requested != null && !DATE_RE.test(requested)) {
    return NextResponse.json({ error: "sessionDate must be YYYY-MM-DD" }, { status: 400 });
  }
  const sessionDate = requested ?? sessionDateOf(new Date());

  try {
    const days = listRegimeDaysForSession(sessionDate, CLASSIFIER_VERSION);
    return NextResponse.json({
      sessionDate,
      classifierVersion: CLASSIFIER_VERSION,
      days: days.map(toPayload),
    });
  } catch (err) {
    // Same rule as the trades export: a SQLite message names the database
    // file and the failing statement, and this route answers anything on the
    // LAN holding a session token.
    log.error("regime", `regime day query failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Failed to read regime labels" }, { status: 500 });
  }
}

function toPayload(day: RegimeDay): RegimeDayPayload {
  return {
    ticker: day.ticker,
    label: day.label,
    vol: day.vol,
    range: day.range,
    classifierVersion: day.classifierVersion,
    features: day.features,
    computedAt: day.computedAt,
    source: day.source,
  };
}
