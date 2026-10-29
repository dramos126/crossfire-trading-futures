import { EventEmitter } from "node:events";
import v8 from "node:v8";

import { describe, it, expect } from "vitest";

import {
  MIN_SHIFT_SESSIONS,
  drawShiftOffset,
  evaluateLift,
  maxDrawdownR,
  mulberry32,
  runLiftFolds,
  selectClaimSet,
  type HeldOutTrade,
  type LabelledSession,
  type LiftThresholds,
} from "./lift-command";
import { parseArgs } from "../args";
import type { Fold } from "../folds";
import type { LabelIndex } from "../regime-labels";
import { runWindow, type WindowResult } from "../run-window";
import { MAX_SKIP_RECORDS } from "../skip-record";
import { buildSummary } from "../summary";
import { createCpuThrottle } from "../throttle";
import { createWorkerHandler } from "../window-worker";
import { createWindowPool, type ToWorker, type WindowPool, type WorkerChild } from "../worker-pool";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import {
  LEGACY_DAY_SESSION,
  withCommonParams,
  type StrategyContext,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";

const THRESHOLDS: LiftThresholds = {
  minCellTrades: 100,
  minLiftR: 0.1,
  foldConsistency: 0.67,
  permutations: 200,
  seed: 7,
};

const FOLDS = 4;
const SESSIONS_PER_FOLD = 100;
const TRADES_PER_SESSION = 2;

/**
 * A four-fold study over 400 sessions in blocks of ten, each block carrying
 * one cyclically-contiguous run of five `active.expanded` days whose start
 * rotates block to block. Exactly half the sessions are `active.expanded`,
 * so `E_all` is the plain average of the two returns, while the rotation
 * stops a circular shift from mapping the winning run back onto itself —
 * which is what the permutation null is supposed to have to work for.
 */
function study(winnerR: number, loserR: number, winner = "active.expanded"): {
  trades: HeldOutTrade[];
  sessions: LabelledSession[];
} {
  const sessions: LabelledSession[] = [];
  const trades: HeldOutTrade[] = [];
  const BLOCK = 10;
  const RUN = 5;
  const ROTATION = 3;

  for (let foldId = 0; foldId < FOLDS; foldId++) {
    for (let i = 0; i < SESSIONS_PER_FOLD; i++) {
      const day = foldId * SESSIONS_PER_FOLD + i;
      const block = Math.floor(day / BLOCK);
      const winning = ((day % BLOCK) + block * ROTATION) % BLOCK < RUN;
      const label = winning ? "active.expanded" : "quiet.compressed";
      const sessionDate = `s${String(day).padStart(4, "0")}`;
      sessions.push({ sessionDate, label });
      for (let t = 0; t < TRADES_PER_SESSION; t++) {
        trades.push({ foldId, sessionDate, r: label === winner ? winnerR : loserR });
      }
    }
  }
  return { trades, sessions };
}

describe("evaluateLift", () => {
  it("finds the lift the construction put there", () => {
    // Half the sessions win 1R and half lose 0.5R, so E_all is 0.25R and the
    // winning cell's lift over it is exactly 0.75R.
    const { trades, sessions } = study(1, -0.5);
    const evaluation = evaluateLift({ trades, sessions, foldCount: FOLDS, thresholds: THRESHOLDS });

    expect(evaluation.eAll).toBeCloseTo(0.25, 10);
    expect(evaluation.claimSet).toEqual(["active.expanded"]);
    expect(evaluation.lift).toBeCloseTo(0.75, 10);
    expect(evaluation.foldConsistency.value).toBe(1);
    expect(evaluation.foldConsistency.eligibleFolds).toBe(FOLDS);
    expect(evaluation.drawdown.gatedR).toBeLessThanOrEqual(evaluation.drawdown.ungatedR);
    expect(evaluation.permutation.n).toBe(THRESHOLDS.permutations);
    expect(evaluation.pass).toBe(true);
  });

  it("reports the per-cell table over the sessions, not only the trades", () => {
    const { trades, sessions } = study(1, -0.5);
    const evaluation = evaluateLift({ trades, sessions, foldCount: FOLDS, thresholds: THRESHOLDS });
    const winner = evaluation.cells.find((c) => c.cell === "active.expanded");

    expect(winner).toMatchObject({
      sessions: 200,
      n: 400,
      expectancyR: 1,
      winRate: 1,
      maxDrawdownR: 0,
    });
    expect(winner?.perFold.map((f) => f.n)).toEqual([100, 100, 100, 100]);
  });

  it("fails on a label with no relationship to the trades", () => {
    // Same trade set, but the R depends on nothing the label knows: every
    // session returns the same number, so no cell can beat E_all.
    const { trades, sessions } = study(0.25, 0.25);
    const evaluation = evaluateLift({ trades, sessions, foldCount: FOLDS, thresholds: THRESHOLDS });

    expect(evaluation.claimSet).toEqual([]);
    expect(evaluation.lift).toBe(0);
    expect(evaluation.verdicts.claimSetNonEmpty).toBe(false);
    expect(evaluation.pass).toBe(false);
  });

  it("refuses a lift that the shifted series reproduces", () => {
    // The label runs are five days long and the trades follow the same
    // five-day rhythm regardless of which label sits on a day, so a shifted
    // series claims the same lift and the permutation criterion fails.
    const sessions: LabelledSession[] = [];
    const trades: HeldOutTrade[] = [];
    for (let day = 0; day < FOLDS * SESSIONS_PER_FOLD; day++) {
      const sessionDate = `s${String(day).padStart(4, "0")}`;
      const winning = Math.floor(day / 5) % 2 === 0;
      sessions.push({
        sessionDate,
        label: winning ? "active.expanded" : "quiet.compressed",
      });
      trades.push({
        foldId: Math.floor(day / SESSIONS_PER_FOLD),
        sessionDate,
        r: winning ? 1 : -0.5,
      });
    }
    // A shift of a multiple of ten days maps winners onto winners, so a good
    // share of the null draws reproduce the observed lift exactly.
    const evaluation = evaluateLift({
      trades,
      sessions,
      foldCount: FOLDS,
      thresholds: { ...THRESHOLDS, minCellTrades: 50 },
    });
    expect(evaluation.permutation.p).toBeGreaterThan(0.05);
    expect(evaluation.verdicts.permutation).toBe(false);
    expect(evaluation.pass).toBe(false);
  });

  it("re-runs the cell selection on every shift, so a shift can claim what the observed labels could not", () => {
    // Returns run in 20-day blocks and the labels run in 20-day blocks
    // offset by ten, so each observed cell holds half of each return block
    // and no cell clears the floor. A shift that realigns them does claim a
    // cell — which is only visible if the selection is redone per shift.
    const sessions: LabelledSession[] = [];
    const trades: HeldOutTrade[] = [];
    const BLOCK = 20;
    for (let day = 0; day < FOLDS * SESSIONS_PER_FOLD; day++) {
      const sessionDate = `s${String(day).padStart(4, "0")}`;
      sessions.push({
        sessionDate,
        label:
          Math.floor(day / BLOCK) % 2 === 0 ? "active.expanded" : "quiet.compressed",
      });
      const winningReturn = Math.floor((day + BLOCK / 2) / BLOCK) % 2 === 0;
      trades.push({
        foldId: Math.floor(day / SESSIONS_PER_FOLD),
        sessionDate,
        r: winningReturn ? 1 : -0.5,
      });
    }

    const evaluation = evaluateLift({
      trades,
      sessions,
      foldCount: FOLDS,
      thresholds: THRESHOLDS,
    });
    expect(evaluation.claimSet).toEqual([]);
    expect(evaluation.lift).toBe(0);
    expect(evaluation.permutation.percentile95).toBeGreaterThan(0);
  });

  it("is reproducible under a seed", () => {
    const { trades, sessions } = study(1, -0.5);
    const run = (seed: number) =>
      evaluateLift({
        trades,
        sessions,
        foldCount: FOLDS,
        thresholds: { ...THRESHOLDS, seed },
      }).permutation;

    expect(run(7)).toEqual(run(7));
  });
});

describe("selectClaimSet", () => {
  it("claims a cell at the trade floor and not one trade below it", () => {
    const cellOf = new Map<string, string>();
    const trades: HeldOutTrade[] = [];
    for (let i = 0; i < 100; i++) {
      const sessionDate = `s${i}`;
      cellOf.set(sessionDate, "active.expanded");
      trades.push({ foldId: 0, sessionDate, r: 1 });
    }

    expect(selectClaimSet(trades, cellOf, 0, THRESHOLDS)).toEqual(["active.expanded"]);
    expect(selectClaimSet(trades.slice(0, 99), cellOf, 0, THRESHOLDS)).toEqual([]);
  });

  it("never claims unknown, whatever it earned", () => {
    const cellOf = new Map<string, string>();
    const trades: HeldOutTrade[] = [];
    for (let i = 0; i < 500; i++) {
      const sessionDate = `s${i}`;
      cellOf.set(sessionDate, "unknown");
      trades.push({ foldId: 0, sessionDate, r: 2 });
    }
    expect(selectClaimSet(trades, cellOf, 0, THRESHOLDS)).toEqual([]);
  });

  it("refuses a cell whose edge over E_all is under the floor", () => {
    const cellOf = new Map<string, string>();
    const trades: HeldOutTrade[] = [];
    for (let i = 0; i < 200; i++) {
      const sessionDate = `s${i}`;
      cellOf.set(sessionDate, "quiet.expanded");
      trades.push({ foldId: 0, sessionDate, r: 0.5 });
    }
    expect(selectClaimSet(trades, cellOf, 0.45, THRESHOLDS)).toEqual([]);
    expect(selectClaimSet(trades, cellOf, 0.3, THRESHOLDS)).toEqual(["quiet.expanded"]);
  });
});

describe("drawShiftOffset", () => {
  it("stays clear of both ends, because a shift of len − 1 is a shift of −1", () => {
    const sessionCount = 400;
    // Every value the generator can return, ends included: the bound has to
    // hold for the extremes, not only for a sample of the middle.
    for (const u of [0, 0.5, 1 - Number.EPSILON]) {
      const offset = drawShiftOffset(() => u, sessionCount);
      expect(offset).toBeGreaterThanOrEqual(MIN_SHIFT_SESSIONS);
      expect(offset).toBeLessThanOrEqual(sessionCount - MIN_SHIFT_SESSIONS);
    }

    const random = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const offset = drawShiftOffset(random, sessionCount);
      expect(offset).toBeGreaterThanOrEqual(MIN_SHIFT_SESSIONS);
      expect(offset).toBeLessThanOrEqual(sessionCount - MIN_SHIFT_SESSIONS);
    }
  });

  it("draws a different sequence under a different seed", () => {
    const sequence = (seed: number) => {
      const random = mulberry32(seed);
      return Array.from({ length: 20 }, () => drawShiftOffset(random, 400));
    };
    expect(sequence(7)).toEqual(sequence(7));
    expect(sequence(7)).not.toEqual(sequence(8));
  });
});

