"use client";

import { FieldBadge } from "@/components/field-badge";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import {
  buildDeployAccountRows,
  NO_AUTO_TRADE_STAMP,
} from "@/components/playbook/playbook-deploy-model";
import { LAST_LEG_REFUSAL } from "@/lib/trading/domain";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import type { AccountRow } from "@/lib/hooks/use-trading/account-row";

/**
 * The account set for a deployment, as a checkbox list — checked means
 * *this account is a leg*.
 *
 * **It is the single source of truth for the account set**, and that is a
 * rule in [design-language.md](../../docs/modules/ui/design-language.md)
 * rather than a description of where the code happens to live. It was inside
 * `DeployConfirmModal` while the modal was the only surface that edited a
 * deployment; the editor now has its own route, and a second copy of the
 * safety predicates below is exactly the duplication that leaves one arm
 * behind when the other is fixed. Moved here unchanged so both call it.
 *
 * **Two independent grounds disable a row, and they are not interchangeable.**
 * The deploy refusal and the last-remaining-leg pin. A row can be refused by
 * either, and the tooltip says which. The deploy refusal is the Playbook Deploy
 * picker's row (`buildDeployAccountRows`): the live-account block (the
 * server's verdict on the row, `autoTrade`, computed by the one predicate the
 * engine uses — A38), then the
 * account-state gate read off the server's `gates` — dead, locked, OCO off or
 * unknown — never derived here.
 *
 * **The refusal carries `&& !checked`, and that carve-out is load-bearing.**
 * Unchecking a checked row *is* the remove-leg action, so a block that also
 * disabled an already-checked row would make a leg on a refused account
 * impossible to unwind through the UI — the refusal becoming the hazard, on
 * exactly the wind-down path the operator needs most. The stamp still renders
 * on such a row, so it says why it is off-limits without trapping it.
 *
 * **A row disable is a rendering decision, so `toggleAccount` repeats it.**
 * `disabled` on an `<input>` is one devtools keystroke from gone, and a stale
 * render can hand a click to a row the current props would block. Both
 * grounds are re-checked in the handler with the same operands.
 *
 * There is no mixed-broker ground. That gate was commented out in three
 * places and never restored; it is deleted rather than reinstated, which
 * settles it in the direction the code has behaved for months. The seam it
 * moves the risk onto is the market sub — see architecture.md.
 */
export interface AccountLegPickerProps {
  accounts: AccountRow[];
  /** Checked accounts. In edit mode this is the leg set. */
  accountIds: Set<number>;
  onAccountIdsChange: (next: Set<number>) => void;
  /** Single-account mirror the create flow still reads. Called with the lone
   *  id when exactly one row is checked, and `""` otherwise. */
  onAccountChange: (id: number | "") => void;
  /** Editing an existing deployment: rows gain add/remove stamps and the
   *  last checked row is pinned. */
  isEditMode: boolean;
  /** Accounts that are already legs. Drives the add/remove stamps; absent in
   *  create mode, where nothing is "already" anything. */
  existingLegAccountIds?: Set<number>;
  /** `GET /api/books`' account-state gates. Null or absent — not read yet, or
   *  the read failed — refuses nothing on that ground; `add-legs` screens
   *  again regardless. */
  gates?: readonly AccountGateWire[] | null;
}

export function AccountLegPicker({
  accounts,
  accountIds,
  onAccountIdsChange,
  onAccountChange,
  isEditMode,
  existingLegAccountIds,
  gates = null,
}: AccountLegPickerProps) {
  const { accountLabel } = useDisplayPrivacy();
  const isMulti = accountIds.size > 1;
  const isLastLeg = isEditMode && accountIds.size === 1;
  const refusalOf = new Map(buildDeployAccountRows(accounts, gates).map((r) => [r.id, r]));

  function toggleAccount(id: number) {
    const target = refusalOf.get(id);
    if (!target) return;
    const checked = accountIds.has(id);
    if (isLastLeg && checked) return;
    if (target.refusal != null && !checked) return;
    const next = new Set(accountIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onAccountIdsChange(next);
    if (next.size === 1) {
      const [only] = next;
      onAccountChange(only);
    } else {
      onAccountChange("");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs text-[var(--muted)]">
          Accounts{" "}
          {isEditMode
            ? `(${accountIds.size} legs)`
            : isMulti
            ? `(${accountIds.size} selected)`
            : ""}
        </label>
      </div>
      <div className="max-h-56 overflow-auto rounded-md border border-[var(--card-border)] divide-y divide-[var(--card-border)]">
        {accounts.map((a, idx) => {
          const checked = accountIds.has(a.id);
          const zebraClass = idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";
          // The server refuses this account too, so a checkbox that let the
          // operator select it would only produce a 403 at Save.
          const refusal = refusalOf.get(a.id)?.refusal ?? null;
          const stamp = refusalOf.get(a.id)?.stamp ?? NO_AUTO_TRADE_STAMP;
          // The state gate's stamps carry their own casing; `no auto-trade` is upper-cased.
          const stampCase = refusalOf.get(a.id)?.stampFromStateGate ? "" : "uppercase ";
          // `&& !checked`: unchecking a checked row *is* remove-leg. A
          // pre-block leg sitting on a refused account must stay removable — an
          // operator has to be able to unwind one. The stamp below renders
          // regardless, so the row still says why it is off-limits.
          const pinnedLastLeg = isLastLeg && checked;
          const blocked = (refusal != null && !checked) || pinnedLastLeg;
          const tooltip = pinnedLastLeg ? LAST_LEG_REFUSAL : refusal ?? undefined;
          const isExistingLeg = isEditMode && existingLegAccountIds?.has(a.id) === true;
          const isPendingAdd = isEditMode && checked && !isExistingLeg;
          const isPendingRemove = isEditMode && existingLegAccountIds?.has(a.id) && !checked;
          return (
            <label
              key={a.id}
              title={tooltip}
              aria-disabled={blocked || undefined}
              className={`flex items-center gap-3 px-3 py-2 text-sm ${zebraClass} ${
                blocked
                  ? "opacity-50 cursor-not-allowed"
                  : "cursor-pointer hover:bg-[var(--hover)]"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={blocked}
                onChange={() => toggleAccount(a.id)}
              />
              <span className="flex-1 font-mono text-xs truncate">{accountLabel(a.name)}</span>
              {isPendingAdd && (
                <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-sm border bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/30 shrink-0">
                  add
                </span>
              )}
              {isPendingRemove && (
                <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-sm border bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30 shrink-0">
                  remove
                </span>
              )}
              {/* A greyed row on its own reads as a bug. The stamp says the
                  account is off-limits; the row tooltip says why. */}
              {refusal != null && (
                <span className={`text-[10px] ${stampCase}tracking-wide px-1 py-0.5 rounded-full border bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30 shrink-0`}>
                  {stamp}
                </span>
              )}
              <FieldBadge label={a.broker === "tradovate" ? "TRADOVATE" : "TOPSTEP"} />
            </label>
          );
        })}
      </div>
      <p className="text-[10px] text-[var(--muted)] mt-1">
        Each account runs as its own leg, sized from that account&rsquo;s risk settings.
      </p>
    </div>
  );
}
