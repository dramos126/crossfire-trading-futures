import { describe, it, expect } from "vitest";

import {
  sessionDateOf,
  sessionEndUtc,
  sessionStartUtc,
  shiftSessionDatesBack,
} from "./session-dates";

describe("sessionDateOf", () => {
  it("puts 18:00 ET into the next calendar day's session", () => {
    // 2025-06-01T22:00Z is 18:00 EDT — the first instant of the Monday session.
    expect(sessionDateOf(new Date("2025-06-01T22:00:00.000Z"))).toBe("2025-06-02");
    expect(sessionDateOf(new Date("2025-06-01T21:59:00.000Z"))).toBe("2025-06-01");
  });

  it("keeps the 17:00-18:00 ET maintenance break with the session that just closed", () => {
    expect(sessionDateOf(new Date("2025-06-02T21:00:00.000Z"))).toBe("2025-06-02");
    expect(sessionDateOf(new Date("2025-06-02T21:59:00.000Z"))).toBe("2025-06-02");
  });

  it("reads the boundary through the live ET offset, not a fixed one", () => {
    // EST: 18:00 ET is 23:00Z, an hour later than the EDT boundary above.
    expect(sessionDateOf(new Date("2025-01-06T23:00:00.000Z"))).toBe("2025-01-07");
    expect(sessionDateOf(new Date("2025-01-06T22:59:00.000Z"))).toBe("2025-01-06");
  });

  it("puts an RTH bar in its own session date", () => {
    expect(sessionDateOf(new Date("2025-06-02T13:30:00.000Z"))).toBe("2025-06-02");
  });
});

describe("sessionStartUtc / sessionEndUtc", () => {
  it("opens at 18:00 ET the prior calendar day and closes at 17:00 ET", () => {
    expect(sessionStartUtc("2025-06-02").toISOString()).toBe("2025-06-01T22:00:00.000Z");
    expect(sessionEndUtc("2025-06-30").toISOString()).toBe("2025-06-30T21:00:00.000Z");
  });

  it("shifts by an hour across the DST halves", () => {
    expect(sessionStartUtc("2025-01-07").toISOString()).toBe("2025-01-06T23:00:00.000Z");
    expect(sessionEndUtc("2025-01-07").toISOString()).toBe("2025-01-07T22:00:00.000Z");
  });

  it("lands correctly on the day the clocks move", () => {
    // 2025-03-09 is the US spring-forward date; the session that opens that
    // evening is already on EDT.
    expect(sessionStartUtc("2025-03-10").toISOString()).toBe("2025-03-09T22:00:00.000Z");
    // The prior session opened on EST, before the change.
    expect(sessionStartUtc("2025-03-07").toISOString()).toBe("2025-03-06T23:00:00.000Z");
  });
});

describe("shiftSessionDatesBack", () => {
  it("skips weekends", () => {
    expect(shiftSessionDatesBack("2025-06-02", 1)).toBe("2025-05-30");
    expect(shiftSessionDatesBack("2025-06-02", 2)).toBe("2025-05-29");
  });

  it("walks 30 session days back across two month boundaries", () => {
    expect(shiftSessionDatesBack("2025-06-02", 30)).toBe("2025-04-21");
  });

  it("is a no-op at zero", () => {
    expect(shiftSessionDatesBack("2025-06-02", 0)).toBe("2025-06-02");
  });
});
