import type { BarData } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { BacktestReplayResult } from "@/components/chart/trade-markers";
import {
  defaultParamValues,
  migrateLegacyParamOverrides,
  resolveTimeframe,
  type CommonParams,
  type ParamValues,
  type StrategyModule,
  type OpenPosition,
} from "../strategy-types";
import { calculateAll, type IndicatorResult } from "../indicators";
import { daySessionForTicker } from "../contracts/contract-specs";
import { collectSessionWindows, currentCmeSessionStart, isInAnySessionWindow } from "../session/session";
import { isValidBracketTicks } from "../orders/brackets";
import { computeWarmupBars, fetchReplayBars, findTriggerBarIndex } from "./replay-bars";
import {
  ENTRY_FILTER_REGISTRY,
  type AllFilterParams,
  type FilterPassContext,
} from "../filters";
import { ADX_INDICATOR_ID } from "../filters/adx";
import { SLOPE_INDICATOR_ID } from "../filters/slope";
import { evaluateDailyPnlGate } from "../daily-pnl-gate";
import { getAccountDailyPnlLimits } from "@/lib/db/account-brokers";
import { getAccountRealizedSinceGross } from "@/lib/db/trades";

/**
 * Live-vs-backtest replay engine.
 *
 * Re-runs `shouldEnter` against the same bar window the live engine
 * evaluated, using the params + filter state pinned on the trade row at
 * entry-placement time (paramSnapshot, filterSnapshot). Compares the
 * replay's outcome to the live trade's actuals to classify each closed
 * trade as MATCH / EXEC DRIFT / SIGNAL DRIFT / NO BACKTEST SIGNAL.
 *
 * Snapshotting is the foundation: replaying against the deployment's
 * *current* params would lie the moment the user edits the deployment.
 * If a snapshot is missing (trade predates the snapshotting feature),
 * replay short-circuits with `no_signal: no param snapshot` rather than
 * silently falling back to current params.
 *
 * Known fidelity caveat: live evaluates on a partial-bar tick stream;
 * replay reads only closed bars from the bar API. Today's strategies
 * are bar-close evaluators so the gap is theoretical. A future tick-
 * driven entry strategy would need a separate replay path.
 */

// Tick tolerances. Entry is tighter — backtest fills at bar close in a
// single moment, so a ±1-tick window covers float-rounding + the engine's
// "fill at bar close" approximation. Exits are slipperier: backtest checks
// bar high/low against the bracket, but the live broker fills *somewhere*
// inside the bar's spread, and SL gaps can blow through. 2 ticks keeps
// MATCH precise without flagging every gappy bar as EXEC DRIFT.
//
// These are universal — chosen against MNQ-like (thin-tick, deep-book)
// products. On thinner-book contracts the same tick count covers a wider
// fraction of typical spread, so EXEC_DRIFT will under-report; on fat-tick
// contracts (e.g. MGC at $10/tick) the same count is a tighter dollar
// window and may flag legitimate fills as drift. If the surface starts
// lying systematically on a specific contract, swap these for a per-
// contract map keyed off contractId — the rest of replayTrade is already
// contract-agnostic.
const ENTRY_TICK_TOLERANCE = 1;
const EXIT_TICK_TOLERANCE = 2;

// Cacheability predicate + transient-failure prefix list live in
// replay-classify.ts so the client-side analytics panel can share them
// without pulling in this server-only module's heavier dependency tree.
export { NON_CACHEABLE_NO_SIGNAL_PREFIXES, isReplayResultCacheable } from "./replay-classify";

/**
 * Compat shim for legacy session snapshots. Strips the pre-rework keys
 * (`activeStart` / `activeEnd` / `additionalSessions`) and guarantees a
 * `pauseWindows` array. Returns a fresh object; the original snapshot is not
 * mutated.
 *
 * **It no longer projects anything into a window**, because there is no window
 * on the snapshot to project into: replay takes the trading window from the
 * playbook's `config.session`, the same place the engine and the backtest take
 * it. A snapshot's own `mainSession` is dropped on load with the other retired
 * keys — replaying a trade under a window the strategy no longer runs would
 * report drift the operator never caused.
 */
