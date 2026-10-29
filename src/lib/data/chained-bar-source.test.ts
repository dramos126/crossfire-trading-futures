import { describe, it, expect, vi } from "vitest";

import type { Bar, BarSource, BarSourceCoverage } from "./bar-source";
import { ChainedBarSource } from "./chained-bar-source";

const NS_PER_MS = BigInt(1_000_000);

function bar(tsMs: number, open = 100): Bar {
  return {
    tsUtc: BigInt(tsMs) * NS_PER_MS,
    open,
    high: open + 1,
    low: open - 1,
    close: open + 0.5,
    volume: BigInt(10),
    symbol: "ES.c.0",
  };
}

function makeSource(opts: {
  bars: Bar[];
  coverage: BarSourceCoverage;
}): BarSource & {
  getBars: ReturnType<typeof vi.fn>;
  coverage: ReturnType<typeof vi.fn>;
} {
  return {
    getBars: vi.fn(async (_s: string, from: Date, to: Date) =>
      opts.bars.filter(
        (b) => b.tsUtc >= BigInt(from.getTime()) * NS_PER_MS && b.tsUtc <= BigInt(to.getTime()) * NS_PER_MS,
      ),
    ),
    coverage: vi.fn(async () => opts.coverage),
  };
}

describe("ChainedBarSource", () => {
  it("delegates entirely to fallback when primary has no coverage", async () => {
    const t0 = Date.UTC(2026, 0, 5, 22, 0, 0);
    const primary = makeSource({ bars: [], coverage: { minUtc: null, maxUtc: null } });
    const fallback = makeSource({
      bars: [bar(t0, 1), bar(t0 + 60_000, 2)],
      coverage: { minUtc: null, maxUtc: null },
    });
    const chained = new ChainedBarSource(primary, fallback);

    const out = await chained.getBars("ES.c.0", new Date(t0 - 60_000), new Date(t0 + 120_000));

    expect(out.map((b) => b.open)).toEqual([1, 2]);
    expect(primary.getBars).not.toHaveBeenCalled();
    expect(fallback.getBars).toHaveBeenCalledTimes(1);
  });

  it("delegates entirely to primary when toUtc <= primary.maxUtc", async () => {
    const cacheMax = Date.UTC(2025, 11, 31, 22, 0, 0);
    const primary = makeSource({
      bars: [bar(cacheMax - 120_000, 1), bar(cacheMax - 60_000, 2)],
      coverage: { minUtc: new Date(0), maxUtc: new Date(cacheMax) },
    });
    const fallback = makeSource({ bars: [], coverage: { minUtc: null, maxUtc: null } });
    const chained = new ChainedBarSource(primary, fallback);

    const out = await chained.getBars(
      "ES.c.0",
      new Date(cacheMax - 600_000),
      new Date(cacheMax - 30_000),
    );

    expect(out.map((b) => b.open)).toEqual([1, 2]);
    expect(primary.getBars).toHaveBeenCalledTimes(1);
    expect(fallback.getBars).not.toHaveBeenCalled();
  });

  it("concatenates and sorts when toUtc > primary.maxUtc", async () => {
    const cacheMax = Date.UTC(2025, 11, 31, 22, 0, 0);
    const requestedEnd = Date.UTC(2026, 0, 6, 22, 0, 0);
    const liveStart = Date.UTC(2026, 0, 5, 22, 0, 0);

    const primary = makeSource({
      bars: [bar(cacheMax - 60_000, 1), bar(cacheMax, 2)],
      coverage: { minUtc: new Date(0), maxUtc: new Date(cacheMax) },
    });
    const fallback = makeSource({
      bars: [bar(liveStart, 3), bar(liveStart + 60_000, 4)],
      coverage: { minUtc: null, maxUtc: null },
    });
    const chained = new ChainedBarSource(primary, fallback);

    const out = await chained.getBars(
      "ES.c.0",
      new Date(cacheMax - 600_000),
      new Date(requestedEnd),
    );

    expect(out.map((b) => b.open)).toEqual([1, 2, 3, 4]);
    expect(primary.getBars).toHaveBeenCalledWith("ES.c.0", expect.any(Date), new Date(cacheMax));
    expect(fallback.getBars).toHaveBeenCalledWith("ES.c.0", new Date(cacheMax), new Date(requestedEnd));
  });

  it("dedupes bars with the same tsUtc across primary and fallback", async () => {
    const cacheMax = Date.UTC(2025, 11, 31, 22, 0, 0);
    const requestedEnd = cacheMax + 120_000;

    const primary = makeSource({
      bars: [bar(cacheMax - 60_000, 1), bar(cacheMax, 2)],
      coverage: { minUtc: new Date(0), maxUtc: new Date(cacheMax) },
    });
    const fallback = makeSource({
      // fallback returns a bar at the exact splice instant (cacheMax) — must dedupe
      bars: [bar(cacheMax, 99), bar(cacheMax + 60_000, 3)],
      coverage: { minUtc: null, maxUtc: null },
    });
    const chained = new ChainedBarSource(primary, fallback);

    const out = await chained.getBars(
      "ES.c.0",
      new Date(cacheMax - 600_000),
      new Date(requestedEnd),
    );

    expect(out).toHaveLength(3);
    expect(out.map((b) => b.open)).toEqual([1, 2, 3]);
  });

  it("warns and returns primary-only bars when fallback returns 0 for a non-empty gap", async () => {
    const cacheMax = Date.UTC(2025, 11, 31, 22, 0, 0);
    const requestedEnd = Date.UTC(2026, 0, 6, 22, 0, 0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const primary = makeSource({
      bars: [bar(cacheMax - 60_000, 1), bar(cacheMax, 2)],
      coverage: { minUtc: new Date(0), maxUtc: new Date(cacheMax) },
    });
    const fallback = makeSource({ bars: [], coverage: { minUtc: null, maxUtc: null } });
    const chained = new ChainedBarSource(primary, fallback);

    const out = await chained.getBars(
      "ES.c.0",
      new Date(cacheMax - 600_000),
      new Date(requestedEnd),
    );

    expect(out.map((b) => b.open)).toEqual([1, 2]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("fallback returned 0 bars");
    warnSpy.mockRestore();
  });

  it("coverage returns primary coverage", async () => {
    const cacheMin = new Date(Date.UTC(2020, 0, 1));
    const cacheMax = new Date(Date.UTC(2025, 11, 31, 22, 0, 0));
    const primary = makeSource({ bars: [], coverage: { minUtc: cacheMin, maxUtc: cacheMax } });
    const fallback = makeSource({
      bars: [],
      coverage: { minUtc: new Date(0), maxUtc: new Date(Date.UTC(2026, 0, 6)) },
    });
    const chained = new ChainedBarSource(primary, fallback);

    const cov = await chained.coverage("ES.c.0");

    expect(cov.minUtc).toEqual(cacheMin);
    expect(cov.maxUtc).toEqual(cacheMax);
    expect(fallback.coverage).not.toHaveBeenCalled();
  });
});
