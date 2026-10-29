import { getDb, registerMigration } from "./connection";
import { log } from "@/lib/logger";

/**
 * Per-order routing metadata for Tradovate-placed orders.
 *
 * Replaces the customTag echo Topstep uses for fill→deployment attribution
 * (Tradovate rejects unregistered Tag50 values, so we cannot round-trip a
 * deploymentId through the order body). Instead, every successful Tradovate
 * `placeOrder` synchronously persists a `(orderId → deploymentId, role)` row
 * BEFORE control returns to the caller — the WS dispatcher (or any future
 * fill/order consumer) can then look up an inbound `orderId` against this
 * table to recover the originating deployment.
 *
 * Survives engine restarts because it's DB-backed. Cold-boot fills that
 * predate the row (operator-placed orders, pre-Phase-X installs) miss the
 * lookup and the dispatcher drops the event with a logged warning — same
 * defensive behavior as the contract-id miss path in realtime.ts.
 */
registerMigration((d) => {
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
});

// Add qty column to existing installs (DEFAULT 1 keeps pre-migration rows valid).
registerMigration((d) => {
  const cols = (d.prepare("PRAGMA table_info(tradovate_order_map)").all() as { name: string }[]).map(
    (r) => r.name,
  );
  if (!cols.includes("qty")) {
    d.exec(`ALTER TABLE tradovate_order_map ADD COLUMN qty INTEGER NOT NULL DEFAULT 1`);
  }
});

export type TradovateOrderRole = "entry" | "sl" | "tp" | "exit";

interface OrderMapRow {
  order_id: number;
  deployment_id: string;
  role: string;
  account_id: number;
  placed_at: number;
  terminal_at: number | null;
  qty: number;
}

export interface OrderMapping {
  orderId: number;
  deploymentId: string;
  role: TradovateOrderRole;
  accountId: number;
  placedAt: number;
  terminalAt: number | null;
  qty: number;
}

function isTradovateOrderRole(v: string): v is TradovateOrderRole {
  return v === "entry" || v === "sl" || v === "tp" || v === "exit";
}

/**
 * Persist a single (orderId → deployment, role) mapping. Caller is the
 * Tradovate `placeOrder` post-success block; rows MUST land before the
 * placeOrder result returns so a fill arriving moments later can attribute.
 */
export function recordOrderMapping(input: {
  orderId: number;
  deploymentId: string;
  role: TradovateOrderRole;
  accountId: number;
  qty: number;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO tradovate_order_map (order_id, deployment_id, role, account_id, placed_at, terminal_at, qty)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         deployment_id = excluded.deployment_id,
         role = excluded.role,
         account_id = excluded.account_id,
         placed_at = excluded.placed_at,
         terminal_at = NULL,
         qty = excluded.qty`,
    )
    .run(input.orderId, input.deploymentId, input.role, input.accountId, now, input.qty);
}

/**
 * Bulk variant for the OSO bracketed-entry path: writes all three
 * (entry, SL, TP) mappings in one transaction so a partial DB failure
 * can't leave the map in a half-populated state where the entry fill
 * resolves but the bracket fills don't.
 */
export function recordOrderMappings(
  rows: ReadonlyArray<{
    orderId: number;
    deploymentId: string;
    role: TradovateOrderRole;
    accountId: number;
    qty: number;
  }>,
): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO tradovate_order_map (order_id, deployment_id, role, account_id, placed_at, terminal_at, qty)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(order_id) DO UPDATE SET
       deployment_id = excluded.deployment_id,
       role = excluded.role,
       account_id = excluded.account_id,
       placed_at = excluded.placed_at,
       terminal_at = NULL,
       qty = excluded.qty`,
  );
  const now = Date.now();
  const tx = db.transaction(
    (
      list: ReadonlyArray<{
        orderId: number;
        deploymentId: string;
        role: TradovateOrderRole;
        accountId: number;
        qty: number;
      }>,
    ) => {
      for (const r of list) stmt.run(r.orderId, r.deploymentId, r.role, r.accountId, now, r.qty);
    },
  );
  tx(rows);
}

/** Returns the mapping row for an orderId, or null on miss. */
export function lookupByOrderId(orderId: number): OrderMapping | null {
  const row = getDb()
    .prepare(
      `SELECT order_id, deployment_id, role, account_id, placed_at, terminal_at, qty
       FROM tradovate_order_map WHERE order_id = ?`,
    )
    .get(orderId) as OrderMapRow | undefined;
  if (!row) return null;
  if (!isTradovateOrderRole(row.role)) return null;
  return {
    orderId: row.order_id,
    deploymentId: row.deployment_id,
    role: row.role,
    accountId: row.account_id,
    placedAt: row.placed_at,
    terminalAt: row.terminal_at,
    qty: row.qty,
  };
}

/**
 * Naked-position watchdog read path: returns every still-alive
 * (`terminal_at IS NULL`) mapping row for an account filtered to the
 * requested role. Used by the Tradovate branch of the watchdog to
 * enumerate known SL orderIds for verification via `/order/item`,
 * sidestepping the fragility of `/order/list` filtering when the
 * contractId-cache hasn't warmed (string-fallback would mis-match the
 * position's dated symbol and the SL would be invisible).
 */
export function findActiveOrderMappingsByAccount(
  accountId: number,
  role: TradovateOrderRole | ReadonlyArray<TradovateOrderRole>,
): OrderMapping[] {
  const roles = Array.isArray(role) ? role : [role as TradovateOrderRole];
  if (roles.length === 0) return [];
  const placeholders = roles.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT order_id, deployment_id, role, account_id, placed_at, terminal_at, qty
       FROM tradovate_order_map
       WHERE account_id = ? AND role IN (${placeholders}) AND terminal_at IS NULL`,
    )
    .all(accountId, ...roles) as OrderMapRow[];
  const out: OrderMapping[] = [];
  for (const row of rows) {
    if (!isTradovateOrderRole(row.role)) continue;
    out.push({
      orderId: row.order_id,
      deploymentId: row.deployment_id,
      role: row.role,
      accountId: row.account_id,
      placedAt: row.placed_at,
      terminalAt: row.terminal_at,
      qty: row.qty,
    });
  }
  return out;
}

/**
 * Stamp `terminal_at` on a mapping row when the order has reached a
 * terminal state (filled, cancelled, rejected). Idempotent — re-stamping
 * leaves the original timestamp intact so we don't drift the eventual
 * TTL cleanup window. No-op when the row doesn't exist or is already
 * terminal.
 */
export function markTerminal(orderId: number): void {
  getDb()
    .prepare(
      `UPDATE tradovate_order_map
       SET terminal_at = ?
       WHERE order_id = ? AND terminal_at IS NULL`,
    )
    .run(Date.now(), orderId);
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Drop terminal rows older than the TTL window. Called from the engine
 * boot sequence so a long-running install doesn't accumulate the table
 * indefinitely. Keeps live (non-terminal) rows regardless of age — those
 * still need their mapping to attribute the eventual fill.
 */
export function cleanupExpiredOrderMappings(): number {
  const cutoff = Date.now() - TTL_MS;
  const res = getDb()
    .prepare(`DELETE FROM tradovate_order_map WHERE terminal_at IS NOT NULL AND terminal_at < ?`)
    .run(cutoff);
  const dropped = typeof res.changes === "number" ? res.changes : 0;
  if (dropped > 0) {
    log.event(
      "db_migration_applied",
      "tradovate.order-map",
      `cleanup: dropped ${dropped} terminal row(s) older than ${Math.round(TTL_MS / (24 * 60 * 60 * 1000))}d`,
    );
  }
  return dropped;
}
