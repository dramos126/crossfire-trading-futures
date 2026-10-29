/**
 * The opening range lines on a run chart: the high and low of the session's
 * 09:30–09:44 ET bars, drawn from 09:45 to 16:00 ET.
 *
 * Works in display seconds — ET wall clock written as UTC, what
 * `convertUtcToEtDisplay` gives every candle — so the lines sit on the same
 * time points as the bars and add none of their own.
 *
 * Owned by docs/modules/ui/ui-playbooks.md, "The run reader".
 */
import type { UTCTimestamp } from "lightweight-charts";
import type { BarData } from "@/lib/brokers/types";
import { convertUtcToEtDisplay } from "@/components/chart/trade-markers";

const SECONDS_PER_MINUTE = 60;
const RANGE_START_MINUTE_ET = 9 * 60 + 30;
const RANGE_END_MINUTE_ET = 9 * 60 + 45;
const LINES_END_MINUTE_ET = 16 * 60;

export interface OpeningRangeLines {
  high: number;
  low: number;
  from: UTCTimestamp;
  to: UTCTimestamp;
}

/** Display seconds of an ET wall-clock minute on `sessionDate`. */
function displayAt(sessionDate: string, minuteEt: number): number {
  const [y, m, d] = sessionDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000 + minuteEt * SECONDS_PER_MINUTE;
}

/**
 * The range and the stretch of loaded bars to draw it across, or null.
 *
 * The range comes from the loaded bars when they include the 09:30 bar,
 * otherwise from `known` (the trade's own recorded range), otherwise there is
 * none. The lines span the first to the last loaded bar between 09:45 and
 * 16:00 — never a time the chart has no bar for.
 */
export function openingRangeLines(
  bars: readonly Pick<BarData, "timestamp" | "high" | "low">[],
  sessionDate: string,
  known: { high: number | null; low: number | null },
): OpeningRangeLines | null {
  const rangeStart = displayAt(sessionDate, RANGE_START_MINUTE_ET);
  const rangeEnd = displayAt(sessionDate, RANGE_END_MINUTE_ET);
  const linesEnd = displayAt(sessionDate, LINES_END_MINUTE_ET);

  let high = -Infinity;
  let low = Infinity;
  let sawRangeStart = false;
  let from: number | null = null;
  let to: number | null = null;
  for (const bar of bars) {
    const t = convertUtcToEtDisplay(bar.timestamp);
    if (t >= rangeStart && t < rangeEnd) {
      if (t === rangeStart) sawRangeStart = true;
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    } else if (t >= rangeEnd && t <= linesEnd) {
      if (from == null) from = t;
      to = t;
    }
  }

  if (!sawRangeStart) {
    if (known.high == null || known.low == null || !Number.isFinite(known.high) || !Number.isFinite(known.low)) return null;
    high = known.high;
    low = known.low;
  }
  if (from == null || to == null || from === to) return null;
  return { high, low, from: from as UTCTimestamp, to: to as UTCTimestamp };
}
