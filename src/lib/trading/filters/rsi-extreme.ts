import type { OrderSide } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { ParamSchema } from "../strategy-types";

export interface RsiExtremeFilterParams {
  rsiExtremeEnabled: boolean;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
}

export const RSI_EXTREME_FILTER_PARAMS: Record<keyof RsiExtremeFilterParams, ParamSchema> = {
  rsiExtremeEnabled: {
    type: "boolean",
    label: "RSI extreme",
    default: false,
    group: "Entry Filters",
    description:
      "Block entries unless RSI shows directional exhaustion. Longs require RSI ≤ oversold; shorts require RSI ≥ overbought. Designed for mean-reversion strategies fading extremes.",
  },
  rsiPeriod: {
    type: "integer",
    label: "RSI period",
    default: 14,
    min: 2,
    max: 100,
    group: "Entry Filters",
    description: "Lookback for the RSI calculation. 14 is the standard.",
  },
  rsiOversold: {
    type: "number",
    label: "RSI oversold (long threshold)",
    default: 30,
    min: 5,
    max: 50,
    step: 1,
    group: "Entry Filters",
    description:
      "Long candidates require RSI at or below this. Lower = stricter (rarer but more extreme dips).",
  },
  rsiOverbought: {
    type: "number",
    label: "RSI overbought (short threshold)",
    default: 70,
    min: 50,
    max: 95,
    step: 1,
    group: "Entry Filters",
    description:
      "Short candidates require RSI at or above this. Higher = stricter (rarer but more extreme extensions).",
  },
};

export const RSI_EXTREME_INDICATOR_ID = "rsiExtreme" as const;

export function rsiExtremeIndicatorConfig(
  params: RsiExtremeFilterParams,
): IndicatorConfig | null {
  if (!params.rsiExtremeEnabled) return null;
  return { id: RSI_EXTREME_INDICATOR_ID, type: "RSI", params: { period: params.rsiPeriod } };
}

export function rsiExtremeWarmupBars(params: RsiExtremeFilterParams): number {
  return params.rsiExtremeEnabled ? params.rsiPeriod + 1 : 0;
}

export function passesRsiExtremeFilter(
  rsiSeries: number[] | undefined,
  barIndex: number,
  side: OrderSide,
  params: RsiExtremeFilterParams,
): boolean {
  if (!params.rsiExtremeEnabled) return true;
  if (!rsiSeries) return false;
  const rsi = rsiSeries[barIndex];
  if (rsi == null || !isFinite(rsi)) return false;
  if (side === 0) return rsi <= params.rsiOversold;
  return rsi >= params.rsiOverbought;
}
