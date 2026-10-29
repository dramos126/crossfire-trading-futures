/**
 * One backtest run at a time, per machine.
 *
 * Two concurrent runs on one machine defeat the core budget — the budget is
 * per invocation, so two sweeps at six workers each is twelve cores asked of
 * an eight-core machine.
 * The lock is a pid in a file rather than a flock: a run that was killed
 * leaves the file behind, and a stale lock that refuses every later run is
 * worse than the contention it was guarding against, so a pid that is no
 * longer alive is cleared and the run proceeds.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError } from "./cli-error";

const LOCK_FILE = "crossfire-backtest.lock";

export interface LockFs {
  read: (file: string) => string | null;
  write: (file: string, contents: string) => void;
  remove: (file: string) => void;
}

export interface RunLockArgs {
  file: string;
  pid: number;
  fs: LockFs;
  isAlive: (pid: number) => boolean;
}

/** Takes the lock, or refuses naming the pid that holds it. */
export function acquireRunLock(args: RunLockArgs): void {
  const held = readPid(args.fs, args.file);
  if (held != null && held !== args.pid && args.isAlive(held)) {
    throw new CliError(`another backtest run is in progress (pid ${held}); wait for it`);
  }
  args.fs.write(args.file, `${args.pid}\n`);
}

/** Idempotent, and never removes a lock another run has since taken. */
export function releaseRunLock(args: Omit<RunLockArgs, "isAlive">): void {
  if (readPid(args.fs, args.file) !== args.pid) return;
  args.fs.remove(args.file);
}

function readPid(fs: LockFs, file: string): number | null {
  const raw = fs.read(file);
  if (raw == null) return null;
  const pid = Number(raw.trim());
  // An unreadable lock is not a run: treat it as absent rather than refusing
  // every future invocation on a file nothing can interpret.
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function runLockFile(): string {
  return path.join(os.tmpdir(), LOCK_FILE);
}

export function nodeLockFs(): LockFs {
  return {
    read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
    write: (file, contents) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents, "utf8");
    },
    remove: (file) => {
      rmSync(file, { force: true });
    },
  };
}

/** Signal 0 checks for the process without touching it. `EPERM` means it is
 *  alive and owned by someone else, which is still held. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