function projectLegacySessionSnapshot(snapshot: ParamValues): ParamValues {
  const out: ParamValues = { ...snapshot };
  delete out.activeStart;
  delete out.activeEnd;
  delete out.additionalSessions;
  if (!Array.isArray(out.pauseWindows)) out.pauseWindows = [];
  return out;
}

export interface ReplayTradeArgs {
  trade: StrategyTrade;
  strategy: StrategyModule;
  /** Pre-fetched bar window. Caller should prefer the at-exit snapshot
   *  when one exists and only fall back to a live fetch when not. */
  bars: BarData[];
  /** The contract's tickSize at trade time. Required for indicator math
   *  + bracket-hit detection in the simulated walk-forward. */
  tickSize: number;
  /** Contract tick value (dollar P&L per tick). Used for the bt PnL
   *  surface; null leaves pnlDollars undefined. */
  tickValue: number | null;
}

/**
 * Run the replay against a closed live trade. Pure function — caller
 * owns IO (bar fetching, persisting the cached result).
 *
 * Returns a BacktestReplayResult ready for the comparison strip + chart
 * overlay. All four divergence states (match / exec_drift / signal_drift
 * / no_signal) flow through this function.
 */
export function replayTrade(args: ReplayTradeArgs): BacktestReplayResult {
  const { trade, strategy, bars, tickSize, tickValue } = args;

  if (trade.paramSnapshot == null) {
    return {
      status: "no_signal",
      noSignalReason: "no param snapshot (trade predates snapshotting)",
    };
  }
  if (bars.length === 0) {
    return { status: "no_signal", noSignalReason: "no bars available for replay window" };
  }

  // Merge snapshotted params over schema defaults so any param keys added
  // since this trade fired still have a value. Snapshotted values win on
  // collision — the whole point is to replay with the values the live
  // trade actually used. Project legacy session snapshots
  // (`activeStart`/`activeEnd`/`additionalSessions`) into the
  // `mainSession` shape first; replay only walks the trade's primary
  // window so dropping `additionalSessions` is safe.
  const projected = projectLegacySessionSnapshot(trade.paramSnapshot as ParamValues);
  const params = {
    ...defaultParamValues(strategy.params),
    ...migrateLegacyParamOverrides(
      trade.strategyKey,
      projected,
      { deploymentId: trade.deploymentId },
    ),
  } as CommonParams;

  const daySession = daySessionForTicker(trade.ticker);
  const indicatorConfigs =
    strategy.buildIndicators?.(params) ?? strategy.config.indicators;
  const indicators = calculateAll(indicatorConfigs, bars, daySession);

  const triggerIso = trade.entryFilledAt ?? trade.entrySubmittedAt;
  const triggerIdx = findTriggerBarIndex(bars, triggerIso);
  if (triggerIdx < 0) {
    return {
      status: "no_signal",
      noSignalReason: "trigger bar not found in replay window",
    };
  }

  const sessionWindows = collectSessionWindows(strategy.config.session, params);
  const triggerBar = bars[triggerIdx];

  // Bug guard: if the trigger bar is the LAST bar in the replay window
  // there are zero forward bars to simulate. The walk-forward loop below
  // would no-op and the end-of-data fallback would close at
  // `bars[bars.length - 1].close === triggerBar.close === btEntryPrice`,
  // producing a fake $0 PnL "match" / "exec_drift". Surface honestly so
  // it lands in the diagnostic no_signal bucket instead of polluting
  // EXEC DRIFT.
  if (triggerIdx >= bars.length - 1) {
    return {
      status: "no_signal",
      noSignalReason: "insufficient post-entry bars for replay",
    };
  }

  // Session gate. The live engine refuses entries outside the active
  // window, so if the trigger bar would land outside replay's session
  // window the replay's view is "shouldn't have fired here" — signal
  // drift, since live did fire.
  if (!isInAnySessionWindow(new Date(triggerBar.timestamp), sessionWindows)) {
    return {
      status: "signal_drift",
      noSignalReason: "filter blocked: session",
      blockedByFilter: "session",
    };
  }

  const entryCtx = {
    bars,
    barIndex: triggerIdx,
    indicators,
    position: null,
    params,
    tickSize,
    daySession,
    sessionWindows,
    crossTimeframeBars: new Map<string, BarData[]>(),
    // Replay evaluates signal-drift on a single trigger bar — engine cap
    // state at the moment of the live entry isn't reconstructed here.
    // Reporting "not entered" lets the strategy reach its real gate set
    // (momentum / second-breakout / filters) which is what drift testing
    // is about.
    hasEnteredThisSession: () => false,
  };

  // Per-filter attribution. Run each enabled entry filter individually
  // before `shouldEnter` so a veto can be attributed to the specific
  // filter + indicator value + threshold from the snapshot. The strategy's
  // `shouldEnter` typically calls `passesAllEntryFilters` again — that's
  // a harmless re-check since filters are pure functions of (bars,
  // params, indicators). We can't know the live trade's signal direction
  // ahead of `shouldEnter`, so we probe both sides; if EITHER side passes
  // we hand control to `shouldEnter`. (The slope filter is the only side-
  // sensitive one today.)
  // Strategies that consume filters spread `AllFilterParams` into their
  // own params shape, so the snapshot already has every filter's keys —
  // but `CommonParams` doesn't *declare* those keys, hence the cast
  // through unknown. The filter functions tolerate missing fields by
  // short-circuiting on the enable flag.
  const filterParams = params as unknown as AllFilterParams;
  for (const filter of Object.values(ENTRY_FILTER_REGISTRY)) {
    const probeLong: FilterPassContext = { ...entryCtx, side: 0, params: filterParams };
    const probeShort: FilterPassContext = { ...entryCtx, side: 1, params: filterParams };
    if (filter.pass(probeLong) || filter.pass(probeShort)) continue;
    // Both sides blocked — the filter is the entry-side culprit.
    const attribution = attributeFilterBlock(filter.key, filterParams, indicators, bars, triggerIdx, tickSize);
    return {
      status: "signal_drift",
      noSignalReason: `filter blocked: ${filter.key}`,
      blockedByFilter: filter.key,
      ...(attribution ?? {}),
    };
  }

  // Daily-PnL money gate. Engine + backtest both consult the same
  // evaluator before letting `shouldEnter` decide; replay must too, or a
  // live entry that the gate blocked gets mis-attributed as a signal that
  // drifted later. Replay is forensic / by-construction flat at this
  // point (same constraint as the engine entry-eval site), so unrealized
  // = 0 even when the include-unrealized flag is on.
  {
    const sessionStart = currentCmeSessionStart(new Date(triggerBar.timestamp));
    const realizedGross = getAccountRealizedSinceGross(trade.accountId, sessionStart);
    const gate = evaluateDailyPnlGate({
      ...getAccountDailyPnlLimits(trade.accountId),
      realizedGross,
      unrealized: 0,
    });
    if (gate.tripped && gate.side) {
      return {
        status: "signal_drift",
        noSignalReason: `daily-pnl gate: ${gate.side}`,
      };
    }
  }

  const signal = strategy.shouldEnter(entryCtx);
  if (!signal) {
    return {
      status: "signal_drift",
      noSignalReason: deriveNoSignalReason(params, indicatorConfigs.length > 0),
    };
  }
  // Structured skip — strategy considered entry but a gate rejected.
  // For replay this is signal drift just like null, but with a more
  // specific reason.
  if ("skip" in signal) {
    return {
      status: "signal_drift",
      noSignalReason: `gate ${signal.gate}: ${signal.skip}`,
    };
  }

  // Bracket math mirrors engine + backtest: both legs are the strategy's and
  // the platform collapses neither. The three paths share
  // `isValidBracketTicks` and nothing else.
  if (!isValidBracketTicks(signal.slTicks)) {
    return { status: "signal_drift", noSignalReason: "strategy emitted invalid SL ticks" };
  }
  if (!isValidBracketTicks(signal.tpTicks)) {
    return { status: "signal_drift", noSignalReason: "strategy emitted invalid TP ticks" };
  }
  const bTp = signal.tpTicks;
  const bSl = signal.slTicks;

  // Walk forward bar-by-bar simulating bracket hits + shouldExit. Same
  // model the backtest engine uses, condensed: TP/SL take priority over
  // shouldExit (resting orders fill before the engine evaluates), session
  // close force-exits, end-of-window closes at last bar.
  const isLong = signal.side === 0;
  const btEntryPrice = triggerBar.close;
  const btTpPrice = btEntryPrice + (isLong ? bTp : -bTp) * tickSize;
  const btSlPrice = btEntryPrice + (isLong ? -bSl : bSl) * tickSize;

  const position: OpenPosition & { tpTicks: number; slTicks: number } = {
    side: signal.side,
    entryPrice: btEntryPrice,
    entryTimestamp: triggerBar.timestamp,
    barsSinceEntry: 0,
    entryFilledAt: triggerBar.timestamp,
    // The count the row was actually placed at. Replay is forensic: nothing
    // downstream of here reads it (P&L uses `trade.size` directly), and
    // re-deriving a count — from a param blob, or from today's risk posture —
    // would report the operator's later Settings edit as strategy drift.
    size: trade.size,
    tpTicks: bTp,
    slTicks: bSl,
  };

  let btExitPrice: number | null = null;
  let btExitIdx = -1;
  let btExitReason: string = "end_of_data";
  for (let i = triggerIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    position.barsSinceEntry++;

    const tpHit = isLong ? bar.high >= btTpPrice : bar.low <= btTpPrice;
    const slHit = isLong ? bar.low <= btSlPrice : bar.high >= btSlPrice;
    if (tpHit && slHit) {
      // Conservative: assume SL fires first when a bar's range straddles
      // both. Matches backtest's default conflict resolution.
      btExitPrice = btSlPrice;
      btExitReason = "stop_loss";
      btExitIdx = i;
      break;
    }
    if (tpHit) {
      btExitPrice = btTpPrice;
      btExitReason = "take_profit";
      btExitIdx = i;
      break;
    }
    if (slHit) {
      btExitPrice = btSlPrice;
      btExitReason = "stop_loss";
      btExitIdx = i;
      break;
    }

    if (!isInAnySessionWindow(new Date(bar.timestamp), sessionWindows)) {
      btExitPrice = bar.close;
      btExitReason = "time_window_close";
      btExitIdx = i;
      break;
    }

    const exitDecision = strategy.shouldExit({
      bars,
      barIndex: i,
      indicators,
      position,
      params,
      tickSize,
      daySession,
      sessionWindows,
      crossTimeframeBars: new Map<string, BarData[]>(),
      hasEnteredThisSession: () => false,
    });
    const exitTriggered =
      exitDecision === true ||
      (typeof exitDecision === "object" && exitDecision.exit === true);
    if (exitTriggered) {
      btExitPrice = bar.close;
      btExitReason = "signal";
      btExitIdx = i;
      break;
    }
  }

  if (btExitPrice == null) {
    // Walked off the end of the replay window without an exit — either
    // the trade is still open in real life or we didn't fetch enough
    // post-exit padding. Use the last bar's close as the bt exit.
    const last = bars[bars.length - 1];
    btExitPrice = last.close;
    btExitIdx = bars.length - 1;
    btExitReason = "end_of_data";
  }

  const btExitBar = bars[btExitIdx];
  const priceDelta = isLong
    ? btExitPrice - btEntryPrice
    : btEntryPrice - btExitPrice;
  const pnlTicks = tickSize > 0 ? priceDelta / tickSize : 0;
  const pnlDollars =
    tickValue != null ? pnlTicks * tickValue * trade.size : null;

  // Classify match vs exec drift. Both sides must have actuals to
  // compare; an open / pending trade can't yield exec drift, but the
  // brief assumes closed trades only on the strip.
  const status = classifyDrift(trade, {
    fill: btEntryPrice,
    exit: btExitPrice,
    tickSize,
  });

  return {
    status,
    trigger: btEntryPrice,
    fill: btEntryPrice,
    tpPrice: btTpPrice,
    slPrice: btSlPrice,
    exit: btExitPrice,
    exitReason: btExitReason,
    pnlDollars: pnlDollars ?? undefined,
    pnlTicks: Math.round(pnlTicks * 10) / 10,
    entryTime: triggerBar.timestamp,
    exitTime: btExitBar.timestamp,
    triggerBarHigh: triggerBar.high,
    triggerBarLow: triggerBar.low,
  };
}

