import { getDb, registerMigration } from "./connection";
import type { TickerSymbol } from "@/lib/trading/domain";
import {
  bookCarries,
  cellParamValues,
  codeBook,
  MIGRATION_BOOK_KEY,
  type CodeBookCell,
} from "@/lib/trading/books/code-books";
import { log } from "@/lib/logger";

/**
 * The account's book — one account running one of the books defined in code
 * (`trading/books/code-books.ts`) — and its per-playbook switches.
 *
 *   code book      = key + name + cells                       (in code)
 *   account's book = accountId + bookKey + enabled + retiredAt  (`books`;
 *                    one live per account)
 *   account link   = (account's book, ticker, strategyKey) + on  (`book_playbooks`)
 *   derived row    = one parent-with-one-leg deployment per running cell,
 *                    keyed on (account's book, ticker, strategyKey)
 *
 * **A cell runs on an account only when the account's book carries it and it
 * is on for that account.** The link keeps its historical column name,
 * `armed`; it is the account's own switch for the cell, and **a cell the book
 * carries with no link reads on** — so a cell a push adds to a book is on for
 * every account running it. A cell the book does not carry (a cell a push
 * removed, or one only the account's previous book had) reads off, whether the
 * account has a link for it or only a derived row, so that row is stood down;
 * if a later push carries it again, the boot resumes it (`uncarried_at`).
 * `listBookPlaybooks` / `listBooksWithPlaybooks`
 * answer that set — what runs once the account's switch is on — so the
 * reconciler, the close check and the Dashboard read one armed set. A book with
 * no key (left on its own links by the migration, or retired before books were
 * in code) answers its links alone.
 *
 * This module owns the two tables and the one pointer between an account's
 * book and the row it materialises. It does **not** decide what materialises —
 * that is `trading/books/reconcile.ts`, the only writer of a derived row — and
 * it reads no account class and no playbook declaration.
 *
 * `account_id` is INTEGER rather than the proposal's TEXT: every account id in
 * this codebase is a number (`account_brokers.account_id`, `deployments.
 * account_id`, `screenAccountsForAutoTrade`), and a TEXT column here would be
 * the one spelling that has to be converted at every boundary.
 */

/**
 * Migration reports committed by this process and not yet emitted. Above the
 * registration because the migration runs at import when the database is
 * already open.
 */
let pendingMergeReports: string[] = [];
let pendingCodeBookReports: string[] = [];
let pendingUnmigratedReports: string[] = [];

