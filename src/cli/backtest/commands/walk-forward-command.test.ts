import { EventEmitter } from "node:events";
import v8 from "node:v8";
import vm from "node:vm";

import { describe, it, expect, vi } from "vitest";

import {
  MIN_TRAINING_TRADES_TO_SWEEP,
  assertSweepable,
  efficiencyOf,
  isBetter,
  pickBest,
  sweepGrid,
} from "./walk-forward-command";
import { parseArgs, parseSweepAxis, runsInSampleWindows } from "../args";
import { hashParams } from "../output";
import { resolveFullParams, resolveParamOverrides } from "../params";
import type { WindowResult } from "../run-window";
import type { CliSummary } from "../summary";
import { createCpuThrottle, type ProcessClock } from "../throttle";
import { createWorkerHandler } from "../window-worker";
import {
  createWindowPool,
  type FromWorker,
  type ToWorker,
  type WindowPool,
  type WorkerChild,
} from "../worker-pool";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import {
  LEGACY_DAY_SESSION,
  withCommonParams,
  type StrategyContext,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";

const MINIMAL = [
  "--ticker",
  "MNQ",
  "--timeframe",
  "5m",
  "--from",
  "2024-01-01",
  "--to",
  "2025-06-30",
  "--playbook",
  "orb",
];

const FOLD = {
  foldId: 2,
  train: { from: "2023-01-01", to: "2024-06-30" },
  test: { from: "2024-07-01", to: "2024-12-31" },
};

function summary(over: Partial<CliSummary>): CliSummary {
  return {
    expectancyR: 0,
    totalPnlDollars: 0,
    profitFactor: 0,
    maxDrawdownR: 0,
    ...over,
  } as CliSummary;
}

describe("assertSweepable", () => {
  it("refuses a training window under the floor and names the count", () => {
    expect(() => assertSweepable(FOLD, 99)).toThrow(/has 99 training trades/);
    expect(() => assertSweepable(FOLD, 99)).toThrow(/floor is 100/);
    expect(() => assertSweepable(FOLD, 99)).toThrow(/2023-01-01\.\.2024-06-30/);
  });

  it("allows exactly the floor", () => {
    expect(() => assertSweepable(FOLD, MIN_TRAINING_TRADES_TO_SWEEP)).not.toThrow();
  });

  it("refuses a fold with no trades at all rather than sweeping an empty window", () => {
    expect(() => assertSweepable(FOLD, 0)).toThrow(/has 0 training trades/);
  });
});

describe("sweepGrid", () => {
  it("is empty without an axis, so a bare walk-forward is a held-out report", () => {
    expect(sweepGrid([])).toEqual([]);
  });

  it("takes the cartesian product of two axes", () => {
    const grid = sweepGrid([parseSweepAxis("a=1:2:1"), parseSweepAxis("b=10:20:10")]);
    expect(grid).toHaveLength(4);
    expect(grid).toContainEqual({ a: 1, b: 10 });
    expect(grid).toContainEqual({ a: 2, b: 20 });
  });
});

describe("runsInSampleWindows", () => {
  it("is false without a sweep, so a plain walk-forward runs held-out windows only", () => {
    expect(runsInSampleWindows(parseArgs("walk-forward", MINIMAL))).toBe(false);
  });

  it("is true under a sweep, which has to have a training window to pick on", () => {
    const args = parseArgs("walk-forward", [...MINIMAL, "--sweep", "atrPeriod=10:14:2"]);
    expect(runsInSampleWindows(args)).toBe(true);
  });

  it("is true when --in-sample asks for the train-vs-test comparison", () => {
    const args = parseArgs("walk-forward", [...MINIMAL, "--in-sample"]);
    expect(args.inSample).toBe(true);
    expect(runsInSampleWindows(args)).toBe(true);
  });

  it("takes --in-sample as a bare flag", () => {
    expect(() =>
      parseArgs("walk-forward", [...MINIMAL, "--in-sample=true"]),
    ).toThrow(/takes no value/);
  });
});

describe("isBetter", () => {
  it("maximises every objective except drawdown, which it minimises", () => {
    expect(isBetter("expectancyR", summary({ expectancyR: 0.2 }), summary({ expectancyR: 0.1 }))).toBe(true);
    expect(isBetter("netDollars", summary({ totalPnlDollars: 10 }), summary({ totalPnlDollars: 20 }))).toBe(false);
    expect(isBetter("profitFactor", summary({ profitFactor: 1.4 }), summary({ profitFactor: 1.1 }))).toBe(true);
    expect(isBetter("maxDrawdownR", summary({ maxDrawdownR: 2 }), summary({ maxDrawdownR: 5 }))).toBe(true);
  });

  it("keeps the incumbent on a tie, so the first grid point wins", () => {
    expect(isBetter("expectancyR", summary({ expectancyR: 0.1 }), summary({ expectancyR: 0.1 }))).toBe(false);
  });
});

/** The two modules differ only in a constant no CLI flag mentions, which is
 *  the case the header has to tell apart. */
function playbook(key: string, atrPeriod: number): StrategyModule {
  return {
    key,
    version: "1.0.0",
    config: {
      name: key,
      timeframe: "5m",
      session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
      size: 1,
      entryType: 2,
      indicators: [],
    },
    params: {
      size: { type: "integer", label: "Contracts", default: 1 },
      atrPeriod: { type: "integer", label: "ATR period", default: atrPeriod },
    },
    shouldEnter: () => null,
    shouldExit: () => false,
  } as StrategyModule;
}

describe("the walk-forward header's base params", () => {
  const args = parseArgs("walk-forward", MINIMAL);

  it("carries a module constant the CLI never passed", () => {
    expect(resolveFullParams(playbook("a", 14), args).atrPeriod).toBe(14);
  });

  it("moves the calibration hash between two modules run with identical flags", () => {
    const a = hashParams(resolveFullParams(playbook("a", 14), args));
    const b = hashParams(resolveFullParams(playbook("b", 20), args));
    expect(a).not.toBe(b);
  });

  it("did not move when the header hashed the CLI overrides alone", () => {
    const a = hashParams(resolveParamOverrides(playbook("a", 14), args));
    const b = hashParams(resolveParamOverrides(playbook("b", 20), args));
    expect(a).toBe(b);
  });

  it("holds no sweep value — a fold's pick belongs to that fold's report", () => {
    const swept = parseArgs("walk-forward", [...MINIMAL, "--sweep", "atrPeriod=10:20:5"]);
    expect(resolveFullParams(playbook("a", 14), swept).atrPeriod).toBe(14);
  });
});

describe("efficiencyOf", () => {
  it("is the held-out expectancy over the training expectancy", () => {
    expect(efficiencyOf(summary({ expectancyR: 0.2 }), summary({ expectancyR: 0.1 }))).toBeCloseTo(0.5, 10);
  });

  it("is null rather than Infinity when the training window expected nothing", () => {
    expect(efficiencyOf(summary({ expectancyR: 0 }), summary({ expectancyR: 0.1 }))).toBeNull();
  });

  it("is null on a losing training window — there is no degradation from a loss", () => {
    expect(efficiencyOf(summary({ expectancyR: -0.2 }), summary({ expectancyR: -0.1 }))).toBeNull();
  });
});

const FIVE_MINUTES_MS = 5 * 60_000;
/** Well above one fixture window's run time, so the delay decides the order. */
const REVERSE_ORDER_STEP_MS = 20;
const SWEEP_SESSIONS = ["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05", "2025-06-06"];

/** Closes one point higher every bar, so a long earns and a short loses. */
const RISING_BARS: BarData[] = SWEEP_SESSIONS.flatMap((date) => {
  const open = new Date(`${date}T13:30:00.000Z`).getTime();
  return Array.from({ length: 12 }, (_, i) => ({
    timestamp: new Date(open + i * FIVE_MINUTES_MS).toISOString(),
    open: 99 + i,
    high: 100.5 + i,
    low: 99.5 + i,
    close: 100 + i,
    volume: 10,
  }));
});

/** `side` decides every trade; `ignored` decides nothing, so a sweep over it
 *  is a tie at every grid point. */
const sweepable = {
  key: "sweepable",
  version: "1.0.0",
  config: {
    name: "Sweepable",
    description: "fixture",
    timeframe: "5m",
    session: LEGACY_DAY_SESSION,
    entryType: 2,
    indicators: [],
  },
  params: withCommonParams({
    side: { type: "integer", label: "Side", default: 0 },
    ignored: { type: "integer", label: "Ignored", default: 0 },
  }),
  shouldEnter: (ctx: StrategyContext) => ({
    side: ctx.params.side === 1 ? (1 as const) : (0 as const),
    slTicks: 8,
    tpTicks: 16,
  }),
  shouldExit: () => true,
} satisfies StrategyModule;

/** What crossing an `advanced`-serialization IPC channel does to a message. */
function overIpc<T>(message: T): T {
  return v8.deserialize(v8.serialize(message)) as T;
}

const IDLE_CLOCK: ProcessClock = { cpuMs: () => 0, wallMs: () => 0 };

function workerHandler(strategy: StrategyModule, send: (message: FromWorker) => void) {
  return createWorkerHandler({
    loadStrategy: async () => strategy,
    clock: IDLE_CLOCK,
    createThrottle: (cpuTarget, clock) => createCpuThrottle(cpuTarget, clock),
    send,
  });
}

/**
 * A forked worker without the fork: the real worker handler behind a
 * structured-clone channel, answering each job later the earlier it was
 * sent, so the last grid point finishes first.
 */
class InProcessWorker extends EventEmitter implements WorkerChild {
  private readonly handle: (message: ToWorker) => void;
  constructor(strategy: StrategyModule, finished: number[], jobCount: number) {
    super();
    this.handle = workerHandler(strategy, (message) => {
      setTimeout(() => {
        finished.push(message.index);
        this.emit("message", overIpc(message));
      }, (jobCount - message.index) * REVERSE_ORDER_STEP_MS);
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

/** The real worker handler, whose answers the test releases by hand. */
class HeldWorker extends EventEmitter implements WorkerChild {
  readonly held: FromWorker[] = [];
  private readonly handle: (message: ToWorker) => void;
  constructor(strategy: StrategyModule) {
    super();
    this.handle = workerHandler(strategy, (message) => {
      this.held.push(message);
    });
  }
  /** The job index of the answer it is holding. */
  get heldIndex(): number {
    return this.held[0].index;
  }
  send(message: ToWorker): boolean {
    this.handle(overIpc(message));
    return true;
  }
  kill(): boolean {
    return true;
  }
  release(): void {
    const message = this.held.shift();
    if (message === undefined) throw new Error("nothing held");
    this.emit("message", overIpc(message));
  }
}

/** A full collection on demand, so a `WeakRef` that still derefs is a result
 *  something still holds. */
function exposeGc(): () => void {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
}

describe("pickBest", () => {
  const args = parseArgs("walk-forward", [
    ...MINIMAL.slice(0, 4),
    "--from",
    "2025-06-04",
    "--to",
    "2025-06-06",
    "--playbook",
    "sweepable",
    "--warmup-days",
    "2",
  ]);
  const fold = {
    foldId: 0,
    train: { from: "2025-06-04", to: "2025-06-06" },
    test: { from: "2025-06-04", to: "2025-06-06" },
  };

  async function pick(workers: number, grid: Array<Record<string, number>>) {
    const finished: number[] = [];
    const pool = createWindowPool({
      workers,
      cpuTarget: 100,
      throttle: createCpuThrottle(100),
      forkWorker: () => new InProcessWorker(sweepable, finished, grid.length),
    });
    const best = await pickBest(args, sweepable, CONTRACT_SPECS.MNQ, RISING_BARS, fold, grid, 7, null, pool);
    pool.close();
    return { best, finished };
  }

  it("picks the same grid point at 3 workers as at 1", async () => {
    const grid = sweepGrid([parseSweepAxis("side=0:1:1"), parseSweepAxis("ignored=1:2:1")]);
    const one = await pick(1, grid);
    const three = await pick(3, grid);

    expect(one.best.constants).toEqual({ side: 0, ignored: 1 });
    expect(JSON.stringify(three.best)).toBe(JSON.stringify(one.best));
    expect(three.best.window.records[0].tradeId).toBe(7);
  });

  it("keeps the first grid point on a tie at 3 workers, though the last one finished first", async () => {
    const grid = sweepGrid([parseSweepAxis("ignored=1:3:1")]);
    const one = await pick(1, grid);
    const three = await pick(3, grid);

    expect(three.finished[0]).toBe(grid.length - 1);
    expect(one.best.constants).toEqual({ ignored: 1 });
    expect(three.best.constants).toEqual({ ignored: 1 });
    expect(JSON.stringify(three.best)).toBe(JSON.stringify(one.best));
  });

  it("holds only the incumbent between deliveries at 3 workers finishing in reverse, and picks the same point", async () => {
    const gc = exposeGc();
    // Six points over three workers: two rounds, each finishing last job first.
    const grid = sweepGrid([parseSweepAxis("side=0:1:1"), parseSweepAxis("ignored=1:3:1")]);
    const workers: HeldWorker[] = [];
    const inner = createWindowPool({
      workers: 3,
      cpuTarget: 100,
      throttle: createCpuThrottle(100),
      forkWorker: () => {
        const worker = new HeldWorker(sweepable);
        workers.push(worker);
        return worker;
      },
    });
    // A registry rather than WeakRefs, whose deref keeps a target alive to
    // the end of the job.
    let delivered = 0;
    let collected = 0;
    const registry = new FinalizationRegistry(() => {
      collected++;
    });
    const counting = {
      run: (source, jobs, onResult) =>
        inner.run(source, jobs, (i, result) => {
          delivered++;
          registry.register(result, i);
          onResult(i, result);
        }),
      close: inner.close,
    } satisfies WindowPool;
    const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
    const live = async () => {
      // Twice: `v8.deserialize` holds every object it built until a weak
      // callback frees its native deserializer, so a clone can only be
      // collected by the collection after that one. Cleanup callbacks then
      // run as their own task.
      gc();
      await nextTask();
      gc();
      await nextTask();
      return delivered - collected;
    };

    const picking = pickBest(args, sweepable, CONTRACT_SPECS.MNQ, RISING_BARS, fold, grid, 7, null, counting);
    const liveAfterRound: number[] = [];
    for (let round = 0; round < 2; round++) {
      await vi.waitFor(() => expect(workers.every((w) => w.held.length === 1)).toBe(true));
      for (const worker of [...workers].sort((a, b) => b.heldIndex - a.heldIndex)) worker.release();
      liveAfterRound.push(await live());
    }
    const best = await picking;
    inner.close();

    expect(delivered).toBe(grid.length);
    // The incumbent alone; the candidate under judgement makes two.
    expect(liveAfterRound).toEqual([1, 1]);
    const one = await pick(1, grid);
    expect(best.constants).toEqual({ side: 0, ignored: 1 });
    expect(JSON.stringify(best)).toBe(JSON.stringify(one.best));
  });
});