/** Compare the replayed fill + exit against the live trade's actuals.
 *  Both within tick tolerance → match; otherwise exec_drift. Tolerances
 *  are top-of-file constants; entries are tighter than exits because
 *  bracket exits can fill anywhere inside a bar's spread. */
function classifyDrift(
  trade: StrategyTrade,
  bt: { fill: number; exit: number; tickSize: number },
): "match" | "exec_drift" {
  const liveFill = trade.entryPrice;
  const liveExit = trade.exitPrice;
  if (liveFill == null || liveExit == null) {
    // Treat partial data as drift — replay produced both sides; live
    // didn't. The strip will still show both rows.
    return "exec_drift";
  }
  const ts = bt.tickSize > 0 ? bt.tickSize : 1;
  const fillDeltaTicks = Math.abs(liveFill - bt.fill) / ts;
  const exitDeltaTicks = Math.abs(liveExit - bt.exit) / ts;
  if (fillDeltaTicks <= ENTRY_TICK_TOLERANCE && exitDeltaTicks <= EXIT_TICK_TOLERANCE) {
    return "match";
  }
  return "exec_drift";
}

/** Best-effort reason string when shouldEnter returns null on the
 *  trigger bar. The strategy doesn't expose *why* it returned null
 *  (the decision tree is private to the module), so we fall back to
 *  generic categories. UI just renders the string. */
