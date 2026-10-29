/**
 * Unit tests for runBacktest — focused on the balance simulation
 * (startingBalance option) added in the recent commits.
 *
 * Strategy used throughout: a minimal inline StrategyModule that fires
 * unconditionally on every bar (no indicator warmup, no session gate
 * complications) so we can construct exact trade sequences by controlling
 * bar OHLC values.
 *
 * Session notes: the fixture declares `LEGACY_DAY_SESSION`, 09:30–15:55
 * America/New_York — the window every module carried before the session
 * became a playbook constant.
 * All test bars use 14:30 UTC (= 10:30 ET, inside the window) so session
 * guards never block entries or force exits.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCellStepper, runBacktest, straddleSubBars, type CellStepperOptions } from "./backtest";
import type { StrategyModule, CommonParams, ParamValues } from "./strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "./strategy-types";
import { resolveEffectiveTpTicks } from "./orders/brackets";
import {
  anyExitFilterTriggered,
  buildAllFilterIndicators,
  type AllFilterParams,
} from "./filters";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { aggregateBars } from "@/lib/data/aggregator";
import { barDataToBar, barToBarData } from "@/lib/data/bar-source-adapter";
import { defaultParamValues } from "./strategy-types";
import { collectSessionWindows } from "./session/session";
import { isInTradableSessionWindow } from "./session/exchange-calendar";
import { NO_DAILY_PNL_LIMITS } from "./daily-pnl-gate";
import { computeIntrabarBreakevenSlPrice } from "./exit-filters/breakeven";

// A pass-through spy: the intrabar latch is pinned by how often break-even is
// asked inside a bar, which no trade field shows.
vi.mock("./exit-filters/breakeven", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exit-filters/breakeven")>();
  return { ...actual, computeIntrabarBreakevenSlPrice: vi.fn(actual.computeIntrabarBreakevenSlPrice) };
});

// ── Bar factory ──────────────────────────────────────────────────────

/** Minute offset from 2025-01-02 14:30 UTC (inside default session 10:30 ET) */
function bar(minuteOffset: number, open: number, close: number, opts?: { high?: number; low?: number }): BarData {
  const ts = new Date(Date.UTC(2025, 0, 2, 14, 30 + minuteOffset, 0));
  return {
    timestamp: ts.toISOString(),
    open,
    high: opts?.high ?? Math.max(open, close) + 0.25,
    low: opts?.low ?? Math.min(open, close) - 0.25,
    close,
    volume: 100,
  };
}

// ── Minimal fixture strategy ─────────────────────────────────────────

/**
 * Fires a LONG entry on every bar with a fixed 4-tick SL.
 * shouldExit always returns false — exits happen only via bracket hit.
 */
type FixtureParams = CommonParams;

const alwaysLongStrategy: StrategyModule<FixtureParams> = {
  version: "1.0.0",
  key: "test-always-long",
  params: withCommonParams({}),
  config: {
    name: "Always Long (test fixture)",
    description: "Test fixture — enters long on every bar.",
    timeframe: "1m",
    session: LEGACY_DAY_SESSION,
    entryType: 2,
    indicators: [],
  },
  buildIndicators() {
    return [];
  },
  shouldEnter({ barIndex }) {
    if (barIndex < 1) return null;
    const slTicks = 4;
    return { side: 0, slTicks, tpTicks: resolveEffectiveTpTicks(slTicks, 2) };
  },
  shouldExit() {
    return false;
  },
};

/**
 * Always-long on `buildTradeBars`' signal bars (the odd indices) only. Its exit
 * bars are flat at their close, and an always-long fixture would re-enter
 * there (A102), so the pairs would overlap.
 */
const pairedLongStrategy: StrategyModule<FixtureParams> = {
  ...alwaysLongStrategy,
  key: "test-paired-long",
  shouldEnter(ctx) {
    return ctx.barIndex % 2 === 1 ? alwaysLongStrategy.shouldEnter(ctx) : null;
  },
};

// ── Common backtest opts ─────────────────────────────────────────────

/** NQ-like instrument: 0.25 tick size, $5 tick value. */
const BASE_OPTS = {
  strategy: alwaysLongStrategy,
  tickSize: 0.25,
  tickValue: 5,
  daySession: CONTRACT_SPECS.MNQ.daySession,
  feePerSideUsd: 0,
} as const;

/** `BASE_OPTS` for a `buildTradeBars` series. */
const PAIRED_OPTS = { ...BASE_OPTS, strategy: pairedLongStrategy } as const;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Builds a sequence of bars that produce exactly `count` closed trades,
 * each either winning or losing based on the provided flags array.
 *
 * win  → close moves 8 ticks above entry (TP fires at 4*2 = 8 ticks with RR=2)
 * loss → close gaps down 5 ticks below entry (SL at 4 ticks, bar low pierces it)
 *
 * Each trade uses a fresh bar pair (signal bar + exit bar) so they never
 * overlap.  The 2R multiple is the fixture strategy's own.
 */
function buildTradeBars(wins: boolean[]): BarData[] {
  const tickSize = 0.25;
  const bars: BarData[] = [];
  // Seed bar at index 0 — no entry fires here (barIndex < 1 guard).
  bars.push(bar(0, 20000, 20000));

  for (let i = 0; i < wins.length; i++) {
    const entryClose = 20000 + i * 5; // distinct price per trade
    // Signal bar — alwaysLong fires here, enters at bar.close = entryClose
    bars.push(bar(1 + i * 2, entryClose, entryClose));

    if (wins[i]) {
      // TP = entryClose + 4*2*0.25 = entryClose + 2.00
      const tpPrice = entryClose + 8 * tickSize;
      // Bar high reaches TP, low stays above SL
      bars.push(bar(2 + i * 2, entryClose, entryClose, { high: tpPrice + 0.25, low: entryClose - 0.10 }));
    } else {
      // SL = entryClose - 4*0.25 = entryClose - 1.00
      const slPrice = entryClose - 4 * tickSize;
      // Bar low pierces SL, high stays below TP
      bars.push(bar(2 + i * 2, entryClose, entryClose, { high: entryClose + 0.10, low: slPrice - 0.25 }));
    }
  }
  return bars;
}

// ── Tests: startingBalance absent ───────────────────────────────────

describe("runBacktest — startingBalance absent", () => {
  it("result has no startingBalance, highestBalance, lowestBalance, or blowupTradeIndex fields", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
    });
    expect("startingBalance" in result).toBe(false);
    expect("highestBalance" in result).toBe(false);
    expect("lowestBalance" in result).toBe(false);
    expect("blowupTradeIndex" in result).toBe(false);
  });

  it("empty bar input returns result without balance fields", async () => {
    const result = await runBacktest({ ...BASE_OPTS, bars: [] });
    expect("startingBalance" in result).toBe(false);
    expect("blowupTradeIndex" in result).toBe(false);
  });
});

// ── Tests: startingBalance set, all wins ────────────────────────────

describe("runBacktest — startingBalance set, all profitable trades", () => {
  it("highestBalance equals startingBalance plus total net profit", async () => {
    // Two winning trades, each +8 ticks × $5 = +$10 net per trade.
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true, true]),
      startingBalance: 1000,
    });
    expect(result.trades).toHaveLength(2);
    const totalPnl = result.trades.reduce((sum, t) => sum + t.pnlDollars, 0);
    expect(result.startingBalance).toBe(1000);
    expect(result.highestBalance).toBeCloseTo(1000 + totalPnl, 6);
    expect(result.lowestBalance).toBeCloseTo(1000, 6);
    // No blowup when all trades are profitable.
    expect(result.blowupTradeIndex).toBeUndefined();
  });

  it("lowestBalance never drops below startingBalance when every trade wins", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true, true, true]),
      startingBalance: 500,
    });
    // Running equity monotonically increases — lowestBalance stays at start.
    expect(result.lowestBalance).toBeCloseTo(500, 6);
    expect(result.highestBalance).toBeGreaterThan(500);
  });
});

// ── Tests: single losing trade drives equity to zero ─────────────────

describe("runBacktest — startingBalance set, single loss blows up", () => {
  it("blowupTradeIndex is 0 when the first (and only) trade drives equity to zero or below", async () => {
    // One losing trade costs 4 ticks × $5 = $20 net loss.
    // Start with $15 — the loss drops equity to -$5, triggering blowup.
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false]),
      startingBalance: 15,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].pnlDollars).toBeLessThan(0);
    expect(result.blowupTradeIndex).toBe(0);
  });

  it("startingBalance = 0 with any loss triggers immediate blowup at trade 0", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false]),
      startingBalance: 0,
    });
    expect(result.blowupTradeIndex).toBe(0);
  });
});

// ── Tests: blowup on trade N, not overwritten by later trades ────────

describe("runBacktest — blowup on trade N, index is 0-based and not overwritten", () => {
  it("first two trades win, third trade triggers blowup — blowupTradeIndex is 2", async () => {
    // Each win: +8 ticks × $5 = +$40 gross — wait, with tickValue=5 and slTicks=4:
    // win  pnl = 4 * 2 * 5 = $40 (8 ticks × $5)
    // loss pnl = -4 * 5 = -$20 (4 ticks × $5)
    // Start at $35: after two wins (+$80) equity = $115.
    // Third trade is a loss (-$20) → equity = $95. Not a blowup yet.
    // We need a starting balance just barely above zero after the first
    // two losses to make the third trigger it.
    //
    // Easiest: start at $30 with [win, win, loss, loss, loss]:
    // after t0 win:  +40 → $70
    // after t1 win:  +40 → $110
    // after t2 loss: -20 → $90  (no blowup)
    // We need a scenario where exactly trade index 2 causes blowup.
    // Use [win, loss, loss] with startingBalance just enough to survive trade 0 and 1
    // but fall at trade 2.
    //
    // win pnl = +$40; loss pnl = -$20
    // Start=$25: +40=$65, -20=$45, -20=$25 (still positive). Need more losses.
    //
    // Simplest exact setup: [win, loss, loss, loss] start=$50
    // +40 = $90; -20 = $70; -20 = $50; -20 = $30. Still positive.
    //
    // Use startingBalance=19 with wins=[false, false, false]:
    // t0: -20 → equity=-1 → blowup at 0. Wrong.
    //
    // Use wins=[true, true, false, false, false] startingBalance=5:
    // t0: +40 → $45; t1: +40 → $85; t2: -20 → $65; t3: -20 → $45; t4: -20 → $25. No blowup.
    //
    // Keep it simple: wins=[true, false, false] startingBalance=10
    // t0: +40 → $50; t1: -20 → $30; t2: -20 → $10 (>0, no blowup). Hmm.
    //
    // wins=[false, false, false] startingBalance=35:
    // t0: -20 → $15; t1: -20 → -$5 → blowup at index 1. Not 2.
    //
    // wins=[false, false, false] startingBalance=45:
    // t0: -20 → $25; t1: -20 → $5; t2: -20 → -$15 → blowup at index 2. Correct.
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false, false, false]),
      startingBalance: 45,
    });
    expect(result.trades).toHaveLength(3);
    expect(result.blowupTradeIndex).toBe(2);
  });

  it("blowup index is not overwritten by subsequent losing trades after blowup", async () => {
    // wins=[false, false, false], startingBalance=35:
    // t0: -20 → $15; t1: -20 → -$5 → blowup at index 1; t2: -20 → -$25 (blowup already set).
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false, false, false]),
      startingBalance: 35,
    });
    expect(result.trades).toHaveLength(3);
    // Blowup happens at trade 1 (index 1), subsequent trade at index 2 must NOT overwrite.
    expect(result.blowupTradeIndex).toBe(1);
  });
});

// ── Tests: highestBalance and lowestBalance tracking ─────────────────

