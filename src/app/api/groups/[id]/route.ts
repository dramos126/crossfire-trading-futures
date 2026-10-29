import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  beginGroupDestroy,
  disableGroupWithSnapshot,
  enableGroupAndRestore,
  getGroup,
  softDeleteGroup,
  syncLegsFromGroup,
  updateGroup,
  type GroupPatch,
} from "@/lib/db/deployment-groups";
import {
  filterMainSessionOverlaps,
  findConflictingDeployments,
  listGroupLegs,
  readPauseWindows,
  sessionForStrategyKey,
} from "@/lib/db/deployments";
import { listDerivedRows } from "@/lib/db/books";
import { crossTimeframeExitRefusalForStrategyKey, getStrategy } from "@/lib/trading/strategies";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { legHasOpenPositionWithFallback } from "@/lib/trading/orders/leg-position";
import { validatePauseWindows } from "@/lib/trading/session/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import {
  createOpenPositionLookup,
  hasOpenPositionOnBroker,
} from "@/lib/trading/broker-access/open-position-lookup";
import type { PauseWindow } from "@/lib/trading/strategy-types";
import { checkDeploymentSettings } from "@/lib/trading/deployment-settings";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  RESUME_WOULD_RETRACT_A_CLOSE,
  groupEnableWouldRetractClose,
  type Deployment,
} from "@/lib/trading/domain";

const handle = engineHandle();

interface RouteContext { params: Promise<{ id: string }> }

/**
 * Return, after telling the engine.
 *
 * The enable/disable cascade commits every leg ~150 lines before this
 * handler's closing `sync()`, and four gates between them return early. A
 * non-200 is still a mutated binding: the disable half self-heals because the
 * closing guard reads the DB, but the enable half does not — legs read
 * `Active`, sit outside `realtimeDeployments`, and nothing re-reads the
 * deployment set on a timer, which is the indefinite-no-entries failure the
 * closing `sync()` exists to close. **Every exit downstream of a mutation goes
 * through here, whatever status the caller sees.** The gates upstream of the
 * cascade deliberately do not — they have mutated nothing.
 */
async function respondSynced(body: unknown, init?: { status: number }): Promise<NextResponse> {
  await handle.emitDeploymentsChanged();
  await handle.syncIfRunning();
  return NextResponse.json(body, init);
}

/**
 * Find legs the open-position gate refuses, consulting the durable trade row
 * first, then engine state, then falling back to a per-account broker
 * `searchOpenPositions` query when the engine isn't ready (cold boot,
 * post-auth-failure stop). The lookup caches per accountId so a group with N
 * legs across K accounts costs at most K broker hits, not N.
 *
 * **The trade-row read is the first clause for the same reason it is in
 * `holdsPosition` on `PATCH /api/deployments/[id]`**, and the group cascade
 * went without it: `legHasOpenPositionWithFallback` short-circuits on
 * `if (state) return state.position != null`, and every managed leg has a state
 * entry while the engine runs, so the broker arm below never fires and the
 * mirror is the whole answer. `placeExitOrder`'s callers null that mirror at
 * *submission*, so through the submission-to-fill window the leg reads flat
 * while the row sits `pending_exit` — and `closingStatusForDisable` then writes
 * `Paused` over a live broker position. `Paused` is a claim the deployment is
 * flat: it is outside `listManagedDeployments()`, so the same request's
 * `sync()` deletes the leg's mirror and `activeTradeId`, and outside
 * `isLegInExitLoop` and the watchdog's candidates, so a rejected exit leaves an
 * open position with no engine actor at all.
 *
 * The three arms answer at different granularity, which the error copy
 * reflects: the trade row and engine state are the leg's own position, while
 * the broker arm asks whether the leg's *account* holds anything at all (see
 * `hasOpenPositionOnBroker` for why it is account-scoped). All are true
 * statements about the leg's account, so the message says that.
 *
 * Fail-closed on broker error: when the fallback throws — including when
 * the account's broker client is unavailable — the leg is reported as
 * in-position so the caller's destructive op is rejected rather than
 * silently allowed through.
 */