describe("maxDrawdownR", () => {
  it("is the deepest peak-to-trough of the cumulative series", () => {
    expect(maxDrawdownR([1, -0.5, -0.5, 1])).toBeCloseTo(1, 10);
    expect(maxDrawdownR([1, 1, 1])).toBe(0);
    expect(maxDrawdownR([])).toBe(0);
  });
});

const FIVE_MINUTES_MS = 5 * 60_000;
/** Well above one fixture window's run time, so the delay decides the order. */
const REVERSE_ORDER_STEP_MS = 20;
const LIFT_SESSIONS = ["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05", "2025-06-06"];

const LIFT_BARS: BarData[] = LIFT_SESSIONS.flatMap((date) => {
  const open = new Date(`${date}T13:30:00.000Z`).getTime();
  return Array.from({ length: 12 }, (_, i) => ({
    timestamp: new Date(open + i * FIVE_MINUTES_MS).toISOString(),
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100 + (i % 3) - 1,
    volume: 10,
  }));
});

/** Enters on two bars in three and skips the third, so every fold carries
 *  trades and skip rows both. */
const entersAndSkips = {
  key: "enters-and-skips",
  version: "1.0.0",
  config: {
    name: "Enters and skips",
    description: "fixture",
    timeframe: "5m",
    session: LEGACY_DAY_SESSION,
    entryType: 2,
    indicators: [],
  },
  params: withCommonParams({}),
  shouldEnter: (ctx: StrategyContext) =>
    ctx.barIndex % 3 === 0
      ? { skip: "long break below session VWAP", gate: "vwap" }
      : { side: 0 as const, slTicks: 8, tpTicks: 16 },
  shouldExit: () => true,
} satisfies StrategyModule;

