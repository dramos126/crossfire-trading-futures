/**
 * `listManagedDeployments()` as the engine's single gate: what the engine
 * is allowed to trade is decided here, once, for every entry point. Plus
 * the P3 status vocabulary and the migration that produced it.
 *
 * Real in-memory better-sqlite3 with the shipped migrations replayed, per
 * the pattern in `auth.test.ts` — the point of these tests is that a row
 * sitting in the table as `Active` still does not reach the engine, and a
 * stubbed query could not show that. The migration tests need the real
 * thing for the same reason: the mapping is SQL over two tables and the
 * failure mode it guards against is a row silently coming back armed.
 *
 * `@/lib/trading/strategies` is mocked because `db/deployments` imports
 * it and the strategy loader uses webpack's `require.context`, which has
 * no vitest equivalent. Nothing under test calls it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: vi.fn(() => null),
}));

import { BrokerKind, setAccountBrokers } from "./account-brokers";
import {
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
// Namespace import so the allowlist can be spied per test: it is stored on
// `globalThis` and has no reset, and `vi.restoreAllMocks()` in afterEach is
// what keeps a staging test from leaking into the prod-path one.
import * as stagingAllowlist from "@/lib/trading/broker-access/staging-allowlist";
import {
  getDeployment,
  insertDeployment,
  listClosingDeployments,
  listDeployments,
  listManagedDeployments,
  listPendingReconciliationDeployments,
  patchWouldBeTradeable,
  readManagedDeployments,
  reapDestroyingDeployment,
  runPendingSessionMigrations,
  markOrphaned,
  clearOrphanedAndReEnable,
  settlePausingDeployment,
  softDeleteDeployment,
  updateDeployment,
} from "./deployments";
// Imported for its migration only, and deliberately *after* `deployments`:
// that is production's registration order (`instrumentation.ts` lists
// deployments first), so the status backfill's first pass runs against a
// database with no `strategy_trades` table and has to no-op through its
// existence guard.
import "./trades";
// Same reason, one shape later: every leg has a parent, so `updateDeployment`
// reads `deployment_groups` on any status write. That module owns the table
// and nothing in `deployments.ts` imports it — production loads both through
// the route graph, and this is the equivalent here.
import {
  beginGroupDestroy,
  disableGroupWithSnapshot,
  enableGroupAndRestore,
  getGroup,
  insertGroup,
  updateGroup,
} from "./deployment-groups";
import { AccountEntryGate } from "@/lib/trading/engine/engine-account-entry-gate";

const PRAC_ACCOUNT = 101;
const LIVE_ACCOUNT = 202;
const UNKNOWN_ACCOUNT = 303;

function deploy(
  accountId: number,
  status: "Active" | "Paused" = "Active",
  groupId = "parent-1",
): string {
  return insertDeployment({
    strategyKey: "orb",
    accountId,
    ticker: "/NQ",
    contractId: null,
    status,
    paramValues: { size: 1 },
    name: `depl-${accountId}`,
    groupId,
  }).id;
}

/** A row as it existed before P3: `enabled`, no `status`. Written with raw
 *  SQL because no exported writer can produce one any more, which is the
 *  point — the migration is the only thing that reads this shape. */