registerMigration((d) => {
  // `enabled` and `armed` are `NOT NULL` with **no DEFAULT** and are written
  // at insert: they decide what the engine acts on, so the column that has
  // never been written must not read as a value somebody chose.
  d.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_playbooks (
      book_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      strategy_key TEXT NOT NULL,
      armed INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (book_id, ticker, strategy_key)
    );
  `);
  migrateToOneBookPerAccount(d);
  // After the merge, never before: on an install still on the per-ticker
  // shape an account can hold two books, and the index would throw at boot.
  addRetiredAt(d);
  addName(d);
  addUncarriedAt(d);
  migrateToCodeBooks(d);
});

type Db = ReturnType<typeof getDb>;

interface LegacyBookRow {
  id: string;
  account_id: number;
  ticker: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface LegacyCellRow {
  book_id: string;
  strategy_key: string;
  armed: number;
  updated_at: number;
}

function hasColumn(d: Db, table: string, column: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * The `(account, ticker)` → `account` reshape, in one transaction.
 *
 * Detected by `books.ticker` still being there, so a second run — and a fresh
 * install, whose `CREATE` above already wrote the new shape — does nothing.
 * SQLite cannot drop a column that sits in a unique index in place, so both
 * tables are rebuilt and renamed over the originals.
 *
 * **What trades must not change here.** Each cell takes its old book's
 * ticker; an account with several books keeps the oldest id, and the others'
 * cells and derived rows move to it. When the merged switches agree the book
 * keeps that value. When they differ the book is **on** and every cell that
 * came from an **off** book is written disarmed — so the on book's playbooks
 * keep running, and nothing the off book held starts.
 */
function migrateToOneBookPerAccount(d: Db): void {
  // `.immediate()` takes the write lock before the probe, so a second process
  // booting on the same file waits and then sees the new shape, rather than
  // passing the probe too and failing its own rebuild.
  const reports = d.transaction((): string[] => {
    if (!hasColumn(d, "books", "ticker")) return [];
    const merged: string[] = [];
    const books = d
      .prepare(`SELECT * FROM books ORDER BY created_at ASC, rowid ASC`)
      .all() as LegacyBookRow[];
    const cells = d.prepare(`SELECT * FROM book_playbooks`).all() as LegacyCellRow[];
    const cellsByBook = new Map<string, LegacyCellRow[]>();
    for (const c of cells) {
      const list = cellsByBook.get(c.book_id);
      if (list) list.push(c);
      else cellsByBook.set(c.book_id, [c]);
    }
    const byAccount = new Map<number, LegacyBookRow[]>();
    for (const b of books) {
      const list = byAccount.get(b.account_id);
      if (list) list.push(b);
      else byAccount.set(b.account_id, [b]);
    }

    d.exec(`
      CREATE TABLE books_next (
        id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE book_playbooks_next (
        book_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        strategy_key TEXT NOT NULL,
        armed INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (book_id, ticker, strategy_key)
      );
    `);
    const insertBook = d.prepare(
      `INSERT INTO books_next (id, account_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertCell = d.prepare(`
      INSERT INTO book_playbooks_next (book_id, ticker, strategy_key, armed, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const groupsTable = d
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='deployment_groups'`)
      .get();
    const repointable = groupsTable != null && hasColumn(d, "deployment_groups", "book_id");
    if (repointable) {
      // The per-(book, playbook) index would refuse two merged books' copies of
      // one uncalibrated playbook. `deployment-groups.ts` owns its successor,
      // keyed on the cell; it is dropped here too because migrations run in
      // import order and this repoint may run first.
      d.exec(`DROP INDEX IF EXISTS idx_groups_book_playbook`);
    }
    const repoint = repointable
      ? d.prepare(`UPDATE deployment_groups SET book_id = ? WHERE book_id = ?`)
      : null;

    const now = Date.now();
    for (const [accountId, group] of byAccount) {
      const keeper = group[0];
      const agree = group.every((b) => b.enabled === keeper.enabled);
      const enabled = agree ? keeper.enabled : 1;
      insertBook.run(
        keeper.id,
        accountId,
        enabled,
        keeper.created_at,
        enabled === keeper.enabled ? keeper.updated_at : now,
      );

      const disarmed: string[] = [];
      for (const b of group) {
        const fromOffBook = !agree && b.enabled === 0;
        for (const c of cellsByBook.get(b.id) ?? []) {
          const armed = fromOffBook ? 0 : c.armed;
          if (armed !== c.armed) disarmed.push(`${c.strategy_key} on ${b.ticker}`);
          insertCell.run(keeper.id, b.ticker, c.strategy_key, armed, armed !== c.armed ? now : c.updated_at);
        }
        if (b.id !== keeper.id) repoint?.run(keeper.id, b.id);
      }

      if (group.length > 1) {
        const position = keeper.enabled === 1 ? "on" : "off";
        const switches = agree
          ? `every switch was ${position}, so it stays ${position}`
          : `the switches differed, so it is on and the off books' playbooks are disarmed` +
            (disarmed.length > 0 ? ` (${disarmed.join(", ")})` : " (none was armed)");
        merged.push(
          `Account ${accountId}'s ${group.length} books (${group.map((b) => b.ticker).join(", ")}) ` +
            `are now one book, ${keeper.id}; ${switches}`,
        );
      }
    }

    d.exec(`
      DROP TABLE books;
      DROP TABLE book_playbooks;
      ALTER TABLE books_next RENAME TO books;
      ALTER TABLE book_playbooks_next RENAME TO book_playbooks;
    `);
    return merged;
  }).immediate();
  // Only a committed merge reaches here; a throw above rolled it back.
  pendingMergeReports.push(...reports);
}

/**
 * `retired_at` and the partial account index: one **live** book per account.
 *
 * Nullable with no DEFAULT, and NULL is live — so the boot that adds the column
 * changes nothing that trades. The index the 2026-10-11 shape created is
 * unique over every row; it is replaced by one over unretired rows only, so a
 * retired book frees its account. Told apart by its SQL rather than its name,
 * because the name stays. One `.immediate()` transaction, so a second process
 * waits and then finds the partial index already there.
 */
function addRetiredAt(d: Db): void {
  d.transaction(() => {
    if (!hasColumn(d, "books", "retired_at")) {
      d.exec(`ALTER TABLE books ADD COLUMN retired_at INTEGER`);
    }
    const index = d
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_books_account'`)
      .get() as { sql: string } | undefined;
    if (index != null && !index.sql.includes("retired_at")) d.exec(`DROP INDEX idx_books_account`);
    d.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_books_account ON books(account_id) WHERE retired_at IS NULL`,
    );
  }).immediate();
}

/**
 * `name`: what the operator called the account's book before books were
 * defined in code. **Kept and no longer read or written** — a book's name is
 * its code book's now — so a rollback to the build that wrote it still finds
 * its column. Nullable with no DEFAULT; adding it changes nothing that trades.
 */
function addName(d: Db): void {
  d.transaction(() => {
    if (!hasColumn(d, "books", "name")) d.exec(`ALTER TABLE books ADD COLUMN name TEXT`);
  }).immediate();
}

/**
 * `book_playbooks.uncarried_at`: when the reconciler stood this cell's row
 * down **because the account's book stopped carrying the cell** while the
 * account's switch for it read on (epoch ms). A boot that finds the cell
 * carried again resumes the row and clears the stamp — an added cell arrives
 * on. A row stood down by the operator's switch or the book's never carries
 * it. Nullable with no DEFAULT; adding it changes nothing that trades.
 */
function addUncarriedAt(d: Db): void {
  d.transaction(() => {
    if (!hasColumn(d, "book_playbooks", "uncarried_at")) {
      d.exec(`ALTER TABLE book_playbooks ADD COLUMN uncarried_at INTEGER`);
    }
  }).immediate();
}

/**
 * The one-time move onto the books in code, in one transaction.
 *
 * `book_key` is nullable with no DEFAULT: NULL is a book not on a code book.
 * Each **live** account's book with no key is put on {@link MIGRATION_BOOK_KEY}
 * (Combine) with **nothing that trades changed at this boot**:
 *
 * - every link it has keeps its value, so each playbook's switch on the
 *   account is what its arming was (a playbook that was off stays off);
 * - every Combine cell it has **no** link for gets one written **off** — such a
 *   cell read disarmed before, and a cell with no link reads on once the book
 *   has a key;
 * - **a book with a link turned on for a cell Combine does not carry is left
 *   unmigrated**, on its own links exactly as before, and reported
 *   (`book_not_migrated`): putting it on Combine would stand that playbook
 *   down at this boot. The operator moves it with *Move to Combine*, which
 *   says what stops.
 *
 * A retired row is left alone. Idempotent: a migrated row has a key, and an
 * unmigrated one is reported again at each boot until it is moved. Reported
 * only after the transaction committed.
 */
function migrateToCodeBooks(d: Db): void {
  const combine = codeBook(MIGRATION_BOOK_KEY);
  const reports = d.transaction((): { migrated: string[]; unmigrated: string[] } => {
    if (!hasColumn(d, "books", "book_key")) d.exec(`ALTER TABLE books ADD COLUMN book_key TEXT`);
    const out = { migrated: [] as string[], unmigrated: [] as string[] };
    if (!combine) return out;
    const books = d
      .prepare(`
        SELECT id, account_id FROM books
        WHERE retired_at IS NULL AND book_key IS NULL
        ORDER BY created_at ASC, rowid ASC
      `)
      .all() as Array<{ id: string; account_id: number }>;
    const linksOf = d.prepare(`SELECT ticker, strategy_key, armed FROM book_playbooks WHERE book_id = ?`);
    const writeOff = d.prepare(`
      INSERT INTO book_playbooks (book_id, ticker, strategy_key, armed, updated_at) VALUES (?, ?, ?, 0, ?)
    `);
    const setKey = d.prepare(`UPDATE books SET book_key = ? WHERE id = ?`);
    const now = Date.now();
    for (const book of books) {
      const links = linksOf.all(book.id) as Array<{ ticker: string; strategy_key: string; armed: number }>;
      const outside = links.filter(
        (l) =>
          l.armed === 1 &&
          !bookCarries(combine, { ticker: l.ticker as TickerSymbol, strategyKey: l.strategy_key }),
      );
      if (outside.length > 0) {
        out.unmigrated.push(
          `Account ${book.account_id}'s book ${book.id} is not on a book: ` +
            `${outside.map((l) => `${l.strategy_key} on ${l.ticker}`).join(", ")} ` +
            `${outside.length === 1 ? "is" : "are"} on and ${combine.name} does not carry ` +
            `${outside.length === 1 ? "it" : "them"}, so it was left as it was; Move to ${combine.name} ` +
            `puts it on the book and stops ${outside.length === 1 ? "that playbook" : "those playbooks"}`,
        );
        continue;
      }
      const missing = combine.cells.filter(
        (c) => !links.some((l) => l.ticker === c.ticker && l.strategy_key === c.strategyKey),
      );
      for (const c of missing) writeOff.run(book.id, c.ticker, c.strategyKey, now);
      setKey.run(combine.key, book.id);
      out.migrated.push(
        `Account ${book.account_id}'s book ${book.id} now runs ${combine.name}, each playbook's ` +
          `switch as it was` +
          (missing.length > 0
            ? `; ${missing.map((c) => `${c.strategyKey} on ${c.ticker}`).join(", ")} written off`
            : ""),
      );
    }
    return out;
  }).immediate();
  // Only a committed migration reaches here; a throw above rolled it back.
  pendingCodeBookReports.push(...reports.migrated);
  pendingUnmigratedReports.push(...reports.unmigrated);
}

