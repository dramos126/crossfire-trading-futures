/**
 * The exchange calendar behind the session-end flatten.
 *
 * Two kinds of test here and they guard different things. The behavioural
 * ones pin the halt's edges — the cushion at the front, the 18:00 Globex
 * reopen at the back — because both are the difference between flattening
 * early and flattening into a closed exchange. The table ones are hygiene
 * over a hand-maintained list of dates: a typo there is silent, and the way
 * it fails is a position carried through a five-hour halt.
 */

import { describe, it, expect } from "vitest";
import type { SessionWindow } from "../strategy-types";
import { parseHHMM } from "./session";
import {
  CALENDAR_HORIZON_ESCALATE_DAYS,
  CALENDAR_HORIZON_WARN_DAYS,
  CME_EARLY_CLOSES,
  EARLY_CLOSE_CALENDAR_FROM,
  EARLY_CLOSE_CALENDAR_THROUGH,
  EARLY_CLOSE_FLATTEN_CUSHION_MIN,
  calendarHorizonState,
  earlyCloseFor,
  isInEarlyCloseHalt,
  isInTradableBar,
  isInTradableSessionWindow,
  isOutsideCalendarSpan,
} from "./exchange-calendar";

/** `HH:MM` ET on an ET date, as a UTC instant. Both dates used below are in
 *  standard time, so ET = UTC−5; `offsetHours` says so at each call site
 *  rather than being inferred. */
function et(date: string, hhmm: string, offsetHours = 5): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + offsetHours, min, 0));
}

/** Thanksgiving Day 2026: a 13:00 ET halt. */
const HALF_DAY = "2026-11-26";
/** The Wednesday before it: a full session. */
const FULL_DAY = "2026-11-25";
/** Good Friday 2026, held open to 09:15 ET for the March NFP — the earliest
 *  close in the table, and one that halts before the cash open, so a declared
 *  09:30–15:55 window has no tradable minute on it (A93). */
const NFP_GOOD_FRIDAY = "2026-04-03";
/** Independence Day 2024, a Thursday. The 4th is a session, not a closure:
 *  Globex reopened at 18:00 on the 3rd for this trade date and halted at
 *  13:00 ET here, exactly as on the other federal holidays CME does not close
 *  outright. It carried no row until 2026-09-25. */
const JULY_FOURTH = "2024-07-04";

const DAY_WINDOW: SessionWindow[] = [{ start: "09:30", end: "15:55" }];

describe("isInEarlyCloseHalt", () => {
  it("is false all day on a session the calendar has no row for", () => {
    for (const hhmm of ["09:30", "12:55", "13:00", "15:55", "17:30"]) {
      expect(isInEarlyCloseHalt(et(FULL_DAY, hhmm))).toBe(false);
    }
  });

  it("starts the cushion ahead of the published halt, not at it", () => {
    // A market order submitted at the halt second is the same failure A63
    // describes, three hours earlier.
    expect(isInEarlyCloseHalt(et(HALF_DAY, "12:54"))).toBe(false);
    expect(isInEarlyCloseHalt(et(HALF_DAY, "12:55"))).toBe(true);
    expect(EARLY_CLOSE_FLATTEN_CUSHION_MIN).toBe(5);
  });

  it("runs to the 18:00 Globex reopen and stops there", () => {
    // Bounded at the reopen rather than at midnight: an overnight window is
    // genuinely tradable from 18:00 for the next trade date, and clamping to
    // end-of-day would close every overnight playbook on nine dates a year.
    expect(isInEarlyCloseHalt(et(HALF_DAY, "15:55"))).toBe(true);
    expect(isInEarlyCloseHalt(et(HALF_DAY, "17:59"))).toBe(true);
    expect(isInEarlyCloseHalt(et(HALF_DAY, "18:00"))).toBe(false);
  });

  it("leaves the morning of an early-close session open", () => {
    // The session opened at 18:00 the previous evening and runs to the halt;
    // an overnight or pre-open window on this date is unaffected.
    expect(isInEarlyCloseHalt(et(HALF_DAY, "03:00"))).toBe(false);
    expect(isInEarlyCloseHalt(et(HALF_DAY, "09:30"))).toBe(false);
  });

  it("handles a 09:15 Good Friday, the earliest close in the table", () => {
    // EDT on 2026-04-03, so ET = UTC−4. The last 1m bar on every equity
    // contract opens at 09:14 ET (A93), so the flatten lands at 09:10 — an
    // overnight position is out before the halt, not ten minutes after it.
    expect(isInEarlyCloseHalt(et(NFP_GOOD_FRIDAY, "09:09", 4))).toBe(false);
    expect(isInEarlyCloseHalt(et(NFP_GOOD_FRIDAY, "09:10", 4))).toBe(true);
    expect(isInEarlyCloseHalt(et(NFP_GOOD_FRIDAY, "10:15", 4))).toBe(true);
  });

  it("leaves no cash bar tradable on a 09:15 Good Friday", () => {
    const open = et(NFP_GOOD_FRIDAY, "09:30", 4);
    expect(isInTradableSessionWindow(open, DAY_WINDOW)).toBe(false);
    expect(isInTradableBar(open, 60_000, DAY_WINDOW)).toBe(false);
  });
});

