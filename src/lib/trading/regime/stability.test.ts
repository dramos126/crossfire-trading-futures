import { describe, it, expect } from "vitest";

import { activeIndicator, agreement, flipRate, lag1Autocorrelation } from "./stability";

describe("lag1Autocorrelation", () => {
  it("approaches −1 on a series that alternates every day", () => {
    // The standard biased estimator divides n−1 cross-products by n squared
    // deviations, so a perfect alternation floors at −(n−1)/n.
    expect(lag1Autocorrelation([1, 0, 1, 0, 1, 0, 1, 0])).toBeCloseTo(-0.875, 10);
    expect(lag1Autocorrelation(Array.from({ length: 200 }, (_, i) => i % 2))).toBeLessThan(-0.99);
  });

  it("is 1 on a series that never changes, which is perfectly persistent", () => {
    expect(lag1Autocorrelation([1, 1, 1, 1])).toBe(1);
  });

  it("is high on long runs — the shape the vol axis has to have", () => {
    const runs = [...Array(10).fill(1), ...Array(10).fill(0), ...Array(10).fill(1)];
    expect(lag1Autocorrelation(runs)).toBeGreaterThan(0.6);
  });

  it("is 0 with fewer than two samples", () => {
    expect(lag1Autocorrelation([1])).toBe(0);
    expect(lag1Autocorrelation([])).toBe(0);
  });
});

describe("flipRate", () => {
  it("counts changes between consecutive days over the pairs, not the days", () => {
    expect(flipRate(["a", "a", "b", "b", "a"])).toBeCloseTo(0.5, 10);
    expect(flipRate(["a", "a", "a"])).toBe(0);
    expect(flipRate(["a"])).toBe(0);
  });
});

describe("agreement", () => {
  it("is the share of days two label series read the same", () => {
    expect(agreement(["a", "b", "a", "a"], ["a", "b", "b", "a"])).toBe(0.75);
  });

  it("refuses two series of different lengths rather than truncating one", () => {
    expect(() => agreement(["a"], ["a", "b"])).toThrow(/differ in length/);
  });
});

describe("activeIndicator", () => {
  it("maps the vol axis to 0/1 and treats an unknown day as not active", () => {
    expect(activeIndicator(["active", "quiet", null])).toEqual([1, 0, 0]);
  });
});
