import { describe, it, expect } from "vitest";

import { minutesInTradingTz } from "./session";
import { TRADING_TIMEZONE } from "../strategy-types";

/** Deliberately not the module's own formatter: the point is that the cache
 *  answers what an uncached format would have. */
const freshFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TRADING_TIMEZONE,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

function uncachedMinutes(date: Date): number {
  let h = 0;
  let m = 0;
  for (const part of freshFormatter.formatToParts(date)) {
    if (part.type === "hour") h = Number(part.value);
    else if (part.type === "minute") m = Number(part.value);
  }
  if (h === 24) h = 0;
  return h * 60 + m;
}

const INSTANTS = [
  // Spring forward: 01:59 EST, then 03:00 EDT the same minute-pair.
  "2024-03-10T06:59:00Z",
  "2024-03-10T07:00:00Z",
  // Fall back: 01:00 EDT and 01:00 EST — one wall clock, two instants.
  "2024-11-03T05:00:00Z",
  "2024-11-03T06:00:00Z",
  // Midnight ET, the value the normalisation exists for.
  "2024-06-14T03:59:00Z",
  "2024-06-14T04:00:00Z",
].map((iso) => new Date(iso));

describe("minutesInTradingTz", () => {
  it("matches an uncached read on the first call and on the cached second", () => {
    for (const instant of INSTANTS) {
      expect(minutesInTradingTz(instant)).toBe(uncachedMinutes(instant));
      expect(minutesInTradingTz(instant)).toBe(uncachedMinutes(instant));
    }
  });

  it("reports 0 at ET midnight, both halves of the year", () => {
    expect(minutesInTradingTz(new Date("2024-06-14T04:00:00Z"))).toBe(0);
    expect(minutesInTradingTz(new Date("2024-12-14T05:00:00Z"))).toBe(0);
  });
});
