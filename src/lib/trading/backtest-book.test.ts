/**
 * The book runner's cross-leg rules, on scripted fixture playbooks whose
 * `shouldEnter` / `shouldExit` answer by bar index, so every contest, hold and
 * release is placed on a known bar.
 *
 * Bars are 5m from 2025-01-02 15:00 UTC (10:00 ET), inside the fixtures'
 * 09:30–15:55 ET window, flat at 20000 with a ±0.25 range: a 4-tick stop
 * (19999) and an 8-tick target (20002) fill only on a bar a test widens.
 */
import { describe, it, expect } from "vitest";
import {
  runBookBacktest,
  runBookBacktestPermuted,
  bookBarKey,
  type BookAccountInput,
  type BookCellInput,
  type RunBookBacktestOptions,
} from "./backtest-book";
import { runBacktest } from "./backtest";
import { NO_DAILY_PNL_LIMITS } from "./daily-pnl-gate";
import { LEGACY_DAY_SESSION, withCommonParams, type StrategyModule } from "./strategy-types";
import { CONTRACT_SPECS } from "./contracts/contract-specs";
import type { BarData } from "@/lib/brokers/types";
import type { Timeframe } from "./domain";

const BAR_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2025, 0, 2, 15, 0, 0);
const PRICE = 20000;
const TP_HIT = { high: 20002.25 };
const SL_HIT = { low: 19998.75 };

type Wick = { high?: number; low?: number };

function series(n: number, wicks: Record<number, Wick> = {}, startMs = T0, barMs = BAR_MS): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(startMs + i * barMs).toISOString(),
    open: PRICE,
    close: PRICE,
    high: wicks[i]?.high ?? PRICE + 0.25,
    low: wicks[i]?.low ?? PRICE - 0.25,
    volume: 100,
  }));
}

type Step = "long" | "skip";

function scripted(
  key: string,
  entries: Record<number, Step>,
  opts: { exits?: number[]; slTicks?: number; timeframe?: Timeframe } = {},
): StrategyModule {
  const slTicks = opts.slTicks ?? 4;
  return {
    version: "1.0.0",
    key,
    params: withCommonParams({}),
    config: {
      name: key,
      description: "Scripted test fixture.",
      timeframe: opts.timeframe ?? "5m",
      session: LEGACY_DAY_SESSION,
      entryType: 2,
      indicators: [],
    },
    buildIndicators: () => [],
    shouldEnter({ barIndex }) {
      const step = entries[barIndex];
      if (step === "long") return { side: 0, slTicks, tpTicks: slTicks * 2 };
      if (step === "skip") return { skip: "fixture skip", gate: "fixture" };
      return null;
    },
    shouldExit({ barIndex }) {
      return opts.exits?.includes(barIndex) ?? false;
    },
  };
}

function cell(deploymentId: string, strategyKey: string, createdAt: string, ticker = "/MNQ"): BookCellInput {
  return { deploymentId, strategyKey, ticker, createdAt, paramValues: {} };
}

const ACCOUNT: BookAccountInput = {
  accountId: 1,
  dailyPnl: NO_DAILY_PNL_LIMITS,
  posture: {
    broker: "topstep",
    riskPhase: "off",
    mllUsd: null,
    startBalanceUsd: null,
    pressAtUsd: null,
    maxRiskPerTradeUsd: 1000,
    maxContracts: 1,
  },
  phaseSeed: null,
};

function options(args: {
  cells: BookCellInput[];
  strategies: StrategyModule[];
  bars: Record<string, BarData[]>;
  account?: BookAccountInput;
  reportFrom?: Date;
}): RunBookBacktestOptions {
  const byKey = new Map(args.strategies.map((s) => [s.key ?? "", s]));
  return {
    cells: args.cells,
    resolveStrategy: (key) => byKey.get(key),
    bars: new Map(Object.entries(args.bars)),
    account: args.account ?? ACCOUNT,
    reportFrom: args.reportFrom,
  };
}

const MNQ = bookBarKey("/MNQ", "5m");
const MES = bookBarKey("/MES", "5m");
const MES_1M = bookBarKey("/MES", "1m");
const MIN_MS = 60_000;

/** The 1m bar closing with 5m bar `i`, on the same T0 grid. */
function oneMinuteIndexClosingWith(i: number): number {
  return (i + 1) * (BAR_MS / MIN_MS) - 1;
}

