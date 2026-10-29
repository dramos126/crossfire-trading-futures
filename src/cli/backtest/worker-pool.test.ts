import { EventEmitter } from "node:events";
import v8 from "node:v8";

import { describe, it, expect, vi } from "vitest";

import { CliError } from "./cli-error";
import { runWindow, type WindowResult } from "./run-window";
import { buildSummary } from "./summary";
import { createCpuThrottle } from "./throttle";
import {
  WorkerSignalled,
  createWindowPool,
  type FromWorker,
  type PoolJob,
  type ToWorker,
  type WindowJob,
  type WorkerChild,
} from "./worker-pool";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { LEGACY_DAY_SESSION, withCommonParams, type StrategyModule } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";

const FIVE_MINUTES_MS = 5 * 60_000;

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
  shouldEnter: () => ({ side: 0, slTicks: 8, tpTicks: 16 }),
  shouldExit: () => true,
} satisfies StrategyModule;

function barsFor(sessionDates: string[]): BarData[] {
  return sessionDates.flatMap((date) => {
    const open = new Date(`${date}T13:30:00.000Z`).getTime();
    return Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(open + i * FIVE_MINUTES_MS).toISOString(),
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100 + (i % 3),
      volume: 10,
    }));
  });
}

const BARS = barsFor(["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05", "2025-06-06"]);
const SOURCE = { strategy: alwaysEnters, allBars: BARS, labels: null };

function job(from: string, to: string, foldId: number): WindowJob {
  return {
    from,
    to,
    warmupDays: 2,
    tickSize: 0.25,
    tickValue: 0.5,
    daySession: CONTRACT_SPECS.MNQ.daySession,
    feePerSideUsd: 0,
    paramOverrides: { timeframe: "5m" },
    sizing: { mode: "fixed", contracts: 1 },
    dailyLossUsd: null,
    dailyProfitUsd: null,
    foldId,
    sample: "test",
    tradeIdStart: 1,
    regimes: null,
  };
}

const JOBS: PoolJob[] = [
  { label: "fold 0", job: job("2025-06-04", "2025-06-04", 0) },
  { label: "fold 1", job: job("2025-06-05", "2025-06-05", 1) },
  { label: "fold 2", job: job("2025-06-06", "2025-06-06", 2) },
  { label: "fold 3", job: job("2025-06-04", "2025-06-06", 3) },
];

/** A stand-in result, tagged so the order it lands in is visible. */
function tagged(tag: string): WindowResult {
  return {
    records: [],
    keptBacktestTrades: [],
    skips: [],
    sessions: [],
    summary: buildSummary({ records: [], backtestTrades: [], sessions: [] }),
    warmupFrom: tag,
    barCount: 0,
    firstBarTs: null,
    lastBarTs: null,
    resolvedParams: {},
    warnings: [],
  };
}

/** What crossing an `advanced`-serialization IPC channel does to a message. */
function overIpc<T>(message: T): T {
  return v8.deserialize(v8.serialize(message)) as T;
}

/** A worker the test answers by hand, in whatever order it likes. Messages
 *  both ways are structured-cloned, as the real channel clones them. */
