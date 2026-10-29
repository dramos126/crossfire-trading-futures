import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getTradeBarsBatch } from "@/lib/db/trades";

/**
 * Batch read of per-trade bar snapshots from `strategy_trade_bars`. Used
 * by the deployment-trades export to fold bars into the JSON payload
 * without one /chart round-trip per row.
 *
 * Trades whose snapshot row is missing (rare — engine writes one on every
 * exit fill) are silently omitted; the export client emits `bars: null`
 * for those.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const tradeIdsRaw = (body as { tradeIds?: unknown }).tradeIds;
  if (!Array.isArray(tradeIdsRaw)) {
    return NextResponse.json({ error: "tradeIds must be an array of integers" }, { status: 400 });
  }
  const tradeIds: number[] = [];
  for (const v of tradeIdsRaw) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      return NextResponse.json({ error: "tradeIds must be an array of integers" }, { status: 400 });
    }
    tradeIds.push(v);
  }

  try {
    const rows = getTradeBarsBatch(tradeIds);
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load trade bars" },
      { status: 500 },
    );
  }
}
