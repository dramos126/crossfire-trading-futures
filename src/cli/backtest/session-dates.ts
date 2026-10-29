/**
 * The CLI's half of session-date handling: parsing a flag into a session
 * date, and the month arithmetic the walk-forward fold geometry is cut on.
 *
 * The calendar itself — what a session date *is*, and the ET arithmetic
 * behind it — belongs to the classifier and lives in
 * [`regime/session-dates.ts`](../../lib/trading/regime/session-dates.ts).
 * Callers here import the two halves from their own homes; this file does
 * not re-export the other one.
 */
import { addCalendarDays } from "@/lib/trading/regime/session-dates";
import { CliError } from "./cli-error";

const SESSION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSessionDate(value: string, flag: string): string {
  if (!SESSION_DATE_RE.test(value)) {
    throw new CliError(`${flag} must be a session date as YYYY-MM-DD, got "${value}"`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (
    asUtc.getUTCFullYear() !== y ||
    asUtc.getUTCMonth() !== m - 1 ||
    asUtc.getUTCDate() !== d
  ) {
    throw new CliError(`${flag} is not a real calendar date: "${value}"`);
  }
  return value;
}

// ── Month arithmetic, for walk-forward fold geometry ────────────────────

export function monthKeyOf(sessionDate: string): string {
  return sessionDate.slice(0, 7);
}

export function addMonths(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Whole months from `a` to `b`, `b` exclusive of nothing — a plain diff. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}

export function firstDayOfMonth(monthKey: string): string {
  return `${monthKey}-01`;
}

export function lastDayOfMonth(monthKey: string): string {
  const next = addMonths(monthKey, 1);
  return addCalendarDays(firstDayOfMonth(next), -1);
}
