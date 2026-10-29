import type { BarData } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import type { CommonParams, StrategyModule } from "../strategy-types";
import { TRADING_TIMEZONE } from "../strategy-types";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRADING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TRADING_TIMEZONE,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

const MINUTES_PER_HOUR = 60;

/**
 * Entries kept before a cached minute→value map is emptied. A backtest year
 * of 1m bars is ~370k minutes and each strategy walks the same ones many
 * times over, so the cap is sized to hold a working set rather than a run;
 * it is cleared wholesale because per-entry eviction costs more bookkeeping
 * than the `Intl` format it is saving.
 *
 * What the cap costs a process that never restarts: two maps of at most
 * 262,144 number→small-value entries, ~35 MB together at the ceiling once
 * `Map`'s own per-entry overhead is counted, reached after ~180 days of live
 * ticking (one entry per wall-clock minute) or within a single backtest year,
 * then dropped to zero and refilled. That is the steady-state ceiling of the
 * 24/7 engine, not a leak.
 */
export const MINUTE_CACHE_CAP = 262_144;

const MS_PER_MINUTE = 60_000;

/**
 * Memoise a pure `Date → T` on the **UTC minute** the instant falls in.
 *
 * `Intl` formatting is the hot spot on both the backtest bar loop and the
 * live tick path — a strategy that walks back over a session formats every
 * bar it passes, once per bar it evaluates. Bar timestamps repeat, but live
 * instants are `new Date()` and never do: keyed on the millisecond the cache
 * never hit on the tick path and simply filled to the cap and cleared.
 *
 * The minute is sound as the whole input because both memoised readings are
 * minute-granular and every ET offset is a whole number of hours, so no
 * boundary the answers turn on falls inside a UTC minute. **Do not memoise a
 * finer-grained function here**, and do not give either one a second input —
 * a param, an env read, a mutable formatter — without removing the memo in
 * the same commit.
 */
export function memoiseByUtcMinute<T extends string | number>(
  compute: (d: Date) => T,
  cap: number,
): (d: Date) => T {
  const cache = new Map<number, T>();
  return (d: Date): T => {
    const minute = Math.floor(d.getTime() / MS_PER_MINUTE);
    const hit = cache.get(minute);
    if (hit !== undefined) return hit;
    const value = compute(d);
    if (cache.size >= cap) cache.clear();
    cache.set(minute, value);
    return value;
  };
}

const etDateKeyOf = memoiseByUtcMinute((d: Date) => dateFormatter.format(d), MINUTE_CACHE_CAP);

/** ET calendar date string (YYYY-MM-DD) for the given instant. */
export function etDateKey(d: Date): string {
  return etDateKeyOf(d);
}

const minutesInTradingTzOf = memoiseByUtcMinute((d: Date): number => {
  let h = 0;
  let m = 0;
  for (const p of timeFormatter.formatToParts(d)) {
    if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
  }
  // Intl can emit "24" for midnight depending on locale; normalise.
  if (h === 24) h = 0;
  return h * MINUTES_PER_HOUR + m;
}, MINUTE_CACHE_CAP);

/**
 * Minutes-since-midnight in TRADING_TIMEZONE for the given instant.
 *
 * Defined here rather than in `session.ts` — which re-exports it — so that
 * both memoised `Intl` reads share one cache policy, and so the day-session
 * predicate below can use it without an import cycle back through `session.ts`.
 */
