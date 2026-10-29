/**
 * The forked side of `worker-pool.ts`: one process that loads the playbook
 * once, takes the run's bars once, then runs windows one job at a time.
 *
 * It holds its own CPU throttle at the run's target and lowers its own
 * priority, because both are per process. It ignores `SIGINT` — a terminal
 * ^C reaches the whole process group, and the parent is the one that decides
 * how a run ends and closes the pool — and exits when the parent's IPC
 * channel goes, so a parent killed outright leaves no worker behind.
 */
import { loadStrategiesNode } from "@/lib/trading/strategies/load-node";
import type { StrategyModule } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";
import { CliError } from "./cli-error";
import type { LabelIndex } from "./regime-labels";
import { runWindow } from "./run-window";
import {
  createCpuThrottle,
  createJobClock,
  lowerProcessPriority,
  processClock,
  type CpuThrottle,
  type ProcessClock,
} from "./throttle";
import { WORKER_ARG, type FromWorker, type ToWorker } from "./worker-pool";

export interface WorkerDeps {
  loadStrategy: (playbook: string) => Promise<StrategyModule>;
  /** The process's own clock. The throttle is handed a view of it whose wall
   *  time runs only while a job does. */
  clock: ProcessClock;
  createThrottle: (cpuTarget: number, clock: ProcessClock) => CpuThrottle;
  send: (message: FromWorker) => void;
}

interface WorkerState {
  strategy: StrategyModule;
  allBars: BarData[];
  subBars?: BarData[];
  labels: LabelIndex | null;
  throttle: CpuThrottle;
}

/** The worker's whole behaviour, separate from `process` so a test can drive
 *  it through a fake child. */
export function createWorkerHandler(deps: WorkerDeps): (message: ToWorker) => void {
  let state: Promise<WorkerState> | null = null;
  // Jobs run one after another even if the pool ever sends two, so the
  // throttle's sleeps are never shared between overlapping windows.
  let queue: Promise<void> = Promise.resolve();
  // Idle between jobs — the parent running a fold's base and held-out
  // windows — would otherwise be banked as credit by a duty cycle measured
  // from process start, and spent running the next sweep flat out.
  const jobClock = createJobClock(deps.clock);

  return (message) => {
    if (message.type === "init") {
      const { playbook, cpuTarget, allBars, subBars, labels } = message;
      state = deps.loadStrategy(playbook).then((strategy) => ({
        strategy,
        allBars,
        subBars,
        labels,
        throttle: deps.createThrottle(cpuTarget, jobClock),
      }));
      // A load failure surfaces on the first job, which is what names it.
      state.catch(() => {});
      return;
    }
    const ready = state;
    const { index, job } = message;
    queue = queue.then(async () => {
      try {
        if (ready === null) throw new Error("window worker received a job before init");
        const { strategy, allBars, subBars, labels, throttle } = await ready;
        jobClock.jobStarted();
        const result = await runWindow({
          ...job,
          strategy,
          allBars,
          subBars,
          labels,
          onProgress: throttle.onProgress,
        }).finally(jobClock.jobEnded);
        deps.send({ type: "result", index, result, cpuMs: deps.clock.cpuMs() });
      } catch (err) {
        deps.send(failure(index, err));
      }
    });
  };
}

/** A refusal is its sentence alone; a defect also carries its stack, which
 *  the parent adopts so `main` prints the worker's stack and only that. */
function failure(index: number, err: unknown): FromWorker {
  const cliError = err instanceof CliError;
  if (err instanceof Error) {
    return { type: "failure", index, message: err.message, stack: cliError ? null : err.stack ?? null, cliError };
  }
  return { type: "failure", index, message: String(err), stack: null, cliError };
}

/** The same loader `resolvePlaybook` uses, test fixtures included. */
async function loadPlaybook(playbook: string): Promise<StrategyModule> {
  const found = (await loadStrategiesNode({ includeTest: true }))[playbook];
  if (!found) throw new CliError(`window worker: unknown playbook "${playbook}"`);
  return found;
}

function runAsWorker(): void {
  lowerProcessPriority();
  process.on("SIGINT", () => {});
  process.on("disconnect", () => process.exit(0));
  const handle = createWorkerHandler({
    loadStrategy: loadPlaybook,
    clock: processClock,
    createThrottle: (cpuTarget, clock) => createCpuThrottle(cpuTarget, clock),
    send: (message) => {
      process.send?.(message);
    },
  });
  process.on("message", (message) => handle(message as ToWorker));
}

if (process.argv.includes(WORKER_ARG)) runAsWorker();
