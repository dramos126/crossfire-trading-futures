import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDeployment, clearOrphanedAndReEnable } from "@/lib/db/deployments";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { listDerivedRows } from "@/lib/db/books";
import {
  isClosingStatus,
  RESTORE_NEEDS_PLAYBOOK_ON,
  RESTORE_WOULD_RETRACT_A_CLOSE,
} from "@/lib/trading/domain";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { id } = await ctx.params;
  const deployment = getDeployment(id);
  if (!deployment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deployment.orphanReason == null) {
    return NextResponse.json({ error: "Deployment is not orphaned" }, { status: 409 });
  }
  // This route re-enables, so it can put a pre-block row on a live account
  // back into the engine. It cannot re-point the deployment, but "resume
  // trading here" needs the same permission as "start trading here". First of
  // the refusals: it never clears, so a sentence saying *wait* must not stand
  // in front of it.
  const refusal = screenAccountsForAutoTrade([deployment.accountId]);
  if (refusal) return NextResponse.json({ error: refusal.message }, { status: 403 });
  // `markOrphaned` keeps a closing status, so a row can be detached mid-close
  // — an `AccountNotFound` from the very `placeOrder` the closing guard just
  // issued is enough. `clearOrphanedAndReEnable` writes `Active` regardless,
  // which retracts the operator's Destroy, drops the row out of
  // `listClosingDeployments()` and re-arms entries over an open position.
  //
  // This guard holds only because nothing between this read and the write
  // below awaits: better-sqlite3 is synchronous and the engine shares the
  // process, so the closing guard cannot write `Pausing` in between. Add an
  // `await` here and the check has to move into the UPDATE's WHERE clause.
  if (isClosingStatus(deployment.status)) {
    return NextResponse.json({ error: RESTORE_WOULD_RETRACT_A_CLOSE }, { status: 409 });
  }
  // `clearOrphanedAndReEnable` writes the leg alone, so under a book's
  // switched-off parent it would leave a leg that does not trade holding its
  // own slot (bugs.md A85). Enabling the parent here instead would restore
  // every sibling leg from its snapshot — arming more than the one pressed.
  // After the closing check, though it does not clear by waiting: the move it
  // names is the book's off-and-on, whose on is itself refused over a
  // `Pausing` leg, and a `Destroying` one is reaped once flat. Waiting is the
  // first move either way.
  const derived = listDerivedRows().find((row) => row.groupId === deployment.groupId);
  if (derived != null && !derived.enabled) {
    return NextResponse.json({ error: RESTORE_NEEDS_PLAYBOOK_ON }, { status: 409 });
  }

  clearOrphanedAndReEnable(id);
  await handle.emitDeploymentsChanged();
  await handle.syncIfRunning();

  return NextResponse.json({ ok: true });
}
