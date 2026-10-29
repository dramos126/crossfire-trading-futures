import type { BrokerKind } from "@/lib/db/account-brokers";
import type { RefreshResult } from "../../broker-access/broker-registry";

/** The part of a refresh an orphan pass reads — all a route holds of one. */
export type OrphanPassRefresh = Pick<RefreshResult, "partial" | "errors" | "listed">;

/**
 * What an orphan cross-check may conclude about a deployment account that is
 * absent from the broker registry after a fan-out.
 *
 * Three detection sites read the registry's account set and pause every
 * deployment on an account they cannot find in it. The set is only evidence
 * about the brokers that actually answered: `BrokerRegistry.refresh()` carries
 * a failed arm's entries forward, but on a cold boot there is nothing to carry,
 * so one `searchAccounts` throw leaves that broker's whole catalog absent. Read
 * as a broker's answer, that silence orphan-paused every deployment on a live
 * combine for two trading days (A74).
 *
 * The attribution is **per arm**, not per fan-out: a Tradovate outage must not
 * stop genuine Topstep orphan detection, and vice versa. That is why this takes
 * the account's *persisted* broker — `getAccountBrokerOrNull`, never
 * `getAccountBrokerOrTopstep`, because this is a safety path and "unknown" must
 * not read as "confirmed Topstep" ([brokers/README.md]).
 *
 * **Fail-open is correct here and is not to be tightened later.** Orphan-pause
 * is not the live-account safety gate — `autoTradeVerdict` is, and nothing here
 * touches it. The worst case of skipping a cross-check is one rejected order,
 * which then orphans the account as `place_order_account_not_found`: a real
 * broker answer instead of an inference from silence. The opposite error is
 * permanent, because `markOrphaned` writes `status = 'Paused'` and the row
 * leaves the set every detection site iterates.
 */
export type AbsentAccountVerdict =
  | { decision: "orphan" }
  /** `reason` completes the sentence "orphan check skipped for account N — …". */
  | { decision: "skip"; reason: string };

const ORPHAN: AbsentAccountVerdict = { decision: "orphan" };

export function attributeAbsentAccount(
  broker: BrokerKind | null,
  refresh: OrphanPassRefresh,
): AbsentAccountVerdict {
  if (broker === null) {
    // No `account_brokers` row, so there is no arm to attribute the absence
    // to. A clean fan-out is still a full answer from every configured
    // broker, and an account absent from all of them is genuinely gone.
    if (!refresh.partial) return ORPHAN;
    return {
      decision: "skip",
      reason:
        "no persisted broker for it and this refresh was partial " +
        `(${describeFailedArms(refresh)}), so its absence cannot be attributed to a broker`,
    };
  }
  const armError = refresh.errors[broker];
  if (armError == null) return ORPHAN;
  return {
    decision: "skip",
    reason:
      `its broker's fan-out arm failed on this refresh (${broker}: ${armError}). ` +
      "An arm that reported nothing is not the claim that the account is gone",
  };
}

export interface AbsentAccountPassDeps {
  isAccountRegistered: (accountId: number) => boolean;
  /** The account's persisted broker — `getAccountBrokerOrNull`, never the
   *  Topstep-defaulting read, for the reason the module doc gives. */
  brokerOf: (accountId: number) => BrokerKind | null;
  handleOrphanedAccount: (accountId: number, reason: string) => Promise<void>;
  /** `reason` completes "orphan check skipped for account N — …". Each caller
   *  logs on its own seam and names its own site. */
  onSkip: (accountId: number, reason: string) => void;
}

/**
 * One orphan pass over a refresh: every leg not already orphaned whose account
 * the refresh left absent is attributed to its own arm, and orphaned under
 * `orphanReason` when that arm answered. Returns the accounts it orphaned.
 *
 * Shared by `/api/deployments/check-orphans` and the account-status check, so
 * a refresh that resets the reconciler's 30-minute clock is cross-checked by
 * the same rule rather than a copy of it.
 *
 * **An id the refresh itself listed is present**, whatever the live registry
 * holds by the time this runs: a concurrent refresh with no Tradovate client
 * empties the Tradovate entries after this result was returned, and reading
 * the registry alone would orphan an account its own broker had just listed.
 * That is the fail-open direction, so it only ever removes a pause.
 */
export async function orphanAbsentAccounts(
  legs: Iterable<{ accountId: number; orphanReason: string | null }>,
  refresh: OrphanPassRefresh,
  orphanReason: string,
  deps: AbsentAccountPassDeps,
): Promise<number[]> {
  const listed = new Set([...(refresh.listed.topstep ?? []), ...(refresh.listed.tradovate ?? [])]);
  const absent = new Set<number>();
  for (const leg of legs) {
    // Already orphaned: handleOrphanedAccount would no-op, at the cost of a sync.
    if (leg.orphanReason != null) continue;
    if (listed.has(leg.accountId) || deps.isAccountRegistered(leg.accountId)) continue;
    absent.add(leg.accountId);
  }
  const orphaned: number[] = [];
  for (const accountId of absent) {
    const verdict = attributeAbsentAccount(deps.brokerOf(accountId), refresh);
    if (verdict.decision === "skip") {
      deps.onSkip(accountId, verdict.reason);
      continue;
    }
    orphaned.push(accountId);
    await deps.handleOrphanedAccount(accountId, orphanReason);
  }
  return orphaned;
}

function describeFailedArms(refresh: OrphanPassRefresh): string {
  const failed: string[] = [];
  if (refresh.errors.topstep != null) failed.push(`topstep: ${refresh.errors.topstep}`);
  if (refresh.errors.tradovate != null) failed.push(`tradovate: ${refresh.errors.tradovate}`);
  return failed.join("; ");
}
