import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

/**
 * The one-shot clear of `replay_result_json` after the snapshot's post-exit
 * tail widened from 50 to 300 bars (bug file
 * replay-cache-invalidation-missing-on-snapshot-tail-widening). The real
 * migration runs against a database this test owns; `registerMigration` is
 * captured rather than reimplemented.
 */

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: Database.Database) => void>,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

import { REPLAY_CACHE_TAIL_CLEARED_KEY, getReplayResult, setReplayResult } from "./trades";

const STALE_BLOB = JSON.stringify({ status: "match", pnlDollars: 0 });
const FRESH_BLOB = JSON.stringify({ status: "exec_drift", pnlDollars: -42.5 });

function migrate(): void {
  for (const fn of migrations) fn(db);
}

function createSettingsTable(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
}

function insertClosedTrade(id: number): void {
  db.prepare(`
    INSERT INTO strategy_trades
      (id, deployment_id, strategy_key, account_id, ticker, contract_id, side, size,
       entry_submitted_at, status)
    VALUES (?, 'd1', 'ema', 4469, '/MNQ', 'CON.F.US.MNQ.Z26', 0, 1, '2026-04-28T14:00:00.000Z', 'closed')
  `).run(id);
}

/** A database from before the clear: the trade table exists and carries
 *  blobs cached under the 50-bar tail. */
function seedBeforeTheClear(): void {
  migrate();
  insertClosedTrade(1);
  insertClosedTrade(2);
  setReplayResult(1, STALE_BLOB);
  setReplayResult(2, STALE_BLOB);
  createSettingsTable();
}

beforeEach(() => {
  db = new Database(":memory:");
});

describe("the replay-cache clear after the snapshot tail widened", () => {
  it("nulls every cached replay the first time it runs", () => {
    seedBeforeTheClear();
    migrate();
    expect(getReplayResult(1)).toBeNull();
    expect(getReplayResult(2)).toBeNull();
  });

  it("records that it ran", () => {
    seedBeforeTheClear();
    migrate();
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(REPLAY_CACHE_TAIL_CLEARED_KEY);
    expect(row).toBeDefined();
  });

  it("keeps a replay computed after the clear on every later boot", () => {
    seedBeforeTheClear();
    migrate();
    setReplayResult(1, FRESH_BLOB);
    migrate();
    migrate();
    expect(getReplayResult(1)).toBe(FRESH_BLOB);
  });

  it("does nothing while app_settings does not exist, and clears on the boot that has it", () => {
    migrate();
    insertClosedTrade(1);
    setReplayResult(1, STALE_BLOB);
    migrate();
    expect(getReplayResult(1)).toBe(STALE_BLOB);
    createSettingsTable();
    migrate();
    expect(getReplayResult(1)).toBeNull();
  });
});
