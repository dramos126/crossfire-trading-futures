import { describe, it, expect } from "vitest";

import { runWindow } from "./run-window";
import { sessionStartUtc } from "@/lib/trading/regime/session-dates";
import type { LabelIndex } from "./regime-labels";
import { LEGACY_DAY_SESSION, withCommonParams, type StrategyModule } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";

const TICK_SIZE = 0.25;
const SL_TICKS = 8;
const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Fires long on every evaluated bar, so the only thing deciding which
 * trades survive is the warmup / `--from` filter under test.
 */
const alwaysEnters = {
  key: "always-enters",
  version: "1.0.0",
  config: {
    name: "Always enters",
    description: "fixture",
    timeframe: "5m",
    session: LEGACY_DAY_SESSION,
    entryType: 2,
    indicators: [],
  },
  params: withCommonParams({}),
  shouldEnter: () => ({ side: 0, slTicks: SL_TICKS, tpTicks: SL_TICKS * 2 }),
  shouldExit: () => true,
} satisfies StrategyModule;

/** One bar every five minutes across the RTH portion of each session date. */
function barsFor(sessionDates: string[]): BarData[] {
  const bars: BarData[] = [];
  for (const date of sessionDates) {
    // 13:30Z is 09:30 ET in June; the fixture only needs bars inside the
    // strategy's default main session.
    const open = new Date(`${date}T13:30:00.000Z`).getTime();
    for (let i = 0; i < 12; i++) {
      const at = open + i * FIVE_MINUTES_MS;
      bars.push({
        timestamp: new Date(at).toISOString(),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 10,
      });
    }
  }
  return bars;
}

/** Skips on every evaluated bar, so the warmup filter is again the variable. */
const alwaysSkips = {
  ...alwaysEnters,
  key: "always-skips",
  shouldEnter: () => ({ skip: "long break below session VWAP", gate: "vwap" }),
} satisfies StrategyModule;

const SESSION_DATES = [
  "2025-06-02",
  "2025-06-03",
  "2025-06-04",
  "2025-06-05",
  "2025-06-06",
];

async function run(
  from: string,
  to: string,
  warmupDays: number,
  regime?: { labels: LabelIndex; regimes: string[] },
  strategy: StrategyModule = alwaysEnters,
) {
  return runWindow({
    strategy,
    allBars: barsFor(SESSION_DATES),
    from,
    to,
    warmupDays,
    tickSize: TICK_SIZE,
    tickValue: 0.5,
    daySession: CONTRACT_SPECS.MNQ.daySession,
    feePerSideUsd: 0,
    paramOverrides: { timeframe: "5m" },
    sizing: { mode: "fixed", contracts: 1 },
    dailyLossUsd: null,
    dailyProfitUsd: null,
    foldId: null,
    sample: null,
    tradeIdStart: 1,
    labels: regime?.labels ?? null,
    regimes: regime?.regimes ?? null,
  });
}

function labelIndex(byDate: Record<string, string>): LabelIndex {
  return new Map(
    Object.entries(byDate).map(([sessionDate, label]) => [
      sessionDate,
      {
        label,
        vol: label.startsWith("active") ? ("active" as const) : ("quiet" as const),
        range: label.endsWith("expanded") ? ("expanded" as const) : ("compressed" as const),
        classifierVersion: "1",
        features: { vol5: 1, vol5Pct: 50, rthRange: 1, rangeRatio: 1 },
      },
    ]),
  );
}

