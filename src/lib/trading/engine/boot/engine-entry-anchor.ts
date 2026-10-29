/**
 * `barsSinceEntry` derived from the bars each pass fetched, rather than added
 * to once per evaluation (A95).
 *
 * The live engine and the backtest both set the count to 0 on the bar whose
 * close produced the signal, and every reader finds that bar as
 * `barIndex - barsSinceEntry`. The backtest adds one per bar index. An
 * evaluation-driven `++` matches that only when every bar is evaluated
 * exactly once, and a restart, a feed outage that aborts a pass, or one late
 * pass covering two closed bars all break it. Counting the bars between the
 * last bar the count is known on and the newest bar held does not.
 */
import type { BarData } from "@/lib/brokers/types";

/** A bar the count is known on: its open time and `barsSinceEntry` on it. */
export interface BarCountAnchor {
  barMs: number;
  count: number;
}

export type BarCountStep =
  /** The anchor bar is held; the count is exact. */
  | { kind: "counted"; anchor: BarCountAnchor }
  /** The anchor bar is older than the oldest bar held. The oldest bar stands
   *  in for the entry bar, so the count is short of the true one, but it
   *  never goes back. */
  | { kind: "older"; anchor: BarCountAnchor }
  /** The read has not reached the anchor bar yet (a lagging read): nothing to
   *  count, and the anchor is kept for the next pass. */
  | { kind: "ahead" };

/** The entry's own anchor: count 0 on the signal bar. Null when the row has no
 *  signal bar, or one that does not parse — no bar is guessed. */
export function signalBarAnchor(signalBarTs: string | null): BarCountAnchor | null {
  if (signalBarTs == null) return null;
  const barMs = Date.parse(signalBarTs);
  return Number.isFinite(barMs) ? { barMs, count: 0 } : null;
}

/**
 * The count on the newest bar in `bars` (bar timestamps are opens), returned
 * as the anchor for the next pass, so the count carries on past the point
 * where the entry bar scrolls out of the read.
 */
export function stepBarCount(bars: readonly BarData[], anchor: BarCountAnchor): BarCountStep {
  const newest = bars.at(-1);
  if (newest === undefined) return { kind: "ahead" };
  const newestMs = Date.parse(newest.timestamp);
  if (newestMs < anchor.barMs) return { kind: "ahead" };
  const barIndex = bars.length - 1;
  for (let i = barIndex; i >= 0; i--) {
    if (Date.parse(bars[i].timestamp) <= anchor.barMs) {
      return { kind: "counted", anchor: { barMs: newestMs, count: anchor.count + barIndex - i } };
    }
  }
  // Not `anchor.count + barIndex`, which is nearer the truth: a strategy that
  // reads `bars[barIndex - barsSinceEntry]` gets a bar that exists only while
  // the count is at most `barIndex`, and structure-break's exit throws on one
  // that does not.
  return { kind: "older", anchor: { barMs: newestMs, count: Math.max(barIndex, anchor.count + 1) } };
}