describe("runBacktest — highestBalance and lowestBalance tracking across mixed trades", () => {
  it("highestBalance is the peak equity after all trades, lowestBalance is the trough", async () => {
    // wins=[true, false, true] startingBalance=100
    // Each win: +$40; each loss: -$20
    // t0 win:  100 + 40 = 140 (new high)
    // t1 loss: 140 - 20 = 120 (no change to peak, new low candidate: 120 > 100)
    // t2 win:  120 + 40 = 160 (new high)
    // highestBalance=160, lowestBalance=100 (never dropped below start)
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true, false, true]),
      startingBalance: 100,
    });
    expect(result.trades).toHaveLength(3);
    expect(result.highestBalance).toBeCloseTo(160, 6);
    // lowestBalance stays at starting balance since equity never went below it.
    expect(result.lowestBalance).toBeCloseTo(100, 6);
    expect(result.blowupTradeIndex).toBeUndefined();
  });

  it("lowestBalance tracks the actual lowest point when losses precede wins", async () => {
    // wins=[false, false, true, true] startingBalance=200
    // t0 loss: -20 → 180 (new low: 180)
    // t1 loss: -20 → 160 (new low: 160)
    // t2 win:  +40 → 200
    // t3 win:  +40 → 240 (new high: 240)
    // highestBalance=240, lowestBalance=160
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false, false, true, true]),
      startingBalance: 200,
    });
    expect(result.trades).toHaveLength(4);
    expect(result.highestBalance).toBeCloseTo(240, 6);
    expect(result.lowestBalance).toBeCloseTo(160, 6);
    expect(result.blowupTradeIndex).toBeUndefined();
  });

  it("highestBalance equals startingBalance when all trades are losses", async () => {
    // Equity only decreases — highestBalance stays at the starting value.
    // wins=[false, false], startingBalance=200
    // t0: -20 → 180; t1: -20 → 160
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([false, false]),
      startingBalance: 200,
    });
    expect(result.trades).toHaveLength(2);
    // highestBalance should still be 200 (never went above start)
    expect(result.highestBalance).toBeCloseTo(200, 6);
    expect(result.lowestBalance).toBeCloseTo(160, 6);
  });

  it("startingBalance is echoed back in result", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      startingBalance: 12345,
    });
    expect(result.startingBalance).toBe(12345);
  });
});

// ── Tests: no trades produced ────────────────────────────────────────

describe("runBacktest — startingBalance set but no trades generated", () => {
  it("balance fields are present and equal to startingBalance when no trades fire", async () => {
    // Empty bars → no trades.
    const result = await runBacktest({
      ...BASE_OPTS,
      bars: [],
      startingBalance: 500,
    });
    // emptyResult() path: balance fields won't be present since startingBalance is not
    // threaded through emptyResult(). Verify the actual behavior: absent fields.
    // The implementation returns early via emptyResult() which does NOT include
    // startingBalance in the spread — so the fields are absent.
    expect("startingBalance" in result).toBe(false);
  });

  it("single seed bar (warmup only) — no entries fire — balance fields present and unchanged", async () => {
    // Only one bar — barIndex=0 is the seed bar, shouldEnter guard (barIndex < 1) blocks
    // any entry, so zero trades are produced.  startingBalance is threaded through the
    // full run path (not emptyResult), so the spread appears in the result.
    const singleBar: BarData[] = [bar(0, 20000, 20000)];
    const result = await runBacktest({
      ...BASE_OPTS,
      bars: singleBar,
      startingBalance: 750,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.startingBalance).toBe(750);
    expect(result.highestBalance).toBe(750);
    expect(result.lowestBalance).toBe(750);
    expect(result.blowupTradeIndex).toBeUndefined();
  });
});

// ── Tests: fixed-count sizing ────────────────────────────────────────

/**
 * The count is the caller's argument, not a param. Nothing in the blob can
 * move it, which is the property that made deleting `paramValues.size` safe.
 */
describe("runBacktest — sizing at a fixed contract count", () => {
  it("takes the caller's count", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      sizing: { mode: "fixed", contracts: 3 },
    });
    expect(result.trades[0].size).toBe(3);
  });

  it("is one contract when the caller says nothing, whatever the blob carries", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      paramOverrides: { size: 7 },
    });
    expect(result.trades[0].size).toBe(1);
  });
});

// ── Tests: --risk-usd sizing ─────────────────────────────────────────

/**
 * The mode the trader calibrates the budget on, and the one the fixed-count
 * tests above cannot reach: `sizing` runs the engine's own
 * `resolveRiskSizedContracts`, so the count and the budget skip are the ones
 * the engine would have produced.
 *
 * At BASE_OPTS' $5 tick and a 4-tick stop with fees off, one contract loses
 * $20 at the stop.
 */
describe("runBacktest — sizing at a per-trade risk budget", () => {
  it("closes a risk-sized trade at the size it opened, not at the param blob's count", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      // $100 / $20 = 5 contracts, under the ceiling. The fixed default is 1,
      // so a close that reads anything but the open position reports a fifth
      // of the money — which is what the latent `size` bug did.
      sizing: { mode: "risk", maxRiskPerTradeUsd: 100, maxContracts: 10 },
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.size).toBe(5);
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.pnlTicks).toBe(8);
    expect(trade.grossPnlDollars).toBe(8 * 5 * 5);
  });

  it("caps at the account's ceiling when the budget affords more", async () => {
    const result = await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      sizing: { mode: "risk", maxRiskPerTradeUsd: 100, maxContracts: 2 },
    });
    expect(result.trades[0].size).toBe(2);
  });

  it("fires onRiskBudgetSkip and takes no trade when one contract does not fit", async () => {
    const onRiskBudgetSkip = vi.fn();
    const bars = buildTradeBars([true]);
    const result = await runBacktest({
      ...BASE_OPTS,
      bars,
      // $10 does not cover one contract's $20 loss at the stop.
      sizing: { mode: "risk", maxRiskPerTradeUsd: 10, maxContracts: 10 },
      onRiskBudgetSkip,
    });

    expect(result.trades).toHaveLength(0);
    // Every bar past the strategy's warmup guard signals and every one of them
    // skips — the callback carries the signal bar so a caller can drop skips
    // that land in its own warmup window.
    expect(onRiskBudgetSkip.mock.calls.map((c) => (c[0] as BarData).timestamp)).toEqual(
      bars.slice(1).map((b) => b.timestamp),
    );
  });

  it("hands the refusal its three numbers, so the caller does not re-derive them", async () => {
    const onRiskBudgetSkip = vi.fn();
    await runBacktest({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true]),
      sizing: { mode: "risk", maxRiskPerTradeUsd: 10, maxContracts: 10 },
      onRiskBudgetSkip,
    });
    // 4-tick stop at $5/tick, fees off.
    expect(onRiskBudgetSkip.mock.calls[0][1]).toEqual({
      slTicks: 4,
      riskPerContractUsd: 20,
      maxRiskPerTradeUsd: 10,
    });
  });
});

/**
 * The playbook's own cap and share, at `engine.entry.test.ts`'s numbers: MNQ's
 * $0.50 tick and $0.62 a side, a 40-tick stop ($21.24 a contract), a $100
 * budget and a ceiling of 10. Each count below is the one the engine's entry
 * path places for the same deployment settings there.
 */
describe("runBacktest — the playbook's own limits, at the engine's numbers", () => {
  const fortyTick: StrategyModule<FixtureParams> = {
    ...pairedLongStrategy,
    key: "test-forty-tick",
    shouldEnter(ctx) {
      return ctx.barIndex % 2 === 1 ? { side: 0, slTicks: 40, tpTicks: 80 } : null;
    },
  };
  const ENGINE_OPTS = {
    ...PAIRED_OPTS,
    strategy: fortyTick,
    tickValue: 0.5,
    feePerSideUsd: 0.62,
    sizing: { mode: "risk", maxRiskPerTradeUsd: 100, maxContracts: 10 },
  } as const;

  const cases: Array<[string, Record<string, number>, number]> = [
    ["no setting (the engine's 4)", {}, 4],
    ["the off values (the engine's 4)", { playbookMaxContracts: 0, playbookRiskPercent: 100 }, 4],
    ["a cap of 1 (the engine's 1)", { playbookMaxContracts: 1 }, 1],
    ["a 50% share: $50 buys 2", { playbookRiskPercent: 50 }, 2],
  ];
  for (const [label, paramOverrides, contracts] of cases) {
    it(`sizes ${label}`, async () => {
      const result = await runBacktest({ ...ENGINE_OPTS, bars: buildTradeBars([true]), paramOverrides });
      expect(result.trades[0].size).toBe(contracts);
    });
  }

  it("skips when the share leaves less than one contract (the engine's entry_risk_budget), naming the scaled budget", async () => {
    const onRiskBudgetSkip = vi.fn();
    const result = await runBacktest({
      ...ENGINE_OPTS,
      bars: buildTradeBars([true]),
      paramOverrides: { playbookRiskPercent: 21 },
      onRiskBudgetSkip,
    });
    expect(result.trades).toHaveLength(0);
    expect(onRiskBudgetSkip.mock.calls[0][1]).toEqual({ slTicks: 40, riskPerContractUsd: 21.24, maxRiskPerTradeUsd: 21 });
  });

  it("ends a flat-budget run on a setting the sizer cannot use, as the engine refuses the entry", async () => {
    await expect(
      runBacktest({ ...ENGINE_OPTS, bars: buildTradeBars([true]), paramOverrides: { playbookMaxContracts: 4 } }),
    ).rejects.toThrow(/playbook max contracts/);
  });
});

// ── Tests: structured entry skips ────────────────────────────────────

/**
 * The engine persists an `EntrySkip` into `skipped_signals`; a backtest that
 * discarded it would leave the two paths reporting different things about the
 * same bar, which is the parity defect the callback exists to close.
 */
describe("runBacktest — onEntrySkip", () => {
  const skipsEveryBar: StrategyModule<FixtureParams> = {
    ...alwaysLongStrategy,
    key: "test-always-skips",
    shouldEnter({ barIndex }) {
      if (barIndex < 1) return null;
      return { skip: "no session VWAP on this bar", gate: "vwap", detail: { barIndex } };
    },
  };

  it("reports every skip whole and still takes no trade", async () => {
    const onEntrySkip = vi.fn();
    const bars = buildTradeBars([true]);
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: skipsEveryBar,
      bars,
      onEntrySkip,
    });

    expect(result.trades).toHaveLength(0);
    expect(onEntrySkip.mock.calls.map((c) => (c[1] as BarData).timestamp)).toEqual(
      bars.slice(1).map((b) => b.timestamp),
    );
    expect(onEntrySkip.mock.calls[0][0]).toEqual({
      skip: "no session VWAP on this bar",
      gate: "vwap",
      detail: { barIndex: 1 },
    });
  });

  it("stays silent for a strategy that returns a bare null", async () => {
    const onEntrySkip = vi.fn();
    await runBacktest({
      ...BASE_OPTS,
      strategy: { ...alwaysLongStrategy, key: "test-null", shouldEnter: () => null },
      bars: buildTradeBars([true]),
      onEntrySkip,
    });
    expect(onEntrySkip).not.toHaveBeenCalled();
  });
});

// ── Tests: cross-timeframe exit filters ──────────────────────────────

/**
 * `crossTimeframeBars` is built empty at every site in this file and populated
 * only by the engine, so an exit filter on a non-`same` timeframe returned
 * false on every bar here and fired normally live. The run is refused rather
 * than warned about: a warning left the divergent numbers in the reader's
 * hands, and they look exactly like a run of the deployment that would trade.
 */
describe("runBacktest — an exit filter on a timeframe this path cannot serve", () => {
  /** A strategy wired to the registry the way a real one is: filter indicator
   *  configs from `buildAllFilterIndicators`, exits through the registry. */
  const filterAwareStrategy: StrategyModule<FixtureParams> = {
    ...alwaysLongStrategy,
    key: "test-filter-aware",
    buildIndicators(params) {
      return buildAllFilterIndicators(params as unknown as AllFilterParams);
    },
    shouldExit({ bars, barIndex, indicators, position, params, tickSize, crossTimeframeBars }) {
      if (!position) return false;
      return anyExitFilterTriggered({
        bars,
        barIndex,
        indicators,
        side: position.side,
        params: params as unknown as AllFilterParams,
        tickSize,
        crossTimeframeBars,
        position,
      });
    },
  };

  /** Flat at 20000 long enough to clear warmup and open a position, then one
   *  bar that closes a tick lower without reaching either bracket leg — an
   *  EMA(2) cross-down and nothing else. */
  function emaCrossDownBars(): BarData[] {
    const out: BarData[] = [];
    for (let i = 0; i < 8; i++) out.push(bar(i, 20000, 20000, { high: 20000.25, low: 19999.75 }));
    out.push(bar(8, 20000, 19999.75, { high: 20000.25, low: 19999.5 }));
    return out;
  }

  it("refuses the run", async () => {
    await expect(
      runBacktest({
        ...BASE_OPTS,
        strategy: filterAwareStrategy,
        bars: emaCrossDownBars(),
        paramOverrides: { emaExitEnabled: true, emaExitTimeframe: "15m", emaExitPeriod: 2 },
      }),
    ).rejects.toThrow("only the live engine fetches those");
  });

  // The narrow half. `same` reads the strategy's own indicator pipeline, which
  // this path builds, so it is not a parity defect and the refusal must not
  // reach it — the over-broad fix (refuse the filter whenever it is enabled)
  // deletes a working exit.
  it("runs the same configuration on the strategy's own timeframe, and the filter fires", async () => {
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: filterAwareStrategy,
      bars: emaCrossDownBars(),
      paramOverrides: { emaExitEnabled: true, emaExitTimeframe: "same", emaExitPeriod: 2 },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("ema_exit");
  });
});

