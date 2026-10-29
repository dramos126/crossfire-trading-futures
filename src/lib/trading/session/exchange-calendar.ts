/**
 * The exchange calendar the session-end flatten reads — the one place that
 * knows a declared `HH:MM` session window is not the whole story.
 *
 * A strategy's `config.session` is a fixed wall-clock pair with no calendar
 * term in it, and every session-end actor evaluated exactly that. On an
 * exchange early close the two paths then disagreed in opposite directions:
 * the engine's 15s clock guard fired at the configured window end into a
 * market that had shut hours earlier, and the backtest force-exited on the
 * first bar outside the window — which is the 18:00 Globex reopen, five hours
 * and one settlement later. Both wrong, which is what makes it a parity defect
 * rather than two bugs ([bugs.md](../../../../docs/bugs.md) A63).
 *
 * Both paths now read one calendar-aware answer from this module —
 * `isInTradableSessionWindow` off an instant, `isInTradableBar` off a bar —
 * and both take the exchange side from `isInEarlyCloseHalt` alone. Do not
 * special-case a half-day in the guard or in `backtest.ts`, and do not
 * re-compose the two terms at a call site; both are the shape this module
 * exists to prevent.
 *
 * **Which way an error here goes.** A date listed that is not really an early
 * close costs the afternoon of one session. A date missed carries a live
 * position through a five-hour news-bearing halt against a prop account's
 * trailing drawdown. So where two sources disagree on whether a date is an
 * early close, it is listed; where they disagree on the *time*, the earlier
 * one is taken.
 */

import type { SessionWindow } from "../strategy-types";
import { etDateKey, minutesInTradingTz } from "./session-utils";
import { isInAnySessionWindow, parseHHMM } from "./session";

