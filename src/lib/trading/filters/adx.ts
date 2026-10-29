import type { IndicatorConfig } from "@/lib/trading/domain";
import type { ParamSchema } from "../strategy-types";

export interface AdxFilterParams {
  adxFilterEnabled: boolean;
  adxPeriod: number;
  adxMinimum: number;
}

export const ADX_FILTER_PARAMS: Record<keyof AdxFilterParams, ParamSchema> = {
  adxFilterEnabled: {
    type: "boolean",
    label: "Use ADX filter",
    default: false,
    group: "Entry Filters",
    description: "Skip trades when the market is chopping sideways. ADX is a trend-strength gauge — high ADX means price is going somewhere, low ADX means it's just churning. Use this to keep trend-following entries out of dead chop.",
  },
  adxPeriod: {
    type: "integer",
    label: "ADX Period",
    default: 14,
    min: 2,
    max: 100,
    group: "Entry Filters",
    description: "How many bars ADX looks back to size up the trend. 14 is the standard nobody argues with. Drop it lower if you want ADX to react faster to fresh moves; raise it for a steadier read.",
  },
  adxMinimum: {
    type: "integer",
    label: "Minimum ADX",
    default: 20,
    min: 0,
    max: 100,
    group: "Entry Filters",
    description: "Floor on trend strength before a trade is allowed. Under 20 is chop, 20-30 is a real trend forming, over 30 is a strong push. Start at 20; nudge up to 25 if too many entries are dying in sideways action.",
  },
};

/** Indicator id used by `passesAdxFilter` and returned by `adxIndicatorConfig`. */
export const ADX_INDICATOR_ID = "adx" as const;

/** Strategy `buildIndicators` can spread/append this when the filter is on. */
export function adxIndicatorConfig(params: AdxFilterParams): IndicatorConfig | null {
  if (!params.adxFilterEnabled) return null;
  return { id: ADX_INDICATOR_ID, type: "ADX", params: { period: params.adxPeriod } };
}

/**
 * Bars of warmup the ADX series needs before its values are stable enough
 * to gate entries. ADX uses Wilder smoothing, which produces a value after
 * `period` bars but doesn't truly stabilize until ~2× period — a plain
 * EMA/SMA stabilizes after 1× period and wouldn't get this doubling.
 * Returns 0 when the filter is disabled (its indicator isn't built).
 */
export function adxWarmupBars(params: AdxFilterParams): number {
  return params.adxFilterEnabled ? params.adxPeriod * 2 : 0;
}

export function passesAdxFilter(
  adxSeries: number[] | undefined,
  barIndex: number,
  params: AdxFilterParams,
): boolean {
  if (!params.adxFilterEnabled) return true;
  if (!adxSeries) return false;
  const now = adxSeries[barIndex];
  if (now == null || isNaN(now)) return false;
  return now >= params.adxMinimum;
}
