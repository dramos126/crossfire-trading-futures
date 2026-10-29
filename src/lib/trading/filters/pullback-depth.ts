import type { BarData, OrderSide } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { ParamSchema } from "../strategy-types";

export interface PullbackDepthFilterParams {
  pullbackDepthEnabled: boolean;
  pullbackEmaPeriod: number;
  pullbackLookbackBars: number;
  pullbackMaxTicksFromEma: number;
}

export const PULLBACK_DEPTH_FILTER_PARAMS: Record<keyof PullbackDepthFilterParams, ParamSchema> = {
  pullbackDepthEnabled: {
    type: "boolean",
    label: "Pullback Depth",
    default: false,
    group: "Entry Filters",
    description:
      "Block trades when price hasn't actually pulled back to the trend EMA before the trigger.\n\nStops the strategy from entering mid-impulse at the bottom of a pullback that already exhausted itself, instead of at the rejection off the EMA where the stop has structural protection.\n\nCompose with a regime filter (Trend Slope or ADX) — this filter checks where you are in the swing, not which way the market is going.",
  },
  pullbackEmaPeriod: {
    type: "integer",
    label: "Pullback EMA period",
    default: 9,
    min: 2,
    max: 500,
    group: "Entry Filters",
    description:
      "EMA used as the pullback reference line. 9 matches the typical chart EMA on a 5m intraday read; raise for slower swings, lower for tighter scalps.",
  },
  pullbackLookbackBars: {
    type: "integer",
    label: "Pullback lookback (bars)",
    default: 5,
    min: 2,
    max: 50,
    group: "Entry Filters",
    description:
      "How many bars back (including the trigger bar) to scan for an EMA tag. 5 on a 5m chart is roughly 25 minutes of pullback window.",
  },
  pullbackMaxTicksFromEma: {
    type: "integer",
    label: "Max ticks from EMA",
    default: 0,
    min: 0,
    max: 50,
    group: "Entry Filters",
    description:
      "How close the swing extreme had to come to the EMA. 0 means a strict touch or cross is required. Above 0, a pullback that came within N ticks counts as having reached the EMA — useful when wicks routinely fall just shy of the line.",
  },
};

export const PULLBACK_EMA_INDICATOR_ID = "__pullback_ema" as const;

export function pullbackDepthIndicatorConfig(
  params: PullbackDepthFilterParams,
): IndicatorConfig | null {
  if (!params.pullbackDepthEnabled) return null;
  return { id: PULLBACK_EMA_INDICATOR_ID, type: "EMA", params: { period: params.pullbackEmaPeriod } };
}

/**
 * Bars of warmup needed before the pullback read is meaningful. The EMA
 * stabilizes after `pullbackEmaPeriod` bars and the scan walks
 * `pullbackLookbackBars` back from the trigger; take the larger so both
 * are ready. Returns 0 when disabled.
 */
export function pullbackDepthWarmupBars(params: PullbackDepthFilterParams): number {
  if (!params.pullbackDepthEnabled) return 0;
  return Math.max(params.pullbackEmaPeriod, params.pullbackLookbackBars);
}

/**
 * Passes when at least one bar in the lookback window (including the
 * trigger bar) reached the pullback EMA — long: bar low ≤ ema + threshold;
 * short: bar high ≥ ema − threshold. Threshold is `pullbackMaxTicksFromEma`
 * converted to price via `tickSize`.
 */
export function passesPullbackDepthFilter(
  emaSeries: number[] | undefined,
  bars: BarData[],
  barIndex: number,
  side: OrderSide,
  params: PullbackDepthFilterParams,
  tickSize: number,
): boolean {
  if (!params.pullbackDepthEnabled) return true;
  if (!emaSeries || tickSize <= 0) return false;

  const lookback = params.pullbackLookbackBars;
  const threshold = params.pullbackMaxTicksFromEma * tickSize;

  const start = barIndex - lookback + 1;
  if (start < 0) return false;

  for (let i = start; i <= barIndex; i++) {
    const ema = emaSeries[i];
    const bar = bars[i];
    if (ema == null || isNaN(ema) || bar == null) return false;

    if (side === 0) {
      if (bar.low <= ema + threshold) return true;
    } else {
      if (bar.high >= ema - threshold) return true;
    }
  }

  return false;
}