class ManualWorker extends EventEmitter implements WorkerChild {
  readonly sent: ToWorker[] = [];
  killed = false;
  send(message: ToWorker): boolean {
    this.sent.push(overIpc(message));
    return true;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** The index of the job it was last handed. */
  get current(): number {
    const last = this.sent[this.sent.length - 1];
    if (last.type !== "job") throw new Error("no job sent");
    return last.index;
  }
  reply(message: FromWorker): void {
    this.emit("message", overIpc(message));
  }
  answer(tag = `r${this.current}`): void {
    this.reply({ type: "result", index: this.current, result: tagged(tag), cpuMs: 0 });
  }
}

function manualPool(workers: number) {
  const children: ManualWorker[] = [];
  const throttle = createCpuThrottle(100, { cpuMs: () => 0, wallMs: () => 1_000 });
  const pool = createWindowPool({
    workers,
    cpuTarget: 100,
    throttle,
    forkWorker: () => {
      const child = new ManualWorker();
      children.push(child);
      return child;
    },
  });
  return { pool, children, throttle };
}

/** Records each delivery's index and tag, in delivery order. */
function recorder() {
  const delivered: Array<[number, string]> = [];
  const onResult = (i: number, r: WindowResult) => {
    delivered.push([i, r.warmupFrom]);
  };
  return { delivered, onResult };
}

describe("createWindowPool at one worker", () => {
  it("never forks, and hands each job's runWindow result back in order", async () => {
    const forkWorker = vi.fn((): WorkerChild => new ManualWorker());
    const throttle = createCpuThrottle(100);
    const pool = createWindowPool({ workers: 1, cpuTarget: 100, throttle, forkWorker });

    const results: WindowResult[] = [];
    await pool.run(SOURCE, JOBS, (i, r) => {
      expect(i).toBe(results.length);
      results.push(r);
    });

    expect(forkWorker).not.toHaveBeenCalled();
    expect(throttle.report().workers).toBe(1);
    const direct = await Promise.all(
      JOBS.map(({ job: j }) => runWindow({ ...j, strategy: alwaysEnters, allBars: BARS, labels: null })),
    );
    expect(JSON.stringify(results)).toBe(JSON.stringify(direct));
    expect(results[0].records.length).toBeGreaterThan(0);
  });
});

describe("createWindowPool with forked workers", () => {
  it("forks no more workers than the batch has jobs, and sends each the bars and labels once", async () => {
    const { pool, children, throttle } = manualPool(3);
    const { onResult } = recorder();
    const run = pool.run(SOURCE, JOBS.slice(0, 2), onResult);

    expect(children).toHaveLength(2);
    expect(throttle.report().workers).toBe(2);
    for (const child of children) {
      expect(child.sent[0]).toEqual({
        type: "init",
        playbook: "always-enters",
        cpuTarget: 100,
        allBars: BARS,
        labels: null,
      });
      child.answer();
    }
    await run;

    const again = pool.run(SOURCE, JOBS.slice(0, 1), onResult);
    expect(children).toHaveLength(2);
    expect(children[0].sent.filter((m) => m.type === "init")).toHaveLength(1);
    children[0].answer();
    await again;
  });

  it("forks nothing until a batch arrives, so a run with no fan-out reports one worker", () => {
    const { children, throttle } = manualPool(6);
    expect(children).toHaveLength(0);
    expect(throttle.report().workers).toBe(1);
  });

  it("forks up to the worker count when a later batch is larger", async () => {
    const { pool, children, throttle } = manualPool(3);
    const { onResult } = recorder();
    const first = pool.run(SOURCE, JOBS.slice(0, 1), onResult);
    children[0].answer();
    await first;

    const second = pool.run(SOURCE, JOBS, onResult);
    expect(children).toHaveLength(3);
    expect(throttle.report().workers).toBe(3);
    expect(children[2].sent[0]).toMatchObject({ type: "init", allBars: BARS });
    for (const child of children) child.answer();
    children[0].answer();
    await second;
  });

  it("delivers in job order, holding back only the results that arrive early", async () => {
    const { pool, children } = manualPool(2);
    const { delivered, onResult } = recorder();
    const run = pool.run(SOURCE, JOBS, onResult);
    const [w0, w1] = children;
    expect([w0.current, w1.current]).toEqual([0, 1]);

    // Job 1 finishes first and its worker takes 2, then 3; job 0 is last.
    w1.answer();
    expect(w1.current).toBe(2);
    w1.answer();
    expect(w1.current).toBe(3);
    w1.answer();
    expect(delivered).toEqual([]);

    w0.answer();
    await run;
    expect(delivered).toEqual([
      [0, "r0"],
      [1, "r1"],
      [2, "r2"],
      [3, "r3"],
    ]);
  });

  it("delivers a result at once when every earlier one is in", async () => {
    const { pool, children } = manualPool(2);
    const { delivered, onResult } = recorder();
    const run = pool.run(SOURCE, JOBS.slice(0, 2), onResult);
    children[0].answer();
    expect(delivered).toEqual([[0, "r0"]]);
    children[1].answer();
    await run;
    expect(delivered).toEqual([
      [0, "r0"],
      [1, "r1"],
    ]);
  });

  it("refuses with a CliError naming the job when a worker exits before returning it", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS, () => {});
    children[1].emit("exit", 1, null);

    await expect(run).rejects.toThrow(CliError);
    await expect(run).rejects.toThrow('window worker exited (code 1) before returning job "fold 1"');
  });

