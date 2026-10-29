import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  clearOrphaned,
  deleteDeployment,
  findConflictingDeployments,
  filterMainSessionOverlaps,
  sessionForStrategyKey,
  getDeployment,
  listGroupLegs,
  patchWouldBeTradeable,
  softDeleteDeployment,
  updateDeployment,
  type DeploymentPatch,
} from "@/lib/db/deployments";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { softDeleteGroup } from "@/lib/db/deployment-groups";
import { listDerivedRows } from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  MOVE_NEEDS_A_PAUSED_LEG,
  MOVE_WOULD_MISDIRECT_A_CLOSE,
  RESUME_WOULD_RETRACT_A_CLOSE,
  isClosingStatus,
  isOperatorDeploymentStatus,
} from "@/lib/trading/domain";
import { legHasOpenPositionWithFallback } from "@/lib/trading/orders/leg-position";
import {
  createOpenPositionLookup,
  hasOpenPositionOnBroker,
} from "@/lib/trading/broker-access/open-position-lookup";
import { validatePauseWindows } from "@/lib/trading/session/session";
import type { PauseWindow } from "@/lib/trading/strategy-types";

const handle = engineHandle();

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const deployment = getDeployment(id);
  if (!deployment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deployment });
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const patch = body as DeploymentPatch;
  if (patch.name !== undefined && patch.name !== null && typeof patch.name !== "string") {
    return NextResponse.json({ error: "Invalid deployment name" }, { status: 400 });
  }
  // Params live on the deployment, and a leg has an account and a size
  // override. A body naming them is refused rather than dropped: dropping
  // it would answer 200 to an edit that did not happen.
  if ("paramValues" in (body as Record<string, unknown>)) {
    return NextResponse.json(
      { error: "Parameters are edited on the deployment, not on a leg." },
      { status: 400 },
    );
  }
  // **A capability removal, not a refactor.** A standalone deployment could
  // be re-pointed at a different instrument until this shipped. It cannot
  // now: a deployment is strategy plus instrument, and moving one leaves a
  // single row whose trade history spans two. Delete and recreate is the
  // honest operation, and it is what the message says.
  if ("ticker" in (body as Record<string, unknown>) || "strategyKey" in (body as Record<string, unknown>)) {
    return NextResponse.json(
      {
        error:
          "Strategy and instrument are fixed when a deployment is created. " +
          "Delete this deployment and create a new one.",
      },
      { status: 400 },
    );
  }
  // `Pausing` and `Destroying` are the engine's to write, never a client's:
  // they are a claim that a close is under way, and only the thing running
  // the close may make it. Destroy is a DELETE, not a status assignment.
  if (patch.status !== undefined && !isOperatorDeploymentStatus(patch.status)) {
    return NextResponse.json(
      { error: "status must be \"Active\" or \"Paused\"" },
      { status: 400 },
    );
  }

  const existing = getDeployment(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The reconciler is the only writer of a derived row's state — a status
  // write here would make this leg its own slot holder, and the book could
  // never resume it. Checked ahead of the screen and the broker-backed
  // position check below, the same ordering the group DELETE's refusal uses.
  if (
    patch.status !== undefined &&
    listDerivedRows().some((row) => row.groupId === existing.groupId)
  ) {
    return NextResponse.json({ error: BOOK_DERIVED_ROW_REFUSAL }, { status: 409 });
  }

  const nextStatus = patch.status ?? existing.status;
  const nextAccountId = patch.accountId ?? existing.accountId;
  // Pinned at creation, both of them — a deployment's identity is strategy
  // plus instrument. Only the account can move, and only onto a leg whose
  // own account went away.
  const nextTicker = existing.ticker;
  const nextStrategyKey = existing.strategyKey;

  // This route can move a deployment onto a different account, so the
  // check is on the *resulting* account, not the existing one. The
  // condition itself lives in `db/deployments.ts` with its own tests —
  // see `patchWouldBeTradeable` for why both of its clauses are there.
  if (patchWouldBeTradeable(existing, patch)) {
    const refusal = screenAccountsForAutoTrade([nextAccountId]);
    if (refusal) return NextResponse.json({ error: refusal.message }, { status: 403 });
  }

  if (nextStatus === "Active") {
    // The window is the playbook's, not the row's. An unregistered strategy
    // has none, and arming a leg the engine could not evaluate is the thing
    // this check is for — it just names the module now rather than the blob.
    const nextParams = existing.paramValues as Record<string, unknown>;
    const candidateMain = sessionForStrategyKey(nextStrategyKey);
    if (!candidateMain) {
      return NextResponse.json(
        { error: `Strategy ${nextStrategyKey} is not registered, so it declares no session.` },
        { status: 400 },
      );
    }
    const rawPauses = nextParams.pauseWindows;
    if (rawPauses != null) {
      if (!Array.isArray(rawPauses)) {
        return NextResponse.json({ error: "pauseWindows must be an array" }, { status: 400 });
      }
      const pauseCheck = validatePauseWindows(candidateMain, rawPauses as PauseWindow[]);
      if (!pauseCheck.valid) {
        return NextResponse.json({ error: pauseCheck.error }, { status: 400 });
      }
    }
    const sameTriple = findConflictingDeployments(
      nextAccountId,
      nextTicker,
      nextStrategyKey,
      id,
    );
    const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
    if (overlaps.length > 0) {
      const c = overlaps[0];
      return NextResponse.json(
        {
          error:
            `Main session overlaps an existing active deployment of ${nextStrategyKey} ` +
            `on ${nextTicker}.`,
          conflictId: c.id,
          conflictName: c.name,
        },
        { status: 409 },
      );
    }
  }

  // The two refusals that clear by waiting, last, and both whole-body. `Active`
  // over `Pausing`/`Destroying` would drop the close in flight and re-arm
  // entries with the position open. A move would send the close to the new
  // account, because the closing guard flattens whatever account the row names:
  // the old account's position is never closed, and one on the new account that
  // belongs to another deployment can be. A pause and a rename stay allowed.
  if (patch.status === "Active" && isClosingStatus(existing.status)) {
    return NextResponse.json({ error: RESUME_WOULD_RETRACT_A_CLOSE }, { status: 409 });
  }
  // A move is allowed only from a settled `Paused` leg (orphan recovery), judged
  // on the status before the request: an `Active` leg may hold a position that a
  // pause in the same body would turn into `Pausing` on the new account.
  if (nextAccountId !== existing.accountId && existing.status !== "Paused") {
    return NextResponse.json(
      { error: isClosingStatus(existing.status) ? MOVE_WOULD_MISDIRECT_A_CLOSE : MOVE_NEEDS_A_PAUSED_LEG },
      { status: 409 },
    );
  }

  // A pause on a `Destroying` leg is already satisfied by the delete, and
  // writing `Pausing`/`Paused` over it would retract the delete: the guard would
  // settle the row instead of reaping it. The status is dropped and the rest of
  // the body applies — the same reason `disableGroupWithSnapshot` keeps
  // `Destroying`.
  const operatorPatch: DeploymentPatch = { ...patch };
  if (patch.status === "Paused" && existing.status === "Destroying") delete operatorPatch.status;
  // An empty remainder (a bare `{}`, or a pause dropped above) answers the row
  // unchanged: no write, no sync, no announce.
  if (Object.keys(operatorPatch).length === 0) return NextResponse.json({ deployment: existing });

  // A Pause on a deployment that still holds a position is `Pausing`, not
  // `Paused` — D-4 says a deployment that is not Active holds no position,
  // and this row is not flat yet. The request does not wait for the close:
  // `placeExitOrder` returns at submission and flat is confirmed later, so a
  // request that waited would race the client's own timeout and strand the
  // work if the tab closed. The status is the durable handle on that work.
  const effectivePatch: DeploymentPatch =
    operatorPatch.status === "Paused" && (await holdsPosition(id))
      ? { ...operatorPatch, status: "Pausing" }
      : operatorPatch;

  try {
    const updated = updateDeployment(id, effectivePatch);
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // The write reaching the engine promptly is necessary but not sufficient:
    // the *work* the status implies sat idle for up to one guard interval
    // before the first submission attempt. Fire-and-forget, and deliberately
    // not awaited — the request still returns at the status write, never at
    // flat. Only on a row that actually entered a transient state; a Pause
    // that wrote `Paused` has nothing to flatten.
    if (effectivePatch.status === "Pausing") await handle.nudgeClosingGuard();
    // Reassigning a detached deployment to a new account clears the orphan
    // markers — the row no longer points at a vanished account, so it
    // belongs back in the Active tab. Stays paused; user opts in via
    // toggle so an unintended save doesn't auto-resume live trading.
    let result = updated;
    if (
      existing.orphanReason != null &&
      patch.accountId != null &&
      patch.accountId !== existing.accountId
    ) {
      clearOrphaned(id);
      result = getDeployment(id) ?? updated;
    }
    // Below the orphan clearing rather than above it, on the same rule as the
    // DELETE site's group cascade: the refetch this provokes must not read a
    // row one statement away from losing its orphan markers. One call above
    // one return — a tab that is not this one has no other way to learn,
    // because `useDeployments` hydrates once and never polls.
    await handle.emitDeploymentsChanged();
    // The engine's deployment set is an in-memory projection of these rows,
    // and a status change is the one edit it must not learn late: a `Pausing`
    // row the engine still reads as `Active` can open a fresh position after
    // the operator has asked it to stop.
    await handle.syncIfRunning();
    return NextResponse.json({ deployment: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 500 },
    );
  }
}

