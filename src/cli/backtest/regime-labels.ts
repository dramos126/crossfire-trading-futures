/**
 * The run's label series: one `RegimeResult` per session day, and the
 * lookups the gate and the trade records read it through.
 *
 * The classifier is called once per session and cached, because `lift`'s
 * permutation test asks for the same series a thousand times over and the
 * gate asks for it once per bar.
 */
import {
  classifyRegime,
  classifyWithParams,
  UNKNOWN_LABEL,
  type ClassifierParams,
  type RegimeResult,
} from "@/lib/trading/regime/classify-regime";
import type { SessionDay } from "@/lib/trading/regime/session-days";
import { sessionDateOf } from "@/lib/trading/regime/session-dates";
import type { BarData } from "@/lib/brokers/types";

export type LabelIndex = Map<string, RegimeResult>;

/**
 * `days[i]`'s label is the one computed for session `i` — from sessions
 * `≤ i−1` — so the map answers "what was tonight's label for tomorrow" for
 * every day in the series.
 */
export function buildLabelIndex(days: SessionDay[], params?: ClassifierParams): LabelIndex {
  const index: LabelIndex = new Map();
  for (let i = 0; i < days.length; i++) {
    index.set(
      days[i].sessionDate,
      params ? classifyWithParams(days, i, params) : classifyRegime(days, i),
    );
  }
  return index;
}

export function labelOfSession(index: LabelIndex, sessionDate: string): string {
  return index.get(sessionDate)?.label ?? UNKNOWN_LABEL;
}

export function labelForBar(index: LabelIndex, bar: BarData): string {
  return labelOfSession(index, sessionDateOf(new Date(bar.timestamp)));
}

/** Sessions per cell over a set of session dates — `run.json`'s
 *  `labelDistribution` and `cells.json`'s copy of it. */
export function labelDistribution(
  index: LabelIndex,
  sessionDates: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sessionDate of sessionDates) {
    const label = labelOfSession(index, sessionDate);
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}
