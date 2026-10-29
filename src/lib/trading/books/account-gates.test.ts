import { describe, it, expect, vi } from "vitest";

// `readAccountGates` reads three tables; this file tests the pure builder.
vi.mock("@/lib/db/account-brokers", () => ({
  autoTradeVerdictsForAccountIds: vi.fn(),
  listAccountDeployRecords: vi.fn(),
}));
vi.mock("@/lib/db/books", () => ({ listBooks: vi.fn(), listDerivedRows: vi.fn() }));
vi.mock("@/lib/db/deployments", () => ({ listDeployments: vi.fn() }));

import { accountsInUse, buildAccountGates, type AccountGateRecord } from "./account-gates";
import {
  ACCOUNT_DEAD_REFUSAL,
  AUTO_OCO_OFF_REFUSAL,
  autoBracketWarning,
  lockedRefusal,
} from "@/lib/trading/broker-access/account-state-gate";
import type { AutoTradeVerdict } from "@/lib/trading/broker-access/account-trading-policy";

const NOW = new Date("2026-10-14T15:00:00.000Z");

function record(accountId: number, over: Partial<AccountGateRecord["state"]> = {}): AccountGateRecord {
  return {
    accountId,
    name: `50KTC-${accountId}`,
    state: {
      broker: "topstep",
      status: "ok",
      cause: null,
      lockoutReason: null,
      lockoutUntil: null,
      autoOcoBrackets: true,
      bracketAutoApply: null,
      bracketRiskUsd: null,
      bracketTargetUsd: null,
      ...over,
    },
    templateId: 67,
    startingBalanceUsd: 50_000,
  };
}

function permitAll(ids: number[]): Map<number, AutoTradeVerdict> {
  return new Map(ids.map((id) => [id, { permitted: true }]));
}

describe("accountsInUse", () => {
  it("frees an account once its book is removed, though the book's paused rows stay", () => {
    const inUse = accountsInUse({
      books: [
        { id: "removed", accountId: 1, retiredAt: 1_000 },
        { id: "live", accountId: 2, retiredAt: null },
      ],
      derived: [
        { groupId: "g-removed", bookId: "removed" },
        { groupId: "g-live", bookId: "live" },
      ],
      legs: [
        { accountId: 1, groupId: "g-removed" },
        { accountId: 2, groupId: "g-live" },
        // A hand-made leg still holds its account, removed book or not.
        { accountId: 3, groupId: "g-hand" },
      ],
    });
    expect([...inUse].sort()).toEqual([2, 3]);
  });
});

describe("buildAccountGates", () => {
  it("states each refusal with its stamp, and a permitted account's warning", () => {
    const gates = buildAccountGates({
      records: [
        record(1, { status: "dead" }),
        record(2, { autoOcoBrackets: false }),
        record(3, { bracketAutoApply: true, bracketRiskUsd: 300, bracketTargetUsd: 600 }),
      ],
      autoTrade: permitAll([1, 2, 3]),
      inUse: new Set(),
      now: NOW,
    });
    expect(gates[0]?.refusal).toEqual({ kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL });
    expect(gates[1]?.refusal).toEqual({ kind: "oco-off", stamp: "OCO Off", reason: AUTO_OCO_OFF_REFUSAL });
    expect(gates[2]).toMatchObject({ refusal: null, warning: autoBracketWarning(300, 600) });
  });

  // The wire Books, the Deploy picker and the Dashboard all render.
  it("carries the cause's stamp and sentence on the wire", () => {
    const dll = "daily loss limit reached: lost $1,041.66 of a $1,000.00 limit today";
    const target = "daily profit target reached: up $1,250.00 on a $1,000.00 target today";
    const breach = "maximum loss limit reached: balance $47,999.99 is at or under its $48,000.00 floor";
    const gates = buildAccountGates({
      records: [
        record(1, { status: "locked", cause: "daily-loss", lockoutReason: dll }),
        record(2, { status: "locked", cause: "profit-target", lockoutReason: target }),
        record(3, { status: "dead", cause: "max-loss", lockoutReason: breach }),
        record(4, { status: "locked", cause: "website", lockoutReason: "Manual lockout" }),
      ],
      autoTrade: permitAll([1, 2, 3, 4]),
      inUse: new Set(),
      now: NOW,
    });
    expect(gates.map((g) => g.refusal)).toEqual([
      { kind: "locked", stamp: "DLL", reason: lockedRefusal(dll, null) },
      { kind: "locked", stamp: "Profit Target", reason: lockedRefusal(target, null) },
      { kind: "dead", stamp: "Max Loss", reason: `This account can no longer trade (${breach}). Use another account.` },
      { kind: "locked", stamp: "Locked", reason: lockedRefusal("Manual lockout", null) },
    ]);
  });

  it("offers a replacement only for a dead account something uses", () => {
    const records = [record(1, { status: "dead" }), record(2)];
    const unused = buildAccountGates({ records, autoTrade: permitAll([1, 2]), inUse: new Set(), now: NOW });
    expect(unused[0]?.replacements).toEqual([]);

    const used = buildAccountGates({ records, autoTrade: permitAll([1, 2]), inUse: new Set([1]), now: NOW });
    expect(used[0]?.replacements).toEqual([{ accountId: 2, name: "50KTC-2" }]);
    expect(used[1]?.replacements).toEqual([]);
  });

  it("never offers a candidate a deploy gate refuses — the live-account block or its own state", () => {
    const records = [record(1, { status: "dead" }), record(2), record(3, { autoOcoBrackets: null })];
    const gates = buildAccountGates({
      records,
      autoTrade: new Map<number, AutoTradeVerdict>([
        [1, { permitted: true }],
        [2, { permitted: false, reason: "live" }],
        [3, { permitted: true }],
      ]),
      inUse: new Set([1]),
      now: NOW,
    });
    expect(gates[0]?.replacements).toEqual([]);
  });

  it("does not offer a replacement for a locked account — only a dead one moves", () => {
    const gates = buildAccountGates({
      records: [record(1, { status: "locked" }), record(2)],
      autoTrade: permitAll([1, 2]),
      inUse: new Set([1]),
      now: NOW,
    });
    expect(gates[0]?.refusal?.kind).toBe("locked");
    expect(gates[0]?.replacements).toEqual([]);
  });
});