describe("runWindow", () => {
  it("emits no trade whose signal bar precedes --from's session start", async () => {
    const result = await run("2025-06-04", "2025-06-06", 2);
    const windowStart = sessionStartUtc("2025-06-04").getTime();
    expect(result.records.length).toBeGreaterThan(0);
    for (const trade of result.records) {
      expect(new Date(trade.signalBarTs).getTime()).toBeGreaterThanOrEqual(windowStart);
    }
    expect(result.records.map((t) => t.sessionDate)).not.toContain("2025-06-03");
  });

  it("still reads the warmup bars — the sliced series starts before --from", async () => {
    const result = await run("2025-06-04", "2025-06-06", 2);
    expect(result.warmupFrom).toBe("2025-06-02");
    expect(new Date(result.firstBarTs ?? "").getTime()).toBeLessThan(
      sessionStartUtc("2025-06-04").getTime(),
    );
    expect(result.barCount).toBeGreaterThan(result.records.length);
  });

  it("counts sessions over the requested range only, warmup excluded", async () => {
    const result = await run("2025-06-04", "2025-06-06", 2);
    expect(result.sessions.map((s) => s.sessionDate)).toEqual([
      "2025-06-04",
      "2025-06-05",
      "2025-06-06",
    ]);
    expect(result.summary.sessions).toBe(3);
  });

  it("hands out trade ids from the offset it was given, so folds do not collide", async () => {
    const result = await runWindow({
      strategy: alwaysEnters,
      allBars: barsFor(SESSION_DATES),
      from: "2025-06-04",
      to: "2025-06-04",
      warmupDays: 1,
      tickSize: TICK_SIZE,
      tickValue: 0.5,
      daySession: CONTRACT_SPECS.MNQ.daySession,
      feePerSideUsd: 0,
      paramOverrides: { timeframe: "5m" },
      sizing: { mode: "fixed", contracts: 1 },
      dailyLossUsd: null,
      dailyProfitUsd: null,
      foldId: 3,
      sample: "test",
      tradeIdStart: 500,
      labels: null,
      regimes: null,
    });
    expect(result.records[0].tradeId).toBe(500);
    expect(result.records[0].foldId).toBe(3);
    expect(result.records[0].sample).toBe("test");
  });

  it("drops every trade when the whole range is warmup", async () => {
    const result = await run("2025-06-09", "2025-06-09", 2);
    expect(result.records).toEqual([]);
    expect(result.summary.expectancyR).toBe(0);
  });
});

describe("runWindow skip records", () => {
  it("records a strategy skip under its own gate and counts it", async () => {
    const result = await run("2025-06-04", "2025-06-06", 2, undefined, alwaysSkips);

    expect(result.records).toEqual([]);
    expect(result.skips.length).toBeGreaterThan(0);
    expect(result.summary.skipReasonCounts.vwap).toBe(result.skips.length);
    expect(result.skips[0]).toMatchObject({
      source: "strategy",
      gate: "vwap",
      reason: "long break below session VWAP",
      sessionDate: "2025-06-04",
      foldId: null,
      sample: null,
      regime: null,
    });
  });

  it("records no skip on a warmup bar, which was never going to trade", async () => {
    const result = await run("2025-06-04", "2025-06-06", 2, undefined, alwaysSkips);
    const windowStart = sessionStartUtc("2025-06-04").getTime();
    for (const skip of result.skips) {
      expect(new Date(skip.signalBarTs).getTime()).toBeGreaterThanOrEqual(windowStart);
    }
    expect(result.skips.map((s) => s.sessionDate)).not.toContain("2025-06-03");
  });

  it("leaves the regime gate out of the file while still counting it", async () => {
    const labels = labelIndex({
      "2025-06-02": "quiet.compressed",
      "2025-06-03": "quiet.compressed",
      "2025-06-04": "active.expanded",
      "2025-06-05": "quiet.compressed",
      "2025-06-06": "active.expanded",
    });
    const gated = await run("2025-06-04", "2025-06-06", 2, {
      labels,
      regimes: ["active.expanded"],
    });
    expect(gated.summary.skipReasonCounts.regime).toBeGreaterThan(0);
    expect(gated.skips).toEqual([]);
  });
});