export function minutesInTradingTz(d: Date): number {
  return minutesInTradingTzOf(d);
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/**
 * `HH:MM` → minutes since midnight, or a throw.
 *
 * `parseHHMM`'s validation with the opposite failure posture, and
 * deliberately so: that one parses *operator* input on the trading path,
 * where a null fails open onto a 24h window rather than blocking entries.
 * This one parses a window the contract table wrote, so a malformed value is
 * a defect in the table — and the silent version of it is `NaN`, which makes
 * every comparison below false and turns a day-session strategy into a
 * zero-trade one with nothing in the log.
 */
function minutesOfHHMM(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  const hours = m ? Number(m[1]) : -1;
  const minutes = m ? Number(m[2]) : -1;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Malformed day-session bound "${hhmm}" — expected HH:MM.`);
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

export interface DaySessionMinutes {
  readonly start: number;
  readonly end: number;
}

/**
 * The window's bounds in minutes since ET midnight, parsed once per window
 * object.
 *
 * `isInDaySession` is called per bar inside scans the `Intl` memo above
 * exists to protect, and re-parsing two strings there put the cost straight
 * back. The cache is keyed on the window object because that object is a
 * `CONTRACT_SPECS` row shared by reference into every strategy context, so a
 * process parses each instrument's bounds exactly once; a window built
 * ad-hoc simply misses and re-parses.
 */
const minutesByWindow = new WeakMap<DaySessionWindow, DaySessionMinutes>();

export function daySessionMinutes(daySession: DaySessionWindow): DaySessionMinutes {
  const hit = minutesByWindow.get(daySession);
  if (hit) return hit;
  const parsed = {
    start: minutesOfHHMM(daySession.start),
    end: minutesOfHHMM(daySession.end),
  };
  minutesByWindow.set(daySession, parsed);
  return parsed;
}

/**
 * Is `at` inside the instrument's day session? `[start, end)` in ET
 * wall-clock minutes: a bar stamped 16:00 opens the 16:00–16:01 minute and
 * is after the cash close.
 *
 * This is the one predicate every day-session quantity is measured through —
 * the tier ATR, the session VWAP anchor and the classifier's session-day
 * rows. Grouping by ET calendar date instead measures a 24-hour Globex day
 * and calls it a session, which is how ORB v2's tier gate came out inert.
 */
export function isInDaySession(at: Date, daySession: DaySessionWindow): boolean {
  const { start, end } = daySessionMinutes(daySession);
  const minute = minutesInTradingTz(at);
  return minute >= start && minute < end;
}

/**
 * The window a day-session quantity is measured over, or a throw.
 *
 * `null` means the deployment's instrument has no `CONTRACT_SPECS` row, so
 * nothing here knows when its cash session opens. A calendar-day fallback is
 * not an approximation of the answer — it is a different quantity wearing the
 * same name — so the caller refuses to produce a number instead.
 */
export function requireDaySession(
  daySession: DaySessionWindow | null,
  measure: string,
): DaySessionWindow {
  if (!daySession) {
    throw new Error(
      `${measure} needs the instrument's day-session window; this ticker has no contract-spec row.`,
    );
  }
  return daySession;
}

/**
 * The indicator types `calculateIndicator` resolves a day-session window
 * for. A new one there is a new one here — the pair is what lets the engine
 * answer "does this strategy need the window" without running the indicator.
 */
export function indicatorNeedsDaySession(config: IndicatorConfig): boolean {
  return config.type === "SESSION_VWAP" || config.type === "SESSION_VWAP_BANDS";
}

/**
 * Does this strategy need the instrument's day-session window to evaluate?
 *
 * Two ways to need it and only one of them is visible: a `SESSION_VWAP` or `SESSION_VWAP_BANDS` in
 * the indicator set, which `calculateAll` resolves the window for, and a
 * hook that calls `requireDaySession` itself, which no scan can see — so a
 * strategy doing that declares `config.requiresDaySession`. The answer is a
 * property of `(strategy, params)` and is stable for a deployment's life,
 * which is what lets the engine ask once at activation.
 */
export function strategyNeedsDaySession(
  strategy: StrategyModule,
  params: CommonParams,
): boolean {
  if (strategy.config.requiresDaySession) return true;
  const configs = strategy.buildIndicators?.(params) ?? strategy.config.indicators;
  return configs.some(indicatorNeedsDaySession);
}

/**
 * Index of the first day-session bar of `sessionDate`, walking back from
 * `barIndex`. Returns -1 when that ET date has no day-session bar at or
 * before `barIndex` — a series that reaches only into the overnight.
 */
