import { getDb } from "@/lib/db/connection";
import {
  getBook,
  listBookLinks,
  listDerivedRows,
  setAccountCellOn,
  setBookKey,
  type AccountCellLink,
  type Book,
  type DerivedRow,
} from "@/lib/db/books";
import { listGroupLegs, sessionForStrategyKey } from "@/lib/db/deployments";
import { unregisteredPositionRefusal } from "@/lib/trading/books/refusals";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import {
  applyBookPlan,
  emptyBookResult,
  planBooks,
  type BookCell,
  type BookReconcileResult,
} from "@/lib/trading/books/reconcile";
import {
  bookNotInBuild,
  codeBook,
  STAGING_CODE_BOOKS,
  type CodeBookCell,
} from "@/lib/trading/books/code-books";
import {
  groupEnableWouldRetractClose,
  turnOnWouldRetractACloseRefusal,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/trading/domain";

/**
 * *Move to <book>*: an account changes the code book it runs, **in place**
 * (operator, 2026-10-19) — the account's `books` row keeps its id and switch,
 * and only its book key changes, so every derived row keeps its `book_id`.
 *
 * Per playbook, from what runs on the account now to what the new book runs:
 *
 *   keeps   runs in both  — nothing about its row changes; its history and
 *                           any open position carry on
 *   stops   only the old  — the new book does not carry it, so its link reads
 *                           off and the reconciler stands it down as a disarm
 *                           does (a position goes `Pausing` and is closed);
 *                           a reason to refuse only when that position is on
 *                           a playbook this build does not register, which
 *                           the closing guard cannot safely flatten
 *   starts  only the new  — turned on for the account, created or resumed; a
 *                           resume over a leg still `Pausing` refuses the
 *                           **whole** move before any write
 *
 * A cell both books carry keeps the account's own switch — it is the same
 * link. The reconciler stays the only writer of a derived row: the move writes
 * the key and the links, and `applyBookPlan` does the rest.
 */

export type MoveStep = "keeps" | "stops" | "starts";

export interface MoveLine extends BookCell {
  step: MoveStep;
  /** A `stops` line whose row holds a position (or is still closing one):
   *  the confirmation names it *will be closed*. */
  willClose: boolean;
}

/** What the planner reads. Plain data, so the confirmation and the write ask one function. */
export interface MovePlanInput {
  accountEnabled: boolean;
  /** What the account's book carries now: a code book's cells, or — on a book
   *  not on one — its own links' cells. */
  oldCells: readonly CodeBookCell[];
  /** The account's own switches. A cell the old book carries with no link is on. */
  links: readonly AccountCellLink[];
  newCells: readonly CodeBookCell[];
  /** The account's book's derived rows. */
  rows: readonly DerivedRow[];
  legs: (groupId: string) => ReadonlyArray<{ status: DeploymentStatus; openTrade: boolean }>;
  /** Whether this build registers the playbook (it declares a session). */
  registered: (strategyKey: string) => boolean;
}

export interface MovePlan {
  lines: MoveLine[];
  /** Cells the new book starts: turned on, and named in the reconcile's transition. */
  starts: BookCell[];
  /** Strategy keys whose resume would retract a close: non-empty refuses the move. */
  closingOnResume: string[];
  /**
   * *Stops* that would close a position on a playbook this build does not
   * register: non-empty refuses the move. The closing guard cannot safely
   * flatten a row with no module loaded (punchlist
   * `unregistered-row-exit-alerts`), so the move does not hand it one.
   */
  unregisteredClosing: BookCell[];
}

function keyOf(cell: BookCell): string {
  return `${cell.ticker}:${cell.strategyKey}`;
}

export function planBookMove(input: MovePlanInput): MovePlan {
  const inOld = new Set(input.oldCells.map(keyOf));
  const inNew = new Set(input.newCells.map(keyOf));
  const linkOn = new Map(input.links.map((l) => [keyOf(l), l.on]));
  const row = new Map(input.rows.map((r) => [keyOf(r), r]));
  const plan: MovePlan = { lines: [], starts: [], closingOnResume: [], unregisteredClosing: [] };

  const cells = new Map<string, BookCell>();
  for (const c of [...input.oldCells, ...input.newCells]) {
    cells.set(keyOf(c), { ticker: c.ticker, strategyKey: c.strategyKey });
  }
  for (const [key, cell] of cells) {
    const on = linkOn.get(key) ?? true;
    const oldRuns = inOld.has(key) && on;
    // A cell both books carry keeps its switch; one only the new book carries is turned on.
    const newRuns = inNew.has(key) && (inOld.has(key) ? on : true);
    const r = row.get(key);
    if (oldRuns && newRuns) {
      plan.lines.push({ ...cell, step: "keeps", willClose: false });
    } else if (oldRuns) {
      const legs = r?.enabled ? input.legs(r.groupId) : [];
      const willClose = legs.some((l) => l.openTrade || l.status === "Pausing");
      plan.lines.push({ ...cell, step: "stops", willClose });
      if (willClose && !input.registered(cell.strategyKey)) plan.unregisteredClosing.push(cell);
    } else if (newRuns) {
      plan.lines.push({ ...cell, step: "starts", willClose: false });
      plan.starts.push(cell);
      const resumes = input.accountEnabled && r != null && !r.enabled;
      if (resumes && input.legs(r.groupId).some((l) => groupEnableWouldRetractClose(l.status))) {
        plan.closingOnResume.push(cell.strategyKey);
      }
    }
  }
  plan.closingOnResume = [...new Set(plan.closingOnResume)];
  return plan;
}

/** Everything the planner needs for this account's book and target, read now. */
export function readMovePlan(accountBook: Book, targetKey: string): MovePlan {
  const links = listBookLinks(accountBook.id);
  // A staging book this build does not register still has its cells in code;
  // without them the move would list no stops and re-arm cells it had off.
  const current =
    codeBook(accountBook.bookKey) ??
    (bookNotInBuild(accountBook.bookKey)
      ? (STAGING_CODE_BOOKS.find((b) => b.key === accountBook.bookKey) ?? null)
      : null);
  // A book not on a code book carries every cell it has a link for, on or off,
  // so a playbook it had switched off stays off on the new book.
  const oldCells: CodeBookCell[] =
    accountBook.bookKey == null
      ? links.map((l) => ({ ticker: l.ticker, strategyKey: l.strategyKey }))
      : [...(current?.cells ?? [])];
  return planBookMove({
    accountEnabled: accountBook.enabled,
    oldCells,
    links,
    newCells: codeBook(targetKey)?.cells ?? [],
    rows: listDerivedRows().filter((r) => r.bookId === accountBook.id),
    legs: (groupId) =>
      listGroupLegs(groupId).map((leg) => ({
        status: leg.status,
        openTrade: getOpenTradeForDeployment(leg.id) != null,
      })),
    registered: (strategyKey) => sessionForStrategyKey(strategyKey) != null,
  });
}

/** The close-in-flight 409's sentence for a move, or null. */
export function moveCloseRefusal(plan: MovePlan, nameOf: (strategyKey: string) => string): string | null {
  if (plan.closingOnResume.length === 0) return null;
  return turnOnWouldRetractACloseRefusal(plan.closingOnResume.map(nameOf), "move");
}

/** The 409's sentence for a move that would close a position on an unregistered playbook, or null. */
export function moveUnregisteredRefusal(plan: MovePlan): string | null {
  if (plan.unregisteredClosing.length === 0) return null;
  return unregisteredPositionRefusal(plan.unregisteredClosing.map((c) => `${c.strategyKey} on ${c.ticker}`));
}

export interface MoveResult {
  book: Book;
  lines: MoveLine[];
  result: BookReconcileResult;
}

/**
 * The write, in one transaction: the key, the starts' links, then one
 * reconcile pass that stands down what the new book does not carry and creates
 * or resumes what it adds. The caller has run every refusal before calling,
 * and reports and announces `result` once this has returned (committed).
 * Throws — writing nothing — when the account's book is no longer live, the
 * book is unknown, or a start would retract a close.
 */
export function runBookMove(
  accountBookId: string,
  targetKey: string,
  deps: { inPosition: (leg: Deployment) => boolean },
): MoveResult {
  return getDb().transaction((): MoveResult => {
    const from = getBook(accountBookId);
    if (!from || from.retiredAt != null) throw new Error("The account's book is not live");
    if (!codeBook(targetKey)) throw new Error("No such book");
    const plan = readMovePlan(from, targetKey);
    // Decided above every write, as the routes decide theirs.
    if (plan.unregisteredClosing.length > 0) {
      throw new Error("A stop would close a position on a playbook this build does not register");
    }
    if (plan.closingOnResume.length > 0) throw new Error("A resume would retract a close");

    setBookKey(from.id, targetKey);
    for (const cell of plan.starts) setAccountCellOn(from.id, cell.ticker, cell.strategyKey, true);
    const reconcile = planBooks(plan.starts.map((cell) => ({ bookId: from.id, cell })));
    const result = emptyBookResult(reconcile);
    applyBookPlan(reconcile, deps, result);

    return { book: getBook(from.id) ?? from, lines: plan.lines, result };
  })();
}