describe("runWindow with a regime gate", () => {
  const labels = labelIndex({
    "2025-06-02": "quiet.compressed",
    "2025-06-03": "quiet.compressed",
    "2025-06-04": "active.expanded",
    "2025-06-05": "quiet.compressed",
    "2025-06-06": "active.expanded",
  });

  it("takes entries on the allowed cells only and counts the rest as regime skips", async () => {
    const gated = await run("2025-06-04", "2025-06-06", 2, {
      labels,
      regimes: ["active.expanded"],
    });
    const ungated = await run("2025-06-04", "2025-06-06", 2);

    expect(new Set(gated.records.map((t) => t.sessionDate))).toEqual(
      new Set(["2025-06-04", "2025-06-06"]),
    );
    expect(gated.records.length).toBeLessThan(ungated.records.length);
    expect(gated.summary.skipReasonCounts.regime).toBeGreaterThan(0);
  });

  it("counts no skip on a warmup bar, which was never going to trade", async () => {
    const gated = await run("2025-06-04", "2025-06-04", 2, {
      labels,
      regimes: ["active.expanded"],
    });
    expect(gated.summary.skipReasonCounts).toEqual({});
  });

  it("stamps the signal bar's label onto the trade and the session row", async () => {
    const gated = await run("2025-06-04", "2025-06-06", 2, {
      labels,
      regimes: ["active.expanded"],
    });
    expect(gated.records[0].regime?.label).toBe("active.expanded");
    expect(gated.sessions.map((s) => s.label)).toEqual([
      "active.expanded",
      "quiet.compressed",
      "active.expanded",
    ]);
    expect(gated.sessions[0].features).not.toBeNull();
  });

  it("leaves label, features and regime null when no classifier ran", async () => {
    const plain = await run("2025-06-04", "2025-06-06", 2);
    expect(plain.sessions[0].label).toBeNull();
    expect(plain.sessions[0].features).toBeNull();
    expect(plain.records[0].regime).toBeNull();
  });
});

describe("runWindow with --daily-profit-usd", () => {
  /**
   * Every bar closes one point above the last, inside a bracket neither leg of
   * which the next bar reaches, so each trade is a +1 point signal exit:
   * 4 ticks × $0.50 = **$2 gross** on MNQ's tick value.
   */
  function risingBars(sessionDates: string[]): BarData[] {
    return barsFor(sessionDates).map((bar, i) => {
      const close = 100 + (i % 12);
      return { ...bar, open: close - 1, high: close + 0.5, low: close - 0.5, close };
    });
  }

  async function profitRun(dailyProfitUsd: number | null) {
    return runWindow({
      strategy: alwaysEnters,
      allBars: risingBars(SESSION_DATES),
      from: "2025-06-04",
      to: "2025-06-06",
      warmupDays: 2,
      tickSize: TICK_SIZE,
      tickValue: 0.5,
      daySession: CONTRACT_SPECS.MNQ.daySession,
      feePerSideUsd: 0,
      paramOverrides: { timeframe: "5m" },
      sizing: { mode: "fixed", contracts: 1 },
      dailyLossUsd: null,
      dailyProfitUsd,
      foldId: null,
      sample: null,
      tradeIdStart: 1,
      labels: null,
      regimes: null,
    });
  }

  function tradesPerSession(records: { sessionDate: string }[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of records) out.set(r.sessionDate, (out.get(r.sessionDate) ?? 0) + 1);
    return out;
  }

  it("takes no further entry in a session once realised P&L reaches the target", async () => {
    const ungated = await profitRun(null);
    const gated = await profitRun(4);

    for (const count of tradesPerSession(ungated.records).values()) {
      expect(count).toBeGreaterThan(2);
    }
    // Two $2 trades reach $4 inclusive; the third entry is refused, and the
    // next session starts the count again.
    expect([...tradesPerSession(gated.records).entries()]).toEqual([
      ["2025-06-04", 2],
      ["2025-06-05", 2],
      ["2025-06-06", 2],
    ]);
    for (const trade of gated.records) expect(trade.pnlGrossDollars).toBe(2);
  });
});
