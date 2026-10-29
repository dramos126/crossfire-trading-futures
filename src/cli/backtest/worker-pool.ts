/**
 * A pool of forked window workers for the windows of one command that do not
 * depend on each other — `walk-forward`'s sweep and `lift`'s fold loop.
 *
 * **Processes, not threads**, for the two reasons in `throttle.ts`: the CPU
 * cap reads `process.cpuUsage()`, which is process-wide, and `os.setPriority`
 * is per process. Each worker holds its own throttle at the run's target.
 *
 * **Results are handed to `onResult` strictly in job order, whatever order
 * the workers finish in.** That is what makes a run at N workers write the
 * same files as a run at 1. Only a result that arrives before an earlier one
 * is held back, so a caller that keeps one result and drops the rest — the
 * sweep — never has the whole batch alive at once.
 *
 * At one worker nothing forks: the jobs run here, in order, through the same
 * `runWindow` call the commands always made.
 */
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BarData } from "@/lib/brokers/types";
import type { StrategyModule } from "@/lib/trading/strategy-types";
import { CliError } from "./cli-error";
import type { LabelIndex } from "./regime-labels";
import { runWindow, type RunWindowArgs, type WindowResult } from "./run-window";
import type { CpuThrottle, WorkerCpuSink } from "./throttle";

/** What every job of one pool shares, which crosses the IPC channel once per
 *  worker rather than once per job. A pool serves one bar series. */
export interface WindowSource {
  strategy: StrategyModule;
  allBars: BarData[];
  /** The 1m bars `allBars` was aggregated from, absent on a 1m series. */
  subBars?: BarData[];
  labels: LabelIndex | null;
}

export type WindowJob = Omit<RunWindowArgs, keyof WindowSource | "onProgress">;

export interface PoolJob {
  /** Names the job in a failure — which fold, which grid point. */
  label: string;
  job: WindowJob;
}

export type OnResult = (index: number, result: WindowResult) => void;

export type ToWorker =
  | {
      type: "init";
      playbook: string;
      cpuTarget: number;
      allBars: BarData[];
      subBars?: BarData[];
      labels: LabelIndex | null;
    }
  | { type: "job"; index: number; job: WindowJob };

export type FromWorker =
  | { type: "result"; index: number; result: WindowResult; cpuMs: number }
  | {
      type: "failure";
      index: number;
      message: string;
      /** The worker's own stack for a defect; null for a refusal. */
      stack: string | null;
      cliError: boolean;
    };