/**
 * Emit `books_merged`, `book_types_migrated` and `book_not_migrated` for every
 * migration this process committed, once each.
 *
 * Not emitted from the migrations: they run at the first `getDb()`, which can
 * be before the log store is flushing, and a line that reaches only stdout is
 * gone at the next container rebuild — while these lines are the only record
 * of which cells a merge disarmed and which book each account's book went on.
 * Boot calls this after `getEngine()` has started the store.
 */
export function reportBookMigrations(): void {
  const merges = pendingMergeReports;
  pendingMergeReports = [];
  for (const message of merges) log.event("books_merged", "db", message);
  const migrated = pendingCodeBookReports;
  pendingCodeBookReports = [];
  for (const message of migrated) log.event("book_types_migrated", "db", message);
  const unmigrated = pendingUnmigratedReports;
  pendingUnmigratedReports = [];
  for (const message of unmigrated) log.event("book_not_migrated", "db", message);
}

export interface Book {
  id: string;
  accountId: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * When the operator removed this book from its account (epoch ms), or null
   * while it is live. A retired book is off, materialises nothing, and keeps
   * its links and its derived rows' `book_id`; nothing about it is deleted.
   */
  retiredAt: number | null;
  /** The code book this account runs, or null when it is not on one. */
  bookKey: string | null;
}

