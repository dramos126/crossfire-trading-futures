import type { BarData } from "@/lib/brokers/types";
import type { ParamSchema } from "../strategy-types";
import { minutesInTradingTz, parseHHMM } from "../session/session";

export interface TimeWindowFilterParams {
  timeWindowEnabled: boolean;
  timeWindowStartEt: string;
  timeWindowEndEt: string;
}

export const TIME_WINDOW_FILTER_PARAMS: Record<keyof TimeWindowFilterParams, ParamSchema> = {
  timeWindowEnabled: {
    type: "boolean",
    label: "Time-of-day window",
    default: false,
    group: "Entry Filters",
    description:
      "Allow entries only inside an ET time-of-day window.\n\nLeave off when the strategy already enforces its own session window — turning this on as well will narrow the window to the overlap, not widen it.",
  },
  timeWindowStartEt: {
    type: "time",
    label: "Window start (ET)",
    default: "09:30",
    group: "Entry Filters",
    description: "Earliest time of day (ET, inclusive) entries are allowed.",
  },
  timeWindowEndEt: {
    type: "time",
    label: "Window end (ET)",
    default: "16:00",
    group: "Entry Filters",
    description: "Latest time of day (ET, exclusive). Entries blocked at or after this minute.",
  },
};

export function timeWindowWarmupBars(_params: TimeWindowFilterParams): number {
  return 0;
}

export function passesTimeWindowFilter(
  bars: BarData[],
  barIndex: number,
  params: TimeWindowFilterParams,
): boolean {
  if (!params.timeWindowEnabled) return true;
  const b = bars[barIndex];
  if (!b?.timestamp) return false;
  const ts = new Date(b.timestamp);
  if (isNaN(ts.getTime())) return false;
  const mins = minutesInTradingTz(ts);
  const start = parseHHMM(params.timeWindowStartEt);
  const end = parseHHMM(params.timeWindowEndEt);
  if (start == null || end == null) return false;
  // Overnight window (e.g. 18:30 → 01:00): wrap around midnight.
  if (end <= start) return mins >= start || mins < end;
  return mins >= start && mins < end;
}
