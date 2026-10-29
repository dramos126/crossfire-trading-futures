/**
 * `orphanAbsentAccounts` — the per-arm orphan pass `/api/deployments/check-orphans`
 * runs, shared with the account-status check so a refresh that resets the
 * reconciler's 30-minute clock is still cross-checked. The attribution itself
 * is `attributeAbsentAccount`'s and is pinned beside the registry; this file
 * pins what the pass does around it.
 */
import { describe, it, expect, vi } from "vitest";
import { BrokerKind } from "@/lib/db/account-brokers";
import type { RefreshResult } from "../../broker-access/broker-registry";
import { orphanAbsentAccounts, type AbsentAccountPassDeps } from "./orphan-attribution";

const TOPSTEP = 5001;
const TRADOVATE = 7002;

function refresh(
  listed: RefreshResult["listed"],
  errors: Partial<RefreshResult["errors"]> = {},
): RefreshResult {
  const full = { topstep: null, tradovate: null, ...errors };
  return {
    partial: full.topstep !== null || full.tradovate !== null,
    errors: full,
    listed,
    cannotTrade: {
      topstep: listed.topstep === null ? null : [],
      tradovate: listed.tradovate === null ? null : [],
    },
    answeredAt: {
      topstep: listed.topstep === null ? null : "2026-10-14T21:00:00.000Z",
      tradovate: listed.tradovate === null ? null : "2026-10-14T21:00:00.000Z",
    },
    balances: { topstep: listed.topstep === null ? null : new Map(), tradovate: null },
    size: 0,
    removed: [],
    kindChanges: [],
  };
}

function makeDeps(registered: number[] = []) {
  const skipped: Array<{ accountId: number; reason: string }> = [];
  const deps = {
    isAccountRegistered: (id: number) => registered.includes(id),
    brokerOf: (id: number) => (id === TRADOVATE ? BrokerKind.Tradovate : BrokerKind.Topstep),
    handleOrphanedAccount: vi.fn(async (_id: number, _reason: string) => undefined),
    onSkip: (accountId: number, reason: string) => skipped.push({ accountId, reason }),
  } satisfies AbsentAccountPassDeps;
  return { deps, skipped };
}

const LEGS = [
  { accountId: TOPSTEP, orphanReason: null },
  { accountId: TOPSTEP, orphanReason: null },
  { accountId: TRADOVATE, orphanReason: null },
];

describe("orphanAbsentAccounts", () => {
  it("orphans each absent account once, under the reason it is given", async () => {
    const { deps } = makeDeps();
    const out = await orphanAbsentAccounts(
      LEGS,
      refresh({ topstep: [], tradovate: [] }),
      "periodic_account_check",
      deps,
    );
    expect(out).toEqual([TOPSTEP, TRADOVATE]);
    expect(deps.handleOrphanedAccount.mock.calls).toEqual([
      [TOPSTEP, "periodic_account_check"],
      [TRADOVATE, "periodic_account_check"],
    ]);
  });

  it("skips an account whose arm failed, and says so, while the other arm keeps detecting", async () => {
    const { deps, skipped } = makeDeps();
    const out = await orphanAbsentAccounts(
      LEGS,
      refresh({ topstep: [], tradovate: null }, { tradovate: "401" }),
      "periodic_account_check",
      deps,
    );
    expect(out).toEqual([TOPSTEP]);
    expect(skipped.map((s) => s.accountId)).toEqual([TRADOVATE]);
    expect(skipped[0]?.reason).toContain("401");
  });

  it("leaves an already-orphaned leg and a registered account alone", async () => {
    const { deps } = makeDeps([TOPSTEP]);
    const out = await orphanAbsentAccounts(
      [
        { accountId: TOPSTEP, orphanReason: null },
        { accountId: TRADOVATE, orphanReason: "periodic_account_check" },
      ],
      refresh({ topstep: [], tradovate: [] }),
      "periodic_account_check",
      deps,
    );
    expect(out).toEqual([]);
    expect(deps.handleOrphanedAccount).not.toHaveBeenCalled();
  });

  // The registry is live and the result is not: a concurrent refresh with no
  // Tradovate client empties the Tradovate entries after this result was
  // returned, while the result still says Tradovate answered. Reading only the
  // registry would orphan an account its own broker just listed.
  it("counts an account this refresh listed as present, whatever the registry holds by now", async () => {
    const { deps } = makeDeps();
    const out = await orphanAbsentAccounts(
      LEGS,
      refresh({ topstep: [TOPSTEP], tradovate: [TRADOVATE] }),
      "periodic_account_check",
      deps,
    );
    expect(out).toEqual([]);
    expect(deps.handleOrphanedAccount).not.toHaveBeenCalled();
  });
});