/**
 * One cell on an account's book: a playbook on one instrument. `armed` is
 * what runs once the account's switch is on — carried by the book **and** on
 * for this account (see {@link effectiveCells}).
 */
export interface BookPlaybook {
  bookId: string;
  ticker: TickerSymbol;
  strategyKey: string;
  armed: boolean;
  updatedAt: number;
  /**
   * The code book does not carry this cell and the account's switch for it
   * reads on, so its row stands down because of the book — and the stand-down
   * is stamped (`markCellUncarried`), so a push that carries it again resumes it.
   */
  uncarried?: boolean;
  /**
   * The code book carries this cell again, it is on for the account, and its
   * row was stood down because the book had dropped it: the reconciler resumes
   * it without an operator transition, at boot too.
   */
  reCarried?: boolean;
  /**
   * The code book cell's sizing settings (`cellParamValues`), present only when
   * it sets one: the params the reconciler creates this cell's row with. A row
   * that exists already is not rewritten from it.
   */
  paramValues?: Readonly<Record<string, number>>;
}

export interface BookWithPlaybooks extends Book {
  playbooks: BookPlaybook[];
}

/** An account's own switch for one cell. */
export interface AccountCellLink {
  bookId: string;
  ticker: TickerSymbol;
  strategyKey: string;
  on: boolean;
  updatedAt: number;
  /** When the reconciler stood the cell's row down because the book stopped
   *  carrying it; null (or absent) otherwise. See {@link markCellUncarried}. */
  uncarriedAt?: number | null;
}

