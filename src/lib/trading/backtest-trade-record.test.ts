import { describe, it, expect } from "vitest";

import { buildTradeRecord } from "./backtest-trade-record";
import { runBacktest, type BacktestTrade } from "@/lib/trading/backtest";
import { LEGACY_DAY_SESSION, withCommonParams } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";

const TICK_SIZE = 1;

function trade(over: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    side: 0,
    entryBarIndex: 0,
    entryTimestamp: "2025-06-04T13:30:00.000Z",
    signalBarTs: "2025-06-04T13:30:00.000Z",
    entryPrice: 100,
    exitBarIndex: 0,
    exitTimestamp: "2025-06-04T13:35:00.000Z",
    exitPrice: 100,
    exitReason: "stop_loss",
    pnlTicks: 0,
    pnlDollars: 0,
    grossPnlDollars: 0,
    feesDollars: 0,
    size: 1,
    riskDollars: 8,
    slTicks: 8,
    tpTicks: 16,
    tpPrice: 104,
    slPrice: 98,
    breakEvenMoved: false,
    trailMoved: false,
    ...over,
  };
}

function bar(o: { high: number; low: number }): BarData {
  return {
    timestamp: "2025-06-04T13:30:00.000Z",
    open: o.low,
    high: o.high,
    low: o.low,
    close: o.high,
    volume: 10,
  };
}

function recordFor(t: BacktestTrade, bars: BarData[]) {
  return buildTradeRecord({
    trade: t,
    bars,
    tickSize: TICK_SIZE,
    tradeId: 1,
    foldId: null,
    sample: null,
    regime: null,
  });
}

// The backtest fills at the entry bar's close, so that bar's range traded
// before the position existed.
describe("A104 — excursion is measured from the fill, not the entry bar's range", () => {
  it("a long's MAE and MFE leave out the entry bar's low and high", () => {
    const t = trade({ side: 0, entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100 });
    const bars = [
      bar({ high: 110, low: 90 }),
      bar({ high: 102, low: 97 }),
      bar({ high: 103, low: 98 }),
    ];
    const r = recordFor(t, bars);
    expect([r.maeTicks, r.maeBarIndex, r.mfeTicks, r.mfeBarIndex]).toEqual([3, 1, 3, 2]);
  });

  it("a short's MAE and MFE leave out the entry bar's high and low", () => {
    const t = trade({ side: 1, entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100 });
    const bars = [
      bar({ high: 110, low: 90 }),
      bar({ high: 103, low: 99 }),
      bar({ high: 102, low: 96 }),
    ];
    const r = recordFor(t, bars);
    expect([r.maeTicks, r.maeBarIndex, r.mfeTicks, r.mfeBarIndex]).toEqual([3, 1, 4, 2]);
  });
});

// A flatten booked at a bar's open (a bar that opens past the session end)
// held none of that bar's range.
describe("A107 — an exit at the exit bar's open leaves that bar out of the excursion", () => {
  it("does not count the flatten bar's low or high", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100, exitReason: "time_window_close", exitAtBarOpen: true });
    const bars = [
      bar({ high: 100, low: 100 }),
      bar({ high: 102, low: 98 }),
      bar({ high: 120, low: 80 }),
    ];
    const r = recordFor(t, bars);
    expect([r.maeTicks, r.mfeTicks]).toEqual([2, 2]);
  });

  it("still counts the exit bar for an exit inside it", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100 });
    const bars = [
      bar({ high: 100, low: 100 }),
      bar({ high: 102, low: 98 }),
      bar({ high: 101, low: 92 }),
    ];
    expect(recordFor(t, bars).maeTicks).toBe(8);
  });
});

// `rMultiple` is gross ticks over the stop and keeps that meaning; the net
// figure sits beside it, and on a small winner the two differ in sign.
describe("A65 — rMultipleNet is net dollars over the dollars the stop risked", () => {
  it("reads a fee-eaten winner as a net loss while rMultiple stays gross", () => {
    // 1 tick won on an 8-tick stop, $1 a tick, 2 contracts, $3 round trip.
    const t = trade({ pnlTicks: 1, grossPnlDollars: 2, feesDollars: 3, pnlDollars: -1, size: 2, slTicks: 8, riskDollars: 16 });
    const r = recordFor(t, [bar({ high: 100, low: 100 })]);
    expect([r.rMultiple, r.rMultipleNet]).toEqual([1 / 8, -1 / 16]);
  });

  it("runBacktest stamps the stop's dollar risk on the trade", async () => {
    const at = (minute: number, low: number): BarData => ({
      timestamp: new Date(Date.UTC(2025, 0, 2, 14, 30 + minute)).toISOString(),
      open: 100,
      high: 100,
      low,
      close: 100,
      volume: 10,
    });
    const result = await runBacktest({
      strategy: {
        version: "1.0.0",
        key: "test-a65",
        params: withCommonParams({}),
        config: { name: "A65", description: "", timeframe: "1m", session: LEGACY_DAY_SESSION, entryType: 2, indicators: [] },
        shouldEnter: ({ barIndex }) => (barIndex === 0 ? { side: 0, slTicks: 8, tpTicks: 8 } : null),
        shouldExit: () => false,
      },
      bars: [at(0, 100), at(1, 90)],
      tickSize: 1,
      tickValue: 1.25,
      daySession: null,
      sizing: { mode: "fixed", contracts: 2 },
    });
    expect(result.trades.map((x) => x.riskDollars)).toEqual([20]);
  });
});

describe("maeBarIndex", () => {
  it("is 0 when no bar after the fill goes against the trade", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100 });
    const bars = [
      bar({ high: 101, low: 95 }),
      bar({ high: 102, low: 100 }),
      bar({ high: 103, low: 101 }),
    ];
    expect(recordFor(t, bars).maeBarIndex).toBe(0);
  });

  it("points at the worst bar mid-trade", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 3, entryPrice: 100 });
    const bars = [
      bar({ high: 101, low: 99 }),
      bar({ high: 102, low: 90 }),
      bar({ high: 103, low: 95 }),
      bar({ high: 104, low: 93 }),
    ];
    expect(recordFor(t, bars).maeBarIndex).toBe(1);
  });

  it("resolves a tied worst low to the earlier bar", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 2, entryPrice: 100 });
    const bars = [
      bar({ high: 101, low: 95 }),
      bar({ high: 102, low: 90 }),
      bar({ high: 103, low: 90 }),
    ];
    expect(recordFor(t, bars).maeBarIndex).toBe(1);
  });
});

describe("mfeBarIndex", () => {
  it("points at the best bar mid-trade, the same way maeBarIndex does", () => {
    const t = trade({ entryBarIndex: 0, exitBarIndex: 3, entryPrice: 100 });
    const bars = [
      bar({ high: 101, low: 99 }),
      bar({ high: 108, low: 98 }),
      bar({ high: 103, low: 97 }),
      bar({ high: 104, low: 96 }),
    ];
    expect(recordFor(t, bars).mfeBarIndex).toBe(1);
  });
});
