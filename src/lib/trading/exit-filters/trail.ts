import type { OrderSide, BarData } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { OpenPosition, ParamSchema } from "../strategy-types";
import { priceFromTicks } from "../orders/pnl-math";

/**
 * Trailing-SL exit filter. Bracket-modify (NOT market-exit) trailing.
 *
 * Distinct from `trailing-stop.ts`, which is the legacy CommonParam-driven
 * client-managed market-exit trail the engine still wires up directly.
 * This module is the registry-shaped successor: arms in R-space, ratchets
 * the broker SL bracket on each bar close while the trade is favorable,
 * and never widens.
 *
 * **Arm condition:** MFE (computed from bar highs/lows since entry) ≥
 * `trailArmAtR × slTicks × tickSize`. Once armed, every subsequent bar
 * close computes a candidate new SL:
 *   - `atr` mode: `currentBar.high - ATR × trailDistanceAtr` (long) /
 *     mirror for short. ATR is in price units; the indicator pipeline
 *     supplies it via `TRAIL_ATR_INDICATOR_ID`.
 *   - `ticks` mode: `currentBar.high - trailDistanceTicks × tickSize`
 *     (long) / mirror.
 *
 * **Composition:** SL only ratchets favorably. The filter returns a
 * desired SL price; the engine / backtest collects requests across all
 * firing filters on a bar, keeps the tightest, and rejects the modify
 * if it would loosen the current SL.
 *
 * **Cadence:** bar close, never tick. The ATR series is bar-aligned and
 * intra-bar evaluation would oscillate with every quote.
 *
 * **Null-fallback:** `position.slTicks == null` → fail open per the
 * EXIT_FILTER_REGISTRY contract.
 */

export type TrailMode = "atr" | "ticks";

export interface TrailFilterParams {
  trailFilterEnabled: boolean;
  trailFilterMode: TrailMode;
  trailFilterArmAtR: number;
  trailFilterDistanceAtr: number;
  trailFilterAtrPeriod: number;
  trailFilterDistanceTicks: number;
}

export const TRAIL_FILTER_PARAMS: Record<keyof TrailFilterParams, ParamSchema> = {
  trailFilterEnabled: {
    type: "boolean",
    label: "Trailing stop",
    default: false,
    group: "Exit Filters",
    description: "Once the trade has run far enough, ratchet the broker stop-loss tighter on every bar close. Locks in profit progressively without a market exit.",
  },
  trailFilterMode: {
    type: "select",
    label: "Trail distance mode",
    default: "atr",
    options: [
      { value: "atr", label: "ATR multiple" },
      { value: "ticks", label: "Fixed ticks" },
    ],
    group: "Exit Filters",
    description: "How the trail distance is measured.\n\nATR multiple: the trail breathes with volatility — wider in choppy markets, tighter when things quiet down.\n\nFixed ticks: a constant distance that never changes regardless of market conditions.",
  },
  trailFilterArmAtR: {
    type: "number",
    label: "Arm at R multiple",
    default: 1.0,
    min: 0.1,
    step: 0.1,
    group: "Exit Filters",
    description: "How far the trade has to run in your favor before the trail arms, expressed as a multiple of the entry SL distance.",
  },
  trailFilterDistanceAtr: {
    type: "number",
    label: "Distance (× ATR)",
    default: 1.5,
    min: 0.1,
    step: 0.1,
    group: "Exit Filters",
    description: "How many ATRs behind the recent high (long) or low (short) the stop trails. 1.5 gives the trade room to breathe; tighten toward 1.0 to lock in profit faster.",
    visibleWhen: { key: "trailFilterMode", value: "atr" },
  },
  trailFilterAtrPeriod: {
    type: "integer",
    label: "ATR period",
    default: 14,
    min: 2,
    max: 200,
    group: "Exit Filters",
    description: "Lookback length for the trail's ATR. Standard 14 is fine for most setups.",
    visibleWhen: { key: "trailFilterMode", value: "atr" },
  },
  trailFilterDistanceTicks: {
    type: "integer",
    label: "Distance (ticks)",
    default: 0,
    min: 0,
    group: "Exit Filters",
    description: "How many ticks behind the recent high (long) or low (short) the stop trails. Set to the minimum meaningful distance on your instrument — too tight and noise stops you out.",
    visibleWhen: { key: "trailFilterMode", value: "ticks" },
  },
};