/** The slice of `ChildProcess` the pool uses, so a test can stand in for it. */
export interface WorkerChild {
  send(message: ToWorker): boolean;
  kill(): boolean;
  on(event: "message", listener: (message: FromWorker) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type ForkWorker = () => WorkerChild;

export interface WindowPool {
  /** Resolves once every job's result has been handed to `onResult`. */
  run(source: WindowSource, jobs: PoolJob[], onResult: OnResult): Promise<void>;
  /** Idempotent; safe from a process `exit` handler. */
  close(): void;
}

export interface WindowPoolOptions {
  workers: number;
  cpuTarget: number;
  throttle: CpuThrottle & WorkerCpuSink;
  forkWorker?: ForkWorker;
}

/**
 * The signals `main` handles. A terminal ^C or a `kill` of the process group
 * reaches every worker as well as the parent, and a worker's `exit` can be
 * seen before the parent's own handler runs.
 */
const PARENT_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM"]);

/** A worker lost to a signal the parent also handles: `main` lets the
 *  parent's own handler end the run, rather than reporting a failure. */
export class WorkerSignalled extends CliError {
  constructor(
    message: string,
    readonly signal: NodeJS.Signals,
  ) {
    super(message);
    this.name = "WorkerSignalled";
  }
}

/** Tells the forked entry it is a worker, so importing the module in a test
 *  process that also has an IPC channel never wires it to `process`. */
export const WORKER_ARG = "--window-worker";

const WORKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "window-worker.ts");

/**
 * `--import tsx` so the worker resolves `@/*` and `.ts` as `main.ts` does
 * under `corepack yarn backtest`; `advanced` so bars and results cross as a
 * structured clone — JSON would turn a summary's `Infinity` into `null`.
 */
export const forkWindowWorker: ForkWorker = () =>
  fork(WORKER_ENTRY, [WORKER_ARG], {
    execArgv: ["--import", "tsx"],
    serialization: "advanced",
  }) as WorkerChild;

export function createWindowPool(opts: WindowPoolOptions): WindowPool {
  if (opts.workers <= 1) return inProcessPool(opts.throttle);
  return forkedPool(opts);
}

function inProcessPool(throttle: CpuThrottle): WindowPool {
  return {
    run: async (source, jobs, onResult) => {
      for (const [i, { job }] of jobs.entries()) {
        onResult(i, await runWindow({ ...job, ...source, onProgress: throttle.onProgress }));
      }
    },
    close: () => {},
  };
}

interface Slot {
  child: WorkerChild;
  /** Index into the current batch's jobs, or null when idle. */
  busy: number | null;
  /** The worker's cumulative CPU as last reported, so each report credits
   *  only its delta. */
  cpuMs: number;
}

interface Batch {
  jobs: PoolJob[];
  onResult: OnResult;
  /** Results that came back before an earlier job's, by index. */
  early: Map<number, WindowResult>;
  /** The next index to dispatch, and the next to hand to `onResult`. */
  next: number;
  delivered: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

function forkedPool(opts: WindowPoolOptions): WindowPool {
  const forkWorker = opts.forkWorker ?? forkWindowWorker;
  const slots: Slot[] = [];
  let source: WindowSource | null = null;
  let batch: Batch | null = null;
  /** Set once a worker is lost; every later `run` refuses with it. */
  let broken: Error | null = null;
  let closed = false;

  const fail = (err: Error) => {
    broken ??= err;
    const current = batch;
    batch = null;
    current?.reject(err);
  };

  const dispatch = (slot: Slot) => {
    if (batch === null || batch.next >= batch.jobs.length) return;
    const index = batch.next++;
    slot.busy = index;
    slot.child.send({ type: "job", index, job: batch.jobs[index].job });
  };

  /** Hands over every result now contiguous with those already delivered. */
  const deliver = (current: Batch) => {
    for (;;) {
      const result = current.early.get(current.delivered);
      if (result === undefined) return;
      current.early.delete(current.delivered);
      current.onResult(current.delivered, result);
      current.delivered++;
    }
  };

  const onMessage = (slot: Slot, message: FromWorker) => {
    const current = batch;
    slot.busy = null;
    if (message.type === "failure") {
      fail(failureError(message));
      return;
    }
    opts.throttle.addWorkerCpuMs(message.cpuMs - slot.cpuMs);
    slot.cpuMs = message.cpuMs;
    if (current === null) return;
    current.early.set(message.index, message.result);
    try {
      deliver(current);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (current.delivered === current.jobs.length) {
      batch = null;
      current.resolve();
      return;
    }
    dispatch(slot);
  };

  const onLost = (slot: Slot, why: string, signal: string | null) => {
    if (closed) return;
    const job = slot.busy !== null && batch !== null ? batch.jobs[slot.busy].label : null;
    const message =
      job !== null
        ? `window worker ${why} before returning job "${job}"`
        : `window worker ${why} between jobs`;
    fail(
      signal !== null && PARENT_SIGNALS.has(signal)
        ? new WorkerSignalled(message, signal as NodeJS.Signals)
        : new CliError(message),
    );
  };

  const spawn = (from: WindowSource): Slot => {
    // A worker finds the module by the key the loader stamped on it.
    const playbook = from.strategy.key;
    if (playbook == null) throw new Error("a pooled playbook needs the loader's key");
    const slot: Slot = { child: forkWorker(), busy: null, cpuMs: 0 };
    slot.child.on("message", (message) => onMessage(slot, message));
    slot.child.on("exit", (code, signal) =>
      onLost(slot, `exited (${signal ?? `code ${code}`})`, signal),
    );
    slot.child.on("error", (err) => onLost(slot, `failed (${err.message})`, null));
    slot.child.send({
      type: "init",
      playbook,
      cpuTarget: opts.cpuTarget,
      allBars: from.allBars,
      ...(from.subBars == null ? {} : { subBars: from.subBars }),
      labels: from.labels,
    });
    opts.throttle.addWorker();
    return slot;
  };

  return {
    run: (next, jobs, onResult) => {
      if (closed) return Promise.reject(new Error("window pool is closed"));
      if (broken) return Promise.reject(broken);
      if (batch !== null) return Promise.reject(new Error("window pool is already running a batch"));
      if (source === null) source = next;
      else if (
        next.allBars !== source.allBars ||
        next.subBars !== source.subBars ||
        next.labels !== source.labels
      ) {
        return Promise.reject(new Error("a window pool serves the one bar series it started with"));
      }
      if (jobs.length === 0) return Promise.resolve();
      // A worker with no job would still load the playbook and every bar.
      const wanted = Math.min(opts.workers, jobs.length);
      while (slots.length < wanted) slots.push(spawn(source));
      return new Promise<void>((resolve, reject) => {
        batch = { jobs, onResult, early: new Map(), next: 0, delivered: 0, resolve, reject };
        for (const slot of slots) dispatch(slot);
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const slot of slots) slot.child.kill();
    },
  };
}

/** A refusal keeps its sentence; a defect keeps the worker's stack as its
 *  own, so `main` prints that one stack rather than this frame's on top. */
function failureError(message: Extract<FromWorker, { type: "failure" }>): Error {
  if (message.cliError) return new CliError(message.message);
  const err = new Error(message.message);
  if (message.stack !== null) err.stack = message.stack;
  return err;
}