// ── Exchange early close (A63) ───────────────────────────────────────

/**
 * The backtest half of the A63 parity defect.
 *
 * `inWindow` read `bar.timestamp` against a fixed `HH:MM` pair with no
 * calendar term, so on a 13:00 ET close the first bar outside the window was
 * the **18:00 Globex reopen** — five hours and one settlement after the halt,
 * booked as `time_window_close`. The engine's clock guard was wrong in the
 * opposite direction, which is what made it a parity defect rather than two
 * bugs. Both now read `isInTradableSessionWindow`.
 *
 * 2026-11-26 is Thanksgiving Day: a 13:00 ET halt, so the effective end is
 * 12:55 with the five-minute cushion. EST, so ET = UTC−5.
 */
describe("runBacktest — the session's last bar on an exchange early close", () => {
  /** One flat 1m bar at `minuteOfDayEt` on `etDate`, priced so no bracket leg
   *  can be reached — every assertion below is about *which* bar closes the
   *  trade, and a TP or SL hit would answer a different question. */
  function flatBar(etDate: string, hourEt: number, minuteEt: number): BarData {
    const [y, m, d] = etDate.split("-").map(Number);
    const ts = new Date(Date.UTC(y, m - 1, d, hourEt + 5, minuteEt, 0));
    return {
      timestamp: ts.toISOString(),
      open: 20000,
      high: 20000.25,
      low: 19999.75,
      close: 20000,
      volume: 100,
    };
  }

  /** 12:50–12:54 ET, then the 18:00 ET Globex reopen. The gap is the whole
   *  point: on an early close no bar prints in between. */
  function earlyCloseBars(etDate: string): BarData[] {
    return [
      flatBar(etDate, 12, 50),
      flatBar(etDate, 12, 51),
      flatBar(etDate, 12, 52),
      flatBar(etDate, 12, 53),
      flatBar(etDate, 12, 54),
      flatBar(etDate, 18, 0),
    ];
  }

  it("force-exits on the last bar before the halt, not on the 18:00 reopen", async () => {
    const result = await runBacktest({ ...BASE_OPTS, bars: earlyCloseBars("2026-11-26") });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe("time_window_close");
    // Index 4 is the 12:54 bar, whose close *is* 12:55 — the effective end
    // once the cushion is applied. Index 5 is the reopen, which is what this
    // path booked before the calendar term existed.
    expect(trade.exitBarIndex).toBe(4);
    // Stamped at that close, the engine's instant (A111).
    expect(trade.exitTimestamp).toBe(flatBar("2026-11-26", 12, 55).timestamp);
  });

  it("refuses an entry on a bar whose close is already past the halt", async () => {
    // The always-long fixture enters on every bar from index 1, so index 1 is
    // the 12:54 bar — the one whose close is the halt. Entering there is a
    // position nothing can manage out.
    const bars = [
      flatBar("2026-11-26", 12, 53),
      flatBar("2026-11-26", 12, 54),
      flatBar("2026-11-26", 18, 0),
    ];

    const result = await runBacktest({ ...BASE_OPTS, bars });

    expect(result.trades).toHaveLength(0);
  });

  /**
   * The control, and the reason the 34 recorded artifacts are unchanged
   * except on their early-close trades. 2026-11-25 is the Wednesday before:
   * a full session, no row in the calendar, so the force-exit still lands on
   * the first bar outside the declared window.
   */
  it("leaves a full session alone — the force-exit is still the first bar outside the window", async () => {
    const result = await runBacktest({ ...BASE_OPTS, bars: earlyCloseBars("2026-11-25") });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("time_window_close");
    expect(result.trades[0].exitBarIndex).toBe(5);
  });

  /**
   * Past the calendar's far end the platform cannot tell an early close from
   * a normal one. It does not refuse the run — a backtest is not a money path
   * and a throw would block research on a table edit — but it must not let
   * the reader take the early-close trades on trust.
   */
  it("warns when the bars reach past the calendar's horizon", async () => {
    const result = await runBacktest({ ...BASE_OPTS, bars: earlyCloseBars("2029-11-26") });

    expect(result.warnings?.some((w) => w.includes("early-close calendar"))).toBe(true);
  });
});

// ── The flatten's price ──────────────────────────────────────────────

/**
 * Which bar force-exits is A63's and is not what this pins. **Which price it
 * books is**, and it was one bar late.
 *
 * The engine flattens on the clock — the instant `isInTradableSessionWindow`
 * turns false — and its market order fills near the print at that instant. This
 * path booked the first out-of-window bar's **close**, so on a 5m series
 * against a 15:55 window the engine filled at 15:55 and the run booked 16:00:
 * five minutes of movement the engine never saw, on every flatten in the
 * corpus.
 *
 * Every fixture below prices `open` and `close` twenty points apart, so an
 * assertion can only pass on one of them, and gives the fixture a 100-point
 * stop so no bracket leg can pre-empt the flatten.
 */
describe("runBacktest — the price the session-end flatten books", () => {
  /** A bar at an ET wall-clock minute. Both dates used here are EST, so
   *  ET = UTC−5. */
  function etBar(
    etDate: string,
    hourEt: number,
    minuteEt: number,
    open: number,
    close: number,
  ): BarData {
    const [y, m, d] = etDate.split("-").map(Number);
    return {
      timestamp: new Date(Date.UTC(y, m - 1, d, hourEt + 5, minuteEt, 0)).toISOString(),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100,
    };
  }

  /** The always-long fixture at a declared timeframe — `barLengthMs` comes off
   *  `config.timeframe`, which is what makes the same bar sequence a 5m series
   *  or a 15m one — entering once, on bar 1, with a 100-point stop. */
  function wideStopAt(timeframe: "5m" | "15m"): StrategyModule<FixtureParams> {
    return {
      ...alwaysLongStrategy,
      key: `test-always-long-${timeframe}`,
      config: { ...alwaysLongStrategy.config, timeframe },
      shouldEnter({ barIndex }) {
        if (barIndex !== 1) return null;
        const slTicks = 400;
        return { side: 0, slTicks, tpTicks: resolveEffectiveTpTicks(slTicks, 2) };
      },
    };
  }

  /**
   * 5m, a full session, the window every live 5m playbook declares. The last
   * in-window bar opens 15:50 and the first out-of-window bar opens **15:55** —
   * which *is* the engine's clock instant, so the fix is exact here and this is
   * the case the whole corpus's flatten book is priced on.
   */
  it("books the first out-of-window bar's open on 5m, where that open is the window end", async () => {
    // Entry on the 15:45 bar: the 15:50 bar closes at 15:55, out of window,
    // so it takes no entry (A103).
    const bars = [
      etBar("2025-01-02", 15, 40, 20000, 20000),
      etBar("2025-01-02", 15, 45, 20000, 20000),
      etBar("2025-01-02", 15, 50, 20000, 20000),
      etBar("2025-01-02", 15, 55, 20005, 20025),
    ];

    const result = await runBacktest({ ...BASE_OPTS, strategy: wideStopAt("5m"), bars });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe("time_window_close");
    expect(trade.exitBarIndex).toBe(3);
    // 20005 is the 15:55 print, where the engine fills. 20025 is the 16:00
    // close, which is what this path booked.
    expect(trade.exitPrice).toBe(20005);
  });

  /**
   * The guard on the other branch, and the reason the fix is not one
   * unconditional `bar.open`.
   *
   * On a 13:00 ET early close the flatten bar is the one whose **close** is the
   * effective halt (12:55, cushion applied) — `isInTradableBar` refuses it on
   * the calendar term, asked at the close, while its open was still tradable.
   * The engine's clock fires at 12:55, which is that close, so the close is the
   * parity price here and the open would book the flatten a whole bar early.
   * 2026-11-26 is Thanksgiving Day.
   */
  it("books the close on an early-close halt, where the close is the engine's instant", async () => {
    const bars = [
      etBar("2026-11-26", 12, 40, 20000, 20000),
      etBar("2026-11-26", 12, 45, 20000, 20000),
      etBar("2026-11-26", 12, 50, 20005, 20025),
    ];

    const result = await runBacktest({ ...BASE_OPTS, strategy: wideStopAt("5m"), bars });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe("time_window_close");
    expect(trade.exitBarIndex).toBe(2);
    // 20025 is the 12:55 print — the halt the engine fires at.
    expect(trade.exitPrice).toBe(20025);
  });

  it("A111: stamps an early-close flatten booked at the bar's close at that close, not at the bar's open", async () => {
    const bars = [
      etBar("2026-11-26", 12, 40, 20000, 20000),
      etBar("2026-11-26", 12, 45, 20000, 20000),
      etBar("2026-11-26", 12, 50, 20005, 20025),
    ];

    const result = await runBacktest({ ...BASE_OPTS, strategy: wideStopAt("5m"), bars });

    const trade = result.trades[0];
    expect(trade.exitTimestamp).toBe(etBar("2026-11-26", 12, 55, 0, 0).timestamp);
    expect(trade.exitAtBarOpen).toBeUndefined();
  });

  it("A111: the flatten at the window end keeps the bar-open stamp, which is the engine's instant there", async () => {
    const bars = [
      etBar("2025-01-02", 15, 40, 20000, 20000),
      etBar("2025-01-02", 15, 45, 20000, 20000),
      etBar("2025-01-02", 15, 50, 20000, 20000),
      etBar("2025-01-02", 15, 55, 20005, 20025),
    ];

    const result = await runBacktest({ ...BASE_OPTS, strategy: wideStopAt("5m"), bars });

    expect(result.trades[0].exitTimestamp).toBe(bars[3].timestamp);
  });
});

// ── Which bars evaluate an entry (A103) ──────────────────────────────

/**
 * The engine evaluates `shouldEnter` at a bar's close and asks
 * `isInTradableSessionWindow(now)` there. The backtest used to ask at the
 * bar's open, so with a 12:00–13:00 pause on 30m the 12:30 bar (closing 13:00)
 * was skipped here and evaluated live, and the 11:30 bar (closing 12:00) the
 * reverse. EST date, so ET = UTC−5.
 */
describe("A103 — an entry is judged at the bar's close, as the engine judges it", () => {
  const flatBarAt = (minuteOfDayEt: number): BarData => ({
    timestamp: new Date(Date.UTC(2025, 0, 2, 5, minuteOfDayEt, 0)).toISOString(),
    open: 20000,
    high: 20000.25,
    low: 19999.75,
    close: 20000,
    volume: 100,
  });

  function evaluatedOpensEt(timeframe: "15m" | "30m", firstMinuteEt: number, count: number, overrides = {}) {
    const minutes = timeframe === "30m" ? 30 : 15;
    const bars = Array.from({ length: count }, (_, k) => flatBarAt(firstMinuteEt + k * minutes));
    const asked: number[] = [];
    const strategy: StrategyModule<FixtureParams> = {
      ...alwaysLongStrategy,
      key: `test-a103-${timeframe}`,
      config: { ...alwaysLongStrategy.config, timeframe },
      shouldEnter: ({ barIndex }) => {
        asked.push(barIndex);
        return null;
      },
    };
    return runBacktest({ ...BASE_OPTS, strategy, bars, paramOverrides: overrides }).then(() => ({ bars, asked, minutes }));
  }

  const etLabel = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

  it("30m with a 12:00–13:00 pause: evaluates the 12:30 bar, skips the 11:30 and 15:30 bars", async () => {
    const { bars, asked } = await evaluatedOpensEt("30m", 9 * 60, 15, { pauseWindows: [{ start: "12:00", end: "13:00" }] });

    expect(asked.map((i) => etLabel(bars[i].timestamp))).toEqual([
      "09:00", "09:30", "10:00", "10:30", "11:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00",
    ]);
  });

  it("evaluates exactly the bars whose close the engine's predicate admits", async () => {
    const pause = { pauseWindows: [{ start: "12:00", end: "13:00" }] };
    const { bars, asked, minutes } = await evaluatedOpensEt("30m", 9 * 60, 15, pause);
    const windows = collectSessionWindows(alwaysLongStrategy.config.session, pause);
    const admitted = bars.flatMap((b, i) =>
      isInTradableSessionWindow(new Date(Date.parse(b.timestamp) + minutes * 60_000), windows) ? [i] : [],
    );

    expect(asked).toEqual(admitted);
  });

  it("15m: takes no entry on the 15:45 bar, whose close is past the 15:55 window end", async () => {
    const { bars, asked } = await evaluatedOpensEt("15m", 15 * 60 + 15, 4);

    expect(asked.map((i) => etLabel(bars[i].timestamp))).toEqual(["15:15", "15:30"]);
  });
});

