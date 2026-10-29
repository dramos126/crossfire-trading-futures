/**
 * The only writer that un-detaches a row, and the one state it must refuse.
 *
 * `markOrphaned` deliberately preserves `Pausing` / `Destroying` — the close
 * is owed whether or not the account answers — so a detached row can be
 * mid-close. `clearOrphanedAndReEnable` writes `status = 'Active',
 * enabled = 1` unconditionally, so without the guard below a restore retracts
 * the operator's own Destroy, drops the row out of `listClosingDeployments()`
 * and re-arms entries over a position that is still open
 * ([deployments.md](../../../../../../docs/modules/trading/deployments.md),
 * the status table's rule; [bugs.md](../../../../../../docs/bugs.md) A74).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const H = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  clearOrphanedAndReEnable: vi.fn(),
  listManagedDeployments: vi.fn(() => []),
  screenAccountsForAutoTrade: vi.fn<() => { message: string } | null>(() => null),
  sync: vi.fn(),
  emitDeploymentsChanged: vi.fn(),
  listDerivedRows: vi.fn<() => Array<{ groupId: string; bookId: string; strategyKey: string; enabled: boolean }>>(() => []),
  enableGroupAndRestore: vi.fn(),
  updateGroup: vi.fn(),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: H.getDeployment,
  clearOrphanedAndReEnable: H.clearOrphanedAndReEnable,
  listManagedDeployments: H.listManagedDeployments,
}));
vi.mock("@/lib/db/books", () => ({
  listDerivedRows: H.listDerivedRows,
}));
// The two writers that could turn a parent on. The route must reach neither:
// enabling the parent would restore every sibling leg from its snapshot.
vi.mock("@/lib/db/deployment-groups", () => ({
  enableGroupAndRestore: H.enableGroupAndRestore,
  updateGroup: H.updateGroup,
}));
vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: H.screenAccountsForAutoTrade,
}));
vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: () => ({ sync: H.sync }),
}));
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: () => ({ emitDeploymentsChanged: H.emitDeploymentsChanged }),
}));

import { POST } from "./route";
import {
  RESTORE_NEEDS_PLAYBOOK_ON,
  RESTORE_WOULD_RETRACT_A_CLOSE,
  type DeploymentStatus,
} from "@/lib/trading/domain";

const ID = "leg-orb";
const GROUP_ID = "grp-orb";

function detachedRow(status: DeploymentStatus) {
  return {
    id: ID,
    accountId: 5001,
    status,
    groupId: GROUP_ID,
    orphanReason: "place_order_account_not_found",
    orphanedAt: "2026-09-20T14:02:11.000Z",
  };
}

function request(): NextRequest {
  return new NextRequest(`http://localhost/api/deployments/${ID}/clear-orphan`, {
    method: "POST",
    headers: { "x-session-token": "tok" },
  });
}

function ctx() {
  return { params: Promise.resolve({ id: ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.screenAccountsForAutoTrade.mockReturnValue(null);
  H.listManagedDeployments.mockReturnValue([]);
  H.listDerivedRows.mockReturnValue([]);
});

describe("POST /api/deployments/[id]/clear-orphan refuses a row that still owes a close", () => {
  for (const status of ["Pausing", "Destroying"] as const) {
    it(`409s on a detached ${status} row and writes nothing`, async () => {
      H.getDeployment.mockReturnValue(detachedRow(status));

      const res = await POST(request(), ctx());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: RESTORE_WOULD_RETRACT_A_CLOSE });
      expect(H.clearOrphanedAndReEnable).not.toHaveBeenCalled();
      // No engine sync and no broadcast either: nothing changed, and a
      // `deploymentsChanged` off a refusal would make the board refetch a row
      // it is already rendering correctly.
      expect(H.sync).not.toHaveBeenCalled();
      expect(H.emitDeploymentsChanged).not.toHaveBeenCalled();
    });
  }

  it("still restores a detached Paused row, which is the whole point of the route", async () => {
    H.getDeployment.mockReturnValue(detachedRow("Paused"));

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(H.clearOrphanedAndReEnable).toHaveBeenCalledWith(ID);
    expect(H.emitDeploymentsChanged).toHaveBeenCalledTimes(1);
    expect(H.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing a row that is not orphaned at all", async () => {
    H.getDeployment.mockReturnValue({ ...detachedRow("Paused"), orphanReason: null });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(409);
    expect(H.clearOrphanedAndReEnable).not.toHaveBeenCalled();
  });

  it("keeps the live-account refusal in front of the write", async () => {
    H.getDeployment.mockReturnValue(detachedRow("Paused"));
    H.screenAccountsForAutoTrade.mockReturnValue({ message: "live account refusal" });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "live account refusal" });
    expect(H.clearOrphanedAndReEnable).not.toHaveBeenCalled();
  });

  // A77's order: a refusal waiting will not clear answers before a sentence
  // that says to wait. Restoring a live account's row is never allowed.
  it("answers the live-account 403 ahead of the close, which clears by waiting", async () => {
    H.getDeployment.mockReturnValue(detachedRow("Pausing"));
    H.screenAccountsForAutoTrade.mockReturnValue({ message: "live account refusal" });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "live account refusal" });
  });
});

describe("POST /api/deployments/[id]/clear-orphan on a book's row under a switched-off playbook (bugs.md A85)", () => {
  function derived(groupId: string, enabled: boolean) {
    return { groupId, bookId: "book-1", strategyKey: "orb", enabled };
  }

  it("409s with RESTORE_NEEDS_PLAYBOOK_ON and writes neither the leg nor the group", async () => {
    // `clearOrphanedAndReEnable` writes the leg `Active` and leaves the parent
    // off, so the leg would not trade and would hold its own slot — every
    // book control on the cell then refuses.
    H.getDeployment.mockReturnValue(detachedRow("Paused"));
    H.listDerivedRows.mockReturnValue([derived(GROUP_ID, false)]);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RESTORE_NEEDS_PLAYBOOK_ON });
    expect(H.clearOrphanedAndReEnable).not.toHaveBeenCalled();
    expect(H.enableGroupAndRestore).not.toHaveBeenCalled();
    expect(H.updateGroup).not.toHaveBeenCalled();
    expect(H.sync).not.toHaveBeenCalled();
    expect(H.emitDeploymentsChanged).not.toHaveBeenCalled();
  });

  it("answers a row still owing a close with the close's sentence, not the book's", async () => {
    // The book's sentence names off-and-on, and the on half is itself refused
    // over a `Pausing` leg; waiting comes first.
    H.getDeployment.mockReturnValue(detachedRow("Pausing"));
    H.listDerivedRows.mockReturnValue([derived(GROUP_ID, false)]);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RESTORE_WOULD_RETRACT_A_CLOSE });
  });

  it("answers the live-account 403 ahead of the book's sentence", async () => {
    // The book's on is refused on a live account too, so its sentence would
    // send the operator to a press that cannot work.
    H.getDeployment.mockReturnValue(detachedRow("Paused"));
    H.listDerivedRows.mockReturnValue([derived(GROUP_ID, false)]);
    H.screenAccountsForAutoTrade.mockReturnValue({ message: "live account refusal" });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(403);
    expect(H.clearOrphanedAndReEnable).not.toHaveBeenCalled();
  });

  it("still restores a book's row whose playbook is switched on", async () => {
    H.getDeployment.mockReturnValue(detachedRow("Paused"));
    H.listDerivedRows.mockReturnValue([derived(GROUP_ID, true)]);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(H.clearOrphanedAndReEnable).toHaveBeenCalledWith(ID);
    expect(H.enableGroupAndRestore).not.toHaveBeenCalled();
    expect(H.sync).toHaveBeenCalledTimes(1);
  });

  it("still restores a hand-made row, even beside a book's switched-off row", async () => {
    // Keyed on this row's own parent: another group's derived row says
    // nothing about it.
    H.getDeployment.mockReturnValue(detachedRow("Paused"));
    H.listDerivedRows.mockReturnValue([derived("grp-other", false)]);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(H.clearOrphanedAndReEnable).toHaveBeenCalledWith(ID);
  });
});
