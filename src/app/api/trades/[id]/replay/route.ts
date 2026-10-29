import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  getReplayResult,
  getTradeBars,
  getTradeById,
  setReplayResult,
} from "@/lib/db/trades";
import { getDeployment } from "@/lib/db/deployments";
import { getStrategy } from "@/lib/trading/strategies";
import { resolveTimeframe } from "@/lib/trading/strategy-types";
import { runReplay, isReplayResultCacheable } from "@/lib/trading/replay/replay";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import type { BacktestReplayResult } from "@/components/chart/trade-markers";
import type { Timeframe } from "@/lib/trading/domain";

/**
 * Replay endpoint — invokes the live-vs-backtest replay engine for a
 * closed trade and returns a BacktestReplayResult.
 *
 * Cache strategy: closed trades are immutable, so the result is computed
 * once and persisted on the trade row (replay_result_json). Subsequent
 * calls return the cached blob without recomputing.
 *
 * Gated. A cache miss runs strategy evaluation plus a market-data read
 * per request with no cost bound, so this is the most expensive GET in
 * the app to leave open.
 */

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
  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  // Cache hit — closed trades never mutate so a previously computed
  // replay result is authoritative. Open trades skip the cache (the
  // exit isn't known yet) but still flow through replayTrade so the
  // UI can preview the entry-side comparison.
  if (trade.status === "closed") {
    const cached = getReplayResult(id);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as BacktestReplayResult;
        return NextResponse.json(parsed);
      } catch {
        // Fall through to recompute on corrupt cache.
      }
    }
  }

  const strategy = getStrategy(trade.strategyKey);
  if (!strategy) {
    const result: BacktestReplayResult = {
      status: "no_signal",
      noSignalReason: `strategy ${trade.strategyKey} not loaded`,
    };
    return NextResponse.json(result);
  }

  const deployment = trade.deploymentId ? getDeployment(trade.deploymentId) : null;
  const timeframe = resolveTimeframe(strategy.config, deployment?.paramValues) as Timeframe;

  // Prefer the at-exit bar snapshot when one exists — it sidesteps the
  // 3-month Topstep retention gate so older trades still replay. Only
  // fall back to a live fetch when there's no snapshot (open trades,
  // or rows that closed before the snapshot feature shipped).
  //
  // Maturity gate: a snapshot taken immediately on close only contains
  // bars Topstep had published through "now," so the trigger bar lands
  // at/near the end of the window and runReplay returns
  // "insufficient post-entry bars for replay". Treat the snapshot as
  // authoritative only once its bars_mature_at has elapsed; otherwise
  // route through the live-fetch branch below (replay-bars pads past
  // exit so live always has runway). NULL matureAt = mature.
  const snapshot = getTradeBars(id);
  const snapshotMature =
    snapshot != null && (snapshot.matureAt == null || new Date(snapshot.matureAt) <= new Date());
  const snapshotBars = snapshotMature && snapshot ? snapshot.bars : null;

  // No snapshot means the live-fetch fallback runs, which needs a
  // configured market-data provider. An unconfigured one is a no_signal;
  // a configured-but-failing one surfaces as a bar-fetch failure inside
  // runReplay, which is the more useful message.
  const allowLiveFetch = !snapshotBars && marketDataRegistry.historical().isConfigured();

  const result = await runReplay({
    trade,
    strategy,
    snapshotBars,
    allowLiveFetch,
    timeframe,
    tickSize: trade.tickSize ?? 0.25,
    tickValue: trade.tickValue,
  });

  // Cache the closed-trade result for next time. Open / pending trades
  // are skipped — their exit can still mutate, so we'd risk pinning a
  // stale snapshot. Environmental no_signal results (transient bar-fetch
  // failures, missing engine client) are also skipped via
  // isReplayResultCacheable so a one-off outage doesn't permanently pin
  // the trade's replay state.
  if (trade.status === "closed" && isReplayResultCacheable(result)) {
    try {
      setReplayResult(id, JSON.stringify(result));
    } catch {
      // Cache write is best-effort; never fail the request on it.
    }
  }

  return NextResponse.json(result);
}
