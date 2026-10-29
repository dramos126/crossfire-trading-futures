import { describe, it, expect, vi } from "vitest";

import { TopstepBarSource } from "./topstep-bar-source";
import type { MarketDataProvider } from "@/lib/market-data/provider";
import type { BarData, RetrieveBarsRequest } from "@/lib/brokers/types";

const NS_PER_MS = BigInt(1_000_000);

function mockProvider(
  retrieveBars: (req: RetrieveBarsRequest) => Promise<BarData[]>,
): MarketDataProvider {
  return { retrieveBars } as unknown as MarketDataProvider;
}

function bar(timestamp: string, v: number): BarData {
  return { timestamp, open: v, high: v, low: v, close: v, volume: v };
}

describe("TopstepBarSource", () => {
  it("converts BarData → Bar correctly (timestamp, price, volume)", async () => {
    const ts = "2026-01-05T22:00:00.000Z";
    const provider = mockProvider(async () => [
      { timestamp: ts, open: 100.25, high: 101.5, low: 99.75, close: 100.75, volume: 1234 },
    ]);
    const src = new TopstepBarSource(provider, "CON.F.US.ENQ.M26");

    const bars = await src.getBars("NQ.c.0", new Date("2026-01-05T00:00:00Z"), new Date("2026-01-06T00:00:00Z"));

    expect(bars).toHaveLength(1);
    expect(bars[0].tsUtc).toBe(BigInt(new Date(ts).getTime()) * NS_PER_MS);
    expect(bars[0].open).toBe(100.25);
    expect(bars[0].high).toBe(101.5);
    expect(bars[0].low).toBe(99.75);
    expect(bars[0].close).toBe(100.75);
    expect(bars[0].volume).toBe(BigInt(1234));
    expect(bars[0].symbol).toBe("NQ.c.0");
  });

  it("sorts output by tsUtc ascending", async () => {
    const t1 = "2026-01-05T22:00:00.000Z";
    const t2 = "2026-01-05T22:01:00.000Z";
    const t3 = "2026-01-05T22:02:00.000Z";
    const provider = mockProvider(async () => [bar(t3, 3), bar(t1, 1), bar(t2, 2)]);
    const src = new TopstepBarSource(provider, "CON.X");

    const bars = await src.getBars("NQ.c.0", new Date("2026-01-05T00:00:00Z"), new Date("2026-01-06T00:00:00Z"));

    expect(bars.map((b) => b.open)).toEqual([1, 2, 3]);
  });

  it("single-chunk fetch stops after one call when bars < 10k", async () => {
    const calls = vi.fn(async (_req: RetrieveBarsRequest): Promise<BarData[]> => [
      bar("2026-01-05T22:00:00.000Z", 1),
      bar("2026-01-05T22:01:00.000Z", 2),
    ]);
    const provider = mockProvider(calls);
    const src = new TopstepBarSource(provider, "CON.X");

    // Range is wider than the returned bars; the chunk walker should still
    // terminate because the oldest returned bar is at-or-before fromUtc.
    const bars = await src.getBars(
      "NQ.c.0",
      new Date("2026-01-05T22:00:00.000Z"),
      new Date("2026-01-05T23:00:00.000Z"),
    );

    expect(bars).toHaveLength(2);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("coverage returns nulls", async () => {
    const src = new TopstepBarSource(mockProvider(async () => []), "CON.X");
    const cov = await src.coverage("NQ.c.0");
    expect(cov).toEqual({ minUtc: null, maxUtc: null });
  });
});
