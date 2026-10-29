import { describe, expect, it } from "vitest";
import type { BarData } from "@/lib/brokers/types";
import { signalBarAnchor, stepBarCount } from "./engine-entry-anchor";

// 5m bars opening 14:00 … 14:25 UTC; the signal bar is 14:10 (index 2).
const bar = (timestamp: string): BarData => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const ts = (hhmm: string) => `2026-10-09T${hhmm}:00.000Z`;
const BARS = ["14:00", "14:05", "14:10", "14:15", "14:20", "14:25"].map((t) => bar(ts(t)));
const SIGNAL_BAR = 2;
const ms = (iso: string) => Date.parse(iso);

describe("signalBarAnchor", () => {
  it("puts count 0 on the signal bar", () => {
    expect(signalBarAnchor(ts("14:10"))).toEqual({ barMs: ms(ts("14:10")), count: 0 });
  });

  it("answers null for a row with no signal bar, or one that does not parse, rather than guessing a bar", () => {
    expect(signalBarAnchor(null)).toBeNull();
    expect(signalBarAnchor("not a time")).toBeNull();
  });
});

describe("stepBarCount", () => {
  const signal = signalBarAnchor(ts("14:10"))!;

  it("counts the bars from the signal bar to the newest bar held", () => {
    expect(stepBarCount(BARS, signal)).toEqual({
      kind: "counted",
      anchor: { barMs: ms(ts("14:25")), count: BARS.length - 1 - SIGNAL_BAR },
    });
  });

  it("matches a signal bar stamped with a different ISO spelling of the same instant", () => {
    const step = stepBarCount(BARS, signalBarAnchor("2026-10-09T14:10:00+00:00")!);
    expect(step.kind === "counted" && step.anchor.count).toBe(3);
  });

  it("answers 0 on the signal bar itself", () => {
    const step = stepBarCount(BARS.slice(0, SIGNAL_BAR + 1), signal);
    expect(step.kind === "counted" && step.anchor.count).toBe(0);
  });

  it("carries a count on from an earlier bar, so bars no pass evaluated are still counted", () => {
    // Known to be 1 on 14:15; this read reaches 14:25, two bars on.
    expect(stepBarCount(BARS, { barMs: ms(ts("14:15")), count: 1 })).toEqual({
      kind: "counted",
      anchor: { barMs: ms(ts("14:25")), count: 3 },
    });
  });

  it("counts from the oldest bar held, and says so, when the anchor bar is older than it", () => {
    expect(stepBarCount(BARS, signalBarAnchor(ts("13:55"))!)).toEqual({
      kind: "older",
      anchor: { barMs: ms(ts("14:25")), count: BARS.length - 1 },
    });
    expect(stepBarCount(BARS, { barMs: ms(ts("13:55")), count: 2 })).toEqual({
      kind: "older",
      anchor: { barMs: ms(ts("14:25")), count: BARS.length - 1 },
    });
  });

  it("never counts back when the count was already past the oldest bar held", () => {
    expect(stepBarCount(BARS, { barMs: ms(ts("13:55")), count: 9 })).toEqual({
      kind: "older",
      anchor: { barMs: ms(ts("14:25")), count: 10 },
    });
  });

  it("keeps the anchor when the read has not reached its bar yet", () => {
    expect(stepBarCount(BARS.slice(0, SIGNAL_BAR), signal)).toEqual({ kind: "ahead" });
    expect(stepBarCount([], signal)).toEqual({ kind: "ahead" });
  });
});
