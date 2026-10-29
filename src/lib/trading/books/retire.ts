import { listDerivedRows, type DerivedRow } from "@/lib/db/books";
import { listGroupLegs } from "@/lib/db/deployments";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import type { DeploymentStatus } from "@/lib/trading/domain";

/**
 * Removing a book from its account — `DELETE /api/books/[id]`, which stamps
 * `retired_at` and deletes nothing.
 *
 * **Refused unless the book is already off and every derived leg is settled**:
 * `Paused`, none `Pausing` or `Destroying`, and no open trade row on any leg.
 * Requiring off first means a retire never races an entry, and the flatten
 * stays with the existing off. The live-account block is not asked: a remove
 * only winds down, like off.
 */

/** The 409's sentence, and the inert control's title. It names the moves, in order. */
export const REMOVE_BOOK_REFUSAL =
  "A book can be removed from its account only once it is switched off and none of its playbooks holds a position or is still closing one. Turn the book off and wait for its playbooks to close, then remove it.";

/** A write on a book that has been removed. It names the control that brings it back. */
export const BOOK_REMOVED_REFUSAL =
  "This book has been removed from its account, so it cannot be switched on or changed. Use Deploy a book, picking this book and account, to bring it back, switched off and with its playbooks as they were.";

export interface RemoveBookState {
  enabled: boolean;
  /** Every leg of the book's derived rows. */
  legs: ReadonlyArray<{ status: DeploymentStatus; openTrade: boolean }>;
}

export function removeBookRefusalFor(state: RemoveBookState): string | null {
  if (state.enabled) return REMOVE_BOOK_REFUSAL;
  if (state.legs.some((leg) => leg.status !== "Paused" || leg.openTrade)) return REMOVE_BOOK_REFUSAL;
  return null;
}

/**
 * The refusal read now, for the route and for `GET /api/books`, which carries
 * it so the grid draws *Remove from account* inert with the same sentence.
 * The trade row is the durable answer, the one boot and the book routes use.
 * `derived` is for a caller that has already read the derived rows.
 */
export function removeBookRefusal(
  book: { id: string; enabled: boolean },
  derived: readonly DerivedRow[] = listDerivedRows(),
): string | null {
  if (book.enabled) return removeBookRefusalFor({ enabled: true, legs: [] });
  const legs = derived
    .filter((row) => row.bookId === book.id)
    .flatMap((row) => listGroupLegs(row.groupId))
    .map((leg) => ({ status: leg.status, openTrade: getOpenTradeForDeployment(leg.id) != null }));
  return removeBookRefusalFor({ enabled: book.enabled, legs });
}