function barTs(i: number): string {
  return new Date(T0 + i * BAR_MS).toISOString();
}

describe("runBookBacktest — contract lock", () => {
  it("refuses a second cell on the same contract while the first holds it, naming the holder", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z"), cell("b", "fx-b", "2026-01-02T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 2: "long" }), scripted("fx-b", { 4: "long" })],
        bars: { [MNQ]: series(8) },
      }),
    );
    expect(result.trades.map((t) => t.deploymentId)).toEqual(["a"]);
    expect(result.blocked).toEqual([
      expect.objectContaining({
        deploymentId: "b",
        gate: "contract_held",
        holderDeploymentId: "a",
        signalBarTs: barTs(4),
        contested: false,
        releaseSensitive: false,
      }),
    ]);
    expect(result.blockedCounts.b).toEqual({ contract_held: 1, stale_latch: 0, daily_pnl: 0 });
    // The engine persists none of these, so none is a skip.
    expect(result.skips).toEqual([]);
  });

  it("does not block a cell on a different contract", async () => {
    const result = await runBookBacktest(
      options({
        cells: [
          cell("a", "fx-a", "2026-01-01T00:00:00.000Z", "/MNQ"),
          cell("c", "fx-c", "2026-01-02T00:00:00.000Z", "/MES"),
        ],
        strategies: [scripted("fx-a", { 2: "long" }), scripted("fx-c", { 4: "long" })],
        bars: { [MNQ]: series(8), [MES]: series(8) },
      }),
    );
    expect(result.trades.map((t) => [t.deploymentId, t.ticker])).toEqual([
      ["a", "/MNQ"],
      ["c", "/MES"],
    ]);
    expect(result.blocked).toEqual([]);
  });
});

describe("runBookBacktest — a cell created mid-run", () => {
  it("takes no entry on a bar closing before entriesFrom, and holds nothing another cell could be blocked by", async () => {
    const result = await runBookBacktest(
      options({
        cells: [
          // Bar 2 closes at T0 + 15m; the cell exists from T0 + 20m.
          { ...cell("late", "fx-late", "2026-01-01T00:00:00.000Z"), entriesFrom: new Date(T0 + 4 * BAR_MS).toISOString() },
          cell("b", "fx-b", "2026-01-02T00:00:00.000Z"),
        ],
        strategies: [scripted("fx-late", { 2: "long", 5: "long" }), scripted("fx-b", { 3: "long" })],
        bars: { [MNQ]: series(10) },
      }),
    );
    // Bar 3 closes at T0 + 20m, so `b` enters with the slot free; `late` is
    // then refused by `b`'s hold, not by its own creation time.
    expect(result.trades.map((t) => [t.deploymentId, t.signalBarTs])).toEqual([["b", barTs(3)]]);
    expect(result.blocked.map((b) => [b.deploymentId, b.gate, b.signalBarTs])).toEqual([
      ["late", "contract_held", barTs(5)],
    ]);
    expect(result.skips).toEqual([]);
  });

  it("enters as before with no entriesFrom", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("late", "fx-late", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-late", { 2: "long" })],
        bars: { [MNQ]: series(8) },
      }),
    );
    expect(result.trades.map((t) => t.signalBarTs)).toEqual([barTs(2)]);
  });
});

