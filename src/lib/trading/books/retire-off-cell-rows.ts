import { listBooks, listDerivedRows, type Book, type DerivedRow } from "@/lib/db/books";
import { softDeleteGroup } from "@/lib/db/deployment-groups";
import { listGroupLegs } from "@/lib/db/deployments";
import { getOffCellRowsRetiredAt, setOffCellRowsRetiredAt } from "@/lib/db/settings";
import { bookCarries, codeBook } from "@/lib/trading/books/code-books";
import type { DeploymentStatus } from "@/lib/trading/domain";
import { log } from "@/lib/logger";

/**
 * The one-time retirement of off-cell derived rows (operator, 2026-10-24,
 * A86). A playbook that left a book in code leaves its derived row behind,
 * stood down, on a cell the grid no longer draws a box for. The reconciler
 * never deletes one — a stand-down is a pause, so a re-add can resume it —
 * and the operator chose to soft-delete the five such rows that existed
 * instead of leaving them.
 *
 * This is not the reconciler and adds no fourth action to it. It runs once per
 * database, at boot after the book reconcile, so a cell a push re-adds at the
 * same boot is resumed rather than retired, and it stamps `app_settings` so a
 * row stood down by a later push stays as the history it is.
 */

export interface OffCellRowsState {
  books: readonly Book[];
  derived: readonly DerivedRow[];
  /** The statuses of the group's live legs. */
  legStatuses: (groupId: string) => readonly DeploymentStatus[];
}

/**
 * The derived rows the one-shot retires: off, every leg `Paused`, on a live
 * book whose code book does not carry the cell. A retired book's rows are
 * history and stay; a book not on a code book, or on one this build does not
 * register, carries nothing to compare against and is left alone.
 */
export function offCellRowsToRetire(state: OffCellRowsState): DerivedRow[] {
  return state.derived.filter((r) => {
    if (r.enabled) return false;
    const book = state.books.find((b) => b.id === r.bookId);
    if (!book || book.retiredAt != null) return false;
    const cb = codeBook(book.bookKey);
    if (!cb || bookCarries(cb, { ticker: r.ticker, strategyKey: r.strategyKey })) return false;
    return state.legStatuses(r.groupId).every((s) => s === "Paused");
  });
}

/**
 * Run the one-shot if it has not run on this database: soft-delete each row
 * through `softDeleteGroup`, stamp the key, log what went. Returns null when
 * it had already run. A throw partway leaves the stamp unwritten, and the
 * next boot retires what is left — the predicate no longer matches a row
 * already soft-deleted.
 */
export function runRetireOffCellRows(): { retired: readonly DerivedRow[] } | null {
  if (getOffCellRowsRetiredAt() != null) return null;
  const retired = offCellRowsToRetire({
    books: listBooks(),
    derived: listDerivedRows(),
    legStatuses: (groupId) => listGroupLegs(groupId).map((l) => l.status),
  });
  for (const row of retired) softDeleteGroup(row.groupId);
  setOffCellRowsRetiredAt(new Date().toISOString());
  const named = retired.map((r) => `${r.strategyKey} on ${r.ticker} (group ${r.groupId})`).join("; ");
  log.event(
    "derived_rows_retired",
    "engine",
    `boot: retired ${retired.length} derived row(s) on cells their book no longer carries` +
      (retired.length > 0 ? `: ${named}` : ""),
  );
  return { retired };
}
