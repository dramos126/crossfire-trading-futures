/**
 * The bound on `skips.jsonl`. It is one function because all three commands
 * append through it — `run` per row, `walk-forward` and `lift` per window —
 * so the cap is stated once rather than three times.
 */
import { describe, it, expect } from "vitest";

import { MAX_SKIP_RECORDS, appendSkips, skipTruncationWarning } from "./skip-record";
import type { CliSkipRecord } from "./skip-record";

function rows(n: number): CliSkipRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    signalBarTs: `2025-06-04T13:${String(i % 60).padStart(2, "0")}:00.000Z`,
    sessionDate: "2025-06-04",
    source: "strategy" as const,
    gate: "vwap",
    reason: "s",
    detail: null,
    foldId: null,
    sample: null,
    regime: null,
  }));
}

describe("appendSkips", () => {
  it("takes everything and drops nothing while there is room", () => {
    const into: CliSkipRecord[] = [];
    expect(appendSkips(into, rows(3))).toBe(0);
    expect(into).toHaveLength(3);
  });

  it("fills to the cap exactly and reports the remainder as dropped", () => {
    const into: CliSkipRecord[] = [];
    expect(appendSkips(into, rows(MAX_SKIP_RECORDS + 7))).toBe(7);
    expect(into).toHaveLength(MAX_SKIP_RECORDS);
  });

  it("drops a whole batch once the cap is reached, across appends", () => {
    const into = rows(MAX_SKIP_RECORDS);
    expect(appendSkips(into, rows(4))).toBe(4);
    expect(into).toHaveLength(MAX_SKIP_RECORDS);
  });

  it("says the counts survive the truncation, because they do", () => {
    // The gate counts are taken before the append at every call site, so the
    // bound costs rows and never a number in the summary.
    expect(skipTruncationWarning(12)).toContain("12");
    expect(skipTruncationWarning(12)).toContain("skipReasonCounts is complete");
  });
});
