/**
 * The cache-backed historical-bars path, in one place.
 *
 * Three backtest routes used to build `ParquetCacheBarSource` →
 * `ChainedBarSource(cache, TopstepBarSource)` → `aggregateBars` inline and
 * identically. That construction is the caching/chaining *layer*, not a
 * vendor seam, so it belongs beneath the `MarketDataProvider` boundary
 * rather than inside route handlers — a provider that wants cache-backed
 * history calls the same function.
 *
 * Two reads live here and the difference between them is the point.
 * `fetchCachedBars` is the **freshest** answer: cache plus a Topstep tail,
 * for a caller that wants the range filled. `fetchArchiveBars` is the **one
 * source** answer: the cache alone, for a caller whose whole requirement is
 * that another reader of the same span gets identical bars.
 */
import type { BarData, BarUnit } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";
import { topstepMarketDataProvider } from "@/lib/brokers/topstep/market-data-provider";
import { promises as fs } from "node:fs";
import type { BarSource, BarSourceCoverage } from "./bar-source";
import { ParquetCacheBarSource, resolveCacheDir } from "./bar-cache";
import { ChainedBarSource } from "./chained-bar-source";
import { TopstepBarSource } from "./topstep-bar-source";
import { aggregateBars } from "./aggregator";
import { barToBarData } from "./bar-source-adapter";

const NS_PER_MS = BigInt(1_000_000);

/**
 * Tickers we have cache coverage for. Cache symbols are vendor-canonical
 * Databento continuous forms. Keys are the leading-slash-stripped form of
 * `TickerSymbol` so a `/NQ` lookup hits `NQ`. Tickers absent here fall
 * through to the Topstep history walk.
 *
 * Every deployable micro uses `.v.0` (volume-mapped), never `.c.0`. `.c.0`
 * follows the calendar front month: for gold that lands on a near-dead serial
 * month for much of the year — 4 bars a day against 1,379 — and for the index
 * micros it holds the expiring contract through its 09:30 ET settlement on
 * every quarterly third Friday, so the cash session is missing four times a
 * year and roll week is priced on a contract the account no longer trades
 * (bugs.md A61). The `.c.0` gold directories were renamed `_deprecated-*` on
 * 2026-08-21 and `MGC.v.0` backfilled 2020→2026 in their place; the index
 * micros moved to `.v.0` on 2026-10-25 after a bar-by-bar comparison showed
 * the two series identical outside roll week. The minis (ES, NQ, YM) stay on
 * `.c.0`: research history only, never measured against, not backfilled.
 * `GC` is deliberately absent: the full-size contract is not traded, so it
 * falls through to the Topstep walk like any other unmapped ticker rather
 * than pointing at a cache symbol that does not exist. See providers.md.
 */
export const TICKER_TO_CACHE_SYMBOL: Readonly<Record<string, string>> = {
  ES: "ES.c.0",
  MES: "MES.v.0",
  NQ: "NQ.c.0",
  MNQ: "MNQ.v.0",
  YM: "YM.c.0",
  MYM: "MYM.v.0",
  MGC: "MGC.v.0",
};

/**
 * `aggregateBars` buckets by UTC epoch (`floor(minutes_since_epoch / N) * N`),
 * which diverges from Topstep's session-anchored aggregation at ≥1h. A 4h
 * backtest from cache would have different OHLC boundaries than the same
 * backtest from Topstep, so these timeframes skip the cache entirely.
 */
export const HIGH_TF_NO_CACHE: ReadonlySet<Timeframe> = new Set<Timeframe>(["1h", "4h", "1d"]);