export function findDaySessionStartIdx(
  bars: BarData[],
  barIndex: number,
  sessionDate: string,
  daySession: DaySessionWindow,
): number {
  let startIdx = -1;
  for (let i = barIndex; i >= 0; i--) {
    const b = bars[i];
    if (!b?.timestamp) continue;
    const t = new Date(b.timestamp);
    if (isNaN(t.getTime())) continue;
    if (etDateKey(t) !== sessionDate) break;
    if (isInDaySession(t, daySession)) startIdx = i;
  }
  return startIdx;
}

/**
 * What one backward walk over the prior completed day sessions can answer.
 *
 * Every field is measured over `daySession` bars alone and over ET dates other
 * than the current one, so *prior session* means the last completed cash
 * session and not the last calendar day.
 */
export interface PriorDaySessionStats {
  /**
   * Mean of `(sessionHigh − sessionLow)` over the prior `period` completed
   * sessions, or NaN when fewer than `period` are in the series. The rest of
   * the fields are still answered in that case — a hook that needs only the
   * prior close does not need a full baseline.
   */
  readonly rangeMean: number;
  /** Last in-window bar close of the most recent completed prior session. NaN when there is none. */
  readonly close: number;
  /** High of that same session. NaN when there is none. */
  readonly high: number;
  /** Low of that same session. NaN when there is none. */
  readonly low: number;
  /** Completed prior sessions the walk found, capped at `period`. */
  readonly sessions: number;
  /**
   * Of `sessions`, how many fell inside `spanDays` calendar days of the bar at
   * `sessionStartIdx`. Equal to `sessions` when `spanDays` is omitted — a
   * caller that states no span gets the pre-2026-09-24 answer and no new
   * verdict.
   *
   * **Reported, never gated on here: the recency verdict is the caller's.** A
   * session counts as in-span when its newest in-window bar is at or after the
   * floor, which is the reading both call-site walks this replaced already had.
   */
  readonly sessionsInSpan: number;
}

/**
 * The degenerate answer, shared by reference across every caller that reaches
 * it — so it is frozen and the fields above are `readonly`. In a process that
 * never restarts, one caller writing to a field it was handed would follow
 * every later call that takes this path.
 */
const EMPTY_PRIOR_STATS: PriorDaySessionStats = Object.freeze({
  rangeMean: NaN,
  close: NaN,
  high: NaN,
  low: NaN,
  sessions: 0,
  sessionsInSpan: 0,
});

const MS_PER_DAY = 86_400_000;

/**
 * The prior completed day sessions behind the bar at `sessionStartIdx`, in one
 * walk: the range mean over `period` of them, and the most recent one's close,
 * high and low.
 *
 * Sessions are identified by ET calendar date; only bars inside `daySession`
 * count toward a session's high, low and close, and only dates other than
 * `currentSessionDate` are considered. The walk stops as soon as `period`
 * sessions are complete.
 *
 * The window is passed rather than the bars pre-filtered to it because
 * `sessionStartIdx` indexes into the caller's full series; filtering first
 * would silently re-base it.
 *
 * **One walk, because seven hooks want overlapping parts of it.** The
 * three-year survey's §9, item 3 asks for exactly this shape so the MES probes
 * do not each copy the traversal; `priorRthSessionRangeAtr` below is now the
 * range-mean projection of it rather than a second copy.
 *
 * **`spanDays` is a report, not a bound.** The walk itself is unbounded in
 * calendar time — it counts sessions back however old they are — so after a
 * hole in the series `rangeMean` averages across it and comes back finite.
 * Passing `spanDays` adds `sessionsInSpan` to the answer and changes no other
 * field, which is what lets a caller that wants the recency verdict state it in
 * its own fail-closed gate while every caller that does not keeps the number it
 * has always been handed.
 */
