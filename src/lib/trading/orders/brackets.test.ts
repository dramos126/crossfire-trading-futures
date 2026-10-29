import { describe, it, expect } from "vitest";
import {
  resolveEffectiveTpTicks,
  isValidBracketTicks,
  formatDeploymentChips,
} from "./brackets";

describe("resolveEffectiveTpTicks", () => {
  it("returns sl * rewardR rounded", () => {
    expect(resolveEffectiveTpTicks(100, 2)).toBe(200);
  });

  it("rounds fractional result", () => {
    expect(resolveEffectiveTpTicks(100, 1.5)).toBe(150);
  });

  it("floors to 1 tick minimum", () => {
    expect(resolveEffectiveTpTicks(1, 0.1)).toBe(1);
  });

  it("throws on rewardR <= 0", () => {
    expect(() => resolveEffectiveTpTicks(100, 0)).toThrow();
    expect(() => resolveEffectiveTpTicks(100, -1)).toThrow();
  });

  it("throws on non-finite rewardR", () => {
    expect(() => resolveEffectiveTpTicks(100, NaN)).toThrow();
    expect(() => resolveEffectiveTpTicks(100, Infinity)).toThrow();
  });
});

describe("isValidBracketTicks", () => {
  it("accepts any positive finite distance, integer or not", () => {
    expect(isValidBracketTicks(1)).toBe(true);
    expect(isValidBracketTicks(37.5)).toBe(true);
  });

  it("refuses zero, negatives and non-finite values", () => {
    expect(isValidBracketTicks(0)).toBe(false);
    expect(isValidBracketTicks(-1)).toBe(false);
    expect(isValidBracketTicks(NaN)).toBe(false);
    expect(isValidBracketTicks(Infinity)).toBe(false);
  });
});

describe("formatDeploymentChips", () => {
  it("is empty when nothing is set — there is no unconditional chip left", () => {
    expect(formatDeploymentChips({ cooldown: 0 })).toBe("");
  });

  it("prints the cooldown when it is on", () => {
    expect(formatDeploymentChips({ cooldown: 30 })).toBe("CD: 30s");
  });

  it("states no size, stop rule, reward ratio or daily limit — the deployment owns none of them", () => {
    const chips = formatDeploymentChips({ cooldown: 30 });
    expect(chips).not.toContain("SL");
    expect(chips).not.toContain("Size");
    expect(chips).not.toContain("RR");
    expect(chips).not.toContain("DL");
    expect(chips).not.toContain("DP");
  });
});