const TIMEFRAME_TO_MINUTES: Readonly<Record<Timeframe, number>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/** Cache symbol for a ticker, or null when the ticker has no cache coverage. */
export function cacheSymbolForTicker(ticker: string): string | null {
  return TICKER_TO_CACHE_SYMBOL[ticker.replace(/^\//, "")] ?? null;
}

/**
 * Invert Topstep's `(unit, unitNumber)` pair back to a `Timeframe`. A
 * provider that speaks the Topstep request shape but does not speak to
 * Topstep needs this to pick an aggregation bucket. Returns null for any
 * pair no `Timeframe` covers rather than guessing a bucket size.
 */
export function timeframeForBarUnit(unit: BarUnit, unitNumber: number): Timeframe | null {
  const minutes =
    unit === 2 ? unitNumber : unit === 3 ? unitNumber * 60 : unit === 4 ? unitNumber * 1440 : null;
  if (minutes === null) return null;
  for (const [tf, m] of Object.entries(TIMEFRAME_TO_MINUTES) as [Timeframe, number][]) {
    if (m === minutes) return tf;
  }
  return null;
}

export type CachedBarsOutcome =
  | {
      kind: "bars";
      bars: BarData[];
      coverage: BarSourceCoverage;
      /** True when the chained tail past the cache's `maxUtc` contributed bars. */
      topstepContributed: boolean;
    }
  | { kind: "skipped"; reason: "htf-bucket-mismatch" | "no-coverage" | "no-bars" };

export interface FetchCachedBarsArgs {
  cacheSymbol: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
  /** Topstep contract id for the live tail spliced past the cache's coverage. */
  tailContractId: string;
}

/**
 * Which bound a cache-only read hit, when it could not serve the window.
 * Each names a fact about *this box* — a directory that is not there, a
 * symbol nothing backfilled, an archive that starts too late — never a fact
 * about an environment variable, because prod runs on the default path and
 * holds no variable to name.
 */
export type ArchiveBound = "not-mounted" | "no-coverage" | "coverage-short";

export type ArchiveBarsOutcome =
  | { kind: "bars"; bars: BarData[]; coverage: BarSourceCoverage }
  | { kind: "unavailable"; bound: ArchiveBound; detail: string };

export interface FetchArchiveBarsArgs {
  cacheSymbol: string;
  from: Date;
  to: Date;
  cacheDir?: string;
}

/**
 * Read `[from, to]` from the Parquet cache, **and only the cache**, at the
 * archive's native 1m — no chain, no Topstep tail, no aggregation.
 *
 * This is the read for a caller that needs one source rather than a fresh
 * one: the same bars the backtest CLI's `loadCacheBars` builds its session
 * days from, under the same coverage predicate, so two readers of the same
 * span cannot build the same session day from different bars. `to` past the
 * cache's `maxUtc` is **not** a refusal — a caller asking about a session
 * that has not happened yet is normal, and the rolling embargo keeps the
 * archive about one session behind regardless.
 *
 * Coverage that does not reach `from` is `unavailable` with the bound
 * named, never a short array: a shorter window than the caller asked for is
 * indistinguishable from a thin one, and it is what a warmup requirement
 * fails silently against.
 *
 * **The cache root resolves exactly as `ParquetCacheBarSource`'s does**, via
 * `resolveCacheDir` — `BAR_CACHE_DIR` when it is set, the repo/WORKDIR
 * default otherwise. Gating on the variable instead would refuse on the one
 * box that matters: the app container is handed no `BAR_CACHE_DIR` and
 * mounts the archive at the default path, so a read keyed on the variable
 * answers "not configured" while the bars sit under it.
 *
 * Cost: `coverage` parses the first and last year file and `getBars` parses
 * every year file the span touches, so a 13-month window is two files read
 * twice — seconds of CPU and a few hundred MB transient. Not for a hot path.
 */
export async function fetchArchiveBars(
  args: FetchArchiveBarsArgs,
): Promise<ArchiveBarsOutcome> {
  const { cacheSymbol, from, to } = args;

  const cacheDir = resolveCacheDir(args.cacheDir);
  if (!(await isReadableDirectory(cacheDir))) {
    return {
      kind: "unavailable",
      bound: "not-mounted",
      detail: `no bar cache directory at ${cacheDir} in this process`,
    };
  }

  const cache = new ParquetCacheBarSource({ cacheDir });
  const coverage = await cache.coverage(cacheSymbol);
  if (coverage.minUtc == null) {
    return {
      kind: "unavailable",
      bound: "no-coverage",
      detail: `the cache under ${cacheDir} holds nothing for ${cacheSymbol}`,
    };
  }
  if (coverage.minUtc > from) {
    return {
      kind: "unavailable",
      bound: "coverage-short",
      detail:
        `${cacheSymbol} starts ${coverage.minUtc.toISOString()}, after the ` +
        `${from.toISOString()} the window needs`,
    };
  }

  const bars = await cache.getBars(cacheSymbol, from, to);
  return { kind: "bars", bars: bars.map(barToBarData), coverage };
}

/** A root this process can actually read. An unreadable one is the same
 *  operator story as an absent one — there is no archive here — and it is
 *  named rather than left to surface as an empty read per symbol. */
async function isReadableDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The cache with the Topstep tail spliced on past its coverage — the one
 * binding of `TopstepBarSource`, shared by `fetchCachedBars` and the backtest
 * CLI's opt-in `--topstep-tail`, so the two cannot splice differently.
 */
export function chainCacheWithTopstepTail(cache: BarSource, tailContractId: string): BarSource {
  return new ChainedBarSource(
    cache,
    new TopstepBarSource(topstepMarketDataProvider, tailContractId),
  );
}

/**
 * Read `[from, to]` from the Parquet cache, splicing the Topstep tail on for
 * anything past the cache's coverage, and aggregate to `timeframe`.
 *
 * Returns a `skipped` outcome rather than an empty array so callers can tell
 * "the cache does not serve this" from "the cache served nothing" and fall
 * through to a full Topstep walk without silently shrinking the range.
 */
export async function fetchCachedBars(args: FetchCachedBarsArgs): Promise<CachedBarsOutcome> {
  const { cacheSymbol, timeframe, from, to, tailContractId } = args;

  if (HIGH_TF_NO_CACHE.has(timeframe)) {
    return { kind: "skipped", reason: "htf-bucket-mismatch" };
  }

  const cache = new ParquetCacheBarSource();
  const coverage = await cache.coverage(cacheSymbol);
  if (coverage.minUtc == null) {
    return { kind: "skipped", reason: "no-coverage" };
  }

  // Chaining is unconditional and safe: when `to` is inside the cache's
  // coverage the chain delegates entirely to the cache and never calls the
  // tail. Databento's rolling 24h embargo means the cache is permanently
  // about one session behind, so the tail is the normal path, not an edge.
  //
  // The tail binds the Topstep provider by import rather than through
  // `marketDataRegistry`: it must be the live-capable vendor, never
  // `realtime()` or `historical()`, and going through the registry
  // singleton would also make this module import the module that registers
  // the cache-backed provider that calls it.
  const chained = chainCacheWithTopstepTail(cache, tailContractId);
  const cacheBars = await chained.getBars(cacheSymbol, from, to);
  if (cacheBars.length === 0) {
    return { kind: "skipped", reason: "no-bars" };
  }

  const cacheMaxNs = coverage.maxUtc != null ? BigInt(coverage.maxUtc.getTime()) * NS_PER_MS : null;
  const topstepContributed = cacheMaxNs != null && cacheBars.some((b) => b.tsUtc > cacheMaxNs);

  const aggregated = aggregateBars(cacheBars, TIMEFRAME_TO_MINUTES[timeframe]);
  return {
    kind: "bars",
    bars: aggregated.map(barToBarData),
    coverage,
    topstepContributed,
  };
}