function legacyRow(opts: { id: string; enabled: 0 | 1; deletedAt?: string | null }): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO deployments (
      id, strategy_key, account_id, ticker, contract_id,
      status, enabled, param_values, created_at, updated_at, deleted_at
    ) VALUES (?, 'orb', ?, '/NQ', NULL, NULL, ?, '{"size":1}', ?, ?, ?)
  `).run(opts.id, PRAC_ACCOUNT, opts.enabled, now, now, opts.deletedAt ?? null);
}

function openTradeFor(deploymentId: string): void {
  db.prepare(`
    INSERT INTO strategy_trades (
      deployment_id, strategy_key, account_id, ticker, contract_id,
      side, size, entry_submitted_at, status
    ) VALUES (?, 'orb', ?, '/NQ', 'CON.F.US.NQ.Z26', 0, 1, ?, 'open')
  `).run(deploymentId, PRAC_ACCOUNT, new Date().toISOString());
}

/** Replay the whole queue, which is exactly what the next boot does. */
function rerunMigrations(): void {
  for (const fn of migrations) fn(db);
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  setAccountBrokers([
    {
      accountId: PRAC_ACCOUNT,
      broker: BrokerKind.Topstep,
      name: "PRAC-V2-12345",
      practice: true,
    },
    {
      accountId: LIVE_ACCOUNT,
      broker: BrokerKind.Topstep,
      name: "TSTX-441122",
      practice: false,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("listManagedDeployments — live-account block", () => {
  it("returns an active deployment on a practice account", () => {
    const id = deploy(PRAC_ACCOUNT);
    expect(listManagedDeployments().map((d) => d.id)).toEqual([id]);
  });

  it("withholds an active deployment on a live account", () => {
    const liveId = deploy(LIVE_ACCOUNT);
    const pracId = deploy(PRAC_ACCOUNT);
    // The row is genuinely Active in the table — this is the pre-block
    // row the second layer exists for, not a row the API would accept.
    expect(listDeployments().map((d) => d.id).sort()).toEqual([liveId, pracId].sort());
    expect(listManagedDeployments().map((d) => d.id)).toEqual([pracId]);
  });

  it("logs a warning naming the deployment it withheld", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const liveId = deploy(LIVE_ACCOUNT);
    listManagedDeployments();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain(liveId);
    warn.mockRestore();
  });

  it("withholds a deployment whose account has no catalog row", () => {
    deploy(UNKNOWN_ACCOUNT);
    expect(listManagedDeployments()).toEqual([]);
  });

  it("applies with no staging allowlist set, which is the prod path", () => {
    // The gap this closes: the allowlist is null on prod, so before this
    // filter a live-account row passed straight through.
    expect(stagingAllowlist.getStagingAllowlist()).toBeNull();
    deploy(LIVE_ACCOUNT);
    expect(listManagedDeployments()).toEqual([]);
  });

  it("does not resurrect a paused row on a permitted account", () => {
    deploy(PRAC_ACCOUNT, "Paused");
    expect(listManagedDeployments()).toEqual([]);
  });

  it("keeps a closing row on a withheld account so the close can finish", () => {
    // The block's subject is auto-trading. Withholding a `Pausing` row
    // would strand it — nothing else would ever flatten it — and it cannot
    // enter, because entry-eval gates on `Active`.
    const liveId = deploy(LIVE_ACCOUNT);
    updateDeployment(liveId, { status: "Pausing" });
    expect(listManagedDeployments().map((d) => d.id)).toEqual([liveId]);
    expect(readManagedDeployments().withheldLiveAccounts).toEqual([]);
  });
});

describe("listManagedDeployments — what the engine is handed", () => {
  it("includes both closing statuses alongside Active", () => {
    const active = deploy(PRAC_ACCOUNT);
    const pausing = deploy(PRAC_ACCOUNT);
    const destroying = deploy(PRAC_ACCOUNT);
    updateDeployment(pausing, { status: "Pausing" });
    updateDeployment(destroying, { status: "Destroying" });
    expect(listManagedDeployments().map((d) => d.id).sort()).toEqual(
      [active, pausing, destroying].sort(),
    );
  });

  it("drops a row the moment it settles to Paused", () => {
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    expect(settlePausingDeployment(id)).toBe(true);
    expect(listManagedDeployments()).toEqual([]);
  });
});

describe("settle and reap — the transitions the closing guard writes", () => {
  it("settles a Pausing row to Paused", () => {
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    expect(settlePausingDeployment(id)).toBe(true);
    expect(getDeployment(id)?.status).toBe("Paused");
  });

  it("refuses to settle a row the operator has already resumed", () => {
    // The guard between confirming flat and writing the completion. No
    // operator route writes this Resume any more — each refuses `Active` over
    // a closing row — so this pins defence in depth against a later writer.
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    updateDeployment(id, { status: "Active" });
    expect(settlePausingDeployment(id)).toBe(false);
    expect(getDeployment(id)?.status).toBe("Active");
  });

  it("reaps a Destroying row into the Trash, carrying its groupId", () => {
    const id = deploy(PRAC_ACCOUNT, "Active", "grp-1");
    updateDeployment(id, { status: "Destroying" });
    expect(reapDestroyingDeployment(id)).toEqual({ groupId: "grp-1" });
    const row = getDeployment(id);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.status).toBe("Paused");
  });

  it("does not reap a row that is merely Pausing", () => {
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    expect(reapDestroyingDeployment(id)).toBeUndefined();
    expect(getDeployment(id)?.deletedAt).toBeNull();
  });

  it("lists exactly the rows still owed a close", () => {
    const pausing = deploy(PRAC_ACCOUNT);
    const destroying = deploy(PRAC_ACCOUNT);
    deploy(PRAC_ACCOUNT);
    updateDeployment(pausing, { status: "Pausing" });
    updateDeployment(destroying, { status: "Destroying" });
    expect(listClosingDeployments().map((d) => d.id).sort()).toEqual(
      [pausing, destroying].sort(),
    );
  });

  it("excludes a trashed row from the closing list", () => {
    // Trash is settled by definition; the migration maps it to `Paused`
    // for the same reason. A closing sweep must not fire a market exit at
    // something the operator threw away.
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    softDeleteDeployment(id);
    expect(listClosingDeployments()).toEqual([]);
  });
});

describe("the status backfill migration", () => {
  it("maps an enabled row to Active", () => {
    legacyRow({ id: "legacy-on", enabled: 1 });
    rerunMigrations();
    expect(getDeployment("legacy-on")?.status).toBe("Active");
  });

  it("never re-arms a row the operator had disabled", () => {
    // The worst outcome this migration can produce. `NOT NULL DEFAULT
    // 'Active'` would do exactly that on the ALTER, which is why the
    // column is nullable and backfilled explicitly.
    legacyRow({ id: "legacy-off", enabled: 0 });
    rerunMigrations();
    expect(getDeployment("legacy-off")?.status).toBe("Paused");
    expect(listManagedDeployments()).toEqual([]);
  });

  it("maps a disabled row holding an open trade to Pausing, not Paused", () => {
    // D-4: a deployment that is not Active holds no position. This row is
    // not flat yet, so saying `Paused` would be a lie and would strand the
    // position — it is the state the exit-loop widening used to cover.
    legacyRow({ id: "legacy-in-pos", enabled: 0 });
    openTradeFor("legacy-in-pos");
    rerunMigrations();
    expect(getDeployment("legacy-in-pos")?.status).toBe("Pausing");
  });

  it("maps a trashed row to Paused even when a trade row is still open", () => {
    legacyRow({ id: "legacy-trash", enabled: 0, deletedAt: new Date().toISOString() });
    openTradeFor("legacy-trash");
    rerunMigrations();
    expect(getDeployment("legacy-trash")?.status).toBe("Paused");
  });

  it("maps an enabled-but-trashed row to Paused, not Active", () => {
    // Should not exist — `softDeleteDeployment` clears `enabled` — but the
    // `deleted_at IS NULL` clause is what makes the odd row fall to the
    // safe side rather than come back armed.
    legacyRow({ id: "legacy-weird", enabled: 1, deletedAt: new Date().toISOString() });
    rerunMigrations();
    expect(getDeployment("legacy-weird")?.status).toBe("Paused");
  });

  it("does not touch a row whose status has already been written", () => {
    // Re-running is the normal case: completion is not tracked across
    // boots. A second pass must not reinterpret `enabled`, which is now a
    // write-only mirror and lags a status the engine set.
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });
    rerunMigrations();
    expect(getDeployment(id)?.status).toBe("Pausing");
  });

  it("reads an unbackfilled row as Paused rather than Active", () => {
    // Fail-closed at the reader, not only at the writer.
    legacyRow({ id: "never-migrated", enabled: 1 });
    expect(getDeployment("never-migrated")?.status).toBe("Paused");
  });
});

