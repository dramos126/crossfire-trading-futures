/**
 * Databento OHLCV-1m backfill fetcher (Phase 2 of vendor-agnostic bar cache).
 *
 * Translates Databento's HTTP timeseries.get_range NDJSON response into the
 * canonical parquet schema defined in src/lib/data/bar-source.ts and writes
 * one file per symbol+year under {BAR_CACHE_DIR}/ohlcv-1m/{symbol}/{year}.parquet.
 *
 * Run via: `corepack yarn backfill:databento --symbols ES.c.0,NQ.c.0 --from 2022-01-01 --to 2024-12-31`
 * (`--dry-run` prints the plan and the estimated cost without fetching).
 *
 * The runtime app NEVER imports this file. Vendor API key lives only on the
 * dev machine.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import type { Bar } from "../src/lib/data/bar-source";
import { readParquetToBars, writeBarsToParquet } from "../src/lib/data/parquet-io";

// --- constants ---------------------------------------------------------------

const DATABENTO_HOST = "https://hist.databento.com";
const DATABENTO_DATASET = "GLBX.MDP3";
const DATABENTO_SCHEMA = "ohlcv-1m";
const PRICE_SCALE = 1_000_000_000; // Databento fixed-point divisor (1e9)
const DEFAULT_CACHE_DIR = "./data/bar-cache";
const SCHEMA_DIR = "ohlcv-1m";

// Cost model for OHLCV-1m at Usage-Based pricing.
//
// Calibrated against real billing 2026-08-20: fetching MNQ + MES for
// 2026-05-19..2026-08-19 (92 days, 0.504 contract-years) transferred 10.2 MB
// and was billed $0.67 — i.e. ~20 MB per contract-year at ~$67/GB. The
// previous 46 MB/contract-year constant, combined with pricing by whole
// calendar years instead of actual days, overestimated that run by ~9x
// ($6.29 vs $0.67). An inflated estimate is not harmless: it trips the
// confirm threshold on runs that cost cents, which trains you to raise the
// threshold until it stops protecting anything.
const MB_PER_CONTRACT_YEAR = 20;
const USD_PER_GB = 70;
const DAYS_PER_YEAR = 365;
const CONFIRM_THRESHOLD_USD = 5;

// --- types -------------------------------------------------------------------

export interface BackfillArgs {
  symbols: string[];
  fromYear: number;
  toYear: number;
  fromDate: string; // ISO date e.g. 2022-01-01
  toDate: string;
  confirm: boolean;
  dryRun: boolean;
  force: boolean;
  append: boolean;
  /** Optional path to write a machine-readable run summary (see RunSummary). */
  summaryPath: string | null;
  /** Optional path to write a ready-to-send Discord message (markdown). */
  messagePath: string | null;
  /**
   * Fail the run when coverage is older than this many days. The check lives
   * here rather than in the CI pipeline so it is unit-testable and does not
   * depend on a JSON parser being installed on the CI host.
   */
  maxAgeDays: number | null;
}

/** Per-symbol outcome, one entry per symbol+year touched. */
export interface SymbolResult {
  symbol: string;
  year: number;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  /**
   * Bars returned by the API, including any that were already cached. This is
   * what the request cost; it is NOT what the cache gained — see `addedBars`.
   */
  newBars: number;
  /**
   * Net rows added after dedup against the existing file. Zero means the run
   * changed nothing, which `newBars` alone would hide: a re-fetch of an
   * already-cached window returns a full set of bars and adds none of them.
   */
  addedBars?: number;
  totalBars: number;
  fromDate?: string;
  toDate?: string;
  /** ISO timestamp of the last bar in the file after the run. */
  lastBarUtc?: string;
}

/**
 * Machine-readable run summary, written when `--summary <path>` is passed.
 * A nightly CI job reads this to build its Discord message — a run
 * that fetched nothing is the failure worth reporting, and that is only
 * visible by comparing `lastBarUtc` against today.
 */
export interface RunSummary {
  ok: boolean;
  dryRun: boolean;
  symbols: SymbolResult[];
  succeeded: number;
  skipped: number;
  failed: number;
  fetchedSymbolDays: number;
  estimatedCostUsd: number;
  /** Oldest `lastBarUtc` across symbols — the true edge of usable coverage. */
  coverageEndUtc: string | null;
}

