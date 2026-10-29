import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Bar } from "./bar-source";
import { ParquetCacheBarSource } from "./bar-cache";
import { writeBarsToParquet } from "./parquet-io";

const NS_PER_MS = BigInt(1_000_000);
const NS_PER_MIN = BigInt(60_000) * NS_PER_MS;

function makeBar(tsUtc: bigint, symbol: string, base: number): Bar {
  return {
    tsUtc,
    open: base,
    high: base + 0.25,
    low: base - 0.25,
    close: base + 0.1,
    volume: BigInt(100),
    symbol,
  };
}

async function writeYearFile(
  cacheDir: string,
  symbol: string,
  year: number,
  bars: Bar[],
): Promise<void> {
  const dir = path.join(cacheDir, "ohlcv-1m", symbol);
  await fs.mkdir(dir, { recursive: true });
  const bytes = await writeBarsToParquet(bars);
  await fs.writeFile(path.join(dir, `${year}.parquet`), Buffer.from(bytes));
}

describe("ParquetCacheBarSource", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bar-cache-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a single-year fixture preserving nanosecond timestamps", async () => {
    const symbol = "ES.c.0";
    // Three minute-bars in 2024-06-01.
    const t0 = BigInt(Date.UTC(2024, 5, 1, 14, 30, 0)) * NS_PER_MS;
    const bars: Bar[] = [
      makeBar(t0, symbol, 5300),
      makeBar(t0 + NS_PER_MIN, symbol, 5301),
      makeBar(t0 + NS_PER_MIN * BigInt(2), symbol, 5302),
    ];
    await writeYearFile(tmpDir, symbol, 2024, bars);

    const src = new ParquetCacheBarSource({ cacheDir: tmpDir });
    const got = await src.getBars(
      symbol,
      new Date(Date.UTC(2024, 0, 1)),
      new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999)),
    );
    expect(got).toHaveLength(3);
    expect(got[0].tsUtc).toBe(t0);
    expect(got[1].tsUtc).toBe(t0 + NS_PER_MIN);
    expect(got[2].tsUtc).toBe(t0 + NS_PER_MIN * BigInt(2));
    expect(got[0].open).toBe(5300);
    expect(got[0].symbol).toBe(symbol);
    expect(got[0].volume).toBe(BigInt(100));
  });

  it("returns empty array (does not throw) when no files exist for a symbol", async () => {
    const src = new ParquetCacheBarSource({ cacheDir: tmpDir });
    const got = await src.getBars(
      "DOES_NOT_EXIST",
      new Date(Date.UTC(2020, 0, 1)),
      new Date(Date.UTC(2020, 11, 31)),
    );
    expect(got).toEqual([]);
    const cov = await src.coverage("DOES_NOT_EXIST");
    expect(cov).toEqual({ minUtc: null, maxUtc: null });
  });

  it("merges bars from adjacent year files when range spans Jan 1", async () => {
    const symbol = "NQ.c.0";
    const dec31 = BigInt(Date.UTC(2023, 11, 31, 23, 59, 0)) * NS_PER_MS;
    const jan01a = BigInt(Date.UTC(2024, 0, 1, 0, 0, 0)) * NS_PER_MS;
    const jan01b = BigInt(Date.UTC(2024, 0, 1, 0, 1, 0)) * NS_PER_MS;
    const yr2023: Bar[] = [
      makeBar(BigInt(Date.UTC(2023, 11, 31, 23, 58, 0)) * NS_PER_MS, symbol, 17000),
      makeBar(dec31, symbol, 17001),
    ];
    const yr2024: Bar[] = [
      makeBar(jan01a, symbol, 17002),
      makeBar(jan01b, symbol, 17003),
    ];
    await writeYearFile(tmpDir, symbol, 2023, yr2023);
    await writeYearFile(tmpDir, symbol, 2024, yr2024);

    const src = new ParquetCacheBarSource({ cacheDir: tmpDir });
    const got = await src.getBars(
      symbol,
      new Date(Date.UTC(2023, 11, 31, 23, 59, 0)),
      new Date(Date.UTC(2024, 0, 1, 0, 1, 0)),
    );
    expect(got.map((b) => b.tsUtc)).toEqual([dec31, jan01a, jan01b]);

    const cov = await src.coverage(symbol);
    expect(cov.minUtc?.toISOString()).toBe(new Date(Date.UTC(2023, 11, 31, 23, 58, 0)).toISOString());
    expect(cov.maxUtc?.toISOString()).toBe(new Date(Date.UTC(2024, 0, 1, 0, 1, 0)).toISOString());
  });
});
