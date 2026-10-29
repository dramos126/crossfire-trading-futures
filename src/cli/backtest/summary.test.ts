import { describe, it, expect } from "vitest";

import { buildSummary, drawdownInR, longestLossStreak } from "./summary";
import { buildSessionRecords } from "./sessions";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { BacktestTrade } from "@/lib/trading/backtest";

/** Only the fields the summary actually reads are meaningful here; the rest
 *  exist because the record type is the file format, not a view model. */
function record(over: {
  sessionDate: string;
  pnlTicks: number;
  slTicks?: number;
  pnlNetDollars?: number;
  pnlGrossDollars?: number;
  exitReason?: CliTradeRecord["exitReason"];
  entryHourEt?: number;
  weekday?: number;
  barsHeld?: number;
}): CliTradeRecord {
  const slTicks = over.slTicks ?? 100;
  return {
    tradeId: 0,
    foldId: null,
    sample: null,
    sessionDate: over.sessionDate,
    regime: null,
    signalBarTs: `${over.sessionDate}T13:35:00.000Z`,
    entryTs: `${over.sessionDate}T13:35:00.000Z`,
    entryBarIndex: 0,
    side: 0,
    entryPrice: 100,
    slPrice: 99,
    tpPrice: 102,
    slTicks,
    tpTicks: slTicks * 2,
    contracts: 1,
    exitTs: `${over.sessionDate}T14:35:00.000Z`,
    exitBarIndex: 12,
    exitPrice: 101,
    exitReason: over.exitReason ?? "stop_loss",
    pnlTicks: over.pnlTicks,
    pnlGrossDollars: over.pnlGrossDollars ?? over.pnlTicks * 0.5,
    feesDollars: 1.24,
    pnlNetDollars: over.pnlNetDollars ?? over.pnlTicks * 0.5 - 1.24,
    rMultiple: over.pnlTicks / slTicks,
    mfeTicks: 10,
    mfeBarIndex: 3,
    maeTicks: 10,
    maeBarIndex: 2,
    barsHeld: over.barsHeld ?? 12,
    slMoved: { breakeven: false, trail: false },
    entryMeta: null,
    exitMeta: null,
    entryHourEt: over.entryHourEt ?? 9,
    weekday: over.weekday ?? 1,
  };
}

function summaryOf(records: CliTradeRecord[], sessionDates: string[], dailyLossUsd: number | null = null) {
  const sessions = buildSessionRecords(sessionDates, records, dailyLossUsd);
  // `computeStats` is the owner of the win/loss buckets; the R statistics
  // under test do not depend on the backtest-trade list, so an empty one
  // keeps this file focused on the arithmetic it adds.
  return buildSummary({ records, backtestTrades: [] as BacktestTrade[], sessions });
}

