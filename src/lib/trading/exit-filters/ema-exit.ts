import type { OrderSide, BarData } from "@/lib/brokers/types";
import type { IndicatorConfig, Timeframe } from "@/lib/trading/domain";
import type { ParamSchema } from "../strategy-types";
import { ema } from "../indicators";

/**
 * EMA close-through exit filter.
 *
 * If enabled, the strategy exits an open position when the last closed bar
 * on the configured timeframe closes on the opposite side of the EMA:
 *   - Long  → exit when close < ema
 *   - Short → exit when close > ema
 *
 * Intended as a thesis-invalidation exit: if price closes through the
 * trend EMA from the wrong side, the setup that got us in is no longer
 * valid, so cut the trade before it walks the rest of the way to the
 * bracket SL. Trades the worst part of the SL for an earlier (usually
 * better) fill on trend reversals, at the cost of being whipsawed by
 * brief pullbacks.
 *
 * **Timeframe** can be independent of the strategy's entry timeframe. Set
 * to "same" (default) and the filter reads the strategy's own indicator
 * pipeline. Set to a different timeframe (e.g. strategy on 5m, exit on
 * 15m) and the engine pre-fetches that timeframe's bars and the filter
 * computes the EMA locally — used to avoid whipsaws where a lower
 * timeframe panics but the higher timeframe trend is still intact.
 *
 * **The cross-timeframe path below is live code the platform refuses to
 * configure.** Only the engine populates `crossTimeframeBars`; the backtest
 * and the replay hand every context an empty map, so a non-"same" timeframe
 * fires on every live tick and never once in a measurement. Every create,
 * edit, activation and backtest surface refuses it through
 * `crossTimeframeExitRefusalFor` (filters/index.ts). The code stays because
 * the engine half is correct and the gap is the backtest's; do not delete it,
 * and do not reach it by any other door.
 */

/** Union of the select widget values. "same" = use strategy's timeframe. */
export type EmaExitTimeframe = "same" | Timeframe;

export interface EmaExitFilterParams {
  emaExitEnabled: boolean;
  emaExitPeriod: number;
  emaExitTimeframe: EmaExitTimeframe;
}

export const EMA_EXIT_FILTER_PARAMS: Record<keyof EmaExitFilterParams, ParamSchema> = {
  emaExitEnabled: {
    type: "boolean",
    label: "EMA close-through",
    default: false,
    group: "Exit Filters",
    description: "Bail on the trade when a bar closes through an EMA from the wrong side. Longs exit on a close below the line, shorts exit on a close above. Cuts the trade when the thesis breaks instead of riding it down to the bracket stop.",
  },
  emaExitPeriod: {
    type: "integer",
    label: "Exit EMA period",
    default: 21,
    min: 2,
    max: 500,
    group: "Exit Filters",
    description: "EMA length used for the exit line. 7 or 9 cuts losers (and winners) fast; 21 is the standard mid-trend setting; 50 or 200 lets the trade breathe through pullbacks.",
  },
  emaExitTimeframe: {
    type: "select",
    label: "Exit timeframe",
    default: "same",
    options: [
      { value: "same", label: "Same as strategy" },
      { value: "1m", label: "1 minute" },
      { value: "3m", label: "3 minutes" },
      { value: "5m", label: "5 minutes" },
      { value: "15m", label: "15 minutes" },
      { value: "30m", label: "30 minutes" },
      { value: "1h", label: "1 hour" },
      { value: "4h", label: "4 hours" },
    ],
    group: "Exit Filters",
    description: "Which timeframe the exit EMA is read on. \"Same as strategy\" reads the strategy's own bars and is the only setting that runs today: a higher timeframe — say 15m while the strategy runs on 5m — would keep the filter from bailing on every little 5m wiggle, but only the live engine can fetch those bars, so no backtest ever exercises it. Save one and the deployment is refused with that explanation.",
  },
};

/** Indicator id used when timeframe is "same" — reuses the strategy's
 *  indicator pipeline. For cross-timeframe, the engine supplies pre-fetched
 *  bars and the filter computes EMA locally (no registry indicator). */
export const EMA_EXIT_INDICATOR_ID = "__ema_exit" as const;

/** Only builds an indicator config when the filter is on AND the timeframe
 *  matches the strategy's. Cross-timeframe EMAs are computed on separate
 *  bars the engine pre-fetches, not through the strategy's indicator pipe. */
export function emaExitIndicatorConfig(params: EmaExitFilterParams): IndicatorConfig | null {
  if (!params.emaExitEnabled) return null;
  if (params.emaExitTimeframe !== "same") return null;
  return { id: EMA_EXIT_INDICATOR_ID, type: "EMA", params: { period: params.emaExitPeriod } };
}

/**
 * Returns true if the EMA-exit should trigger — i.e. the most recent close
 * on the configured timeframe is on the opposite side of the EMA.
 *
 * `sameTimeframeEmaSeries` is the strategy's own EMA values when timeframe
 * is "same". `crossTimeframeBars` is the engine-fetched bars on the exit
 * timeframe when timeframe is different — the filter computes EMA on those
 * bars directly.
 */
export function triggeredEmaExit(
  sameTimeframeEmaSeries: number[] | undefined,
  currentBarClose: number,
  side: OrderSide,
  params: EmaExitFilterParams,
  crossTimeframeBars: BarData[] | undefined,
  barIndexForSame: number,
): boolean {
  // Precondition: callers MUST pass closed bars only in `crossTimeframeBars`.
  // This filter reads `crossTimeframeBars[length - 1]` as the most recent
  // closed bar with no partial-bar guard. Firing on an in-progress bar would
  // close the position based on a price that hasn't actually printed yet —
  // unacceptable for a market-exit filter. The engine satisfies this via
  // `fetchBars` in `engine.ts` setting `includePartialBar: false`; any new
  // caller must do the same.
  if (!params.emaExitEnabled) return false;

  if (params.emaExitTimeframe === "same") {
    if (!sameTimeframeEmaSeries) return false;
    const ema = sameTimeframeEmaSeries[barIndexForSame];
    if (ema == null || isNaN(ema)) return false;
    return checkCrossBack(currentBarClose, ema, side);
  }

  // Cross-timeframe path: compute EMA on the engine-fetched bars. Use the
  // LAST fully-closed bar on that timeframe as the evaluation point —
  // higher-timeframe bars close less often than the strategy's ticks, and
  // we only want the filter to fire when the higher timeframe has actually
  // printed a close (otherwise we're reading a partial bar and defeating
  // the whole purpose of choosing a higher timeframe).
  if (!crossTimeframeBars || crossTimeframeBars.length === 0) return false;
  const closes = crossTimeframeBars.map((b) => b.close);
  const emaSeries = ema(closes, params.emaExitPeriod);
  const lastIdx = crossTimeframeBars.length - 1;
  const emaVal = emaSeries[lastIdx];
  if (emaVal == null || isNaN(emaVal)) return false;
  const lastClose = closes[lastIdx];
  return checkCrossBack(lastClose, emaVal, side);
}

function checkCrossBack(close: number, emaVal: number, side: OrderSide): boolean {
  if (side === 0) return close < emaVal;
  return close > emaVal;
}