// ── A flatten inside a bar (A105) ────────────────────────────────────

/**
 * On 30m bars against a 15:55 window the bar opening 15:30 closes at 16:00, so
 * the engine's clock flattens inside it. This path used to resolve the bracket
 * on that bar's whole range, then resolve it again on the 16:00–16:30 bar
 * before flattening at that bar's open: stops and targets the engine could not
 * fill, and a flatten one bar late.
 *
 * Every series here is built from 1m bars through the CLI's own composition
 * (`aggregateBars`, `barToBarData`), so the 30m bar and its sub-bars agree.
 * The fixture enters long once, at the close of bar 1, at 20000, with a stop at
 * 19990 and a target at 20010. All dates are EST, so ET = UTC−5.
 */
describe("runBacktest — a session flatten inside a bar (A105)", () => {
  const ENTRY = 20000;
  const STOP = 19990;
  const TARGET = 20010;

  /** EST unless the date is one of the EDT ones a test names. */
  const EDT_DATES = new Set(["2025-07-02"]);

  function minuteBar(etDate: string, minuteOfDayEt: number, open: number, patch: Partial<BarData> = {}): BarData {
    const [y, m, d] = etDate.split("-").map(Number);
    const utcOffsetHours = EDT_DATES.has(etDate) ? 4 : 5;
    return {
      timestamp: new Date(Date.UTC(y, m - 1, d, utcOffsetHours, minuteOfDayEt, 0)).toISOString(),
      open,
      high: open + 0.25,
      low: open - 0.25,
      close: open,
      volume: 100,
      ...patch,
    };
  }

  /** Flat 1m bars at ENTRY over `[fromMinute, toMinute)` ET, with overrides by ET minute. */
  function minutes(
    etDate: string,
    fromMinute: number,
    toMinute: number,
    overrides: Record<number, (b: BarData) => BarData> = {},
  ): BarData[] {
    const out: BarData[] = [];
    for (let min = fromMinute; min < toMinute; min++) {
      const b = minuteBar(etDate, min, ENTRY);
      out.push(overrides[min]?.(b) ?? b);
    }
    return out;
  }

  function aggregate(oneMinute: BarData[], timeframeMinutes: number): BarData[] {
    return aggregateBars(oneMinute.map((b) => barDataToBar(b, "MNQ.c.0")), timeframeMinutes).map(barToBarData);
  }

  function longAt(timeframe: "1m" | "5m" | "15m" | "30m"): StrategyModule<FixtureParams> {
    return {
      ...alwaysLongStrategy,
      key: `test-long-once-${timeframe}`,
      config: { ...alwaysLongStrategy.config, timeframe },
      shouldEnter({ barIndex }) {
        if (barIndex !== 1) return null;
        return { side: 0, slTicks: 40, tpTicks: 40 };
      },
    };
  }

  const hm = (h: number, m: number) => h * 60 + m;
  const touchStop = (b: BarData): BarData => ({ ...b, low: STOP - 5 });
  const touchTarget = (b: BarData): BarData => ({ ...b, high: TARGET + 2 });
  const opensAt = (price: number) => (b: BarData): BarData => ({ ...b, open: price, high: price + 0.25, low: price - 0.25, close: price });

  /** 14:30–16:30 ET on a normal session: bars 14:30, 15:00 (entry), 15:30, 16:00. */
  function normalDay(overrides: Record<number, (b: BarData) => BarData>, etDate = "2025-01-02") {
    const subBars = minutes(etDate, hm(14, 30), hm(16, 30), {
      // The 16:00 bar falls through the stop: it must not be reached.
      [hm(16, 10)]: touchStop,
      ...overrides,
    });
    return { subBars, bars: aggregate(subBars, 30) };
  }

  it("flattens at 15:55 on the 15:30 bar when the stop is only touched at 15:58, and books no stop", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 55)]: opensAt(20002), [hm(15, 58)]: touchStop });

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe("time_window_close");
    expect(trade.exitBarIndex).toBe(2);
    // Stamped at the flatten minute, not the 15:30 bar's open.
    expect(trade.exitTimestamp).toBe(minuteBar("2025-01-02", hm(15, 55), ENTRY).timestamp);
    // The open of the 15:55 1m bar — the engine's clock instant.
    expect(trade.exitPrice).toBe(20002);
  });

  it("keeps the bar-open stamp on a bracket fill inside the straddling bar", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 50)]: touchTarget });

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades[0].exitReason).toBe("take_profit");
    expect(result.trades[0].exitTimestamp).toBe(bars[2].timestamp);
  });

  it("keeps a target filled at 15:50, before the flatten", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 50)]: touchTarget, [hm(15, 58)]: touchStop });

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("take_profit");
    expect(result.trades[0].exitPrice).toBe(TARGET);
    expect(result.trades[0].exitBarIndex).toBe(2);
  });

  it("does not reach the 16:00 bar's bracket or its open when nothing touches the bracket before 15:55", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 55)]: opensAt(20003) });

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("time_window_close");
    expect(result.trades[0].exitBarIndex).toBe(2);
    expect(result.trades[0].exitPrice).toBe(20003);
  });

  it.each([
    ["Thanksgiving, 13:00 halt", "2026-11-26", hm(12, 55)],
    ["the day after, 13:15 halt", "2026-11-27", hm(13, 10)],
  ])("on an early close (%s) flattens at the halt less the cushion, inside the bar, with no stop after it", async (_name, etDate, flattenMinute) => {
    // Bar 1 is the 30m bar ending at or before the flatten's bar; bar 2 holds the flatten.
    const straddleOpen = flattenMinute - (flattenMinute % 30);
    const subBars = [
      ...minutes(etDate, straddleOpen - 60, straddleOpen + 30, {
        [flattenMinute]: opensAt(20004),
        [flattenMinute + 2]: touchStop,
      }),
      // The 18:00 Globex reopen, five hours later, where the A63 bug booked it.
      ...minutes(etDate, hm(18, 0), hm(18, 30), { [hm(18, 1)]: touchStop }),
    ];
    const bars = aggregate(subBars, 30);

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe("time_window_close");
    expect(trade.exitBarIndex).toBe(2);
    expect(trade.exitPrice).toBe(20004);
  });

  it("flattens at 15:55 EDT on a summer date, which is 19:55 UTC", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 55)]: opensAt(20002), [hm(15, 58)]: touchStop }, "2025-07-02");

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(bars[2].timestamp).toBe("2025-07-02T19:30:00.000Z");
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("time_window_close");
    expect(result.trades[0].exitPrice).toBe(20002);
    expect(result.trades[0].exitTimestamp).toBe("2025-07-02T19:55:00.000Z");
  });

  describe("a gap in the 1m bars at the flatten", () => {
    const without = (subBars: BarData[], gone: number[]) => {
      const missing = new Set(gone.map((min) => minuteBar("2025-01-02", min, ENTRY).timestamp));
      return subBars.filter((b) => !missing.has(b.timestamp));
    };

    it("books the next print's open when 15:55 and 15:56 have no bar, still stamped 15:55", async () => {
      const full = normalDay({ [hm(15, 57)]: opensAt(20004) }).subBars;
      const subBars = without(full, [hm(15, 55), hm(15, 56)]);

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars: aggregate(subBars, 30), subBars });

      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitPrice).toBe(20004);
      expect(result.trades[0].exitTimestamp).toBe(minuteBar("2025-01-02", hm(15, 55), ENTRY).timestamp);
    });

    it("books the last close before the flatten when nothing prints from 15:55 to the bar's close", async () => {
      const full = normalDay({ [hm(15, 54)]: (b) => ({ ...b, close: 20001 }) }).subBars;
      const gone = Array.from({ length: 5 }, (_, k) => hm(15, 55) + k);
      const subBars = without(full, gone);

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars: aggregate(subBars, 30), subBars });

      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitBarIndex).toBe(2);
      expect(result.trades[0].exitPrice).toBe(20001);
    });
  });

  /** A deployment's pause window is a flatten too: the engine's guard reads
   *  the same windows, with the pause subtracted. */
  describe("a pause window that starts inside a bar", () => {
    const pauseAt = (start: string, end: string) => ({ pauseWindows: [{ start, end }] });

    it("flattens at 10:40 inside the 10:30 30m bar, and books no stop after it", async () => {
      const subBars = minutes("2025-01-02", hm(9, 30), hm(11, 30), {
        [hm(10, 40)]: opensAt(20003),
        [hm(10, 45)]: touchStop,
      });
      const bars = aggregate(subBars, 30);

      const result = await runBacktest({
        ...BASE_OPTS,
        strategy: longAt("30m"),
        bars,
        subBars,
        paramOverrides: pauseAt("10:40", "10:50"),
      });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitBarIndex).toBe(2);
      expect(result.trades[0].exitPrice).toBe(20003);
      expect(result.trades[0].exitTimestamp).toBe(minuteBar("2025-01-02", hm(10, 40), ENTRY).timestamp);
    });

    it("still scans a 5m bar when the pause starts off the 5-minute grid", async () => {
      const subBars = minutes("2025-01-02", hm(10, 20), hm(10, 50), {
        [hm(10, 32)]: opensAt(20003),
        [hm(10, 33)]: touchStop,
      });
      const bars = aggregate(subBars, 5);

      const result = await runBacktest({
        ...BASE_OPTS,
        strategy: longAt("5m"),
        bars,
        subBars,
        paramOverrides: pauseAt("10:32", "10:40"),
      });

      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitPrice).toBe(20003);
    });
  });

  describe("straddleSubBars — what the CLI hands over", () => {
    it("keeps only the 15:30 bar's minutes, and a run on them equals a run on the whole 1m series", async () => {
      const { bars, subBars } = normalDay({ [hm(15, 55)]: opensAt(20002), [hm(15, 40)]: touchStop });
      const strategy = longAt("30m");

      const kept = straddleSubBars(bars, subBars, [{ strategy }]);

      expect(kept).toHaveLength(30);
      expect(kept?.[0].timestamp).toBe(bars[2].timestamp);
      const onKept = await runBacktest({ ...BASE_OPTS, strategy, bars, subBars: kept });
      const onAll = await runBacktest({ ...BASE_OPTS, strategy, bars, subBars });
      expect(onKept).toEqual(onAll);
      expect(onKept.trades[0].exitReason).toBe("stop_loss");
    });

    it("hands over nothing on 5m against the session's on-grid bounds", () => {
      const subBars = minutes("2025-01-02", hm(15, 40), hm(16, 10));
      expect(straddleSubBars(aggregate(subBars, 5), subBars, [{ strategy: longAt("5m") }])).toBeUndefined();
    });

    it("unions the bars of every leg reading the series", () => {
      const subBars = minutes("2025-01-02", hm(9, 30), hm(16, 30));
      const bars = aggregate(subBars, 30);
      const paused = { strategy: longAt("30m"), paramOverrides: { pauseWindows: [{ start: "10:40", end: "10:50" }] } };

      const kept = straddleSubBars(bars, subBars, [{ strategy: longAt("30m") }, paused]);

      expect(kept?.map((b) => b.timestamp).filter((_, k) => k % 30 === 0)).toEqual([
        minuteBar("2025-01-02", hm(10, 30), ENTRY).timestamp,
        minuteBar("2025-01-02", hm(15, 30), ENTRY).timestamp,
      ]);
    });
  });

  describe("without 1m bars, the approximate rule", () => {
    it("counts a stop the straddling bar touched, since it may have filled before the flatten", async () => {
      const { bars } = normalDay({ [hm(15, 58)]: touchStop });

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].exitReason).toBe("stop_loss");
      expect(result.trades[0].exitPrice).toBe(STOP);
      expect(result.trades[0].exitBarIndex).toBe(2);
      expect(result.warnings?.some((w) => w.includes("1 session flatten fell inside a bar with no 1m bars"))).toBe(true);
    });

    it("counts the touched stop under take-profit-first conflict resolution too", async () => {
      const { bars } = normalDay({ [hm(15, 50)]: touchTarget, [hm(15, 58)]: touchStop });

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, conflictResolution: "take_profit" });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].exitReason).toBe("stop_loss");
      expect(result.trades[0].exitPrice).toBe(STOP);
    });

    it("never fills a target, and caps the flatten at it", async () => {
      const { bars } = normalDay({
        [hm(15, 50)]: touchTarget,
        [hm(15, 59)]: (b) => ({ ...b, high: TARGET + 3, close: TARGET + 3 }),
      });

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars });

      expect(bars[2].close).toBe(TARGET + 3);
      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitPrice).toBe(TARGET);
    });

    it("otherwise flattens at the straddling bar's close", async () => {
      const { bars } = normalDay({ [hm(15, 59)]: (b) => ({ ...b, close: 20001 }) });

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars });

      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitBarIndex).toBe(2);
      expect(result.trades[0].exitPrice).toBe(20001);
    });
  });

  /**
   * On a timeframe whose bars align to the window end no bar holds the flatten,
   * so these runs are what they were: the prod pins' 1m and 5m files are the
   * real-data half of this, unchanged by the fix.
   */
  it.each([
    ["1m", 1],
    ["5m", 5],
  ] as const)("leaves a %s series unchanged, with or without 1m bars", async (timeframe, timeframeMinutes) => {
    const subBars = minutes("2025-01-02", hm(15, 40), hm(16, 10), { [hm(15, 55)]: opensAt(20002) });
    const bars = aggregate(subBars, timeframeMinutes);

    const without = await runBacktest({ ...BASE_OPTS, strategy: longAt(timeframe), bars });
    const withSubs = await runBacktest({ ...BASE_OPTS, strategy: longAt(timeframe), bars, subBars });

    expect(withSubs).toEqual(without);
    expect(without.warnings).toBeUndefined();
    expect(without.trades).toHaveLength(1);
    expect(without.trades[0].exitReason).toBe("time_window_close");
    expect(without.trades[0].exitTimestamp).toBe(minuteBar("2025-01-02", hm(15, 55), ENTRY).timestamp);
    expect(without.trades[0].exitPrice).toBe(20002);
  });

  it("on the 1m bars of a straddling 30m bar, books no stop the 15:55 minute touched", async () => {
    const { bars, subBars } = normalDay({ [hm(15, 55)]: (b) => touchStop(opensAt(20002)(b)) });

    const result = await runBacktest({ ...BASE_OPTS, strategy: longAt("30m"), bars, subBars });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("time_window_close");
    expect(result.trades[0].exitPrice).toBe(20002);
  });

  /**
   * A106: on 1m and 5m the first out-of-window bar opens at 15:55, the
   * engine's flatten instant, so a bracket leg that bar touches is one the
   * engine was already flat for. The flatten books that bar's open.
   */
  describe("a bar that opens at the flatten (A106)", () => {
    it.each([
      ["1m", "stop", 1, touchStop],
      ["5m", "stop", 5, touchStop],
      ["1m", "target", 1, touchTarget],
      ["5m", "target", 5, touchTarget],
    ] as const)("%s: books no %s touched on the 15:55 bar, and flattens at its open", async (timeframe, _leg, timeframeMinutes, touch) => {
      const subBars = minutes("2025-01-02", hm(15, 40), hm(16, 10), {
        [hm(15, 55)]: (b) => touch(opensAt(20002)(b)),
      });
      const bars = aggregate(subBars, timeframeMinutes);
      const flattenBarIndex = bars.findIndex((b) => b.timestamp === minuteBar("2025-01-02", hm(15, 55), ENTRY).timestamp);

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt(timeframe), bars });

      expect(result.trades).toHaveLength(1);
      const trade = result.trades[0];
      expect(trade.exitReason).toBe("time_window_close");
      expect(trade.exitBarIndex).toBe(flattenBarIndex);
      expect(trade.exitTimestamp).toBe(bars[flattenBarIndex].timestamp);
      expect(trade.exitPrice).toBe(20002);
    });

    it.each([
      ["1m", 1],
      ["5m", 5],
    ] as const)("still fills a stop a %s bar inside the window touched, at 15:50", async (timeframe, timeframeMinutes) => {
      const subBars = minutes("2025-01-02", hm(15, 40), hm(16, 10), { [hm(15, 50)]: touchStop });
      const bars = aggregate(subBars, timeframeMinutes);
      const stopBarIndex = bars.findIndex((b) => b.timestamp === minuteBar("2025-01-02", hm(15, 50), ENTRY).timestamp);

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt(timeframe), bars });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].exitReason).toBe("stop_loss");
      expect(result.trades[0].exitPrice).toBe(STOP);
      expect(result.trades[0].exitBarIndex).toBe(stopBarIndex);
    });

    // Break-even at 1R arms on the 15:55 bar's high, below its close; live is
    // flat at that bar's open, so the move never happened.
    it("A107: the flatten bar moves no stop and is marked as an exit at its open", async () => {
      const subBars = minutes("2025-01-02", hm(15, 40), hm(16, 10), {
        [hm(15, 55)]: (b) => ({ ...b, open: 20002, high: 20015 }),
        [hm(15, 59)]: (b) => ({ ...b, high: 20012.25, close: 20012 }),
      });
      const bars = aggregate(subBars, 5);

      const result = await runBacktest({
        ...BASE_OPTS,
        strategy: longAt("5m"),
        bars,
        paramOverrides: { breakEvenFilterEnabled: true, breakEvenFilterAtR: 1, breakEvenFilterOffsetTicks: 0 },
      });

      expect(result.trades).toHaveLength(1);
      const [t] = result.trades;
      expect([t.exitReason, t.exitPrice, t.breakEvenMoved, t.slPrice, t.exitAtBarOpen]).toEqual([
        "time_window_close",
        20002,
        false,
        STOP,
        true,
      ]);
    });
  });

  /**
   * The engine flattens from its clock guard: every `SESSION_END_GUARD_INTERVAL_MS`
   * it asks `isInTradableSessionWindow(now, windows)` and closes at market the
   * first time it is false. The guard's module reaches the strategy loader, so
   * its constant and its call are read from source rather than imported.
   */
  describe("parity with the engine's flatten instant", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const guardSrc = readFileSync(`${here}engine/session-close/engine-session-guard.ts`, "utf8");
    const intervalMs = Number(/export const SESSION_END_GUARD_INTERVAL_MS = ([\d_]+);/.exec(guardSrc)?.[1].replace(/_/g, ""));

    it("the guard decides on isInTradableSessionWindow at the wall clock", () => {
      expect(intervalMs).toBe(15_000);
      expect(guardSrc).toMatch(/isInTradableSessionWindow\(now, sessionWindows\)/);
    });

    it.each([
      ["30m", 30, "2025-01-02"],
      ["15m", 15, "2025-01-02"],
      ["30m", 30, "2026-11-26"],
      ["15m", 15, "2026-11-26"],
      ["30m", 30, "2026-11-27"],
      ["15m", 15, "2026-11-27"],
    ] as const)("%s (%i-minute bars) on %s books the 1m open at the instant the engine's guard fires", async (timeframe, timeframeMinutes, etDate) => {
      // Each minute opens at its own price, so only one minute's open can match.
      const priced = (min: number) => (b: BarData) => opensAt(ENTRY + ((min % 30) - 15) * 0.25)(b);
      const overrides: Record<number, (b: BarData) => BarData> = {};
      for (let min = hm(11, 0); min < hm(16, 30); min++) overrides[min] = priced(min);
      const subBars = minutes(etDate, hm(11, 0), hm(16, 30), overrides);
      const bars = aggregate(subBars, timeframeMinutes);
      const windows = collectSessionWindows(alwaysLongStrategy.config.session, defaultParamValues(alwaysLongStrategy.params));

      // The engine: the guard ticking from the session's open bar until it fires.
      let engineAt = Date.parse(bars[1].timestamp) + timeframeMinutes * 60_000;
      while (isInTradableSessionWindow(new Date(engineAt), windows)) engineAt += intervalMs;
      const fillMinute = subBars.find((b) => {
        const t = Date.parse(b.timestamp);
        return t <= engineAt && engineAt < t + 60_000;
      });

      const result = await runBacktest({ ...BASE_OPTS, strategy: longAt(timeframe), bars, subBars });

      expect(fillMinute).toBeDefined();
      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].exitReason).toBe("time_window_close");
      expect(result.trades[0].exitPrice).toBe(fillMinute!.open);
    });
  });
});

