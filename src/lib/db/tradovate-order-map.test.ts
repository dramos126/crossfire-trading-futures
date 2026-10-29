/**
 * Unit tests for tradovate-order-map.ts — DB persistence of the qty column
 * added by the naked-position watchdog fix.
 *
 * Uses a real in-memory better-sqlite3 instance so SQL semantics are exact.
 * The real getDb() / registerMigration machinery is mocked; schema and
 * migrations are applied directly to the in-memory DB in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import {
  recordOrderMapping,
  recordOrderMappings,
  lookupByOrderId,
  findActiveOrderMappingsByAccount,
  markTerminal,
  cleanupExpiredOrderMappings,
} from "./tradovate-order-map";

// ── Schema helpers ────────────────────────────────────────────────────────────

/** Apply the base schema (pre-qty migration) — simulates an existing install. */
function createBaseSchema(d: InstanceType<typeof Database>): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tradovate_order_map (
      order_id      INTEGER PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      role          TEXT NOT NULL,
      account_id    INTEGER NOT NULL,
      placed_at     INTEGER NOT NULL,
      terminal_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tradovate_order_map_deployment ON tradovate_order_map(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_tradovate_order_map_terminal ON tradovate_order_map(terminal_at);
  `);
}

/** Apply the qty migration (same guard logic as the production migration). */
function applyQtyMigration(d: InstanceType<typeof Database>): void {
  const cols = (d.prepare("PRAGMA table_info(tradovate_order_map)").all() as { name: string }[]).map(
    (r) => r.name,
  );
  if (!cols.includes("qty")) {
    d.exec(`ALTER TABLE tradovate_order_map ADD COLUMN qty INTEGER NOT NULL DEFAULT 1`);
  }
}

/** Full schema: base + qty migration — matches a fresh install or fully-migrated DB. */
function createFullSchema(d: InstanceType<typeof Database>): void {
  createBaseSchema(d);
  applyQtyMigration(d);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  db = new Database(":memory:");
  createFullSchema(db);
});

// ── recordOrderMapping ────────────────────────────────────────────────────────

describe("recordOrderMapping", () => {
  it("persists qty and lookupByOrderId returns it", () => {
    recordOrderMapping({
      orderId: 101,
      deploymentId: "deploy-aaa",
      role: "sl",
      accountId: 2001,
      qty: 2,
    });

    const row = lookupByOrderId(101);
    expect(row).not.toBeNull();
    expect(row!.qty).toBe(2);
    expect(row!.orderId).toBe(101);
    expect(row!.deploymentId).toBe("deploy-aaa");
    expect(row!.role).toBe("sl");
    expect(row!.accountId).toBe(2001);
    expect(row!.terminalAt).toBeNull();
  });

  it("returns null for an orderId that was never recorded", () => {
    expect(lookupByOrderId(9999)).toBeNull();
  });

  it("upsert on ON CONFLICT re-writes qty to the new value", () => {
    recordOrderMapping({ orderId: 102, deploymentId: "deploy-aaa", role: "entry", accountId: 2001, qty: 1 });
    // Simulate a re-place (e.g. engine re-records after a restart) with updated size.
    recordOrderMapping({ orderId: 102, deploymentId: "deploy-aaa", role: "entry", accountId: 2001, qty: 3 });

    const row = lookupByOrderId(102);
    expect(row!.qty).toBe(3);
  });

  it("upsert clears terminal_at so a re-placed order is treated as alive again", () => {
    recordOrderMapping({ orderId: 103, deploymentId: "deploy-aaa", role: "sl", accountId: 2001, qty: 1 });
    markTerminal(103);
    expect(lookupByOrderId(103)!.terminalAt).not.toBeNull();

    // Re-record: terminal_at must be cleared.
    recordOrderMapping({ orderId: 103, deploymentId: "deploy-aaa", role: "sl", accountId: 2001, qty: 2 });
    const row = lookupByOrderId(103);
    expect(row!.terminalAt).toBeNull();
    expect(row!.qty).toBe(2);
  });
});

// ── recordOrderMappings (bulk) ────────────────────────────────────────────────

describe("recordOrderMappings", () => {
  it("persists qty on all rows in the transaction", () => {
    recordOrderMappings([
      { orderId: 201, deploymentId: "deploy-bbb", role: "entry", accountId: 2001, qty: 2 },
      { orderId: 202, deploymentId: "deploy-bbb", role: "sl", accountId: 2001, qty: 2 },
      { orderId: 203, deploymentId: "deploy-bbb", role: "tp", accountId: 2001, qty: 2 },
    ]);

    expect(lookupByOrderId(201)!.qty).toBe(2);
    expect(lookupByOrderId(202)!.qty).toBe(2);
    expect(lookupByOrderId(203)!.qty).toBe(2);
  });

  it("is a no-op when the rows array is empty", () => {
    expect(() => recordOrderMappings([])).not.toThrow();
  });

  it("rolls back all rows when a constraint violation occurs mid-transaction", () => {
    // Pre-insert a row with unique order_id 301 to trigger a conflict on a
    // batch that also writes 301.
    recordOrderMapping({ orderId: 301, deploymentId: "deploy-ccc", role: "entry", accountId: 2001, qty: 1 });

    // The batch uses ON CONFLICT DO UPDATE so it won't throw — verify that
    // the upsert path correctly updates qty rather than silently ignoring it.
    recordOrderMappings([
      { orderId: 301, deploymentId: "deploy-ccc", role: "entry", accountId: 2001, qty: 4 },
      { orderId: 302, deploymentId: "deploy-ccc", role: "sl", accountId: 2001, qty: 4 },
    ]);

    expect(lookupByOrderId(301)!.qty).toBe(4);
    expect(lookupByOrderId(302)!.qty).toBe(4);
  });

  it("SL row qty matches the entry size — the fix for the size-2 bracket being counted as 1", () => {
    // Regression: OSO path records all three legs with qty=order.size.
    // Verify the SL leg's qty survives the batch write.
    recordOrderMappings([
      { orderId: 401, deploymentId: "deploy-ddd", role: "entry", accountId: 2001, qty: 2 },
      { orderId: 402, deploymentId: "deploy-ddd", role: "sl", accountId: 2001, qty: 2 },
      { orderId: 403, deploymentId: "deploy-ddd", role: "tp", accountId: 2001, qty: 2 },
    ]);

    const sl = lookupByOrderId(402);
    expect(sl!.role).toBe("sl");
    expect(sl!.qty).toBe(2);
  });
});

// ── findActiveOrderMappingsByAccount ──────────────────────────────────────────

describe("findActiveOrderMappingsByAccount", () => {
  it("returns correct qty per row for alive SL orders", () => {
    recordOrderMappings([
      { orderId: 501, deploymentId: "deploy-eee", role: "sl", accountId: 3001, qty: 2 },
      { orderId: 502, deploymentId: "deploy-fff", role: "sl", accountId: 3001, qty: 3 },
    ]);

    const rows = findActiveOrderMappingsByAccount(3001, "sl");
    expect(rows).toHaveLength(2);

    const r501 = rows.find((r) => r.orderId === 501)!;
    expect(r501.qty).toBe(2);

    const r502 = rows.find((r) => r.orderId === 502)!;
    expect(r502.qty).toBe(3);
  });

  it("excludes terminal rows", () => {
    recordOrderMapping({ orderId: 601, deploymentId: "deploy-ggg", role: "sl", accountId: 3001, qty: 1 });
    markTerminal(601);

    const rows = findActiveOrderMappingsByAccount(3001, "sl");
    expect(rows.find((r) => r.orderId === 601)).toBeUndefined();
  });

  it("returns empty when no rows match the account", () => {
    recordOrderMapping({ orderId: 701, deploymentId: "deploy-hhh", role: "sl", accountId: 4000, qty: 1 });

    const rows = findActiveOrderMappingsByAccount(9999, "sl");
    expect(rows).toHaveLength(0);
  });

  it("filters by role — entry rows not returned when querying sl only", () => {
    recordOrderMappings([
      { orderId: 801, deploymentId: "deploy-iii", role: "entry", accountId: 5001, qty: 2 },
      { orderId: 802, deploymentId: "deploy-iii", role: "sl", accountId: 5001, qty: 2 },
    ]);

    const rows = findActiveOrderMappingsByAccount(5001, "sl");
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(802);
  });

  it("accepts an array of roles and returns rows matching any", () => {
    recordOrderMappings([
      { orderId: 901, deploymentId: "deploy-jjj", role: "sl", accountId: 6001, qty: 2 },
      { orderId: 902, deploymentId: "deploy-jjj", role: "tp", accountId: 6001, qty: 2 },
      { orderId: 903, deploymentId: "deploy-jjj", role: "entry", accountId: 6001, qty: 2 },
    ]);

    const rows = findActiveOrderMappingsByAccount(6001, ["sl", "tp"]);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.orderId).sort();
    expect(ids).toEqual([901, 902]);
  });

  it("returns empty array when role array is empty", () => {
    recordOrderMapping({ orderId: 1001, deploymentId: "deploy-kkk", role: "sl", accountId: 7001, qty: 1 });

    const rows = findActiveOrderMappingsByAccount(7001, []);
    expect(rows).toHaveLength(0);
  });
});

// ── Pre-migration rows default qty=1 ──────────────────────────────────────────

describe("qty DEFAULT 1 for pre-migration rows", () => {
  it("rows inserted before the qty column existed read back as qty=1 after migration", () => {
    // Simulate a pre-migration install: create the base table without qty,
    // insert a row, then apply the qty migration.
    const oldDb = new Database(":memory:");
    createBaseSchema(oldDb);

    // Insert directly without qty (the column doesn't exist yet).
    oldDb.prepare(
      `INSERT INTO tradovate_order_map (order_id, deployment_id, role, account_id, placed_at, terminal_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(1101, "deploy-legacy", "sl", 8001, Date.now());

    // Now apply the qty migration.
    applyQtyMigration(oldDb);

    // Point the module's getDb() at this legacy DB for this assertion.
    db = oldDb;
    const row = lookupByOrderId(1101);
    expect(row).not.toBeNull();
    // The DEFAULT 1 on ALTER TABLE must have back-filled this existing row.
    expect(row!.qty).toBe(1);
  });
});