const LIFT_FOLDS: Fold[] = ["2025-06-04", "2025-06-05", "2025-06-06"].map((date, foldId) => ({
  foldId,
  train: { from: "2025-06-02", to: "2025-06-03" },
  test: { from: date, to: date },
}));

const LIFT_LABELS: LabelIndex = new Map(
  LIFT_SESSIONS.map((sessionDate, i) => {
    const label = i % 2 === 0 ? "active.expanded" : "quiet.compressed";
    return [
      sessionDate,
      {
        label,
        vol: i % 2 === 0 ? ("active" as const) : ("quiet" as const),
        range: i % 2 === 0 ? ("expanded" as const) : ("compressed" as const),
        classifierVersion: "1",
        features: { vol5: 1, vol5Pct: 50, rthRange: 1, rangeRatio: 1 },
      },
    ];
  }),
);

const LIFT_ARGS = parseArgs("lift", [
  "--ticker",
  "MNQ",
  "--timeframe",
  "5m",
  "--from",
  "2025-06-04",
  "--to",
  "2025-06-06",
  "--playbook",
  "enters-and-skips",
]);

/** What crossing an `advanced`-serialization IPC channel does to a message. */
function overIpc<T>(message: T): T {
  return v8.deserialize(v8.serialize(message)) as T;
}

