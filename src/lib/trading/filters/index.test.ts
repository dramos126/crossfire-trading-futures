/**
 * `crossTimeframeExitRefusalFor` — the sentence every surface says about an
 * exit filter configured on a timeframe only the live engine serves.
 *
 * The condition it refuses is a parity defect: `crossTimeframeBars` is
 * populated by the engine and by nothing else, so the filter is inert in every
 * backtest and replay and live on every tick.
 */

import { describe, it, expect } from "vitest";
import { attributeSlRatchet, crossTimeframeExitRefusalFor, isStopAtOrBeyondMarket, type AllFilterParams } from "./index";

function params(over: Record<string, unknown>): AllFilterParams {
  return over as unknown as AllFilterParams;
}

describe("crossTimeframeExitRefusalFor", () => {
  it("returns null when nothing is enabled", () => {
    expect(crossTimeframeExitRefusalFor(params({}))).toBeNull();
  });

  // The whole point of the narrow fix: `same` reads the strategy's own
  // indicator pipeline, which both paths build, so it is not a parity defect
  // and must keep working. The obvious over-broad fix — refuse `ema_exit`
  // whenever it is enabled — fails here.
  it("does not refuse an enabled filter on the strategy's own timeframe", () => {
    expect(
      crossTimeframeExitRefusalFor(
        params({ emaExitEnabled: true, emaExitTimeframe: "same", emaExitPeriod: 21 }),
      ),
    ).toBeNull();
  });

  it("refuses an enabled filter on a higher timeframe, naming the filter and the timeframe", () => {
    const refusal = crossTimeframeExitRefusalFor(
      params({ emaExitEnabled: true, emaExitTimeframe: "15m", emaExitPeriod: 21 }),
    );
    expect(refusal).toContain("EMA Close-Through");
    expect(refusal).toContain("15m");
    // What is wrong, and what to do about it — not "unsupported configuration".
    expect(refusal).toContain("only the live engine fetches those");
    expect(refusal).toContain('Set the exit timeframe to "Same as strategy"');
  });

  // Fail-open, like every other filter predicate: a saved timeframe on a
  // filter nobody turned on changes nothing about what either path evaluates.
  it("does not refuse a disabled filter carrying a higher timeframe", () => {
    expect(
      crossTimeframeExitRefusalFor(
        params({ emaExitEnabled: false, emaExitTimeframe: "15m", emaExitPeriod: 21 }),
      ),
    ).toBeNull();
  });
});

describe("isStopAtOrBeyondMarket", () => {
  it("is true for a long's stop at or above the mark", () => {
    expect(isStopAtOrBeyondMarket(0, 20026.25, 20015)).toBe(true);
    expect(isStopAtOrBeyondMarket(0, 20015, 20015)).toBe(true);
  });

  it("is false for a long's stop below the mark", () => {
    expect(isStopAtOrBeyondMarket(0, 20026.25, 20026.5)).toBe(false);
  });

  it("is true for a short's stop at or below the mark", () => {
    expect(isStopAtOrBeyondMarket(1, 19973.75, 19985)).toBe(true);
    expect(isStopAtOrBeyondMarket(1, 19985, 19985)).toBe(true);
  });

  it("is false for a short's stop above the mark", () => {
    expect(isStopAtOrBeyondMarket(1, 19973.75, 19973.5)).toBe(false);
  });

  it("fails open on an unknown mark", () => {
    expect(isStopAtOrBeyondMarket(0, 20026.25, null)).toBe(false);
    expect(isStopAtOrBeyondMarket(1, 19973.75, Number.NaN)).toBe(false);
  });
});

describe("attributeSlRatchet", () => {
  const sl = (key: string, newSlPrice: number) => ({ key, result: { type: "modifySl" as const, newSlPrice } });

  it("credits only the filter whose candidate became the stop", () => {
    expect(attributeSlRatchet(0, 100, 111, [sl("breakeven", 100), sl("trail", 111)])).toEqual({ breakEven: false, trail: true });
    expect(attributeSlRatchet(1, 100, 89, [sl("breakeven", 100), sl("trail", 89)])).toEqual({ breakEven: false, trail: true });
    expect(attributeSlRatchet(0, 100, 112, [sl("breakeven", 112), sl("trail", 111)])).toEqual({ breakEven: true, trail: false });
  });

  it("credits both on a tie", () => {
    expect(attributeSlRatchet(0, 100, 111, [sl("breakeven", 111), sl("trail", 111)])).toEqual({ breakEven: true, trail: true });
  });

  it("does not credit break-even for a stop still behind entry", () => {
    expect(attributeSlRatchet(0, 100, 95, [sl("breakeven", 95), sl("trail", 91)])).toEqual({ breakEven: false, trail: false });
    expect(attributeSlRatchet(1, 100, 105, [sl("breakeven", 105)])).toEqual({ breakEven: false, trail: false });
  });

  it("credits break-even exactly at entry", () => {
    expect(attributeSlRatchet(0, 100, 100, [sl("breakeven", 100)])).toEqual({ breakEven: true, trail: false });
    expect(attributeSlRatchet(1, 100, 100, [sl("breakeven", 100)])).toEqual({ breakEven: true, trail: false });
  });

  it("ignores exit-type results", () => {
    expect(attributeSlRatchet(0, 100, 111, [{ key: "trail", result: { type: "exit", reason: "x" } }])).toEqual({ breakEven: false, trail: false });
  });
});
