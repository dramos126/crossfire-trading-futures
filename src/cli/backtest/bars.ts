/**
 * Bars for the CLI: the Parquet cache, and the Topstep tail only when asked.
 *
 * By default no `ChainedBarSource`, no tail, no session filter. A calibration
 * run has to be reproducible from the archive alone, and splicing a live
 * vendor onto the tail would make the same command answer differently on
 * two machines. Coverage that does not reach the requested range is a
 * refusal, never a short run — the failure this exists to prevent is a
 * playbook that looks admissible because two of its years were missing.
 *
 * `--topstep-tail` (and `parity-day`) relax exactly one half of that: the
 * archive must still reach back to the start of the warmup, and anything past
 * its end comes from Topstep through `chainCacheWithTopstepTail`. The range
 * the tail served is returned as `barTail` and stamped on the run header, so
 * the file says where its last bars came from.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { ParquetCacheBarSource } from "@/lib/data/bar-cache";
import type { Bar, BarSource } from "@/lib/data/bar-source";
import { aggregateBars } from "@/lib/data/aggregator";
import { barToBarData } from "@/lib/data/bar-source-adapter";
import type { BarData } from "@/lib/brokers/types";
import { straddleSubBars, type StraddleLeg } from "@/lib/trading/backtest";
import type { ContractSpec, DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import { contractMonthKey } from "@/lib/trading/broker-access/contract-pairing";
import { pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";
import { buildSessionDays, type SessionDay } from "@/lib/trading/regime/session-days";
import {
  etParts,
  sessionEndUtc,
  sessionStartUtc,
  shiftSessionDatesBack,
} from "@/lib/trading/regime/session-dates";
import { CliError, DayRefusal } from "./cli-error";
import { CLASSIFIER_WARMUP_SESSION_DAYS, type CliArgs, type CliTimeframe } from "./args";
import { PERTURB_WARMUP_SESSION_DAYS } from "./perturbations";

const SCHEMA_DIR = "ohlcv-1m";
const DEFAULT_CACHE_DIR = "./data/bar-cache";
const NS_PER_MS = BigInt(1_000_000);

const TIMEFRAME_MINUTES: Readonly<Record<CliTimeframe, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
};

export interface CacheFileRef {
  path: string;
  mtime: string;
}

export interface LoadedBars {
  bars: BarData[];
  /** `runBacktest`'s `subBars`: the 1m bars inside the bars `straddleLegs`
   *  flatten inside (`straddleSubBars`), not the whole 1m series, so a
   *  worker's init message stays small. Absent when there are none — a 1m or
   *  5m series against a shipped window — or no legs were named. */
  subBars?: BarData[];
  /** Completed session-day rows over the same span, built from the **1m**
   *  series before it is aggregated away — the classifier's only input, and
   *  the reason this is returned here rather than derived from `bars`. */
  sessionDays: SessionDay[];
  cacheFiles: CacheFileRef[];
  coverage: { minUtc: string | null; maxUtc: string | null };
  /** Null on a cache-only run. */
  barTail: BarTailRecord | null;
}

/** What a run needs to splice the Topstep tail: the contract, and the
 *  composition from `cached-bars.ts` (injected so this module does not load
 *  the broker graph on a cache-only run). */
export interface BarTailInput {
  contractId: string;
  chain: (cache: BarSource, contractId: string) => BarSource;
}

/**
 * Where the bars past the archive came from. `fromUtc` / `toUtc` /
 * `barCount` describe the 1m bars the tail actually contributed — null and 0
 * when the archive already covered the range, which is still a tailed run
 * and says so.
 */
export interface BarTailRecord {
  source: "topstep";
  contractId: string;
  cacheMaxUtc: string;
  fromUtc: string | null;
  toUtc: string | null;
  barCount: number;
  seam: BarSeam;
}

/**
 * Where the archive hands over to the tail. The tail reads Topstep's active
 * contract; a `.c.0` archive follows the calendar front month and a `.v.0`
 * archive the volume roll, so across a roll the two sides of the seam can be
 * different instruments and the run is priced on a jump. Since the index
 * micros moved to `.v.0` (2026-10-25, A61) `cacheMonth` is null for every
 * deployable ticker and `gapTicks` alone carries the seam check; the minis a
 * `--bar-symbol` run may read are still `.c.0` and still name their month.
 */
