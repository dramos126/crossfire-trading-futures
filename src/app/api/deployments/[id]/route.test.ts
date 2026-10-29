/**
 * The closing-guard nudge on the two deployment-level status writers.
 *
 * D-5 is unchanged and is what this file has to keep honest: the request
 * returns at the *status write*, never at flat. What was wrong was the delay
 * before the first attempt — the status landed and then nothing happened
 * until the closing guard's 15s interval came round. Measured on a live local
 * instance: `Pausing` at t+0.0s, exit submitted at t+7.0s, filled at t+7.8s.
 * The broker took 0.8s; the other 7 were a poll nobody needed to wait for.
 *
 * Two properties, and the second is the one that keeps the first honest:
 * a row that entered a transient state gets a pass now, and a Pause that
 * wrote `Paused` directly does not — there is nothing to flatten, and firing
 * a sweep on every pause would make the nudge a heartbeat rather than a
 * response to work being created.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const DEPLOYMENT = {
  id: "dep-1",
  name: "Demo Fixture (TEST)",
  groupId: null,
  accountId: 90055646,
  ticker: "/MNQ",
  strategyKey: "demo-fixture.test",
  status: "Active",
  deletedAt: null,
  orphanReason: null,
  paramValues: {},
};

vi.mock("@/lib/db/deployments", () => ({
  clearOrphaned: vi.fn(),
  deleteDeployment: vi.fn(() => true),
  findConflictingDeployments: vi.fn(() => []),
  filterMainSessionOverlaps: vi.fn(() => []),
  readMainSession: vi.fn(() => null),
  sessionForStrategyKey: vi.fn(() => ({ start: "09:30", end: "16:00", timezone: "America/New_York" })),
  getDeployment: vi.fn(() => DEPLOYMENT),
  listManagedDeployments: vi.fn(() => [DEPLOYMENT]),
  listGroupLegs: vi.fn(() => []),
  patchWouldBeTradeable: vi.fn(() => false),
  softDeleteDeployment: vi.fn(() => true),
  updateDeployment: vi.fn((_id: string, patch: { status?: string }) => ({
    ...DEPLOYMENT,
    ...patch,
  })),
}));

vi.mock("@/lib/db/trades", () => ({
  getOpenTradeForDeployment: vi.fn(() => null),
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  softDeleteGroup: vi.fn(),
}));

vi.mock("@/lib/db/books", () => ({
  listDerivedRows: vi.fn(() => []),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: vi.fn(() => null),
}));

// The broker arm of the position gate never runs here — `holdsPosition`
// answers from the trade row or the engine mirror — but the module reaches a
// broker registry at import, so it is stubbed rather than loaded.
vi.mock("@/lib/trading/broker-access/open-position-lookup", () => ({
  createOpenPositionLookup: vi.fn(() => ({})),
  hasOpenPositionOnBroker: vi.fn(async () => false),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(),
}));

import { PATCH, DELETE } from "./route";
import { getEngineIfReady } from "@/lib/trading/engine/engine-singleton";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { EventBroadcaster } from "@/lib/realtime/event-broadcaster";
import type { BroadcastEvent, BroadcasterDeps } from "@/lib/realtime/event-broadcaster";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import {
  clearOrphaned,
  filterMainSessionOverlaps,
  getDeployment,
  patchWouldBeTradeable,
  softDeleteDeployment,
  updateDeployment,
} from "@/lib/db/deployments";
import { listDerivedRows } from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  MOVE_NEEDS_A_PAUSED_LEG,
  MOVE_WOULD_MISDIRECT_A_CLOSE,
  RESUME_WOULD_RETRACT_A_CLOSE,
} from "@/lib/trading/domain";

function request(method: "PATCH" | "DELETE", body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/deployments/dep-1", {
    method,
    // `requireSession` reads the `x-session-token` header, not a cookie.
    headers: { "content-type": "application/json", "x-session-token": "test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = { params: Promise.resolve({ id: "dep-1" }) } as never;

describe("the closing-guard nudge on /api/deployments/[id]", () => {
  let sync: ReturnType<typeof vi.fn>;
  let nudgeClosingGuard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sync = vi.fn();
    nudgeClosingGuard = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard,
      peekState: () => ({ position: null }),
    } as never);
  });

  it("fires one pass when a Pause on a deployment in position writes `Pausing`", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployment: { status: "Pausing" } });
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the pause wrote `Paused` directly — nothing to flatten", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployment: { status: "Paused" } });
    expect(nudgeClosingGuard).not.toHaveBeenCalled();
  });

  it("fires one pass when a delete on a deployment in position writes `Destroying`", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);

    const res = await DELETE(request("DELETE"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ destroying: true });
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
  });

  it("returns its normal response when the engine is null", async () => {
    // `getEngineIfReady` is null before boot and after either fatal-auth
    // stop(); the route must still complete its DB work and answer normally.
    vi.mocked(getEngineIfReady).mockReturnValue(null as never);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);

    const patched = await PATCH(request("PATCH", { status: "Paused" }), ctx);
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ deployment: { status: "Pausing" } });

    const deleted = await DELETE(request("DELETE"), ctx);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, destroying: true });
  });
});

/**
 * The deployment lifecycle event, on the two deployment-level mutators.
 *
 * `useDeployments` hydrates once on mount and nothing re-reads the list on a
 * timer, so before this event a pause in one tab never reached another —
 * not late, never, until that tab reloaded or ran a mutation of its own.
 * The relay carried `order`, `position`, `userTrade`, `marketTrade`,
 * `strategyTrade` and `status`, and no deployment event at all.
 *
 * The subscriber here is a real `EventBroadcaster` rather than a spy: the
 * property under test spans two modules — the route decides *when*, the
 * broadcaster decides *what reaches a listener* — and a stub on that seam
 * agrees with whichever side is wrong.
 *
 * Both halves are asserted. Every return downstream of a mutation emits,
 * whatever status the caller sees; every gate upstream of one does not,
 * because "always emit" and "emit iff something committed" are
 * indistinguishable from the downstream cases alone.
 */
