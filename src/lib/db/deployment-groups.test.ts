/**
 * `rowToGroup` — the one place a `deployment_groups` row becomes a
 * `DeploymentGroup`, and therefore the only place `book_id` can be lost.
 *
 * The board asks *is this row a book's?* of every card, and it may not reach
 * past its adapter to a raw row to find out
 * ([ui/design-language.md](../../../docs/modules/ui/design-language.md)) — so a
 * mapper that drops the column silently puts a live ✕ back on a row the route
 * 409s. Nothing else fails when it does.
 *
 * Real in-memory better-sqlite3 and the **shipped** migration callbacks,
 * captured off the mocked `registerMigration`, the way `books.test.ts` does it:
 * what is asserted is the SQL that boots and the mapper that reads it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

let db: Db;

const { migrations } = vi.hoisted(() => ({ migrations: [] as Array<(d: Db) => void> }));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: Db) => void) => {
    migrations.push(fn);
  }),
}));

// The module's runtime deps reach the strategy loader's `require.context` and
// the filter registry, neither of which has a vitest equivalent. Same stubs
// `books.test.ts` uses for the same import.
vi.mock("@/lib/db/deployments", () => ({
  insertDeployment: vi.fn(),
  listGroupLegs: vi.fn(() => []),
  softDeleteDeployment: vi.fn(),
  updateDeployment: vi.fn(),
}));
vi.mock("@/lib/trading/deep-equal", () => ({ deepEqual: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

import { getGroup, insertGroup, listGroups } from "./deployment-groups";

function runMigrations(d: Db): void {
  for (const m of migrations) m(d);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("rowToGroup — book_id reaches the domain type", () => {
  it("carries the book a derived row points at", () => {
    const group = insertGroup({
      name: null,
      strategyKey: "orb",
      paramValues: {},
      ticker: "/MNQ",
      contractId: null,
      enabled: true,
    });
    // The reconciler binds the row after the insert, in the same transaction —
    // `attachBookToGroup`'s write, stated here as the SQL it runs.
    db.prepare(`UPDATE deployment_groups SET book_id = 'book-1' WHERE id = ?`).run(group.id);

    expect(getGroup(group.id)?.bookId).toBe("book-1");
    expect(listGroups().map((g) => g.bookId)).toEqual(["book-1"]);
  });

  it("reads a hand-made row as null, including the row the insert just wrote", () => {
    // `NULL` is *hand-made*, which is every row on an install that has never
    // opened a book — and the value the create path writes, because binding a
    // book is a second write with one owner.
    const group = insertGroup({
      name: null,
      strategyKey: "ema-crossover",
      paramValues: {},
      ticker: "/MNQ",
      contractId: null,
      enabled: true,
    });

    expect(group.bookId).toBeNull();
    expect(getGroup(group.id)?.bookId).toBeNull();
  });
});
