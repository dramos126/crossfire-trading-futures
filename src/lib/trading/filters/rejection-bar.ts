import type { BarData, OrderSide } from "@/lib/brokers/types";
import type { ParamSchema } from "../strategy-types";

export interface RejectionBarFilterParams {
  rejectionBarEnabled: boolean;
  rejectionBodyClosePct: number;
  rejectionMinRangeTicks: number;
}

export const REJECTION_BAR_FILTER_PARAMS: Record<keyof RejectionBarFilterParams, ParamSchema> = {
  rejectionBarEnabled: {
    type: "boolean",
    label: "Rejection bar",
    default: false,
    group: "Entry Filters",
    description:
      "Require the signal bar to close in the half of its range matching the trade direction (close near high for longs, near low for shorts). Confirms exhaustion / rejection at the extreme.",
  },
  rejectionBodyClosePct: {
    type: "number",
    label: "Close depth (fraction of range)",
    default: 0.6,
    min: 0.5,
    max: 0.95,
    step: 0.05,
    group: "Entry Filters",
    description:
      "How deep into the favorable half the close must sit. 0.6 means close is in the top 40% of the bar for longs (or bottom 40% for shorts). Higher = stricter exhaustion shape.",
  },
  rejectionMinRangeTicks: {
    type: "integer",
    label: "Minimum bar range (ticks)",
    default: 4,
    min: 1,
    max: 50,
    group: "Entry Filters",
    description:
      "Bars smaller than this are skipped — the close-position fraction is noise on tiny bars. Set to the smallest meaningful rejection candle on your timeframe.",
  },
};

export function rejectionBarWarmupBars(_params: RejectionBarFilterParams): number {
  return 0;
}

export function passesRejectionBarFilter(
  bars: BarData[],
  barIndex: number,
  side: OrderSide,
  params: RejectionBarFilterParams,
  tickSize: number,
): boolean {
  if (!params.rejectionBarEnabled) return true;
  const b = bars[barIndex];
  if (!b) return false;
  const range = b.high - b.low;
  if (range <= 0) return false;
  if (tickSize <= 0) return false;
  const rangeTicks = range / tickSize;
  if (rangeTicks < params.rejectionMinRangeTicks) return false;
  if (side === 0) return (b.close - b.low) / range >= params.rejectionBodyClosePct;
  return (b.high - b.close) / range >= params.rejectionBodyClosePct;
}