describe("isInTradableSessionWindow", () => {
  it("is the declared window on a full session", () => {
    expect(isInTradableSessionWindow(et(FULL_DAY, "10:30"), DAY_WINDOW)).toBe(true);
    expect(isInTradableSessionWindow(et(FULL_DAY, "15:55"), DAY_WINDOW)).toBe(false);
  });

  it("ends the session at the calendar's halt even though the window is still open", () => {
    expect(isInTradableSessionWindow(et(HALF_DAY, "12:54"), DAY_WINDOW)).toBe(true);
    expect(isInTradableSessionWindow(et(HALF_DAY, "12:55"), DAY_WINDOW)).toBe(false);
    // And it does not come back when the declared window ends, which is where
    // the clock guard used to fire.
    expect(isInTradableSessionWindow(et(HALF_DAY, "15:55"), DAY_WINDOW)).toBe(false);
  });

  it("ends Independence Day itself at the halt, not at the declared window end", () => {
    // EDT, so ET = UTC−4. The gap this pins: July 3 carried a row and July 4
    // did not, so a leg open at 12:55 rode a shut exchange to 15:55.
    expect(isInTradableSessionWindow(et(JULY_FOURTH, "12:30", 4), DAY_WINDOW)).toBe(true);
    expect(isInTradableSessionWindow(et(JULY_FOURTH, "12:55", 4), DAY_WINDOW)).toBe(false);
    expect(isInTradableSessionWindow(et(JULY_FOURTH, "15:55", 4), DAY_WINDOW)).toBe(false);
  });

  it("does not open a window the calendar left alone", () => {
    // The calendar can only ever subtract. A leg outside its declared window
    // is out of session whatever the exchange is doing.
    expect(isInTradableSessionWindow(et(HALF_DAY, "19:00"), DAY_WINDOW)).toBe(false);
  });
});

