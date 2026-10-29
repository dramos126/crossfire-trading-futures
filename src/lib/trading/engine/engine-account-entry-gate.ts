/**
 * The engine's account-state entry gate: a running deployment takes no new
 * entry while its account is dead, locked out, or (Topstep) has Auto OCO
 * Brackets off. Exits and the management of an open position are untouched —
 * `processDeployment` asks this only on the entry path, beside the flap breaker.
 *
 * **One predicate, read through.** Dead / locked / OCO are decided by
 * `accountStateVerdict` (brokers/README.md, the account-state gate), never
 * re-derived here. The one difference from the deploy screen is deliberate:
 * an **unknown** OCO setting refuses a *new* deployment but does not stop a
 * running one. Unknown means the website read failed or fell back; the deploy
 * screen already refused the account at creation, so a running deployment on
 * it was created while OCO read `true`, and halting every running Topstep
 * deployment whenever that undocumented endpoint is down is the wrong failure
 * direction for an engine that is already trading.
 *
 * It reads the stored answer only — `account_brokers` as the last status check
 * wrote it — and never calls a broker on the tick.
 *
 * A controller rather than a field on `DeploymentState`: the per-deployment
 * memory of which reason was last announced is written by nothing else
 * (engine.md, *Extraction pattern*). It exists so the line is said once per
 * deployment per reason, and once when it clears, never per bar.
 *
 * **A detached deployment (`orphanReason` set) is refused here too, on the
 * same entry-only terms (A75).** It stays in the managed set and the exit
 * loop until flat; it opens nothing while the marker stands. The marker is
 * read from the database row by id, never from the caller's `Deployment`:
 * `/api/engine` start/update hands the engine rows off a request body, and a
 * body cannot clear the marker.
 */

import {
  accountStateVerdict,
  deadBreachPhrase,
  type AccountDeployState,
  type AccountStateCause,
  type AccountStateRefusalKind,
} from "@/lib/trading/broker-access/account-state-gate";
import { TRADING_TIMEZONE } from "@/lib/trading/strategy-types";

/** The refusals that stop a running deployment's entries. */
export type AccountEntrySkipKind = Exclude<AccountStateRefusalKind, "oco-unknown">;

export interface AccountEntrySkip {
  kind: AccountEntrySkipKind;
  cause: AccountStateCause | null;
  lockoutReason: string | null;
  lockoutUntil: string | null;
}

/**
 * Whether a running deployment on this account skips its entry at `now`, and
 * why. `null` state — no catalogue row — skips nothing here: the live-account
 * block already withholds such a row from the engine's managed set.
 */
export function accountEntrySkip(state: AccountDeployState | null, now: Date): AccountEntrySkip | null {
  if (state == null) return null;
  const verdict = accountStateVerdict(state, now);
  if (verdict.permitted || verdict.kind === "oco-unknown") return null;
  return {
    kind: verdict.kind,
    cause: state.cause,
    lockoutReason: state.lockoutReason,
    lockoutUntil: state.lockoutUntil,
  };
}

/** The event each skip is announced under, and the one that says it cleared. */
export const ACCOUNT_ENTRY_SKIP_EVENTS: Record<AccountEntrySkipKind, string> = {
  dead: "deployment_account_dead",
  locked: "deployment_account_locked",
  "oco-off": "deployment_account_oco_off",
};
export const ACCOUNT_ENTRY_RESUMED_EVENT = "deployment_account_entries_resumed";
export const DETACHED_ENTRY_SKIP_EVENT = "deployment_detached";

const STILL_MANAGED = "An open position is still managed to its exit.";

export function detachedEntrySkipMessage(orphanReason: string): string {
  return (
    `Entries skipped: this deployment is detached (${orphanReason}) and opens no new position ` +
    `until Restore and arm clears it. ${STILL_MANAGED}`
  );
}