function deriveNoSignalReason(_params: CommonParams, hasIndicators: boolean): string {
  if (!hasIndicators) return "no signal on closed bar";
  return "indicator value differed";
}

/**
 * Per-filter attribution. Returns the indicator value at the trigger bar
 * and the threshold from the snapshot params for the filter that blocked
 * the entry. Drives the v1.1 detective-mode panels in the analytics UI.
 *
 * Knowing each filter's value/threshold semantics is intentionally inline
 * here rather than a method on FilterMetadata — keeps the filter contract
 * unchanged and forward-compatible (older filters with no analytics
 * surface stay zero-boilerplate). New filters that want detective-mode
 * visibility add a case here.
 */
function attributeFilterBlock(
  filterKey: string,
  params: AllFilterParams,
  indicators: Map<string, IndicatorResult>,
  bars: BarData[],
  triggerIdx: number,
  tickSize: number,
): { blockedIndicatorValue?: number; blockedThreshold?: number } | null {
  switch (filterKey) {
    case "adx": {
      const series = indicators.get(ADX_INDICATOR_ID)?.values;
      const value = series?.[triggerIdx];
      if (value == null || isNaN(value)) return null;
      return { blockedIndicatorValue: value, blockedThreshold: params.adxMinimum };
    }
    case "volume": {
      // Realized volume ratio at the trigger bar (current / avg over
      // lookback bars before it). Comparable directly to volumeMultiplier.
      const lookback = params.volumeLookback;
      const start = triggerIdx - lookback;
      if (start < 0) return { blockedThreshold: params.volumeMultiplier };
      const current = bars[triggerIdx]?.volume;
      if (current == null || !isFinite(current)) return { blockedThreshold: params.volumeMultiplier };
      let sum = 0;
      let count = 0;
      for (let j = start; j < triggerIdx; j++) {
        const v = bars[j]?.volume;
        if (v != null && isFinite(v)) {
          sum += v;
          count++;
        }
      }
      if (count === 0 || sum <= 0) return { blockedThreshold: params.volumeMultiplier };
      const ratio = current / (sum / count);
      return { blockedIndicatorValue: ratio, blockedThreshold: params.volumeMultiplier };
    }
    case "slope": {
      const series = indicators.get(SLOPE_INDICATOR_ID)?.values;
      const back = triggerIdx - params.slopeLookback;
      if (!series || back < 0 || tickSize <= 0) {
        return { blockedThreshold: params.slopeMinTicks };
      }
      const now = series[triggerIdx];
      const prev = series[back];
      if (now == null || prev == null || isNaN(now) || isNaN(prev)) {
        return { blockedThreshold: params.slopeMinTicks };
      }
      const realizedTicks = (now - prev) / tickSize;
      return { blockedIndicatorValue: realizedTicks, blockedThreshold: params.slopeMinTicks };
    }
    default:
      return null;
  }
}

