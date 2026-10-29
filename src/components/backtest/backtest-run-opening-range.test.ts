import { describe, expect, it } from "vitest";
import { openingRangeLines } from "./backtest-run-opening-range";

// 2022-08-18 is EDT (UTC−4): 09:30 ET = 13:30Z.
const bar = (utc: string, high: number, low: number) => ({ timestamp: `2022-08-18T${utc}:00.000Z`, high, low });
const display = (et: string) => Date.parse(`2022-08-18T${et}:00Z`) / 1000;
const none = { high: null, low: null };

describe("openingRangeLines", () => {
  const bars = [
    bar("13:25", 999, 1), // 09:25 ET — before the range, ignored
    bar("13:30", 110, 100),
    bar("13:35", 120, 95),
    bar("13:40", 115, 98),
    bar("13:45", 500, 0), // 09:45 ET — after the range, not in it
    bar("17:00", 130, 90),
    bar("20:00", 130, 90), // 16:00 ET — the last point
    bar("20:05", 130, 90), // 16:05 ET — past the lines
  ];

  it("takes the range from the 09:30–09:44 bars only and spans 09:45 to 16:00", () => {
    expect(openingRangeLines(bars, "2022-08-18", none)).toEqual({
      high: 120,
      low: 95,
      from: display("09:45"),
      to: display("16:00"),
    });
  });

  it("uses the bars over the recorded range when the 09:30 bar is loaded", () => {
    expect(openingRangeLines(bars, "2022-08-18", { high: 1, low: 0 })?.high).toBe(120);
  });

  it("falls back to the recorded range when the loaded bars start after 09:30", () => {
    const late = bars.filter((b) => b.timestamp >= "2022-08-18T17:00");
    expect(openingRangeLines([bar("13:50", 1, 1), ...late], "2022-08-18", { high: 120, low: 95 })).toMatchObject({
      high: 120,
      low: 95,
      from: display("09:50"),
    });
  });

  it("draws nothing without a range or with under two points to draw across", () => {
    expect(openingRangeLines(bars.slice(5), "2022-08-18", none)).toBeNull();
    expect(openingRangeLines(bars.slice(0, 5), "2022-08-18", none)).toBeNull();
  });
});