describe("patchWouldBeTradeable — what PATCH /api/deployments/[id] screens", () => {
  const ON = { status: "Active" as const, accountId: PRAC_ACCOUNT };
  const OFF = { status: "Paused" as const, accountId: PRAC_ACCOUNT };

  it("screens a re-point while the row is already active", () => {
    expect(patchWouldBeTradeable(ON, { accountId: LIVE_ACCOUNT })).toBe(true);
  });

  it("screens a re-activate that names no account", () => {
    // The patch carries no accountId, so the resulting account is the
    // existing one — the clause that catches this is `nextStatus`, not
    // the account comparison.
    expect(patchWouldBeTradeable(OFF, { status: "Active" })).toBe(true);
  });

  it("screens a move that also pauses the row", () => {
    // Paused today, but the next toggle starts trading on an account
    // nothing ever screened.
    expect(patchWouldBeTradeable(ON, { status: "Paused", accountId: LIVE_ACCOUNT })).toBe(true);
  });

  it("does not screen a pause in place", () => {
    // The escape hatch: turning off or renaming a pre-block row must not
    // 403, or the operator cannot unwind it.
    expect(patchWouldBeTradeable(ON, { status: "Paused" })).toBe(false);
    // A rename carries neither field, so an already-paused row stays
    // editable through it.
    expect(patchWouldBeTradeable(OFF, {})).toBe(false);
  });

  it("does not screen an edit that leaves an Active row Active on its own account", () => {
    // deployments.md: an Active row on an account that turned dead, locked or
    // OCO-off is left alone; only a new arm is refused. A rename is not one.
    expect(patchWouldBeTradeable(ON, {})).toBe(false);
    expect(patchWouldBeTradeable(ON, { status: "Active" })).toBe(false);
    expect(patchWouldBeTradeable(ON, { accountId: PRAC_ACCOUNT })).toBe(false);
  });

  it("does not screen the close itself", () => {
    // `Pausing` is a flatten, and the live-account rule's scope is
    // auto-trading — refusing to close inverts it.
    expect(patchWouldBeTradeable(ON, { status: "Pausing" })).toBe(false);
    expect(patchWouldBeTradeable(ON, { status: "Destroying" })).toBe(false);
  });
});

