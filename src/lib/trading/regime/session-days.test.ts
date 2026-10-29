import { describe, it, expect } from "vitest";

import { buildSessionDays } from "./session-days";
import type { BarData } from "@/lib/brokers/types";

const CASH_SESSION = { start: "09:30", end: "16:00" };
const MNQ_TICK = 0.25;

function bar(timestamp: string, high: number, low: number, close: number): BarData {
  return { timestamp, open: low, high, low, close, volume: 10 };
}

describe("buildSessionDays", () => {
  it("measures the day session only, ignoring overnight bars", () => {
    const days = buildSessionDays({
      bars: [
        // 03:00 ET — inside the Globex session, outside the cash session.
        bar("2025-06-02T07:00:00.000Z", 9_000, 8_000, 8_500),
        bar("2025-06-02T13:30:00.000Z", 100.5, 99.5, 100),
        bar("2025-06-02T19:55:00.000Z", 101.0, 100.0, 100.75),
        // 16:00 ET opens the minute after the close — end is exclusive.
        bar("2025-06-02T20:00:00.000Z", 9_000, 8_000, 8_500),
      ],
      daySession: CASH_SESSION,
      tickSize: MNQ_TICK,
    });

    expect(days).toEqual([
      {
        sessionDate: "2025-06-02",
        daySessionHigh: 101.0,
        daySessionLow: 99.5,
        daySessionClose: 100.75,
        rthTR: null,
        rthRange: 6,
      },
    ]);
  });

  it("takes the true range against the prior day-session close, not the prior low", () => {
    const days = buildSessionDays({
      bars: [
        bar("2025-06-02T13:30:00.000Z", 101, 99, 100),
        // Gaps up and never trades back to yesterday's close.
        bar("2025-06-03T13:30:00.000Z", 106, 104, 105),
      ],
      daySession: CASH_SESSION,
      tickSize: MNQ_TICK,
    });

    expect(days[1].rthRange).toBe(8);
    // 106 − 100 = 6 points = 24 ticks, the gap included.
    expect(days[1].rthTR).toBe(24);
  });

  it("counts ticks exactly on a tick size that is not a binary fraction", () => {
    const days = buildSessionDays({
      bars: [bar("2025-06-02T13:30:00.000Z", 2650.7, 2648.3, 2650.0)],
      daySession: { start: "08:20", end: "13:30" },
      tickSize: 0.1,
    });
    expect(days[0].rthRange).toBe(24);
  });

  it("buckets across a DST change without moving the session window", () => {
    const days = buildSessionDays({
      bars: [
        // 09:30 EST, then 09:30 EDT after the clocks moved on 2025-03-09.
        bar("2025-03-07T14:30:00.000Z", 101, 99, 100),
        bar("2025-03-10T13:30:00.000Z", 103, 101, 102),
        // 08:30 EDT on the same day — pre-market, excluded in either half.
        bar("2025-03-10T12:30:00.000Z", 9_000, 8_000, 8_500),
      ],
      daySession: CASH_SESSION,
      tickSize: MNQ_TICK,
    });

    expect(days.map((d) => d.sessionDate)).toEqual(["2025-03-07", "2025-03-10"]);
    expect(days[1].daySessionHigh).toBe(103);
  });

  it("emits no row for a session with no day-session bar at all", () => {
    const days = buildSessionDays({
      bars: [
        bar("2025-06-02T13:30:00.000Z", 101, 99, 100),
        // Overnight only — a holiday's Globex session, not a zero-range day.
        bar("2025-06-04T02:00:00.000Z", 101, 99, 100),
      ],
      daySession: CASH_SESSION,
      tickSize: MNQ_TICK,
    });
    expect(days.map((d) => d.sessionDate)).toEqual(["2025-06-02"]);
  });
});
