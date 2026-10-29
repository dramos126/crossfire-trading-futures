import type { TickerSymbol } from "@/lib/trading/domain";
import {
  FULL_RISK_PERCENT,
  NO_PLAYBOOK_CONTRACT_CAP,
  PLAYBOOK_MAX_CONTRACTS_PARAM,
  PLAYBOOK_RISK_PERCENT_PARAM,
} from "@/lib/trading/orders/risk-sizer";

/**
 * The books, defined in code like playbooks (operator, 2026-10-19): a stable
 * key, a display name, and the `(ticker, playbook)` cells it runs. Changing a
 * book is a code change.
 *
 * Two lists, as playbooks have folders (operator, 2026-10-22):
 * `PROD_CODE_BOOKS` every build registers, `STAGING_CODE_BOOKS` only a staging
 * build. **A prod book's cells are prod playbooks** (`PROD_PLAYBOOK_KEYS`); a
 * staging book's may also be staging ones. Both are on the contract each
 * playbook is calibrated for — `code-books.test.ts` pins all three. Promoting a
 * staging book is moving its entry to the prod list, and that test then
 * refuses any cell still on a staging playbook.
 *
 * What a push does to the accounts running a book, at the boot that runs it:
 * a cell **added** is on for every one of them (an account's own switch reads
 * on until it is turned off) and the reconciler creates it where the
 * account's book is on; a cell **removed** stands down on every one of them,
 * a position closed through `Pausing` and the closing guard. The operator
 * deploys off-hours for that reason ([deployments-books-history.md](../../../../docs/modules/trading/deployments-books-history.md),
 * 2026-10-11, revised 2026-10-19).
 *
 * **Cell order is priority on a shared bar only within one bar size.** The
 * engine evaluates one bar size's legs in `created_at` order and the first to
 * signal takes the contract; the reconciler creates a book's rows in cell
 * order, and a cell a push appends is created at that boot, after every row
 * already running. Across bar sizes on one contract, the bar size of the
 * oldest managed row on that contract (any account) goes first, whatever the
 * cell order: a 1m cell beats a 30m cell on the same contract only while a 1m
 * row is the oldest managed one.
 *
 * **A cell's sizing settings are a ceiling the reconciler writes onto its row**
 * (2026-10-22), and the engine and the book CLI size from the row's params. A
 * create writes them; a resume narrows the row to them (`narrowParamsToCell`),
 * never raising a setting and keeping an operator's lower one. A row that keeps
 * running is not rewritten: a push that lowers a cell's setting reaches a
 * running row at its next resume (the cell's off and on) or through its ✎.
 *
 * Client-safe: pure data, read by the Books page and the server alike. Nothing
 * here is a gate: the live-account block still screens every account whatever
 * book it runs.
 */

export interface CodeBookCell {
  ticker: TickerSymbol;
  strategyKey: string;
  /** `playbookMaxContracts` for the row this cell creates: 1..3, absent for no playbook cap. */
  playbookMaxContracts?: number;
  /** `playbookRiskPercent` for the row this cell creates: 1..100, absent for 100. */
  playbookRiskPercent?: number;
}

export interface CodeBook {
  /** Stable: stored on the account's book, and what `book --book` will take. */
  key: string;
  name: string;
  cells: readonly CodeBookCell[];
}

export const PROD_CODE_BOOKS: readonly CodeBook[] = [
  {
    key: "sample",
    name: "Sample",
    // The three example playbooks on /MNQ. None has an edge; the book shows how one is put together.
    cells: [
      { ticker: "/MNQ", strategyKey: "bar-close-pulse" },
      { ticker: "/MNQ", strategyKey: "ema-crossover" },
      { ticker: "/MNQ", strategyKey: "trend-follower" },
    ],
  },
];

export const STAGING_CODE_BOOKS: readonly CodeBook[] = [];

