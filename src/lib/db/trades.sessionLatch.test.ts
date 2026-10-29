import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

/**
 * `strategy_trades.session_key` and `listSessionLatchedEntries` — the read a
 * restart rebuilds the engine's one-per-side latch from (bugs.md A92).
 *
 * Rows are written through the shipped writers the live entry and fill paths
 * call, so "filled" here means what `markEntryFilled` makes it mean, and the
 * real migration runs against a database this test owns.
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

import {
  attachPendingExit,
  closeTrade,
  getTradeById,
  insertPendingEntry,
  listSessionLatchedEntries,
  markEntryFailed,
  markEntryFilled,
} from "./trades";

const DEPL_A = "depl-a";
const DEPL_B = "depl-b";
const SESSION = "2026-10-09";
/** 11:19 ET on the session day. */
const SUBMITTED_AT = "2026-10-09T15:19:00.000Z";
const SINCE = "2026-10-02T16:00:00.000Z";

function entry(over: { deploymentId?: string; side?: 0 | 1; sessionKey?: string; at?: string } = {}): number {
  return insertPendingEntry({
    deploymentId: over.deploymentId ?? DEPL_A,
    strategyKey: "beta-pullback-fade",
    accountId: 1,
    ticker: "/MNQ",
    contractId: "CON.F.US.MNQ.Z26",
    side: over.side ?? 0,
    size: 1,
    entryOrderId: null,
    entrySubmittedAt: over.at ?? SUBMITTED_AT,
    sessionKey: "sessionKey" in over ? over.sessionKey : SESSION,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const m of migrations) m(db);
});

describe("insertPendingEntry", () => {
  it("stamps the signal's session key on the row, and null when there is none", () => {
    const keyed = entry();
    const unkeyed = entry({ sessionKey: undefined });
    const read = db.prepare(`SELECT session_key FROM strategy_trades WHERE id = ?`);
    expect(read.get(keyed)).toEqual({ session_key: SESSION });
    expect(read.get(unkeyed)).toEqual({ session_key: null });
  });

  // A fill after a restart has no in-memory key to latch from; it reads this.
  it("reads the key back on the trade", () => {
    expect(getTradeById(entry())?.sessionKey).toBe(SESSION);
    expect(getTradeById(entry({ sessionKey: undefined }))?.sessionKey).toBeNull();
  });
});

describe("listSessionLatchedEntries", () => {
  it("returns an entry once it fills, never while it is pending", () => {
    const id = entry();
    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([]);

    markEntryFilled(id, 21_000, "2026-10-09T15:19:02.000Z");

    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([
      { deploymentId: DEPL_A, sessionKey: SESSION, side: 0 },
    ]);
  });

  it("does not return an order that was cancelled or rejected before it filled", () => {
    markEntryFailed(entry(), "entry_not_filled");
    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([]);
  });

  it("returns a filled entry through its exit and after it closes", () => {
    const exiting = entry({ side: 0 });
    markEntryFilled(exiting, 21_000, SUBMITTED_AT);
    attachPendingExit({ tradeId: exiting, exitOrderId: 9, exitSubmittedAt: SUBMITTED_AT });
    const stopped = entry({ side: 1 });
    markEntryFilled(stopped, 21_000, SUBMITTED_AT);
    closeTrade({ tradeId: stopped, exitPrice: 21_010, exitFilledAt: SUBMITTED_AT, pnlTicks: -40, pnlDollars: -20 });

    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([
      { deploymentId: DEPL_A, sessionKey: SESSION, side: 0 },
      { deploymentId: DEPL_A, sessionKey: SESSION, side: 1 },
    ]);
  });

  // The reconciler can promote a row before Trade/search has indexed the fill
  // time; the live latch was set on that promotion, so the restart must agree.
  it("returns a filled entry whose fill time is not known yet", () => {
    markEntryFilled(entry(), 21_000, null);
    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toHaveLength(1);
  });

  it("returns only the deployments it was asked about", () => {
    markEntryFilled(entry({ deploymentId: DEPL_B }), 21_000, SUBMITTED_AT);
    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([]);
    expect(listSessionLatchedEntries([], SINCE)).toEqual([]);
  });

  it("does not return an entry from a strategy that emitted no session key", () => {
    markEntryFilled(entry({ sessionKey: undefined }), 21_000, SUBMITTED_AT);
    expect(listSessionLatchedEntries([DEPL_A], SINCE)).toEqual([]);
  });

  it("returns entries submitted at or after the cut-off and none before it", () => {
    markEntryFilled(entry({ at: "2026-10-02T15:59:59.000Z", sessionKey: "2026-10-02" }), 21_000, null);
    markEntryFilled(entry({ at: SINCE, sessionKey: "2026-10-03" }), 21_000, null);
    expect(listSessionLatchedEntries([DEPL_A], SINCE).map((e) => e.sessionKey)).toEqual(["2026-10-03"]);
  });
});