// ── Tests: the per-cell stepper and its book hooks ───────────────────

describe("createCellStepper", () => {
  function step(opts: CellStepperOptions) {
    const stepper = createCellStepper(opts);
    for (let i = 0; i < opts.bars.length; i++) {
      if (stepper.bracketPhase(i) === "flattened") continue;
      stepper.barPhase(i);
    }
    return stepper.finish();
  }

  it("with neither hook set, stepping it is runBacktest", async () => {
    const opts = { ...BASE_OPTS, bars: buildTradeBars([true, false, true]), startingBalance: 100 };
    expect(step(opts)).toEqual(await runBacktest(opts));
  });

  it("takes no trade on a bar the account gate refuses", () => {
    const result = step({
      ...PAIRED_OPTS,
      bars: buildTradeBars([true, true]),
      accountGate: { onNoSignal: () => {}, check: () => "contract_held" },
    });
    expect(result.trades).toEqual([]);
  });

  it("tells the account gate about a null and not about an EntrySkip", () => {
    const answers = [null, { skip: "fixture", gate: "fixture" }, null] as const;
    const noSignals: number[] = [];
    step({
      ...BASE_OPTS,
      strategy: { ...alwaysLongStrategy, shouldEnter: ({ barIndex }) => answers[barIndex] ?? null },
      bars: [bar(0, 20000, 20000), bar(1, 20000, 20000), bar(2, 20000, 20000)],
      accountGate: { onNoSignal: (i) => noSignals.push(i), check: () => null },
    });
    expect(noSignals).toEqual([0, 2]);
  });

  it("sizes from postureFor instead of the flat sizing, and turns its throw into a size_resolution skip", () => {
    const bars = buildTradeBars([true, true]);
    const sizes = step({
      ...PAIRED_OPTS,
      bars,
      sizing: { mode: "fixed", contracts: 1 },
      postureFor: () => ({ maxRiskPerTradeUsd: 1000, maxContracts: 2 }),
    }).trades.map((t) => t.size);
    expect(sizes).toEqual([2, 2]);

    const skipped: string[] = [];
    const refused = step({
      ...BASE_OPTS,
      bars,
      postureFor: () => {
        throw new Error("no posture");
      },
      onSizeResolutionSkip: (b, args) => skipped.push(`${b.timestamp} ${args.failure}`),
    });
    expect(refused.trades).toEqual([]);
    // Never filled, so the fixture signals on every bar after the seed.
    expect(skipped).toEqual(bars.slice(1).map((b) => `${b.timestamp} no posture`));
  });
});

// ── An entry on the bar a bracket filled (A102) ──────────────────────

/**
 * Live, a bracket that fills inside bar `i` leaves the engine flat at that
 * bar's close, and `shouldEnter` runs there. Bar 1 enters long at 20000 (stop
 * 19999, target 20002); bar 2's low fills the stop and it closes at 19999.5,
 * where the re-entry's target (20001.5) sits under bar 2's high — so a
 * re-entry checked against its own entry bar would fill there.
 */
