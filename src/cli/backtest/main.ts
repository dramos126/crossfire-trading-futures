/**
 * `corepack yarn backtest <command> [flags]`.
 *
 * The trader's calibration surface: bars from the Databento Parquet cache
 * and, by default, nothing else. Two paths opt into more: `run --topstep-tail`
 * logs in to Topstep for the bars past the archive, and `parity-day` does the
 * same and reads a private copy of a trading-database snapshot. Neither opens
 * the operator's database for writing. It lives under `src/cli/` rather than
 * `scripts/` because it imports `runBacktest` and the strategy modules
 * themselves — the same hooks the engine runs, which is the only reason a
 * backtest number means anything — and `scripts/` may not import from
 * `src/`. Nothing in the app imports this tree and it never ships in the
 * image.
 */
import os from "node:os";

import { COMMANDS, parseArgs, parseCommand, type CliArgs, type Command } from "./args";
import { bookCommand, parseBookArgs } from "./commands/book-command";
import { CliError } from "./cli-error";
import { loadStrategiesNode } from "@/lib/trading/strategies/load-node";
import { compareCommand } from "./commands/compare-command";
import { labelsCommand } from "./commands/labels-command";
import { liftCommand } from "./commands/lift-command";
import { parseParityArgs } from "./parity/parity-day";
import { parityDayCommand } from "./parity/parity-day-command";
import { parityReportCommand, parseParityReportArgs } from "./parity/parity-report";
import { playbookNames } from "./playbook-label";
import {
  assertCrossTimeframeExitMeasurable,
  assertInstrumentCalibrated,
  assertSessionMeasurable,
  assertSettingsTakeEntries,
  assertWarmupCoversDeclaredSessions,
  resolveExecutedParamSets,
} from "./params";
import { daySessionForTicker } from "@/lib/trading/contracts/contract-specs";
import { runCommand } from "./commands/run-command";
import { sweepGrid, walkForwardCommand } from "./commands/walk-forward-command";
import {
  acquireRunLock,
  nodeLockFs,
  pidIsAlive,
  releaseRunLock,
  runLockFile,
} from "./run-lock";
import {
  createCpuThrottle,
  formatCpuReport,
  lowerProcessPriority,
  type CpuThrottle,
  type WorkerCpuSink,
} from "./throttle";
import { WorkerSignalled, createWindowPool, type WindowPool } from "./worker-pool";
import type { StrategyModule } from "@/lib/trading/strategy-types";

/** The shell's convention for "killed by signal N". */
const SIGNAL_EXIT_BASE = 128;
/** How long a worker lost to SIGINT/SIGTERM waits for the parent's own
 *  handler of that signal. Both arrive in the same instant; this is slack
 *  for the event loop, not for a sender. */
const PARENT_SIGNAL_GRACE_MS = 500;

async function main(argv: string[]): Promise<void> {
  const command = parseCommand(argv);
  // `compare` reads two finished artifacts and no bars, so it shares none of
  // the flags every other command requires — including the CPU cap, which
  // has nothing to cap.
  if (command === "compare") {
    process.stdout.write(`${await compareCommand(argv.slice(1))}\n`);
    return;
  }
  // Reads a parity record off disk and writes HTML: no bars, so no lock or
  // cap. The registry is loaded only to name the playbooks.
  if (command === "parity-report") {
    const reportArgs = parseParityReportArgs(argv.slice(1));
    const playbooks = playbookNames(await loadStrategiesNode({ includeTest: true }));
    process.stdout.write(`${parityReportCommand(reportArgs, playbooks)}\n`);
    return;
  }
  // Its own flags, but the same lock and CPU cap as `run`, because it is a
  // sequence of runs.
  if (command === "parity-day") {
    const parity = parseParityArgs(argv.slice(1), new Date());
    const throttle = startThrottledRun(parity.cpuTarget);
    await writeAndExit(await parityDayCommand(parity, throttle));
    return;
  }
  // Its own flags too: the book comes off the snapshot, not off --playbook.
  if (command === "book") {
    const book = parseBookArgs(argv.slice(1));
    const throttle = startThrottledRun(book.cpuTarget);
    await writeAndExit(await bookCommand(book, throttle));
    return;
  }

  const args = parseArgs(command, argv.slice(1));
  const throttle = startThrottledRun(args.cpuTarget);
  const pool = createWindowPool({ workers: args.workers, cpuTarget: args.cpuTarget, throttle });
  releaseOnExit(pool.close);
  // Closed as soon as the command returns, not only on `exit`: an idle
  // worker's IPC channel keeps the event loop alive, so `exit` would never
  // come and a finished run would hang.
  let out: string;
  try {
    out = await dispatch(command, args, throttle, pool);
  } finally {
    pool.close();
  }
  if (args.topstepTail) {
    await writeAndExit(out);
    return;
  }
  process.stdout.write(`${out}\n`);
}