const LOCK_END_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: TRADING_TIMEZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function accountEntrySkipMessage(skip: AccountEntrySkip): string {
  switch (skip.kind) {
    case "dead": {
      const breach = deadBreachPhrase(skip.cause, skip.lockoutReason);
      const why =
        breach === null
          ? "its broker reports the account failed, ineligible or closed"
          : `the account can no longer trade (${breach})`;
      return `Entries skipped: ${why}. ${STILL_MANAGED} Move it to a replacement account or remove it.`;
    }
    case "locked": {
      const why = skip.lockoutReason?.trim() ? ` (${skip.lockoutReason.trim()})` : "";
      const until = skip.lockoutUntil == null ? NaN : Date.parse(skip.lockoutUntil);
      return Number.isNaN(until)
        ? `Entries skipped: the account is locked out${why} and its broker gave no end time. ` +
            `Entries resume when a status check finds the lock lifted. ${STILL_MANAGED}`
        : `Entries skipped: the account is locked out${why} until ` +
            `${LOCK_END_FORMAT.format(new Date(until))} ET. Entries resume on their own then. ${STILL_MANAGED}`;
    }
    case "oco-off":
      return (
        "Entries skipped: Auto OCO Brackets is off for the account in Topstep. Entries resume " +
        `once it is turned on in Topstep's settings and the next status check reads it. ${STILL_MANAGED}`
      );
  }
}

const WAS: Record<AccountEntrySkipKind, string> = {
  dead: "reported dead",
  locked: "locked out",
  "oco-off": "Auto OCO Brackets off",
};

export interface AccountEntryGateDeps {
  /** The stored account state; never a broker call. */
  readState(accountId: number): AccountDeployState | null;
  /** The deployment row's `orphanReason` as the database stores it — never
   *  the caller's `Deployment`, which may have come off a request body. */
  readOrphanReason(deploymentId: string): string | null;
  announce(event: string, deploymentId: string, accountId: number, message: string): void;
}

type EntrySkipKind = AccountEntrySkipKind | "detached";

export class AccountEntryGate {
  /** Deployment id → the reason last announced for it. Absent is "entries open". */
  private readonly skipping = new Map<string, EntrySkipKind>();

  constructor(private readonly deps: AccountEntryGateDeps) {}

  /** True when this deployment's entry is skipped at `now`. Speaks only on a change of reason. */
  skipsEntry(deploymentId: string, accountId: number, now: Date): boolean {
    const was = this.skipping.get(deploymentId);
    const orphanReason = this.deps.readOrphanReason(deploymentId);
    if (orphanReason != null) {
      if (was !== "detached") {
        this.skipping.set(deploymentId, "detached");
        this.deps.announce(DETACHED_ENTRY_SKIP_EVENT, deploymentId, accountId, detachedEntrySkipMessage(orphanReason));
      }
      return true;
    }
    const skip = accountEntrySkip(this.deps.readState(accountId), now);
    if (skip == null) {
      if (was !== undefined) {
        this.skipping.delete(deploymentId);
        // A detached skip ends only on the operator's Restore and arm, which
        // says so itself; the resumed event's words are about the account.
        if (was !== "detached") {
          this.deps.announce(
            ACCOUNT_ENTRY_RESUMED_EVENT,
            deploymentId,
            accountId,
            `Entries resume: the account is no longer ${WAS[was]}.`,
          );
        }
      }
      return false;
    }
    if (was !== skip.kind) {
      this.skipping.set(deploymentId, skip.kind);
      this.deps.announce(ACCOUNT_ENTRY_SKIP_EVENTS[skip.kind], deploymentId, accountId, accountEntrySkipMessage(skip));
    }
    return true;
  }

  /** Keep only these deployments — the sync's set. A dropped one is forgotten silently. */
  retain(deploymentIds: ReadonlySet<string>): void {
    for (const id of [...this.skipping.keys()]) if (!deploymentIds.has(id)) this.skipping.delete(id);
  }

  /** Engine stop: a restarted engine announces a standing skip again. */
  reset(): void {
    this.skipping.clear();
  }
}
