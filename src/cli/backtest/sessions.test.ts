import { describe, it, expect } from "vitest";

import { buildSessionRecords } from "./sessions";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";

const DATES = ["2025-06-03", "2025-06-04"];

function trade(over: Partial<CliTradeRecord> = {}): CliTradeRecord {
  const base = {
    tradeId: 1,
    foldId: null,
    sample: null,
    sessionDate: "2025-06-03",
    regime: null,
    signalBarTs: "2025-06-03T14:00:00.000Z",
    entryTs: "2025-06-03T14:00:00.000Z",
    entryBarIndex: 0,
    side: 0,
    entryPrice: 100,
    slPrice: 98,
    tpPrice: 104,
    slTicks: 8,
    tpTicks: 16,
    contracts: 1,
    exitTs: "2025-06-03T15:00:00.000Z",
    exitBarIndex: 12,
    exitPrice: 98,
    exitReason: "stop_loss",
    pnlTicks: -8,
    pnlGrossDollars: -400,
    feesDollars: 2,
    pnlNetDollars: -402,
    rMultiple: -1,
    mfeTicks: 0,
    mfeBarIndex: 0,
    maeTicks: 8,
    maeBarIndex: 4,
    barsHeld: 12,
    slMoved: { breakeven: false, trail: false },
    entryMeta: null,
    exitMeta: null,
    entryHourEt: 10,
    weekday: 2,
  } satisfies CliTradeRecord;
  return { ...base, ...over };
}

describe("buildSessionRecords", () => {
  it("buckets P&L on the signal-bar session", () => {
    const rows = buildSessionRecords(DATES, [trade(), trade({ tradeId: 2 })], null);
    expect(rows.map((r) => [r.sessionDate, r.tradeCount, r.netDollars, r.fired])).toEqual([
      ["2025-06-03", 2, -804, true],
      ["2025-06-04", 0, 0, false],
    ]);
  });

  it("counts a breach only once the running gross reaches the limit", () => {
    const under = buildSessionRecords(DATES, [trade()], 500);
    expect(under[0].dailyLossBreached).toBe(false);

    const over = buildSessionRecords(DATES, [trade(), trade({ tradeId: 2 })], 500);
    expect(over[0].dailyLossBreached).toBe(true);
  });

  it("breaches the session the trade exited in, not the one it signalled in", () => {
    // Signal at 16:00 ET on 03 June, exit at 18:30 ET — past the maintenance
    // break, so the loss lands on the 04 June session, which is where the
    // engine's gate counts it.
    const spanning = trade({
      signalBarTs: "2025-06-03T20:00:00.000Z",
      exitTs: "2025-06-03T22:30:00.000Z",
      pnlGrossDollars: -600,
    });
    const rows = buildSessionRecords(DATES, [spanning], 500);
    expect(rows.map((r) => [r.sessionDate, r.dailyLossBreached])).toEqual([
      ["2025-06-03", false],
      ["2025-06-04", true],
    ]);
  });

  it("never breaches without a limit", () => {
    const rows = buildSessionRecords(DATES, [trade({ pnlGrossDollars: -100_000 })], null);
    expect(rows.every((r) => !r.dailyLossBreached)).toBe(true);
  });
});