describe("buildSummary", () => {
  it("means R over the kept trades and reports the sample deviation", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 200 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-04", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-05", pnlTicks: 100 }),
    ];
    const summary = summaryOf(records, [
      "2025-06-02",
      "2025-06-03",
      "2025-06-04",
      "2025-06-05",
      "2025-06-06",
    ]);
    // R values are 2, -1, -1, 1.
    expect(summary.expectancyR).toBeCloseTo(0.25, 10);
    expect(summary.medianR).toBeCloseTo(0, 10);
    expect(summary.avgWinR).toBeCloseTo(1.5, 10);
    expect(summary.avgLossR).toBeCloseTo(-1, 10);
    expect(summary.payoffRatio).toBeCloseTo(1.5, 10);
    expect(summary.stdR).toBeCloseTo(1.5, 10);
  });

  it("counts sessions with and without a trade, and trades per session over all of them", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 100 }),
      record({ sessionDate: "2025-06-02", pnlTicks: -100 }),
    ];
    const summary = summaryOf(records, ["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05"]);
    expect(summary.sessions).toBe(4);
    expect(summary.sessionsWithTrade).toBe(1);
    expect(summary.tradesPerSession).toBeCloseTo(0.5, 10);
  });

  it("names the worst session by net dollars, not by R", () => {
    const records = [
      // A tight stop loses less money on a worse R than a wide stop does.
      record({ sessionDate: "2025-06-02", pnlTicks: -20, slTicks: 20 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -200, slTicks: 400 }),
    ];
    const summary = summaryOf(records, ["2025-06-02", "2025-06-03"]);
    expect(summary.worstSessionDate).toBe("2025-06-03");
    expect(summary.worstSessionDollars).toBeCloseTo(-101.24, 10);
  });

  it("returns a null worst session and zeroed R statistics with no trades", () => {
    const summary = summaryOf([], ["2025-06-02", "2025-06-03"]);
    expect(summary.worstSessionDate).toBeNull();
    expect(summary.worstSessionDollars).toBe(0);
    expect(summary.expectancyR).toBe(0);
    expect(summary.tradesPerSession).toBe(0);
  });

  it("buckets by ET entry hour and weekday, ascending", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 100, entryHourEt: 13, weekday: 4 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -100, entryHourEt: 9, weekday: 1 }),
      record({ sessionDate: "2025-06-04", pnlTicks: 300, entryHourEt: 9, weekday: 1 }),
    ];
    const summary = summaryOf(records, ["2025-06-02", "2025-06-03", "2025-06-04"]);
    expect(summary.byEntryHourEt).toEqual([
      { hour: 9, n: 2, expectancyR: 1 },
      { hour: 13, n: 1, expectancyR: 1 },
    ]);
    expect(summary.byWeekday.map((b) => b.weekday)).toEqual([1, 4]);
  });

  it("counts exit reasons and leaves skip reasons an empty object rather than absent", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: -100, exitReason: "stop_loss" }),
      record({ sessionDate: "2025-06-03", pnlTicks: 200, exitReason: "take_profit" }),
      record({ sessionDate: "2025-06-04", pnlTicks: -100, exitReason: "stop_loss" }),
    ];
    const summary = summaryOf(records, ["2025-06-02", "2025-06-03", "2025-06-04"]);
    expect(summary.exitReasonCounts).toEqual({ stop_loss: 2, take_profit: 1 });
    expect(summary.skipReasonCounts).toEqual({});
  });

  it("counts a daily-loss breach on the running gross total inside a session", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: -600, pnlGrossDollars: -300 }),
      record({ sessionDate: "2025-06-02", pnlTicks: -600, pnlGrossDollars: -300 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -200, pnlGrossDollars: -100 }),
    ];
    const summary = summaryOf(records, ["2025-06-02", "2025-06-03"], 500);
    expect(summary.dailyLossBreaches).toBe(1);
  });
});

describe("drawdownInR", () => {
  it("measures peak to trough on the cumulative R series", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 200 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-04", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-05", pnlTicks: 100 }),
    ];
    // Cumulative R: 2, 1, 0, 1. Peak 2, trough 0.
    expect(drawdownInR(records).maxDrawdownR).toBeCloseTo(2, 10);
  });

  it("counts the underwater stretch in sessions that carried a trade", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 200 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-09", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-10", pnlTicks: -100 }),
    ];
    // Ordinals 0..3 over the four trading sessions; the peak is ordinal 0.
    expect(drawdownInR(records).maxDurationSessions).toBe(3);
  });

  it("is zero on a series that only rises", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: 100 }),
      record({ sessionDate: "2025-06-03", pnlTicks: 100 }),
    ];
    expect(drawdownInR(records)).toEqual({ maxDrawdownR: 0, maxDurationSessions: 0 });
  });
});

describe("longestLossStreak", () => {
  it("counts consecutive losers and resets on a scratch", () => {
    const records = [
      record({ sessionDate: "2025-06-02", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-03", pnlTicks: -100 }),
      record({ sessionDate: "2025-06-04", pnlTicks: 0 }),
      record({ sessionDate: "2025-06-05", pnlTicks: -100 }),
    ];
    expect(longestLossStreak(records)).toBe(2);
  });

  it("is zero with no losers", () => {
    expect(longestLossStreak([record({ sessionDate: "2025-06-02", pnlTicks: 100 })])).toBe(0);
  });
});