export function priorDaySessionStats(
  bars: BarData[],
  sessionStartIdx: number,
  period: number,
  currentSessionDate: string,
  daySession: DaySessionWindow,
  spanDays?: number,
): PriorDaySessionStats {
  const memo = memoByFixedSeries.get(bars);
  if (!memo) {
    return walkPriorDaySessionStats(bars, sessionStartIdx, period, currentSessionDate, daySession, spanDays);
  }
  const key = `${sessionStartIdx}|${period}|${currentSessionDate}|${daySession.start}|${daySession.end}|${spanDays}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const stats = Object.freeze(
    walkPriorDaySessionStats(bars, sessionStartIdx, period, currentSessionDate, daySession, spanDays),
  );
  memo.set(key, stats);
  return stats;
}

/**
 * Series a caller has promised never to change, each with its walk answers.
 *
 * A hook asks {@link priorDaySessionStats} on every bar it evaluates, and every
 * bar of one session asks the same question — the same `sessionStartIdx` — so
 * a multi-year backtest walked the same `period` sessions back tens of times
 * per session, which was the largest cost in an `orb` run. The answer is a pure
 * function of the arguments and the bars **before** `sessionStartIdx`, so on a
 * series that cannot change it is safe to keep.
 *
 * **Opt-in, never inferred**: the engine's series is live and may be rewritten
 * in place, where a kept answer would go stale silently. Only `runBacktest`,
 * whose bars are a fixed slice, registers one. Kept answers are frozen because
 * every later caller of the same key is handed the same object.
 */
const memoByFixedSeries = new WeakMap<BarData[], Map<string, PriorDaySessionStats>>();

/** Promise that `bars` will not change, so the prior-session walk over it may be
 *  kept. See {@link memoByFixedSeries}; the engine must never call this. */
export function markFixedSeries(bars: BarData[]): void {
  if (!memoByFixedSeries.has(bars)) memoByFixedSeries.set(bars, new Map());
}

function walkPriorDaySessionStats(
  bars: BarData[],
  sessionStartIdx: number,
  period: number,
  currentSessionDate: string,
  daySession: DaySessionWindow,
  spanDays?: number,
): PriorDaySessionStats {
  if (period < 1) return EMPTY_PRIOR_STATS;
  if (sessionStartIdx <= 0) return EMPTY_PRIOR_STATS;

  // No span asked for: every session is in it. An anchor bar that cannot be
  // read leaves a NaN floor, which no session compares at or after — so the
  // count is zero and a caller gating on it fails closed.
  const anchorMs = new Date(bars[sessionStartIdx]?.timestamp ?? "").getTime();
  const spanFloorMs = spanDays === undefined ? -Infinity : anchorMs - spanDays * MS_PER_DAY;

  const ranges: number[] = [];
  let sessionsInSpan = 0;
  let curDate: string | null = null;
  let curHigh = -Infinity;
  let curLow = Infinity;
  let curInSpan = false;
  let priorClose = NaN;
  let priorHigh = NaN;
  let priorLow = NaN;
  let priorPending = true;

  /** Close the session being accumulated. Returns true once `period` are in. */
  const flush = (): boolean => {
    if (!isFinite(curHigh) || !isFinite(curLow)) return false;
    ranges.push(curHigh - curLow);
    if (curInSpan) sessionsInSpan++;
    if (priorPending) {
      priorHigh = curHigh;
      priorLow = curLow;
      priorPending = false;
    }
    return ranges.length >= period;
  };

  for (let i = sessionStartIdx - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b?.timestamp) continue;
    const t = new Date(b.timestamp);
    if (isNaN(t.getTime())) continue;
    if (!isInDaySession(t, daySession)) continue;
    const d = etDateKey(t);
    if (d === currentSessionDate) continue;
    if (curDate === null) {
      curDate = d;
      curHigh = b.high;
      curLow = b.low;
      // Walking backwards, the first in-window bar of a session is its last
      // one — so this is the prior session's closing print, and its recency.
      curInSpan = t.getTime() >= spanFloorMs;
      priorClose = b.close;
    } else if (d === curDate) {
      if (b.high > curHigh) curHigh = b.high;
      if (b.low < curLow) curLow = b.low;
    } else {
      if (flush()) break;
      curDate = d;
      curHigh = b.high;
      curLow = b.low;
      curInSpan = t.getTime() >= spanFloorMs;
    }
  }

  if (ranges.length < period && curDate !== null) flush();

  let rangeMean = NaN;
  if (ranges.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += ranges[i];
    rangeMean = sum / period;
  }

  return {
    rangeMean,
    close: priorClose,
    high: priorHigh,
    low: priorLow,
    sessions: ranges.length,
    sessionsInSpan,
  };
}

/**
 * Average of `(sessionHigh − sessionLow)` over the prior `period` completed
 * day sessions before the bar at `sessionStartIdx`. NaN if fewer than `period`
 * prior sessions are available.
 *
 * The range-mean projection of {@link priorDaySessionStats} — same walk, same
 * answers, kept as its own name because `orb`, ORB v2 and a VWAP fade all ask
 * only this question and every number they have published was taken through it.
 *
 * **It states no `spanDays` and must not start.** A recency verdict here would
 * move those three published runs; a caller that wants one asks the helper
 * directly and gates on `sessionsInSpan` itself.
 */
export function priorRthSessionRangeAtr(
  bars: BarData[],
  sessionStartIdx: number,
  period: number,
  currentSessionDate: string,
  daySession: DaySessionWindow,
): number {
  return priorDaySessionStats(bars, sessionStartIdx, period, currentSessionDate, daySession)
    .rangeMean;
}

// ── Market Profile / TPO ────────────────────────────────────────────────────

/**
 * The TPO period. Thirty minutes is the convention every Market Profile source
 * in [external-community-survey.md](../../../../docs/strategies/accounts/external-community-survey.md)
 * §3 states, and it is what makes the profile *exact* from OHLC: a TPO is a
 * unit of time, so a 30m bucket's high and low are the whole of what the period
 * contributes, where a volume POC off bars would be an approximation.
 *
 * Buckets are floored on the **absolute epoch**, never on the session open —
 * the same rule in-module higher-timeframe aggregation follows, and what makes
 * this identical on the live path and in the CLI by construction. Every ET
 * offset is a whole number of hours, so an ET half-hour boundary is a UTC one.
 */
const TPO_BUCKET_MS = 30 * 60_000;
const TPO_BUCKET_MINUTES = 30;

/**
 * The share of a session's TPO count the value area holds.
 *
 * **The construction, stated because there are several and the numbers depend
 * on which one produced them.** Levels are a grid of `levelSize` steps spanning
 * the session's day-session high and low. Each 30m bucket adds one count to
 * every level in `[bucketLow, bucketHigh]`. The POC is the level with the
 * highest count, ties broken by proximity to the session midpoint. The value
 * area starts at the POC and expands **one level at a time**, each step taking
 * whichever adjacent level carries the higher count, until the levels included
 * hold at least this share of the session's total count. **A tie on the count
 * goes to whichever candidate is nearer the session midpoint**, so the band is
 * centred the same way the POC is; two equidistant candidates take the level
 * above. VAH and VAL are the top and bottom levels of what that expansion
 * included.
 *
 * Two places this differs from other published recipes, both deliberate:
 * expansion is one level at a time rather than the two-at-a-time pairing some
 * platforms use (survey §3.1 states one), and the total is a sum over levels
 * rather than over bucket-minutes.
 */
export const VALUE_AREA_FRACTION = 0.7;

/**
 * Work cap on the level grid, in levels. On a 0.25 grid this is 2,048 index
 * points — eight times MNQ's three-year median cash-session range — so no real
 * session reaches it and a bar carrying a corrupt extreme cannot make this
 * allocate without bound. A session past the cap is returned with `NaN` value
 * area and no single prints rather than dropped, so the caller's own
 * `isFinite` clause stands the session down instead of a missing row reading
 * as one fewer session.
 */
const MAX_TPO_LEVELS = 8_192;

/**
 * A contiguous run of price levels the prior session's auction printed exactly
 * once — one 30m period crossed the band and no other returned to it.
 *
 * `low` and `high` are the band's lowest and highest **levels**, so a band of
 * `levels` steps has `high − low = (levels − 1) × levelSize`. A one-level band
 * therefore has zero width, which is the honest reading for a caller applying a
 * minimum-width rule.
 *
 * `touchesHigh` / `touchesLow` say the band reaches the session's extreme,
 * which is a *tail* in Market Profile's language rather than a zone inside the
 * auction. Reported, not filtered: excluding tails is a claim about the thesis
 * and belongs to the caller.
 */
export interface SinglePrintBand {
  readonly low: number;
  readonly high: number;
  readonly levels: number;
  readonly touchesHigh: boolean;
  readonly touchesLow: boolean;
}

/** One prior day session's TPO profile, built from its own 30m buckets. */
export interface DaySessionTpoProfile {
  /** ET calendar date of the session this was built from. */
  readonly sessionDate: string;
  /** Day-session high and low — the span the level grid covers. */
  readonly high: number;
  readonly low: number;
  /** Point of control; `NaN` when the grid could not be built. */
  readonly poc: number;
  /** Value-area high and low; `NaN` when the grid could not be built. */
  readonly vah: number;
  readonly val: number;
  /** Total TPO count summed over every level. Zero when the grid was refused. */
  readonly tpos: number;
  /**
   * 30m buckets this session contributed. **The completeness report** — compare
   * it against `expectedBuckets` on the result; the threshold is the caller's.
   */
  readonly buckets: number;
  /** The level step the grid was built on, echoed so a band's width is readable. */
  readonly levelSize: number;
  /** Single-print runs, ascending by price, tails included. */
  readonly singlePrints: readonly SinglePrintBand[];
  /** Epoch ms of the session's last in-window bar — its recency, and where a "naked since" walk stops. */
  readonly lastBarMs: number;
}

export interface PriorDaySessionProfiles {
  /** Newest session first, at most `sessions` of them. */
  readonly profiles: readonly DaySessionTpoProfile[];
  /** Completed prior sessions the walk profiled, capped at `sessions`. */
  readonly sessions: number;
  /**
   * Of `sessions`, how many fell inside `spanDays` calendar days of the bar at
   * `sessionStartIdx`. Equal to `sessions` when `spanDays` is omitted.
   *
   * **Reported, never gated on here** — the same contract
   * {@link PriorDaySessionStats.sessionsInSpan} carries, for the same reason: a
   * recency verdict is a claim about how stale a structure may be before the
   * setup is no longer the one that was measured, and that is the module's
   * claim rather than the traversal's.
   */
  readonly sessionsInSpan: number;
  /**
   * 30m buckets a *complete* session of this instrument's day session spans.
   * Thirteen on MNQ's 09:30–16:00. The denominator of the caller's own
   * completeness clause.
   */
  readonly expectedBuckets: number;
}

interface TpoBucket {
  high: number;
  low: number;
}

function buildTpoProfile(
  sessionDate: string,
  buckets: TpoBucket[],
  levelSize: number,
  lastBarMs: number,
): DaySessionTpoProfile {
  let high = -Infinity;
  let low = Infinity;
  for (const b of buckets) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }

  const refused: DaySessionTpoProfile = {
    sessionDate,
    high,
    low,
    poc: NaN,
    vah: NaN,
    val: NaN,
    tpos: 0,
    buckets: buckets.length,
    levelSize,
    singlePrints: [],
    lastBarMs,
  };
  if (!isFinite(high) || !isFinite(low) || !(levelSize > 0)) return refused;

  const levels = Math.round((high - low) / levelSize) + 1;
  if (levels < 1 || levels > MAX_TPO_LEVELS) return refused;

  // A difference array over level indices, prefix-summed in place: each bucket
  // is an interval `[low, high]` of levels and the count at a level is how many
  // intervals cover it. Incrementing every level of every bucket is the same
  // answer at `buckets × levels` work instead of `buckets + levels`.
  const counts = new Int32Array(levels);
  for (const b of buckets) {
    const from = Math.round((b.low - low) / levelSize);
    const to = Math.round((b.high - low) / levelSize);
    counts[from]++;
    if (to + 1 < levels) counts[to + 1]--;
  }
  let running = 0;
  let tpos = 0;
  for (let i = 0; i < levels; i++) {
    running += counts[i];
    counts[i] = running;
    tpos += running;
  }

  // The POC tie is broken toward the session midpoint, and an **exact** distance
  // tie keeps the *lower* index: the scan is ascending and the comparison is
  // strict. The value-area expansion below takes the same midpoint reading and
  // states its own direction on an exact distance tie, because there the two
  // candidates sit on opposite sides of the band and one of them has to win.
  const mid = (levels - 1) / 2;
  let pocIdx = 0;
  let pocCount = -1;
  for (let i = 0; i < levels; i++) {
    const c = counts[i];
    if (c > pocCount || (c === pocCount && Math.abs(i - mid) < Math.abs(pocIdx - mid))) {
      pocCount = c;
      pocIdx = i;
    }
  }

  const target = VALUE_AREA_FRACTION * tpos;
  let valIdx = pocIdx;
  let vahIdx = pocIdx;
  let included = counts[pocIdx];
  while (included < target && (valIdx > 0 || vahIdx < levels - 1)) {
    // −1 stands for "this side is exhausted"; counts are never negative, so the
    // live side always wins the comparison and an exhausted side never ties.
    const above = vahIdx < levels - 1 ? counts[vahIdx + 1] : -1;
    const below = valIdx > 0 ? counts[valIdx - 1] : -1;
    // **A tie is the common case here, not the edge one.** `counts` is piecewise
    // constant with at most two breakpoints per bucket over hundreds of levels,
    // so adjacent levels carry equal counts across most of a plateau. Resolving
    // every tie one way takes that entire run before a single level on the other
    // side, which translates the whole band — the 70% target fixes its *width*
    // either way. So the tie goes to whichever candidate sits nearer the session
    // midpoint, the centring convention the POC tie above already uses; an exact
    // distance tie (the two candidates equidistant) takes the level above.
    const takeAbove =
      above === below
        ? Math.abs(vahIdx + 1 - mid) <= Math.abs(valIdx - 1 - mid)
        : above > below;
    if (takeAbove) {
      vahIdx++;
      included += above;
    } else {
      valIdx--;
      included += below;
    }
  }

  const singlePrints: SinglePrintBand[] = [];
  let runStart = -1;
  for (let i = 0; i <= levels; i++) {
    // A count of **zero** ends a run like any other non-1 count, and on a
    // gapless session it cannot occur: consecutive buckets share the price the
    // first closed at and the second opened at, so the union of a session's
    // bucket ranges is contiguous. A zero-count level means a *missing bucket*,
    // not a price the market jumped over — do not read this branch as evidence
    // that a session's profile has holes in it.
    const isSingle = i < levels && counts[i] === 1;
    if (isSingle) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;
    singlePrints.push({
      low: low + runStart * levelSize,
      high: low + (i - 1) * levelSize,
      levels: i - runStart,
      touchesLow: runStart === 0,
      touchesHigh: i - 1 === levels - 1,
    });
    runStart = -1;
  }

  return {
    sessionDate,
    high,
    low,
    poc: low + pocIdx * levelSize,
    vah: low + vahIdx * levelSize,
    val: low + valIdx * levelSize,
    tpos,
    buckets: buckets.length,
    levelSize,
    singlePrints,
    lastBarMs,
  };
}

/**
 * The prior completed day sessions' **TPO profiles** behind the bar at
 * `sessionStartIdx`, newest first, in one backward walk.
 *
 * Sessions are identified by ET calendar date and only bars inside
 * `daySession` are bucketed, so a profile is the *cash session's* auction and
 * never the 24-hour Globex day — the trap the day-session rule names, and the
 * one a hook grouping `ctx.bars` by calendar date falls into. A session is one
 * ET date by construction, so no hole in the series can be crossed *inside* one
 * profile; which sessions the walk reached is the separate question
 * `spanDays` answers.
 *
 * **Report, do not gate**, the same contract {@link priorDaySessionStats}
 * settled on: the walk itself is unbounded in calendar time, `spanDays` adds
 * `sessionsInSpan` and changes nothing else, `buckets` says how complete each
 * session was against `expectedBuckets`, and an unbuildable grid comes back as
 * `NaN` value-area levels rather than as a missing session. Every threshold
 * over those numbers belongs to the caller's own fail-closed clause.
 *
 * `levelSize` is the price grid the TPO counts are taken on — the instrument's
 * tick size for the modules that use this today. See {@link VALUE_AREA_FRACTION}
 * for the value-area construction.
 */
export function priorDaySessionProfiles(
  bars: BarData[],
  sessionStartIdx: number,
  sessions: number,
  currentSessionDate: string,
  daySession: DaySessionWindow,
  levelSize: number,
  spanDays?: number,
): PriorDaySessionProfiles {
  const { start, end } = daySessionMinutes(daySession);
  const expectedBuckets =
    Math.floor((end - 1) / TPO_BUCKET_MINUTES) - Math.floor(start / TPO_BUCKET_MINUTES) + 1;
  const empty: PriorDaySessionProfiles = {
    profiles: [],
    sessions: 0,
    sessionsInSpan: 0,
    expectedBuckets,
  };
  if (sessions < 1 || sessionStartIdx <= 0) return empty;

  // An anchor bar that cannot be read leaves a NaN floor, which no session
  // compares at or after — so the in-span count is zero and a caller gating on
  // it fails closed.
  const anchorMs = new Date(bars[sessionStartIdx]?.timestamp ?? "").getTime();
  const spanFloorMs = spanDays === undefined ? -Infinity : anchorMs - spanDays * MS_PER_DAY;

  const profiles: DaySessionTpoProfile[] = [];
  let sessionsInSpan = 0;
  let curDate: string | null = null;
  let curBuckets = new Map<number, TpoBucket>();
  let curLastMs = 0;
  let curInSpan = false;

  /** Close the session being accumulated. Returns true once `sessions` are in. */
  const flush = (): boolean => {
    if (curDate === null || curBuckets.size === 0) return false;
    profiles.push(buildTpoProfile(curDate, [...curBuckets.values()], levelSize, curLastMs));
    if (curInSpan) sessionsInSpan++;
    return profiles.length >= sessions;
  };

  for (let i = sessionStartIdx - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b?.timestamp) continue;
    const ms = Date.parse(b.timestamp);
    if (isNaN(ms)) continue;
    const t = new Date(ms);
    if (!isInDaySession(t, daySession)) continue;
    const d = etDateKey(t);
    if (d === currentSessionDate) continue;

    if (d !== curDate) {
      if (curDate !== null && flush()) {
        curDate = null;
        break;
      }
      curDate = d;
      curBuckets = new Map();
      // Walking backwards, the first in-window bar of a session is its last
      // one — so this is the session's closing print, and its recency.
      curLastMs = ms;
      curInSpan = ms >= spanFloorMs;
    }

    const bucketStart = Math.floor(ms / TPO_BUCKET_MS) * TPO_BUCKET_MS;
    const hit = curBuckets.get(bucketStart);
    if (hit) {
      if (b.high > hit.high) hit.high = b.high;
      if (b.low < hit.low) hit.low = b.low;
    } else {
      curBuckets.set(bucketStart, { high: b.high, low: b.low });
    }
  }

  if (curDate !== null && profiles.length < sessions) flush();

  return { profiles, sessions: profiles.length, sessionsInSpan, expectedBuckets };
}
