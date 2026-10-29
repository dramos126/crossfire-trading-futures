import {
  listBookPlaybooks,
  listDerivedRows,
  type BookPlaybook,
  type DerivedRow,
} from "@/lib/db/books";
import type { BookCell } from "@/lib/trading/books/reconcile";
import { listGroupLegs } from "@/lib/db/deployments";
import { getStrategy } from "@/lib/trading/strategies";
import {
  groupEnableWouldRetractClose,
  turnOnWouldRetractACloseRefusal,
  type DeploymentStatus,
} from "@/lib/trading/domain";

/**
 * Which playbooks a book switch turning **on** would resume over a close still
 * in flight — the one answer both book `PATCH` routes refuse on and
 * `GET /api/books` reports, so the grid and the route cannot disagree.
 *
 * A resume is `enableGroupAndRestore`, which rewrites a `Pausing` leg from its
 * snapshot and drops the close; on a detached leg the orphan markers stay set,
 * so it trades again while the board says Detached. A `Destroying` leg it
 * skips, so that one blocks nothing (`groupEnableWouldRetractClose`). Only a
 * stood-down parent resumes (the call is a no-op on an enabled one), and only
 * a playbook the switch leaves wanted — armed under the book's switch, or the
 * one cell being armed under an on book. The slot question is not asked: a
 * held slot would not resume either, and refusing there is the conservative
 * direction.
 */
export interface TurnOnState {
  bookEnabled: boolean;
  armed: (cell: BookCell) => boolean;
  /** This book's derived rows. */
  derived: readonly DerivedRow[];
  legStatuses: (groupId: string) => readonly DeploymentStatus[];
}

/**
 * `cell` absent is the book's own switch; present is one cell's arm. Answers
 * strategy keys, once each — the sentence names playbooks, and one playbook
 * closing on two instruments is still one name.
 */
export function closingOnTurnOn(state: TurnOnState, scope: { cell?: BookCell }): string[] {
  const keys = state.derived
    .filter((row) => {
      if (row.enabled) return false;
      const resumes =
        scope.cell == null
          ? state.armed(row)
          : state.bookEnabled &&
            row.ticker === scope.cell.ticker &&
            row.strategyKey === scope.cell.strategyKey;
      return resumes && state.legStatuses(row.groupId).some(groupEnableWouldRetractClose);
    })
    .map((row) => row.strategyKey);
  return [...new Set(keys)];
}

/** The display name the grid joins from the client registry, read server-side. */
function playbookName(strategyKey: string): string {
  return getStrategy(strategyKey)?.config.name ?? strategyKey;
}

/**
 * The 409's sentence for turning `book` (or one of its cells) on, or null when
 * nothing it would resume is closing. Reads only; the caller decides before it
 * writes anything.
 */
export function turnOnCloseRefusal(
  book: { id: string; enabled: boolean },
  scope: { cell?: BookCell },
): string | null {
  const armed = armedLookup(listBookPlaybooks(book.id));
  const keys = closingOnTurnOn(
    {
      bookEnabled: book.enabled,
      armed,
      derived: listDerivedRows().filter((row) => row.bookId === book.id),
      legStatuses: (groupId) => listGroupLegs(groupId).map((leg) => leg.status),
    },
    scope,
  );
  if (keys.length === 0) return null;
  // One playbook can sit on two contracts, so an arm's sentence names which one
  // is closing. The grid's inert cell spells the same `<name> on <ticker>`.
  if (scope.cell != null) {
    return turnOnWouldRetractACloseRefusal(
      [`${playbookName(scope.cell.strategyKey)} on ${scope.cell.ticker}`],
      "playbook",
    );
  }
  return turnOnWouldRetractACloseRefusal(keys.map(playbookName), "book");
}

/** Whether a cell is armed, from a book's rows; a cell with no row is not. */
export function armedLookup(playbooks: readonly BookPlaybook[]): (cell: BookCell) => boolean {
  const armed = new Map(playbooks.map((p) => [`${p.ticker}:${p.strategyKey}`, p.armed]));
  return (cell) => armed.get(`${cell.ticker}:${cell.strategyKey}`) ?? false;
}