  it("marks a worker lost to SIGTERM or SIGINT with the signal, so main can exit as the parent's own signal", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const { pool, children } = manualPool(2);
      const run = pool.run(SOURCE, JOBS, () => {});
      children[0].emit("exit", null, signal);

      const err = await run.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkerSignalled);
      expect((err as WorkerSignalled).signal).toBe(signal);
    }
  });

  it("does not mark a worker lost to SIGKILL, which the parent is never handling", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS, () => {});
    children[0].emit("exit", null, "SIGKILL");

    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).not.toBeInstanceOf(WorkerSignalled);
  });

  it("refuses every later batch once a worker is lost, rather than hanging on it", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS.slice(0, 2), () => {});
    for (const child of children) child.answer("ok");
    await run;
    children[0].emit("exit", null, "SIGKILL");

    await expect(pool.run(SOURCE, JOBS, () => {})).rejects.toThrow(
      "window worker exited (SIGKILL) between jobs",
    );
  });

  it("carries a worker's refusal back as the same CliError", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS, () => {});
    children[0].reply({ type: "failure", index: 0, message: "Unknown playbook", stack: null, cliError: true });

    await expect(run).rejects.toThrow(CliError);
    await expect(run).rejects.toThrow("Unknown playbook");
  });

  it("carries a worker's defect back with the worker's stack alone, so main prints one", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS, () => {});
    const workerStack = "TypeError: boom\n    at runWindow (run-window.ts:1:1)";
    children[0].reply({ type: "failure", index: 0, message: "boom", stack: workerStack, cliError: false });

    const err = await run.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CliError);
    expect((err as Error).message).toBe("boom");
    expect((err as Error).stack).toBe(workerStack);
  });

  it("rejects the batch when the caller's onResult throws, rather than crashing the emitter", async () => {
    const { pool, children } = manualPool(2);
    const run = pool.run(SOURCE, JOBS.slice(0, 2), () => {
      throw new CliError("every grid point traded nothing");
    });
    children[0].answer();

    await expect(run).rejects.toThrow("every grid point traded nothing");
  });

  it("credits each worker's CPU to the parent's report once, by delta", async () => {
    const { pool, children, throttle } = manualPool(2);
    const run = pool.run(SOURCE, JOBS, () => {});
    const [w0, w1] = children;
    // Cumulative per worker: w1 reports 500 then 1500, w0 reports 2000.
    w1.reply({ type: "result", index: w1.current, result: tagged("a"), cpuMs: 500 });
    w1.reply({ type: "result", index: w1.current, result: tagged("b"), cpuMs: 1_500 });
    w1.reply({ type: "result", index: w1.current, result: tagged("c"), cpuMs: 1_500 });
    w0.reply({ type: "result", index: w0.current, result: tagged("d"), cpuMs: 2_000 });
    await run;

    // 3500ms of worker CPU over 1000ms of parent wall, the parent itself idle.
    expect(throttle.report()).toEqual({ targetPct: 100, workers: 2, achievedPct: 350 });
  });

  it("kills every worker on close, and a worker exiting after close is not an error", async () => {
    const { pool, children } = manualPool(3);
    const run = pool.run(SOURCE, JOBS.slice(0, 3), () => {});
    for (const child of children) child.answer("ok");
    await run;

    pool.close();
    pool.close();
    expect(children.map((c) => c.killed)).toEqual([true, true, true]);
    for (const child of children) child.emit("exit", null, "SIGTERM");
    await expect(pool.run(SOURCE, JOBS, () => {})).rejects.toThrow("window pool is closed");
  });
});