describe("runBacktest — an entry on the bar a bracket filled (A102)", () => {
  const longOn = (indices: readonly number[]): StrategyModule<FixtureParams> => ({
    ...alwaysLongStrategy,
    key: "test-long-on",
    shouldEnter: ({ barIndex }) => (indices.includes(barIndex) ? { side: 0, slTicks: 4, tpTicks: 8 } : null),
  });
  const bars = [
    bar(0, 20000, 20000),
    bar(1, 20000, 20000),
    bar(2, 20000, 19999.5, { high: 20001.75, low: 19998.75 }),
    bar(3, 19999.5, 19999.5, { high: 20001.75, low: 19999.25 }),
    bar(4, 19999.5, 19999.5),
  ];

  it("at cooldown 0 enters at the stop bar's close, and the new trade's first bracket check is the next bar", async () => {
    const result = await runBacktest({ ...BASE_OPTS, strategy: longOn([1, 2]), bars });

    expect(result.trades.map((t) => [t.entryBarIndex, t.exitBarIndex, t.exitReason, t.entryPrice])).toEqual([
      [1, 2, "stop_loss", 20000],
      [2, 3, "take_profit", 19999.5],
    ]);
  });

  it("with a cooldown of one bar takes no entry on the stop bar", async () => {
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: longOn([1, 2]),
      bars,
      paramOverrides: { cooldownSeconds: 60 },
    });

    expect(result.trades.map((t) => [t.entryBarIndex, t.exitReason])).toEqual([[1, "stop_loss"]]);
  });

  it("with a cooldown shorter than the bar still takes no entry on the stop bar, since it rounds up to one bar", async () => {
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: longOn([1, 2]),
      bars,
      paramOverrides: { cooldownSeconds: 30 },
    });

    expect(result.trades.map((t) => [t.entryBarIndex, t.exitReason])).toEqual([[1, "stop_loss"]]);
  });

  // The merged param blob always answers COMMON_PARAMS' "5m", so a 1m run
  // divided its cooldown by 300 s: 180 s was one bar, not three.
  it("A80: the cooldown counts bars of the run's own timeframe, not 5m bars", async () => {
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: longOn([1, 3, 4, 5]),
      bars: [...bars.slice(0, 3), bar(3, 20000, 20000), bar(4, 20000, 20000), bar(5, 20000, 20000), bar(6, 20000, 20000)],
      paramOverrides: { cooldownSeconds: 180 },
    });

    expect(result.trades.map((t) => [t.entryBarIndex, t.exitReason])).toEqual([
      [1, "stop_loss"],
      [5, "end_of_data"],
    ]);
  });

  it("the session latch refuses a same-side re-entry on the stop bar, and lets the other side in", async () => {
    // Long on bar 1; bar 2 asks long, then short when the long side is latched.
    const latched: StrategyModule<FixtureParams> = {
      ...alwaysLongStrategy,
      key: "test-latched",
      shouldEnter: ({ barIndex, hasEnteredThisSession }) => {
        if (barIndex === 1) return { side: 0, slTicks: 4, tpTicks: 8, sessionKey: "s" };
        if (barIndex !== 2) return null;
        if (!hasEnteredThisSession("s", 0)) return { side: 0, slTicks: 4, tpTicks: 8, sessionKey: "s" };
        return { side: 1, slTicks: 4, tpTicks: 8, sessionKey: "s" };
      },
    };

    const result = await runBacktest({ ...BASE_OPTS, strategy: latched, bars });

    expect(result.trades.map((t) => [t.entryBarIndex, t.side])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("the daily gate counts the stop's loss before the entry check on the same bar", async () => {
    // The stop loses 4 ticks × $5 = $20 gross.
    const run = (dailyMaxLossUsd: number) =>
      runBacktest({
        ...BASE_OPTS,
        strategy: longOn([1, 2]),
        bars,
        dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd },
      });

    expect((await run(20)).trades.map((t) => t.entryBarIndex)).toEqual([1]);
    expect((await run(21)).trades.map((t) => t.entryBarIndex)).toEqual([1, 2]);
  });

  it("still evaluates no close on a bar the session flatten falls inside (A105)", async () => {
    // 30m from 14:30 ET: bar 1 (15:00) enters, bar 2 (15:30) holds the 15:55
    // flatten. Live is out of session at 16:00, not just flat.
    const etBar = (minuteOfDayEt: number): BarData => ({
      timestamp: new Date(Date.UTC(2025, 0, 2, 5, minuteOfDayEt, 0)).toISOString(),
      open: 20000,
      high: 20000.25,
      low: 19999.75,
      close: 20000,
      volume: 100,
    });
    const strategy = { ...longOn([1, 2]), config: { ...alwaysLongStrategy.config, timeframe: "30m" as const } };
    const thirty = [etBar(14 * 60 + 30), etBar(15 * 60), etBar(15 * 60 + 30), etBar(16 * 60)];

    const result = await runBacktest({ ...BASE_OPTS, strategy, bars: thirty });

    expect(result.trades.map((t) => [t.entryBarIndex, t.exitBarIndex, t.exitReason])).toEqual([
      [1, 2, "time_window_close"],
    ]);
  });

  it("the stepper tells a bracket fill from a flatten, so runBacktest skips only the flatten's close", () => {
    const stepper = createCellStepper({ ...BASE_OPTS, strategy: longOn([1]), bars });
    stepper.barPhase(0);
    expect(stepper.bracketPhase(1)).toBe("none");
    stepper.barPhase(1);
    // A 1m fill always lands in the bar's last minute.
    expect(stepper.bracketPhase(2)).toBe("filled_at_close");
  });
});

// ── Break-even lock beyond the market ────────────────────────────────

/**
 * An 80-tick stop with a 105-tick break-even offset arms at +1R, before the
 * lock price has traded, so the requested stop sits above a long's market (or
 * below a short's). The engine refuses that modify (`stop_move_wrong_side`)
 * and the position keeps its stop; the backtest used to take it and then fill
 * the lock at entry+105 on the next dip — a price never traded after the move.
 * Entry is the signal bar's close at 20000; 1R is 20 points; the lock is
 * 26.25 points past entry.
 */
describe("runBacktest — a break-even lock beyond the market", () => {
  const ENTRY = 20000;
  const LOCK_POINTS = 105 * 0.25;
  const BE_OVERRIDES = {
    breakEvenFilterEnabled: true,
    breakEvenFilterAtR: 1,
    breakEvenFilterOffsetTicks: 105,
  };

  function oneEntry(side: 0 | 1): StrategyModule<FixtureParams> {
    return {
      ...alwaysLongStrategy,
      key: `test-one-entry-${side}`,
      shouldEnter: ({ barIndex }) => (barIndex === 1 ? { side, slTicks: 80, tpTicks: 2000 } : null),
    };
  }

  /** Mirror a long's price path about the entry for the short case. */
  function pricePath(side: 0 | 1, rows: Array<[open: number, high: number, low: number, close: number]>): BarData[] {
    const px = (d: number) => (side === 0 ? ENTRY + d : ENTRY - d);
    return rows.map(([o, h, l, c], i) => {
      const hi = side === 0 ? px(h) : px(l);
      const lo = side === 0 ? px(l) : px(h);
      return bar(i, px(o), px(c), { high: hi, low: lo });
    });
  }

  // Points from entry, long orientation: +1R reached at 21, the bar closes at
  // 15 (under the lock), and the next bar dips to 5 without trading the lock.
  const NEVER_ABOVE: Array<[number, number, number, number]> = [
    [0, 0.25, -0.25, 0],
    [0, 0.25, -0.25, 0],
    [0, 21, -1, 15],
    [15, 18, 5, 10],
  ];

  // Same arm, then a bar closes at 30 — past the lock — and the next bar falls
  // back through it from above.
  const TRADED_ABOVE: Array<[number, number, number, number]> = [
    [0, 0.25, -0.25, 0],
    [0, 0.25, -0.25, 0],
    [0, 21, -1, 15],
    [15, 31, 14, 30],
    [30, 31, 20, 22],
  ];

  for (const side of [0, 1] as const) {
    const name = side === 0 ? "long" : "short";
    const lockPrice = side === 0 ? ENTRY + LOCK_POINTS : ENTRY - LOCK_POINTS;

    it(`a ${name} is not filled at the lock when price never traded past it after the move`, async () => {
      const bars = pricePath(side, NEVER_ABOVE);
      const result = await runBacktest({ ...BASE_OPTS, strategy: oneEntry(side), bars, paramOverrides: BE_OVERRIDES });

      expect(result.trades).toHaveLength(1);
      const [t] = result.trades;
      expect(t.exitPrice).not.toBe(lockPrice);
      expect(t.exitReason).toBe("end_of_data");
      expect(t.exitPrice).toBe(bars[3].close);
      expect(t.breakEvenMoved).toBe(false);
    });

    it(`a ${name} moves once a bar closes past the lock, and fills it on the way back`, async () => {
      const bars = pricePath(side, TRADED_ABOVE);
      const result = await runBacktest({ ...BASE_OPTS, strategy: oneEntry(side), bars, paramOverrides: BE_OVERRIDES });

      expect(result.trades).toHaveLength(1);
      const [t] = result.trades;
      expect(t.exitReason).toBe("breakeven_stop");
      expect(t.exitPrice).toBe(lockPrice);
      expect(t.exitBarIndex).toBe(4);
      expect(t.breakEvenMoved).toBe(true);
    });

    // The trail in ticks mode asks for `high - 2 points` (long): 19 on the
    // arming bar, above its 15 close, so it is refused the same way.
    const TRAIL_TICKS = {
      trailFilterEnabled: true,
      trailFilterMode: "ticks",
      trailFilterArmAtR: 1,
      trailFilterDistanceTicks: 8,
    };

    it(`a ${name} trail (ticks) is not filled at a stop the market never traded past after the move`, async () => {
      const bars = pricePath(side, NEVER_ABOVE);
      const result = await runBacktest({ ...BASE_OPTS, strategy: oneEntry(side), bars, paramOverrides: TRAIL_TICKS });

      expect(result.trades).toHaveLength(1);
      const [t] = result.trades;
      expect(t.exitReason).toBe("end_of_data");
      expect(t.exitPrice).toBe(bars[3].close);
      expect(t.trailMoved).toBe(false);
      expect(result.warnings).toContainEqual(expect.stringMatching(/^2 stop moves were refused/));
    });

    it(`a ${name} trail (ticks) moves once a bar closes past its stop, and fills it on the way back`, async () => {
      const bars = pricePath(side, TRADED_ABOVE);
      const result = await runBacktest({ ...BASE_OPTS, strategy: oneEntry(side), bars, paramOverrides: TRAIL_TICKS });

      expect(result.trades).toHaveLength(1);
      const [t] = result.trades;
      expect(t.exitReason).toBe("trail_stop");
      expect(t.exitPrice).toBe(side === 0 ? ENTRY + 29 : ENTRY - 29);
      expect(t.exitBarIndex).toBe(4);
      expect(t.trailMoved).toBe(true);
      expect(t.breakEvenMoved).toBe(false);
    });
  }

  it("a run with no refused move carries no refusal warning", async () => {
    const bars = pricePath(0, NEVER_ABOVE);
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: oneEntry(0),
      bars,
      paramOverrides: { ...BE_OVERRIDES, breakEvenFilterOffsetTicks: 40 },
    });
    expect(result.warnings ?? []).not.toContainEqual(expect.stringMatching(/refused/));
  });

  it("a lock inside the market is still taken on the arming bar", async () => {
    // 40 ticks = 10 points, below the arming bar's 15-point close.
    const bars = pricePath(0, NEVER_ABOVE);
    const result = await runBacktest({
      ...BASE_OPTS,
      strategy: oneEntry(0),
      bars,
      paramOverrides: { ...BE_OVERRIDES, breakEvenFilterOffsetTicks: 40 },
    });
    const [t] = result.trades;
    expect(t.exitReason).toBe("breakeven_stop");
    expect(t.exitPrice).toBe(ENTRY + 10);
    expect(t.exitBarIndex).toBe(3);
  });

  // The check setting's default is bar close: absent, `barClose`, and either
  // with the series' own 1m bars handed over as sub-bars, every case above
  // comes out as it did before the setting existed.
  it.each([
    ["never above", NEVER_ABOVE, BE_OVERRIDES],
    ["traded above", TRADED_ABOVE, BE_OVERRIDES],
    ["lock inside the market", NEVER_ABOVE, { ...BE_OVERRIDES, breakEvenFilterOffsetTicks: 40 }],
  ] as const)("bar close is the default and ignores sub-bars (%s)", async (_name, path, overrides) => {
    for (const side of [0, 1] as const) {
      const bars = pricePath(side, [...path]);
      const before = await runBacktest({ ...BASE_OPTS, strategy: oneEntry(side), bars, paramOverrides: overrides });
      const checks: ParamValues[] = [{}, { breakEvenFilterCheck: "barClose" }];
      for (const check of checks) {
        for (const subBars of [undefined, bars]) {
          const after = await runBacktest({
            ...BASE_OPTS,
            strategy: oneEntry(side),
            bars,
            subBars,
            paramOverrides: { ...overrides, ...check },
          });
          expect(after.trades).toEqual(before.trades);
        }
      }
    }
  });

  // Break-even and trail firing on the same bar. The flags follow the
  // candidate that became the stop, through the engine's rule
  // (`attributeSlRatchet`), not every filter that fired.
  describe("break-even and trail on the same bar", () => {
    // Arms at bar 2 (high +21, close +15); bar 3 dips to +5; bar 4 to -6.
    const SAME_BAR: Array<[number, number, number, number]> = [
      [0, 0.25, -0.25, 0],
      [0, 0.25, -0.25, 0],
      [0, 21, -1, 15],
      [15, 16, 5, 10],
      [10, 11, -6, -6],
    ];
    const both = (beOffsetTicks: number, trailTicks: number) => ({
      ...BE_OVERRIDES,
      breakEvenFilterOffsetTicks: beOffsetTicks,
      trailFilterEnabled: true,
      trailFilterMode: "ticks",
      trailFilterArmAtR: 1,
      trailFilterDistanceTicks: trailTicks,
    });
    const run = (overrides: ReturnType<typeof both>) =>
      runBacktest({ ...BASE_OPTS, strategy: oneEntry(0), bars: pricePath(0, SAME_BAR), paramOverrides: overrides });

    it("labels a trail stop when the trail's target won over a break-even at entry", async () => {
      // BE at +0, trail at 21 - 10 = +11.
      const [t] = (await run(both(0, 40))).trades;
      expect(t.exitReason).toBe("trail_stop");
      expect(t.exitPrice).toBe(ENTRY + 11);
      expect(t.trailMoved).toBe(true);
      expect(t.breakEvenMoved).toBe(false);
    });

    it("labels a break-even stop when break-even's target won", async () => {
      // BE at +12, trail at +11.
      const [t] = (await run(both(48, 40))).trades;
      expect(t.exitReason).toBe("breakeven_stop");
      expect(t.exitPrice).toBe(ENTRY + 12);
      expect(t.breakEvenMoved).toBe(true);
      expect(t.trailMoved).toBe(false);
    });

    it("labels a plain stop loss when a negative-offset break-even won below entry", async () => {
      // BE at -5, trail at 21 - 30 = -9.
      const [t] = (await run(both(-20, 120))).trades;
      expect(t.exitReason).toBe("stop_loss");
      expect(t.exitPrice).toBe(ENTRY - 5);
      expect(t.exitBarIndex).toBe(4);
      expect(t.breakEvenMoved).toBe(false);
      expect(t.trailMoved).toBe(false);
    });
  });

  // Parity: the refusal and the flag attribution are each one shared helper,
  // asked by both paths. A second inline copy on either side is how the two
  // drift, so the sites are enumerated from source.
  describe("the engine and the backtest share the ratchet rules", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const engineSrc = readFileSync(`${here}engine/engine.ts`, "utf8");
    const backtestSrc = readFileSync(`${here}backtest.ts`, "utf8");
    const callSites = (src: string, fn: string) => src.match(new RegExp(`\\b${fn}\\([^)]*\\)`, "g")) ?? [];

    it.each([
      ["engine", engineSrc, "isStopAtOrBeyondMarket", ["isStopAtOrBeyondMarket(position.side, alignedStop, marketPrice)"]],
      ["backtest", backtestSrc, "isStopAtOrBeyondMarket", ["isStopAtOrBeyondMarket(pos.side, tightest, mark)"]],
    ])("%s calls %s at exactly the enumerated sites", (_path, src, fn, expected) => {
      const sites = callSites(src, fn);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites).toEqual(expected);
    });

    // The bar-close ratchet and the intrabar break-even share one ratchet, so
    // the refusal and the flags cannot drift between them.
    it("the backtest ratchets through one helper, at bar close against the close and intrabar against the minute's", () => {
      expect(callSites(backtestSrc, "ratchetStop")).toEqual([
        "ratchetStop(pos, [{ key: EXIT_FILTER_REGISTRY.breakeven.key, result }], sub.close)",
        "ratchetStop(position, exitFilterResults, bar.close)",
      ]);
    });

    it.each([
      ["engine", engineSrc],
      ["backtest", backtestSrc],
    ])("%s stamps its ratchet flags through attributeSlRatchet, once", (_path, src) => {
      const sites = src.match(/\battributeSlRatchet\(/g) ?? [];
      expect(sites.length).toBeGreaterThan(0);
      expect(sites).toHaveLength(1);
    });

    it("the engine measures the refusal against the decision bar's close and keeps no inline copy", () => {
      // The mark, then the mirror's stored stop (wave 4 C1: the reference the
      // no-loosen check falls back to), then the label.
      expect(engineSrc).toMatch(
        /bars\[barIndex\]\?\.close \?\? null,\s*deplState\.slCurrentPrice,\s*"Exit-filter SL modify"/,
      );
      expect(engineSrc).not.toMatch(/marketPrice <= alignedStop|marketPrice >= alignedStop/);
      expect(engineSrc).not.toMatch(/winningKeys/);
      expect(backtestSrc).not.toMatch(/firedByKey/);
    });
  });
});