/**
 * Does this deployment still hold a position? Engine state first, broker
 * search when the engine has none — the same source priority and the same
 * fail-closed contract as every other route-level gate.
 *
 * Fail-closed here means `Pausing` rather than `Paused` on an unknown answer,
 * which costs one closing-guard interval: the guard finds nothing to close
 * and settles the row itself. The opposite mistake — calling a deployment
 * flat when it is not — is the one D-4 exists to abolish.
 */
async function holdsPosition(id: string): Promise<boolean> {
  const deployment = getDeployment(id);
  if (!deployment) return false;
  // Both halves, matching `settleIfFlatSync` — the durable trade row *and*
  // the in-memory mirror. The mirror alone is not enough here for the same
  // reason it is not enough there, and the failure is the inverse:
  //   - an exit in flight nulls `position` at *submission* while the trade
  //     row sits `pending_exit`, so the mirror says flat over a live position
  //     and Pause would write `Paused` directly, skipping `Pausing`;
  //   - after a restart `seedStatePositionFromOpenTrade` refuses to seed
  //     unless the row is `open` with an entry price, so a `pending_exit` row
  //     leaves the mirror null while the broker may still hold contracts.
  // The broker fallback does not cover it either: `restoreLastBarTimestamps`
  // calls `getState` for every managed deployment at boot, so a state entry
  // always exists while the engine runs and the fallback never fires.
  if (getOpenTradeForDeployment(id) != null) return true;
  const lookup = createOpenPositionLookup();
  return legHasOpenPositionWithFallback((await handle.peekLegPosition(id)) ?? undefined, () =>
    hasOpenPositionOnBroker(lookup, deployment),
  );
}