/**
 * **CME equity-index early closes** — ET date → the published ET `HH:MM` at
 * which Globex halts equity-index futures. Dates absent from this map trade a
 * full session, which is why the horizon below is not optional.
 *
 * Distinct from `tom-hold`'s `GLOBEX_FULL_CLOSURES`, which lists dates with no
 * session *at all*. The two tables answer different questions and neither is
 * derivable from the other; a full closure needs no session-end rule because
 * nothing can be open on a day that never opened. Merging them is a follow-up
 * with its own review, not a line in this change. **That disjointness is not
 * quite true today and the exception is named below**: both tables list
 * 2025-01-09, which halted at its own cash open.
 *
 * Four groups, and each has its own provenance:
 *
 * - **13:00 ET** (12:00 CT) — MLK, Presidents' Day, Memorial Day, Juneteenth,
 *   Labor Day, Thanksgiving Day itself, and every Independence Day session:
 *   July 3 when it is a weekday, **July 4 itself when it is a weekday**, and
 *   the observed holiday when July 4 falls on a weekend. CME Group's published
 *   holiday calendar. **The rule is "the holiday itself is a session"** — CME
 *   equity index closes outright on exactly three days a year (New Year's Day,
 *   Good Friday, Christmas), and on every other federal holiday it trades the
 *   overnight and the cash morning and halts at noon CT. Reading July 4 as a
 *   closure because the cash equity market is shut is the mistake this row
 *   family exists to stop; see the note below.
 * - **13:15 ET** (12:15 CT) — the day after Thanksgiving, and Christmas Eve
 *   when it is a weekday. These two are the only 12:15 CT closes CME
 *   publishes for equity index.
 * - **09:15 ET** (08:15 CT) — Good Friday in the years a scheduled 08:30 ET
 *   macro print falls on it, when CME holds equity-index futures open through
 *   the release instead of closing for the day: Globex trades from the 18:00
 *   reopen the evening before and halts 45 minutes after the print, before the
 *   cash open. CME's 2023 notice says 08:15 CT, and the archive agrees — the
 *   last 1m bar is 09:14 ET on ES, MES, NQ, MNQ, YM and MYM on 2021-04-02,
 *   2023-04-07 and 2026-04-03 (2024-03-29 holds no bars, which settles
 *   nothing). These rows said 10:15 until 2026-10-23 (A93), which held the
 *   halt term an hour past a shut market. **The rule is the
 *   print, not the payrolls report specifically**, and that distinction is
 *   what a future hand extends this table by: 2023-04-07 and 2026-04-03 carry
 *   March NFP, but 2024-03-29 carries February PCE — March 2024's payrolls
 *   printed on 2024-04-05. A Good Friday with no 08:30 print is a full
 *   closure and belongs to the other table (2025-04-18, 2027-03-26).
 *   **These are the earliest closes here and the most dangerous to miss** — a
 *   position held overnight into the print must be flat by 09:10, and a
 *   09:30–15:55 playbook has no tradable minute on these days at all.
 * - **09:30 ET** — the 2025-01-09 national day of mourning alone, where CME
 *   held equity index open only to 08:30 CT. That is the cash open, so the
 *   session listed here never traded a cash minute; it is a row rather than an
 *   omission because an absent date silently means *full session*.
 *   **`tom-hold`'s `GLOBEX_FULL_CLOSURES` lists this same date**, which
 *   contradicts the claim above that the two tables answer disjoint questions.
 *   Both readings are defensible for a session that halts at its own open, and
 *   neither table is wrong about behaviour; the overlap is recorded here and
 *   settled by the merge that note names, not by reaching into the other one.
 *
 * **Why July 4 carries its own row.** The three weekday Independence Days in
 * this span — 2023-07-04, 2024-07-04, 2025-07-04 — had no row until
 * 2026-09-25, so a 09:30–15:55 playbook read them as full sessions and would
 * have flattened at 15:55 into an exchange that halted at 13:00. The cache
 * holds 210 contiguous 1m bars from 09:30 to 12:59 on each, on ES and MNQ
 * alike, at holiday volume (19k–37k against 27k–44k on MLK, Memorial and
 * Labor Day, and 770k–990k on the neighbouring full sessions), and Globex
 * reopened at 18:00 the prior evening for the trade date — which it does not
 * do before a real closure: Christmas Eve 2024 stops at 13:14 with no reopen
 * and Christmas Day holds nothing before 18:00.
 *
 * **Bars present may add a row; bars absent settle nothing.** A cache cannot
 * manufacture a trade, so prints are a fact about the exchange. An empty day
 * is a fact about this cache: the same scan finds no day bars on the three
 * print-day Good Fridays above — they halt at 09:15, so there are none to
 * find, and they were sessions all the same (overnight bars to 09:14 on the
 * dates the archive holds); none on fifteen
 * quarterly-expiry Fridays, which are `.c.0` continuous-series roll gaps on
 * ordinary full sessions; and none on 2023-01-02, which is a genuine full
 * closure and the other table's business. **No date is removed from here, or
 * read as a closure, on an empty cache.**
 *
 * **Why July 3 sits at 13:00, and what the 1m tape says.** The census in
 * [punchlist.md](../../../../docs/punchlist.md) counted 30m bucket coverage and
 * grouped July 3 with the 13:15 dates; that count could not carry the decision
 * at its resolution, and this note asked for 1m coverage between 13:00 and
 * 13:15 ET. **That measurement was taken 2026-09-25 and it favours 13:15**:
 * all three July 3 sessions hold 225 contiguous bars to 13:14 at 428k–580k
 * contracts, the shape and volume class of the acknowledged 13:15 rows, where
 * every 13:00 row stops at 12:59. **The rows stay at 13:00 anyway** — two
 * published holiday calendars say 12:00 CT, the error-direction rule takes the
 * earlier time when sources disagree, and being early costs fifteen minutes of
 * a thin pre-holiday afternoon. Moving them to 13:15 moves a live flatten
 * *later*, which is the dangerous direction, so it wants a published CME
 * advisory and a reviewer rather than this measurement alone.
 *
 * 2027 is derived rather than sourced: the federal-holiday rule fixes each
 * date and CME's pattern around them has been stable for the whole span above.
 * The one genuinely ambiguous case is Independence Day 2027, which falls on a
 * Sunday — the observed holiday is Monday July 5 and the pre-holiday early
 * close is Friday July 2, and published notices have put the shortened session
 * on either. Both are listed and both at 13:00, on the error-direction rule at
 * the top of this file and the Independence Day rule above: one lost afternoon
 * against a five-hour carry.
 */
