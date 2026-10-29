/**
 * Read-only BarSource backed by parquet files on local disk.
 *
 * Layout: `{BAR_CACHE_DIR}/ohlcv-1m/{symbol}/{year}.parquet`.
 *
 * Files are populated by the vendor-specific Phase 2 fetcher (Databento now,
 * Massive or others later). This reader does not know or care which vendor
 * produced them — the canonical schema is the contract.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Bar, BarSource, BarSourceCoverage } from "./bar-source";
import { readParquetToBars } from "./parquet-io";

export const DEFAULT_CACHE_DIR = "./data/bar-cache";
const SCHEMA_DIR = "ohlcv-1m";

const NS_PER_MS = BigInt(1_000_000);

/**
 * The cache root this process reads: an explicit override, else
 * `BAR_CACHE_DIR`, else the default — resolved absolute against
 * `process.cwd()`.
 *
 * **Exported because the default branch is the one prod runs on.** The app
 * container is never handed `BAR_CACHE_DIR` (setting it would flip the
 * Databento provider's `isConfigured()` as a side effect of a path) and
 * mounts the archive at `/app/data/bar-cache` under `WORKDIR /app`, so
 * `./data/bar-cache` *is* the bind there. A caller deciding whether the
 * archive is reachable has to ask this same question, or it answers about
 * an environment variable while this class reads the mounted cache beside
 * it — which is how the regime label came back "not configured" on the one
 * box that has the bars ([bugs.md](../../../docs/bugs.md) A81).
 *
 * An empty `BAR_CACHE_DIR` counts as unset, matching how `settings-cache`
 * reads an empty row; resolving `""` would point the reader at `cwd`.
 */
export function resolveCacheDir(override?: string): string {
  const fromEnv = process.env.BAR_CACHE_DIR;
  const raw = override ?? (fromEnv != null && fromEnv.length > 0 ? fromEnv : DEFAULT_CACHE_DIR);
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function nsFromDate(d: Date): bigint {
  return BigInt(d.getTime()) * NS_PER_MS;
}

export interface ParquetCacheBarSourceOptions {
  /**
   * Override the cache root. Defaults to `process.env.BAR_CACHE_DIR` or
   * `./data/bar-cache` when the env var is unset. Resolved relative to
   * `process.cwd()` if not absolute.
   */
  cacheDir?: string;
}

export class ParquetCacheBarSource implements BarSource {
  private readonly cacheDir: string;

  constructor(options: ParquetCacheBarSourceOptions = {}) {
    this.cacheDir = resolveCacheDir(options.cacheDir);
  }

  async getBars(symbol: string, fromUtc: Date, toUtc: Date): Promise<Bar[]> {
    if (fromUtc > toUtc) return [];
    const fromNs = nsFromDate(fromUtc);
    const toNs = nsFromDate(toUtc);
    const fromYear = fromUtc.getUTCFullYear();
    const toYear = toUtc.getUTCFullYear();
    const symbolDir = path.join(this.cacheDir, SCHEMA_DIR, symbol);

    const out: Bar[] = [];
    for (let year = fromYear; year <= toYear; year++) {
      const file = path.join(symbolDir, `${year}.parquet`);
      let bytes: Uint8Array;
      try {
        const buf = await fs.readFile(file);
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        if (isMissingFileError(err)) continue;
        throw err;
      }
      const bars = await readParquetToBars(bytes);
      for (const b of bars) {
        if (b.tsUtc < fromNs || b.tsUtc > toNs) continue;
        out.push(b);
      }
    }
    out.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
    return out;
  }

  async coverage(symbol: string): Promise<BarSourceCoverage> {
    const symbolDir = path.join(this.cacheDir, SCHEMA_DIR, symbol);
    let entries: string[];
    try {
      entries = await fs.readdir(symbolDir);
    } catch (err) {
      if (isMissingFileError(err)) return { minUtc: null, maxUtc: null };
      throw err;
    }
    const yearFiles = entries
      .filter((e) => /^\d{4}\.parquet$/.test(e))
      .sort();
    if (yearFiles.length === 0) return { minUtc: null, maxUtc: null };

    let minNs: bigint | null = null;
    let maxNs: bigint | null = null;
    for (const file of [yearFiles[0], yearFiles[yearFiles.length - 1]]) {
      const buf = await fs.readFile(path.join(symbolDir, file));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const bars = await readParquetToBars(bytes);
      for (const b of bars) {
        if (minNs === null || b.tsUtc < minNs) minNs = b.tsUtc;
        if (maxNs === null || b.tsUtc > maxNs) maxNs = b.tsUtc;
      }
    }
    return {
      minUtc: minNs === null ? null : new Date(Number(minNs / NS_PER_MS)),
      maxUtc: maxNs === null ? null : new Date(Number(maxNs / NS_PER_MS)),
    };
  }
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}
