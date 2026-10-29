import { describe, it, expect } from "vitest";

import type { Bar } from "./bar-source";
import { aggregateBars } from "./aggregator";

const NS_PER_MS = BigInt(1_000_000);
const NS_PER_MIN = BigInt(60_000) * NS_PER_MS;

function makeBar(tsUtc: bigint, open: number, high: number, low: number, close: number, volume: number): Bar {
  return { tsUtc, open, high, low, close, volume: BigInt(volume), symbol: "ES.c.0" };
}

describe("aggregateBars", () => {
  it("aggregates 10 sequential 1m bars into 2 five-minute bars with correct OHLCV", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push(makeBar(t0 + NS_PER_MIN * BigInt(i), 100 + i, 101 + i, 99 + i, 100 + i + 0.5, 10 + i));
    }
    const out = aggregateBars(bars, 5);
    expect(out).toHaveLength(2);

    expect(out[0].tsUtc).toBe(t0);
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(104.5);
    expect(out[0].high).toBe(105);
    expect(out[0].low).toBe(99);
    expect(out[0].volume).toBe(BigInt(10 + 11 + 12 + 13 + 14));

    expect(out[1].tsUtc).toBe(t0 + NS_PER_MIN * BigInt(5));
    expect(out[1].open).toBe(105);
    expect(out[1].close).toBe(109.5);
    expect(out[1].high).toBe(110);
    expect(out[1].low).toBe(104);
    expect(out[1].volume).toBe(BigInt(15 + 16 + 17 + 18 + 19));
  });

  it("emits no bar for empty buckets when input is sparse (gaps in timestamps)", () => {
    // Bucket 0: minutes 0,1,2 (3 bars). Bucket 1: minutes 5..9 (none). Bucket 2: minutes 10,11 (2 bars).
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 0, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      makeBar(t0 + NS_PER_MIN * BigInt(0), 1, 2, 0.5, 1.5, 5),
      makeBar(t0 + NS_PER_MIN * BigInt(1), 1.5, 2.5, 1, 2, 6),
      makeBar(t0 + NS_PER_MIN * BigInt(2), 2, 3, 1.5, 2.5, 7),
      makeBar(t0 + NS_PER_MIN * BigInt(10), 10, 11, 9.5, 10.5, 8),
      makeBar(t0 + NS_PER_MIN * BigInt(11), 10.5, 12, 10, 11.5, 9),
    ];
    const out = aggregateBars(bars, 5);
    expect(out).toHaveLength(2);
    expect(out[0].tsUtc).toBe(t0);
    expect(out[0].volume).toBe(BigInt(18));
    expect(out[1].tsUtc).toBe(t0 + NS_PER_MIN * BigInt(10));
    expect(out[1].volume).toBe(BigInt(17));
  });

  it("returns input unchanged when targetMinutes === 1", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      makeBar(t0, 100, 101, 99, 100.5, 10),
      makeBar(t0 + NS_PER_MIN, 100.5, 101.5, 99.5, 101, 11),
    ];
    const out = aggregateBars(bars, 1);
    expect(out).toBe(bars);
  });

  it("sums volume across the bucket", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      makeBar(t0 + NS_PER_MIN * BigInt(0), 1, 1, 1, 1, 100),
      makeBar(t0 + NS_PER_MIN * BigInt(1), 1, 1, 1, 1, 200),
      makeBar(t0 + NS_PER_MIN * BigInt(2), 1, 1, 1, 1, 300),
    ];
    const out = aggregateBars(bars, 5);
    expect(out).toHaveLength(1);
    expect(out[0].volume).toBe(BigInt(600));
  });

  it("OHLC: open = first, high = max, low = min, close = last", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      // first bar opens at 50, sets initial low
      makeBar(t0 + NS_PER_MIN * BigInt(0), 50, 52, 49, 51, 1),
      // mid bar carries the highest high
      makeBar(t0 + NS_PER_MIN * BigInt(1), 51, 60, 50, 55, 1),
      // bar with the lowest low
      makeBar(t0 + NS_PER_MIN * BigInt(2), 55, 56, 40, 45, 1),
      // last bar's close is the bucket close
      makeBar(t0 + NS_PER_MIN * BigInt(3), 45, 48, 44, 47, 1),
      makeBar(t0 + NS_PER_MIN * BigInt(4), 47, 49, 46, 48.75, 1),
    ];
    const out = aggregateBars(bars, 5);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(50);
    expect(out[0].high).toBe(60);
    expect(out[0].low).toBe(40);
    expect(out[0].close).toBe(48.75);
  });

  it("returns empty array on empty input", () => {
    expect(aggregateBars([], 5)).toEqual([]);
  });

  it("60m: aggregates 60 sequential 1m bars all within UTC hour 00:00-01:00 into 1 bar", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 0, 0, 0)) * NS_PER_MS;
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) {
      bars.push(makeBar(t0 + NS_PER_MIN * BigInt(i), 100 + i, 101 + i, 99 + i, 100.5 + i, 1));
    }
    const out = aggregateBars(bars, 60);
    expect(out).toHaveLength(1);
    expect(out[0].tsUtc).toBe(t0);
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(159.5);
    expect(out[0].volume).toBe(BigInt(60));
  });

  it("60m: bars spanning midnight UTC produce 2 bars (UTC-anchored buckets, not session-anchored)", () => {
    // Documents the known divergence from Topstep's session-anchored
    // aggregation: a 23:30 + 00:30 pair lands in two different UTC hour
    // buckets here, while a session-anchored aggregator would group them.
    const before = BigInt(Date.UTC(2024, 5, 1, 23, 30, 0)) * NS_PER_MS;
    const after = BigInt(Date.UTC(2024, 5, 2, 0, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      makeBar(before, 1, 2, 1, 1.5, 5),
      makeBar(after, 2, 3, 2, 2.5, 6),
    ];
    const out = aggregateBars(bars, 60);
    expect(out).toHaveLength(2);
    expect(out[0].tsUtc).toBe(BigInt(Date.UTC(2024, 5, 1, 23, 0, 0)) * NS_PER_MS);
    expect(out[1].tsUtc).toBe(BigInt(Date.UTC(2024, 5, 2, 0, 0, 0)) * NS_PER_MS);
  });

  it("sorts output ascending even when buckets are populated out of order", () => {
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 0, 0)) * NS_PER_MS;
    // Insert later bucket first.
    const bars: Bar[] = [
      makeBar(t0 + NS_PER_MIN * BigInt(11), 2, 2, 2, 2, 1),
      makeBar(t0 + NS_PER_MIN * BigInt(10), 2, 2, 2, 2, 1),
      makeBar(t0 + NS_PER_MIN * BigInt(1), 1, 1, 1, 1, 1),
      makeBar(t0 + NS_PER_MIN * BigInt(0), 1, 1, 1, 1, 1),
    ];
    const out = aggregateBars(bars, 5);
    expect(out).toHaveLength(2);
    expect(out[0].tsUtc < out[1].tsUtc).toBe(true);
  });
});
