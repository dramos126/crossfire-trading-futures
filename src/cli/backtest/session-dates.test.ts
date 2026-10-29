import { describe, it, expect } from "vitest";

import { addMonths, lastDayOfMonth, monthsBetween, parseSessionDate } from "./session-dates";

describe("parseSessionDate", () => {
  it("refuses anything that is not YYYY-MM-DD", () => {
    expect(() => parseSessionDate("2025/06/02", "--from")).toThrow(/session date/);
    expect(() => parseSessionDate("06-02-2025", "--from")).toThrow(/session date/);
  });

  it("refuses a date the calendar does not have", () => {
    expect(() => parseSessionDate("2025-02-30", "--to")).toThrow(/not a real calendar date/);
  });
});

describe("month arithmetic", () => {
  it("crosses a year boundary in both directions", () => {
    expect(addMonths("2023-11", 3)).toBe("2024-02");
    expect(addMonths("2024-02", -3)).toBe("2023-11");
    expect(monthsBetween("2023-01", "2024-12")).toBe(23);
  });

  it("finds the last day of a month, leap years included", () => {
    expect(lastDayOfMonth("2024-02")).toBe("2024-02-29");
    expect(lastDayOfMonth("2023-02")).toBe("2023-02-28");
    expect(lastDayOfMonth("2024-06")).toBe("2024-06-30");
    expect(lastDayOfMonth("2024-12")).toBe("2024-12-31");
  });
});