function startThrottledRun(cpuTarget: number): CpuThrottle & WorkerCpuSink {
  takeRunLock();
  lowerProcessPriority();
  const throttle = createCpuThrottle(cpuTarget);
  // stderr, not stdout: stdout is the run directory and nothing else, so a
  // caller can still capture it.
  process.on("exit", () => {
    process.stderr.write(`${formatCpuReport(throttle.report())}\n`);
  });
  return throttle;
}

/**
 * Exit explicitly once stdout has flushed. A run that opened the Topstep
 * stack holds an open database and the broker plugin's handles, and the event
 * loop may never drain — an unattended task would hang instead of finishing.
 */
function writeAndExit(out: string): Promise<void> {
  return new Promise(() => {
    process.stdout.write(`${out}\n`, () => process.exit());
  });
}

async function dispatch(
  command: Command,
  args: CliArgs,
  throttle: CpuThrottle,
  pool: WindowPool,
): Promise<string> {
  switch (command) {
    case "labels":
      return labelsCommand(args, throttle);
    case "run":
      return runCommand(args, await resolvePlaybook(args), throttle);
    case "walk-forward":
      return walkForwardCommand(args, await resolvePlaybook(args), throttle, pool);
    case "lift":
      return liftCommand(args, await resolvePlaybook(args), throttle, pool);
    default:
      throw new CliError(`Unhandled command "${command}". Expected one of: ${COMMANDS.join(", ")}`);
  }
}

/** One run per machine. */
function takeRunLock(): void {
  const lock = { file: runLockFile(), pid: process.pid, fs: nodeLockFs() };
  acquireRunLock({ ...lock, isAlive: pidIsAlive });
  releaseOnExit(() => releaseRunLock(lock));
}

/** What a run holds that must not outlive it: the run lock and the window
 *  workers. Each release is idempotent. */
const releases: Array<() => void> = [];

/**
 * Released on a normal exit and on a signal, so a ^C leaves neither a lock
 * nor an orphan worker. The signal handlers re-raise rather than swallowing:
 * an operator's ^C must still look like a ^C to whatever launched the run.
 *
 * In reverse registration order, so the workers are killed before the lock
 * that says a run is in progress is given up.
 */
function releaseOnExit(release: () => void): void {
  if (releases.length === 0) {
    const releaseAll = () => {
      for (const r of [...releases].reverse()) r();
    };
    process.on("exit", releaseAll);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        releaseAll();
        process.exit(SIGNAL_EXIT_BASE + os.constants.signals[signal]);
      });
    }
  }
  releases.push(release);
}

/**
 * `includeTest: true` — the test fixtures are candidates for the measured
 * re-evaluation pass, so the CLI must be able to run them. Nothing here can
 * place an order, which is what makes that safe.
 */
async function resolvePlaybook(args: CliArgs): Promise<StrategyModule> {
  const key = args.playbook;
  if (key == null) throw new CliError("Missing required flag --playbook");
  const strategies = await loadStrategiesNode({ includeTest: true });
  const found = strategies[key];
  if (!found) {
    throw new CliError(
      `Unknown playbook "${key}". Available: ${Object.keys(strategies).sort().join(", ")}`,
    );
  }
  // Before any bars are read: an instrument the playbook was never calibrated
  // for is a number about a different market, a session the flags cannot
  // express is a zero-trade run wearing a measurement's name, and so is a
  // warmup too short for the sessions the module declared. The instrument goes
  // first because it needs no params at all.
  assertInstrumentCalibrated(found, args.ticker, args.crossInstrument);

  // The base constants plus every sweep point, because a swept param can move
  // the declaration: the axis maximum of `--sweep atrPeriod=10:40:10` needs
  // thirty sessions more than the default the base set asserts at, and it used
  // to run starved. The exit-filter timeframe is checked over the same sets and
  // for the same reason. The session check is a base-constants question — the
  // playbook's session is on `config`, not in the param blob, and `--sweep`
  // takes a numeric grid so it cannot reach the time window's `HH:MM` either.
  const sets = resolveExecutedParamSets(found, args, sweepGrid(args.sweep));
  assertSessionMeasurable(found, sets[0]);
  assertSettingsTakeEntries(found, sets, daySessionForTicker(args.ticker));
  assertCrossTimeframeExitMeasurable(sets);
  assertWarmupCoversDeclaredSessions(found, sets, args.warmupDays);
  return found;
}

// Exits rather than setting `exitCode`, for `writeAndExit`'s reason: a refusal
// after the Topstep tail opened would otherwise leave the process running.
main(process.argv.slice(2)).catch((err: unknown) => {
  const message =
    err instanceof CliError
      ? err.message
      : err instanceof Error
        ? err.stack ?? err.message
        : String(err);
  const fail = () => process.stderr.write(`${message}\n`, () => process.exit(1));
  // A signal to the whole process group can reach a worker's `exit` before
  // this process's own handler runs. Give that handler the chance to end the
  // run as the signal it is; a worker signalled alone still fails here.
  if (err instanceof WorkerSignalled) setTimeout(fail, PARENT_SIGNAL_GRACE_MS);
  else fail();
});