interface DatabentoOhlcvRecord {
  hd: { ts_event: string };
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// --- pure helpers (exported for tests) ---------------------------------------

export function parseArgs(argv: string[]): BackfillArgs {
  const opts: Partial<BackfillArgs> = {
    confirm: false,
    dryRun: false,
    force: false,
    append: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--symbols") {
      const v = argv[++i];
      if (!v) throw new Error("--symbols requires a value");
      opts.symbols = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--from") {
      const v = argv[++i];
      if (!v) throw new Error("--from requires a value");
      opts.fromDate = v;
    } else if (a === "--to") {
      const v = argv[++i];
      if (!v) throw new Error("--to requires a value");
      opts.toDate = v;
    } else if (a === "--confirm") {
      opts.confirm = true;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--append") {
      opts.append = true;
    } else if (a === "--summary") {
      const v = argv[++i];
      if (!v) throw new Error("--summary requires a path");
      opts.summaryPath = v;
    } else if (a === "--message") {
      const v = argv[++i];
      if (!v) throw new Error("--message requires a path");
      opts.messagePath = v;
    } else if (a === "--max-age-days") {
      const v = argv[++i];
      if (!v) throw new Error("--max-age-days requires a number");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--max-age-days must be a non-negative number, got: ${v}`);
      opts.maxAgeDays = n;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.symbols || opts.symbols.length === 0) {
    throw new Error("--symbols is required (comma-separated)");
  }
  if (!opts.fromDate) throw new Error("--from YYYY-MM-DD is required");
  if (!opts.toDate) throw new Error("--to YYYY-MM-DD is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.fromDate)) {
    throw new Error(`--from must be YYYY-MM-DD, got: ${opts.fromDate}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.toDate)) {
    throw new Error(`--to must be YYYY-MM-DD, got: ${opts.toDate}`);
  }
  const fromYear = parseInt(opts.fromDate.slice(0, 4), 10);
  const toYear = parseInt(opts.toDate.slice(0, 4), 10);
  if (toYear < fromYear) {
    throw new Error(`--to (${opts.toDate}) is before --from (${opts.fromDate})`);
  }
  return {
    symbols: opts.symbols,
    fromYear,
    toYear,
    fromDate: opts.fromDate,
    toDate: opts.toDate,
    confirm: opts.confirm ?? false,
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    append: opts.append ?? false,
    summaryPath: opts.summaryPath ?? null,
    messagePath: opts.messagePath ?? null,
    maxAgeDays: opts.maxAgeDays ?? null,
  };
}

/** Whole days between `coverageEndUtc` and `now`. Null when coverage is unknown. */
export function coverageAgeDays(coverageEnd: string | null, nowMs: number): number | null {
  if (!coverageEnd) return null;
  const end = Date.parse(coverageEnd);
  if (Number.isNaN(end)) return null;
  return Math.floor((nowMs - end) / 86_400_000);
}

/**
 * Discord message for a run. Built here rather than in the CI pipeline so it
 * is unit-testable and needs no JSON parsing on the CI host — the pipeline
 * just reads the file.
 *
 * The coverage line is the one that earns its place: a run that fetched
 * nothing is indistinguishable from a healthy no-op unless coverage is stated
 * every time, and an expired key, a stale mount and a publishing lag all look
 * exactly like a zero-bar run.
 */