/** The books a build registers: the prod list, then the staging list on a staging build. */
export function codeBooksForBuild(staging: boolean): readonly CodeBook[] {
  return staging ? [...PROD_CODE_BOOKS, ...STAGING_CODE_BOOKS] : PROD_CODE_BOOKS;
}

// The gate `strategies/index.ts` puts `staging/` behind, spelled identically (code-books.test.ts compares the two):
// a literal NEXT_PUBLIC_* read is inlined at build time in the server and the browser bundle alike, so a runtime env
// flip cannot register a staging book. Not `isStagingEnv()`, which reads "not prod" — true of a dev build too, which
// registers no `staging/` playbook.
export const CODE_BOOKS: readonly CodeBook[] = codeBooksForBuild(process.env.NEXT_PUBLIC_APP_ENV === "staging");

/** The book every live account's book was put on by the one-time migration. */
export const MIGRATION_BOOK_KEY = "sample";

export function codeBook(key: string | null): CodeBook | null {
  if (key == null) return null;
  return CODE_BOOKS.find((b) => b.key === key) ?? null;
}

/**
 * A book defined in code that this build does not register: a staging book met
 * by a prod build, on a database copied from staging. Not the same as a key in
 * neither list, which was removed from code and stands its rows down.
 * `registered` is the build's list, or the `codeBooks` a `GET /api/books` body carries.
 */
export function bookNotInBuild(
  key: string | null,
  registered: ReadonlyArray<Pick<CodeBook, "key">> = CODE_BOOKS,
): boolean {
  if (key == null || registered.some((b) => b.key === key)) return false;
  return STAGING_CODE_BOOKS.some((b) => b.key === key);
}

/** The cell's sizing settings as a row's `paramValues` — only those it sets. */
export function cellParamValues(cell: CodeBookCell): Record<string, number> {
  const out: Record<string, number> = {};
  if (cell.playbookMaxContracts !== undefined) out[PLAYBOOK_MAX_CONTRACTS_PARAM] = cell.playbookMaxContracts;
  if (cell.playbookRiskPercent !== undefined) out[PLAYBOOK_RISK_PERCENT_PARAM] = cell.playbookRiskPercent;
  return out;
}

/**
 * A row's params narrowed to its cell's sizing settings, or null when the row's
 * own settings are already at or under them. Never raises: a row's cap is
 * lowered to the cell's only when it has none (absent or `0`) or a higher one,
 * and its share only when it has none or a higher one. A stored value that is
 * not a number is left as it is — the sizer refuses it at the next entry.
 */
export function narrowParamsToCell(
  rowParams: Readonly<Record<string, unknown>>,
  cellParams: Readonly<Record<string, number>>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...rowParams };
  let changed = false;
  const cellCap = cellParams[PLAYBOOK_MAX_CONTRACTS_PARAM];
  if (cellCap !== undefined && cellCap !== NO_PLAYBOOK_CONTRACT_CAP) {
    const rowCap = rowParams[PLAYBOOK_MAX_CONTRACTS_PARAM];
    const noCap = rowCap === undefined || rowCap === NO_PLAYBOOK_CONTRACT_CAP;
    if (noCap || (typeof rowCap === "number" && rowCap > cellCap)) {
      out[PLAYBOOK_MAX_CONTRACTS_PARAM] = cellCap;
      changed = true;
    }
  }
  const cellShare = cellParams[PLAYBOOK_RISK_PERCENT_PARAM];
  if (cellShare !== undefined) {
    const rowShare = rowParams[PLAYBOOK_RISK_PERCENT_PARAM] ?? FULL_RISK_PERCENT;
    if (typeof rowShare === "number" && rowShare > cellShare) {
      out[PLAYBOOK_RISK_PERCENT_PARAM] = cellShare;
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Whether a book carries a cell. */
export function bookCarries(book: CodeBook, cell: CodeBookCell): boolean {
  return book.cells.some((c) => c.ticker === cell.ticker && c.strategyKey === cell.strategyKey);
}
