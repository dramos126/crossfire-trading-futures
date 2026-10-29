/**
 * `POST /api/deployments/move-account` — *Move to replacement*. Every refusal
 * is decided before any write; a move re-points every leg and the book in one
 * transaction, keeps each leg's status, and announces like every binding
 * mutation. And nothing but the operator's press reaches it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

const h = vi.hoisted(() => ({
  /** Set by the rollback test alone; every other test runs on the recorder. */
  realDb: null as Db | null,
  migrations: [] as Array<(d: Db) => void>,
  order: [] as string[],
  screen: vi.fn(),
  readAccountGates: vi.fn(),
  listDeployments: vi.fn(),
  getOpenTradeForDeployment: vi.fn(),
  getBookByAccount: vi.fn(),
  updateDeployment: vi.fn(),
  clearOrphaned: vi.fn(),
  carry: vi.fn(),
  listDerivedRows: vi.fn(),
  listBooks: vi.fn(),
  setBookAccount: vi.fn(),
  runBookReconcile: vi.fn(),
  sync: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(
    () =>
      h.realDb ?? {
        transaction: (fn: () => void) => () => {
          h.order.push("tx:begin");
          fn();
          h.order.push("tx:end");
        },
        prepare: () => {
          throw new Error("prepare() called in test — DB not available");
        },
      },
  ),
  registerMigration: vi.fn((fn: (d: Db) => void) => {
    h.migrations.push(fn);
  }),
  registerPreCloseHook: vi.fn(),
}));
// Reached only by the rollback test's real `db/deployments`: the strategy
// loader is `require.context`, which vitest cannot run.
vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: vi.fn(() => null),
  sessionForStrategyKey: vi.fn(() => null),
}));
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));
vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: h.screen,
  carryRiskSettings: h.carry,
  getAccountRiskSettings: vi.fn(),
  logAccountRiskChange: vi.fn(),
}));
vi.mock("@/lib/db/books", () => ({
  getBookByAccount: h.getBookByAccount,
  listBooks: h.listBooks,
  listDerivedRows: h.listDerivedRows,
  setBookAccount: h.setBookAccount,
}));
vi.mock("@/lib/db/deployments", () => ({
  clearOrphaned: h.clearOrphaned,
  listDeployments: h.listDeployments,
  listManagedDeployments: vi.fn(() => []),
  updateDeployment: h.updateDeployment,
}));
vi.mock("@/lib/db/trades", () => ({ getOpenTradeForDeployment: h.getOpenTradeForDeployment }));
vi.mock("@/lib/trading/books/account-gates", () => ({ readAccountGates: h.readAccountGates }));
vi.mock("@/lib/trading/books/reconcile", () => ({ runBookReconcileAndAnnounce: h.runBookReconcile }));
vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => ({ sync: h.sync })),
}));
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => ({ emitDeploymentsChanged: h.emit })),
}));

import { POST } from "./route";
import {
  MOVE_DID_NOT_LAND,
  MOVE_NEEDS_A_DEAD_ACCOUNT,
  MOVE_TARGET_NOT_A_REPLACEMENT,
  MOVE_WAITS_FOR_OPEN_TRADE,
} from "@/lib/trading/broker-access/account-state-gate";

const DEAD = 11;
const FRESH = 12;

function gate(accountId: number, dead: boolean, replacements: number[] = []) {
  return {
    accountId,
    name: `acct-${accountId}`,
    refusal: dead ? { kind: "dead", stamp: "Dead", reason: "dead" } : null,
    warning: null,
    replacements: replacements.map((id) => ({ accountId: id, name: `acct-${id}` })),
  };
}

/** The book's derived parent; a leg under any other group is hand-made. */
const BOOK_GROUP = "g-book";

function leg(id: string, status: string, orphanReason: string | null = null, groupId = BOOK_GROUP) {
  return { id, accountId: DEAD, status, orphanReason, groupId };
}

const CARRIED = { posture: true, dailyPnl: true, phase: "combine" };

function move(body: unknown = { fromAccountId: DEAD, toAccountId: FRESH }): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/deployments/move-account", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": "test" },
      body: JSON.stringify(body),
    }),
  );
}

