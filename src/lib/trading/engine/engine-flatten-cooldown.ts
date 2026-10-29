// One cooldown, shared by every engine path that can put a market order
// against an `(account, contract)` without another actor's unbooked order
// being visible to it any other way. There are five, and all five are wired
// in: the naked-position watchdog, D-2 enforcement, the session-end clock
// guard, P6's restart downtime sweep, and the per-deployment force flatten.
//
// **That criterion was broadened on 2026-09-01 and this header carried the
// old one.** It read *"submits a market order against a broker position
// without re-reading it first"*, which is true of the four sweeps and false
// of the fifth actor: `forceFlatDeployment` re-reads the broker after its
// bracket cancel and still needs the interlock, because what it cannot see
// is the *other* actor's order, not its own stale size. Re-reading your own
// position was never the property that made two flattens safe.
//
// The scopes overlap per *pairing*, and the two live pairings are the
// watchdog's with the other two clock-driven actors. Since D-16 the watchdog's
// scope is `collectManagedContractIds` — the contractId on every still-
// reconcilable trade row for the account, and nothing else — so it is exactly
// the set of the deployments' *own* positions, which is what the session guard
// flattens past its window and what the restart sweep flattens past a downtime
// threshold. Their periods coincide every other pass, and none of them
// re-reads the position between deciding and submitting. Two market orders
// into one position is a naked reverse.
//
// **The watchdog↔D-2 pairing this module was written around is gone, and D-2
// stays wired anyway.** D-16 scoped the watchdog to contracts carrying a trade
// row; D-2 acts only where the same query says there is none, so the two are
// complementary and cannot contend on one `(account, contract)` key. The
// header used to describe that overlap as live — a hand position on a
// claiming deployment's own front month, inside the watchdog's set and
// unclaimed by D-2's arithmetic — and it was the stated reason this module
// exists. It is not any more; the pairings above are. **Do not read the change
// as a reason to unwire D-2.** The property here is per actor rather than per
// pair: D-2 is the one actor nothing else can stamp for, so dropping its
// consultation would be untestable from above exactly as the original gap was,
// and the complementarity is a property of two scope predicates that a change
// to either could remove without touching this file.
//
// **The exit latch cannot express this, which is why this exists.**
// `deplState.exitInFlight` is set inside `placeExitOrder`, and the watchdog
// deliberately bypasses `placeExitOrder` — so it sets no latch and carries no
// accessor to read one. The session guard and the restart sweep do latch
// against each other; neither is visible to the watchdog in either direction.
//
// The actors used to hold one cooldown map each, keyed identically and
// invisible to one another. This is the state they now share, and it is owned
// by no controller for that reason: the engine constructs one instance and
// hands it to every dep bag that needs it, which is engine.md's "value edges between
// satellites go through the engine" applied to shared state rather than to a
// call.

/**
 * `force_flat` is the fifth actor and has two callers. It has no interval of
 * its own: pressed from the board, its deferral does not become a retry, and
 * reporting the deferral to the caller is what stands in for one. Its one
 * interval caller is the closing guard, every 15s for a closing row whose
 * playbook this build does not register; its own stamp stands the guard down
 * rather than retrying, because the mirror is already torn down.
 *
 * **It can also hit its own stamp**, which is the case the other four never
 * reach: a second press inside the window defers to a submission nothing
 * will follow up. `stampedBy` exists so that arm can tell the two apart and
 * say which it is, rather than promising a retry on behalf of an actor that
 * is itself.
 */
export type FlattenActor = "watchdog" | "d2" | "session" | "restart" | "force_flat";

/** A live stamp: who submitted, and when. Returned by `stampedBy` as a copy,
 *  so a caller cannot age or re-own another actor's entry. */
export interface FlattenStamp {
  by: FlattenActor;
  /** `Date.now()` as the submitting actor read it. */
  at: number;
}

/**
 * How long a submitted flatten suppresses the next one on the same
 * (account, contract), from *any* actor.
 *
 * The longest of the four sweep periods, deliberately — it equals
 * `NAKED_POSITION_WATCHDOG_INTERVAL_MS` (the other three all run at 15s) and
 * is stated here rather than imported from it because the watchdog imports
 * this module, and the reverse edge would close a cycle. A window shorter
 * than any interval lets that actor come back around before another's market
 * order has booked, which is the whole failure. The cost is that a 15s sweep
 * skips one pass where its own retry would have been safe.
 */
export const FLATTEN_COOLDOWN_MS = 30_000;

function key(accountId: number, contractId: string): string {
  return `${accountId}:${contractId}`;
}

export class FlattenCooldown {
  private submitted = new Map<string, { at: number; by: FlattenActor }>();

  /** Number of live stamps. Exists so a test can assert the prune below; a
   *  map that only ever grows is how a 24/7 process leaks. */
  get size(): number {
    return this.submitted.size;
  }

  /**
   * True while a flatten any actor submitted may still be unbooked.
   *
   * Expired keys are dropped on read, which is what keeps a contract that was
   * flattened once and never looked at again from sitting in the map — the
   * sweep asks about every open position every pass, so a key that stops
   * being asked about is a position that closed, and `note`'s sweep collects
   * those.
   */
  active(accountId: number, contractId: string): boolean {
    return this.stampedBy(accountId, contractId) !== null;
  }

  /**
   * The same question, answered with *whose* stamp it is and when it was
   * made — null when none is live.
   *
   * Additive, and it changes nothing for the four actors that keep reading
   * `active()`: they defer identically whoever stamped, because each of them
   * has an interval that brings it back. `force_flat` has none, so it is the
   * one caller for which the answer is not the same in both directions — its
   * own stamp means nobody is coming and the operator has to press again,
   * and it cannot say so without being able to ask.
   */
  stampedBy(accountId: number, contractId: string): FlattenStamp | null {
    const k = key(accountId, contractId);
    const entry = this.submitted.get(k);
    if (!entry) return null;
    if (Date.now() - entry.at < FLATTEN_COOLDOWN_MS) return { by: entry.by, at: entry.at };
    this.submitted.delete(k);
    return null;
  }

  /**
   * Stamp *before* the submit, never after it.
   *
   * The window this closes is the one between deciding to flatten and the
   * order reaching the broker — stamping on the far side of the await leaves
   * the other actor free for exactly the round-trip that matters.
   */
  note(accountId: number, contractId: string, by: FlattenActor): void {
    const cutoff = Date.now() - FLATTEN_COOLDOWN_MS;
    for (const [k, entry] of this.submitted) {
      if (entry.at <= cutoff) this.submitted.delete(k);
    }
    this.submitted.set(key(accountId, contractId), { at: Date.now(), by });
  }

  /**
   * Drop a stamp whose order never reached the wire — a refused latch, a
   * rejected submission.
   *
   * **It refuses to drop the other actor's**, and that asymmetry is the point
   * of the `by` argument. D-2 taking an `EXIT_IN_FLIGHT` says nothing about a
   * market order the watchdog put on the book two seconds earlier, and
   * clearing it there is precisely the sequence that produced the double
   * flatten: rejected, cooldown dropped, retry fills, other actor's stale
   * positions read banks its own strike.
   */
  release(accountId: number, contractId: string, by: FlattenActor): void {
    const k = key(accountId, contractId);
    if (this.submitted.get(k)?.by === by) this.submitted.delete(k);
  }
}
