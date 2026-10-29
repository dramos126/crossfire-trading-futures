/**
 * `PATCH /api/books/[id]` — the book switch.
 *
 * Three properties, and the last two are silences. The `false → true`
 * transition is screened by the live-account block and refuses with the
 * sentence verbatim; an **off** is never screened, because a book on an account
 * that has since been classified live must still be turnable off; and a body
 * that is not a transition writes nothing and announces nothing.
 *
 * The reconciler is real for the reason the collection route's test gives — it
 * is what carries the sync and the emit — and the broadcaster is real so the
 * frame is observed rather than counted.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getBook: vi.fn(),
  listBookPlaybooks: vi.fn<(bookId: string) => Array<Record<string, unknown>>>(() => []),
  setBookEnabled: vi.fn(),
  retireBook: vi.fn(),
  listBooksWithPlaybooks: vi.fn(),
  listDerivedRows: vi.fn(),
  attachBookToGroup: vi.fn(),
  insertGroupWithLegs: vi.fn(),
  disableGroupWithSnapshot: vi.fn(),
  enableGroupAndRestore: vi.fn(),
  findConflictingDeployment: vi.fn(),
  listGroupLegs: vi.fn<(groupId: string) => Array<Record<string, unknown>>>(() => []),
  listManagedDeployments: vi.fn(() => []),
  sessionForStrategyKey: vi.fn(),
  screenAccountsForAutoTrade: vi.fn(),
  getOpenTradeForDeployment: vi.fn(() => null),
  sync: vi.fn(),
  nudgeClosingGuard: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => ({
    transaction: (fn: () => unknown) => fn,
    prepare: () => {
      throw new Error("prepare() called in test — DB not available");
    },
  })),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

vi.mock("@/lib/db/books", () => ({
  getBook: h.getBook,
  listBookPlaybooks: h.listBookPlaybooks,
  setBookEnabled: h.setBookEnabled,
  retireBook: h.retireBook,
  listBooksWithPlaybooks: h.listBooksWithPlaybooks,
  listDerivedRows: h.listDerivedRows,
  attachBookToGroup: h.attachBookToGroup,
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  insertGroupWithLegs: h.insertGroupWithLegs,
  disableGroupWithSnapshot: h.disableGroupWithSnapshot,
  enableGroupAndRestore: h.enableGroupAndRestore,
}));

vi.mock("@/lib/db/deployments", () => ({
  findConflictingDeployment: h.findConflictingDeployment,
  listGroupLegs: h.listGroupLegs,
  listManagedDeployments: h.listManagedDeployments,
  sessionForStrategyKey: h.sessionForStrategyKey,
}));

vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: h.screenAccountsForAutoTrade,
}));

vi.mock("@/lib/db/trades", () => ({ getOpenTradeForDeployment: h.getOpenTradeForDeployment }));

// Enumerated, not spread: the real module is the `require.context` strategy
// loader, which has no vitest equivalent and fails the whole file at import.
// Reached through the reconciler, which asks both declarations before it
// materialises anything.
vi.mock("@/lib/trading/strategies", () => ({
  instrumentRefusalForStrategyKey: vi.fn(() => null),
  daySessionRefusalForStrategyKey: vi.fn(() => null),
  getStrategy: (key: string) =>
    key === "orb" ? { config: { name: "Opening Range Breakout" } } : undefined,
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => ({ sync: h.sync, nudgeClosingGuard: h.nudgeClosingGuard })),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({ peekBroadcaster: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DELETE, PATCH } from "./route";
import { BOOK_REMOVED_REFUSAL, REMOVE_BOOK_REFUSAL } from "@/lib/trading/books/retire";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { EventBroadcaster } from "@/lib/realtime/event-broadcaster";
import type { BroadcastEvent, BroadcasterDeps } from "@/lib/realtime/event-broadcaster";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import { turnOnWouldRetractACloseRefusal } from "@/lib/trading/domain";

const SESSION = { activeStart: "09:30", activeEnd: "15:55" };
const BOOK = { id: "book-1", accountId: 11, enabled: false, createdAt: 1, updatedAt: 1, retiredAt: null, name: null };

function withPlaybooks(enabled: boolean) {
  return [
    {
      ...BOOK,
      enabled,
      playbooks: [{ bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", armed: true, updatedAt: 1 }],
    },
  ];
}

function patch(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/books/book-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-token": "test" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "book-1" }) } as never;

let seen: BroadcastEvent[];
let subscriber: Mock<(event: BroadcastEvent) => void>;

beforeEach(() => {
  vi.clearAllMocks();
  h.getBook.mockReturnValue({ ...BOOK, enabled: false });
  h.setBookEnabled.mockImplementation((id: string, enabled: boolean) => ({ ...BOOK, id, enabled }));
  h.listBooksWithPlaybooks.mockReturnValue([]);
  h.listBookPlaybooks.mockReturnValue([]);
  h.listDerivedRows.mockReturnValue([]);
  h.listGroupLegs.mockReturnValue([]);
  h.listManagedDeployments.mockReturnValue([]);
  h.sessionForStrategyKey.mockReturnValue(SESSION);
  h.findConflictingDeployment.mockReturnValue(null);
  h.screenAccountsForAutoTrade.mockReturnValue(null);
  h.insertGroupWithLegs.mockReturnValue({ group: { id: "g-new" }, legs: [] });

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
  subscriber = vi.fn((e: BroadcastEvent) => {
    seen.push(e);
  });
  broadcaster.subscribe("books", subscriber);
  vi.mocked(peekBroadcaster).mockReturnValue(broadcaster);
});

describe("PATCH /api/books/[id]", () => {
  it("refuses a `false → true` transition on the live-account screen, verbatim", async () => {
    h.screenAccountsForAutoTrade.mockReturnValue({
      message: LIVE_ACCOUNT_REFUSAL,
      refused: [{ accountId: 11, reason: LIVE_ACCOUNT_REFUSAL }],
    });

    const res = await PATCH(patch({ enabled: true }), ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: LIVE_ACCOUNT_REFUSAL,
      refusedAccounts: [{ accountId: 11, reason: LIVE_ACCOUNT_REFUSAL }],
    });
    expect(h.setBookEnabled).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("lets a refused account's book be turned off — the wind-down path is never screened", async () => {
    h.getBook.mockReturnValue({ ...BOOK, enabled: true });
    h.listBooksWithPlaybooks.mockReturnValue(withPlaybooks(false));
    h.listDerivedRows.mockReturnValue([
      { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: true },
    ]);
    h.listGroupLegs.mockReturnValue([{ id: "leg-1", status: "Active" }]);

    const res = await PATCH(patch({ enabled: false }), ctx);

    expect(res.status).toBe(200);
    expect(h.screenAccountsForAutoTrade).not.toHaveBeenCalled();
    expect(h.setBookEnabled).toHaveBeenCalledWith("book-1", false);
    expect(h.disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("resumes the stood-down rows on an off → on, which is the transition", async () => {
    h.listBooksWithPlaybooks.mockReturnValue(withPlaybooks(true));
    h.listDerivedRows.mockReturnValue([
      { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
    ]);

    const res = await PATCH(patch({ enabled: true }), ctx);

    expect(res.status).toBe(200);
    expect(h.enableGroupAndRestore).toHaveBeenCalledWith("g1");
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  // The handler rejecting is what Next answers 500 for, and the board's
  // `writeThenRefresh` reads that as a failed write rather than refreshing
  // over an engine that may still hold the old deployment set.
  it("fails the request when the engine's sync throws, rather than answering 200", async () => {
    h.listBooksWithPlaybooks.mockReturnValue(withPlaybooks(true));
    h.listDerivedRows.mockReturnValue([
      { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
    ]);
    h.sync.mockImplementationOnce(() => {
      throw new Error("sync blew up");
    });

    await expect(PATCH(patch({ enabled: true }), ctx)).rejects.toThrow("sync blew up");

    expect(h.enableGroupAndRestore).toHaveBeenCalledWith("g1");
    expect(seen).toEqual([]);
  });

  it("writes nothing and announces nothing on a body that is not a transition", async () => {
    h.getBook.mockReturnValue({ ...BOOK, enabled: true });

    const res = await PATCH(patch({ enabled: true }), ctx);

    expect(res.status).toBe(200);
    expect(h.setBookEnabled).not.toHaveBeenCalled();
    expect(h.screenAccountsForAutoTrade).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  // Operator decision 2026-10-07 ("1A"). `enableGroupAndRestore` writes a
  // `Pausing` leg back to `Active` and drops its close; the book's on is
  // refused whole rather than resuming the rest.
  describe("while a leg the switch would resume is still closing", () => {
    function twoArmed(enabled: boolean) {
      return [
        {
          ...BOOK,
          enabled,
          playbooks: [
            { bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", armed: true, updatedAt: 1 },
            { bookId: "book-1", ticker: "/MNQ", strategyKey: "ema", armed: true, updatedAt: 1 },
          ],
        },
      ];
    }

    function closingOn(groupId: string, status: string) {
      h.listGroupLegs.mockImplementation((g: string) => [
        { id: `leg-${g}`, status: g === groupId ? status : "Paused" },
      ]);
    }

    beforeEach(() => {
      h.listBookPlaybooks.mockReturnValue(twoArmed(false)[0].playbooks);
      h.listBooksWithPlaybooks.mockReturnValue(twoArmed(true));
      h.listDerivedRows.mockReturnValue([
        { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
        { groupId: "g2", bookId: "book-1", ticker: "/MNQ", strategyKey: "ema", enabled: false },
      ]);
    });

    it("409s an off → on when one armed playbook's leg is Pausing, and writes nothing at all", async () => {
      closingOn("g1", "Pausing");

      const res = await PATCH(patch({ enabled: true }), ctx);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: turnOnWouldRetractACloseRefusal(["Opening Range Breakout"], "book"),
      });
      expect(h.setBookEnabled).not.toHaveBeenCalled();
      // No partial resume: the sibling that is not closing stays down too.
      expect(h.enableGroupAndRestore).not.toHaveBeenCalled();
      expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
      expect(h.sync).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    });

    // Operator choice 3A: `enableGroupAndRestore` skips a `Destroying` leg, so
    // the on retracts nothing there and the sibling is not held back by it.
    it("turns on over a leg being destroyed, which the resume leaves alone", async () => {
      closingOn("g1", "Destroying");

      const res = await PATCH(patch({ enabled: true }), ctx);

      expect(res.status).toBe(200);
      expect(h.setBookEnabled).toHaveBeenCalledWith("book-1", true);
    });

    it("resumes both as before when every leg has settled Paused", async () => {
      closingOn("none", "Pausing");

      const res = await PATCH(patch({ enabled: true }), ctx);

      expect(res.status).toBe(200);
      expect(h.setBookEnabled).toHaveBeenCalledWith("book-1", true);
      expect(h.enableGroupAndRestore).toHaveBeenCalledWith("g1");
      expect(h.enableGroupAndRestore).toHaveBeenCalledWith("g2");
    });

    it("does not refuse over a closing leg the switch would not resume (its playbook is disarmed)", async () => {
      closingOn("g1", "Pausing");
      h.listBookPlaybooks.mockReturnValue([
        { bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", armed: false, updatedAt: 1 },
        { bookId: "book-1", ticker: "/MNQ", strategyKey: "ema", armed: true, updatedAt: 1 },
      ]);

      const res = await PATCH(patch({ enabled: true }), ctx);

      expect(res.status).toBe(200);
      expect(h.setBookEnabled).toHaveBeenCalledWith("book-1", true);
    });

    it("still turns the book off while a leg is closing — the wind-down is never refused", async () => {
      h.getBook.mockReturnValue({ ...BOOK, enabled: true });
      h.listBooksWithPlaybooks.mockReturnValue(twoArmed(false));
      h.listDerivedRows.mockReturnValue([
        { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: true },
      ]);
      closingOn("g1", "Pausing");

      const res = await PATCH(patch({ enabled: false }), ctx);

      expect(res.status).toBe(200);
      expect(h.setBookEnabled).toHaveBeenCalledWith("book-1", false);
    });

    it("answers the live-account 403 ahead of the close, which clears by waiting", async () => {
      closingOn("g1", "Pausing");
      h.screenAccountsForAutoTrade.mockReturnValue({
        message: LIVE_ACCOUNT_REFUSAL,
        refused: [{ accountId: 11, reason: LIVE_ACCOUNT_REFUSAL }],
      });

      const res = await PATCH(patch({ enabled: true }), ctx);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(LIVE_ACCOUNT_REFUSAL);
      expect(h.setBookEnabled).not.toHaveBeenCalled();
    });
  });

  it("404s an id with no book, and 400s a body that sets nothing", async () => {
    h.getBook.mockReturnValue(null);
    expect((await PATCH(patch({ enabled: true }), ctx)).status).toBe(404);

    expect((await PATCH(patch({ enabled: "yes" }), ctx)).status).toBe(400);
    expect(h.setBookEnabled).not.toHaveBeenCalled();
  });

  it("refuses to switch a removed book on, and writes nothing", async () => {
    h.getBook.mockReturnValue({ ...BOOK, retiredAt: 1_000 });

    const res = await PATCH(patch({ enabled: true }), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BOOK_REMOVED_REFUSAL });
    expect(h.setBookEnabled).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/books/[id] — the name is the shared book's", () => {
  it("400s a name on the account's book, which carries the switch alone", async () => {
    const res = await PATCH(patch({ name: "Combine" }), ctx);

    expect(res.status).toBe(400);
    expect(h.setBookEnabled).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });
});

function del(): NextRequest {
  return new NextRequest("http://localhost/api/books/book-1", {
    method: "DELETE",
    headers: { "x-session-token": "test" },
  });
}

describe("DELETE /api/books/[id] — Remove from account", () => {
  const DERIVED = { groupId: "g1", bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false };

  beforeEach(() => {
    h.getOpenTradeForDeployment.mockImplementation(() => null);
    h.listDerivedRows.mockReturnValue([DERIVED]);
    h.listGroupLegs.mockReturnValue([{ id: "leg-1", status: "Paused" }]);
    h.retireBook.mockImplementation((id: string) => ({ ...BOOK, id, retiredAt: 2_000 }));
  });

  it("stamps the book and touches no deployment row, announcing nothing", async () => {
    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ book: { ...BOOK, retiredAt: 2_000 } });
    expect(h.retireBook).toHaveBeenCalledWith("book-1");
    // Derived rows stay Paused and keep their book: nothing deletes, pauses or resumes them.
    expect(h.disableGroupWithSnapshot).not.toHaveBeenCalled();
    expect(h.enableGroupAndRestore).not.toHaveBeenCalled();
    expect(h.attachBookToGroup).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("refuses a book that is still on, with the sentence that names the moves", async () => {
    h.getBook.mockReturnValue({ ...BOOK, enabled: true });

    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: REMOVE_BOOK_REFUSAL });
    expect(h.retireBook).not.toHaveBeenCalled();
  });

  it.each(["Pausing", "Destroying"])("refuses an off book whose leg is still %s", async (status) => {
    h.listGroupLegs.mockReturnValue([{ id: "leg-1", status }]);

    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(REMOVE_BOOK_REFUSAL);
    expect(h.retireBook).not.toHaveBeenCalled();
  });

  it("refuses an off book whose Paused leg still has an open trade row", async () => {
    h.getOpenTradeForDeployment.mockImplementation(((id: string) =>
      id === "leg-1" ? { id: "t1" } : null) as never);

    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(409);
    expect(h.getOpenTradeForDeployment).toHaveBeenCalledWith("leg-1");
    expect(h.retireBook).not.toHaveBeenCalled();
  });

  it("does not ask the live-account block: a live-classified account's book is still cleared", async () => {
    h.screenAccountsForAutoTrade.mockReturnValue({
      message: LIVE_ACCOUNT_REFUSAL,
      refused: [{ accountId: 11, reason: LIVE_ACCOUNT_REFUSAL }],
    });

    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(200);
    expect(h.screenAccountsForAutoTrade).not.toHaveBeenCalled();
    expect(h.retireBook).toHaveBeenCalledWith("book-1");
  });

  it("answers a removed book unchanged on a repeat, writing nothing", async () => {
    h.getBook.mockReturnValue({ ...BOOK, retiredAt: 1_000 });

    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ book: { ...BOOK, retiredAt: 1_000 } });
    expect(h.retireBook).not.toHaveBeenCalled();
  });

  it("404s an id with no book", async () => {
    h.getBook.mockReturnValue(null);
    expect((await DELETE(del(), ctx)).status).toBe(404);
    expect(h.retireBook).not.toHaveBeenCalled();
  });
});

describe("only the operator reaches the retire write", () => {
  // Enumerated from source, as Move to replacement's re-point is: a reconciler,
  // a job or a boot step that called it would take a book off an account with
  // nobody pressing anything.
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const root = join(process.cwd(), "src");
  const files = sources(root);
  const callers = (needle: RegExp) =>
    files.filter((f) => needle.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();

  it("stamps retired_at only from this route", () => {
    const found = callers(/\bretireBook\(/);
    expect(found).toEqual(["app/api/books/[id]/route.ts", "lib/db/books.ts"]);
  });

  it("writes the column only from the books module", () => {
    expect(callers(/retired_at\s*=\s*\?/)).toEqual(["lib/db/books.ts"]);
  });
});
