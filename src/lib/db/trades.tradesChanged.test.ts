/**
 * Every write to a `strategy_trades` row tells the browser its trade reads are
 * stale — one `tradesChanged` per write. Nothing polls `/api/trades` behind
 * the stream while it is up, so a writer that forgot would leave every trade
 * surface showing the row as it was until the next reconnect.
 *
 * The SQL is not under test here (trades.test.ts has a real database for
 * that), so `getDb` answers a statement that runs and returns nothing. The
 * relay is the engine's, registered on the table module, so it is stood in
 * for by a counter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/db/connection", () => ({
  // `get` answers clearAllTrades's in-flight count: none, so the wipe runs.
  getDb: () => ({ prepare: () => ({ run: () => ({ lastInsertRowid: 41, changes: 1 }), get: () => ({ n: 0 }) }) }),
  registerMigration: () => {},
}));

import * as trades from "./trades";

let emits = 0;

const WRITES: Array<[string, () => void]> = [
  ["insertPendingEntry", () =>
    void trades.insertPendingEntry({
      deploymentId: "dep-1",
      strategyKey: "ema-x",
      accountId: 9001,
      ticker: "/MNQ",
      contractId: "CON.F.US.MNQ.Z26",
      side: 0,
      size: 1,
      entryOrderId: null,
      entrySubmittedAt: "2026-10-27T14:30:00.000Z",
    })],
  ["markEntryFilled", () => trades.markEntryFilled(41, 24680.25, "2026-10-27T14:30:01.000Z")],
  ["setEntryOrderId", () => trades.setEntryOrderId(41, 8811000)],
  ["setBracketOrderIds", () => trades.setBracketOrderIds(41, 8811001, 8811002)],
  ["setRestingBracketPrices", () => trades.setRestingBracketPrices(41, 24700, 24660)],
  ["markBreakEvenMoved", () => trades.markBreakEvenMoved(41, 24680.25)],
  ["markSlTrailEngaged", () => trades.markSlTrailEngaged(41)],
  ["markEntryFailed", () => trades.markEntryFailed(41, "rejected")],
  ["setExitReason", () => trades.setExitReason(41, { label: "Take Profit", code: "take_profit", detail: null })],
  ["backfillExitOrderId", () => trades.backfillExitOrderId(41, 8811003)],
  ["attachPendingExit", () =>
    trades.attachPendingExit({ tradeId: 41, exitOrderId: 8811003, exitSubmittedAt: "2026-10-27T14:40:00.000Z" })],
  ["closeTrade", () =>
    trades.closeTrade({
      tradeId: 41,
      exitPrice: 24700,
      exitFilledAt: "2026-10-27T14:40:01.000Z",
      pnlTicks: 79,
      pnlDollars: 39.5,
      exitKind: "tp",
    })],
  ["healApproximatedExit", () =>
    trades.healApproximatedExit({
      tradeId: 41,
      exitPrice: 24700,
      exitFilledAt: "2026-10-27T14:40:01.000Z",
      pnlTicks: 79,
      pnlDollars: 39.5,
      feesDollars: 0.74,
      exitKind: "other",
    })],
  ["backfillEntryFilledAt", () => trades.backfillEntryFilledAt(41, "2026-10-27T14:30:01.000Z")],
  ["backfillExitFilledAt", () => trades.backfillExitFilledAt(41, "2026-10-27T14:40:01.000Z")],
  // A deleted row is as stale in a tab as an edited one.
  ["deleteTrade", () => void trades.deleteTrade(41)],
  ["clearAllTrades", () => void trades.clearAllTrades()],
];

beforeEach(() => {
  emits = 0;
  trades.setTradeWriteListener(() => void emits++);
});

afterEach(() => {
  trades.setTradeWriteListener(null);
});

describe("the trade writers — tradesChanged", () => {
  it.each(WRITES)("%s sends exactly one", (_name, write) => {
    write();
    expect(emits).toBe(1);
  });

  it("the replay cache does not — it is derived from the row, not the row", () => {
    trades.setReplayResult(41, "{}");
    expect(emits).toBe(0);
  });

  it("writes with no listener installed — a process with no engine has no relay", () => {
    trades.setTradeWriteListener(null);
    expect(() => trades.markEntryFailed(41, "rejected")).not.toThrow();
  });

  it("a listener that throws does not turn a committed write into a throw", () => {
    trades.setTradeWriteListener(() => {
      throw new Error("relay down");
    });
    expect(() => trades.markEntryFailed(41, "rejected")).not.toThrow();
  });

  it("the engine installs the relay when it builds the engine (source scan)", () => {
    const singleton = readFileSync(path.join(__dirname, "../trading/engine/engine-singleton.ts"), "utf8");
    expect(singleton).toMatch(/setTradeWriteListener\(\(\) => peekBroadcaster\(\)\?\.emitTradesChanged\(\)\)/);
  });

  it("covers every exported function that writes a row (source scan)", () => {
    const source = readFileSync(path.join(__dirname, "trades.ts"), "utf8");
    const writers = [...source.matchAll(/^export function (\w+)\([\s\S]*?^}/gm)]
      .filter(([body]) => /(UPDATE strategy_trades|INSERT INTO strategy_trades|DELETE FROM strategy_trades)/.test(body))
      .map(([, name]) => name);
    expect(writers.length).toBeGreaterThan(0);
    const exempt = new Set(["setReplayResult"]);
    expect(writers.filter((n) => !exempt.has(n)).sort()).toEqual(WRITES.map(([n]) => n).sort());
  });
});