describe("readManagedDeployments — telling the two empty results apart, on prod", () => {
  // The filter these cases run through is `autoTradeVerdict`, which is
  // env-aware: prod is the TOS rule alone. The fixtures answer the same on
  // either branch, so nothing here changes — but the engine filter is where
  // a staging narrowing would first be observable, and a case that names no
  // environment asserts against whichever branch the runner landed on.
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  });

  it("reports nothing withheld when the operator simply has nothing active", () => {
    deploy(PRAC_ACCOUNT, "Paused");
    const result = readManagedDeployments();
    expect(result.deployments).toEqual([]);
    expect(result.withheldLiveAccounts).toEqual([]);
  });

  it("names the withheld rows when every active row was refused", () => {
    const liveId = deploy(LIVE_ACCOUNT);
    const result = readManagedDeployments();
    // Empty either way — the difference the boot sequence acts on is
    // entirely in this second field.
    expect(result.deployments).toEqual([]);
    expect(result.withheldLiveAccounts).toEqual([
      { id: liveId, accountId: LIVE_ACCOUNT, reason: LIVE_ACCOUNT_REFUSAL },
    ]);
  });

  it("carries the recoverable reason for an account with no catalog row", () => {
    deploy(UNKNOWN_ACCOUNT);
    expect(readManagedDeployments().withheldLiveAccounts[0].reason).toBe(
      UNVERIFIED_ACCOUNT_REFUSAL,
    );
  });

  it("leaves the withheld list empty when a permitted row survives", () => {
    const pracId = deploy(PRAC_ACCOUNT);
    const result = readManagedDeployments();
    expect(result.deployments.map((d) => d.id)).toEqual([pracId]);
    expect(result.withheldLiveAccounts).toEqual([]);
  });

  // The staging half. `runBootSequence` reads this field to tell an
  // allowlist that dropped everything apart from an operator who enabled
  // nothing — both leave `deployments` empty.
  it("names the rows the staging allowlist dropped", () => {
    // An allowlist exists only on a staging boot, so this case says so —
    // the set is populated by `runBootSequence`, not read from the env.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    vi.spyOn(stagingAllowlist, "getStagingAllowlist").mockReturnValue(new Set([PRAC_ACCOUNT]));
    const otherPrac = 404;
    setAccountBrokers([
      {
        accountId: otherPrac,
        broker: BrokerKind.Topstep,
        name: "PRAC-V2-99999",
        practice: true,
      },
    ]);
    const offAllowlistId = deploy(otherPrac);

    const result = readManagedDeployments();

    expect(result.deployments).toEqual([]);
    expect(result.withheldLiveAccounts).toEqual([]);
    expect(result.skippedNotAllowed).toEqual([
      { id: offAllowlistId, accountId: otherPrac },
    ]);
  });
});