describe("isInTradableBar", () => {
  const MIN_MS = 60_000;
  /** The 1m bar that *opens* at `minuteOfDay` ET on `date`. */
  function bar(date: string, minuteOfDay: number): Date {
    return et(date, `${Math.floor(minuteOfDay / 60)}:${String(minuteOfDay % 60).padStart(2, "0")}`);
  }

  it("ends the session on the bar that closes at the halt, not on the reopen", () => {
    // 12:54 opens the last bar of the session — it closes at 12:55, which is
    // the halt once the cushion is applied, and that bar is still tradable.
    expect(isInTradableBar(bar(HALF_DAY, 12 * 60 + 53), MIN_MS, DAY_WINDOW)).toBe(true);
    expect(isInTradableBar(bar(HALF_DAY, 12 * 60 + 54), MIN_MS, DAY_WINDOW)).toBe(false);
    expect(isInTradableBar(bar(HALF_DAY, 15 * 60 + 30), MIN_MS, DAY_WINDOW)).toBe(false);
  });

  it("is exactly the declared window on a full session", () => {
    expect(isInTradableBar(bar(FULL_DAY, 9 * 60 + 29), MIN_MS, DAY_WINDOW)).toBe(false);
    expect(isInTradableBar(bar(FULL_DAY, 9 * 60 + 30), MIN_MS, DAY_WINDOW)).toBe(true);
    expect(isInTradableBar(bar(FULL_DAY, 15 * 60 + 54), MIN_MS, DAY_WINDOW)).toBe(true);
    expect(isInTradableBar(bar(FULL_DAY, 15 * 60 + 55), MIN_MS, DAY_WINDOW)).toBe(false);
  });

  /**
   * **The pin on the composition itself**, and the reason `backtest.ts` calls
   * this rather than ANDing the two terms at its own call site: a term added
   * to one composite and not the other is A63 re-created.
   *
   * Inside the declared window the bar's open and its close are both in
   * window, so the only thing either predicate can be answering is the
   * exchange-side term — and the two must agree minute for minute. This fails
   * if the engine's predicate ever grows a calendar term the bar predicate
   * does not (or the reverse).
   */
  it("shares its exchange term with the engine's predicate, minute for minute", () => {
    for (const date of [HALF_DAY, FULL_DAY]) {
      for (let m = 9 * 60 + 30; m < 15 * 60 + 54; m++) {
        const open = bar(date, m);
        const close = new Date(open.getTime() + MIN_MS);
        expect(isInTradableBar(open, MIN_MS, DAY_WINDOW), `${date} ${m}`).toBe(
          isInTradableSessionWindow(close, DAY_WINDOW),
        );
      }
    }
  });

  it("keeps the window term on the open, which is where the two legitimately differ", () => {
    // The last bar of a full session: its close is 15:55, outside the window,
    // and the engine's instant predicate says so. The bar predicate keeps it,
    // because moving the *window* term onto the close would shift every
    // normal-day force-exit by one bar and invalidate the recorded artifacts.
    const last = bar(FULL_DAY, 15 * 60 + 54);
    expect(isInTradableBar(last, MIN_MS, DAY_WINDOW)).toBe(true);
    expect(isInTradableSessionWindow(new Date(last.getTime() + MIN_MS), DAY_WINDOW)).toBe(false);
  });
});

describe("calendarHorizonState", () => {
  it("is fresh well before the horizon", () => {
    expect(calendarHorizonState(et("2027-06-01", "12:00", 4)).state).toBe("fresh");
  });

  it("turns at the warn boundary and again at the escalate boundary", () => {
    const warn = calendarHorizonState(et("2027-11-02", "12:00", 4));
    expect(warn.state).toBe("approaching");
    expect(warn.daysRemaining).toBeGreaterThan(CALENDAR_HORIZON_ESCALATE_DAYS);
    expect(warn.daysRemaining).toBeLessThanOrEqual(CALENDAR_HORIZON_WARN_DAYS);

    const escalate = calendarHorizonState(et("2027-12-10", "12:00"));
    expect(escalate.state).toBe("approaching");
    expect(escalate.daysRemaining).toBeLessThanOrEqual(CALENDAR_HORIZON_ESCALATE_DAYS);
  });

  it("goes stale the day after the horizon, and says how long ago", () => {
    expect(calendarHorizonState(et(EARLY_CLOSE_CALENDAR_THROUGH, "12:00")).state).toBe(
      "approaching",
    );
    const stale = calendarHorizonState(et("2028-01-31", "12:00"));
    expect(stale.state).toBe("stale");
    expect(stale.daysRemaining).toBe(-31);
  });
});

describe("isOutsideCalendarSpan", () => {
  it("guards both ends — a run over older bars is the same silent assumption", () => {
    expect(isOutsideCalendarSpan("2022-12-31")).toBe(true);
    expect(isOutsideCalendarSpan(EARLY_CLOSE_CALENDAR_FROM)).toBe(false);
    expect(isOutsideCalendarSpan(EARLY_CLOSE_CALENDAR_THROUGH)).toBe(false);
    expect(isOutsideCalendarSpan("2028-01-01")).toBe(true);
  });
});

