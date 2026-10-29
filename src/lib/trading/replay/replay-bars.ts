import type { BarData, BarUnit } from "@/lib/brokers/types";
import type { IndicatorConfig, Timeframe } from "@/lib/trading/domain";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { MIN_WARMUP_BARS, type ParamValues } from "@/lib/trading/strategy-types";
import { entryFilterWarmupBars, indicatorLookbackBars } from "./warmup-lookback";

/**
 * Replay bar fetcher + indicator-warmup math for the live-vs-backtest
 * replay engine. The job is to produce a bar window wide enough that
 * rebuilding indicators from `buildIndicators(params)` yields the same
 * values the live engine saw at the trigger bar — bar-for-bar,
 * indicator-for-indicator.
 *
 * **Known fidelity gap, by design:** the live engine evaluates on a bar
 * stream that may include a partially-formed bar from the SignalR tick
 * feed; the bar API only returns closed bars. For strategies that fire
 * on partial-bar updates (currently none — all entries evaluate at bar
 * close in `processDeployment`), replay would diverge. Today's strategies
 * are bar-close evaluators, so the gap is theoretical. If a tick-driven
 * entry strategy ships, replay needs a separate path.
 *
 * Pricing-side fidelity: the replay fetch uses `live: false` to match
 * the chart route. The engine itself fetches with `live: false` for
 * bar-close evaluation. Same source, same data.
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

/** Bars fetched past the trade exit, so a replay whose simulated trade runs
 *  longer than the live one can still reach its TP or SL. Must equal the
 *  at-exit snapshot's `BARS_AFTER_EXIT` in `engine-bar-fetch.ts`: a trade
 *  replayed from the snapshot and one replayed from this fetch would
 *  otherwise walk different tails and disagree. `replay-bars.test.ts` reads
 *  the engine's value from source and pins the two equal. */
export const POST_EXIT_BARS = 300;

/** Covers a small derived-series tail past 2× the lookback (e.g. ADX's smoothed DX). */
const WARMUP_PAD_BARS = 50;

/**
 * Compute the number of bars of warmup the strategy + filter pipeline
 * needs before the trigger bar so every indicator has a non-NaN value.
 *
 * Takes the longest lookback the backtest also reads — every indicator
 * config's, and every enabled entry filter's for `params` — doubles it so
 * EMA-seeded indicators read clean, and pads. Floored at MIN_WARMUP_BARS so
 * single-indicator strategies still get a draw-able chart window.
 *
 * `params` is the merged param blob; `null` means no filter params are known
 * (the live fetch-depth math, whose callers hand it only the configs).
 */
export function computeWarmupBars(indicatorConfigs: IndicatorConfig[], params: ParamValues | null): number {
  let maxPeriod = params ? entryFilterWarmupBars(params) : 0;
  for (const cfg of indicatorConfigs) {
    const period = indicatorLookbackBars(cfg);
    if (period > maxPeriod) maxPeriod = period;
  }
  return Math.max(MIN_WARMUP_BARS, maxPeriod * 2 + WARMUP_PAD_BARS);
}

export interface FetchReplayBarsArgs {
  contractId: string;
  timeframe: Timeframe;
  /** ISO of the trade's trigger/entry bar — the replay needs `warmupBars`
   *  closed bars *before* this and `POST_EXIT_BARS` after `exitTime` (or
   *  after `entryTime` for still-open trades). */
  entryTime: string;
  /** ISO of the exit fill, or null when the trade is still open. Open-
   *  trade replays only walk forward to the most recent bar. */
  exitTime: string | null;
  /** Number of bars before `entryTime` the indicator pipeline needs to
   *  warm up. Use `computeWarmupBars(buildIndicators(params), params)`. */
  warmupBars: number;
}

/**
 * Fetch a closed-bar window suitable for replay. Returns bars sorted
 * ascending by timestamp, deduped by timestamp (Topstep occasionally
 * returns the prior closed bar twice on near-edge requests).
 *
 * The window is `warmupBars × timeframe` before `entryTime` and
 * `POST_EXIT_BARS × timeframe` after `exitTime`. Single REST call —
 * the warmup window for typical strategies (≤ 300 bars) sits well
 * below the per-call cap.
 */
export async function fetchReplayBars(args: FetchReplayBarsArgs): Promise<BarData[]> {
  const { contractId, timeframe, entryTime, exitTime, warmupBars } = args;
  const cfg = TIMEFRAME_TO_BAR[timeframe];
  if (!cfg) throw new Error(`Unknown timeframe: ${timeframe}`);

  const entryMs = new Date(entryTime).getTime();
  const exitMs = exitTime ? new Date(exitTime).getTime() : Date.now();

  const padBeforeMs = warmupBars * cfg.minutes * 60 * 1000;
  const padAfterMs = POST_EXIT_BARS * cfg.minutes * 60 * 1000;
  const startTime = new Date(entryMs - padBeforeMs).toISOString();
  const endTime = new Date(exitMs + padAfterMs).toISOString();

  // Limit cap mirrors the chart route's 1000 — the warmup ceiling for
  // realistic strategies (lookback ≤ 200 → warmup ≤ 450) plus the
  // bars between entry and exit fits comfortably.
  const bars = await marketDataRegistry.historical().retrieveBars({
    contractId,
    live: false,
    startTime,
    endTime,
    unit: cfg.unit,
    unitNumber: cfg.unitNumber,
    limit: 1000,
    includePartialBar: false,
  });

  // Dedupe — Topstep occasionally returns the same bar twice across
  // chunked windows. Keep the first occurrence; subsequent duplicates
  // would inflate volume sums in the volume filter.
  const seen = new Set<string>();
  const deduped: BarData[] = [];
  for (const bar of bars) {
    if (seen.has(bar.timestamp)) continue;
    seen.add(bar.timestamp);
    deduped.push(bar);
  }
  return deduped;
}

/**
 * Locate the bar that contains the trigger timestamp. Returns the
 * largest bar index whose `timestamp <= entryTime` — the bar the live
 * engine evaluated as the just-closed bar at signal time. Returns -1
 * when no bar is at or before `entryTime` (replay window started too
 * late — caller falls back to no_signal).
 */
export function findTriggerBarIndex(bars: BarData[], entryTime: string): number {
  if (bars.length === 0) return -1;
  const target = new Date(entryTime).getTime();
  let lo = 0;
  let hi = bars.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = new Date(bars[mid].timestamp).getTime();
    if (t <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