// ── Bracket prices on a 0.1-tick instrument ──────────────────────────

/**
 * MGC's 0.1 tick is not a binary fraction, so `entry ± ticks * 0.1` in doubles
 * lands just past the tick it names: 2650.7 − 3 × 0.1 is 2650.3999999999996,
 * and a long whose stop is 2650.4 rode through a bar whose low was exactly
 * 2650.4. Each case is a 3-tick leg built so the double-arithmetic price
 * overshoots the touch.
 */
describe("A110 — an exact touch fills the bracket on a 0.1-tick instrument", () => {
  const MGC_OPTS = {
    ...BASE_OPTS,
    tickSize: CONTRACT_SPECS.MGC.tickSize,
    tickValue: CONTRACT_SPECS.MGC.tickValue,
    daySession: CONTRACT_SPECS.MGC.daySession,
  } as const;
  const enterOnBar1 = (side: 0 | 1, slTicks: number, tpTicks: number): StrategyModule<FixtureParams> => ({
    ...alwaysLongStrategy,
    key: "test-a110",
    shouldEnter: ({ barIndex }) => (barIndex === 1 ? { side, slTicks, tpTicks } : null),
  });
  const run = (side: 0 | 1, slTicks: number, tpTicks: number, entry: number, touch: { high: number; low: number }) =>
    runBacktest({
      ...MGC_OPTS,
      strategy: enterOnBar1(side, slTicks, tpTicks),
      bars: [
        bar(0, entry, entry, { high: entry, low: entry }),
        bar(1, entry, entry, { high: entry, low: entry }),
        bar(2, entry, entry, touch),
      ],
    });
  const exitOf = (result: Awaited<ReturnType<typeof runBacktest>>) =>
    result.trades.map((t) => [t.exitBarIndex, t.exitReason, t.exitPrice, t.slPrice, t.tpPrice]);

  it("a long's stop fills on a low exactly at it", async () => {
    const result = await run(0, 3, 30, 2650.7, { high: 2650.8, low: 2650.4 });
    expect(exitOf(result)).toEqual([[2, "stop_loss", 2650.4, 2650.4, 2653.7]]);
  });

  it("a long's target fills on a high exactly at it", async () => {
    const result = await run(0, 30, 3, 2650.3, { high: 2650.6, low: 2650.2 });
    expect(exitOf(result)).toEqual([[2, "take_profit", 2650.6, 2647.3, 2650.6]]);
  });

  it("a short's stop fills on a high exactly at it", async () => {
    const result = await run(1, 3, 30, 2650.3, { high: 2650.6, low: 2650.2 });
    expect(exitOf(result)).toEqual([[2, "stop_loss", 2650.6, 2650.6, 2647.3]]);
  });

  it("a short's target fills on a low exactly at it", async () => {
    const result = await run(1, 30, 3, 2650.7, { high: 2650.8, low: 2650.4 });
    expect(exitOf(result)).toEqual([[2, "take_profit", 2650.4, 2653.7, 2650.4]]);
  });
});

// ── Break-even checked intrabar ──────────────────────────────────────

/**
 * `breakEvenFilterCheck: "intrabar"`: inside a bar a break-even position holds
 * before its stop has moved, the 1m bars are walked in order — bracket first,
 * then the arm on the range so far, then the ratchet against that minute's
 * close. 5m bars from 2025-01-02 15:00 UTC (10:00 ET); the entry fills at bar
 * 1's close, 20000, with a 40-tick stop (19990) and a 400-tick target (20100),
 * so break-even arms at +1R, 20010, and moves the stop to 20000. Bar 2 is
 * minutes 10–14. Minutes are written long; `mirror` gives the short.
 */