function expectNothingWritten(): void {
  expect(h.updateDeployment).not.toHaveBeenCalled();
  expect(h.carry).not.toHaveBeenCalled();
  expect(h.setBookAccount).not.toHaveBeenCalled();
  expect(h.runBookReconcile).not.toHaveBeenCalled();
  expect(h.sync).not.toHaveBeenCalled();
  expect(h.emit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.screen.mockReturnValue(null);
  h.readAccountGates.mockReturnValue([gate(DEAD, true, [FRESH]), gate(FRESH, false)]);
  h.listDeployments.mockReturnValue([
    leg("a", "Active"),
    leg("b", "Paused", "periodic_account_check"),
    { id: "other", accountId: 99, status: "Active", orphanReason: null, groupId: "g-other" },
  ]);
  h.getOpenTradeForDeployment.mockReturnValue(null);
  h.getBookByAccount.mockReturnValue({ id: "book-1", accountId: DEAD, enabled: true });
  h.listDerivedRows.mockReturnValue([
    { groupId: BOOK_GROUP, bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: true },
  ]);
  h.listBooks.mockReturnValue([{ id: "book-1", accountId: DEAD, enabled: true, retiredAt: null }]);
  h.updateDeployment.mockImplementation((id: string) => h.order.push(`leg:${id}`));
  h.clearOrphaned.mockImplementation((id: string) => h.order.push(`clear:${id}`));
  h.carry.mockImplementation(() => {
    h.order.push("carry");
    return CARRIED;
  });
  h.setBookAccount.mockImplementation(() => h.order.push("book"));
  h.runBookReconcile.mockImplementation(() => h.order.push("reconcile"));
  h.sync.mockImplementation(() => h.order.push("sync"));
  h.emit.mockImplementation(() => h.order.push("emit"));
});

describe("POST /api/deployments/move-account", () => {
  it("re-points every live leg and the book in one transaction, then reconciles and announces", async () => {
    const res = await move();

    expect(res.status).toBe(200);
    expect(h.order).toEqual([
      "tx:begin",
      "leg:a",
      "leg:b",
      "clear:b",
      "carry",
      "book",
      "tx:end",
      "reconcile",
      "sync",
      "emit",
    ]);
    // An Active leg keeps its status; the leg the status check paused when the
    // account went missing comes back on, because the book is on.
    expect(h.updateDeployment.mock.calls).toEqual([
      ["a", { accountId: FRESH }],
      ["b", { accountId: FRESH, status: "Active" }],
    ]);
    expect(h.carry).toHaveBeenCalledWith(DEAD, FRESH);
    expect(h.setBookAccount).toHaveBeenCalledWith("book-1", FRESH);
    expect((await res.json()).moved).toEqual({
      legs: ["a", "b"],
      resumed: ["b"],
      bookId: "book-1",
      carried: CARRIED,
    });
  });

  it("leaves an orphan-paused leg paused when its book is off", async () => {
    h.getBookByAccount.mockReturnValue({ id: "book-1", accountId: DEAD, enabled: false });
    expect((await move()).status).toBe(200);
    expect(h.updateDeployment.mock.calls).toContainEqual(["b", { accountId: FRESH }]);
    expect(h.clearOrphaned).toHaveBeenCalledWith("b");
  });

  it("leaves an orphan-paused leg paused when its playbook is switched off in the book", async () => {
    h.listDerivedRows.mockReturnValue([
      { groupId: BOOK_GROUP, bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
    ]);
    expect((await move()).status).toBe(200);
    expect(h.updateDeployment.mock.calls).toContainEqual(["b", { accountId: FRESH }]);
  });

  it("leaves an orphan-paused hand-made leg paused — no book was on for it", async () => {
    h.listDeployments.mockReturnValue([leg("c", "Paused", "periodic_account_check", "g-hand")]);
    expect((await move()).status).toBe(200);
    expect(h.updateDeployment.mock.calls).toEqual([["c", { accountId: FRESH }]]);
    expect(h.clearOrphaned).toHaveBeenCalledWith("c");
  });

  it("moves the deployments of an account with no book", async () => {
    h.getBookByAccount.mockReturnValue(null);
    expect((await move()).status).toBe(200);
    expect(h.updateDeployment.mock.calls).toEqual([
      ["a", { accountId: FRESH }],
      ["b", { accountId: FRESH }],
    ]);
    expect(h.setBookAccount).not.toHaveBeenCalled();
  });

  it("leaves a removed book's legs on the dead account and moves only the hand-made one", async () => {
    // The removed book is not the account's live book, so `getBookByAccount` misses it.
    h.getBookByAccount.mockReturnValue(null);
    h.listBooks.mockReturnValue([
      { id: "book-1", accountId: DEAD, enabled: false, retiredAt: 1_760_000_000_000 },
    ]);
    h.listDerivedRows.mockReturnValue([
      { groupId: BOOK_GROUP, bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", enabled: false },
    ]);
    h.listDeployments.mockReturnValue([
      leg("removed", "Paused", "periodic_account_check"),
      leg("hand", "Paused", null, "g-hand"),
    ]);
    // A removed book's leg is history: an open row on it does not hold up the move.
    h.getOpenTradeForDeployment.mockImplementation((id: string) => (id === "removed" ? { id: 1 } : null));

    const res = await move();

    expect(res.status).toBe(200);
    expect(h.updateDeployment.mock.calls).toEqual([["hand", { accountId: FRESH }]]);
    expect(h.clearOrphaned).not.toHaveBeenCalled();
    expect(h.setBookAccount).not.toHaveBeenCalled();
    expect((await res.json()).moved).toEqual({
      legs: ["hand"],
      resumed: [],
      bookId: null,
      carried: CARRIED,
    });
  });

  it("refuses a target the deploy screen refuses, 403 with its sentence, before anything else", async () => {
    h.screen.mockReturnValue({ message: "oco unknown", refused: [{ accountId: FRESH, reason: "oco unknown" }] });
    const res = await move();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("oco unknown");
    expect(h.screen).toHaveBeenCalledWith([FRESH]);
    expectNothingWritten();
  });

  it("refuses to move off an account that is not dead", async () => {
    h.readAccountGates.mockReturnValue([gate(DEAD, false, [FRESH]), gate(FRESH, false)]);
    const res = await move();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MOVE_NEEDS_A_DEAD_ACCOUNT);
    expectNothingWritten();
  });

  it("refuses a target that is not among the dead account's replacements", async () => {
    h.readAccountGates.mockReturnValue([gate(DEAD, true, [13]), gate(FRESH, false)]);
    const res = await move();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MOVE_TARGET_NOT_A_REPLACEMENT);
    expectNothingWritten();
  });

  it("refuses while a leg on the dead account still owes a close", async () => {
    h.listDeployments.mockReturnValue([leg("a", "Paused"), leg("b", "Pausing")]);
    const res = await move();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MOVE_WAITS_FOR_OPEN_TRADE);
    expectNothingWritten();
  });

  it("refuses while a leg on the dead account has an open trade on record", async () => {
    h.getOpenTradeForDeployment.mockImplementation((id: string) => (id === "a" ? { id: 1 } : null));
    const res = await move();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MOVE_WAITS_FOR_OPEN_TRADE);
    expectNothingWritten();
  });

  it("refuses a body that names no accounts", async () => {
    expect((await move({ fromAccountId: DEAD })).status).toBe(400);
    expectNothingWritten();
  });
});

