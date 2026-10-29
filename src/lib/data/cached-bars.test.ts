import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// `cached-bars` binds the Topstep provider for the chained tail, and that
// import reaches the Tradovate plugin, which reaches the strategy loader's
// `require.context` — a bundler-only mechanism vitest has no equivalent
// for. Cutting the chain at the broker registry keeps these pure-function
// tests importable; nothing here touches a provider.
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: vi.fn(() => null) },
}));

import type { Bar } from "./bar-source";
import { writeBarsToParquet } from "./parquet-io";
import { cacheSymbolForTicker, fetchArchiveBars, timeframeForBarUnit } from "./cached-bars";

describe("cacheSymbolForTicker", () => {
  it("resolves a leading-slash ticker to its continuous cache symbol", () => {
    expect(cacheSymbolForTicker("/MNQ")).toBe("MNQ.v.0");
  });

  it("resolves the bare form too", () => {
    expect(cacheSymbolForTicker("ES")).toBe("ES.c.0");
  });

  it("returns null for a ticker with no cache coverage", () => {
    expect(cacheSymbolForTicker("/CL")).toBeNull();
  });

  // A deployment row stores the ticker, never a cache symbol, so this table is
  // the only place a gold read can pick its series.
  it("gold cached under .c.0 is an intermittent series: MGC reads .v.0 and GC has no cache symbol", () => {
    expect(cacheSymbolForTicker("/MGC")).toBe("MGC.v.0");
    expect(cacheSymbolForTicker("/GC")).toBeNull();
  });
});

describe("timeframeForBarUnit", () => {
  it("maps minute units by unitNumber", () => {
    expect(timeframeForBarUnit(2, 1)).toBe("1m");
    expect(timeframeForBarUnit(2, 15)).toBe("15m");
  });

  it("maps hour units through minutes", () => {
    expect(timeframeForBarUnit(3, 1)).toBe("1h");
    expect(timeframeForBarUnit(3, 4)).toBe("4h");
  });

  it("maps the day unit", () => {
    expect(timeframeForBarUnit(4, 1)).toBe("1d");
  });

  it("returns null for a minute count no Timeframe covers rather than guessing a bucket", () => {
    expect(timeframeForBarUnit(2, 7)).toBeNull();
  });

  it("returns null for units below minute — tick and second have no bucket here", () => {
    expect(timeframeForBarUnit(1, 1)).toBeNull();
  });

  it("returns null for week and month units", () => {
    expect(timeframeForBarUnit(5, 1)).toBeNull();
    expect(timeframeForBarUnit(6, 1)).toBeNull();
  });
});

/**
 * The cache-only read. Its whole job is to say *which* bound it hit instead
 * of coming back short — a warmup requirement measured against a silently
 * truncated read is what left the live regime labeller unable to produce a
 * label at all (bugs.md A81).
 */
describe("fetchArchiveBars", () => {
  const SYMBOL = "MNQ.c.0";
  const NS_PER_MS = BigInt(1_000_000);
  const NS_PER_MIN = BigInt(60_000) * NS_PER_MS;
  /** Stands in for the container's `WORKDIR /app`. */
  let workDir: string;
  /** Stands in for the `:ro` bind at `/app/data/bar-cache`. */
  let cacheDir: string;

  function bar(tsUtc: bigint, base: number): Bar {
    return { tsUtc, open: base, high: base + 1, low: base - 1, close: base, volume: BigInt(1), symbol: SYMBOL };
  }

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-bars-test-"));
    cacheDir = path.join(workDir, "data", "bar-cache");
    const dir = path.join(cacheDir, "ohlcv-1m", SYMBOL);
    await fs.mkdir(dir, { recursive: true });
    // Coverage is 2026-06-01 onward — a year file that starts mid-year is the
    // shape a half-rebuilt archive has.
    const start = BigInt(Date.parse("2026-06-01T00:00:00Z")) * NS_PER_MS;
    const bars: Bar[] = [];
    for (let i = 0; i < 120; i++) bars.push(bar(start + BigInt(i) * NS_PER_MIN, 20_000 + i));
    await fs.writeFile(path.join(dir, "2026.parquet"), Buffer.from(await writeBarsToParquet(bars)));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * **The container's shape, which no other test in the suite has.** The app
   * container is handed no `BAR_CACHE_DIR` — setting it would flip the
   * Databento provider's `isConfigured()` in prod — and mounts the archive at
   * `/app/data/bar-cache` under `WORKDIR /app`. A read keyed on the variable
   * refuses there while sitting on the bars, which is A81 again on the one box
   * that matters and green on every development machine, because those set
   * the variable in `.env.local`.
   */
  it("reads the default cache root when no BAR_CACHE_DIR is set, as the container has it", async () => {
    vi.stubEnv("BAR_CACHE_DIR", undefined);
    vi.spyOn(process, "cwd").mockReturnValue(workDir);

    const outcome = await fetchArchiveBars({
      cacheSymbol: SYMBOL,
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-01T01:00:00Z"),
    });

    expect(outcome.kind).toBe("bars");
    if (outcome.kind !== "bars") return;
    expect(outcome.bars).toHaveLength(61);
  });

  it("names a cache root that is not there rather than reading an empty one", async () => {
    vi.stubEnv("BAR_CACHE_DIR", undefined);
    vi.spyOn(process, "cwd").mockReturnValue(path.join(workDir, "nowhere"));

    const outcome = await fetchArchiveBars({
      cacheSymbol: SYMBOL,
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-01T01:00:00Z"),
    });

    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.bound).toBe("not-mounted");
    expect(outcome.detail).toContain(path.join(workDir, "nowhere", "data", "bar-cache"));
  });

  it("prefers BAR_CACHE_DIR over the default when the deploy does set one", async () => {
    vi.stubEnv("BAR_CACHE_DIR", cacheDir);
    vi.spyOn(process, "cwd").mockReturnValue(path.join(workDir, "nowhere"));

    const outcome = await fetchArchiveBars({
      cacheSymbol: SYMBOL,
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-01T01:00:00Z"),
    });

    expect(outcome.kind).toBe("bars");
  });

  it("names a symbol the archive holds nothing for", async () => {
    const outcome = await fetchArchiveBars({
      cacheSymbol: "MES.c.0",
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-01T01:00:00Z"),
      cacheDir,
    });

    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.bound).toBe("no-coverage");
  });

  it("refuses a window that starts before coverage, and says where coverage starts", async () => {
    const outcome = await fetchArchiveBars({
      cacheSymbol: SYMBOL,
      from: new Date("2025-09-01T00:00:00Z"),
      to: new Date("2026-06-01T01:00:00Z"),
      cacheDir,
    });

    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.bound).toBe("coverage-short");
    expect(outcome.detail).toContain("2026-06-01T00:00:00.000Z");
  });

  it("serves the window at 1m with no tail spliced past coverage", async () => {
    // `to` is deliberately past `maxUtc` — the caller is asking about a
    // session that has not happened, which is normal and is not a refusal.
    const outcome = await fetchArchiveBars({
      cacheSymbol: SYMBOL,
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-09-01T00:00:00Z"),
      cacheDir,
    });

    expect(outcome.kind).toBe("bars");
    if (outcome.kind !== "bars") return;
    expect(outcome.bars).toHaveLength(120);
    expect(outcome.bars[0].timestamp).toBe("2026-06-01T00:00:00.000Z");
    expect(outcome.bars[119].timestamp).toBe("2026-06-01T01:59:00.000Z");
  });
});