describe("runBookBacktest — stale-signal latch", () => {
  it("is set on a lock refusal and cleared only by a null, not by the slot freeing or a skip", async () => {
    // a holds bars 1–4 (target fills inside 4, freeing the slot in pass A). b
    // signals into the hold on 3, keeps signalling on 4 and 5 with the slot
    // free, skips on 6, signals on 7, goes null on 8 and only then enters on 9.
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z"), cell("b", "fx-b", "2026-01-02T00:00:00.000Z")],
        strategies: [
          scripted("fx-a", { 1: "long" }),
          scripted("fx-b", { 3: "long", 4: "long", 5: "long", 6: "skip", 7: "long", 9: "long" }),
        ],
        bars: { [MNQ]: series(12, { 4: TP_HIT }) },
      }),
    );
    expect(result.blocked.map((r) => [r.gate, r.signalBarTs, r.holderDeploymentId])).toEqual([
      ["contract_held", barTs(3), "a"],
      ["stale_latch", barTs(4), "a"],
      ["stale_latch", barTs(5), "a"],
      ["stale_latch", barTs(7), "a"],
    ]);
    expect(result.skips.map((s) => [s.deploymentId, s.gate, s.signalBarTs])).toEqual([["b", "fixture", barTs(6)]]);
    expect(result.trades.filter((t) => t.deploymentId === "b").map((t) => t.signalBarTs)).toEqual([barTs(9)]);
  });

  it("latches on a lock refusal even when the daily gate would also have refused that bar", async () => {
    // d's MES stop trips the $2 gate on bar 2; a holds MNQ from bar 1 to its
    // stop inside bar 4. b's signal on 3 meets the lock first, so it is
    // latched, and its signal on 4 — slot free, gate tripped — is the latch.
    const result = await runBookBacktest(
      options({
        cells: [
          cell("a", "fx-a", "2026-01-01T00:00:00.000Z", "/MNQ"),
          cell("d", "fx-d", "2026-01-02T00:00:00.000Z", "/MES"),
          cell("b", "fx-b", "2026-01-03T00:00:00.000Z", "/MNQ"),
        ],
        strategies: [
          scripted("fx-a", { 1: "long" }),
          scripted("fx-d", { 1: "long" }),
          scripted("fx-b", { 3: "long", 4: "long" }),
        ],
        bars: { [MNQ]: series(8, { 4: SL_HIT }), [MES]: series(8, { 2: SL_HIT }) },
        account: { ...ACCOUNT, dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd: 2 } },
      }),
    );
    expect(
      result.blocked.filter((r) => r.deploymentId === "b").map((r) => [r.gate, r.signalBarTs, r.holderDeploymentId]),
    ).toEqual([
      ["contract_held", barTs(3), "a"],
      ["stale_latch", barTs(4), "a"],
    ]);
  });
});

describe("runBookBacktest — daily P&L gate", () => {
  it("counts every cell's closed trades, so one leg's loss blocks another leg on another contract", async () => {
    // a loses 4 ticks × $0.50 = $2 gross on bar 2; the account's limit is $2.
    const run = (dailyMaxLossUsd: number) =>
      runBookBacktest(
        options({
          cells: [
            cell("a", "fx-a", "2026-01-01T00:00:00.000Z", "/MNQ"),
            cell("c", "fx-c", "2026-01-02T00:00:00.000Z", "/MES"),
          ],
          strategies: [scripted("fx-a", { 1: "long" }), scripted("fx-c", { 4: "long" })],
          bars: { [MNQ]: series(8, { 2: SL_HIT }), [MES]: series(8) },
          account: { ...ACCOUNT, dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd } },
        }),
      );

    const gated = await run(2);
    expect(gated.trades.map((t) => t.deploymentId)).toEqual(["a"]);
    expect(gated.blocked).toEqual([
      expect.objectContaining({ deploymentId: "c", gate: "daily_pnl", holderDeploymentId: null, signalBarTs: barTs(4) }),
    ]);

    const roomier = await run(3);
    expect(roomier.trades.map((t) => t.deploymentId)).toEqual(["a", "c"]);

    // The same limit on c alone never trips: its own counter is empty.
    const alone = await runBacktest({
      strategy: scripted("fx-c", { 4: "long" }),
      bars: series(8),
      tickSize: CONTRACT_SPECS.MES.tickSize,
      tickValue: CONTRACT_SPECS.MES.tickValue,
      daySession: CONTRACT_SPECS.MES.daySession,
      dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd: 2 },
    });
    expect(alone.trades).toHaveLength(1);
  });

  it("resets at the CME session boundary: the next session's entry is not gated by the last one's loss", async () => {
    const day2 = T0 + DAY_MS;
    const result = await runBookBacktest(
      options({
        cells: [
          cell("a", "fx-a", "2026-01-01T00:00:00.000Z", "/MNQ"),
          cell("c", "fx-c", "2026-01-02T00:00:00.000Z", "/MES"),
        ],
        strategies: [scripted("fx-a", { 1: "long" }), scripted("fx-c", { 4: "long", 9: "long" })],
        bars: {
          [MNQ]: [...series(8, { 2: SL_HIT }), ...series(4, {}, day2)],
          [MES]: [...series(8), ...series(4, {}, day2)],
        },
        account: { ...ACCOUNT, dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd: 2 } },
      }),
    );
    expect(result.blocked.map((r) => [r.deploymentId, r.gate, r.signalBarTs])).toEqual([["c", "daily_pnl", barTs(4)]]);
    expect(result.trades.map((t) => [t.deploymentId, t.signalBarTs])).toEqual([
      ["a", barTs(1)],
      ["c", new Date(day2 + BAR_MS).toISOString()],
    ]);
  });

  it("flags a shorter-timeframe entry inside the longer bar whose bracket fill tripped the gate", async () => {
    // a's 5m stop fills somewhere inside bar 2 (T0+10m..T0+15m) and reaches
    // the tally only at its close; c's 1m entry at T0+12m could have been
    // refused live.
    const run = (dailyMaxLossUsd: number) =>
      runBookBacktest(
        options({
          cells: [
            cell("a", "fx-a", "2026-01-01T00:00:00.000Z", "/MNQ"),
            cell("c", "fx-c", "2026-01-02T00:00:00.000Z", "/MES"),
          ],
          strategies: [scripted("fx-a", { 1: "long" }), scripted("fx-c", { 11: "long" }, { timeframe: "1m" })],
          bars: { [MNQ]: series(8, { 2: SL_HIT }), [MES_1M]: series(40, {}, T0, MIN_MS) },
          account: { ...ACCOUNT, dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd } },
        }),
      );

    const tripped = await run(2);
    expect(tripped.trades.map((t) => [t.deploymentId, t.releaseSensitive, t.endOfData])).toEqual([
      ["a", false, false],
      ["c", true, true],
    ]);

    const untripped = await run(3);
    expect(untripped.trades.map((t) => [t.deploymentId, t.releaseSensitive])).toEqual([
      ["a", false],
      ["c", false],
    ]);
  });
});

