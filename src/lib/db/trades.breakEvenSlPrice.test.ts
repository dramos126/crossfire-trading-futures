import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

/**
 * `break_even_sl_price` — where the break-even move put the stop (bugs.md
 * A20). The real migration creates the column on a database this test owns.
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

import { getTradeById, markBreakEvenMoved } from "./trades";

const TRADE_ID = 1;
// Entry 21000.00 long, break-even offset 2 ticks of 0.25.
const BE_STOP = 21000.5;

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  db.prepare(`
    INSERT INTO strategy_trades
      (id, deployment_id, strategy_key, account_id, ticker, contract_id, side, size,
       entry_price, entry_submitted_at, desired_sl_price, status)
    VALUES (?, 'd1', 'structure-break', 4469, '/MNQ', 'CON.F.US.MNQ.Z26', 0, 1,
            21000, '2026-10-20T14:00:00.000Z', 20990, 'open')
  `).run(TRADE_ID);
});

describe("markBreakEvenMoved — the stop price beside the flag", () => {
  it("stores the price and reads it back on the trade", () => {
    markBreakEvenMoved(TRADE_ID, BE_STOP);
    const trade = getTradeById(TRADE_ID);
    expect(trade?.breakEvenSlPrice).toBe(BE_STOP);
    expect(trade?.slMovedToBreakeven).toBe(true);
  });

  it("leaves the bracket as placed in desired_sl_price", () => {
    markBreakEvenMoved(TRADE_ID, BE_STOP);
    expect(getTradeById(TRADE_ID)?.desiredSlPrice).toBe(20990);
  });

  it("reads null on a row break-even never moved", () => {
    expect(getTradeById(TRADE_ID)?.breakEvenSlPrice).toBeNull();
  });

  it("keeps a stored price when a later call carries none", () => {
    markBreakEvenMoved(TRADE_ID, BE_STOP);
    markBreakEvenMoved(TRADE_ID);
    expect(getTradeById(TRADE_ID)?.breakEvenSlPrice).toBe(BE_STOP);
  });
});
