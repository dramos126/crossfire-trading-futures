/**
 * SESSION_VWAP is a day-session quantity. Everything here is about where the
 * accumulation starts and where it carries nothing at all — the values in
 * between are an ordinary volume-weighted mean and are pinned by construction
 * (each bar's typical price is an integer, so an expected VWAP is exact).
 */
import { describe, it, expect } from "vitest";

import { calculateAll, confirmedSwings } from "./indicators";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";

const MNQ = CONTRACT_SPECS.MNQ.daySession;
const CONFIG = [{ id: "vwap", type: "SESSION_VWAP" as const, params: {} }];

/** ET is UTC-5 in January. `price` becomes the bar's typical price exactly. */
function bar(day: number, utcHour: number, utcMinute: number, price: number, volume: number): BarData {
  return {
    timestamp: new Date(Date.UTC(2025, 0, day, utcHour, utcMinute, 0)).toISOString(),
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
}

function sessionVwapOf(bars: BarData[]): number[] {
  return calculateAll(CONFIG, bars, MNQ).get("vwap")!.values;
}

describe("SESSION_VWAP", () => {
  it("starts accumulating at the day-session open, not at ET midnight", () => {
    const values = sessionVwapOf([
      bar(2, 8, 0, 100, 10_000), // 03:00 ET — overnight, heavy
      bar(2, 14, 30, 200, 100), // 09:30 ET — the cash open
      bar(2, 15, 0, 300, 100), // 10:00 ET
    ]);

    expect(values[0]).toBeNaN();
    expect(values[1]).toBe(200);
    expect(values[2]).toBe(250);
  });

  it("carries NaN after the cash close rather than the session's last value", () => {
    const values = sessionVwapOf([
      bar(2, 14, 30, 200, 100), // 09:30 ET
      bar(2, 21, 0, 400, 100), // 16:00 ET — the close is the right-open edge
      bar(2, 22, 0, 500, 100), // 17:00 ET
    ]);

    expect(values[0]).toBe(200);
    expect(values[1]).toBeNaN();
    expect(values[2]).toBeNaN();
  });

  it("resets at the next session's open", () => {
    const values = sessionVwapOf([
      bar(2, 14, 30, 200, 100), // 09:30 ET
      bar(2, 15, 0, 300, 100), // 10:00 ET
      bar(3, 14, 30, 900, 100), // next day 09:30 ET
    ]);

    expect(values[2]).toBe(900);
  });

  it("reads MGC's own window rather than the index-futures one", () => {
    const values = calculateAll(CONFIG, [
      bar(2, 13, 20, 2400, 100), // 08:20 ET — MGC's open, before MNQ's
      bar(2, 19, 0, 2600, 100), // 14:00 ET — past MGC's 13:30 close
    ], CONTRACT_SPECS.MGC.daySession).get("vwap")!.values;

    expect(values[0]).toBe(2400);
    expect(values[1]).toBeNaN();
  });

  it("throws rather than anchoring on the calendar day when no window resolves", () => {
    expect(() => calculateAll(CONFIG, [bar(2, 14, 30, 200, 100)], null)).toThrow(
      /day-session window/,
    );
  });
});

describe("SESSION_VWAP_BANDS", () => {
  const BANDS = [{ id: "bands", type: "SESSION_VWAP_BANDS" as const, params: {} }];
  const bandsOf = (bars: BarData[]) => calculateAll(BANDS, bars, MNQ).get("bands")!;

  it("carries SESSION_VWAP's own series as its values", () => {
    const bars = [
      bar(2, 8, 0, 100, 10_000), // 03:00 ET — overnight
      bar(2, 14, 30, 200, 100), // 09:30 ET
      bar(2, 15, 0, 300, 300), // 10:00 ET
      bar(3, 14, 30, 900, 100), // next session
    ];
    expect(bandsOf(bars).values).toEqual(sessionVwapOf(bars));
  });

  it("is the volume-weighted deviation of typical price about the VWAP so far", () => {
    // Typicals 200 ×100 and 300 ×300: VWAP 275; Σv(tp − 275)² / Σv = (100·75² + 300·25²) / 400 = 1875.
    const sigma = bandsOf([bar(2, 14, 30, 200, 100), bar(2, 15, 0, 300, 300)]).extra!.sigma;

    expect(sigma[0]).toBe(0);
    expect(sigma[1]).toBeCloseTo(Math.sqrt(1875), 9);
  });

  it("resets at the next open and carries NaN outside the session", () => {
    const sigma = bandsOf([
      bar(2, 14, 30, 200, 100),
      bar(2, 15, 0, 300, 100),
      bar(2, 22, 0, 500, 100), // 17:00 ET
      bar(3, 14, 30, 900, 100),
    ]).extra!.sigma;

    expect(sigma[1]).toBe(50);
    expect(sigma[2]).toBeNaN();
    expect(sigma[3]).toBe(0);
  });

  it("is a day-session indicator, refused without a window", () => {
    expect(() => calculateAll(BANDS, [bar(2, 14, 30, 200, 100)], null)).toThrow(/day-session window/);
  });
});

describe("confirmedSwings", () => {
  it("finds strict swing highs and lows `span` either side, and never the unconfirmed tail", () => {
    const highs = [1, 3, 2, 5, 4, 6, 7];
    expect(confirmedSwings(highs, "high", 1)).toEqual([1, 3]);
    expect(confirmedSwings(highs, "low", 1)).toEqual([2, 4]);
    // Index 5 (6) is below 7, and 6 is the newest value, which nothing can confirm.
    expect(confirmedSwings([1, 2, 9, 2, 1, 3], "high", 2)).toEqual([2]);
  });

  it("does not count a tie as a swing", () => {
    expect(confirmedSwings([1, 3, 3, 1], "high", 1)).toEqual([]);
  });

  it("needs every neighbour inside `span`, not just the adjacent ones", () => {
    // 5 at index 2 beats its adjacent neighbours but not the 6 two bars right.
    expect(confirmedSwings([1, 2, 5, 4, 6, 1, 0], "high", 2)).toEqual([4]);
  });
});