describe("runBookBacktest — release timing", () => {
  it("frees a slot in pass A when the holder's bracket fills, before any cell evaluates the close", async () => {
    // b is evaluated first on every close; a's target fills inside bar 3, so
    // b's signal on 3 finds the slot already free.
    const result = await runBookBacktest(
      options({
        cells: [cell("b", "fx-b", "2026-01-01T00:00:00.000Z"), cell("a", "fx-a", "2026-01-02T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long" }), scripted("fx-b", { 3: "long" })],
        bars: { [MNQ]: series(8, { 3: TP_HIT }) },
      }),
    );
    expect(result.trades.map((t) => [t.deploymentId, t.signalBarTs])).toEqual([
      ["a", barTs(1)],
      ["b", barTs(3)],
    ]);
    expect(result.blocked).toEqual([]);
  });

  it("holds a market exit's slot for the rest of its batch and flags the block release-sensitive", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z"), cell("b", "fx-b", "2026-01-02T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long" }, { exits: [3] }), scripted("fx-b", { 3: "long" })],
        bars: { [MNQ]: series(8) },
      }),
    );
    expect(result.trades.map((t) => [t.deploymentId, t.exitReason])).toEqual([["a", "signal"]]);
    expect(result.blocked).toEqual([
      expect.objectContaining({ deploymentId: "b", gate: "contract_held", holderDeploymentId: "a", releaseSensitive: true }),
    ]);
  });
});

/**
 * A102: live, a bracket filled inside bar `i` leaves the leg flat at that
 * close, so it evaluates there like any flat leg. The fill is reconciled
 * before the close only when it landed early enough, so the re-entry is an
 * excuse to a parity join, never a miss.
 */
