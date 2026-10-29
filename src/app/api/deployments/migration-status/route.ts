import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getMigrationBlocked } from "@/lib/trading/session/session-migration-status";
import { listPendingReconciliationDeployments } from "@/lib/db/deployments";

/** Surfaces the boot-time session-migration runner's results to the
 *  Active-tab banner. Two slices:
 *
 *    - `blocked`: deployments the runner skipped because an open broker
 *      position exists on the row **or on a sibling leg of the same
 *      parent** — the session config it rewrites lives on the parent and
 *      is shared, so the block is a property of the deployment rather than
 *      of the account. A blocked row may itself be flat. Flatten the
 *      deployment before the next boot to finish the migration.
 *    - `pendingReconciliation`: deployments the runner already
 *      disabled and flagged. The user opens each one and either
 *      accepts mainSession only or splits into multiple deployments.
 */
export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  const blocked = Array.from(getMigrationBlocked());
  const pending = listPendingReconciliationDeployments().map((d) => ({
    id: d.id,
    name: d.name,
    strategyKey: d.strategyKey,
    accountId: d.accountId,
    ticker: d.ticker,
    reason: d.pendingReconciliation,
  }));
  return NextResponse.json({ blocked, pendingReconciliation: pending });
}