export const CME_EARLY_CLOSES: ReadonlyMap<string, string> = new Map([
  // 2023
  ["2023-01-16", "13:00"], // MLK Day
  ["2023-02-20", "13:00"], // Presidents' Day
  ["2023-04-07", "09:15"], // Good Friday, held open for March NFP
  ["2023-05-29", "13:00"], // Memorial Day
  ["2023-06-19", "13:00"], // Juneteenth
  ["2023-07-03", "13:00"], // day before Independence Day
  ["2023-07-04", "13:00"], // Independence Day itself — a session, not a closure
  ["2023-09-04", "13:00"], // Labor Day
  ["2023-11-23", "13:00"], // Thanksgiving Day
  ["2023-11-24", "13:15"], // day after Thanksgiving
  // Christmas Eve 2023 fell on a Sunday — no session, so no row.
  // 2024
  ["2024-01-15", "13:00"], // MLK Day
  ["2024-02-19", "13:00"], // Presidents' Day
  ["2024-03-29", "09:15"], // Good Friday, held open for February PCE
  ["2024-05-27", "13:00"], // Memorial Day
  ["2024-06-19", "13:00"], // Juneteenth
  ["2024-07-03", "13:00"], // day before Independence Day
  ["2024-07-04", "13:00"], // Independence Day itself — a session, not a closure
  ["2024-09-02", "13:00"], // Labor Day
  ["2024-11-28", "13:00"], // Thanksgiving Day
  ["2024-11-29", "13:15"], // day after Thanksgiving
  ["2024-12-24", "13:15"], // Christmas Eve
  // 2025
  ["2025-01-09", "09:30"], // national day of mourning — 08:30 CT, the cash open
  ["2025-01-20", "13:00"], // MLK Day
  ["2025-02-17", "13:00"], // Presidents' Day
  ["2025-05-26", "13:00"], // Memorial Day
  ["2025-06-19", "13:00"], // Juneteenth
  ["2025-07-03", "13:00"], // day before Independence Day
  ["2025-07-04", "13:00"], // Independence Day itself — a session, not a closure
  ["2025-09-01", "13:00"], // Labor Day
  ["2025-11-27", "13:00"], // Thanksgiving Day
  ["2025-11-28", "13:15"], // day after Thanksgiving
  ["2025-12-24", "13:15"], // Christmas Eve
  // 2026
  ["2026-01-19", "13:00"], // MLK Day
  ["2026-02-16", "13:00"], // Presidents' Day
  ["2026-04-03", "09:15"], // Good Friday, held open for March NFP
  ["2026-05-25", "13:00"], // Memorial Day
  ["2026-06-19", "13:00"], // Juneteenth
  ["2026-07-03", "13:00"], // Independence Day observed (the 4th is a Saturday)
  ["2026-09-07", "13:00"], // Labor Day
  ["2026-11-26", "13:00"], // Thanksgiving Day
  ["2026-11-27", "13:15"], // day after Thanksgiving
  ["2026-12-24", "13:15"], // Christmas Eve
  // 2027 — derived, see the note above
  ["2027-01-18", "13:00"], // MLK Day
  ["2027-02-15", "13:00"], // Presidents' Day
  ["2027-05-31", "13:00"], // Memorial Day
  ["2027-06-18", "13:00"], // Juneteenth observed (the 19th is a Saturday)
  ["2027-07-02", "13:00"], // Independence Day falls on a Sunday — both
  ["2027-07-05", "13:00"], // candidate sessions are listed
  ["2027-09-06", "13:00"], // Labor Day
  ["2027-11-25", "13:00"], // Thanksgiving Day
  ["2027-11-26", "13:15"], // day after Thanksgiving
  ["2027-12-24", "13:15"], // Christmas Eve
]);