/** Convenience wrapper: fetch bars (snapshot or live), then call
 *  replayTrade. Used by the API route; isolated so unit tests can
 *  exercise replayTrade directly with synthetic bars. */
export interface RunReplayArgs {
  trade: StrategyTrade;
  strategy: StrategyModule;
  /** Pre-loaded snapshot bars when available; null forces a live fetch. */
  snapshotBars: BarData[] | null;
  /** Whether the live-fetch fallback may run. False when the market-data
   *  provider is unconfigured, in which case a missing snapshot is a
   *  no_signal rather than a failed fetch. Only consulted when
   *  snapshotBars is null. */
  allowLiveFetch: boolean;
  /** Resolved timeframe string for the live fetch (must match the
   *  strategy's evaluation timeframe). */
  timeframe: Timeframe;
  tickSize: number;
  tickValue: number | null;
}

export async function runReplay(args: RunReplayArgs): Promise<BacktestReplayResult> {
  const { trade, strategy, snapshotBars, allowLiveFetch, timeframe, tickSize, tickValue } = args;

  // Determine the warmup the strategy + filters need so a live fetch
  // gets a wide-enough window. The snapshot is fixed at 300 bars before
  // entry — sufficient for default-period indicators but not always
  // (slowPeriod=200 wants ~450). When the snapshot is too narrow the
  // indicator pipeline returns NaN at the trigger bar and shouldEnter
  // false-negatives — replayTrade will correctly tag that as signal
  // drift, so we don't auto-fall-back to a live fetch.
  let bars: BarData[];
  if (snapshotBars && snapshotBars.length > 0) {
    bars = snapshotBars;
  } else {
    if (!allowLiveFetch) {
      return {
        status: "no_signal",
        noSignalReason: "no bar snapshot and no live market-data provider available",
      };
    }
    const params = {
      ...defaultParamValues(strategy.params),
      ...migrateLegacyParamOverrides(
        trade.strategyKey,
        (trade.paramSnapshot as ParamValues | null) ?? {},
        { deploymentId: trade.deploymentId },
      ),
    } as CommonParams;
    const indicatorConfigs =
      strategy.buildIndicators?.(params) ?? strategy.config.indicators;
    const warmup = computeWarmupBars(indicatorConfigs, params);
    try {
      bars = await fetchReplayBars({
        contractId: trade.contractId,
        timeframe,
        entryTime: trade.entryFilledAt ?? trade.entrySubmittedAt,
        exitTime: trade.exitFilledAt,
        warmupBars: warmup,
      });
    } catch (err) {
      return {
        status: "no_signal",
        noSignalReason: `bar fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return replayTrade({ trade, strategy, bars, tickSize, tickValue });
}

// Re-export the timeframe util for the route's convenience.
export { resolveTimeframe };
