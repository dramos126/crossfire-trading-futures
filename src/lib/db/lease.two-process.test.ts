/**
 * The lease's one-writer guarantee across real processes. `lease.test.ts` pins
 * the rules on one `:memory:` connection, where nothing can race; this forks
 * workers that each open the same file through the real `connection.ts`, so
 * the `IMMEDIATE` transaction and `busy_timeout` are what is under test.
 */

import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registeredMigrations } from "./connection";
import { LEASE_FRESH_MS } from "./lease";
import type { TakeReply, WorkerCommand, WorkerReply, YieldReply } from "./lease.two-process.worker";

const WORKER = join(__dirname, "lease.two-process.worker.ts");
const RACERS = 4;
const STALE_GENERATION = 7;
/** How long connection B keeps the write lock while A's acquire waits on it;
 *  well inside the 5s `busy_timeout`. */
const HOLD_MS = 400;
/** The active's drain between accepting a hand-off and releasing: long
 *  enough that the standby polls the fresh lease many times meanwhile. */
const DRAIN_MS = 300;
/** How often the parent samples the row through its own connection. */
const SAMPLE_MS = 2;

let dir: string;
let dbPath: string;
let workers: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lease-two-process-"));
  dbPath = join(dir, "trading.db");
  // Created, in WAL and migrated before any worker forks. Workers racing to
  // create the file and switch its journal mode — a lock `busy_timeout` does
  // not wait on — is what made one exit before it was ready.
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  for (const migrate of registeredMigrations()) migrate(seed);
  seed.close();
});

afterEach(() => {
  for (const w of workers) w.kill();
  workers = [];
  rmSync(dir, { recursive: true, force: true });
});

/** Fork a worker and resolve once it has opened the file. */
function spawn(holder: string): Promise<ChildProcess> {
  const w = fork(WORKER, [holder], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, TRADING_DB_PATH: dbPath, CROSSFIRE_ROLE: "all" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  workers.push(w);
  return new Promise((resolveReady, reject) => {
    w.once("error", reject);
    w.once("exit", (code) => reject(new Error(`worker ${holder} exited with ${code} before ready`)));
    w.once("message", (msg) => (msg === "ready" ? resolveReady(w) : reject(new Error(String(msg)))));
  });
}

function send<T>(w: ChildProcess, command: WorkerCommand): Promise<T> {
  return new Promise((resolveReply) => {
    w.once("message", (msg) => resolveReply(msg as T));
    w.send(command);
  });
}

function go(w: ChildProcess): Promise<WorkerReply> {
  return send<WorkerReply>(w, "go");
}

describe("the engine lease across processes", () => {
  it("lets exactly one of several racers take a stale lease, at generation + 1", async () => {
    const racers = await Promise.all(Array.from({ length: RACERS }, (_, i) => spawn(`racer-${i}`)));
    const parent = new Database(dbPath);
    parent
      .prepare(`UPDATE engine_lease SET holder = 'crashed', generation = ?, renewed_at = ? WHERE id = 1`)
      .run(STALE_GENERATION, Date.now() - LEASE_FRESH_MS - 1_000);

    const replies = await Promise.all(racers.map(go));

    expect(replies.map((r) => r.error)).toEqual(replies.map(() => null));
    const winners = replies.filter((r) => r.attempt?.acquired);
    expect(winners).toHaveLength(1);
    const winner = winners[0].attempt?.holder;
    for (const r of replies.filter((x) => !x.attempt?.acquired)) {
      expect(r.attempt).toMatchObject({ holder: winner, generation: STALE_GENERATION + 1 });
    }
    expect(parent.prepare(`SELECT holder, generation FROM engine_lease WHERE id = 1`).get()).toEqual({
      holder: winner,
      generation: STALE_GENERATION + 1,
    });
    parent.close();
  });

  it("waits on a write another connection holds, then reads that connection's holder and refuses", async () => {
    const a = await spawn("process-a");
    const b = new Database(dbPath);
    b.exec("BEGIN IMMEDIATE");
    b.prepare(`UPDATE engine_lease SET holder = 'process-b', generation = 1, renewed_at = ? WHERE id = 1`).run(
      Date.now(),
    );

    const reply = go(a);
    await new Promise((resolveHold) => setTimeout(resolveHold, HOLD_MS));
    b.exec("COMMIT");
    const { attempt, error, elapsedMs } = await reply;

    expect(error).toBeNull();
    // Blocked on B's lock rather than reading the pre-commit snapshot, which
    // would have shown a free lease and taken it.
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(attempt).toMatchObject({ acquired: false, holder: "process-b", generation: 1 });
    expect(b.prepare(`SELECT holder FROM engine_lease WHERE id = 1`).get()).toEqual({ holder: "process-b" });
    b.close();
  });

  it("hands the lease from an active to a standby with no instant of two holders", async () => {
    const [active, standby] = await Promise.all([spawn("active"), spawn("standby")]);
    expect((await send<WorkerReply>(active, "hold")).attempt).toMatchObject({ acquired: true, generation: 1 });

    // The row as a third connection sees it, sampled through the whole hand-off.
    const parent = new Database(dbPath, { readonly: true });
    const read = parent.prepare(`SELECT holder, generation FROM engine_lease WHERE id = 1`);
    const samples: Array<{ holder: string | null; generation: number }> = [];
    const sampler = setInterval(() => {
      samples.push(read.get() as { holder: string | null; generation: number });
    }, SAMPLE_MS);

    const yielded = send<YieldReply>(active, { op: "yield", drainMs: DRAIN_MS });
    const taken = await send<TakeReply>(standby, { op: "take" });
    const gave = await yielded;
    clearInterval(sampler);
    samples.push(read.get() as { holder: string | null; generation: number });
    parent.close();

    expect([gave.error, taken.error]).toEqual([null, null]);
    expect(taken.requestedOf).toBe("active");
    expect(gave.requester).toBe("standby");
    // It asked and waited: the fresh lease refused it for the whole drain.
    expect(taken.refused).toBeGreaterThan(0);
    // The active's last read of itself as holder, its release, then the take.
    expect(gave.lastHeldAt).toBeLessThanOrEqual(gave.releasedAt);
    expect(gave.releasedAt).toBeLessThanOrEqual(taken.acquiredAt);
    expect(taken.generation).toBe(2);

    // The row only ever moves forward: active, then free, then standby.
    const holders = samples.map((s) => s.holder).filter((h, i, all) => i === 0 || h !== all[i - 1]);
    expect(holders[0]).toBe("active");
    expect(holders[holders.length - 1]).toBe("standby");
    expect(holders.filter((h) => h === "active")).toHaveLength(1);
    expect(holders.every((h) => h === "active" || h === "standby" || h === null)).toBe(true);
    expect(samples.filter((s) => s.holder === "standby").every((s) => s.generation === 2)).toBe(true);
  });
});