/**
 * A deployment the reconciler materialised, as the reconciler needs to read
 * it. Narrow on purpose: the runtime `DeploymentGroup` carries no `bookId`,
 * and adding one would put a second branch on every read site of a type that
 * is overwhelmingly about hand-made rows.
 */
export interface DerivedRow {
  groupId: string;
  bookId: string;
  /** The parent's ticker, which is its cell's. */
  ticker: TickerSymbol;
  strategyKey: string;
  /** The parent's own switch. A `false` here is a stood-down or hand-paused row. */
  enabled: boolean;
}

interface BookRow {
  id: string;
  account_id: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
  book_key: string | null;
}

interface BookPlaybookRow {
  book_id: string;
  ticker: string;
  strategy_key: string;
  armed: number;
  updated_at: number;
  uncarried_at: number | null;
}

function rowToBook(r: BookRow): Book {
  return {
    id: r.id,
    accountId: r.account_id,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    retiredAt: r.retired_at ?? null,
    bookKey: r.book_key ?? null,
  };
}

function rowToLink(r: BookPlaybookRow): AccountCellLink {
  return {
    bookId: r.book_id,
    ticker: r.ticker as TickerSymbol,
    strategyKey: r.strategy_key,
    on: r.armed === 1,
    updatedAt: r.updated_at,
    uncarriedAt: r.uncarried_at ?? null,
  };
}

/**
 * What runs on an account's book once its switch is on. One cell per cell the
 * book carries, armed when the account has it on — **a missing link reads
 * on**, which is how a cell a push adds starts on every account running the
 * book — then one per link for a cell the book does **not** carry, armed
 * false, so the reconciler stands its row down: a cell a push removed, or one
 * only the account's previous book had — **and then one per live derived row
 * of the book on a cell neither of those names**, armed false. That last set
 * is what stands down a cell that was only ever on by default (no link): a
 * push adds it and a later push removes it, its key leaves code, or a move
 * lands on a book without it. Without it such a row would keep trading.
 *
 * A cell whose stand-down is the book's doing (not carried, switch reading
 * on) is marked `uncarried`; a carried, on cell whose link carries the stamp is
 * marked `reCarried`, which the reconciler resumes.
 */
export function effectiveCells(
  bookId: string,
  cells: readonly CodeBookCell[],
  links: readonly AccountCellLink[],
  derived: readonly DerivedRow[] = [],
): BookPlaybook[] {
  const key = (c: { ticker: string; strategyKey: string }) => `${c.ticker}:${c.strategyKey}`;
  const linkFor = new Map(links.map((l) => [key(l), l]));
  const carried = new Set(cells.map(key));
  return [
    ...cells.map((cell) => {
      const link = linkFor.get(key(cell));
      const on = link?.on ?? true;
      const paramValues = cellParamValues(cell);
      return {
        bookId,
        ticker: cell.ticker,
        strategyKey: cell.strategyKey,
        armed: on,
        updatedAt: link?.updatedAt ?? 0,
        ...(on && link?.uncarriedAt != null ? { reCarried: true } : {}),
        ...(Object.keys(paramValues).length > 0 ? { paramValues } : {}),
      };
    }),
    ...links
      .filter((l) => !carried.has(key(l)))
      .map((l) => ({
        bookId,
        ticker: l.ticker,
        strategyKey: l.strategyKey,
        armed: false,
        updatedAt: l.updatedAt,
        ...(l.on ? { uncarried: true } : {}),
      })),
    ...rowsWithNoCell(bookId, derived, (k) => carried.has(k) || linkFor.has(k), key).map((r) => ({
      bookId,
      ticker: r.ticker,
      strategyKey: r.strategyKey,
      armed: false,
      updatedAt: 0,
      // No link: the switch was never written, so it read on — the stand-down is the book's.
      uncarried: true,
    })),
  ];
}

