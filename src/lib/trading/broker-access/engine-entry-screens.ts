import { autoTradeVerdictForAccountId } from "@/lib/db/account-brokers";
import { listClosingDeployments } from "@/lib/db/deployments";
import type { Deployment, DeploymentStatus } from "@/lib/trading/domain";
import { log } from "@/lib/logger";

/**
 * The screens every engine entry point that takes a caller-supplied
 * deployment list applies before the engine sees it — `/api/engine` and the
 * engine process's internal endpoint both call these, so a third entry point
 * is one more call, never a third copy. `listManagedDeployments()` covers
 * the lists the engine reads from the database; these cover the body.
 */

export interface WithheldLiveAccount {
  id: string;
  accountId: number;
  reason: string;
}

export interface WithheldNotAllowed {
  id: string;
  accountId: number;
}

export interface BodyDeploymentScreen {
  deployments: Deployment[];
  skippedLiveAccounts: WithheldLiveAccount[];
  skippedNotAllowed: WithheldNotAllowed[];
}

/**
 * The live-account block (through the one predicate), then the staging
 * allowlist. The allowlist is passed in rather than read here because it is
 * a global of the process that booted the engine: a `web` process reads it
 * through the handle, and a direct read there would be null — no filter.
 * `action` names the caller's verb in the log lines.
 */
export function screenBodyDeployments(
  list: Deployment[],
  stagingAllowlist: readonly number[] | null,
  action: string,
): BodyDeploymentScreen {
  const skippedLiveAccounts: WithheldLiveAccount[] = [];
  const permitted: Deployment[] = [];
  for (const d of list) {
    const verdict = autoTradeVerdictForAccountId(d.accountId);
    if (verdict.permitted) permitted.push(d);
    else skippedLiveAccounts.push({ id: d.id, accountId: d.accountId, reason: verdict.reason });
  }
  if (skippedLiveAccounts.length > 0) {
    log.event(
      "deployment_withheld",
      "engine",
      `${action}: ${skippedLiveAccounts.length} deployment(s) withheld — auto-trading not permitted on their accounts`,
    );
  }

  // Null is the prod path: no allowlist, no filter.
  if (!stagingAllowlist || permitted.length === 0) {
    return { deployments: permitted, skippedLiveAccounts, skippedNotAllowed: [] };
  }
  const allowed = new Set(stagingAllowlist);
  const deployments: Deployment[] = [];
  const skippedNotAllowed: WithheldNotAllowed[] = [];
  for (const d of permitted) {
    if (allowed.has(d.accountId)) deployments.push(d);
    else skippedNotAllowed.push({ id: d.id, accountId: d.accountId });
  }
  if (skippedNotAllowed.length > 0) {
    log.event(
      "deployment_skipped_allowlist",
      "engine",
      `${action}: ${skippedNotAllowed.length} deployment(s) skipped — accountId not in staging allowlist`,
    );
  }
  return { deployments, skippedLiveAccounts, skippedNotAllowed };
}

export interface StopWhileClosingRefusal {
  error: string;
  closing: { id: string; status: DeploymentStatus }[];
}

/**
 * Why the engine may not stop now, or null. A closing row is unfinished work
 * the engine owes, and stopping is what makes it unfinishable: the closing
 * guard survives `stop()` and will still submit the exit, but `stop()` clears
 * the interval driving `reconcilePendingTrades` and sets
 * `realtimeEventsEnabled = false`, so nothing can confirm the fill. The
 * position closes at the broker and the row is stranded `Pausing` with its
 * trade stuck `pending_exit`. The UI computes its stop/update decision from
 * the same predicate, but it is not the only caller.
 */
export function stopWhileClosingRefusal(): StopWhileClosingRefusal | null {
  const closing = listClosingDeployments();
  if (closing.length === 0) return null;
  return {
    error: `Cannot stop the engine while ${closing.length} deployment(s) are still closing — stopping now would submit their exits and then remove the only thing that can confirm the fills.`,
    closing: closing.map((d) => ({ id: d.id, status: d.status })),
  };
}

/** The 409 both stop paths answer a refusal with. */
export const STOP_WHILE_CLOSING_STATUS = 409;
