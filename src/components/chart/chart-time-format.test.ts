/**
 * The 12-hour chart time labels shared by the live and run charts.
 */
import { describe, expect, it } from "vitest";
import { TickMarkType, type UTCTimestamp } from "lightweight-charts";
import { crosshairTime12h, formatClock12h, liveBarTime, tickMark12h } from "./chart-time-format";

describe("12-hour chart times", () => {
  // Display seconds are ET wall clock written as UTC, so these are the wall
  // clock the candle shows; nothing here may re-apply a zone.
  const at = (wall: string) => Date.parse(`${wall}Z`) / 1000;

  it("reads midnight as 12:00 AM, noon as 12:00 PM and 13:05 as 1:05 PM", () => {
    expect(formatClock12h(at("2022-07-05T00:00:00"))).toBe("12:00 AM");
    expect(formatClock12h(at("2022-07-05T12:00:00"))).toBe("12:00 PM");
    expect(formatClock12h(at("2022-07-05T13:05:00"))).toBe("1:05 PM");
    expect(formatClock12h(at("2022-07-05T09:45:00"))).toBe("9:45 AM");
    expect(formatClock12h(at("2022-07-05T23:59:00"))).toBe("11:59 PM");
  });

  it("labels the crosshair with the date and a 12-hour clock", () => {
    expect(crosshairTime12h(at("2022-07-05T13:05:00") as UTCTimestamp)).toBe("Tue 05 Jul '22 1:05 PM");
  });

  it("formats intraday ticks and leaves day, month and year boundaries to the library", () => {
    const t = at("2022-07-05T15:30:00") as UTCTimestamp;
    expect(tickMark12h(t, TickMarkType.Time)).toBe("3:30 PM");
    expect(tickMark12h(t, TickMarkType.TimeWithSeconds)).toBe("3:30 PM");
    expect(tickMark12h(t, TickMarkType.DayOfMonth)).toBeNull();
    expect(tickMark12h(t, TickMarkType.Month)).toBeNull();
    expect(tickMark12h(t, TickMarkType.Year)).toBeNull();
  });
});

// A18: the live candle's bucket was floored in UTC and then projected to ET,
// so a bucket wider than the ET offset's granularity started at a different
// wall-clock hour on each side of a DST change.
describe("A18 — liveBarTime floors in ET display space, not UTC", () => {
  const wall = (iso: string) => Date.parse(`${iso}Z`) / 1000;
  const FOUR_HOURS = 240;

  it("puts 10:30 ET in the 08:00 ET bucket on both sides of the November DST change", () => {
    // 2026-10-30 is EDT (UTC-4), 2026-11-02 is EST (UTC-5).
    expect(liveBarTime("2026-10-30T14:30:00.000Z", FOUR_HOURS)).toBe(wall("2026-10-30T08:00:00"));
    expect(liveBarTime("2026-11-02T15:30:00.000Z", FOUR_HOURS)).toBe(wall("2026-11-02T08:00:00"));
  });

  it("puts 10:30 ET in the 08:00 ET bucket on both sides of the March DST change", () => {
    // 2026-03-06 is EST (UTC-5), 2026-03-09 is EDT (UTC-4).
    expect(liveBarTime("2026-03-06T15:30:00.000Z", FOUR_HOURS)).toBe(wall("2026-03-06T08:00:00"));
    expect(liveBarTime("2026-03-09T14:30:00.000Z", FOUR_HOURS)).toBe(wall("2026-03-09T08:00:00"));
  });

  it("keeps a minute bucket on the minute either side", () => {
    expect(liveBarTime("2026-10-30T14:31:42.500Z", 5)).toBe(wall("2026-10-30T10:30:00"));
    expect(liveBarTime("2026-11-02T15:31:42.500Z", 5)).toBe(wall("2026-11-02T10:30:00"));
  });

  it("answers null for a stamp it cannot read", () => {
    expect(liveBarTime("not a time", 5)).toBeNull();
  });
});