export function formatDiscordMessage(summary: RunSummary, ageDays: number | null): string {
  const lines: string[] = [];
  for (const s of summary.symbols) {
    let detail: string;
    if (summary.dryRun) {
      // Past tense on a dry run is a lie — say what it *would* do.
      detail = s.fromDate && s.toDate ? `would fetch ${s.fromDate} → ${s.toDate}` : `nothing to fetch`;
    } else if (s.status === "ok" && (s.addedBars ?? s.newBars) > 0) {
      const added = s.addedBars ?? s.newBars;
      detail = `+${added.toLocaleString()} bars → ${s.totalBars.toLocaleString()} total`;
    } else if (s.status === "ok" && s.addedBars === 0) {
      // Say it plainly. A re-fetch that adds nothing is normal when the cache
      // is already current, but it must not be reported as though it grew.
      detail = `no new bars (${s.newBars.toLocaleString()} fetched, all already cached) → ${s.totalBars.toLocaleString()} total`;
    } else {
      detail = `${s.status}${s.reason ? ` (${s.reason})` : ""}`;
    }
    lines.push(`\`${s.symbol}\` ${detail}`);
  }
  lines.push("");

  // Coverage only when it says something. A nightly run is legitimately a day
  // behind because of the 24h embargo, so printing that every night is noise
  // that trains you to skip the line — which defeats its purpose. Silent when
  // normal, loud when not. The per-symbol lines above already carry the dates.
  if (summary.coverageEndUtc === null) {
    lines.push(`:warning: **Coverage unknown** — no symbol reported a last bar`);
  } else if (ageDays !== null && ageDays > 1) {
    lines.push(`:warning: **Coverage only through ${summary.coverageEndUtc}** (${ageDays}d old)`);
  }

  lines.push(`Estimated cost: $${summary.estimatedCostUsd.toFixed(2)}`);
  if (summary.dryRun) lines.push("_dry run — nothing was fetched and nothing was written_");
  return lines.join("\n");
}

export function priceFromFixed(raw: string): number {
  return parseInt(raw, 10) / PRICE_SCALE;
}

export function parseNdjsonToBars(body: string, symbol: string): Bar[] {
  const out: Bar[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rec = JSON.parse(trimmed) as DatabentoOhlcvRecord;
    out.push({
      tsUtc: BigInt(rec.hd.ts_event),
      open: priceFromFixed(rec.open),
      high: priceFromFixed(rec.high),
      low: priceFromFixed(rec.low),
      close: priceFromFixed(rec.close),
      volume: BigInt(rec.volume),
      symbol,
    });
  }
  return out;
}

/**
 * Pull `available_end` out of a Databento 422 body. They return
 * `{"detail":{"case":"dataset_unavailable_range","payload":{"available_end":…}}}`
 * when a request reaches past the embargo, which is the exact end timestamp
 * to retry with. Returns null for any other error shape.
 */
export function parseAvailableEnd(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { case?: string; payload?: { available_end?: string } };
    };
    if (parsed.detail?.case !== "dataset_unavailable_range") return null;
    return parsed.detail.payload?.available_end ?? null;
  } catch {
    return null;
  }
}

/** ISO timestamp of the newest bar in `bars`, or undefined when empty. */
export function lastBarIso(bars: Bar[]): string | undefined {
  if (bars.length === 0) return undefined;
  const maxNs = bars.reduce((m, b) => (b.tsUtc > m ? b.tsUtc : m), bars[0].tsUtc);
  return new Date(Number(maxNs / BigInt(1_000_000))).toISOString();
}

/**
 * Oldest of each symbol's newest `lastBarUtc` — the true edge of usable
 * coverage, because a chain is only as current as its most stale symbol.
 * Newest per symbol first: a multi-year backfill reports one result per year
 * file, and a closed year's last bar (Dec 31) is not staleness. Null when
 * nothing reported a last bar.
 */
export function coverageEndUtc(results: SymbolResult[]): string | null {
  const newest = new Map<string, string>();
  for (const r of results) {
    if (!r.lastBarUtc) continue;
    const seen = newest.get(r.symbol);
    if (!seen || r.lastBarUtc > seen) newest.set(r.symbol, r.lastBarUtc);
  }
  if (newest.size === 0) return null;
  return [...newest.values()].reduce((oldest, s) => (s < oldest ? s : oldest));
}