describe("CME_EARLY_CLOSES — table hygiene", () => {
  it("is non-empty and reachable through the accessor", () => {
    // A renamed or emptied table would make every assertion below vacuous.
    expect(CME_EARLY_CLOSES.size).toBeGreaterThan(40);
    expect(earlyCloseFor(HALF_DAY)).toBe("13:00");
    expect(earlyCloseFor(FULL_DAY)).toBeNull();
  });

  it("holds only parseable ET times inside the cash day", () => {
    for (const [date, time] of CME_EARLY_CLOSES) {
      const minute = parseHHMM(time);
      expect(minute, `${date} → ${time}`).not.toBeNull();
      // Anything at or past 16:00 is not an early close. A row before the
      // 09:30 open is a session that halts before the open — the print-day
      // Good Fridays at 09:15, which trade overnight for an 08:30 release —
      // and the 2025-01-09 day of mourning sits on the open itself. Both are
      // rows rather than omissions because an absent date silently means
      // "full session". 09:15 is the floor: nothing earlier has been published,
      // and a row below it is more likely a typo than a session.
      expect(minute, `${date} → ${time}`).toBeGreaterThanOrEqual(9 * 60 + 15);
      expect(minute, `${date} → ${time}`).toBeLessThan(16 * 60);
    }
  });

  /**
   * The rows a reviewer twice read the wrong way, pinned so the next reading
   * has to argue with a test.
   *
   * Every Independence Day session is 13:00 (12:00 CT); only the day after
   * Thanksgiving and Christmas Eve are 13:15. A 13:15 on a July row lands the
   * flatten at 13:10, ten minutes inside a 13:00 halt — the failure this
   * module exists to prevent, at reduced scale.
   *
   * **The 4th itself is in this list, and it is the row the table was missing.**
   * July 4 is a session on every weekday it falls on, so the pre-holiday row
   * alone leaves the holiday uncovered.
   */
  it("puts every Independence Day session at 13:00 and keeps 13:15 to the two dates that earn it", () => {
    for (const date of [
      "2023-07-03",
      "2023-07-04",
      "2024-07-03",
      "2024-07-04",
      "2025-07-03",
      "2025-07-04",
      "2026-07-03",
      "2027-07-02",
      "2027-07-05",
    ]) {
      expect(earlyCloseFor(date), date).toBe("13:00");
    }
    const at1315 = [...CME_EARLY_CLOSES.entries()]
      .filter(([, time]) => time === "13:15")
      .map(([date]) => date.slice(5, 7));
    expect(new Set(at1315)).toEqual(new Set(["11", "12"]));
  });

  it("carries the 2025-01-09 day of mourning at the cash open", () => {
    // CME held equity index open only to 08:30 CT, so no cash minute traded.
    expect(earlyCloseFor("2025-01-09")).toBe("09:30");
  });

  it("halts every print-day Good Friday at 09:15, before the cash open (A93)", () => {
    // 08:15 CT. The archive's last 1m bar is 09:14 ET on ES, MES, NQ, MNQ, YM
    // and MYM; a 10:15 row held the halt term an hour past a shut market.
    for (const date of ["2023-04-07", "2024-03-29", "2026-04-03"]) {
      expect(earlyCloseFor(date), date).toBe("09:15");
    }
  });

  it("holds only weekdays inside the calendar's own span", () => {
    for (const date of CME_EARLY_CLOSES.keys()) {
      expect(isOutsideCalendarSpan(date), date).toBe(false);
      // A weekend date is a typo, and the failure it produces is silent: the
      // real holiday session keeps assuming a full close.
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      expect(dow, date).toBeGreaterThan(0);
      expect(dow, date).toBeLessThan(6);
    }
  });

  it("covers every year of its span, so a missing year reads as a gap rather than as a full calendar", () => {
    const years = new Set([...CME_EARLY_CLOSES.keys()].map((d) => d.slice(0, 4)));
    expect([...years].sort()).toEqual(["2023", "2024", "2025", "2026", "2027"]);
    for (const year of years) {
      const rows = [...CME_EARLY_CLOSES.keys()].filter((d) => d.startsWith(year));
      // CME equity index runs nine or ten early closes a year; a year with
      // three has had its holidays confused with the full-closure table.
      expect(rows.length, year).toBeGreaterThanOrEqual(8);
    }
  });
});