/** Indicator id used by the trail filter for ATR. Distinct from any
 *  ATR a strategy may already register. */
export const TRAIL_ATR_INDICATOR_ID = "__trail_atr" as const;

/** Build the ATR indicator config when the filter is on AND its mode
 *  needs ATR. Returns null otherwise so the indicator pipeline doesn't
 *  carry dead series. */
export function trailIndicatorConfig(params: TrailFilterParams): IndicatorConfig | null {
  if (!params.trailFilterEnabled) return null;
  if (params.trailFilterMode !== "atr") return null;
  return { id: TRAIL_ATR_INDICATOR_ID, type: "ATR", params: { period: params.trailFilterAtrPeriod } };
}

function computeMfePrice(
  bars: BarData[],
  entryBarIndex: number,
  currentBarIndex: number,
  entryPrice: number,
  side: OrderSide,
): number {
  if (entryBarIndex < 0 || currentBarIndex < entryBarIndex) return 0;
  if (side === 0) {
    let hi = -Infinity;
    for (let i = entryBarIndex; i <= currentBarIndex; i++) {
      if (bars[i].high > hi) hi = bars[i].high;
    }
    return Number.isFinite(hi) ? hi - entryPrice : 0;
  }
  let lo = Infinity;
  for (let i = entryBarIndex; i <= currentBarIndex; i++) {
    if (bars[i].low < lo) lo = bars[i].low;
  }
  return Number.isFinite(lo) ? entryPrice - lo : 0;
}

export interface TrailTriggerArgs {
  bars: BarData[];
  barIndex: number;
  position: OpenPosition;
  tickSize: number;
  params: TrailFilterParams;
  atrSeries: number[] | undefined;
}

/**
 * Returns the desired new SL price when the trail wants to ratchet on
 * this bar, or null when it doesn't (filter disabled, MFE hasn't reached
 * the arm threshold, ATR not warmed up, or `slTicks` is null).
 *
 * Like the BE filter, this answers "where would I want the SL?" — the
 * caller does the favorable-direction-only ratchet against the current SL
 * across multiple firing filters.
 */
export function computeTrailSlPrice(args: TrailTriggerArgs): number | null {
  const { bars, barIndex, position, tickSize, params, atrSeries } = args;
  if (!params.trailFilterEnabled) return null;
  if (position.slTicks == null) return null;
  if (params.trailFilterArmAtR <= 0 || tickSize <= 0) return null;

  const entryBarIndex = barIndex - position.barsSinceEntry;
  const mfe = computeMfePrice(bars, entryBarIndex, barIndex, position.entryPrice, position.side);
  const armDistance = params.trailFilterArmAtR * position.slTicks * tickSize;
  if (mfe < armDistance) return null;

  let trailDistance: number;
  if (params.trailFilterMode === "atr") {
    if (!atrSeries) return null;
    const atr = atrSeries[barIndex];
    if (atr == null || !Number.isFinite(atr) || atr <= 0) return null;
    if (params.trailFilterDistanceAtr <= 0) return null;
    trailDistance = atr * params.trailFilterDistanceAtr;
  } else {
    if (params.trailFilterDistanceTicks <= 0) return null;
    trailDistance = params.trailFilterDistanceTicks * tickSize;
  }

  const currentBar = bars[barIndex];
  if (!currentBar) return null;
  const isLong = position.side === 0;
  const target = isLong ? currentBar.high - trailDistance : currentBar.low + trailDistance;
  // The tick index keeps its float division, so 0.25 and 1 ticks are unchanged;
  // the price is built on the grid, because `k * 0.1` lands off it, and the
  // engine stores its snapped send, which a re-offered off-grid price would
  // out-tighten on every bar.
  const gridTick = isLong ? Math.floor(target / tickSize) : Math.ceil(target / tickSize);
  return priceFromTicks(0, gridTick, tickSize);
}