/** The real worker handler without the fork, behind a structured-clone
 *  channel, answering the first job last. */
class InProcessWorker extends EventEmitter implements WorkerChild {
  private readonly handle: (message: ToWorker) => void;
  constructor(strategy: StrategyModule, finished: number[], jobCount: number) {
    super();
    this.handle = createWorkerHandler({
      loadStrategy: async () => strategy,
      clock: { cpuMs: () => 0, wallMs: () => 0 },
      createThrottle: (cpuTarget, clock) => createCpuThrottle(cpuTarget, clock),
      send: (message) => {
        setTimeout(() => {
          finished.push(message.index);
          this.emit("message", overIpc(message));
        }, (jobCount - message.index) * REVERSE_ORDER_STEP_MS);
      },
    });
  }
  send(message: ToWorker): boolean {
    this.handle(overIpc(message));
    return true;
  }
  kill(): boolean {
    return true;
  }
}

describe("runLiftFolds", () => {
  async function folds(workers: number) {
    const finished: number[] = [];
    const pool = createWindowPool({
      workers,
      cpuTarget: 100,
      throttle: createCpuThrottle(100),
      forkWorker: () => new InProcessWorker(entersAndSkips, finished, LIFT_FOLDS.length),
    });
    const out = await runLiftFolds({
      args: LIFT_ARGS,
      strategy: entersAndSkips,
      spec: CONTRACT_SPECS.MNQ,
      allBars: LIFT_BARS,
      folds: LIFT_FOLDS,
      labels: LIFT_LABELS,
      pool,
    });
    pool.close();
    return { out, finished };
  }

  it("writes the same records, ids, pooled trades, sessions and skips at 3 workers as at 1", async () => {
    const one = await folds(1);
    const three = await folds(3);

    expect(three.finished).toEqual([2, 1, 0]);
    expect(JSON.stringify(three.out)).toBe(JSON.stringify(one.out));
    expect(one.out.records.length).toBeGreaterThan(LIFT_FOLDS.length);
    expect(one.out.skips.length).toBeGreaterThan(0);
    expect(one.out.skips.map((s) => s.foldId)).toEqual([...one.out.skips.map((s) => s.foldId)].sort());
  });

  it("hands out the ids the sequential fold loop chained, in fold order", async () => {
    const { out } = await folds(3);

    // The loop as it ran before the pool: each fold starts where the last
    // one's ids ended.
    let nextTradeId = 1;
    const chained = [];
    for (const fold of LIFT_FOLDS) {
      const window = await runWindow({
        strategy: entersAndSkips,
        allBars: LIFT_BARS,
        from: fold.test.from,
        to: fold.test.to,
        warmupDays: LIFT_ARGS.warmupDays,
        tickSize: CONTRACT_SPECS.MNQ.tickSize,
        tickValue: CONTRACT_SPECS.MNQ.tickValue,
        daySession: CONTRACT_SPECS.MNQ.daySession,
        feePerSideUsd: CONTRACT_SPECS.MNQ.feePerSide,
        paramOverrides: { timeframe: "5m" },
        sizing: { mode: "fixed", contracts: 1 },
        dailyLossUsd: null,
        dailyProfitUsd: null,
        foldId: fold.foldId,
        sample: "test",
        tradeIdStart: nextTradeId,
        labels: LIFT_LABELS,
        regimes: null,
      });
      nextTradeId += window.records.length;
      chained.push(...window.records);
    }

    expect(out.records).toEqual(chained);
    expect(out.records.map((r) => r.tradeId)).toEqual(chained.map((_, i) => i + 1));
  });

  it("applies the command-wide skip cap in fold order, whatever order the folds returned in", async () => {
    const { out } = await folds(1);
    const sample = out.skips[0];
    const PER_FOLD = 30_000;
    const windows = LIFT_FOLDS.map((fold): WindowResult => ({
      records: [],
      keptBacktestTrades: [],
      skips: Array.from({ length: PER_FOLD }, () => ({ ...sample, foldId: fold.foldId })),
      sessions: [],
      summary: buildSummary({ records: [], backtestTrades: [], sessions: [] }),
      warmupFrom: fold.test.from,
      barCount: 0,
      firstBarTs: null,
      lastBarTs: null,
      resolvedParams: {},
      warnings: [],
    }));
    const pool = {
      run: async (_source, _jobs, onResult) => {
        for (const [i, window] of windows.entries()) onResult(i, window);
      },
      close: () => {},
    } satisfies WindowPool;

    const capped = await runLiftFolds({
      args: LIFT_ARGS,
      strategy: entersAndSkips,
      spec: CONTRACT_SPECS.MNQ,
      allBars: LIFT_BARS,
      folds: LIFT_FOLDS,
      labels: LIFT_LABELS,
      pool,
    });

    expect(capped.skips).toHaveLength(MAX_SKIP_RECORDS);
    expect(capped.skipsDropped).toBe(LIFT_FOLDS.length * PER_FOLD - MAX_SKIP_RECORDS);
    const kept = new Map<number | null, number>();
    for (const s of capped.skips) kept.set(s.foldId, (kept.get(s.foldId) ?? 0) + 1);
    expect([...kept.entries()]).toEqual([
      [0, PER_FOLD],
      [1, MAX_SKIP_RECORDS - PER_FOLD],
    ]);
  });
});
