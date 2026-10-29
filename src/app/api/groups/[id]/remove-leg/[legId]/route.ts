import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getGroup, softDeleteGroup } from "@/lib/db/deployment-groups";
import {
  getDeployment,
  listGroupLegs,
  softDeleteDeployment,
} from "@/lib/db/deployments";
import { legHasOpenPositionWithFallback } from "@/lib/trading/orders/leg-position";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { getDb } from "@/lib/db/connection";
import { LAST_LEG_REFUSAL } from "@/lib/trading/domain";
import {
  createOpenPositionLookup,
  hasOpenPositionOnBroker,
} from "@/lib/trading/broker-access/open-position-lookup";

const handle = engineHandle();

interface RouteContext {
  params: Promise<{ id: string; legId: string }>;
}

/**
 * POST /api/groups/[id]/remove-leg/[legId]
 *
 * Soft-delete a single leg out of a deployment. A leg whose account holds
 * an open broker position cannot be removed — that would abandon the
 * position to its bracket with no engine-managed exits.
 *
 * **Removing the final leg is refused, not a delete.** Deleting a whole
 * deployment as a side effect of subtracting a row is a surprise, and
 * `DELETE /api/groups/[id]` carries its own confirm, its own open-position
 * gate across every leg, and the `Destroying` path — none of which should
 * be reachable by subtraction. The editor disables the last checkbox; this
 * is the server half of the same rule.
 *
 * The last-leg cascade below survives that refusal as the **concurrent-
 * removal backstop**: two removals racing on a two-leg deployment both see
 * two legs, both pass, and one of them lands on zero. It is unreachable by
 * a single caller and is the only thing that stops an empty shell.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id: groupId, legId } = await ctx.params;

  const group = getGroup(groupId);
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
  if (group.deletedAt != null) {
    return NextResponse.json({ error: "Group is soft-deleted" }, { status: 409 });
  }

  const leg = getDeployment(legId);
  if (!leg) return NextResponse.json({ error: "Leg not found" }, { status: 404 });
  if (leg.deletedAt != null) {
    return NextResponse.json({ error: "Leg is already soft-deleted" }, { status: 409 });
  }
  if (leg.groupId !== groupId) {
    return NextResponse.json(
      { error: "Leg does not belong to this group" },
      { status: 409 },
    );
  }

  // Refused, not a delete — see the note above. Checked before the
  // open-position gate so the answer does not depend on a broker round
  // trip: the refusal is the same either way, and the message the operator
  // gets should be the one that tells them what to do instead.
  if (listGroupLegs(groupId).length <= 1) {
    return NextResponse.json({ error: LAST_LEG_REFUSAL }, { status: 409 });
  }

  // Open-position gate. Mirrors convert-to-standalone — engine state
  // first, then the leg account's own broker for cold-boot scenarios.
  // Fail-closed: an unavailable client or a failing search throws and
  // `legHasOpenPositionWithFallback` reads that as "in position".
  const lookup = createOpenPositionLookup();
  const inPos = await legHasOpenPositionWithFallback(
    (await handle.peekLegPosition(leg.id)) ?? undefined,
    () => hasOpenPositionOnBroker(lookup, leg),
  );
  if (inPos) {
    return NextResponse.json(
      {
        error:
          "Cannot remove — this leg's account holds an open position. Close it or wait for exit.",
      },
      { status: 409 },
    );
  }

  let groupSoftDeleted = false;
  try {
    const tx = getDb().transaction(() => {
      softDeleteDeployment(legId);
      const remaining = listGroupLegs(groupId);
      if (remaining.length === 0) {
        softDeleteGroup(groupId);
        groupSoftDeleted = true;
      }
    });
    tx();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Remove failed" },
      { status: 500 },
    );
  }

  await handle.emitDeploymentsChanged();
  await handle.syncIfRunning();

  const refreshed = getDeployment(legId);
  return NextResponse.json({ deployment: refreshed, groupSoftDeleted });
}