describe("a write that throws partway through", () => {
  // Real SQLite, the shipped migrations, and the real writers: what is pinned
  // is that the transaction is one, which a recorder cannot show.
  beforeEach(() => {
    h.realDb = null;
  });

  it("rolls back the legs already re-pointed and answers 409 with nothing announced", async () => {
    const deployments = await vi.importActual<typeof import("@/lib/db/deployments")>(
      "@/lib/db/deployments",
    );
    const groups = await vi.importActual<typeof import("@/lib/db/deployment-groups")>(
      "@/lib/db/deployment-groups",
    );
    const books = await vi.importActual<typeof import("@/lib/db/books")>("@/lib/db/books");
    const db = new Database(":memory:");
    for (const fn of h.migrations) fn(db);
    h.realDb = db;

    const parent = groups.insertGroup({
      name: null,
      strategyKey: "orb",
      ticker: "/MNQ",
      contractId: null,
      paramValues: {},
      enabled: true,
    });
    const legIds = ["Active", "Paused"].map(
      (status) =>
        deployments.insertDeployment({
          strategyKey: "orb",
          accountId: DEAD,
          ticker: "/MNQ",
          contractId: null,
          status: status as "Active" | "Paused",
          paramValues: {},
          name: null,
          groupId: parent.id,
        }).id,
    );
    const deadBook = books.insertBook({ accountId: DEAD, enabled: true });
    // Gained a book after the pairing was read: the re-point hits the index.
    books.insertBook({ accountId: FRESH, enabled: false });

    h.listDeployments.mockImplementation(() => deployments.listDeployments());
    h.getBookByAccount.mockImplementation((id: number) => books.getBookByAccount(id));
    h.updateDeployment.mockImplementation(deployments.updateDeployment);
    h.clearOrphaned.mockImplementation(deployments.clearOrphaned);
    h.setBookAccount.mockImplementation(books.setBookAccount);

    try {
      const res = await move();

      expect(h.updateDeployment).toHaveBeenCalledTimes(2);
      expect(h.setBookAccount).toHaveBeenCalledWith(deadBook.id, FRESH);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(MOVE_DID_NOT_LAND);
      expect(legIds.map((id) => deployments.getDeployment(id)?.accountId)).toEqual([DEAD, DEAD]);
      expect(books.getBook(deadBook.id)?.accountId).toBe(DEAD);
      expect(h.runBookReconcile).not.toHaveBeenCalled();
      expect(h.sync).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    } finally {
      h.realDb = null;
      db.close();
    }
  });
});

describe("never automatic", () => {
  // Enumerated from source: the book re-point and the route are reached only
  // from the route itself and the operator's control. A reconciler, a job or a
  // boot step that called either would move an account with nobody pressing.
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

  it("writes a book's account only from the move route", () => {
    expect(callers(/setBookAccount\(/)).toEqual([
      "app/api/deployments/move-account/route.ts",
      "lib/db/books.ts",
    ]);
  });

  it("is posted to only by the Move to replacement control", () => {
    // A fetch, not a mention: doc comments name the route too.
    expect(callers(/fetch\(\s*["'`]\/api\/deployments\/move-account/)).toEqual([
      "components/playbook/playbook-account-gates.tsx",
    ]);
  });
});