// ── markOrphaned must not retract an unfinished close ─────────────────
//
// `Paused` is a claim the deployment is flat. Writing it over `Pausing` or
// `Destroying` retracts the operator's own Destroy, drops the close
// obligation, and removes the row from `listClosingDeployments()` so the
// closing guard stops retrying — while the position is still open.
//
// Reachable with no operator action: `maybeOrphanFromBrokerError` fires on an
// `AccountNotFound` from the very `placeOrder` the guard just issued, and from
// the 30-minute account poll.

describe("markOrphaned and closing status", () => {
  it("preserves Pausing rather than claiming the deployment is flat", () => {
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Pausing" });

    expect(markOrphaned(id, "account gone")).toBe(true);

    const after = getDeployment(id);
    expect(after?.status).toBe("Pausing");
    expect(after?.orphanReason).toBe("account gone");
    // Still the closing guard's work — the obligation outlives the account's
    // reachability, and clear-orphan is the recovery path either way.
    expect(listClosingDeployments().map((d) => d.id)).toContain(id);
  });

  it("preserves Destroying, so an orphan cannot retract a Destroy", () => {
    const id = deploy(PRAC_ACCOUNT);
    updateDeployment(id, { status: "Destroying" });

    markOrphaned(id, "account gone");

    expect(getDeployment(id)?.status).toBe("Destroying");
    expect(listClosingDeployments().map((d) => d.id)).toContain(id);
  });

  it("still writes Paused for a row that is not closing", () => {
    const id = deploy(PRAC_ACCOUNT);

    markOrphaned(id, "account gone");

    expect(getDeployment(id)?.status).toBe("Paused");
    expect(listClosingDeployments()).toEqual([]);
  });
});

// ── Group destroy takes per-leg destroy's path ───────────────────────────────
// bugs/group-destroy-refuses-when-a-leg-holds-a-position-while-per.md

describe("group destroy closes a leg in position through Destroying and deletes a flat one now", () => {
  function group() {
    return insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: { size: 1 },
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    });
  }

  it("writes Destroying on a leg in position and deletes a flat sibling now", () => {
    const parent = group();
    const held = deploy(PRAC_ACCOUNT, "Active", parent.id);
    const flat = deploy(PRAC_ACCOUNT, "Active", parent.id);

    beginGroupDestroy(parent.id, (leg) => leg.id === held);

    expect(getDeployment(held)?.status).toBe("Destroying");
    expect(getDeployment(held)?.deletedAt).toBeNull();
    expect(listClosingDeployments().map((d) => d.id)).toEqual([held]);
    expect(getDeployment(flat)?.deletedAt).not.toBeNull();
    // The parent stays until the last Destroying leg is reaped, which runs
    // the engine's last-leg cascade.
    expect(getGroup(parent.id)?.deletedAt).toBeNull();
    expect(getGroup(parent.id)?.enabled).toBe(false);
  });

  it("never writes Paused over a leg already Destroying", () => {
    const parent = group();
    const id = deploy(PRAC_ACCOUNT, "Active", parent.id);
    updateDeployment(id, { status: "Destroying" });

    beginGroupDestroy(parent.id, () => true);

    expect(getDeployment(id)?.status).toBe("Destroying");
  });
});

// ── A detached row never enters, and still exits ─────────────────────────────
//
// A75: any path that writes `Active` without clearing the markers — a plain
// PATCH resume, a group resume restoring the leg from its snapshot — used to
// arm the row while the board said Detached. The refusal is the engine's entry
// gate reading this table, so these run the real gate over the real row.

