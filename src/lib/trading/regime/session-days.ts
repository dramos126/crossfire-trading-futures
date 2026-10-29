/**
 * Completed session-day rows — the only input the classifier reads.
 *
 * One row per CME Globex session day (18:00→17:00 ET), built from 1m bars,
 * with every feature measured over the instrument's **day session** only
 * (MNQ/MES 09:30–16:00 ET). Mixing overnight and day-session bars is the
 * failure ORB v2 shipped: its tier compared an RTH opening range against an
 * ATR of pre-market bars, and 100% of 1,200 trades came back "wide". The
 * bucket is the Globex day; the measurement window is the cash session; the
 * two are different things and both are named.
 *
 * `rthTR` and `rthRange` are in **ticks**, through `pnlTicksFromPrices`, so
 * they are exact integers on every instrument — an MGC range subtracted in
 * doubles is 24.000000000000913, and a percentile rank that has to break
 * ties at a cutoff cannot be built on that.
 */
import type { BarData } from "@/lib/brokers/types";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import { pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";
import { isInDaySession } from "@/lib/trading/session/session-utils";
import { sessionDateOf } from "./session-dates";

export interface SessionDay {
  sessionDate: string;
  daySessionHigh: number;
  daySessionLow: number;
  daySessionClose: number;
  /** True range of the day session against the **prior** day-session close,
   *  in ticks. Null on the first row, which has no prior close. */
  rthTR: number | null;
  /** Day-session high − low, in ticks. */
  rthRange: number;
}

export interface BuildSessionDaysArgs {
  /** 1m bars, ascending, stamped at the **open** of each bar. */
  bars: BarData[];
  daySession: DaySessionWindow;
  tickSize: number;
}

/**
 * The window is `[start, end)` in ET wall-clock minutes — `isInDaySession`,
 * the predicate every day-session quantity shares.
 *
 * A session day with no day-session bar at all produces no row — a holiday
 * is an absent session, not a zero-range one, and a zero would poison every
 * trailing statistic that reads it.
 */
export function buildSessionDays(args: BuildSessionDaysArgs): SessionDay[] {
  const { bars, daySession, tickSize } = args;

  const order: string[] = [];
  const byDate = new Map<string, { high: number; low: number; close: number }>();

  for (const bar of bars) {
    const at = new Date(bar.timestamp);
    if (!isInDaySession(at, daySession)) continue;

    const sessionDate = sessionDateOf(at);
    const acc = byDate.get(sessionDate);
    if (!acc) {
      order.push(sessionDate);
      byDate.set(sessionDate, { high: bar.high, low: bar.low, close: bar.close });
      continue;
    }
    if (bar.high > acc.high) acc.high = bar.high;
    if (bar.low < acc.low) acc.low = bar.low;
    acc.close = bar.close;
  }

  order.sort();
  const days: SessionDay[] = [];
  let priorClose: number | null = null;
  for (const sessionDate of order) {
    const acc = byDate.get(sessionDate);
    if (!acc) continue;
    days.push({
      sessionDate,
      daySessionHigh: acc.high,
      daySessionLow: acc.low,
      daySessionClose: acc.close,
      rthTR:
        priorClose == null
          ? null
          : trueRangeTicks(acc.high, acc.low, priorClose, tickSize),
      rthRange: pnlTicksFromPrices(acc.low, acc.high, 1, tickSize),
    });
    priorClose = acc.close;
  }
  return days;
}

/** `max(high, priorClose) − min(low, priorClose)`, which is the three-term
 *  true range written once. */
function trueRangeTicks(
  high: number,
  low: number,
  priorClose: number,
  tickSize: number,
): number {
  const top = high > priorClose ? high : priorClose;
  const bottom = low < priorClose ? low : priorClose;
  return pnlTicksFromPrices(bottom, top, 1, tickSize);
}
