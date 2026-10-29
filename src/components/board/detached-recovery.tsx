"use client";

import { useState } from "react";
import {
  describeOrphanReason,
  detachedRestoreRefusal,
  DETACHED_RECOVER_LABEL,
  DETACHED_RECOVER_NOTE,
  engineSyncIntent,
} from "@/components/board/board-view";
import type { BoardLeg } from "@/components/board/board-model";
import { confirmActivationUnderD2 } from "@/lib/trading/activation-prompts";
import { loadDeployments, refreshDeployments, syncEngine } from "@/lib/hooks/use-strategies";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import type { Deployment } from "@/lib/trading/domain";

/**
 * The recovery surface on a detached leg, and the only caller anywhere of
 * `POST /api/deployments/[id]/clear-orphan`. The board's leg row and the
 * drill-in both render this one component, so the press, its prompts and its
 * refusals cannot differ between the two.
 *
 * **A labelled control in its own band, not a fifth glyph in the cluster.**
 * The row's `☰ ⏸ ▼` are three 28px glyphs an operator presses by shape; a
 * fourth beside them for an action that *re-arms a deployment for live
 * trading* is the one control on the row that must not be pressed by muscle
 * memory. It sits where the flatten's outcome and the row's errors already
 * sit — under the row, full width — which is also the only slot with room for
 * the reason. The button anchors far right of that band, per the
 * primary-action rule, and takes `btn-emerald` because arming is a primary
 * execution action rather than a glyph's worth of housekeeping.
 *
 * **The reason renders in words.** `orphanReason` was a `title` tooltip
 * carrying a raw `account_unavailable_at_boot`, which is a variable name in a
 * sentence slot; `describeOrphanReason` says what was observed and
 * `DETACHED_RECOVER_NOTE` says what it does not mean. Neither claims the
 * account is gone — that claim is what cost two trading days
 * ([bugs.md](../../docs/bugs.md) A74).
 *
 * **Muted rather than `--danger`.** The row's chip already states the failure
 * in the danger tone, and a red band under a red chip is the same claim twice;
 * this band is the explanation and the way out of it. A refusal that comes
 * *back* from the route does render in `--danger`, because that one is new
 * information.
 *
 * **A row the route would refuse keeps the band and loses the press** — one
 * still owing a close, or a book's row whose playbook is switched off.
 * `detachedRestoreRefusal` gives the same sentence the route 409s with; it
 * replaces the note as well as disabling the button, because
 * `DETACHED_RECOVER_NOTE` describes a press that would be refused.
 *
 * **It owes the activation prompts, because it is an activation.**
 * `clearOrphanedAndReEnable` writes `status = 'Active', enabled = 1`, the same
 * fact a ▶ writes and the same weight as a deploy. It deliberately does not
 * also take the two-step arm the ✕ and ▼ use: those have no prompt behind
 * them, and stacking a morph onto a blocking confirm would be a fourth
 * confirmation idiom on one row.
 *
 * **A refused clear leaves the row exactly as it was.** No optimistic write,
 * no refetch on any failing arm — the 403 (the live-account block, rendered
 * verbatim), the 409s and a request that never landed all end with the band
 * still on screen carrying what the server said. Only success refreshes.
 */
export function DetachedRecovery({
  leg,
  bookId,
  onPress,
  onRestored,
}: {
  leg: BoardLeg;
  /** The card's `bookId` — a book's row under a switched-off playbook is refused. */
  bookId: string | null;
  /** Called when a press starts, so the host can clear what the row said before. */
  onPress?: () => void;
  onRestored: () => void;
}) {
  const { token, practiceOnly } = useTrading();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refusal = detachedRestoreRefusal(leg, bookId);

  async function handlePress() {
    if (busy) return;
    setError(null);
    onPress?.();
    const ok = await confirmActivationUnderD2(leg.claim);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(leg.id)}/clear-orphan`, {
        method: "POST",
      });
      if (!res.ok) {
        // Verbatim: the 403's body is the live-account refusal, the same
        // sentence the API, the engine log and the held-back notice carry.
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Could not restore this deployment (${res.status}).`);
        return;
      }
    } catch {
      setError("The restore request never reached the server. This deployment is unchanged.");
      return;
    } finally {
      setBusy(false);
    }
    // A raw `fetch` writes nothing into the deployment cache, so the refresh
    // comes first. The route syncs the engine itself; this resync carries the
    // one thing it cannot see, `practiceOnly`.
    if (token) await refreshDeployments(token);
    await resyncEngine(token, practiceOnly, loadDeployments());
    onRestored();
  }

  return (
    <div
      className="px-4 py-2 border-t border-[var(--card-border)] bg-[var(--bg)]"
      role="group"
      aria-label="Detached row recovery"
    >
      <div className="flex items-start gap-3">
        <p className="text-[11px] leading-snug text-[var(--muted)]">
          {describeOrphanReason(leg.orphanReason)} {refusal ?? DETACHED_RECOVER_NOTE}
        </p>
        {/* No `aria-label`: the label changes while the press is out, and a
            static one to make the button findable would replace the accessible
            name with a stale one. The text is the name. */}
        <button
          type="button"
          onClick={handlePress}
          disabled={busy || refusal != null}
          title={refusal ?? undefined}
          className="btn-emerald ml-auto shrink-0 rounded-md px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Restoring…" : DETACHED_RECOVER_LABEL}
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11px] leading-snug text-[var(--danger)]">{error}</p>}
    </div>
  );
}

/**
 * Push a list to the engine after a deployment-level write.
 *
 * The routes call `engine.sync()` themselves; this carries the one thing they
 * cannot — `practiceOnly`, which is browser state and decides which rows the
 * engine is allowed to run. Group writes deliberately skip it:
 * `/api/groups/[id]` owns its own cascade and sync.
 *
 * **The list is a parameter, and that is the point.** It used to read
 * `loadDeployments()` itself, which made every caller depend on an unstated
 * ordering: the mutation helpers write the module snapshot *before* they
 * resolve, so a read here happened to be current — and a helper that ever
 * resolved first would have folded a list one write stale, with `"stop"` on
 * the far side of an empty fold. Passing it in puts the freshness question at
 * the call site, where the caller knows which write it just made.
 */
export async function resyncEngine(
  token: string | null,
  practiceOnly: boolean,
  deployments: Deployment[],
): Promise<void> {
  await syncEngine(engineSyncIntent(deployments), { token, practiceOnly, deployments });
}
