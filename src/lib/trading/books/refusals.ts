/**
 * The books routes' own sentences for the code-book model, one constant or
 * builder each, so the route's body and the grid's inert control say the same
 * words (copy.md rule 5). Each is a refusal that clears and ends in its move.
 */

/** An account's on for a playbook its book does not carry: it would run nothing. */
export const CELL_NOT_IN_BOOK_REFUSAL =
  "This account's book does not include this playbook, so it cannot be turned on here. Move the account to a book that includes it.";

/**
 * A move that would stop a playbook holding a position when this build of the
 * platform does not include that playbook, so nothing here can close it. Names
 * each one; the move is to flatten at the broker first.
 */
export function unregisteredPositionRefusal(cells: readonly string[]): string {
  const one = cells.length === 1;
  return (
    `This move would stop ${cells.join(", ")}, which ${one ? "holds" : "hold"} a position, and this ` +
    `build of the platform does not include ${one ? "that playbook" : "those playbooks"}, so it cannot ` +
    `close ${one ? "it" : "them"}. Flatten ${one ? "the position" : "those positions"} at the broker, ` +
    `then move the account.`
  );
}

/** A deploy or a move onto a key no book in this build carries. */
export const UNKNOWN_BOOK_REFUSAL = "There is no such book in this build of the platform.";

/** A deploy onto an account that already runs a book. It names the control that changes it. */
export function accountHasBookRefusal(current: string, target: string): string {
  return (
    `This account already runs ${current}, and an account runs one book at a time. ` +
    `Use Move to ${target} in that account's actions instead.`
  );
}