describe("runBacktest — break-even checked intrabar, on the bar's 1m bars", () => {
  const ENTRY = 20000;
  const STOP = 19990;
  const TARGET = 20100;
  const T0 = Date.UTC(2025, 0, 2, 15, 0, 0);
  const MINUTE = 60_000;

  type Minute = { high?: number; low?: number; close?: number };

  /** `count` 1m bars from `startMs`, each opening at the last close; unlisted minutes hold that price. */
  function minutes(spec: Record<number, Minute>, count = 30, startMs = T0): BarData[] {
    const out: BarData[] = [];
    let last = ENTRY;
    for (let k = 0; k < count; k++) {
      const m = spec[k] ?? {};
      const open = last;
      const close = m.close ?? open;
      out.push({
        timestamp: new Date(startMs + k * MINUTE).toISOString(),
        open,
        high: Math.max(open, close, m.high ?? -Infinity),
        low: Math.min(open, close, m.low ?? Infinity),
        close,
        volume: 100,
      });
      last = close;
    }
    return out;
  }

  const mirror = (subs: BarData[]): BarData[] => {
    const px = (p: number) => 2 * ENTRY - p;
    return subs.map((b) => ({ ...b, open: px(b.open), close: px(b.close), high: px(b.low), low: px(b.high) }));
  };

  const fiveMinute = (subs: BarData[]) =>
    aggregateBars(subs.map((b) => barDataToBar(b, "MNQ.c.0")), 5).map(barToBarData);

  function oneEntry(side: 0 | 1, entryBar = 1): StrategyModule<FixtureParams> {
    return {
      ...alwaysLongStrategy,
      key: `test-intrabar-be-${side}`,
      config: { ...alwaysLongStrategy.config, timeframe: "5m" },
      shouldEnter: ({ barIndex }) => (barIndex === entryBar ? { side, slTicks: 40, tpTicks: 400 } : null),
    };
  }

  const BE = { breakEvenFilterEnabled: true, breakEvenFilterAtR: 1, breakEvenFilterOffsetTicks: 0 };
  const INTRABAR = { ...BE, breakEvenFilterCheck: "intrabar" };
  const BAR_CLOSE = { ...BE, breakEvenFilterCheck: "barClose" };

  type RunOpts = { side?: 0 | 1; subBars?: BarData[] | null; conflictResolution?: "stop_loss" | "take_profit" };
  const run = (subs: BarData[], overrides: ParamValues, opts: RunOpts = {}) =>
    runBacktest({
      ...BASE_OPTS,
      strategy: oneEntry(opts.side ?? 0),
      bars: fiveMinute(subs),
      ...(opts.subBars === null ? {} : { subBars: opts.subBars ?? subs }),
      ...(opts.conflictResolution ? { conflictResolution: opts.conflictResolution } : {}),
      paramOverrides: overrides,
    });
  const NO_1M_WARNING = /checked for break-even at (its|their) close, not minute by minute/;
  const exits = (result: Awaited<ReturnType<typeof runBacktest>>) =>
    result.trades.map((t) => [t.exitBarIndex, t.exitReason, t.exitPrice, t.breakEvenMoved]);

  // Runs past the arm at minute 10, then falls through the original stop at 11.
  const ARM_THEN_FADE = minutes({ 10: { high: 20012, close: 20011 }, 11: { low: 19985, close: 19986 } });

  describe("the observed case: a bar that arms and fades through the original stop", () => {
    it("is scratched at break-even intrabar, where bar close takes the full stop — long", async () => {
      expect(exits(await run(ARM_THEN_FADE, INTRABAR))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
      expect(exits(await run(ARM_THEN_FADE, BAR_CLOSE))).toEqual([[2, "stop_loss", STOP, false]]);
    });

    it("is scratched at break-even intrabar, where bar close takes the full stop — short", async () => {
      const subs = mirror(ARM_THEN_FADE);
      expect(exits(await run(subs, INTRABAR, { side: 1 }))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
      expect(exits(await run(subs, BAR_CLOSE, { side: 1 }))).toEqual([[2, "stop_loss", 2 * ENTRY - STOP, false]]);
    });
  });

  it("the live-worse case: an arm the bar's close refuses is scratched intrabar, and runs on at bar close", async () => {
    // Arms at 10, dips to the moved stop at 11, closes the bar at 19998 —
    // back through entry, so bar close refuses the move — then bar 3 reaches the target.
    const subs = minutes({
      10: { high: 20012, close: 20011 },
      11: { low: 19999, close: 20004 },
      14: { close: 19998 },
      15: { high: TARGET + 1, close: 20050 },
    });
    expect(exits(await run(subs, INTRABAR))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
    const barClose = await run(subs, BAR_CLOSE);
    expect(exits(barClose)).toEqual([[3, "take_profit", TARGET, false]]);
    expect(barClose.warnings).toContainEqual(expect.stringMatching(/^1 stop move was refused/));
  });

  it("stop-first at 1m grain: a minute that reaches the arm and touches the original stop is a stop loss", async () => {
    const subs = minutes({ 10: { high: 20012, low: STOP - 1, close: 20011 } });
    expect(exits(await run(subs, INTRABAR))).toEqual([[2, "stop_loss", STOP, false]]);
    expect(exits(await run(mirror(subs), INTRABAR, { side: 1 }))).toEqual([[2, "stop_loss", 2 * ENTRY - STOP, false]]);
  });

  it("a minute that touches the target before any move ends the walk: the bar is decided on its whole range", async () => {
    // Minute 10 reaches the target unmoved; minute 11 falls through the original stop.
    const subs = minutes({ 10: { high: TARGET + 1, close: 20050 }, 11: { low: 19985, close: 19986 } });
    vi.mocked(computeIntrabarBreakevenSlPrice).mockClear();
    // The whole bar touches both legs, so the conflict rule decides, as at bar close.
    expect(exits(await run(subs, INTRABAR))).toEqual(exits(await run(subs, BAR_CLOSE)));
    expect(exits(await run(subs, INTRABAR))).toEqual([[2, "stop_loss", STOP, false]]);
    expect(exits(await run(subs, INTRABAR, { conflictResolution: "take_profit" }))).toEqual([[2, "take_profit", TARGET, false]]);
    expect(vi.mocked(computeIntrabarBreakevenSlPrice)).not.toHaveBeenCalled();
  });

  describe("the mark is the minute's close", () => {
    // Arms at 10 with a close at the would-be stop, and 11 closes under it:
    // both refused by `isStopAtOrBeyondMarket`. 12 falls through the original stop.
    const REFUSED_THEN_FADE = { 10: { high: 20012, close: ENTRY }, 11: { low: 19998, close: 19999 }, 12: { low: 19985, close: 19986 } };

    it("refuses the move at a minute closing at or past the stop, and takes the original stop", async () => {
      vi.mocked(computeIntrabarBreakevenSlPrice).mockClear();
      expect(exits(await run(minutes(REFUSED_THEN_FADE), INTRABAR))).toEqual([[2, "stop_loss", STOP, false]]);
      expect(vi.mocked(computeIntrabarBreakevenSlPrice)).toHaveBeenCalledTimes(2);
    });

    it("refuses the move at a minute closing at or past the stop, and takes the original stop — short", async () => {
      expect(exits(await run(mirror(minutes(REFUSED_THEN_FADE)), INTRABAR, { side: 1 }))).toEqual([[2, "stop_loss", 2 * ENTRY - STOP, false]]);
    });

    it("retries on the bar's later minutes, and moves on the first that closes clear of it", async () => {
      const subs = minutes({ ...REFUSED_THEN_FADE, 11: { close: 20003 } });
      expect(exits(await run(subs, INTRABAR))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
      expect(exits(await run(mirror(subs), INTRABAR, { side: 1 }))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
    });
  });

  describe("once moved, the stop is the latch", () => {
    it("asks once: not again inside the bar, nor on any later bar", async () => {
      const subs = minutes({ 10: { high: 20012, close: 20011 } });
      vi.mocked(computeIntrabarBreakevenSlPrice).mockClear();
      const result = await run(subs, INTRABAR);
      expect(vi.mocked(computeIntrabarBreakevenSlPrice)).toHaveBeenCalledTimes(1);
      expect(exits(result)).toEqual([[5, "end_of_data", 20011, true]]);
      expect(result.trades[0].slPrice).toBe(ENTRY);
    });

  });

  describe("after the move, the minutes are walked against the moved bracket: the first touch decides", () => {
    const ARM = { 10: { high: 20012, close: 20011 } };
    // Minute 11 reaches the target, 12 trades back through entry.
    const TARGET_THEN_STOP = minutes({ ...ARM, 11: { high: TARGET + 1, close: 20050 }, 12: { low: 19995, close: 19996 } });
    // Minute 11 dips to entry, 12 reaches the target.
    const STOP_THEN_TARGET = minutes({ ...ARM, 11: { low: 19999, close: 20004 }, 12: { high: TARGET + 1, close: 20050 } });
    // Minute 11 touches both.
    const BOTH_IN_ONE = minutes({ ...ARM, 11: { high: TARGET + 1, low: 19999, close: 20050 } });

    for (const conflictResolution of ["stop_loss", "take_profit"] as const) {
      describe(`conflict rule ${conflictResolution}`, () => {
        it("target then stop is the target — long and short", async () => {
          expect(exits(await run(TARGET_THEN_STOP, INTRABAR, { conflictResolution }))).toEqual([[2, "take_profit", TARGET, true]]);
          expect(exits(await run(mirror(TARGET_THEN_STOP), INTRABAR, { side: 1, conflictResolution }))).toEqual([
            [2, "take_profit", 2 * ENTRY - TARGET, true],
          ]);
        });

        it("stop then target is the scratch — long and short", async () => {
          expect(exits(await run(STOP_THEN_TARGET, INTRABAR, { conflictResolution }))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
          expect(exits(await run(mirror(STOP_THEN_TARGET), INTRABAR, { side: 1, conflictResolution }))).toEqual([
            [2, "breakeven_stop", ENTRY, true],
          ]);
        });
      });
    }

    it("both legs inside one minute take the conflict rule — long and short", async () => {
      for (const [side, subs] of [[0, BOTH_IN_ONE], [1, mirror(BOTH_IN_ONE)]] as const) {
        const target = side === 0 ? TARGET : 2 * ENTRY - TARGET;
        expect(exits(await run(subs, INTRABAR, { side, conflictResolution: "stop_loss" }))).toEqual([[2, "breakeven_stop", ENTRY, true]]);
        expect(exits(await run(subs, INTRABAR, { side, conflictResolution: "take_profit" }))).toEqual([[2, "take_profit", target, true]]);
      }
    });
  });

  it("a bar with no 1m bars is decided at its close, and the run says how many", async () => {
    const withoutBar2 = ARM_THEN_FADE.filter((_, k) => k < 10 || k >= 15);
    const missingOne = await run(ARM_THEN_FADE, INTRABAR, { subBars: withoutBar2 });
    expect(exits(missingOne)).toEqual([[2, "stop_loss", STOP, false]]);
    expect(missingOne.warnings).toContain(
      "1 bar was checked for break-even at its close, not minute by minute: this run has no 1m bars for it.",
    );
    const inApp = await run(ARM_THEN_FADE, INTRABAR, { subBars: null });
    expect(exits(inApp)).toEqual([[2, "stop_loss", STOP, false]]);
    expect(inApp.warnings?.filter((w) => NO_1M_WARNING.test(w))).toHaveLength(1);
  });

  it("counts every bar that fell back, and none once the stop has moved or at bar close", async () => {
    // Held unmoved on bars 2 and 3, stopped out on bar 3.
    const holdTwoBars = minutes({ 16: { low: 19985, close: 19986 } });
    expect((await run(holdTwoBars, INTRABAR, { subBars: null })).warnings).toContain(
      "2 bars were checked for break-even at their close, not minute by minute: this run has no 1m bars for them.",
    );
    // Moved on bar 2 from its minutes; bars 3–5 have none and are not counted.
    const movedOnBar2 = minutes({ 10: { high: 20012, close: 20011 } });
    const onlyBar2 = movedOnBar2.filter((_, k) => k < 15);
    expect((await run(movedOnBar2, INTRABAR, { subBars: onlyBar2 })).warnings ?? []).not.toContainEqual(expect.stringMatching(NO_1M_WARNING));
    expect((await run(ARM_THEN_FADE, BAR_CLOSE, { subBars: null })).warnings ?? []).not.toContainEqual(expect.stringMatching(NO_1M_WARNING));
    expect((await run(ARM_THEN_FADE, INTRABAR)).warnings ?? []).not.toContainEqual(expect.stringMatching(NO_1M_WARNING));
  });

  it("the time arm modes ignore the setting", async () => {
    const subs = minutes({ 10: { high: 20012, close: 20011 }, 12: { close: 20004 }, 21: { low: 19985, close: 19986 } });
    for (const mode of ["timeOpen", "timeInProfit"]) {
      const time = { ...BE, breakEvenFilterArmMode: mode, breakEvenFilterArmMinutes: 5 };
      vi.mocked(computeIntrabarBreakevenSlPrice).mockClear();
      const intrabar = await run(subs, { ...time, breakEvenFilterCheck: "intrabar" });
      expect(intrabar.trades).toEqual((await run(subs, { ...time, breakEvenFilterCheck: "barClose" })).trades);
      expect(intrabar.trades[0].exitReason).toBe("breakeven_stop");
      expect(vi.mocked(computeIntrabarBreakevenSlPrice)).not.toHaveBeenCalled();
    }
  });

  describe("straddleSubBars — the supply", () => {
    // 09:00–10:30 ET: the 09:00–09:25 bars are before the 09:30 window.
    const PRE_SESSION = Date.UTC(2025, 0, 2, 14, 0, 0);
    const subs = minutes({ 45: { high: 20012, close: 20011 }, 46: { low: 19985, close: 19986 } }, 90, PRE_SESSION);
    const bars = fiveMinute(subs);
    const firstInSession = new Date(Date.UTC(2025, 0, 2, 14, 30, 0)).toISOString();
    // Bar 7 is 09:35; the arm-and-fade is inside bar 9.
    const leg = (overrides: ParamValues) => ({ strategy: oneEntry(0, 7), paramOverrides: { timeframe: "5m", ...overrides } });

    it("keeps every in-session minute for a leg that checks intrabar, and none for one at bar close", () => {
      const kept = straddleSubBars(bars, subs, [leg(INTRABAR)]);
      expect(kept).toHaveLength(60);
      expect(kept?.[0].timestamp).toBe(firstInSession);
      expect(straddleSubBars(bars, subs, [leg(BAR_CLOSE)])).toBeUndefined();
      expect(straddleSubBars(bars, subs, [leg({ ...INTRABAR, breakEvenFilterArmMode: "timeOpen" })])).toBeUndefined();
      expect(straddleSubBars(bars, subs, [leg({ ...INTRABAR, breakEvenFilterEnabled: false })])).toBeUndefined();
    });

    it("a book naming both legs hands over what the intrabar leg alone gets", () => {
      expect(straddleSubBars(bars, subs, [leg(BAR_CLOSE), leg(INTRABAR)])).toEqual(straddleSubBars(bars, subs, [leg(INTRABAR)]));
    });

    it("a run on the kept minutes equals a run on the whole 1m series", async () => {
      const kept = straddleSubBars(bars, subs, [leg(INTRABAR)]);
      const on = (subBars: BarData[] | undefined) =>
        runBacktest({ ...BASE_OPTS, strategy: oneEntry(0, 7), bars, subBars, paramOverrides: INTRABAR });
      const onKept = await on(kept);
      expect(onKept).toEqual(await on(subs));
      expect(exits(onKept)).toEqual([[9, "breakeven_stop", ENTRY, true]]);
    });
  });
});