describe("a detached Active row never enters, and stays in the exit loop", () => {
  const NOW = new Date("2026-10-23T15:00:00.000Z");
  // Wired as engine.ts wires it: the marker off the stored row.
  const entryGate = () =>
    new AccountEntryGate({
      readState: () => null,
      readOrphanReason: (id) => getDeployment(id)?.orphanReason ?? null,
      announce: vi.fn(),
    });

  it("never enters after a PATCH-shape resume that kept the markers", () => {
    const id = deploy(PRAC_ACCOUNT);
    markOrphaned(id, "account_unavailable_at_boot");
    updateDeployment(id, { status: "Active" });
    expect(getDeployment(id)?.orphanReason).toBe("account_unavailable_at_boot");

    expect(entryGate().skipsEntry(id, PRAC_ACCOUNT, NOW)).toBe(true);
  });

  it("never enters after a group resume restored it from its snapshot", () => {
    const parent = insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: { size: 1 },
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    });
    const id = deploy(PRAC_ACCOUNT, "Active", parent.id);
    disableGroupWithSnapshot(parent.id);
    markOrphaned(id, "account_unavailable_at_boot");
    enableGroupAndRestore(parent.id);
    expect(getDeployment(id)?.status).toBe("Active");

    expect(entryGate().skipsEntry(id, PRAC_ACCOUNT, NOW)).toBe(true);
  });

  it("still exits while in position: the row stays in the managed set, unreported as withheld", () => {
    const id = deploy(PRAC_ACCOUNT);
    openTradeFor(id);
    markOrphaned(id, "place_order_account_not_found");
    updateDeployment(id, { status: "Active" });

    const read = readManagedDeployments();
    expect(read.deployments.map((d) => d.id)).toEqual([id]);
    expect(read.withheldLiveAccounts).toEqual([]);
  });

  it("enters again once the markers are cleared", () => {
    const id = deploy(PRAC_ACCOUNT);
    markOrphaned(id, "account gone");
    clearOrphanedAndReEnable(id);
    expect(listManagedDeployments().map((d) => d.id)).toEqual([id]);
    expect(entryGate().skipsEntry(id, PRAC_ACCOUNT, NOW)).toBe(false);
  });
});

// ── Params live on the parent ────────────────────────────────────────────────

describe("params live on the parent, and a leg has no fallback of its own", () => {
  it("reads a leg's params off its parent", () => {
    const parent = insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: { size: 4, riskRewardRatio: 3 },
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    });
    const id = deploy(PRAC_ACCOUNT, "Active", parent.id);

    expect(getDeployment(id)?.paramValues).toEqual({ size: 4, riskRewardRatio: 3 });
  });

  it("follows the parent when the parent is edited, with no per-leg write", () => {
    // The reconciliation this deletes: `syncLegsFromGroup` used to copy the
    // blob onto every leg, so a leg could hold a stale copy of its own
    // config. There is one source now and the next read is the edit.
    const parent = insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: { size: 1 },
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    });
    const id = deploy(PRAC_ACCOUNT, "Active", parent.id);

    updateGroup(parent.id, { paramValues: { size: 7 } });

    expect(getDeployment(id)?.paramValues).toEqual({ size: 7 });
  });

  it("answers an empty blob for a leg whose parent is gone, never the leg row", () => {
    // A soft-delete cascade caught mid-flight, or a row predating this
    // shape. An empty blob resolves no size, which is the engine's
    // skip-the-tick path — a fallback to a per-leg blob would be the second
    // source this decision exists to remove.
    const id = deploy(PRAC_ACCOUNT, "Active", "no-such-parent");

    expect(getDeployment(id)?.paramValues).toEqual({});
  });

  it("does not write params through a leg patch", () => {
    const parent = insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: { size: 2 },
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    });
    const id = deploy(PRAC_ACCOUNT, "Active", parent.id);

    updateDeployment(id, { status: "Paused", name: "renamed" });

    const after = getDeployment(id);
    expect(after?.name).toBe("renamed");
    expect(after?.paramValues).toEqual({ size: 2 });
  });
});

// ── The session migration writes to the parent, so it blocks on the parent ───