export interface BarSeam {
  /** The archive's contract at its last bar, as `Z2026`; null when the
   *  continuous symbol is not calendar-rolled (`.v.0`) and so cannot be told. */
  cacheMonth: string | null;
  /** The tail's contract, as `Z2026`; null when the id does not parse. */
  tailMonth: string | null;
  /** First tail bar's open against the last archive bar's close, in ticks,
   *  unsigned. Null when either side served no bar. */
  gapTicks: number | null;
}

export interface LoadCacheBarsArgs {
  cacheSymbol: string;
  timeframe: CliTimeframe;
  fromUtc: Date;
  toUtc: Date;
  /** The instrument's day-session window and tick size, for the session-day
   *  rows. Features never mix overnight and day-session bars. */
  daySession: DaySessionWindow;
  tickSize: number;
  cacheDir?: string;
  tail?: BarTailInput | null;
  /** The playbooks that will read `bars`, for `subBars`; absent keeps none. */
  straddleLegs?: readonly StraddleLeg[];
  /** Seam for tests; the CLI always reads the Parquet cache. */
  cache?: BarSource;
}

export async function loadCacheBars(args: LoadCacheBarsArgs): Promise<LoadedBars> {
  const { cacheSymbol, timeframe, fromUtc, toUtc } = args;
  const tail = args.tail ?? null;
  const cacheDir = resolveCacheDir(args.cacheDir);
  const cache = args.cache ?? new ParquetCacheBarSource({ cacheDir });

  const coverage = await cache.coverage(cacheSymbol);
  if (coverage.minUtc == null || coverage.maxUtc == null) {
    throw new CliError(
      `No cached bars for ${cacheSymbol} under ${path.join(cacheDir, SCHEMA_DIR)}. ` +
        `Check BAR_CACHE_DIR and the Databento backfill.`,
    );
  }
  // With the tail, the archive's end is not a bound — the tail is what serves
  // past it. Its start still is: Topstep holds about three months, so a
  // warmup the archive cannot reach is a short run whatever the tail does.
  if (coverage.minUtc > fromUtc || (tail == null && coverage.maxUtc < toUtc)) {
    throw new CliError(
      `${cacheSymbol} cache covers ${coverage.minUtc.toISOString()} to ` +
        `${coverage.maxUtc.toISOString()}; the run needs ${fromUtc.toISOString()} to ` +
        `${toUtc.toISOString()} (warmup included). Refusing a short run.`,
    );
  }

  const source = tail == null ? cache : tail.chain(cache, tail.contractId);
  const oneMinute = await readBars(source, cacheSymbol, fromUtc, toUtc, tail != null);
  if (oneMinute.length === 0) {
    throw new CliError(
      `${cacheSymbol} has coverage but returned no bars between ` +
        `${fromUtc.toISOString()} and ${toUtc.toISOString()}.`,
    );
  }

  const oneMinuteBars = oneMinute.map(barToBarData);
  const bars = aggregateBars(oneMinute, TIMEFRAME_MINUTES[timeframe]).map(barToBarData);
  const subBars =
    timeframe === "1m" || args.straddleLegs == null
      ? undefined
      : straddleSubBars(bars, oneMinuteBars, args.straddleLegs);
  return {
    bars,
    ...(subBars == null ? {} : { subBars }),
    sessionDays: buildSessionDays({
      bars: oneMinuteBars,
      daySession: args.daySession,
      tickSize: args.tickSize,
    }),
    cacheFiles: await listCacheFiles(cacheDir, cacheSymbol, fromUtc, toUtc),
    coverage: {
      minUtc: coverage.minUtc.toISOString(),
      maxUtc: coverage.maxUtc.toISOString(),
    },
    barTail:
      tail == null
        ? null
        : tailRecord(oneMinute, coverage.maxUtc, tail.contractId, {
            cacheSymbol,
            tickSize: args.tickSize,
          }),
  };
}

