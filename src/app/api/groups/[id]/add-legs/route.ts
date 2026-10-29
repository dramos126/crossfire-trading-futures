import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getGroup } from "@/lib/db/deployment-groups";
import {
  filterMainSessionOverlaps,
  findConflictingDeployments,
  insertDeployment,
  listGroupLegs,
  sessionForStrategyKey,
} from "@/lib/db/deployments";
import { getDb } from "@/lib/db/connection";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import type { Deployment } from "@/lib/trading/domain";

const handle = engineHandle();

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/groups/[id]/add-legs
 *
 * Add one or more legs to an existing deployment. Each new leg carries an
 * account and an optional size override; params, ticker and contract are
 * the parent's. The live-account block and the per-leg conflict check
 * match `POST /api/deployments` so the account picker behaves the same
 * whichever way a leg arrives.
 *
 * **A leg may route through a different broker than its siblings**, which
 * is what the deleted gate refused. The consequence is in
 * [architecture.md](../../../../../../docs/architecture.md): the two legs
 * share one market sub, so execution identity is resolved per leg and
 * never taken off the sub.
 *
 * Body: { accountIds: number[] }
 *
 * Rejects:
 *   - empty accountIds
 *   - any accountId duplicating an existing active leg
 *   - any accountId duplicating another entry in this batch
 *   - per-leg main-session overlap with another deployment
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input = body as {
    accountIds?: unknown;
  };

  if (!Array.isArray(input.accountIds) || input.accountIds.length === 0) {
    return NextResponse.json(
      { error: "accountIds must be a non-empty array" },
      { status: 400 },
    );
  }
  for (const aid of input.accountIds) {
    if (typeof aid !== "number" || !Number.isInteger(aid)) {
      return NextResponse.json({ error: "accountIds must be integers" }, { status: 400 });
    }
  }
  const newAccountIds = input.accountIds as number[];

  if (new Set(newAccountIds).size !== newAccountIds.length) {
    return NextResponse.json(
      { error: "Duplicate accountId in accountIds" },
      { status: 400 },
    );
  }

  const group = getGroup(id);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (group.deletedAt != null) {
    return NextResponse.json({ error: "Group is soft-deleted" }, { status: 409 });
  }

  const existingLegs = listGroupLegs(id);
  // Defense vs UD2 race: if a concurrent remove-leg + cascade fired
  // softDeleteGroup but this add-legs read the pre-cascade row, the
  // group has zero legs at this exact moment. Reject so the caller
  // refreshes and retries against the (likely soft-deleted) group.
  if (existingLegs.length === 0) {
    return NextResponse.json(
      { error: "Group has no legs — refresh and retry" },
      { status: 409 },
    );
  }
  const existingAccountIds = new Set(existingLegs.map((l) => l.accountId));
  const dupes: number[] = [];
  for (const aid of newAccountIds) {
    if (existingAccountIds.has(aid)) dupes.push(aid);
  }
  if (dupes.length > 0) {
    return NextResponse.json(
      {
        error: `Conflict on ${dupes.length} of ${newAccountIds.length} new accounts.`,
        conflicts: dupes.map((aid) => ({
          accountId: aid,
          conflictName: "(already a leg)",
        })),
      },
      { status: 409 },
    );
  }

  // Live-account block on the incoming legs. This route inserts new
  // deployment rows on caller-supplied accounts, so it reaches a live
  // account exactly as directly as POST /api/deployments does.
  const refusal = screenAccountsForAutoTrade(newAccountIds);
  if (refusal) {
    return NextResponse.json(
      { error: refusal.message, refusedAccounts: refusal.refused },
      { status: 403 },
    );
  }

  // Per-leg conflict check, only when the group is enabled. Mirrors
  // promote-to-group + POST /api/groups.
  if (group.enabled) {
    const candidateMain = sessionForStrategyKey(group.strategyKey);
    if (!candidateMain) {
      return NextResponse.json(
        { error: `Strategy ${group.strategyKey} is not registered, so it declares no session.` },
        { status: 400 },
      );
    }
    const conflicts: Array<{ accountId: number; conflictId: string; conflictName: string | null }> = [];
    for (const aid of newAccountIds) {
      const sameTriple = findConflictingDeployments(aid, group.ticker, group.strategyKey);
      const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
      if (overlaps.length > 0) {
        conflicts.push({
          accountId: aid,
          conflictId: overlaps[0].id,
          conflictName: overlaps[0].name,
        });
      }
    }
    if (conflicts.length > 0) {
      return NextResponse.json(
        {
          error: `Conflict on ${conflicts.length} of ${newAccountIds.length} new accounts.`,
          conflicts,
        },
        { status: 409 },
      );
    }
  }

  let newLegs: Deployment[];
  try {
    const tx = getDb().transaction(() => {
      const legs: Deployment[] = [];
      for (const aid of newAccountIds) {
        const leg = insertDeployment({
          strategyKey: group.strategyKey,
          accountId: aid,
          ticker: group.ticker,
          contractId: group.contractId,
          status: group.enabled ? "Active" : "Paused",
          paramValues: group.paramValues,
          name: group.name,
          groupId: group.id,
          // A leg added under a disabled parent needs its snapshot seeded
          // or `enableGroupAndRestore` skips it and the resume is a no-op.
          enabledSnapshot: group.enabled ? null : true,
        });
        legs.push(leg);
      }
      return legs;
    });
    newLegs = tx();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Add legs failed" },
      { status: 500 },
    );
  }

  await handle.emitDeploymentsChanged();
  await handle.syncIfRunning();

  return NextResponse.json({ legs: newLegs });
}