describe("runPendingSessionMigrations — the block is a property of the parent", () => {
  const EXTRAS = [{ start: "18:00", end: "20:00" }];

  function legacyParent(id: string): string {
    return insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: {
        size: 1,
        mainSession: { start: "09:30", end: "16:00", timezone: "America/New_York" },
        additionalSessions: EXTRAS,
      } as never,
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    }).id;
  }

  function parentParams(id: string): Record<string, unknown> {
    const row = db
      .prepare(`SELECT param_values FROM deployment_groups WHERE id = ?`)
      .get(id) as { param_values: string };
    return JSON.parse(row.param_values);
  }

  it("leaves a flat leg alone when a sibling holds a position", async () => {
    // The hazard: the flat leg's write strips `additionalSessions` from the
    // parent, which is where the in-position sibling reads its windows. It
    // stays `Active`, sees fewer windows on the next tick, and gets
    // force-flattened by `time_window_close` — while the banner says it was
    // blocked pending review.
    const parentId = legacyParent("p1");
    const flat = deploy(PRAC_ACCOUNT, "Active", parentId);
    const holding = deploy(LIVE_ACCOUNT, "Active", parentId);

    const { migrated, blocked } = await runPendingSessionMigrations({
      hasOpenPosition: async (d) => d.id === holding,
    });

    expect(migrated).toEqual([]);
    expect(blocked.map((d) => d.id).sort()).toEqual([flat, holding].sort());
    expect(parentParams(parentId).additionalSessions).toEqual(EXTRAS);
    expect(getDeployment(flat)?.status).toBe("Active");
    expect(getDeployment(flat)?.pendingReconciliation).toBeNull();
  });

  it("migrates a parent whose legs are all flat", async () => {
    const parentId = legacyParent("p2");
    const a = deploy(PRAC_ACCOUNT, "Active", parentId);
    const b = deploy(LIVE_ACCOUNT, "Active", parentId);

    const { migrated, blocked } = await runPendingSessionMigrations({
      hasOpenPosition: async () => false,
    });

    expect(blocked).toEqual([]);
    expect(migrated.map((d) => d.id).sort()).toEqual([a, b].sort());
    expect(parentParams(parentId).additionalSessions).toBeUndefined();
    expect(getDeployment(a)?.status).toBe("Paused");
    expect(getDeployment(b)?.pendingReconciliation).not.toBeNull();
  });

  it("does not let one blocked parent stop another", async () => {
    const blockedParent = legacyParent("p3");
    const cleanParent = legacyParent("p4");
    const holding = deploy(LIVE_ACCOUNT, "Active", blockedParent);
    const clean = deploy(PRAC_ACCOUNT, "Active", cleanParent);

    const { migrated, blocked } = await runPendingSessionMigrations({
      hasOpenPosition: async (d) => d.id === holding,
    });

    expect(blocked.map((d) => d.id)).toEqual([holding]);
    expect(migrated.map((d) => d.id)).toEqual([clean]);
    expect(parentParams(blockedParent).additionalSessions).toEqual(EXTRAS);
    expect(parentParams(cleanParent).additionalSessions).toBeUndefined();
  });

  it("reads a throwing broker check as in-position for the whole parent", async () => {
    const parentId = legacyParent("p5");
    const flat = deploy(PRAC_ACCOUNT, "Active", parentId);
    const unknown = deploy(LIVE_ACCOUNT, "Active", parentId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { migrated, blocked } = await runPendingSessionMigrations({
      hasOpenPosition: async (d) => {
        if (d.id === unknown) throw new Error("broker unreachable");
        return false;
      },
    });

    expect(migrated).toEqual([]);
    expect(blocked.map((d) => d.id).sort()).toEqual([flat, unknown].sort());
    expect(parentParams(parentId).additionalSessions).toEqual(EXTRAS);
    warn.mockRestore();
  });
});

// ── The banner has to be answerable ──────────────────────────────────────────