/** This book's live derived rows on a cell `named` does not cover, once each. */
function rowsWithNoCell(
  bookId: string,
  derived: readonly DerivedRow[],
  named: (key: string) => boolean,
  key: (c: { ticker: string; strategyKey: string }) => string,
): DerivedRow[] {
  const seen = new Set<string>();
  return derived.filter((r) => {
    const k = key(r);
    if (r.bookId !== bookId || named(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The armed set of an account's book: the code book's cells and its links, or
 * its links alone — each with any live derived row of the book on a cell
 * neither names, armed false, so it stands down.
 */
function cellsFor(book: Book, links: readonly AccountCellLink[], derived: readonly DerivedRow[]): BookPlaybook[] {
  if (book.bookKey == null) {
    const key = (c: { ticker: string; strategyKey: string }) => `${c.ticker}:${c.strategyKey}`;
    const linked = new Set(links.map(key));
    return [
      ...links.map((l) => ({
        bookId: l.bookId,
        ticker: l.ticker,
        strategyKey: l.strategyKey,
        armed: l.on,
        updatedAt: l.updatedAt,
      })),
      // Not stamped: a book not on a code book gains no cell from a push.
      ...rowsWithNoCell(book.id, derived, (k) => linked.has(k), key).map((r) => ({
        bookId: book.id,
        ticker: r.ticker,
        strategyKey: r.strategyKey,
        armed: false,
        updatedAt: 0,
      })),
    ];
  }
  // A key no longer in code carries nothing: every link and row reads off and stands down.
  return effectiveCells(book.id, codeBook(book.bookKey)?.cells ?? [], links, derived);
}

export function listBooks(): Book[] {
  const rows = getDb()
    .prepare(`SELECT * FROM books ORDER BY created_at ASC`)
    .all() as BookRow[];
  return rows.map(rowToBook);
}

export function getBook(id: string): Book | null {
  const row = getDb().prepare(`SELECT * FROM books WHERE id = ?`).get(id) as BookRow | undefined;
  return row ? rowToBook(row) : null;
}

/** The account's live book — the one the partial index allows. A retired one is not it. */
export function getBookByAccount(accountId: number): Book | null {
  const row = getDb()
    .prepare(`SELECT * FROM books WHERE account_id = ? AND retired_at IS NULL`)
    .get(accountId) as BookRow | undefined;
  return row ? rowToBook(row) : null;
}

/**
 * The account's most recently retired book **on this code book**, which
 * deploying that book to the account again brings back, so history on the
 * pair carries on. A row retired before books were in code has no key and is
 * never returned.
 */
export function getRetiredBookFor(accountId: number, bookKey: string): Book | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM books
      WHERE account_id = ? AND book_key = ? AND retired_at IS NOT NULL
      ORDER BY retired_at DESC, rowid DESC LIMIT 1
    `)
    .get(accountId, bookKey) as BookRow | undefined;
  return row ? rowToBook(row) : null;
}

/**
 * Remove a book from its account: stamp `retired_at`, and nothing else. The
 * links, the derived rows and their `book_id` stay, so the trade history on
 * them stays readable. Conditional on the book being live **and off**, the
 * route's first refusal restated as a fact of the write. Its one caller is
 * `DELETE /api/books/[id]`, pinned by a source scan in that route's test.
 */
export function retireBook(id: string): Book | null {
  const now = Date.now();
  const info = getDb()
    .prepare(`
      UPDATE books SET retired_at = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL AND enabled = 0
    `)
    .run(now, now, id);
  if (info.changes === 0) return null;
  return getBook(id);
}

/**
 * Bring a retired book back on its account, still off and with its links as
 * they were. Throws on the partial unique index if the account has a live book.
 */
export function unretireBook(id: string): Book | null {
  const info = getDb()
    .prepare(`UPDATE books SET retired_at = NULL, updated_at = ? WHERE id = ? AND retired_at IS NOT NULL`)
    .run(Date.now(), id);
  if (info.changes === 0) return null;
  return getBook(id);
}

export interface InsertBookInput {
  accountId: number;
  enabled: boolean;
  /** The code book. Every route passes one; absent is a book on its own
   *  links, which only the migrations' tests write. */
  bookKey?: string | null;
}

/** Throws on a second live book for one account — the unique index. */
export function insertBook(input: InsertBookInput): Book {
  const now = Date.now();
  const id = crypto.randomUUID();
  const bookKey = input.bookKey ?? null;
  getDb()
    .prepare(`
      INSERT INTO books (id, account_id, enabled, created_at, updated_at, book_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(id, input.accountId, input.enabled ? 1 : 0, now, now, bookKey);
  return {
    id,
    accountId: input.accountId,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    bookKey,
  };
}

/**
 * Put a live account's book on another code book, in place — *Move to <book>*'s
 * write, and its one caller is `trading/books/move.ts`, pinned by a source
 * scan. The row keeps its id, so its derived rows keep their `book_id` and the
 * 2026-09-13 rules hold unchanged: what the new book does not carry stands
 * down through the reconciler, what it adds starts there.
 */
export function setBookKey(id: string, bookKey: string): Book | null {
  const info = getDb()
    .prepare(`UPDATE books SET book_key = ?, updated_at = ? WHERE id = ? AND retired_at IS NULL`)
    .run(bookKey, Date.now(), id);
  if (info.changes === 0) return null;
  return getBook(id);
}

/**
 * Re-point a book at another account — *Move to replacement*'s write, and its
 * only caller (`POST /api/deployments/move-account`), which has already
 * checked that the old account is dead and the new one unused. Throws on the
 * unique index if the new account has a book after all. The links and the
 * `book_id` pointers do not move: they are keyed on the book.
 */
export function setBookAccount(id: string, accountId: number): Book | null {
  const info = getDb()
    .prepare(`UPDATE books SET account_id = ?, updated_at = ? WHERE id = ?`)
    .run(accountId, Date.now(), id);
  if (info.changes === 0) return null;
  return getBook(id);
}

export function setBookEnabled(id: string, enabled: boolean): Book | null {
  const now = Date.now();
  const info = getDb()
    .prepare(`UPDATE books SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, now, id);
  if (info.changes === 0) return null;
  return getBook(id);
}

/** The account's own switch per cell, as stored. */
export function listBookLinks(bookId: string): AccountCellLink[] {
  const rows = getDb()
    .prepare(`SELECT * FROM book_playbooks WHERE book_id = ? ORDER BY ticker ASC, strategy_key ASC`)
    .all(bookId) as BookPlaybookRow[];
  return rows.map(rowToLink);
}

/** The account's book's armed set: what runs once its switch is on. */
export function listBookPlaybooks(bookId: string): BookPlaybook[] {
  const book = getBook(bookId);
  if (!book) return [];
  return cellsFor(book, listBookLinks(bookId), listDerivedRows().filter((r) => r.bookId === bookId));
}

/**
 * Turn one cell on or off **for this account**. **Off is an update, never a
 * delete**: the row is the record of what the operator asked for, and the
 * derived row it stands down keeps the trade history for what that playbook
 * did on that account. Clears `uncarried_at`: the operator's own press
 * supersedes the reconciler's note of why the row last stood down.
 */
export function setAccountCellOn(
  bookId: string,
  ticker: TickerSymbol,
  strategyKey: string,
  on: boolean,
): AccountCellLink {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO book_playbooks (book_id, ticker, strategy_key, armed, updated_at, uncarried_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(book_id, ticker, strategy_key) DO UPDATE SET armed = excluded.armed,
                                                               updated_at = excluded.updated_at,
                                                               uncarried_at = NULL
    `)
    .run(bookId, ticker, strategyKey, on ? 1 : 0, now);
  return { bookId, ticker, strategyKey, on, updatedAt: now, uncarriedAt: null };
}

/**
 * Stamp `uncarried_at` on a cell whose row the reconciler just stood down
 * because the book stopped carrying it — only ever for a cell whose switch
 * reads on (`BookPlaybook.uncarried`), so a missing link is written **on**,
 * which is what it read. The switch itself is not touched. Reconciler-only.
 */
export function markCellUncarried(bookId: string, ticker: TickerSymbol, strategyKey: string): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO book_playbooks (book_id, ticker, strategy_key, armed, updated_at, uncarried_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(book_id, ticker, strategy_key) DO UPDATE SET uncarried_at = excluded.uncarried_at
    `)
    .run(bookId, ticker, strategyKey, now, now);
}

/** Clear the stamp once the row has resumed. Reconciler-only; a no-op with none. */
export function clearCellUncarried(bookId: string, ticker: TickerSymbol, strategyKey: string): void {
  getDb()
    .prepare(`
      UPDATE book_playbooks SET uncarried_at = NULL
      WHERE book_id = ? AND ticker = ? AND strategy_key = ? AND uncarried_at IS NOT NULL
    `)
    .run(bookId, ticker, strategyKey);
}

/**
 * Every account's book with its armed set attached — the reconciler's whole
 * read of these tables, already the code book's cells under the account's own
 * switches. Retired books included: the reconciler skips them, `GET
 * /api/books` leaves them out, and the Dashboard still needs their switch
 * (off) to leave their cards out.
 */
export function listBooksWithPlaybooks(): BookWithPlaybooks[] {
  const books = listBooks();
  if (books.length === 0) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM book_playbooks ORDER BY ticker ASC, strategy_key ASC`)
    .all() as BookPlaybookRow[];
  const linksByBook = new Map<string, AccountCellLink[]>();
  for (const r of rows) {
    const list = linksByBook.get(r.book_id);
    if (list) list.push(rowToLink(r));
    else linksByBook.set(r.book_id, [rowToLink(r)]);
  }
  const derived = listDerivedRows();
  return books.map((b) => ({ ...b, playbooks: cellsFor(b, linksByBook.get(b.id) ?? [], derived) }));
}

/**
 * The live derived rows, read through the one pointer. Soft-deleted rows are
 * excluded, matching the partial unique index: a tombstoned derived row is not
 * a slot the reconciler has to leave alone.
 */
export function listDerivedRows(): DerivedRow[] {
  const rows = getDb()
    .prepare(`
      SELECT id, book_id, ticker, strategy_key, enabled FROM deployment_groups
      WHERE book_id IS NOT NULL AND deleted_at IS NULL
    `)
    .all() as Array<{
      id: string;
      book_id: string;
      ticker: string;
      strategy_key: string;
      enabled: number;
    }>;
  return rows.map((r) => ({
    groupId: r.id,
    bookId: r.book_id,
    ticker: r.ticker as TickerSymbol,
    strategyKey: r.strategy_key,
    enabled: r.enabled === 1,
  }));
}

/**
 * Bind a freshly created parent to the book that asked for it.
 *
 * Separate from `insertGroupWithLegs` because `deployment-groups.ts` owns a
 * shape that knows nothing about books; the reconciler runs the two inside one
 * transaction, so the partial unique index throwing here rolls the insert back
 * rather than leaving an unbound parent behind.
 */
export function attachBookToGroup(groupId: string, bookId: string): void {
  getDb().prepare(`UPDATE deployment_groups SET book_id = ? WHERE id = ?`).run(bookId, groupId);
}
