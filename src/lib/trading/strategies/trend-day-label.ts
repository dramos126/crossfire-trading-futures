/**
 * The MNQ trend-day label — `research/trend-day-filter/decisions.md`, the spec;
 * the decision numbers below are that file's.
 *
 * Variant A labels a cash session `green` / `red` / `neither` at every closed
 * 5m bar from bars up to that close. Variant B is a separate pre-open label,
 * fixed at the cash open from the overnight bars. They are never merged.
 *
 * Pure, and no lookahead by construction: variant A reads the session's cash
 * bars at or before the index it is asked about, variant B reads bars stamped
 * before the open, and both read prior-session rows strictly before the
 * session being labelled. The same call answers the same in engine and
 * backtest. A playbook's `trendDayFilter` reads variant A.
 *
 * Range quantities are tick integers through `pnlTicksFromPrices`, so the
 * `≥` ties decision 6 states are decided by arithmetic, not by representation.
 */
import type { BarData } from "@/lib/brokers/types";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import { sessionVwapBands } from "@/lib/trading/indicators";
import { pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";
import { median } from "@/lib/trading/regime/classify-regime";
import { buildSessionDays, type SessionDay } from "@/lib/trading/regime/session-days";
import {
  addCalendarDays,
  etWallClockToUtc,
  sessionDateOf,
  sessionStartUtc,
  splitSessionDate,
} from "@/lib/trading/regime/session-dates";
import {
  daySessionMinutes,
  isInDaySession,
  minutesInTradingTz,
} from "@/lib/trading/session/session-utils";
import type { CalibrationConstant } from "@/lib/trading/strategy-types";

export type TrendDayLabel = "green" | "red" | "neither";

export interface TrendDayParams {
  orBars: number;
  holdBars: number;
  closePosMin: number;
  rangeMult: number;
  refRangeDays: number;
  revokeBars: number;
  gapMult: number;
  onPosMin: number;
  onMinBarsShare: number;
}

const UNCALIBRATED = "Decision 5 default; none is calibrated.";

const constant = (value: number, min: number, max: number): CalibrationConstant<number> => ({
  value,
  range: { kind: "range", min, max },
  rationale: UNCALIBRATED,
});

/** Decision 5. `gapMult`, `onPosMin` and `onMinBarsShare` are variant B's. */
export const TREND_DAY_CONSTANTS: Readonly<Record<keyof TrendDayParams, CalibrationConstant<number>>> = {
  orBars: constant(6, 3, 12),
  holdBars: constant(6, 3, 12),
  closePosMin: constant(0.75, 0.6, 0.95),
  rangeMult: constant(0.5, 0.25, 1),
  refRangeDays: {
    ...constant(17, 10, 60),
    rationale:
      "Decision 5, amended 2026-10-15: 17, not 20, so the live engine's one 10,000-bar 5m read holds the window with a spare session for an early close. Uncalibrated.",
  },
  revokeBars: constant(1, 1, 3),
  gapMult: constant(0.3, 0.1, 1),
  onPosMin: constant(0.75, 0.6, 0.95),
  onMinBarsShare: constant(0.8, 0.5, 1),
};

export const TREND_DAY_DEFAULTS: Readonly<TrendDayParams> = {
  orBars: TREND_DAY_CONSTANTS.orBars.value,
  holdBars: TREND_DAY_CONSTANTS.holdBars.value,
  closePosMin: TREND_DAY_CONSTANTS.closePosMin.value,
  rangeMult: TREND_DAY_CONSTANTS.rangeMult.value,
  refRangeDays: TREND_DAY_CONSTANTS.refRangeDays.value,
  revokeBars: TREND_DAY_CONSTANTS.revokeBars.value,
  gapMult: TREND_DAY_CONSTANTS.gapMult.value,
  onPosMin: TREND_DAY_CONSTANTS.onPosMin.value,
  onMinBarsShare: TREND_DAY_CONSTANTS.onMinBarsShare.value,
};

const BAR_MINUTES = 5;
const MS_PER_MINUTE = 60_000;
/** A session day whose last cash bar is stamped before `end − 5m` is an early close. */
const FULL_DAY_LAST_BAR_BEFORE_END_MIN = BAR_MINUTES;
/** Variant B: the prior session row must be at most this many calendar days old. */
const PRIOR_SESSION_MAX_AGE_DAYS = 7;

// ── Reference range (decision 1 iv) ─────────────────────────────────────────

/** A `buildSessionDays` row plus whether the session ran to the full close. */
export interface ReferenceDay extends SessionDay {
  full: boolean;
}

/**
 * Session-day rows for `refRange` and variant B's prior close, from bars of
 * any timeframe stamped at their open. `full` is false on an early close —
 * the last cash bar stamped before `end − 5m` (15:55 ET on MNQ).
 */
export function buildReferenceDays(
  bars: readonly BarData[],
  daySession: DaySessionWindow,
  tickSize: number,
): ReferenceDay[] {
  const lastMinute = new Map<string, number>();
  for (const bar of bars) {
    const at = new Date(bar.timestamp);
    if (!isInDaySession(at, daySession)) continue;
    const date = sessionDateOf(at);
    const minute = minutesInTradingTz(at);
    if (minute > (lastMinute.get(date) ?? -1)) lastMinute.set(date, minute);
  }
  const fullFrom = daySessionMinutes(daySession).end - FULL_DAY_LAST_BAR_BEFORE_END_MIN;
  return buildSessionDays({ bars: [...bars], daySession, tickSize }).map((row) => ({
    ...row,
    full: (lastMinute.get(row.sessionDate) ?? -1) >= fullFrom,
  }));
}

/**
 * Median `rthRange`, in ticks, of the last `refRangeDays` full session days
 * strictly before `sessionDate`, reaching back past early closes. Null when
 * fewer are available (or the median is not positive): decision 6 makes that
 * day `neither` throughout.
 */
export function refRangeTicks(
  days: readonly ReferenceDay[],
  sessionDate: string,
  refRangeDays: number,
): number | null {
  const window: number[] = [];
  for (let i = days.length - 1; i >= 0 && window.length < refRangeDays; i--) {
    if (days[i].sessionDate >= sessionDate || !days[i].full) continue;
    window.push(days[i].rthRange);
  }
  if (window.length < refRangeDays) return null;
  const m = median(window);
  return m > 0 ? m : null;
}

// ── Variant A ───────────────────────────────────────────────────────────────

export type IntradayStructural = "or-undefined" | "ref-short";

export interface TrendDayStep {
  /** Bar number `k`: 1 is stamped at the cash open. */
  slot: number;
  /** ISO instant the bar closes — what the label is attached to. */
  closeTs: string;
  state: TrendDayLabel;
  /** What happened at this close: a label taken, a label revoked, or nothing. */
  event: "label" | "revoke" | null;
}

export interface TrendDaySession {
  sessionDate: string;
  /** Why the day is `neither` regardless of price, or null. */
  structural: IntradayStructural | null;
  /** One per present cash bar, ascending. */
  steps: TrendDayStep[];
  first: { label: Exclude<TrendDayLabel, "neither">; slot: number; closeTs: string } | null;
  /** The state at the last present cash bar's close. */
  final: TrendDayLabel;
}

function slotOf(bar: BarData, cashStartMinute: number): number {
  const offset = minutesInTradingTz(new Date(bar.timestamp)) - cashStartMinute;
  if (offset % BAR_MINUTES !== 0) {
    throw new Error(`trend-day label reads 5m bars; ${bar.timestamp} is not on the 5m grid`);
  }
  return offset / BAR_MINUTES + 1;
}

function closeTsOf(bar: BarData): string {
  return new Date(Date.parse(bar.timestamp) + BAR_MINUTES * MS_PER_MINUTE).toISOString();
}

/** Consecutive-present-slot run lengths of a close against VWAP, ending at the current bar. */
interface Runs {
  above: number;
  below: number;
  atOrAbove: number;
  atOrBelow: number;
}

/**
 * Variant A over one session's cash 5m bars, ascending, all of one session
 * date. Each step reads only the bars at or before it, so the state at bar `k`
 * is the same whether or not later bars are passed.
 *
 * Decision 4's order at each close: revoke first, then label — and a label
 * is taken only from a state that was `neither` coming into the bar, so a
 * revocation bar ends `neither` and the state never steps green → red.
 */
export function labelTrendDaySession(
  dayBars: readonly BarData[],
  refTicks: number | null,
  daySession: DaySessionWindow,
  tickSize: number,
  params: TrendDayParams = TREND_DAY_DEFAULTS,
): TrendDaySession {
  const sessionDate = dayBars.length > 0 ? sessionDateOf(new Date(dayBars[0].timestamp)) : "";
  const cashStart = daySessionMinutes(daySession).start;
  const vwap = sessionVwapBands([...dayBars], daySession).vwap;

  const steps: TrendDayStep[] = [];
  let state: TrendDayLabel = "neither";
  let first: TrendDaySession["first"] = null;
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let orSlotsSeen = 0;
  let prevSlot = 0;
  const runs: Runs = { above: 0, below: 0, atOrAbove: 0, atOrBelow: 0 };

  for (let i = 0; i < dayBars.length; i++) {
    const bar = dayBars[i];
    const slot = slotOf(bar, cashStart);
    const c = bar.close;
    const v = vwap[i];
    const contiguous = slot === prevSlot + 1;
    runs.above = c > v ? (contiguous ? runs.above : 0) + 1 : 0;
    runs.below = c < v ? (contiguous ? runs.below : 0) + 1 : 0;
    runs.atOrAbove = c >= v ? (contiguous ? runs.atOrAbove : 0) + 1 : 0;
    runs.atOrBelow = c <= v ? (contiguous ? runs.atOrBelow : 0) + 1 : 0;
    prevSlot = slot;

    if (bar.high > dayHigh) dayHigh = bar.high;
    if (bar.low < dayLow) dayLow = bar.low;
    if (slot <= params.orBars) {
      orSlotsSeen++;
      if (bar.high > orHigh) orHigh = bar.high;
      if (bar.low < orLow) orLow = bar.low;
    }

    let event: TrendDayStep["event"] = null;
    const orDefined = orSlotsSeen === params.orBars;
    if (slot > params.orBars && orDefined && refTicks != null) {
      const carried = state;
      if (carried === "green" && runs.atOrBelow >= params.revokeBars) {
        state = "neither";
        event = "revoke";
      } else if (carried === "red" && runs.atOrAbove >= params.revokeBars) {
        state = "neither";
        event = "revoke";
      }
      if (carried === "neither") {
        const rangeTicks = pnlTicksFromPrices(dayLow, dayHigh, 1, tickSize);
        const expanded = rangeTicks >= params.rangeMult * refTicks;
        const posNeed = params.closePosMin * rangeTicks;
        if (
          expanded &&
          c > orHigh &&
          pnlTicksFromPrices(dayLow, c, 1, tickSize) >= posNeed &&
          runs.above >= params.holdBars
        ) {
          state = "green";
          event = "label";
        } else if (
          expanded &&
          c < orLow &&
          pnlTicksFromPrices(c, dayHigh, 1, tickSize) >= posNeed &&
          runs.below >= params.holdBars
        ) {
          state = "red";
          event = "label";
        }
      }
    }

    const closeTs = closeTsOf(bar);
    if (first == null && state !== "neither") first = { label: state, slot, closeTs };
    steps.push({ slot, closeTs, state, event });
  }

  // An OR still forming at the last bar read is not undefined — only one with
  // a stamp missing among the slots already passed.
  const orUndefined = orSlotsSeen < Math.min(prevSlot, params.orBars);
  const structural: IntradayStructural | null =
    orUndefined ? "or-undefined" : refTicks == null ? "ref-short" : null;
  return { sessionDate, structural, steps, first, final: steps.at(-1)?.state ?? "neither" };
}

export interface TrendDayAt {
  label: TrendDayLabel;
  structural: IntradayStructural | null;
  first: TrendDaySession["first"];
}

/**
 * Variant A's label at the close of `bars[index]` — the strategy-hook entry
 * point: `bars` is `ctx.bars` (5m, stamped at open), `referenceDays` the prior
 * sessions from `buildReferenceDays` (rows on or after today's session are
 * ignored). Null when `bars[index]` is not a cash-session bar.
 */
export function trendDayLabelAt(args: {
  bars: readonly BarData[];
  index: number;
  referenceDays: readonly ReferenceDay[];
  daySession: DaySessionWindow;
  tickSize: number;
  params?: TrendDayParams;
}): TrendDayAt | null {
  const { bars, index, daySession, tickSize } = args;
  const params = args.params ?? TREND_DAY_DEFAULTS;
  const at = bars[index] ? new Date(bars[index].timestamp) : null;
  if (!at || !isInDaySession(at, daySession)) return null;
  const today = sessionDateOf(at);

  const dayBars: BarData[] = [];
  for (let i = index; i >= 0; i--) {
    const t = new Date(bars[i].timestamp);
    if (sessionDateOf(t) !== today) break;
    if (isInDaySession(t, daySession)) dayBars.push(bars[i]);
  }
  dayBars.reverse();

  const ref = refRangeTicks(args.referenceDays, today, params.refRangeDays);
  const session = labelTrendDaySession(dayBars, ref, daySession, tickSize, params);
  return { label: session.final, structural: session.structural, first: session.first };
}

// ── Variant B (decision 7) ──────────────────────────────────────────────────

export type PreOpenStructural = "ref-short" | "overnight-short" | "no-prior-session" | "no-open-bar";

export interface PreOpenResult {
  label: TrendDayLabel;
  structural: PreOpenStructural | null;
  /** 5m bars present in the overnight window, against `expectedBars`. */
  barsPresent: number;
  expectedBars: number;
}

/**
 * Variant B for `sessionDate`, from 5m bars stamped from 18:00 ET the prior
 * evening up to (not including) the cash open; any other bar passed is
 * ignored. `onClose` is the close of the bar stamped one bar before the open
 * (09:25 on MNQ); `priorClose` the most recent reference row before today.
 */
export function labelPreOpen(args: {
  bars: readonly BarData[];
  sessionDate: string;
  referenceDays: readonly ReferenceDay[];
  daySession: DaySessionWindow;
  tickSize: number;
  params?: TrendDayParams;
}): PreOpenResult {
  const { bars, sessionDate, daySession, tickSize } = args;
  const params = args.params ?? TREND_DAY_DEFAULTS;
  const startMs = sessionStartUtc(sessionDate).getTime();
  const cashStart = daySessionMinutes(daySession).start;
  const [y, m, d] = splitSessionDate(sessionDate);
  const openMs = etWallClockToUtc(y, m, d, Math.floor(cashStart / 60), cashStart % 60).getTime();
  const lastStampMs = openMs - BAR_MINUTES * MS_PER_MINUTE;
  const expectedBars = (openMs - startMs) / (BAR_MINUTES * MS_PER_MINUTE);

  let barsPresent = 0;
  let onHigh = -Infinity;
  let onLow = Infinity;
  let onClose: number | null = null;
  for (const bar of bars) {
    const ms = Date.parse(bar.timestamp);
    if (ms < startMs || ms >= openMs) continue;
    if ((ms - startMs) % (BAR_MINUTES * MS_PER_MINUTE) !== 0) {
      throw new Error(`trend-day pre-open label reads 5m bars; ${bar.timestamp} is not on the 5m grid`);
    }
    barsPresent++;
    if (bar.high > onHigh) onHigh = bar.high;
    if (bar.low < onLow) onLow = bar.low;
    if (ms === lastStampMs) onClose = bar.close;
  }

  const neither = (structural: PreOpenStructural | null): PreOpenResult => ({
    label: "neither",
    structural,
    barsPresent,
    expectedBars,
  });

  if (barsPresent < params.onMinBarsShare * expectedBars) return neither("overnight-short");
  if (onClose == null) return neither("no-open-bar");
  const oldest = addCalendarDays(sessionDate, -PRIOR_SESSION_MAX_AGE_DAYS);
  let prior: ReferenceDay | null = null;
  for (let i = args.referenceDays.length - 1; i >= 0; i--) {
    if (args.referenceDays[i].sessionDate < sessionDate) {
      prior = args.referenceDays[i];
      break;
    }
  }
  if (!prior || prior.sessionDate < oldest) return neither("no-prior-session");
  const ref = refRangeTicks(args.referenceDays, sessionDate, params.refRangeDays);
  if (ref == null) return neither("ref-short");

  const gapTicks = pnlTicksFromPrices(prior.daySessionClose, onClose, 1, tickSize);
  const gapNeed = params.gapMult * ref;
  const posNeed = params.onPosMin * pnlTicksFromPrices(onLow, onHigh, 1, tickSize);
  let label: TrendDayLabel = "neither";
  if (gapTicks >= gapNeed && pnlTicksFromPrices(onLow, onClose, 1, tickSize) >= posNeed) {
    label = "green";
  } else if (-gapTicks >= gapNeed && pnlTicksFromPrices(onClose, onHigh, 1, tickSize) >= posNeed) {
    label = "red";
  }
  return { label, structural: null, barsPresent, expectedBars };
}