async function readBars(
  source: BarSource,
  symbol: string,
  fromUtc: Date,
  toUtc: Date,
  tailed: boolean,
): Promise<Bar[]> {
  if (!tailed) return source.getBars(symbol, fromUtc, toUtc);
  try {
    return await source.getBars(symbol, fromUtc, toUtc);
  } catch (err) {
    // A day refusal: the source every leg reads is what failed, not the leg.
    throw new DayRefusal(
      `Reading ${symbol} with the Topstep tail failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The 1m bars strictly past the archive's last bar are the tail's. */
export function tailRecord(
  oneMinute: readonly Bar[],
  cacheMaxUtc: Date,
  contractId: string,
  instrument: { cacheSymbol: string; tickSize: number },
): BarTailRecord {
  const cacheMaxNs = BigInt(cacheMaxUtc.getTime()) * NS_PER_MS;
  const served = oneMinute.filter((bar) => bar.tsUtc > cacheMaxNs);
  const archived = oneMinute.filter((bar) => bar.tsUtc <= cacheMaxNs);
  const lastArchived = archived.at(-1);
  const isoOf = (bar: Bar) => new Date(Number(bar.tsUtc / NS_PER_MS)).toISOString();
  return {
    source: "topstep",
    contractId,
    cacheMaxUtc: cacheMaxUtc.toISOString(),
    fromUtc: served.length > 0 ? isoOf(served[0]) : null,
    toUtc: served.length > 0 ? isoOf(served[served.length - 1]) : null,
    barCount: served.length,
    seam: {
      cacheMonth: calendarFrontMonth(instrument.cacheSymbol, cacheMaxUtc),
      tailMonth: contractMonthKey(contractId),
      gapTicks:
        lastArchived == null || served.length === 0
          ? null
          : Math.abs(
              pnlTicksFromPrices(lastArchived.close, served[0].open, 1, instrument.tickSize),
            ),
    },
  };
}

const CALENDAR_ROLLED_SUFFIX = ".c.0";
/** The equity-index cycle — the only `.c.0` series left in the cache are the
 *  minis (providers.md: every deployable micro is `.v.0` since 2026-10-25). */
const QUARTERLY_MONTHS: ReadonlyArray<[number, string]> = [
  [3, "H"],
  [6, "M"],
  [9, "U"],
  [12, "Z"],
];
const FRIDAY = 5;
const DAYS_TO_THIRD = 14;

/**
 * The contract a calendar-rolled continuous series holds at `at`: the first
 * quarterly month whose third-Friday expiry is on or after `at`'s ET date, as
 * `Z2026`. Null for a series that is not calendar-rolled — a volume roll
 * cannot be told from the date.
 */
export function calendarFrontMonth(cacheSymbol: string, at: Date): string | null {
  if (!cacheSymbol.endsWith(CALENDAR_ROLLED_SUFFIX)) return null;
  const et = etParts(at);
  for (let year = et.year; ; year++) {
    for (const [month, code] of QUARTERLY_MONTHS) {
      if (year === et.year && month < et.month) continue;
      const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const thirdFriday = 1 + ((FRIDAY - firstWeekday + 7) % 7) + DAYS_TO_THIRD;
      if (year === et.year && month === et.month && et.day > thirdFriday) continue;
      return `${code}${year}`;
    }
  }
}

/** Extra weekdays asked for on the retry, above the shortfall itself: the
 *  extension is walked back in weekdays too, so it carries its own holidays. */
const WARMUP_RETRY_CUSHION_SESSION_DAYS = 10;

export interface RunBars {
  loaded: LoadedBars;
  /** The session date the fetch actually reached back to, extension
   *  included — so the header describes the bars the run was handed. */
  warmupFrom: string;
}

export interface LoadRunBarsArgs {
  args: Pick<CliArgs, "timeframe" | "from" | "to" | "warmupDays" | "usesClassifier" | "perturb">;
  spec: ContractSpec;
  /** `--bar-symbol` override — reads this cache symbol's bars in place of
   *  `spec.cacheSymbol`. Undefined/null is the default: `spec.cacheSymbol`
   *  resolves exactly as before this existed. */
  barSymbol?: string | null;
  cacheDir?: string;
  /** `--topstep-tail`; null or absent is cache-only. */
  tail?: BarTailInput | null;
  /** See `LoadCacheBarsArgs.straddleLegs`. */
  straddleLegs?: readonly StraddleLeg[];
  /** Seam for tests; the CLI always reads the cache. */
  load?: (fromUtc: Date, toUtc: Date) => Promise<LoadedBars>;
}

/**
 * The cache symbol a run reads bars from: `--bar-symbol` when given, else
 * the ticker's own mapping. Isolated in its own function so the substitution
 * can never leak into `spec` itself — tick value, fees, the day session and
 * `calibratedFor` all keep reading `spec` untouched.
 */
export function resolveCacheSymbol(spec: ContractSpec, barSymbol?: string | null): string {
  return barSymbol ?? spec.cacheSymbol;
}

/**
 * The run's bars, with the classifier's warmup enforced as a **row**
 * requirement rather than a weekday one.
 *
 * `shiftSessionDatesBack` skips weekends but not holidays, so walking back
 * 275 weekdays reaches back fewer than 275 completed session days and the
 * first sessions of the range come back `unknown` — a warmup shortfall
 * wearing a classifier's answer. Count the rows the fetch actually produced
 * before `--from`, extend once by the shortfall, and refuse with both counts
 * if the archive cannot cover it.
 */
export async function loadRunBars(input: LoadRunBarsArgs): Promise<RunBars> {
  const { args, spec } = input;
  const load =
    input.load ??
    ((fromUtc: Date, toUtc: Date) =>
      loadCacheBars({
        cacheSymbol: resolveCacheSymbol(spec, input.barSymbol),
        timeframe: args.timeframe,
        fromUtc,
        toUtc,
        daySession: spec.daySession,
        tickSize: spec.tickSize,
        cacheDir: input.cacheDir,
        tail: input.tail,
        straddleLegs: input.straddleLegs,
      }));

  const toUtc = sessionEndUtc(args.to);
  const requiredRows = classifierWarmupRows(args);

  const warmupFrom = shiftSessionDatesBack(args.from, args.warmupDays);
  const first = await load(sessionStartUtc(warmupFrom), toUtc);
  if (requiredRows === 0) return { loaded: first, warmupFrom };

  const firstRows = completedRowsBefore(first.sessionDays, args.from);
  if (firstRows >= requiredRows) return { loaded: first, warmupFrom };

  const extendedFrom = shiftSessionDatesBack(
    warmupFrom,
    requiredRows - firstRows + WARMUP_RETRY_CUSHION_SESSION_DAYS,
  );
  const extended = await load(sessionStartUtc(extendedFrom), toUtc);
  const extendedRows = completedRowsBefore(extended.sessionDays, args.from);
  if (extendedRows >= requiredRows) return { loaded: extended, warmupFrom: extendedFrom };

  throw new CliError(
    // The symbol actually read, not the ticker's own — under `--bar-symbol`
    // the coverage that came up short is the substituted archive's, and
    // naming `spec.cacheSymbol` sends the reader to the wrong directory.
    `${resolveCacheSymbol(spec, input.barSymbol)}: the classifier needs ${requiredRows} completed session days before ` +
      `${args.from}; ${warmupFrom} produced ${firstRows} and extending to ${extendedFrom} ` +
      `produced ${extendedRows}. Move --from later or widen the cache.`,
  );
}

/** The classifier's own need, in completed rows: v1's baseline plus the range
 *  median plus the oldest baseline sample's `vol5` window, or the widest
 *  variant's need under `--perturb`. Zero when no classifier runs. */
export function classifierWarmupRows(
  args: Pick<CliArgs, "usesClassifier" | "perturb">,
): number {
  if (!args.usesClassifier) return 0;
  return args.perturb ? PERTURB_WARMUP_SESSION_DAYS : CLASSIFIER_WARMUP_SESSION_DAYS;
}

export function completedRowsBefore(days: readonly SessionDay[], from: string): number {
  return days.filter((day) => day.sessionDate < from).length;
}

function resolveCacheDir(override?: string): string {
  const raw = override ?? process.env.BAR_CACHE_DIR ?? DEFAULT_CACHE_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** The year files the requested span touches, with their mtimes, so a run
 *  can be tied to the state of the archive that produced it. */
async function listCacheFiles(
  cacheDir: string,
  cacheSymbol: string,
  fromUtc: Date,
  toUtc: Date,
): Promise<CacheFileRef[]> {
  const out: CacheFileRef[] = [];
  for (let year = fromUtc.getUTCFullYear(); year <= toUtc.getUTCFullYear(); year++) {
    const file = path.join(cacheDir, SCHEMA_DIR, cacheSymbol, `${year}.parquet`);
    try {
      const stat = await fs.stat(file);
      out.push({ path: file, mtime: stat.mtime.toISOString() });
    } catch {
      // A year with no file contributed no bars; the coverage check above
      // already refused a range the archive cannot serve.
    }
  }
  return out;
}
