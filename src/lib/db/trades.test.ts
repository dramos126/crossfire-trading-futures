/**
 * Unit tests for trades.ts — focused on the entry_failed exclusion fix
 * in listTrades() and getPnLSummary().
 *
 * Uses an in-memory better-sqlite3 database so we get real SQL semantics
 * without touching the filesystem. The real getDb() / registerMigration
 * machinery is mocked to inject the in-memory instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn(),
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { listTrades, getPnLSummary, getAccountRealizedSinceGross } from "./trades";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createSchema(d: InstanceType<typeof Database>): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS strategy_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      strategy_key TEXT NOT NULL DEFAULT 'test',
      account_id INTEGER NOT NULL,
      ticker TEXT NOT NULL DEFAULT '/NQ',
      contract_id TEXT NOT NULL DEFAULT 'NQ-2025',
      side INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 1,
      entry_order_id INTEGER,
      entry_price REAL,
      entry_filled_at TEXT,
      entry_submitted_at TEXT NOT NULL,
      tp_order_id INTEGER,
      sl_order_id INTEGER,
      break_even_moved INTEGER NOT NULL DEFAULT 0,
      sl_moved_to_be_flag INTEGER NOT NULL DEFAULT 0,
      sl_trail_engaged INTEGER NOT NULL DEFAULT 0,
      exit_order_id INTEGER,
      exit_price REAL,
      exit_filled_at TEXT,
      exit_submitted_at TEXT,
      exit_reason TEXT,
      pnl_ticks REAL,
      pnl_dollars REAL,
      fees_dollars REAL,
      tick_size REAL,
      tick_value REAL,
      status TEXT NOT NULL,
      desired_entry_price REAL,
      entry_slippage_ticks REAL,
      entry_slippage_dollars REAL,
      desired_tp_price REAL,
      tp_slippage_ticks REAL,
      tp_slippage_dollars REAL,
      desired_sl_price REAL,
      sl_slippage_ticks REAL,
      sl_slippage_dollars REAL,
      desired_tp_ticks REAL,
      desired_sl_ticks REAL,
      exit_approximated INTEGER NOT NULL DEFAULT 0,
      exit_resolution_source TEXT,
      exit_detected_at TEXT,
      param_snapshot TEXT,
      filter_snapshot TEXT,
      replay_result_json TEXT,
      engine_session_id TEXT,
      deployment_version_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      account_id INTEGER,
      deleted_at TEXT,
      tombstoned_at TEXT
    );
  `);
}

function insertTrade(
  d: InstanceType<typeof Database>,
  overrides: {
    id?: number;
    deploymentId?: string;
    accountId?: number;
    status?: string;
    pnlDollars?: number | null;
    feesDollars?: number | null;
    exitFilledAt?: string | null;
    /** **SQLite's shape, not ISO.** `datetime('now')` writes
     *  `YYYY-MM-DD HH:MM:SS`, and a fixture that invents ISO here is testing a
     *  database that does not exist — which is exactly how a broken raw-string
     *  comparison passed six tests written to prove it worked. */
    exitDetectedAt?: string | null;
    updatedAt?: string;
  } = {},
): void {
  const {
    id,
    deploymentId = "deploy-aaa",
    accountId = 1001,
    status = "closed",
    pnlDollars = 100,
    feesDollars = null,
    exitFilledAt = "2025-06-01T15:00:00.000Z",
    exitDetectedAt = "2025-06-01 15:00:00",
    updatedAt = "2025-06-01 15:00:00",
  } = overrides;
  d.prepare(`
    INSERT INTO strategy_trades
      (id, deployment_id, account_id, status, pnl_dollars, fees_dollars, exit_filled_at,
       exit_detected_at, entry_submitted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    id ?? null, deploymentId, accountId, status, pnlDollars, feesDollars, exitFilledAt,
    exitDetectedAt, updatedAt,
  );
}

// ── Per-test fresh DB ─────────────────────────────────────────────────────────

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  // Reset tombstonedAtRef cache between tests by resetting the module-level
  // cache variable. We do this by wiping and rebuilding the deployment table
  // which already has tombstoned_at — so the feature-detect always returns
  // the real column (no stale NULL-literal cache needed here).
});

// ── listTrades: entry_failed exclusion ───────────────────────────────────────

describe("listTrades() entry_failed exclusion", () => {
  it("does not return a row whose status is entry_failed", () => {
    insertTrade(db, { id: 1, status: "entry_failed", pnlDollars: null, exitFilledAt: null });
    const trades = listTrades();
    expect(trades).toHaveLength(0);
  });

  it("returns a row whose status is closed", () => {
    insertTrade(db, { id: 2, status: "closed", pnlDollars: 200 });
    const trades = listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe("closed");
  });

  it("returns open and pending_entry rows but not entry_failed", () => {
    insertTrade(db, { id: 3, status: "open", pnlDollars: null, exitFilledAt: null });
    insertTrade(db, { id: 4, status: "pending_entry", pnlDollars: null, exitFilledAt: null });
    insertTrade(db, { id: 5, status: "entry_failed", pnlDollars: null, exitFilledAt: null });

    const trades = listTrades();
    const statuses = trades.map((t) => t.status);
    expect(statuses).toContain("open");
    expect(statuses).toContain("pending_entry");
    expect(statuses).not.toContain("entry_failed");
  });

  it("filters by accountId and still excludes entry_failed", () => {
    insertTrade(db, { id: 6, accountId: 1001, status: "closed", pnlDollars: 50 });
    insertTrade(db, { id: 7, accountId: 1001, status: "entry_failed", pnlDollars: null, exitFilledAt: null });
    insertTrade(db, { id: 8, accountId: 2002, status: "closed", pnlDollars: 75 });

    const trades = listTrades({ accountId: 1001 });
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe("closed");
    expect(trades[0].accountId).toBe(1001);
  });

  it("filters by deploymentId and still excludes entry_failed", () => {
    insertTrade(db, { id: 9, deploymentId: "deploy-bbb", status: "closed", pnlDollars: 150 });
    insertTrade(db, { id: 10, deploymentId: "deploy-bbb", status: "entry_failed", pnlDollars: null, exitFilledAt: null });

    const trades = listTrades({ deploymentId: "deploy-bbb" });
    expect(trades).toHaveLength(1);
    expect(trades[0].deploymentId).toBe("deploy-bbb");
    expect(trades[0].status).toBe("closed");
  });
});

// ── getPnLSummary: entry_failed exclusion ────────────────────────────────────

describe("getPnLSummary() entry_failed exclusion", () => {
  it("entry_failed row is not counted in totalTrades", () => {
    insertTrade(db, { id: 11, status: "entry_failed", pnlDollars: null, exitFilledAt: null });

    const summary = getPnLSummary();
    expect(summary.totalTrades).toBe(0);
    expect(summary.closedTrades).toBe(0);
    expect(summary.totalPnlDollars).toBe(0);
  });

  it("closed row is counted in totalTrades and pnl", () => {
    insertTrade(db, { id: 12, status: "closed", pnlDollars: 250 });

    const summary = getPnLSummary();
    expect(summary.totalTrades).toBe(1);
    expect(summary.closedTrades).toBe(1);
    expect(summary.totalPnlDollars).toBe(250);
  });

  it("mix of closed and entry_failed: only closed contributes to totals", () => {
    insertTrade(db, { id: 13, status: "closed", pnlDollars: 100 });
    insertTrade(db, { id: 14, status: "entry_failed", pnlDollars: null, exitFilledAt: null });
    insertTrade(db, { id: 15, status: "closed", pnlDollars: -50 });

    const summary = getPnLSummary();
    // only 2 closed rows, not 3 total
    expect(summary.totalTrades).toBe(2);
    expect(summary.closedTrades).toBe(2);
    expect(summary.winCount).toBe(1);
    expect(summary.lossCount).toBe(1);
    expect(summary.totalPnlDollars).toBeCloseTo(50);
  });

  it("filters by accountId and excludes entry_failed in that scope", () => {
    insertTrade(db, { id: 16, accountId: 3003, status: "closed", pnlDollars: 500 });
    insertTrade(db, { id: 17, accountId: 3003, status: "entry_failed", pnlDollars: null, exitFilledAt: null });

    const summary = getPnLSummary({ accountId: 3003 });
    expect(summary.totalTrades).toBe(1);
    expect(summary.totalPnlDollars).toBe(500);
  });

  it("winCount and lossCount are 0 when only entry_failed rows exist", () => {
    insertTrade(db, { id: 18, status: "entry_failed", pnlDollars: null, exitFilledAt: null });
    insertTrade(db, { id: 19, status: "entry_failed", pnlDollars: null, exitFilledAt: null });

    const summary = getPnLSummary();
    expect(summary.winCount).toBe(0);
    expect(summary.lossCount).toBe(0);
    expect(summary.openTrades).toBe(0);
  });
});

// ── The multi-leg filter the drill-in reads ──────────────────────────────────

describe("deploymentIds — one deployment's N legs, list and summary together", () => {
  function threeLegs(): void {
    insertTrade(db, { id: 30, deploymentId: "leg-a", pnlDollars: 100 });
    insertTrade(db, { id: 31, deploymentId: "leg-b", pnlDollars: -40 });
    insertTrade(db, { id: 32, deploymentId: "leg-c", pnlDollars: 500 });
  }

  it("lists the named legs and nothing else", () => {
    threeLegs();

    const trades = listTrades({ deploymentIds: ["leg-a", "leg-b"] });
    expect(trades.map((t) => t.deploymentId).sort()).toEqual(["leg-a", "leg-b"]);
  });

  it("sums the same set the list covers", () => {
    threeLegs();

    const summary = getPnLSummary({ deploymentIds: ["leg-a", "leg-b"] });
    expect(summary.totalPnlDollars).toBe(60);
    expect(summary.closedTrades).toBe(2);
    expect(summary.winCount).toBe(1);
    expect(summary.lossCount).toBe(1);
  });

  it("still drops entry_failed rows inside the named set", () => {
    insertTrade(db, { id: 33, deploymentId: "leg-a", pnlDollars: 100 });
    insertTrade(db, {
      id: 34,
      deploymentId: "leg-a",
      status: "entry_failed",
      pnlDollars: null,
      exitFilledAt: null,
    });

    expect(listTrades({ deploymentIds: ["leg-a"] })).toHaveLength(1);
    expect(getPnLSummary({ deploymentIds: ["leg-a"] }).totalTrades).toBe(1);
  });

  it("matches nothing for an empty list rather than everything", () => {
    // The parameter present and naming no legs means *these zero legs*. A
    // widening here would answer a drill-in whose legs could not be resolved
    // with every trade in the install, under that deployment's header.
    threeLegs();

    expect(listTrades({ deploymentIds: [] })).toEqual([]);
    expect(getPnLSummary({ deploymentIds: [] }).totalTrades).toBe(0);
  });

  it("leaves the unfiltered query alone when the option is absent", () => {
    threeLegs();

    expect(listTrades()).toHaveLength(3);
    expect(getPnLSummary().totalTrades).toBe(3);
  });
});

// ── A re-pointed deployment's history (bug file
//    deployment-trade-history-pnl-persists-across-account) ───────────────────

describe("a deployment's trades are the ones on its current account", () => {
  const OLD_ACCOUNT = 100200;
  const NEW_ACCOUNT = 90020038;

  /** `leg-moved` traded on the old account, was re-pointed, then traded once
   *  on the new one. */
  function movedLeg(): void {
    db.prepare(`INSERT INTO deployments (id, account_id) VALUES ('leg-moved', ?)`).run(NEW_ACCOUNT);
    insertTrade(db, { id: 40, deploymentId: "leg-moved", accountId: OLD_ACCOUNT, pnlDollars: -250.96 });
    insertTrade(db, { id: 41, deploymentId: "leg-moved", accountId: OLD_ACCOUNT, pnlDollars: 80 });
    insertTrade(db, { id: 42, deploymentId: "leg-moved", accountId: NEW_ACCOUNT, pnlDollars: -134.22 });
  }

  it("lists only the current account's rows under deploymentId", () => {
    movedLeg();
    expect(listTrades({ deploymentId: "leg-moved" }).map((t) => t.id)).toEqual([42]);
  });

  it("lists only the current account's rows under deploymentIds", () => {
    movedLeg();
    expect(listTrades({ deploymentIds: ["leg-moved"] }).map((t) => t.id)).toEqual([42]);
  });

  it("sums only the current account's P&L", () => {
    movedLeg();
    const summary = getPnLSummary({ deploymentIds: ["leg-moved"] });
    expect(summary.closedTrades).toBe(1);
    expect(summary.totalPnlDollars).toBe(-134.22);
    expect(getPnLSummary({ deploymentId: "leg-moved" }).totalPnlDollars).toBe(-134.22);
  });

  it("leaves the old account's own list and total holding its rows", () => {
    movedLeg();
    expect(listTrades({ accountId: OLD_ACCOUNT }).map((t) => t.id).sort()).toEqual([40, 41]);
    expect(getPnLSummary({ accountId: OLD_ACCOUNT }).totalPnlDollars).toBeCloseTo(-170.96);
    expect(getPnLSummary({ accountId: NEW_ACCOUNT }).totalPnlDollars).toBe(-134.22);
  });

  it("leaves the unfiltered read holding every row", () => {
    movedLeg();
    expect(listTrades()).toHaveLength(3);
  });

  it("keeps the rows of a deployment whose row is gone", () => {
    insertTrade(db, { id: 43, deploymentId: "leg-hard-deleted", accountId: OLD_ACCOUNT, pnlDollars: 10 });
    expect(listTrades({ deploymentId: "leg-hard-deleted" }).map((t) => t.id)).toEqual([43]);
    expect(getPnLSummary({ deploymentId: "leg-hard-deleted" }).totalPnlDollars).toBe(10);
  });
});


/**
 * The daily-loss gate's window.
 *
 * Two defects lived here, and the fixtures are part of the fix. `updated_at`
 * and `exit_detected_at` are written by SQLite's `datetime('now')`, which is
 * `YYYY-MM-DD HH:MM:SS` — not ISO. A fixture that seeds ISO into those columns
 * is testing a database that does not exist, and that is precisely how a
 * broken raw-string comparison passed a first round of tests written to prove
 * it worked. Every case below uses the production shape.
 */
describe("getAccountRealizedSinceGross — the daily-loss gate's window", () => {
  // 18:00 ET on the Globex open, EDT. Note it shares a UTC *date* with any
  // close between 18:00 and 20:00 ET — the case a raw string compare drops,
  // because ' ' (0x20) sorts before 'T' (0x54).
  const SESSION_START = "2025-06-01T22:00:00.000Z";

  it("counts an approximated close in the first hours of the session", () => {
    // The live scenario: a loss taken at 19:15 ET. Under a raw `>=` this
    // returned 0 for the entire remaining 22 hours of the session, because
    // sessionStart does not roll at midnight UTC — so the gate never saw it
    // and the deployment kept taking entries past its limit.
    insertTrade(db, {
      pnlDollars: -800,
      exitFilledAt: null,
      exitDetectedAt: "2025-06-01 23:15:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-800);
  });

  it("counts an approximated close later in the same session", () => {
    insertTrade(db, {
      pnlDollars: -500,
      exitFilledAt: null,
      exitDetectedAt: "2025-06-02 14:30:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-500);
  });

  it("still counts an ordinary close through its ISO fill timestamp", () => {
    // The two columns are in different formats on the same row, which is why
    // both sides of the comparison go through `datetime()`.
    insertTrade(db, {
      pnlDollars: -250,
      exitFilledAt: "2025-06-02T14:30:00.000Z",
      exitDetectedAt: "2025-06-02 14:30:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-250);
  });

  it("does not pull a previous session's approximated close into this one", () => {
    insertTrade(db, {
      pnlDollars: -900,
      exitFilledAt: null,
      exitDetectedAt: "2025-06-01 18:00:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(0);
  });

  it("is not dragged into this session by a healer touching updated_at", () => {
    // `backfillEntryFilledAt`, `backfillExitOrderId` and `setExitReason` all
    // bump `updated_at` on a closed, still-unhealed row, over a 7-day window.
    // A window built on `updated_at` would count this week-old loss against
    // today's limit and halt a deployment that should be trading — the gate
    // failing in the opposite direction.
    insertTrade(db, {
      pnlDollars: -1200,
      exitFilledAt: null,
      exitDetectedAt: "2025-05-28 14:00:00",
      updatedAt: "2025-06-02 09:00:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(0);
  });

  it("prefers the fill timestamp once the heal pass lands", () => {
    insertTrade(db, {
      pnlDollars: -700,
      exitFilledAt: "2025-06-01T18:00:00.000Z",
      exitDetectedAt: "2025-06-02 12:00:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(0);
  });

  it("includes a close exactly on the session boundary", () => {
    insertTrade(db, {
      pnlDollars: -300,
      exitFilledAt: null,
      exitDetectedAt: "2025-06-01 22:00:00",
    });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-300);
  });

  it("adds fees to the gross figure on both paths", () => {
    insertTrade(db, { id: 1, pnlDollars: -100, feesDollars: -2, exitFilledAt: null,
      exitDetectedAt: "2025-06-01 23:15:00" });
    insertTrade(db, { id: 2, pnlDollars: -100, feesDollars: -2,
      exitFilledAt: "2025-06-02T14:30:00.000Z", exitDetectedAt: "2025-06-02 14:30:00" });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-204);
  });

  it("ignores an open row regardless of either timestamp", () => {
    insertTrade(db, { status: "open", pnlDollars: null, exitFilledAt: null,
      exitDetectedAt: "2025-06-01 23:15:00" });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(0);
  });

  it("scopes to the account asked about", () => {
    insertTrade(db, { id: 1, accountId: 1001, pnlDollars: -100,
      exitFilledAt: null, exitDetectedAt: "2025-06-01 23:15:00" });
    insertTrade(db, { id: 2, accountId: 2002, pnlDollars: -900,
      exitFilledAt: null, exitDetectedAt: "2025-06-01 23:15:00" });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-100);
  });

  it("sums every deployment on the account, because they share one limit", () => {
    // The whole reason the gate moved off the deployment: two playbooks on one
    // account spend one drawdown, and a per-deployment counter of $X on each is
    // a $2X account limit wearing the operator's number.
    insertTrade(db, { id: 1, deploymentId: "deploy-aaa", pnlDollars: -100,
      exitFilledAt: null, exitDetectedAt: "2025-06-01 23:15:00" });
    insertTrade(db, { id: 2, deploymentId: "deploy-bbb", pnlDollars: -400,
      exitFilledAt: null, exitDetectedAt: "2025-06-01 23:15:00" });

    expect(getAccountRealizedSinceGross(1001, SESSION_START)).toBe(-500);
  });

});

// ── An unsettled trade is never cut off by the limit ─────────────────────────

describe("listTrades() — every open or pending trade, past the limit", () => {
  // The Dashboard's trade rows are its only position signal: a row whose
  // `open` trade fell off the newest-200 page reads as at rest and is hidden.

  it.each(["open", "pending_entry", "pending_exit"])(
    "includes a %s trade older than the newest-N page",
    (status) => {
      insertTrade(db, { id: 1, deploymentId: "old-leg", status });
      for (let id = 2; id <= 6; id++) insertTrade(db, { id });

      const trades = listTrades({ limit: 3 });

      expect(trades.map((t) => t.id)).toEqual([6, 5, 4, 1]);
    },
  );

  it("lists an unsettled trade inside the page once", () => {
    insertTrade(db, { id: 1 });
    insertTrade(db, { id: 2, status: "open" });

    expect(listTrades({ limit: 5 }).map((t) => t.id)).toEqual([2, 1]);
  });

  it("applies the same filters to the unsettled rows it adds", () => {
    insertTrade(db, { id: 1, accountId: 2002, status: "open" });
    insertTrade(db, { id: 2, deploymentId: "other", status: "open" });
    insertTrade(db, { id: 3, status: "entry_failed" });
    for (let id = 4; id <= 6; id++) insertTrade(db, { id });

    expect(listTrades({ accountId: 1001, deploymentId: "deploy-aaa", limit: 1 }).map((t) => t.id)).toEqual([6]);
  });

  it("holds under the default limit of 200", () => {
    insertTrade(db, { id: 1, status: "pending_exit" });
    for (let id = 2; id <= 202; id++) insertTrade(db, { id });

    const trades = listTrades();

    expect(trades).toHaveLength(201);
    expect(trades.at(-1)?.id).toBe(1);
  });
});
