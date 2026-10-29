import { describe, it, expect } from "vitest";

import {
  CLASSIFIER_PARAMS_V1,
  CLASSIFIER_VERSION,
  classifyRegime,
  classifyWithParams,
  isRegimeCell,
} from "./classify-regime";
import type { SessionDay } from "./session-days";

/**
 * Day rows straight from their two features, so the percentile and the
 * median are computable by inspection. Prices are filler — the classifier
 * reads `rthTR` and `rthRange` and nothing else.
 */
function daysFrom(trs: Array<number | null>, ranges: number[]): SessionDay[] {
  return trs.map((rthTR, i) => ({
    sessionDate: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    daySessionHigh: 100,
    daySessionLow: 90,
    daySessionClose: 95,
    rthTR,
    rthRange: ranges[i],
  }));
}

/**
 * 255 sessions built so the baseline `[d−249, d]` at `d = 254` is exactly:
 * 120 values of 100, the four transition means 140/180/220/260, 125 values
 * of 300, and `vol5[d]` itself. `rthTR[0]` is null, as it is on a real first
 * row, which is what puts the 250th sample out of reach one day earlier.
 *
 * With `rthTR[254] = 100`, `vol5[d]` is 260 and exactly 125 of the 250
 * samples are at or below it — a percentile of exactly 50, the `active`
 * cutoff's tie.
 */
function tieSeries(lastTr: number, lastRange: number): SessionDay[] {
  const trs: Array<number | null> = [null];
  for (let i = 1; i < 125; i++) trs.push(100);
  for (let i = 125; i < 254; i++) trs.push(300);
  trs.push(lastTr);

  const ranges = trs.map(() => 200);
  ranges[254] = lastRange;
  return daysFrom(trs, ranges);
}

const TARGET = 255;

describe("classifyRegime", () => {
  it("labels session d+1 as active.expanded on a tie at both cutoffs", () => {
    const result = classifyRegime(tieSeries(100, 200), TARGET);
    expect(result.label).toBe("active.expanded");
    expect(result.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(result.features).toEqual({
      vol5: 260,
      vol5Pct: 50,
      rthRange: 200,
      rangeRatio: 1,
    });
  });

  it("drops to quiet one sample below the cutoff", () => {
    // vol5 = 259.8, which puts the 260 transition mean above it: 124 of 250.
    const result = classifyRegime(tieSeries(99, 200), TARGET);
    expect(result.vol).toBe("quiet");
    expect(result.features?.vol5Pct).toBe(49.6);
  });

  it("calls a range under the prior median compressed", () => {
    const result = classifyRegime(tieSeries(100, 199), TARGET);
    expect(result.label).toBe("active.compressed");
    expect(result.features?.rangeRatio).toBeCloseTo(0.995, 10);
  });

  it("is unknown one day before the baseline is full, and labelled on it", () => {
    const days = tieSeries(100, 200);
    // d = 253 needs a vol5 at index 4, whose window reaches the null first row.
    expect(classifyRegime(days, TARGET - 1).label).toBe("unknown");
    expect(classifyRegime(days, TARGET).label).not.toBe("unknown");
  });

  it("fails closed on an unknown, carrying no partial features", () => {
    const result = classifyRegime(tieSeries(100, 200), 10);
    expect(result).toEqual({
      label: "unknown",
      vol: null,
      range: null,
      classifierVersion: CLASSIFIER_VERSION,
      features: null,
    });
  });

  it("reads no bar from the session it labels", () => {
    const days = tieSeries(100, 200);
    const before = classifyRegime(days, TARGET);

    const withTarget = [
      ...days,
      { ...days[254], rthTR: 99_999, rthRange: 99_999 },
    ];
    expect(classifyRegime(withTarget, TARGET)).toEqual(before);
  });

  it("is unknown past the end of the series rather than reading undefined", () => {
    const days = tieSeries(100, 200);
    expect(classifyRegime(days, days.length + 5).label).toBe("unknown");
    expect(classifyRegime(days, 0).label).toBe("unknown");
  });
});

describe("classifyWithParams", () => {
  const shortParams = { vol5Len: 1, baselineLen: 1, rangeMedianLen: 20, volTiers: [50] };

  it("needs a full range window: 19 prior ranges is unknown, 20 is a label", () => {
    const ranges = Array.from({ length: 40 }, (_, i) => 100 + i);
    const trs: Array<number | null> = ranges.map(() => 50);
    trs[0] = null;
    const days = daysFrom(trs, ranges);

    expect(classifyWithParams(days, 20, shortParams).label).toBe("unknown");
    expect(classifyWithParams(days, 21, shortParams).label).not.toBe("unknown");
  });

  it("names a middle tier when given two cuts, which v1 never asks for", () => {
    const days = tieSeries(100, 200);
    const threeTier = { ...CLASSIFIER_PARAMS_V1, volTiers: [33, 67] };
    // The tie series sits at the 50th percentile: above 33, below 67.
    expect(classifyWithParams(days, TARGET, threeTier).vol).toBe("normal");
    expect(classifyRegime(days, TARGET).vol).toBe("active");
  });

  it("refuses a cut count it has no naming for", () => {
    expect(() =>
      classifyWithParams(tieSeries(100, 200), TARGET, {
        ...CLASSIFIER_PARAMS_V1,
        volTiers: [25, 50, 75],
      }),
    ).toThrow(/tier naming/);
  });

  it("moves the label when a lookback is perturbed, which is what --perturb measures", () => {
    const days = tieSeries(100, 200);
    const shorterBaseline = { ...CLASSIFIER_PARAMS_V1, baselineLen: 200 };
    // The 100-block falls out of a 200-day baseline, so the same day is no
    // longer at the median of it.
    expect(classifyWithParams(days, TARGET, shorterBaseline).vol).toBe("quiet");
  });
});

describe("isRegimeCell", () => {
  it("accepts the four cells and refuses anything else", () => {
    expect(isRegimeCell("active.expanded")).toBe(true);
    expect(isRegimeCell("quiet.compressed")).toBe(true);
    expect(isRegimeCell("normal.expanded")).toBe(false);
    expect(isRegimeCell("unknown")).toBe(false);
  });
});