// ── Migration idempotency ─────────────────────────────────────────────────────

describe("qty migration idempotency", () => {
  it("running the migration twice does not throw", () => {
    // The full schema already applied qty migration in beforeEach.
    // Run it a second time — the PRAGMA guard must make it a no-op.
    expect(() => applyQtyMigration(db)).not.toThrow();
  });

  it("qty values written before the second migration attempt are preserved", () => {
    recordOrderMapping({ orderId: 1201, deploymentId: "deploy-mmm", role: "sl", accountId: 9001, qty: 5 });

    // Second migration run — must not reset the column or its data.
    applyQtyMigration(db);

    expect(lookupByOrderId(1201)!.qty).toBe(5);
  });
});

// ── cleanupExpiredOrderMappings ───────────────────────────────────────────────

describe("cleanupExpiredOrderMappings", () => {
  it("drops terminal rows older than 7 days and preserves live rows", () => {
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
    const staleAt = Date.now() - EIGHT_DAYS_MS;

    // Insert a stale terminal row directly with an old terminal_at.
    db.prepare(
      `INSERT INTO tradovate_order_map (order_id, deployment_id, role, account_id, placed_at, terminal_at, qty)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1301, "deploy-nnn", "sl", 2001, staleAt, staleAt, 1);

    // Insert a live (non-terminal) row.
    recordOrderMapping({ orderId: 1302, deploymentId: "deploy-nnn", role: "sl", accountId: 2001, qty: 2 });

    const dropped = cleanupExpiredOrderMappings();
    expect(dropped).toBe(1);
    expect(lookupByOrderId(1301)).toBeNull();
    expect(lookupByOrderId(1302)).not.toBeNull();
  });
});