describe("runBookBacktest — an entry on the bar a bracket filled", () => {
  it("re-enters the filled cell at that close", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long", 2: "long" })],
        bars: { [MNQ]: series(6, { 2: SL_HIT }) },
      }),
    );
    expect(result.trades.map((t) => [t.signalBarTs, t.exitReason])).toEqual([
      [barTs(1), "stop_loss"],
      [barTs(2), "end_of_data"],
    ]);
  });

  it("ranks the filled cell with the rest, so a better-ranked cell can take the contract it released", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("b", "fx-b", "2026-01-01T00:00:00.000Z"), cell("a", "fx-a", "2026-01-02T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long", 2: "long" }), scripted("fx-b", { 2: "long" })],
        bars: { [MNQ]: series(6, { 2: SL_HIT }) },
      }),
    );
    // a's stop lands where no 1m bar can place it before the close, so live
    // may still hold a's position there and refuse b too.
    expect(result.trades.map((t) => [t.deploymentId, t.signalBarTs, t.releaseSensitive])).toEqual([
      ["a", barTs(1), false],
      ["b", barTs(2), true],
    ]);
    expect(result.blocked).toEqual([
      expect.objectContaining({ deploymentId: "a", gate: "contract_held", holderDeploymentId: "b", signalBarTs: barTs(2) }),
    ]);
  });

  it("checks the daily gate with the fill's loss already in the session's tally", async () => {
    // The stop loses 4 ticks × $0.50 = $2 gross; the limit is $2.
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long", 2: "long" })],
        bars: { [MNQ]: series(6, { 2: SL_HIT }) },
        account: { ...ACCOUNT, dailyPnl: { ...NO_DAILY_PNL_LIMITS, dailyMaxLossUsd: 2 } },
      }),
    );
    expect(result.trades.map((t) => t.signalBarTs)).toEqual([barTs(1)]);
    expect(result.blocked.map((r) => [r.deploymentId, r.gate, r.signalBarTs])).toEqual([["a", "daily_pnl", barTs(2)]]);
  });

  describe("marks the re-entry release-sensitive", () => {
    const reentry = async (args: { timeframe: Timeframe; key: string; bars: BarData[]; subBars?: BarData[] }) => {
      const result = await runBookBacktest({
        ...options({
          cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
          strategies: [scripted("fx-a", { 1: "long", 2: "long" }, { timeframe: args.timeframe })],
          bars: { [args.key]: args.bars },
        }),
        ...(args.subBars ? { subBars: new Map([[args.key, args.subBars]]) } : {}),
      });
      return result.trades.map((t) => t.releaseSensitive);
    };

    it("always on 1m, where every fill lands in the bar's last minute", async () => {
      const MNQ_1M = bookBarKey("/MNQ", "1m");
      expect(await reentry({ timeframe: "1m", key: MNQ_1M, bars: series(6, { 2: SL_HIT }, T0, MIN_MS) })).toEqual([
        false,
        true,
      ]);
    });

    it("on a longer bar with no 1m bars to place the fill on", async () => {
      expect(await reentry({ timeframe: "5m", key: MNQ, bars: series(6, { 2: SL_HIT }) })).toEqual([false, true]);
    });

    it("on a longer bar whose fill the 1m bars place in its last minute, and not when they place it earlier", async () => {
      const bars = series(6, { 2: SL_HIT });
      // Bar 2 spans minutes 10–14.
      const late = series(30, { 14: SL_HIT }, T0, MIN_MS);
      const early = series(30, { 11: SL_HIT }, T0, MIN_MS);
      expect(await reentry({ timeframe: "5m", key: MNQ, bars, subBars: late })).toEqual([false, true]);
      expect(await reentry({ timeframe: "5m", key: MNQ, bars, subBars: early })).toEqual([false, false]);
    });
  });
});