/**
 * Soft-delete by default — moves the deployment to the Trash tab, keeps
 * the row so trades stay attached. Pass `?hard=true` to retire the row
 * (tombstone — used by the Trash tab's "Retire" button). Retire sets
 * `tombstoned_at` instead of removing the row, so strategy_trades keep
 * a valid foreign key for attribution and the Retired bucket on the
 * All-Time card can label them properly.
 *
 * **Destroy cannot hard-delete a deployment that still holds a position.**
 * D-4 says destroying closes, and something has to hold the intent until
 * the close is confirmed — a deleted row cannot. So a soft delete on a row
 * in position writes `Destroying` and returns; the closing guard flattens
 * it and performs this same soft delete once it is confirmed flat. `?hard`
 * is unaffected: it operates on rows already in the Trash, which are flat.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const hard = url.searchParams.get("hard") === "true";
  // Snapshot groupId before the row gets soft-deleted so we can check
  // whether this was the group's last active leg.
  const before = getDeployment(id);
  // Retire (`?hard=true`) operates on rows already in Trash, which are settled
  // by definition — but that was an assumption about the caller, not something
  // the route enforced, and the doc read as a guarantee. Falling through here
  // tombstones a live row, `Destroying` included, out from under an open
  // position. Only the Trash tab renders the affordance today; the route is
  // reachable directly.
  if (hard && before != null && before.deletedAt == null) {
    return NextResponse.json(
      { error: "Retire applies to deployments already in Trash. Delete it first." },
      { status: 409 },
    );
  }
  if (!hard && before != null && before.deletedAt == null && (await holdsPosition(id))) {
    const destroying = updateDeployment(id, { status: "Destroying" });
    await handle.emitDeploymentsChanged();
    await handle.syncIfRunning();
    // Same reason as the `Pausing` write in PATCH: start the close now rather
    // than on the guard's next pass. The guard's pass is not awaited — this
    // returns at the status write, not at flat.
    await handle.nudgeClosingGuard();
    return NextResponse.json({ ok: true, hard: false, destroying: true, deployment: destroying });
  }
  const removed = hard ? deleteDeployment(id) : softDeleteDeployment(id);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Cascade: when a soft-delete drops a deployment's last active leg,
  // soft-delete the parent too so an empty shell does not survive.
  if (!hard && before && listGroupLegs(before.groupId).length === 0) {
    softDeleteGroup(before.groupId);
  }
  // Below the cascade rather than above it, so the refetch this provokes
  // cannot read a group that is one statement away from being tombstoned.
  await handle.emitDeploymentsChanged();
  // Refresh engine groupCache + realtime sub state. Engine state must
  // be fresh after any leg removal — the cascade-fired path doubly so,
  // since a now-soft-deleted group must drop out of groupCache.
  await handle.syncIfRunning();
  return NextResponse.json({ ok: true, hard, destroying: false });
}