/**
 * The span {@link CME_EARLY_CLOSES} is complete over, as ET dates.
 *
 * **Both ends are load-bearing and neither may be inferred away.** Past the
 * far end the platform does not know whether a date is an early close, and
 * *"absent from the map"* would silently mean *"trades a full session"* —
 * which is exactly the assumption A63 is about. Before the near end the same
 * is true of a backtest run over older bars.
 *
 * The behaviour past the horizon is deliberately **loud, not restrictive**:
 * the session guard escalates (see `CALENDAR_HORIZON_*` below) and the
 * backtest emits a warning, and neither stands an account down. Standing down
 * converts a table that needs ten minutes of editing into a certain loss of
 * every session; the exposure it would be buying off is nine or ten sessions a
 * year, each of them announced a month ahead.
 */
export const EARLY_CLOSE_CALENDAR_FROM = "2023-01-01";
export const EARLY_CLOSE_CALENDAR_THROUGH = "2027-12-31";

/**
 * How early the flatten lands relative to the exchange's published halt.
 *
 * **A market order submitted at the halt second is the same failure A63
 * describes, three hours earlier** — every flatten actor in this platform
 * closes by submitting a market order, and no market order fills into a
 * closed exchange. The number is the one the repo already runs on: `orb` and
 * `ema-bounce` declare `15:55` against a 16:00 cash close for exactly this
 * reason, and `SESSION_BLACKOUT_RANGES` documents that five minutes as the
 * cushion before Topstep starts tearing brackets down.
 *
 * **Deliberately a constant rather than each module's own 16:00-minus-window
 * distance.** Deriving it would give a playbook that declares `15:30` a
 * thirty-minute cushion on a half-day, and that `15:30` is a statement about
 * late-day chop, not about the close.
 */
export const EARLY_CLOSE_FLATTEN_CUSHION_MIN = 5;

/** 18:00 ET — when Globex reopens after an early close, for the next trade
 *  date. The same boundary `currentCmeSessionStart` and
 *  `isInMaintenanceWindow` already turn on. */
const GLOBEX_REOPEN_MIN = 18 * 60;

const DAY_MS = 86_400_000;

/** The published ET halt time for an ET date, or null when the date trades a
 *  full session **or lies outside the calendar's span** — the caller that
 *  needs to tell those apart asks {@link calendarHorizonState}. */
export function earlyCloseFor(etDate: string): string | null {
  return CME_EARLY_CLOSES.get(etDate) ?? null;
}

/**
 * True when `instant` falls in the stretch of its ET date that the platform
 * treats as shut because the exchange closes early that day — from the
 * published halt minus {@link EARLY_CLOSE_FLATTEN_CUSHION_MIN} up to the
 * 18:00 ET reopen. The cushion means this is true *before* the halt, so the
 * prose around it is future tense at the moment it first answers true.
 *
 * **This is the exchange-side term, and it is the only one.** Both composites
 * below — the engine's instant predicate and the backtest's bar predicate —
 * reach the calendar through this function and nothing else, so a term added
 * here (the full-closure table named above is the queued one) lands on both
 * paths at once. A caller that ANDs a calendar term in itself re-creates A63
 * in the shape the Decisions entry in
 * [engine.md](../../../../docs/modules/trading/engine.md) forbids.
 *
 * **Bounded at the reopen rather than running to midnight**, because Globex
 * comes back at 18:00 for the next trade date and an overnight window is
 * genuinely tradable then. Clamping to end-of-day would silently close every
 * overnight playbook on nine dates a year.
 *
 * One residual, and it is deliberate: when the day *after* an early close is a
 * full closure — Christmas Eve into Christmas Day, July 3 into July 4 — there
 * is no 18:00 reopen, and this returns false for that evening. Answering it
 * would need the full-closure table, which is `tom-hold`'s and is not merged
 * here. Nothing is exposed by it: the position was flattened at the halt and
 * no bar prints afterwards to open another.
 */
export function isInEarlyCloseHalt(instant: Date): boolean {
  const close = earlyCloseFor(etDateKey(instant));
  if (close == null) return false;
  const closeMin = parseHHMM(close);
  if (closeMin == null) return false;
  const minute = minutesInTradingTz(instant);
  return minute >= closeMin - EARLY_CLOSE_FLATTEN_CUSHION_MIN && minute < GLOBEX_REOPEN_MIN;
}