describe("runBookBacktest — same-bar contest", () => {
  const contest = (aCreated: string, bCreated: string) =>
    options({
      cells: [cell("a", "fx-a", aCreated), cell("b", "fx-b", bCreated)],
      strategies: [scripted("fx-a", { 2: "long" }), scripted("fx-b", { 2: "long" })],
      bars: { [MNQ]: series(6) },
    });

  it("goes to the earlier created_at and marks both sides contested", async () => {
    const result = await runBookBacktest(contest("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));
    expect(result.trades.map((t) => [t.deploymentId, t.contested])).toEqual([["a", true]]);
    expect(result.blocked).toEqual([
      expect.objectContaining({ deploymentId: "b", holderDeploymentId: "a", contested: true }),
    ]);
    expect(result.contests).toEqual([
      expect.objectContaining({ contract: "MNQ", winnerDeploymentId: "a", loserDeploymentIds: ["b"] }),
    ]);
  });

  it("goes the other way when created_at is reversed", async () => {
    const result = await runBookBacktest(contest("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"));
    expect(result.trades.map((t) => t.deploymentId)).toEqual(["b"]);
    expect(result.blocked.map((r) => r.deploymentId)).toEqual(["a"]);
  });

  it("permute reruns each contest with the loser evaluated first", async () => {
    const { base, variants } = await runBookBacktestPermuted(
      contest("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    );
    expect(base.trades.map((t) => t.deploymentId)).toEqual(["a"]);
    expect(variants).toHaveLength(1);
    expect(variants[0].promoted.deploymentId).toBe("b");
    expect(variants[0].result.trades.map((t) => t.deploymentId)).toEqual(["b"]);
  });

  it("is not a contest when the loser was already latched — order could not have changed the outcome", async () => {
    // b is latched by a's hold on bar 2. a's target frees the slot in pass A
    // of bar 3, c takes it, and b's signal on 3 meets c's same-instant claim.
    const result = await runBookBacktest(
      options({
        cells: [
          cell("a", "fx-a", "2026-01-01T00:00:00.000Z"),
          cell("c", "fx-c", "2026-01-02T00:00:00.000Z"),
          cell("b", "fx-b", "2026-01-03T00:00:00.000Z"),
        ],
        strategies: [
          scripted("fx-a", { 1: "long" }),
          scripted("fx-c", { 3: "long" }),
          scripted("fx-b", { 2: "long", 3: "long" }),
        ],
        bars: { [MNQ]: series(8, { 3: TP_HIT }) },
      }),
    );
    expect(result.blocked.map((r) => [r.gate, r.signalBarTs, r.holderDeploymentId, r.contested])).toEqual([
      ["contract_held", barTs(2), "a", false],
      ["contract_held", barTs(3), "c", false],
    ]);
    expect(result.trades.map((t) => [t.deploymentId, t.contested])).toEqual([
      ["a", false],
      ["c", false],
    ]);
    expect(result.contests).toEqual([]);
  });

  it("batches timeframes per contract: MES's first timeframe goes first on MES whatever MNQ subscribed first", async () => {
    // MNQ subscribed 5m first; MES subscribed 1m first. e1 (MES 1m) and e5
    // (MES 5m) signal on the same close.
    const result = await runBookBacktest(
      options({
        cells: [
          cell("m5", "fx-m5", "2026-01-01T00:00:00.000Z", "/MNQ"),
          cell("e1", "fx-e1", "2026-01-02T00:00:00.000Z", "/MES"),
          cell("e5", "fx-e5", "2026-01-03T00:00:00.000Z", "/MES"),
        ],
        strategies: [
          scripted("fx-m5", {}),
          scripted("fx-e1", { [oneMinuteIndexClosingWith(2)]: "long" }, { timeframe: "1m" }),
          scripted("fx-e5", { 2: "long" }),
        ],
        bars: { [MNQ]: series(6), [MES_1M]: series(30, {}, T0, MIN_MS), [MES]: series(6) },
      }),
    );
    expect(result.trades.map((t) => [t.deploymentId, t.contested])).toEqual([["e1", true]]);
    expect(result.blocked).toEqual([
      expect.objectContaining({ deploymentId: "e5", gate: "contract_held", holderDeploymentId: "e1", contested: true }),
    ]);
  });
});

describe("runBookBacktest — what a run records about its sizing", () => {
  it("puts each cell's resolved settings on the cell and the applied sizing on each trade row", async () => {
    // A 200-tick MNQ stop is $101.24 a contract. $1,000 at 50% is $500, which
    // buys 4; the playbook's cap of 2 binds under the account's 3.
    const limited: BookCellInput = {
      ...cell("a", "fx-a", "2026-01-01T00:00:00.000Z"),
      paramValues: { playbookMaxContracts: 2, playbookRiskPercent: 50 },
    };
    const result = await runBookBacktest(
      options({
        cells: [limited, cell("b", "fx-b", "2026-01-02T00:00:00.000Z", "/MES")],
        strategies: [scripted("fx-a", { 1: "long" }, { slTicks: 200 }), scripted("fx-b", { 1: "long" }, { slTicks: 200 })],
        bars: { [MNQ]: series(4), [MES]: series(4) },
        account: {
          ...ACCOUNT,
          posture: {
            broker: "topstep",
            riskPhase: "off",
            mllUsd: null,
            startBalanceUsd: null,
            pressAtUsd: null,
            maxRiskPerTradeUsd: 1000,
            maxContracts: 3,
          },
        },
      }),
    );

    expect(result.cells.map((c) => [c.deploymentId, c.params.playbookMaxContracts, c.params.playbookRiskPercent])).toEqual([
      ["a", 2, 50],
      ["b", 0, 100],
    ]);
    const [a, b] = result.trades;
    expect(a).toMatchObject({ deploymentId: "a", contracts: 2 });
    expect(a.sizing).toEqual({
      maxRiskPerTradeUsd: 1000,
      maxContracts: 3,
      riskPerContractUsd: 101.24,
      appliedPlaybookMaxContracts: 2,
      appliedPlaybookRiskPercent: 50,
      playbookBudgetUsd: 500,
    });
    expect(b.sizing).toMatchObject({ appliedPlaybookMaxContracts: null, appliedPlaybookRiskPercent: 100, playbookBudgetUsd: 1000 });
  });
});

describe("runBookBacktest — phase budget", () => {
  it("sizes the next session from the book's simulated close, not a fixed posture", async () => {
    // 50K combine seeded $1,800 above a $49,800 floor... headroom $2,000 → the
    // $500 bucket: a 200-tick stop risks ~$100.74, so the 3-contract ceiling
    // binds. Three full stops on day one cost ~$904, leaving headroom under
    // $1,250 → the $225 bucket, two contracts, on day two.
    const day2 = T0 + DAY_MS;
    const losers = { 2: { low: 19899.75 }, 4: { low: 19899.75 }, 6: { low: 19899.75 } };
    const bars = [...series(8, losers), ...series(4, {}, day2)];
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long", 3: "long", 5: "long", 9: "long" }, { slTicks: 200 })],
        bars: { [MNQ]: bars },
        account: {
          ...ACCOUNT,
          posture: {
            broker: "topstep",
            riskPhase: "combine",
            mllUsd: 2000,
            startBalanceUsd: 50000,
            pressAtUsd: null,
            maxRiskPerTradeUsd: 500,
            maxContracts: 3,
          },
          phaseSeed: { closeUsd: 51800, peakUsd: 51800 },
        },
      }),
    );
    expect(result.trades.map((t) => t.contracts)).toEqual([3, 3, 3, 2]);
  });

  it("combine_press: presses $500 at headroom over the threshold and $350 the session it falls under", async () => {
    // Seeded $2,000 above a $49,800 floor, threshold $1,500: $500 against a
    // 300-tick stop (~$150.74 a contract) is three contracts. Two full stops
    // (~$904) leave headroom ~$1,096, under the threshold: $350 is two
    // contracts on day two — where `combine` would answer $225 and one.
    const day2 = T0 + DAY_MS;
    const losers = { 2: { low: 19899.75 }, 4: { low: 19899.75 } };
    const bars = [...series(8, losers), ...series(4, {}, day2)];
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 1: "long", 3: "long", 9: "long" }, { slTicks: 300 })],
        bars: { [MNQ]: bars },
        account: {
          ...ACCOUNT,
          posture: {
            broker: "topstep",
            riskPhase: "combine_press",
            mllUsd: 2000,
            startBalanceUsd: 50000,
            pressAtUsd: 1500,
            maxRiskPerTradeUsd: 500,
            maxContracts: 3,
          },
          phaseSeed: { closeUsd: 51800, peakUsd: 51800 },
        },
      }),
    );
    expect(result.trades.map((t) => t.contracts)).toEqual([3, 3, 2]);
  });

  it("seeds the phase at the first reported session, so warmup sessions do not move its budget", async () => {
    // Two warmup sessions of three full 200-tick stops each would leave the
    // book well under the $500 bucket; seeded at the reported Monday it is
    // still the seed's $500 bucket and its 3-contract ceiling.
    const losers = { 2: { low: 19899.75 }, 4: { low: 19899.75 }, 6: { low: 19899.75 } };
    const fri = T0 + DAY_MS;
    const mon = T0 + 4 * DAY_MS;
    const bars = [...series(8, losers), ...series(8, losers, fri), ...series(4, {}, mon)];
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [
          scripted("fx-a", { 1: "long", 3: "long", 5: "long", 9: "long", 11: "long", 13: "long", 17: "long" }, { slTicks: 200 }),
        ],
        bars: { [MNQ]: bars },
        reportFrom: new Date(Date.UTC(2025, 0, 6)),
        account: {
          ...ACCOUNT,
          posture: {
            broker: "topstep",
            riskPhase: "combine",
            mllUsd: 2000,
            startBalanceUsd: 50000,
            pressAtUsd: null,
            maxRiskPerTradeUsd: 500,
            maxContracts: 3,
          },
          phaseSeed: { closeUsd: 51800, peakUsd: 51800 },
        },
      }),
    );
    expect(result.trades.map((t) => [t.signalBarTs, t.contracts])).toEqual([
      [new Date(mon + BAR_MS).toISOString(), 3],
    ]);
  });

  it("records a posture the sizer cannot read as the engine's size_resolution skip", async () => {
    const result = await runBookBacktest(
      options({
        cells: [cell("a", "fx-a", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-a", { 2: "long" })],
        bars: { [MNQ]: series(4) },
        account: { ...ACCOUNT, posture: null },
      }),
    );
    expect(result.trades).toEqual([]);
    expect(result.skips.map((s) => [s.deploymentId, s.gate, s.signalBarTs])).toEqual([
      ["a", "size_resolution", barTs(2)],
    ]);
  });
});