async function findInPositionLegs(legs: Deployment[]): Promise<Deployment[]> {
  const lookup = createOpenPositionLookup();
  const inPosition: Deployment[] = [];
  for (const leg of legs) {
    if (getOpenTradeForDeployment(leg.id) != null) {
      inPosition.push(leg);
      continue;
    }
    const state = (await handle.peekLegPosition(leg.id)) ?? undefined;
    const has = await legHasOpenPositionWithFallback(state, () =>
      hasOpenPositionOnBroker(lookup, leg),
    );
    if (has) inPosition.push(leg);
  }
  return inPosition;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const group = getGroup(id);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const legs = listGroupLegs(id);
  return NextResponse.json({ group, legs });
}

/**
 * PATCH /api/groups/[id] — edit shared config.
 *
 * Special behavior:
 *   - If the patch flips `enabled`, route through
 *     disableGroupWithSnapshot / enableGroupAndRestore so per-leg
 *     snapshots are preserved on disable and restored on enable. An enable
 *     while any leg is `Pausing`/`Destroying` is refused (409) before any
 *     write, since the restore would retract that close.
 *   - If the patch touches paramValues, run the conflict check per leg
 *     against the engine's current view and return per-leg breakdown
 *     so the UI can render the partial-conflict modal. The candidate
 *     window is the playbook's `config.session`; a patch cannot move it.
 *   - For pause-window changes, also block when ANY leg is in position
 *     (a pause carved under an open position moves the
 *     `time_window_close` the engine will fire on it — that's the broker
 *     contract).
 *   - Mid-position param-edit policy: edits to entry-side params apply
 *     to next entry only; existing positions retain paramSnapshot.
 *     Engine enforces this via paramSnapshot at entry; this route
 *     surfaces a `mode: "next-entry-only"` flag in the response so the
 *     UI can render the badge.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const patch = body as GroupPatch & { applyToOverrides?: boolean };
  // Pinned at creation. This route never accepted a ticker change; saying so
  // is what makes the leg route's matching refusal one rule rather than two
  // shapes with different answers. Upstream of the cascade, so a plain
  // `NextResponse` is correct — nothing has been mutated.
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

  const existing = getGroup(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Toggle path: snapshot/restore semantics.
  // Re-run the conflict check on enable (0→1) — a deployment paused for
  // any length of time may collide with something added during its
  // paused window. Disable transitions skip the check (always safe).
  const isEnableTransition =
    "enabled" in patch &&
    typeof patch.enabled === "boolean" &&
    patch.enabled !== existing.enabled;
  // The reconciler is the only writer of a derived row's state — a direct
  // `enabled` write here would make this group its own slot holder, and the
  // book grid's toggle could never resume it. Checked ahead of every screen
  // and cascade below, the same ordering the DELETE refusal uses.
  if (isEnableTransition && listDerivedRows().some((row) => row.groupId === id)) {
    return NextResponse.json({ error: BOOK_DERIVED_ROW_REFUSAL }, { status: 409 });
  }
  if (isEnableTransition && patch.enabled === true) {
    // Enabling a group cascades `enabled = 1` onto every leg, so this is a
    // "start trading here" action for each of their accounts. Screened
    // before the conflict pre-check — a live account is a refusal no
    // amount of session rearranging fixes.
    //
    // The zero-leg case is rejected here rather than left to the screen:
    // an empty account list screens as permitted, which is the right answer
    // for the routes that validate non-empty upstream and the wrong one for
    // a predicate whose whole contract is that absence of proof refuses.
    //
    // Repair first, then refuse. The state this branch catches is a
    // concurrent last-leg removal — exactly what the 0-leg invariant at
    // the bottom of this handler exists to clean up. Returning here skipped
    // that cleanup, so the operator was told to "add an account" to a shell
    // they cannot add to, on every retry, forever. Tombstone it, sync the
    // engine, and say the shell was cleared.
    const enableLegs = listGroupLegs(id);
    if (enableLegs.length === 0) {
      const tombstoned = existing.deletedAt == null ? softDeleteGroup(id) : existing;
      return respondSynced(
        {
          error:
            "This group has no accounts on it, so it was removed. Create a new group to start trading this strategy again.",
          group: tombstoned ?? existing,
          legs: [],
        },
        { status: 409 },
      );
    }
    const refusal = screenAccountsForAutoTrade(enableLegs.map((leg) => leg.accountId));
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, refusedAccounts: refusal.refused },
        { status: 403 },
      );
    }
    const candidateMain = sessionForStrategyKey(existing.strategyKey);
    if (!candidateMain) {
      return NextResponse.json(
        { error: `Strategy ${existing.strategyKey} is not registered, so it declares no session.` },
        { status: 400 },
      );
    }
    const legs = listGroupLegs(id);
    const perLeg: Array<{
      legId: string;
      accountId: number;
      conflict: { id: string; name: string | null; strategyKey: string } | null;
    }> = [];
    for (const leg of legs) {
      const sameTriple = findConflictingDeployments(
        leg.accountId,
        existing.ticker,
        existing.strategyKey,
        leg.id,
      );
      const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
      perLeg.push({
        legId: leg.id,
        accountId: leg.accountId,
        conflict: overlaps[0]
          ? {
              id: overlaps[0].id,
              name: overlaps[0].name,
              strategyKey: overlaps[0].strategyKey,
            }
          : null,
      });
    }
    const conflicting = perLeg.filter((r) => r.conflict != null);
    if (conflicting.length > 0) {
      return NextResponse.json(
        {
          partialConflict: true,
          error: `Cannot enable — conflict on ${conflicting.length} of ${perLeg.length} accounts.`,
          perLeg,
        },
        { status: 409 },
      );
    }
    // `enableGroupAndRestore` rewrites a `Pausing` leg from its snapshot and
    // drops its close, so the enable is refused whole while any leg is
    // `Pausing` — no partial resume. A `Destroying` leg it skips, so that one
    // does not hold its siblings back. Last of the refusals, before any write:
    // the 403, the 400 and the conflict never clear by waiting. Disable is
    // never refused.
    if (legs.some((leg) => groupEnableWouldRetractClose(leg.status))) {
      return NextResponse.json({ error: RESUME_WOULD_RETRACT_A_CLOSE }, { status: 409 });
    }
  }

  // Settings are refused before any write, so a body that also enables never
  // enables and then answers 400.
  if (patch.paramValues != null) {
    if (typeof patch.paramValues !== "object" || Array.isArray(patch.paramValues)) {
      return respondSynced({ error: "Settings must be an object" }, { status: 400 });
    }
    const settings = checkDeploymentSettings({
      strategyKey: existing.strategyKey,
      ticker: existing.ticker,
      module: getStrategy(existing.strategyKey),
      values: patch.paramValues,
      stored: existing.paramValues,
    });
    if (!settings.ok) return respondSynced({ error: settings.error }, { status: 400 });
    patch.paramValues = settings.values;
    // The only surface that can turn an exit filter onto a non-strategy
    // timeframe after creation — the leg PATCH refuses `paramValues` outright
    // — so without this the create routes' refusal is bypassed by creating on
    // "Same as strategy" and editing afterwards.
    const crossTimeframeError = crossTimeframeExitRefusalForStrategyKey(
      existing.strategyKey,
      patch.paramValues,
    );
    if (crossTimeframeError) {
      return respondSynced({ error: crossTimeframeError }, { status: 400 });
    }
  }

  if (isEnableTransition) {
    let result;
    if (patch.enabled) {
      result = enableGroupAndRestore(id);
    } else {
      // Disabling a group takes each leg out of `Active`, and D-4 says a
      // deployment that is not Active holds no position — so a leg holding
      // one goes to `Pausing` and the closing guard flattens it. Resolved
      // here rather than inside the cascade because this is where the
      // engine and the broker are reachable, and it is the same fail-closed
      // lookup the destructive-op gates use.
      const inPosition = new Set(
        (await findInPositionLegs(listGroupLegs(id))).map((leg) => leg.id),
      );
      result = disableGroupWithSnapshot(id, (leg) => inPosition.has(leg.id));
      // Only a leg that actually went to `Pausing` has anything to flatten,
      // and the cascade produces one exactly when this set is non-empty. Not
      // awaited: the group PATCH returns at the status write, never at flat.
      // Fired here rather than beside the sync at the end of the handler so a
      // later 409 — the session-window gate, say — cannot strand legs the
      // cascade has already committed to `Pausing`.
      if (inPosition.size > 0) await handle.nudgeClosingGuard();
    }
    if (!result) return respondSynced({ error: "Toggle failed" }, { status: 500 });
    // Strip the enabled key so we don't double-apply via updateGroup below.
    delete patch.enabled;
  }

  // Pause-window edit gate: block if ANY leg currently in position.
  //
  // **The window itself is no longer patchable** — it is the playbook's
  // `config.session` — so the only half of the active interval a save can move
  // is the pause list, and that is what this gate now compares. The reason is
  // unchanged and is the whole point of keeping it: carving a pause out from
  // under an open position moves the `time_window_close` the engine will fire
  // on it, which is the broker contract the operator is not allowed to edit
  // mid-trade. Pauses are validated against the playbook's window, not against
  // a window in the body.
  if (patch.paramValues != null) {
    const session = sessionForStrategyKey(existing.strategyKey);
    const rawPauses = (patch.paramValues as Record<string, unknown>).pauseWindows;
    if (session && rawPauses != null) {
      if (!Array.isArray(rawPauses)) {
        return respondSynced({ error: "pauseWindows must be an array" }, { status: 400 });
      }
      const pauseCheck = validatePauseWindows(session, rawPauses as PauseWindow[]);
      if (!pauseCheck.valid) {
        return respondSynced({ error: pauseCheck.error }, { status: 400 });
      }
    }
    const beforePauses = readPauseWindows(existing.paramValues as Record<string, unknown>);
    const afterPauses = readPauseWindows(patch.paramValues as Record<string, unknown>);
    const pausesChanged =
      JSON.stringify(beforePauses) !== JSON.stringify(afterPauses);

    if (pausesChanged) {
      const legs = listGroupLegs(id);
      const inPositionLegs = await findInPositionLegs(legs);
      if (inPositionLegs.length > 0) {
        return respondSynced(
          {
            error:
              `Cannot change pause windows — ${inPositionLegs.length} leg(s) are on an account ` +
              `holding an open position. Close those positions first or revert the pause change.`,
            inPositionLegs: inPositionLegs.map((l) => ({
              id: l.id,
              accountId: l.accountId,
            })),
          },
          { status: 409 },
        );
      }
    }
  }

  // Conflict check fan-out for partial-conflict modal. Run when the
  // payload hints at a session-window change OR when the caller has
  // explicitly requested a re-check; report per-leg even when nothing
  // conflicts so the UI can render checkmarks consistently.
  if (patch.paramValues != null) {
    const candidateMain = sessionForStrategyKey(existing.strategyKey);
    if (candidateMain) {
      const legs = listGroupLegs(id);
      const perLeg: Array<{
        legId: string;
        accountId: number;
        conflict: { id: string; name: string | null; strategyKey: string } | null;
      }> = [];
      for (const leg of legs) {
        const sameTriple = findConflictingDeployments(
          leg.accountId,
          existing.ticker,
          existing.strategyKey,
          leg.id,
        );
        const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
        perLeg.push({
          legId: leg.id,
          accountId: leg.accountId,
          conflict: overlaps[0]
            ? {
                id: overlaps[0].id,
                name: overlaps[0].name,
                strategyKey: overlaps[0].strategyKey,
              }
            : null,
        });
      }
      const conflicting = perLeg.filter((r) => r.conflict != null);
      if (conflicting.length > 0 && !patch.applyToOverrides) {
        // The group row is not committed — but a toggle in the same body
        // already cascaded every leg, which is why this returns through the
        // sync helper rather than directly.
        return respondSynced(
          {
            partialConflict: true,
            error: `Conflict on ${conflicting.length} of ${perLeg.length} accounts.`,
            perLeg,
          },
          { status: 409 },
        );
      }
    }
  }

  // Apply the group-row update.
  let updated = updateGroup(id, patch);
  if (!updated) return respondSynced({ error: "Update failed" }, { status: 500 });
  // Bump each leg's version so a trade taken after this edit is flagged
  // against the config it was actually fired with. Nothing is copied — a
  // leg reads the parent's params at query time.
  syncLegsFromGroup(updated);

  // If we re-fetched after the toggle path above, prefer the live row.
  updated = getGroup(id) ?? updated;
  const legs = listGroupLegs(id);
  // 0-leg invariant: a group should never persist enabled with zero legs.
  // Concurrent flows (e.g. last-leg "−" remove + this PATCH) can land
  // here after the leg has been removed elsewhere. Cascade soft-delete
  // so the orphaned shell doesn't keep rendering as an empty section.
  if (legs.length === 0 && updated.deletedAt == null) {
    const tombstoned = softDeleteGroup(id);
    return respondSynced({ group: tombstoned ?? updated, legs });
  }

  // Every mutating deployment/group route syncs; this one only did so inside
  // the two tombstone branches above, so the *normal* path — pause and
  // unpause — never reached the engine.
  //
  // Pause hid it. The closing guard reads `listClosing()` straight from the
  // DB every tick and never consults `realtimeDeployments`, so pausing a
  // group worked and looked like proof the route was fine. Unpause has no
  // such path: a leg only trades once `sync()` puts it back in
  // `realtimeDeployments`, and nothing re-reads that on a timer. So an
  // unpaused group rendered `Active` and never took another entry —
  // indefinitely, not for one tick.
  return respondSynced({ group: updated, legs });
}

/**
 * DELETE /api/groups/[id] — remove the group, with one of two outcomes.
 *
 * - **Every leg flat** (`findInPositionLegs` empty and no open trade row):
 *   `softDeleteGroup` deletes the parent and every leg now, `Paused`.
 * - **Any leg in position, or unknown** (the broker arm fails closed): never
 *   a 409. `beginGroupDestroy` writes `Destroying` on those legs, deletes the
 *   flat ones now and switches the parent off; the closing guard closes and
 *   reaps each `Destroying` leg, and the engine's last-leg cascade deletes
 *   the parent after the final one. The answer carries `destroying: true`.
 *

 * **A row a book materialised is refused outright**, ahead of the position
 * read and any broker round trip, for the reason `remove-leg` checks
 * `LAST_LEG_REFUSAL` first: the answer does not depend on the broker, and a
 * refusal that arrives after a network wait reads as a failure. The reconciler
 * has no delete arm and a tombstoned derived row is not a slot it leaves alone,
 * so a delete here is a control that looks like it worked and is undone at the
 * next boot. **The board renders that row's `✕` disabled with this sentence in
 * its `title`, off `BoardDeployment.bookId`** — as it does the card's `⏸`, for
 * the `PATCH` arm above — so the refusal is one the operator meets before
 * pressing rather than after. The leg row's own `⏸` carries it too, for
 * `PATCH /api/deployments/[id]`'s refusal; the `✎` stays live, because a
 * derived row's configuration is still the operator's to edit.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  if (listDerivedRows().some((row) => row.groupId === id)) {
    return NextResponse.json({ error: BOOK_DERIVED_ROW_REFUSAL }, { status: 409 });
  }

  const legs = listGroupLegs(id);
  const inPosition = new Set((await findInPositionLegs(legs)).map((leg) => leg.id));
  // The broker arm above awaits with the parent still enabled, so the engine
  // can open an entry on a leg it already judged flat. The trade row is read
  // again with no await before any write — and inside `beginGroupDestroy`'s
  // transaction — so such a leg goes `Destroying`, never `Paused` over a
  // live entry.
  const holdsTradeRow = (leg: Deployment) => getOpenTradeForDeployment(leg.id) != null;
  if (inPosition.size > 0 || listGroupLegs(id).some(holdsTradeRow)) {
    // Per-leg destroy's path for every leg: `Destroying` where a position is
    // open (or unknown — the lookup fails closed), deleted now where flat.
    // The engine's last-leg cascade removes the parent once the final
    // `Destroying` leg is reaped. A request never waits for flat.
    const destroying = beginGroupDestroy(id, (leg) => inPosition.has(leg.id) || holdsTradeRow(leg));
    if (!destroying) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await handle.emitDeploymentsChanged();
    await handle.syncIfRunning();
    await handle.nudgeClosingGuard();
    return NextResponse.json({ ok: true, group: destroying, destroying: true });
  }

  const result = softDeleteGroup(id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await handle.emitDeploymentsChanged();
  // Keep engine state coherent with the just-removed legs — without
  // sync(), `realtimeDeployments` still references them and their `state`
  // entries hang around until the next external sync.
  await handle.syncIfRunning();
  return NextResponse.json({ ok: true, group: result });
}
