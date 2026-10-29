import { describe, it, expect } from "vitest";

import type { Bar } from "./bar-source";
import type { BarData } from "@/lib/brokers/types";
import { barToBarData, barDataToBar } from "./bar-source-adapter";

const NS_PER_MS = BigInt(1_000_000);

describe("bar-source-adapter", () => {
  it("barToBarData produces a UTC ISO timestamp matching the bigint ns input", () => {
    const ms = Date.UTC(2024, 5, 1, 14, 30, 0);
    const bar: Bar = {
      tsUtc: BigInt(ms) * NS_PER_MS,
      open: 5300,
      high: 5301.25,
      low: 5299.75,
      close: 5300.5,
      volume: BigInt(1234),
      symbol: "ES.c.0",
    };
    const out = barToBarData(bar);
    expect(out.timestamp).toBe("2024-06-01T14:30:00.000Z");
    expect(out.open).toBe(5300);
    expect(out.close).toBe(5300.5);
    expect(out.volume).toBe(1234);
  });

  it("barDataToBar produces bigint ns matching the ISO string timestamp", () => {
    const bd: BarData = {
      timestamp: "2024-06-01T14:30:00.000Z",
      open: 5300,
      high: 5301.25,
      low: 5299.75,
      close: 5300.5,
      volume: 1234,
    };
    const out = barDataToBar(bd, "ES.c.0");
    expect(out.tsUtc).toBe(BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS);
    expect(out.symbol).toBe("ES.c.0");
    expect(out.volume).toBe(BigInt(1234));
    expect(out.open).toBe(5300);
  });

  it("round-trips Bar → BarData → Bar at millisecond resolution", () => {
    const ms = Date.UTC(2024, 0, 15, 9, 31, 0);
    const original: Bar = {
      tsUtc: BigInt(ms) * NS_PER_MS,
      open: 17000,
      high: 17005,
      low: 16998,
      close: 17002,
      volume: BigInt(987654),
      symbol: "NQ.c.0",
    };
    const round = barDataToBar(barToBarData(original), original.symbol);
    expect(round.tsUtc).toBe(original.tsUtc);
    expect(round.open).toBe(original.open);
    expect(round.high).toBe(original.high);
    expect(round.low).toBe(original.low);
    expect(round.close).toBe(original.close);
    expect(round.volume).toBe(original.volume);
    expect(round.symbol).toBe(original.symbol);
  });

  it("converts volume bigint → number and number → bigint correctly", () => {
    const bar: Bar = {
      tsUtc: BigInt(0),
      open: 1, high: 1, low: 1, close: 1,
      volume: BigInt(42),
      symbol: "X",
    };
    expect(barToBarData(bar).volume).toBe(42);

    const bd: BarData = { timestamp: "1970-01-01T00:00:00.000Z", open: 1, high: 1, low: 1, close: 1, volume: 42 };
    expect(barDataToBar(bd, "X").volume).toBe(BigInt(42));
  });
});