/** Inclusive day count between two ISO `YYYY-MM-DD` dates. Never negative. */
export function daysInclusive(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

/**
 * Estimated cost in USD for `symbolCount` symbols over `dayCount` days of
 * OHLCV-1m. Prorated by day, not rounded up to whole calendar years — a
 * three-month append must not be priced as a full year.
 */
export function estimateCostUsd(symbolCount: number, dayCount: number): number {
  const contractYears = (symbolCount * dayCount) / DAYS_PER_YEAR;
  const totalMb = contractYears * MB_PER_CONTRACT_YEAR;
  return (totalMb / 1024) * USD_PER_GB;
}

export function yearWindowUtc(year: number, fromDate: string, toDate: string): {
  start: string;
  end: string;
} {
  // Clip the requested window to this year. start/end are ISO UTC strings
  // accepted by Databento's `start`/`end` query params.
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const start = fromDate > yearStart ? fromDate : yearStart;
  const end = toDate < yearEnd ? toDate : yearEnd;
  return {
    start: `${start}T00:00:00`,
    end: `${end}T23:59:59`,
  };
}

export interface SkipDecision {
  skip: boolean;
  reason?: string;
}

export function shouldSkipYear(
  filePath: string,
  year: number,
  currentYear: number,
  force: boolean,
  append: boolean,
  fileExists: (p: string) => boolean,
): SkipDecision {
  if (force) return { skip: false };
  if (!fileExists(filePath)) return { skip: false };
  // In append mode we always revisit existing files to check for tail gaps.
  if (append) return { skip: false, reason: "append-mode tail check" };
  if (year >= currentYear) {
    return { skip: false, reason: "current-year refetch" };
  }
  return { skip: true, reason: "file already cached" };
}

/**
 * Union of what is already on disk with what was just fetched, deduped by
 * timestamp and sorted.
 *
 * **The union is what stops a narrow `--from`/`--to` from eating the rest of
 * the year.** The caller reads the existing file on every path, so a
 * partial-range fetch adds to the year rather than replacing it. Before
 * 2026-09-10 the file was read only under `--append`, which made this a no-op
 * everywhere else and cost 57,216 NQ and 57,437 MNQ bars — silently, because
 * the run still printed a healthy total and exited 0.
 *
 * **Existing bars win a timestamp collision.** They come first and the filter
 * keeps first-seen, so every run is additive. The cost is that a re-fetch
 * cannot *correct* a bar already on disk: to repair a bad year, delete the
 * file and fetch it again. Do not flip this to "fetched wins" without deciding
 * that trade deliberately — it would let a nightly run rewrite history that
 * has already been backtested against.
 */
export function mergeBars(existing: readonly Bar[], fetched: readonly Bar[]): Bar[] {
  const seen = new Set<bigint>();
  const deduped = [...existing, ...fetched].filter((b) => {
    if (seen.has(b.tsUtc)) return false;
    seen.add(b.tsUtc);
    return true;
  });
  deduped.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
  return deduped;
}

// --- runtime helpers ---------------------------------------------------------

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function fetchSymbolYear(
  apiKey: string,
  symbol: string,
  year: number,
  fromDate: string,
  toDate: string,
): Promise<Bar[]> {
  const { start, end } = yearWindowUtc(year, fromDate, toDate);
  const params = new URLSearchParams({
    dataset: DATABENTO_DATASET,
    symbols: symbol,
    schema: DATABENTO_SCHEMA,
    stype_in: "continuous",
    encoding: "json",
    start,
    end,
  });
  // Retry transient upstream failures. Observed a 504 mid-run on an otherwise
  // healthy fetch; without this an unattended nightly job goes red — and trips
  // the staleness gate — over a blip that a second attempt clears. Mirrors the
  // Topstep client's approach for the same class of error.
  const TRANSIENT_DELAYS_MS = [2_000, 5_000, 15_000];
  const isTransient = (status: number) => status === 429 || status >= 500;

  const get = async (endOverride?: string) => {
    if (endOverride) params.set("end", endOverride);
    const url = `${DATABENTO_HOST}/v0/timeseries.get_range?${params.toString()}`;
    let last: Response | null = null;
    for (let attempt = 0; attempt <= TRANSIENT_DELAYS_MS.length; attempt++) {
      last = await fetch(url, { headers: { Authorization: basicAuthHeader(apiKey) } });
      if (last.ok || !isTransient(last.status)) return last;
      if (attempt === TRANSIENT_DELAYS_MS.length) break;
      const delay = TRANSIENT_DELAYS_MS[attempt];
      console.log(
        `[backfill-databento] ${symbol} ${year} transient ${last.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${TRANSIENT_DELAYS_MS.length})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    return last as Response;
  };

  let res = await get();

  if (!res.ok) {
    const body = await res.text();

    // Databento embargoes recent data and tells us exactly where the boundary
    // is. Asking for a whole-day end (…T23:59:59Z) collides with it routinely,
    // because availability stops partway through the day rather than at
    // midnight. Rather than guessing an offset that would drift whenever their
    // policy changes, take the boundary from the error and retry once.
    const availableEnd = parseAvailableEnd(body);
    if (res.status === 422 && availableEnd) {
      console.log(
        `[backfill-databento] ${symbol} ${year} end clamped to Databento's available_end ${availableEnd} (embargo)`,
      );
      res = await get(availableEnd);
      if (!res.ok) {
        const retryBody = await res.text();
        throw new Error(
          `databento ${res.status} ${res.statusText} for ${symbol} ${year} after clamping to ${availableEnd}: ${retryBody.slice(0, 500)}`,
        );
      }
    } else {
      throw new Error(
        `databento ${res.status} ${res.statusText} for ${symbol} ${year}: ${body.slice(0, 500)}`,
      );
    }
  }
  const text = await res.text();
  const bars = parseNdjsonToBars(text, symbol);
  bars.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
  return bars;
}

async function writeYearFile(
  cacheDir: string,
  symbol: string,
  year: number,
  bars: Bar[],
): Promise<{ path: string; bytes: number }> {
  const dir = path.join(cacheDir, SCHEMA_DIR, symbol);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${year}.parquet`);
  const out = await writeBarsToParquet(bars);
  writeFileSync(file, Buffer.from(out));
  return { path: file, bytes: statSync(file).size };
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  dotenv.config({ path: ".env.local" });

  const args = parseArgs(process.argv.slice(2));

  const cacheDirRaw = process.env.BAR_CACHE_DIR ?? DEFAULT_CACHE_DIR;
  const cacheDir = path.isAbsolute(cacheDirRaw)
    ? cacheDirRaw
    : path.resolve(process.cwd(), cacheDirRaw);

  const yearCount = args.toYear - args.fromYear + 1;
  const requestedDays = daysInclusive(args.fromDate, args.toDate);
  // Upper bound: the full requested span. In append mode the per-symbol tail
  // is usually far smaller, so the gate is deliberately conservative and the
  // accurate figure is reported at the end from the ranges actually fetched.
  const estCost = estimateCostUsd(args.symbols.length, requestedDays);

  console.log(`[backfill-databento] cache dir: ${cacheDir}`);
  console.log(
    `[backfill-databento] symbols: ${args.symbols.join(", ")} | range: ${args.fromDate} → ${args.toDate} (${requestedDays} days across ${yearCount} year${yearCount === 1 ? "" : "s"})`,
  );
  console.log(
    `[backfill-databento] estimated cost: $${estCost.toFixed(2)} USD max for the full span (~${MB_PER_CONTRACT_YEAR} MB/contract/year @ $${USD_PER_GB}/GB)`,
  );

  if (estCost > CONFIRM_THRESHOLD_USD && !args.confirm && !args.dryRun) {
    console.error(
      `[backfill-databento] estimated cost $${estCost.toFixed(2)} exceeds $${CONFIRM_THRESHOLD_USD} threshold; pass --confirm to proceed`,
    );
    process.exit(2);
  }

  // Accumulated across the ranges actually fetched, which in append mode is
  // the tail gap rather than the requested span. This is the number worth
  // comparing against the Databento billing page.
  let fetchedDays = 0;
  const results: SymbolResult[] = [];

  const apiKey = process.env.DATABENTO_API_KEY;
  if (!args.dryRun && !apiKey) {
    console.error("[backfill-databento] DATABENTO_API_KEY missing in env (.env.local). Use --dry-run to inspect plan.");
    process.exit(2);
  }

  const currentYear = new Date().getUTCFullYear();
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const symbol of args.symbols) {
    for (let year = args.fromYear; year <= args.toYear; year++) {
      const filePath = path.join(cacheDir, SCHEMA_DIR, symbol, `${year}.parquet`);
      const decision = shouldSkipYear(filePath, year, currentYear, args.force, args.append, existsSync);
      if (decision.skip) {
        console.log(`[backfill-databento] SKIP ${symbol} ${year} (${decision.reason})`);
        results.push({ symbol, year, status: "skipped", reason: decision.reason, newBars: 0, totalBars: 0 });
        skipped++;
        continue;
      }

      // In append mode cap toDate to yesterday — Databento's available window
      // typically ends at market close of the prior business day, so "today"
      // still triggers a 422. Yesterday is the safe ceiling.
      const yesterdayDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const effectiveToDate = args.append
        ? args.toDate < yesterdayDate ? args.toDate : yesterdayDate
        : args.toDate;

      // Read the existing year file whenever one is there — on **every** path,
      // not only under `--append`. The merge further down unions `existingBars`
      // with what was fetched, so leaving this empty makes that merge a no-op
      // and the year file is replaced by whatever window the run asked for.
      // A partial-range fetch then destroys every bar in that year outside the
      // range, silently: the OK line still prints a healthy total and the run
      // exits 0. On 2026-09-10 that cost 57,216 NQ bars and 57,437 MNQ bars.
      let existingBars: Bar[] = [];
      let effectiveFromDate = args.fromDate;
      if (existsSync(filePath)) {
        try {
          existingBars = await readParquetToBars(readFileSync(filePath));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[backfill-databento] WARN could not read existing file (${msg}); treating it as empty, so this run REPLACES ${filePath}`,
          );
          existingBars = [];
        }
      }

      // `--append` additionally narrows the fetch to the tail gap. That is the
      // only thing append does that the other modes do not; reading the file is
      // now common to all of them.
      if (args.append && existingBars.length > 0) {
        // maxTsUtc is nanoseconds; convert to ms, then advance 1 minute
        // to skip the last bar's bucket and fetch from the next minute.
        const maxNs = existingBars.reduce(
          (m, b) => (b.tsUtc > m ? b.tsUtc : m),
          existingBars[0].tsUtc,
        );
        const maxMs = Number(maxNs / BigInt(1_000_000));
        const nextMinuteMs = maxMs + 60_000;
        const nextDay = new Date(nextMinuteMs).toISOString().slice(0, 10);
        if (nextDay > effectiveToDate) {
          console.log(
            `[backfill-databento] SKIP ${symbol} ${year} (append: already up to ${new Date(maxMs).toISOString()})`,
          );
          results.push({
            symbol,
            year,
            status: "skipped",
            reason: "already current",
            newBars: 0,
            totalBars: existingBars.length,
            lastBarUtc: new Date(maxMs).toISOString(),
          });
          skipped++;
          continue;
        }
        effectiveFromDate = nextDay;
        console.log(
          `[backfill-databento] APPEND ${symbol} ${year} existing=${existingBars.length} bars, tail-from=${effectiveFromDate} to=${effectiveToDate}`,
        );
      }

      // Clamp to this year's slice before counting. The loop runs once per
      // year, so measuring the whole requested span here would count every
      // year's days once per year — a 7-year backfill reported 7x its real
      // size until this was fixed.
      const planned = yearWindowUtc(year, effectiveFromDate, effectiveToDate);
      const plannedDays = daysInclusive(planned.start.slice(0, 10), planned.end.slice(0, 10));

      if (args.dryRun) {
        fetchedDays += plannedDays;
        const { start, end } = yearWindowUtc(year, effectiveFromDate, effectiveToDate);
        console.log(
          `[backfill-databento] DRY ${symbol} ${year} window=${start}..${end} → would write ${filePath}`,
        );
        results.push({
          symbol,
          year,
          status: "ok",
          reason: "dry run — nothing fetched",
          newBars: 0,
          totalBars: existingBars.length,
          fromDate: effectiveFromDate,
          toDate: effectiveToDate,
          lastBarUtc: lastBarIso(existingBars),
        });
        succeeded++;
        continue;
      }

      try {
        console.log(`[backfill-databento] FETCH ${symbol} ${year} from=${effectiveFromDate} to=${effectiveToDate} ...`);
        const newBars = await fetchSymbolYear(apiKey as string, symbol, year, effectiveFromDate, effectiveToDate);
        // Counted only after the call returns — a failed fetch transfers
        // nothing and must not appear in the cost estimate.
        fetchedDays += plannedDays;
        if (newBars.length === 0 && existingBars.length === 0) {
          console.log(`[backfill-databento] WARN ${symbol} ${year} returned 0 bars — skipping write`);
          skipped++;
          continue;
        }
        if (newBars.length === 0) {
          console.log(`[backfill-databento] SKIP ${symbol} ${year} (append: 0 new bars, cache already current)`);
          results.push({
            symbol,
            year,
            status: "skipped",
            reason: "0 new bars",
            newBars: 0,
            totalBars: existingBars.length,
            lastBarUtc: lastBarIso(existingBars),
          });
          skipped++;
          continue;
        }

        const deduped = mergeBars(existingBars, newBars);
        const addedBars = deduped.length - existingBars.length;
        const { path: writtenPath, bytes } = await writeYearFile(cacheDir, symbol, year, deduped);
        console.log(
          `[backfill-databento] OK ${symbol} ${year} added=${addedBars} fetched=${newBars.length} total=${deduped.length} bytes=${bytes} → ${writtenPath}`,
        );
        results.push({
          symbol,
          year,
          status: "ok",
          newBars: newBars.length,
          addedBars,
          totalBars: deduped.length,
          fromDate: effectiveFromDate,
          toDate: effectiveToDate,
          lastBarUtc: lastBarIso(deduped),
        });
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill-databento] FAIL ${symbol} ${year}: ${msg}`);
        results.push({
          symbol,
          year,
          status: "failed",
          reason: msg,
          newBars: 0,
          totalBars: existingBars.length,
          fromDate: effectiveFromDate,
          toDate: effectiveToDate,
          // Report what the cache already holds. A failed fetch does not make
          // coverage unknown — it makes it stale, and "stale since X" is far
          // more actionable than "unknown".
          lastBarUtc: lastBarIso(existingBars),
        });
        failed++;
      }
    }
  }

  // `fetchedDays` is already summed across symbol-years, so pass 1 symbol.
  const actualCost = estimateCostUsd(1, fetchedDays);
  console.log(
    `[backfill-databento] done — succeeded=${succeeded} skipped=${skipped} failed=${failed} | fetched ${fetchedDays} symbol-days ≈ $${actualCost.toFixed(2)}`,
  );

  const summary: RunSummary = {
    ok: failed === 0,
    dryRun: args.dryRun,
    symbols: results,
    succeeded,
    skipped,
    failed,
    fetchedSymbolDays: fetchedDays,
    estimatedCostUsd: Number(actualCost.toFixed(4)),
    coverageEndUtc: coverageEndUtc(results),
  };
  const ageDays = coverageAgeDays(summary.coverageEndUtc, Date.now());

  if (args.summaryPath) {
    writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[backfill-databento] summary → ${args.summaryPath}`);
  }
  if (args.messagePath) {
    writeFileSync(args.messagePath, formatDiscordMessage(summary, ageDays));
    console.log(`[backfill-databento] message → ${args.messagePath}`);
  }

  if (failed > 0) process.exit(1);

  // Staleness check last, so the summary and message are always written first
  // — a failing run still reports what it saw.
  if (args.maxAgeDays !== null) {
    if (ageDays === null) {
      console.error(
        `[backfill-databento] FATAL no coverage reported — every symbol failed, or the cache is empty/unmounted`,
      );
      process.exit(1);
    }
    if (ageDays > args.maxAgeDays) {
      console.error(
        `[backfill-databento] FATAL coverage is ${ageDays}d old (max ${args.maxAgeDays}d) — last bar ${summary.coverageEndUtc}. The refresh is not working.`,
      );
      process.exit(1);
    }
    console.log(`[backfill-databento] freshness OK — coverage ${ageDays}d old (max ${args.maxAgeDays}d)`);
  }
}

// Only run main when executed directly (not when imported by tests).
const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    console.error("[backfill-databento] fatal:", err);
    process.exit(1);
  });
}
