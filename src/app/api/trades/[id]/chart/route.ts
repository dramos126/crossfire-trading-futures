import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { getTradeById, getTradeBars } from "@/lib/db/trades";
import { getStrategy } from "@/lib/trading/strategies";
import { resolveTimeframe } from "@/lib/trading/strategy-types";
import { getDeployment } from "@/lib/db/deployments";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import type { BarData, BarUnit } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";

/**
 * Returns the bar window around a single trade for the per-trade chart
 * stub on the deployments page. Window matches the at-exit snapshot
 * (300 before entry, 50 after exit) so live and snapshotted views look
 * the same. Lazy-fetched on row expand.
 */

const TIMEFRAME_TO_BAR: Record<Timeframe, { unit: BarUnit; unitNumber: number; minutes: number }> = {
  "1m":  { unit: 2, unitNumber: 1,  minutes: 1 },
  "3m":  { unit: 2, unitNumber: 3,  minutes: 3 },
  "5m":  { unit: 2, unitNumber: 5,  minutes: 5 },
  "15m": { unit: 2, unitNumber: 15, minutes: 15 },
  "30m": { unit: 2, unitNumber: 30, minutes: 30 },
  "1h":  { unit: 3, unitNumber: 1,  minutes: 60 },
  "4h":  { unit: 3, unitNumber: 4,  minutes: 240 },
  "1d":  { unit: 4, unitNumber: 1,  minutes: 1440 },
};

const handle = engineHandle();

const BARS_BEFORE_ENTRY = 300;
const BARS_AFTER_EXIT = 50;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid trade id" }, { status: 400 });
  }

  const trade = getTradeById(id);
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });

  // Snapshot path: closed trades have a stored bar window from
  // saveTradeBars (engine fires after closeTrade). Serve a mature one
  // verbatim — preserves the chart even after Topstep ages the
  // contract out of /retrieveBars (~3 months). An immature one is
  // taken at the exit and lacks the exit bar itself, so the chart
  // stopped short of the fill; fetch live and keep it as the fallback.
  const snapshot = getTradeBars(id);
  const snapshotResponse = snapshot
    ? NextResponse.json({
        trade,
        bars: snapshot.bars,
        timeframe: snapshot.timeframe,
        source: "snapshot",
        capturedAt: snapshot.capturedAt,
      })
    : null;
  const snapshotMature = snapshot != null
    && (snapshot.matureAt == null || Date.parse(snapshot.matureAt) <= Date.now());
  if (snapshotResponse && snapshotMature) return snapshotResponse;

  let tf: Timeframe;
  if (snapshot) {
    tf = snapshot.timeframe as Timeframe;
  } else {
    const strategy = getStrategy(trade.strategyKey);
    if (!strategy) {
      return NextResponse.json({ error: `Strategy ${trade.strategyKey} not loaded` }, { status: 404 });
    }
    const deployment = trade.deploymentId ? getDeployment(trade.deploymentId) : null;
    tf = resolveTimeframe(strategy.config, deployment?.paramValues) as Timeframe;
  }
  const cfg = TIMEFRAME_TO_BAR[tf];
  if (!cfg && snapshotResponse) return snapshotResponse;
  if (!cfg) return NextResponse.json({ error: `Unknown timeframe ${tf}` }, { status: 500 });

  // Window endpoints. Entry timestamp is what we'd plot against; if the
  // entry hasn't filled yet (pending_entry) fall back to submitted-at.
  const entryIso = trade.entryFilledAt ?? trade.entrySubmittedAt;
  const entryMs = new Date(entryIso).getTime();
  const exitMs = trade.exitFilledAt ? new Date(trade.exitFilledAt).getTime() : Date.now();

  const padBeforeMs = BARS_BEFORE_ENTRY * cfg.minutes * 60 * 1000;
  const padAfterMs = BARS_AFTER_EXIT * cfg.minutes * 60 * 1000;
  const startTime = new Date(entryMs - padBeforeMs).toISOString();
  const endTime = new Date(exitMs + padAfterMs).toISOString();

  try {
    // A Tradovate trade row carries the execution symbol, which the bar
    // provider has never heard of. The live-sub scan alone answered nothing
    // here by construction — a closed trade's deployment is long gone — so
    // every Tradovate per-trade chart came back empty.
    //
    // **The raw-id fallback is load-bearing, not laziness.** `marketDataContractId`
    // resolves through the front month and refuses anything else, so a closed
    // trade on a since-rolled contract needs a historical id it cannot give.
    // Passing the row's own id through is the only remaining chance of a hit,
    // and it is what a Topstep row has always used.
    const barContractId = (await handle.marketDataContractId(trade.contractId)) ?? trade.contractId;
    const bars: BarData[] = await marketDataRegistry.historical().retrieveBars({
      contractId: barContractId,
      live: false,
      startTime,
      endTime,
      unit: cfg.unit,
      unitNumber: cfg.unitNumber,
      // 300 + 50 = 350 baseline; long-running open trades can extend
      // further so cap generously.
      limit: 1000,
      includePartialBar: true,
    });
    if (bars.length === 0 && snapshotResponse) return snapshotResponse;

    return NextResponse.json({
      trade,
      bars,
      timeframe: tf,
      source: "live",
    });
  } catch (err) {
    if (snapshotResponse) return snapshotResponse;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch chart bars" },
      { status: 502 },
    );
  }
}
