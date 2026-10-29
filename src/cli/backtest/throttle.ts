/**
 * The CLI's self-imposed CPU cap — **per process**.
 *
 * A window is a single-threaded loop with nothing to wait on, so each process
 * running one takes a whole core for as long as it runs. The parent measures
 * the duty cycle **from process start** — `walk-forward` and `lift` call
 * `runBacktest` once per fold and once per sweep point, and a cap that reset
 * per window would let the invocation as a whole run flat out. A worker
 * measures it over **the wall time it spent running jobs** ({@link
 * createJobClock}): it idles while the parent runs a fold's own windows, and
 * idle time counted as wall would be banked as credit and spent running a
 * whole sweep flat out.
 *
 * The parent and every forked window worker hold their own throttle at the
 * same target. That is why the workers are processes and not threads:
 * `process.cpuUsage()` is process-wide, so a parent thread measuring itself
 * would see every worker thread's CPU and sleep the whole run to a crawl.
 *
 * The arithmetic is deliberately cumulative rather than windowed: it is a
 * debt, so a burst that overshoots is repaid by the next sleeps instead of
 * being forgotten at a window boundary.
 */
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

/** A target of 100 asks for no throttling at all, not a 100% duty cycle. */
export const NO_THROTTLE_PCT = 100;

/**
 * Longest single pause. The debt is cumulative, so a cap only spreads a
 * correction across calls — it never forgives one — and a multi-second stall
 * on a CLI with no output reads as a hang.
 */
const MAX_SLEEP_MS = 2_000;

const MICROS_PER_MS = 1_000;
const MS_PER_SECOND = 1_000;

export interface CpuReport {
  targetPct: number;
  /** Worker processes actually forked; 1 when none were and the parent ran
   *  every window itself. */
  workers: number;
  /** CPU used by the parent and every worker over the parent's wall time, so
   *  a figure above 100 reads as cores used. */
  achievedPct: number;
}

export interface CpuThrottle {
  /**
   * Shaped as `runBacktest`'s `onProgress`; the bar counters are not read.
   * The bar loop awaits it, which is what makes the sleep effective. It
   * throttles this process only — a worker's CPU never makes the parent sleep.
   */
  onProgress: () => Promise<void>;
  report: () => CpuReport;
}

/** The parent's half, which the window pool feeds: each worker it forks, and
 *  the CPU a worker reports, credited to {@link CpuThrottle.report} and never
 *  to the sleep. */
export interface WorkerCpuSink {
  addWorker: () => void;
  addWorkerCpuMs: (ms: number) => void;
}

export interface ProcessClock {
  cpuMs: () => number;
  wallMs: () => number;
}

/** A clock whose wall time runs only between {@link jobStarted} and
 *  {@link jobEnded}; CPU is still the process's own. */
export interface JobClock extends ProcessClock {
  jobStarted: () => void;
  jobEnded: () => void;
}

/**
 * Milliseconds to sleep so that `cpuMs / (wallMs + sleep)` lands at or below
 * `targetPct`. Zero when the run is already under target.
 */
export function throttleSleepMs(cpuMs: number, wallMs: number, targetPct: number): number {
  if (targetPct >= NO_THROTTLE_PCT) return 0;
  const owed = (cpuMs * NO_THROTTLE_PCT) / targetPct - wallMs;
  if (!(owed > 0)) return 0;
  return Math.min(owed, MAX_SLEEP_MS);
}

export function achievedPct(cpuMs: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return (cpuMs * NO_THROTTLE_PCT) / wallMs;
}

export function formatCpuReport(report: CpuReport): string {
  return (
    `cpu: target ${report.targetPct}%, workers ${report.workers}, ` +
    `achieved ${Math.round(report.achievedPct)}%`
  );
}

export function createCpuThrottle(
  targetPct: number,
  clock: ProcessClock = processClock,
): CpuThrottle & WorkerCpuSink {
  let workers = 0;
  let workerCpuMs = 0;
  return {
    onProgress: async () => {
      const ms = throttleSleepMs(clock.cpuMs(), clock.wallMs(), targetPct);
      if (ms > 0) await sleep(ms);
    },
    addWorker: () => {
      workers++;
    },
    addWorkerCpuMs: (ms) => {
      workerCpuMs += ms;
    },
    report: () => ({
      targetPct,
      workers: Math.max(1, workers),
      achievedPct: achievedPct(clock.cpuMs() + workerCpuMs, clock.wallMs()),
    }),
  };
}

export function createJobClock(base: ProcessClock = processClock): JobClock {
  let bankedMs = 0;
  let startedAt: number | null = null;
  const running = () => (startedAt === null ? 0 : base.wallMs() - startedAt);
  return {
    cpuMs: base.cpuMs,
    wallMs: () => bankedMs + running(),
    jobStarted: () => {
      startedAt = base.wallMs();
    },
    jobEnded: () => {
      bankedMs += running();
      startedAt = null;
    },
  };
}

/** Both halves: a backtest's own work is user time, and reading the Parquet
 *  cache is system time. Capping one of them caps nothing. */
export function processCpuMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / MICROS_PER_MS;
}

export const processClock: ProcessClock = {
  cpuMs: processCpuMs,
  wallMs: () => process.uptime() * MS_PER_SECOND,
};

/** Nice the process so whatever else the box runs wins a contended slice.
 *  Some platforms refuse the call outright; the throttle is the real cap. */
export function lowerProcessPriority(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
  } catch {
    process.stderr.write("could not lower process priority; the CPU target still applies\n");
  }
}