describe("pending_reconciliation clears on the parent's session save", () => {
  /** A leg the session-migration runner flagged. Written with SQL because
   *  no exported writer sets the column outside the runner itself. */
  function flag(legId: string, reason = "multi-session migration: review session config"): void {
    db.prepare(`UPDATE deployments SET pending_reconciliation = ? WHERE id = ?`).run(
      reason,
      legId,
    );
  }

  function parentWith(paramValues: Record<string, unknown>): string {
    return insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: paramValues as never,
      ticker: "/NQ",
      contractId: null,
      enabled: true,
    }).id;
  }

  // The pause list is the whole of the session config a save can move now:
  // the trading window is the playbook's `config.session` and no patch
  // reaches it. `mainSession` stays in `SESSION_PARAM_KEYS` for the flagged
  // rows still carrying it, but nothing writes one.
  it("clears every leg when the save changes the pause windows", () => {
    const parentId = parentWith({ size: 1, pauseWindows: [] });
    const a = deploy(PRAC_ACCOUNT, "Paused", parentId);
    const b = deploy(LIVE_ACCOUNT, "Paused", parentId);
    flag(a);
    flag(b);

    updateGroup(parentId, {
      paramValues: { size: 1, pauseWindows: [{ start: "12:00", end: "13:00" }] },
    });

    expect(getDeployment(a)?.pendingReconciliation).toBeNull();
    expect(getDeployment(b)?.pendingReconciliation).toBeNull();
    expect(listPendingReconciliationDeployments()).toEqual([]);
  });

  it("leaves the flag alone on a save that touches no session key", () => {
    // The flag is not dismissable on its own — a rename is not the
    // operator answering the banner.
    const parentId = parentWith({ size: 1, pauseWindows: [] });
    const a = deploy(PRAC_ACCOUNT, "Paused", parentId);
    flag(a);

    updateGroup(parentId, { name: "renamed" });
    updateGroup(parentId, { paramValues: { size: 5, pauseWindows: [] } });

    expect(getDeployment(a)?.pendingReconciliation).toBe(
      "multi-session migration: review session config",
    );
    expect(listPendingReconciliationDeployments().map((d) => d.id)).toEqual([a]);
  });

  it("does not reach a leg under a different parent", () => {
    const flagged = parentWith({ size: 1, pauseWindows: [] });
    const other = parentWith({ size: 1, pauseWindows: [] });
    const mine = deploy(PRAC_ACCOUNT, "Paused", flagged);
    const theirs = deploy(LIVE_ACCOUNT, "Paused", other);
    flag(mine);
    flag(theirs);

    updateGroup(flagged, {
      paramValues: { size: 1, pauseWindows: [{ start: "12:00", end: "13:00" }] },
    });

    expect(getDeployment(mine)?.pendingReconciliation).toBeNull();
    expect(getDeployment(theirs)?.pendingReconciliation).not.toBeNull();
  });
});

// ── The wipe was skipped ─────────────────────────────────────────────────────

describe("rows that predate one-deployment-N-legs", () => {
  /** A parentless leg. No exported writer can produce one, which is the
   *  point — only a database that skipped the wipe holds these. */
  function parentlessRow(id: string): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO deployments (
        id, strategy_key, account_id, ticker, contract_id,
        status, enabled, param_values, created_at, updated_at, group_id
      ) VALUES (?, 'orb', ?, '/NQ', NULL, 'Active', 1, '{"size":1}', ?, ?, NULL)
    `).run(id, PRAC_ACCOUNT, now, now);
  }

  it("reports them at error level, naming the row and the remedy", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    parentlessRow("stale-1");

    rerunMigrations();

    const said = error.mock.calls.flat().join(" ");
    expect(said).toContain("stale-1");
    expect(said).toContain("wipe, not a migration");
    error.mockRestore();
  });

  it("says nothing on a database that has none", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deploy(PRAC_ACCOUNT);

    rerunMigrations();

    expect(error.mock.calls.flat().join(" ")).not.toContain("predate");
    error.mockRestore();
  });

  it("leaves the row inert rather than refusing to read the table", () => {
    // It resolves no size, so the engine skips its tick and it never
    // trades. Refusing to open the database would take Settings down with
    // it and leave nowhere to fix anything from.
    parentlessRow("stale-2");

    expect(getDeployment("stale-2")?.paramValues).toEqual({});
    expect(listDeployments().map((d) => d.id)).toContain("stale-2");
  });
});
