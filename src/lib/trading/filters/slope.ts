import type { OrderSide } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { ParamSchema } from "../strategy-types";

export interface SlopeFilterParams {
  slopeFilterEnabled: boolean;
  slopeEmaPeriod: number;
  slopeLookback: number;
  slopeMinTicks: number;
}

export const SLOPE_FILTER_PARAMS: Record<keyof SlopeFilterParams, ParamSchema> = {
  slopeFilterEnabled: {
    type: "boolean",
    label: "Trend slope",
    default: false,
    group: "Entry Filters",
    description:
      "Block trades when the trend line is flat or sloping the wrong way. Catches the case where indicators line up for a long but the underlying trend isn't actually going anywhere.",
  },
  slopeEmaPeriod: {
    type: "integer",
    label: "Trend EMA period",
    default: 50,
    min: 2,
    max: 500,
    group: "Entry Filters",
    description:
      "EMA length used as the trend line. 50 is a solid mid-trend read. Drop to 20 for a faster, twitchier line; push to 100 or 200 for a slower, longer-term trend.",
  },
  slopeLookback: {
    type: "integer",
    label: "Slope lookback (bars)",
    default: 5,
    min: 2,
    max: 50,
    group: "Entry Filters",
    description:
      "How many bars back the filter looks to measure how far the trend EMA has moved. Longer smooths out wiggles; shorter picks up fresh changes. 5 bars works well on a 5m chart.",
  },
  slopeMinTicks: {
    type: "integer",
    label: "Min slope (ticks over lookback)",
    default: 2,
    min: 0,
    max: 100,
    group: "Entry Filters",
    description:
      "How many ticks the trend EMA has to move in the trade direction across the lookback. Bigger number means a steeper trend is required; 0 means any nudge in the right direction passes.",
  },
};

export const SLOPE_INDICATOR_ID = "__slope_ema" as const;

export function slopeIndicatorConfig(params: SlopeFilterParams): IndicatorConfig | null {
  if (!params.slopeFilterEnabled) return null;
  return { id: SLOPE_INDICATOR_ID, type: "EMA", params: { period: params.slopeEmaPeriod } };
}

/**
 * Bars of warmup needed before the slope read is meaningful. Two windows
 * matter: the EMA itself stabilizes after `slopeEmaPeriod` bars, and the
 * slope measurement compares the EMA `slopeLookback` bars apart. Take the
 * larger so both are ready. Returns 0 when disabled.
 */
export function slopeWarmupBars(params: SlopeFilterParams): number {
  if (!params.slopeFilterEnabled) return 0;
  return Math.max(params.slopeEmaPeriod, params.slopeLookback);
}

/**
 * Passes when the filter's own trend EMA has moved at least `slopeMinTicks`
 * in the direction of `side` across the last `slopeLookback` bars.
 */
export function passesSlopeFilter(
  series: number[] | undefined,
  barIndex: number,
  side: OrderSide,
  params: SlopeFilterParams,
  tickSize: number,
): boolean {
  if (!params.slopeFilterEnabled) return true;
  if (!series || tickSize <= 0) return false;

  const back = barIndex - params.slopeLookback;
  if (back < 0) return false;

  const now = series[barIndex];
  const prev = series[back];
  if (now == null || prev == null || isNaN(now) || isNaN(prev)) return false;

  const delta = now - prev;
  const minMove = params.slopeMinTicks * tickSize;
  return side === 0 ? delta >= minMove : delta <= -minMove;
}