/**
 * **The session-end definition every engine actor reads**, off an instant.
 *
 * The declared window says when the playbook wants to be armed; the calendar
 * says whether the exchange is there to fill it. A caller that asks only the
 * first is the A63 defect, whichever side of the parity contract it sits on.
 *
 * The engine passes the wall clock, which at a decision point *is* the closing
 * bar's close. A caller holding a bar rather than an instant asks
 * {@link isInTradableBar} instead of composing the two terms itself.
 */
export function isInTradableSessionWindow(
  instant: Date,
  windows: ReadonlyArray<SessionWindow>,
): boolean {
  return isInAnySessionWindow(instant, windows) && !isInEarlyCloseHalt(instant);
}

/**
 * The same definition for a caller holding a **bar** — `backtest.ts`, whose
 * `bar.timestamp` is the bar's open.
 *
 * **The asymmetry is the whole reason this is a function rather than one call
 * to {@link isInTradableSessionWindow}**: the window term reads the bar's
 * *open* and the calendar term reads its *close*. Moving the window term onto
 * the close would shift every normal-day force-exit by one bar and invalidate
 * all 34 recorded artifacts on every trade, which is a different change; the
 * calendar term is new, so it is free to ask at the instant that is actually
 * correct — the bar that *ends* at the halt is the session's last.
 *
 * It lives here rather than at the call site so that the two paths cannot
 * drift: both composites take the exchange side from {@link isInEarlyCloseHalt}
 * alone. On a date with no calendar row the calendar term is constantly false
 * and this is exactly the window term, which is what makes an ordinary session
 * bit-for-bit what it was.
 */
export function isInTradableBar(
  barOpen: Date,
  barLengthMs: number,
  windows: ReadonlyArray<SessionWindow>,
): boolean {
  return (
    isInAnySessionWindow(barOpen, windows) &&
    !isInEarlyCloseHalt(new Date(barOpen.getTime() + barLengthMs))
  );
}

/** Days out from the far end of the calendar at which the guard starts saying
 *  so at `warn`. A quarter is enough lead for the table edit to be scheduled
 *  rather than reacted to. */
export const CALENDAR_HORIZON_WARN_DAYS = 90;

/** Days out at which it escalates to `error`. Deliberately *before* the
 *  horizon, not after it: an alarm that first sounds once the platform is
 *  already assuming a normal close has waited until the exposure is live. */
export const CALENDAR_HORIZON_ESCALATE_DAYS = 30;

export type CalendarHorizonState = "fresh" | "approaching" | "stale";

/**
 * How much calendar is left, relative to an instant's ET date.
 *
 * `stale` is *past the horizon* — the platform can no longer tell an early
 * close from a normal one and is assuming normal. `approaching` is the last
 * {@link CALENDAR_HORIZON_WARN_DAYS} before that, escalating at
 * {@link CALENDAR_HORIZON_ESCALATE_DAYS}. `daysRemaining` is negative once
 * stale, so a caller can say how long it has been.
 */
export function calendarHorizonState(instant: Date): {
  state: CalendarHorizonState;
  daysRemaining: number;
} {
  const daysRemaining = daysBetweenEtDates(etDateKey(instant), EARLY_CLOSE_CALENDAR_THROUGH);
  if (daysRemaining < 0) return { state: "stale", daysRemaining };
  if (daysRemaining <= CALENDAR_HORIZON_WARN_DAYS) return { state: "approaching", daysRemaining };
  return { state: "fresh", daysRemaining };
}

/** True when an ET date falls outside the span the calendar is complete over,
 *  at either end. The backtest's question — its bars can predate
 *  {@link EARLY_CLOSE_CALENDAR_FROM} as easily as a live clock can outrun the
 *  other end. */
export function isOutsideCalendarSpan(etDate: string): boolean {
  return etDate < EARLY_CLOSE_CALENDAR_FROM || etDate > EARLY_CLOSE_CALENDAR_THROUGH;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Both parse to UTC
 *  midnight, so the difference is an exact multiple of a day and the division
 *  carries no float error. */
function daysBetweenEtDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