/**
 * A105: a cell's series resolves a flatten inside a bar on its own 1m bars,
 * as `runBacktest` does. 30m from 14:30 ET; the stop is touched only at 15:58,
 * after the 15:55 flatten, inside the 15:30 bar.
 */
describe("runBookBacktest — a session flatten inside a bar", () => {
  const MNQ_30M = bookBarKey("/MNQ", "30m");
  const START = Date.UTC(2025, 0, 2, 19, 30, 0);
  const bars30 = series(4, { 2: { low: SL_HIT.low } }, START, 30 * MIN_MS);
  const flattenMinute = 85;
  const subBars = series(120, { 88: SL_HIT }, START, MIN_MS).map((b, i) =>
    i === flattenMinute ? { ...b, open: PRICE + 1, high: PRICE + 1.25, low: PRICE + 0.75, close: PRICE + 1 } : b,
  );
  const run = (withSubBars: boolean) =>
    runBookBacktest({
      ...options({
        cells: [cell("a", "fx-30m", "2026-01-01T00:00:00.000Z")],
        strategies: [scripted("fx-30m", { 1: "long" }, { timeframe: "30m" })],
        bars: { [MNQ_30M]: bars30 },
      }),
      ...(withSubBars ? { subBars: new Map([[MNQ_30M, subBars]]) } : {}),
    });

  it("flattens at the 15:55 open from the cell's 1m bars, with no stop after it", async () => {
    const result = await run(true);
    expect(result.trades.map((t) => [t.exitReason, t.exitPrice])).toEqual([["time_window_close", PRICE + 1]]);
  });

  it("takes the conservative stop when the series has no 1m bars", async () => {
    const result = await run(false);
    expect(result.trades.map((t) => t.exitReason)).toEqual(["stop_loss"]);
  });
});