describe("the deployment lifecycle event on /api/deployments/[id]", () => {
  let broadcaster: EventBroadcaster;
  let seen: BroadcastEvent[];
  let subscriber: Mock<(event: BroadcastEvent) => void>;

  beforeEach(() => {
    // `clearAllMocks` clears calls, not implementations, so the DB doubles
    // are re-seeded here rather than inherited from whichever test ran last.
    vi.clearAllMocks();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    vi.mocked(getDeployment).mockReturnValue(DEPLOYMENT as never);
    vi.mocked(updateDeployment).mockImplementation(
      (_id: string, patch: { status?: string }) => ({ ...DEPLOYMENT, ...patch }) as never,
    );
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync: vi.fn(),
      nudgeClosingGuard: vi.fn(),
      peekState: () => ({ position: null }),
    } as never);
    broadcaster = new EventBroadcaster({
      userEvents: {
        retain: async () => {},
        isConnected: () => true,
        onPosition: () => {},
        onFill: () => {},
        onStatus: () => {},
      },
      marketTrades: { subscribe: async () => {}, unsubscribe: async () => {} },
      marketDataContractId: async () => null,
    } satisfies BroadcasterDeps);
    seen = [];
    // A spy rather than a bare closure so `invocationCallOrder` is available
    // to the ordering assertion below.
    subscriber = vi.fn((e: BroadcastEvent) => {
      seen.push(e);
    });
    broadcaster.subscribe("board", subscriber);
    vi.mocked(peekBroadcaster).mockReturnValue(broadcaster);
  });

  it("reaches a subscriber when a pause writes `Paused`", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("reaches a subscriber when a pause writes `Pausing`", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);

    await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("emits after the orphan markers are cleared, not before", async () => {
    // A reassignment clears the orphan markers on the way out. The emit sits
    // *below* that, on the DELETE site's rule: the refetch a listener runs on
    // this frame must not read a row one statement from losing them. Nothing
    // between the two awaits today, so above would be safe by accident —
    // which is exactly the kind of safety that stops holding when someone
    // adds an await.
    vi.mocked(getDeployment).mockReturnValue({
      ...DEPLOYMENT,
      status: "Paused",
      orphanReason: "account_missing",
    } as never);

    const res = await PATCH(request("PATCH", { accountId: 5002, status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(clearOrphaned)).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
    expect(subscriber.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(clearOrphaned).mock.invocationCallOrder[0],
    );
  });

  it("emits when a delete in position writes `Destroying`", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);

    const res = await DELETE(request("DELETE"), ctx);

    expect(await res.json()).toMatchObject({ destroying: true });
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("emits when a delete soft-deletes the row", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await DELETE(request("DELETE"), ctx);

    expect(await res.json()).toMatchObject({ ok: true, destroying: false });
    expect(vi.mocked(softDeleteDeployment)).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("stays silent on a gate that rejects before mutating", async () => {
    // `Pausing` from a client is a 400 — the claim that a close is under way
    // is the engine's to make. Nothing was written, so nothing is announced.
    const res = await PATCH(request("PATCH", { status: "Pausing" }), ctx);

    expect(res.status).toBe(400);
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("stays silent when the row update itself fails", async () => {
    vi.mocked(updateDeployment).mockImplementation(() => {
      throw new Error("db is gone");
    });
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(500);
    expect(seen).toEqual([]);
  });

  it("answers normally when no broadcaster exists yet", async () => {
    // Null before the engine has built its realtime transports, and on an
    // install with `USE_REALTIME_BARS=false`. The mutation still commits.
    vi.mocked(peekBroadcaster).mockReturnValue(null);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployment: { status: "Paused" } });
  });
});

describe("a leg's PATCH refuses what lives on its parent", () => {
  const ctx = { params: Promise.resolve({ id: "dep-1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEngineIfReady).mockReturnValue(null);
    vi.mocked(peekBroadcaster).mockReturnValue(null);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  it("400s a body carrying paramValues rather than dropping it", async () => {
    // Silently ignoring it answers 200 to an edit that did not happen —
    // which, on the field that carries `size`, is the operator believing
    // they resized a deployment that will keep placing the old number.
    const res = await PATCH(request("PATCH", { paramValues: { size: 9 } }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Parameters are edited on the deployment, not on a leg.",
    });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });
});

describe("the instrument is pinned at creation", () => {
  const ctx = { params: Promise.resolve({ id: "dep-1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEngineIfReady).mockReturnValue(null);
    vi.mocked(peekBroadcaster).mockReturnValue(null);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  // A capability removal, not a refactor: a standalone deployment could be
  // re-pointed at a different instrument until the one-shape model. Changing
  // it leaves one row whose trade history spans two instruments.
  for (const field of ["ticker", "strategyKey"] as const) {
    it(`400s a body naming ${field}, pointing at delete-and-recreate`, async () => {
      const res = await PATCH(request("PATCH", { [field]: "/ES" }), ctx);

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Delete this deployment");
      expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    });
  }

  it("still moves a leg onto a different account, which is orphan recovery", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Paused" } as never);
    const res = await PATCH(request("PATCH", { accountId: 5002, status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith(
      "dep-1",
      expect.objectContaining({ accountId: 5002 }),
    );
  });
});

/**
 * The reconciler is the only writer of a derived row's state — a direct
 * status write here would make this leg its own slot holder, and the book
 * grid's toggle could never resume it. Checked ahead of the screen and the
 * broker-backed position gate, before any write.
 */
describe("a derived leg's status is the reconciler's to write", () => {
  const ctx = { params: Promise.resolve({ id: "dep-1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEngineIfReady).mockReturnValue(null);
    vi.mocked(peekBroadcaster).mockReturnValue(null);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, groupId: "group-1" } as never);
  });

  it("409s with BOOK_DERIVED_ROW_REFUSAL and writes nothing when the parent group is a book's", async () => {
    vi.mocked(listDerivedRows).mockReturnValue([
      { groupId: "group-1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: true },
    ]);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BOOK_DERIVED_ROW_REFUSAL });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });

  it("writes exactly as before when the parent group is hand-made", async () => {
    vi.mocked(listDerivedRows).mockReturnValue([]);

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledTimes(1);
  });
});

/**
 * A77, operator decision 2026-10-07: `Active` over a close in flight is
 * refused on the server, not only by the board's inert `▶`. The write would
 * drop the row out of `listClosingDeployments()` and re-arm entries with the
 * position open. Only the resume direction — a pause during a close is the
 * operator escalating, and stays allowed.
 */
describe("Active on a leg still closing is refused, and nothing is written", () => {
  let sync: ReturnType<typeof vi.fn>;
  let seen: BroadcastEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    sync = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard: vi.fn(),
      peekState: () => ({ position: null }),
    } as never);
    const broadcaster = new EventBroadcaster({
      userEvents: {
        retain: async () => {},
        isConnected: () => true,
        onPosition: () => {},
        onFill: () => {},
        onStatus: () => {},
      },
      marketTrades: { subscribe: async () => {}, unsubscribe: async () => {} },
      marketDataContractId: async () => null,
    } satisfies BroadcasterDeps);
    seen = [];
    broadcaster.subscribe("board", (e: BroadcastEvent) => {
      seen.push(e);
    });
    vi.mocked(peekBroadcaster).mockReturnValue(broadcaster);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);
    vi.mocked(listDerivedRows).mockReturnValue([]);
    vi.mocked(patchWouldBeTradeable).mockReturnValue(false);
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue(null);
    vi.mocked(updateDeployment).mockImplementation(
      (_id: string, patch: { status?: string }) => ({ ...DEPLOYMENT, ...patch }) as never,
    );
  });

  function closing(status: "Pausing" | "Destroying") {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status } as never);
  }

  it.each(["Pausing", "Destroying"] as const)(
    "409s {status: Active} on a %s leg with RESUME_WOULD_RETRACT_A_CLOSE, writing and announcing nothing",
    async (status) => {
      closing(status);

      const res = await PATCH(request("PATCH", { status: "Active" }), ctx);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: RESUME_WOULD_RETRACT_A_CLOSE });
      expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
      expect(vi.mocked(clearOrphaned)).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    },
  );

  it("refuses the whole body, so a re-point riding the resume is not written either", async () => {
    closing("Pausing");

    const res = await PATCH(request("PATCH", { status: "Active", accountId: 5002 }), ctx);

    expect(res.status).toBe(409);
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });

  it("resumes a settled Paused leg exactly as before", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Paused" } as never);

    const res = await PATCH(request("PATCH", { status: "Active" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith("dep-1", { status: "Active" });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("still accepts a pause on a Pausing leg — the escalation direction is never refused", async () => {
    closing("Pausing");

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith("dep-1", { status: "Pausing" });
  });

  // A pause written over `Destroying` would turn the reap into a settle: the
  // row would be left behind, live, once flat — the delete retracted. The
  // delete already stands the leg down further, so the pause is satisfied.
  it("answers a pause on a Destroying leg with 200 and leaves the status alone", async () => {
    closing("Destroying");

    const res = await PATCH(request("PATCH", { status: "Paused" }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployment: { status: "Destroying" } });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("drops only the status from a pause on a Destroying leg that also renames it", async () => {
    closing("Destroying");

    const res = await PATCH(request("PATCH", { status: "Paused", name: "renamed" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith("dep-1", { name: "renamed" });
  });

  it("still accepts a rename on a closing leg", async () => {
    closing("Destroying");

    const res = await PATCH(request("PATCH", { name: "renamed" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith("dep-1", { name: "renamed" });
  });

  it("answers the live-account 403 ahead of the close, which clears by waiting", async () => {
    closing("Pausing");
    vi.mocked(patchWouldBeTradeable).mockReturnValue(true);
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue({
      message: LIVE_ACCOUNT_REFUSAL,
      refused: [{ accountId: DEPLOYMENT.accountId, reason: LIVE_ACCOUNT_REFUSAL }],
    });

    const res = await PATCH(request("PATCH", { status: "Active" }), ctx);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LIVE_ACCOUNT_REFUSAL);
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });

  it("answers the session-overlap 409 ahead of the close, which clears by waiting", async () => {
    closing("Pausing");
    vi.mocked(filterMainSessionOverlaps).mockReturnValueOnce([
      { id: "other-dep", name: "Other" },
    ] as never);

    const res = await PATCH(request("PATCH", { status: "Active" }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflictId: "other-dep" });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });

  it("answers BOOK_DERIVED_ROW_REFUSAL ahead of the close on a book's leg", async () => {
    vi.mocked(getDeployment).mockReturnValue({
      ...DEPLOYMENT,
      groupId: "group-1",
      status: "Pausing",
    } as never);
    vi.mocked(listDerivedRows).mockReturnValue([
      { groupId: "group-1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
    ]);

    const res = await PATCH(request("PATCH", { status: "Active" }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BOOK_DERIVED_ROW_REFUSAL });
  });
});

/**
 * The closing guard flattens whatever account the row names, so a leg moved
 * mid-close sends its close to the new account: the old account's position is
 * never closed, and one on the new account that another deployment owns can
 * be. Refused whole, before any write.
 */
describe("moving a leg still closing to another account is refused, and nothing is written", () => {
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sync = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard: vi.fn(),
      peekState: () => ({ position: null }),
    } as never);
    vi.mocked(peekBroadcaster).mockReturnValue(null);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 1 } as never);
    vi.mocked(listDerivedRows).mockReturnValue([]);
    vi.mocked(patchWouldBeTradeable).mockReturnValue(false);
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue(null);
    vi.mocked(updateDeployment).mockImplementation(
      (_id: string, patch: { status?: string }) => ({ ...DEPLOYMENT, ...patch }) as never,
    );
  });

  it.each(["Pausing", "Destroying"] as const)(
    "409s {accountId} on a %s leg with MOVE_WOULD_MISDIRECT_A_CLOSE",
    async (status) => {
      vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status } as never);

      const res = await PATCH(request("PATCH", { accountId: 5002 }), ctx);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: MOVE_WOULD_MISDIRECT_A_CLOSE });
      expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
      expect(vi.mocked(clearOrphaned)).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    },
  );

  it("refuses the whole body, so a rename riding the move is not written either", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Pausing" } as never);

    const res = await PATCH(request("PATCH", { accountId: 5002, name: "renamed", status: "Paused" }), ctx);

    expect(res.status).toBe(409);
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
  });

  it("409s {accountId, status: Paused} on an Active leg: the pause must not carry the move", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Active" } as never);

    const res = await PATCH(request("PATCH", { accountId: 5002, status: "Paused" }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MOVE_NEEDS_A_PAUSED_LEG });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(clearOrphaned)).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("409s a bare {accountId} on an Active leg", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Active" } as never);

    const res = await PATCH(request("PATCH", { accountId: 5002 }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MOVE_NEEDS_A_PAUSED_LEG });
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("answers {} with the row unchanged: no write, no sync", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Active" } as never);

    const res = await PATCH(request("PATCH", {}), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("is not a move when the body names the account the leg is already on", async () => {
    vi.mocked(getDeployment).mockReturnValue({ ...DEPLOYMENT, status: "Pausing" } as never);

    const res = await PATCH(request("PATCH", { accountId: DEPLOYMENT.accountId, name: "renamed" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledTimes(1);
  });

  it("still moves a settled Paused leg, which is orphan recovery", async () => {
    vi.mocked(getDeployment).mockReturnValue({
      ...DEPLOYMENT,
      status: "Paused",
      orphanReason: "account_missing",
    } as never);

    const res = await PATCH(request("PATCH", { accountId: 5002 }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateDeployment)).toHaveBeenCalledWith("dep-1", { accountId: 5002 });
    expect(vi.mocked(clearOrphaned)).toHaveBeenCalledTimes(1);
  });
});
