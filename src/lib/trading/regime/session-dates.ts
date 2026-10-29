/**
 * The session-day calendar the regime label is defined on, in Eastern Time.
 *
 * A **session date** names one CME Globex day: session date `D` runs from
 * 18:00 ET on the preceding calendar day to 17:00 ET on `D`, with the
 * 17:00–18:00 ET maintenance break between two of them.
 *
 * It lives here rather than in the CLI because the classifier is the thing
 * that defines "one session day", and phase 2 runs the classifier inside the
 * engine where no CLI exists. The backtest CLI imports it; nothing here
 * imports the CLI.
 *
 * Everything is pure and ET-aware through `Intl`, never through a fixed UTC
 * offset — half the year is EDT and half EST, and a fixed offset silently
 * moves every window by an hour for six months.
 */

import { MINUTE_CACHE_CAP, memoiseByUtcMinute } from "@/lib/trading/session/session-utils";

const ET_TIME_ZONE = "America/New_York";
const SESSION_OPEN_HOUR_ET = 18;
const SESSION_CLOSE_HOUR_ET = 17;
const MS_PER_DAY = 86_400_000;
const SATURDAY = 6;
const SUNDAY = 0;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function etParts(at: Date): EtParts {
  const found: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(at)) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return {
    year: found.year,
    month: found.month,
    day: found.day,
    hour: found.hour,
    minute: found.minute,
    second: found.second,
  };
}

/** Offset of ET from UTC at `at`, in ms (negative — ET is behind UTC). */
function etOffsetMs(at: Date): number {
  const p = etParts(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime();
}

/**
 * The UTC instant at which an ET wall clock reads `y-mo-da hh:mi`.
 *
 * Two passes: the first offset is looked up at the naive instant, which is
 * on the wrong side of a DST boundary for one hour twice a year; re-reading
 * the offset at the corrected instant settles it.
 */
export function etWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - etOffsetMs(new Date(naive));
  return new Date(naive - etOffsetMs(new Date(first)));
}

export function splitSessionDate(sessionDate: string): [number, number, number] {
  const [y, m, d] = sessionDate.split("-").map(Number);
  return [y, m, d];
}

export function formatSessionDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 18:00 ET on the calendar day before `sessionDate`. */
export function sessionStartUtc(sessionDate: string): Date {
  const prior = addCalendarDays(sessionDate, -1);
  const [y, m, d] = splitSessionDate(prior);
  return etWallClockToUtc(y, m, d, SESSION_OPEN_HOUR_ET, 0);
}

/** 17:00 ET on `sessionDate`. */
export function sessionEndUtc(sessionDate: string): Date {
  const [y, m, d] = splitSessionDate(sessionDate);
  return etWallClockToUtc(y, m, d, SESSION_CLOSE_HOUR_ET, 0);
}

/**
 * The session date a timestamp falls in. 18:00 ET and later belongs to the
 * next calendar day's session; the 17:00–18:00 ET break stays with the
 * session that just closed, which is where a stray late bar reads most
 * honestly.
 */
export function sessionDateOf(at: Date): string {
  return sessionDateOfMinute(at);
}

// Memoised because the CLI asks it of every bar in every window, and a sweep
// runs the same training window once per grid point. The answer turns on the
// ET date and hour only, so the minute memo's soundness argument holds.
const sessionDateOfMinute = memoiseByUtcMinute((at: Date) => {
  const p = etParts(at);
  const sameDay = formatSessionDate(p.year, p.month, p.day);
  return p.hour >= SESSION_OPEN_HOUR_ET ? addCalendarDays(sameDay, 1) : sameDay;
}, MINUTE_CACHE_CAP);

export function addCalendarDays(sessionDate: string, days: number): string {
  const [y, m, d] = splitSessionDate(sessionDate);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return formatSessionDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

function isWeekend(sessionDate: string): boolean {
  const [y, m, d] = splitSessionDate(sessionDate);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === SATURDAY || dow === SUNDAY;
}

/**
 * Walk back `count` **weekdays** from `sessionDate`.
 *
 * Weekends are skipped; holidays are not, because a holiday calendar would
 * be a second source of truth this reads only to size a warmup window. So
 * `count` weekdays back spans **fewer than `count` sessions** — every
 * holiday inside the span is a weekday that produced no session-day row.
 * The error is in the direction of too little history, not too much: a
 * caller that needs a guaranteed number of completed rows has to count the
 * rows it got and extend (the backtest CLI's `loadRunBars` does).
 */
export function shiftSessionDatesBack(sessionDate: string, count: number): string {
  let cursor = sessionDate;
  for (let i = 0; i < count; i++) {
    do {
      cursor = addCalendarDays(cursor, -1);
    } while (isWeekend(cursor));
  }
  return cursor;
}

export function etHourOf(at: Date): number {
  return etParts(at).hour;
}

/** 0 = Sunday, in ET. */
export function etWeekdayOf(at: Date): number {
  const p = etParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}