/**
 * A cell that checks break-even intrabar reads its series' 1m bars as a single
 * run does. 5m from 10:00 ET; long at bar 1's close (20000), 4-tick stop at
 * 19999, so 1R arms at 20001. Bar 2's first minute reaches it and closes
 * clear; its second falls through the original stop.
 */
describe("runBookBacktest — break-even checked intrabar", () => {
  const minute = (k: number, high: number, low: number, close: number): BarData => ({
    timestamp: new Date(T0 + k * MIN_MS).toISOString(),
    open: PRICE,
    high,
    low,
    close,
    volume: 100,
  });
  const subBars = Array.from({ length: 20 }, (_, k) =>
    k === 10 ? minute(k, PRICE + 1.25, PRICE, PRICE + 1) : k === 11 ? minute(k, PRICE + 1, PRICE - 1.5, PRICE - 1.25) : minute(k, PRICE, PRICE, PRICE),
  );
  const bars = series(4, { 2: { high: PRICE + 1.25, low: PRICE - 1.5 } });
  const strategy = scripted("fx-be", { 1: "long" });
  const paramValues = { breakEvenFilterEnabled: true, breakEvenFilterAtR: 1, breakEvenFilterOffsetTicks: 0, breakEvenFilterCheck: "intrabar" };

  it("scratches the arm-and-fade bar, as runBacktest does on the same bars", async () => {
    const book = await runBookBacktest({
      ...options({
        cells: [{ ...cell("a", "fx-be", "2026-01-01T00:00:00.000Z"), paramValues }],
        strategies: [strategy],
        bars: { [MNQ]: bars },
      }),
      subBars: new Map([[MNQ, subBars]]),
    });
    const single = await runBacktest({
      strategy,
      bars,
      subBars,
      paramOverrides: paramValues,
      tickSize: CONTRACT_SPECS.MNQ.tickSize,
      tickValue: CONTRACT_SPECS.MNQ.tickValue,
      daySession: CONTRACT_SPECS.MNQ.daySession,
    });
    expect(single.trades.map((t) => [t.exitReason, t.exitPrice])).toEqual([["breakeven_stop", PRICE]]);
    expect(book.trades.map((t) => [t.exitReason, t.exitPrice])).toEqual([["breakeven_stop", PRICE]]);
  });
});
