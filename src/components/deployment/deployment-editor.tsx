"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AccountLegPicker } from "@/components/account/account-leg-picker";
import { useBooks, useStatusCheckOnOpen } from "@/components/playbook/playbook-account-gates";
import { IntentBadges } from "@/components/intent-badges";
import { ParamForm } from "@/components/param-form";
import { useBoardModel } from "@/components/board/use-board";
import { useDeployments } from "@/lib/hooks/use-strategies";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import { getStrategy } from "@/lib/trading/strategies";
import { PLAYBOOK_NOT_IN_BUILD } from "@/lib/trading/strategies/prod-playbooks";
import {
  buildSavePlan,
  describeConflict,
  draftFrom,
  isDirty,
  PINNED_FIELD_REASON,
  readConflict,
  type ConflictReport,
  type EditorDraft,
  type SavePlan,
} from "@/components/deployment/deployment-editor-model";
import type { ParamValues } from "@/lib/trading/strategy-types";

/**
 * `/deployments/[id]/edit` — the deployment editor.
 *
 * **A sibling route, not a mode on the stats page.** Both of the operator's
 * editing flows land in one hop: the board's ✎ and the drill-in's Edit come
 * straight here. The URL then says which one you are in, which is the whole
 * reason to split — configuring a hypothetical deployment and editing a live
 * one holding a position used to differ by a banner, a greyed ticker and a
 * button label, on the same page.
 *
 * **There is no confirm modal, and that is a decision rather than an
 * omission.** `DeployConfirmModal` served create *and* edit; a confirm step
 * in the middle of a page whose purpose was to stop editing being a mode is
 * the thing this route exists to remove, and design-language.md reserves
 * blocking dialogs for irreversible destructive operations. The modal keeps
 * its create mode. What it does not keep is the account picker, which moved
 * to `AccountLegPicker` so one copy of the live-account block and the
 * last-leg pin serves both surfaces.
 *
 * **It reads raw group and leg rows.** Declared exception to the board's
 * adapter rule, argued in
 * [deployment-editor-model.ts](./deployment-editor-model.ts): the rule
 * forbids reaching past `board-model.ts` *to draw a field*, and an editor is
 * not a board render. The rows arrive through `useBoardModel`, which is
 * already the one file carved out to hold `GET /api/groups`.
 *
 * Every decision lives in the model beside it. This file is composition,
 * request orchestration and the two states a save can land in.
 */

const FIELD_LABEL = "text-[10px] uppercase tracking-wider text-[var(--muted)]";
const PANEL = "border border-[var(--card-border)] bg-[var(--card)] p-4";

export function DeploymentEditor({ id }: { id: string }) {
  const router = useRouter();
  const trading = useTrading();
  const { hideAccountIds, accountLabel, text } = useDisplayPrivacy();
  const { board, groups, refreshGroups } = useBoardModel();
  const { deployments } = useDeployments();

  // The Playbook Deploy picker's account check: one status check per open,
  // then the accounts and the books (which carry each account's gate) again.
  const [gateRound, setGateRound] = useState(0);
  useStatusCheckOnOpen(trading.token, () => {
    void trading.reloadAccounts();
    setGateRound((n) => n + 1);
  });
  const { gates } = useBooks(trading.token, gateRound);

  const group = useMemo(() => groups.find((g) => g.id === id) ?? null, [groups, id]);
  const legs = useMemo(
    () => deployments.filter((d) => d.groupId === id && d.deletedAt == null).sort((a, b) => a.accountId - b.accountId),
    [deployments, id],
  );
  const card = useMemo(() => board.find((c) => c.id === id) ?? null, [board, id]);

  // Seeded once per loaded group. A refetch mid-edit must not overwrite what
  // the operator is typing — the plan is diffed against the rows at save
  // time, which is what makes a stale draft safe rather than a reason to
  // re-seed. `seededFor` is the id the draft was built from, so navigating
  // between two editors does re-seed.
  //
  // **`legs.length > 0` is a load gate, not a defensive check.** The group
  // row and the deployment store hydrate independently, so the group can
  // arrive a tick before its legs. Seeding then would build a draft with an
  // empty account set — which is not "no legs selected", it is every leg
  // marked for removal, and the first render would offer a Save that
  // deletes the deployment down to nothing. A group always has at least one
  // leg (the server cascades a soft-delete rather than persisting a 0-leg
  // parent), so an empty list here can only mean not-yet-loaded.
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (group != null && legs.length > 0 && seededFor !== group.id) {
    setSeededFor(group.id);
    setDraft(draftFrom(group, legs));
  }

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictReport | null>(null);

  const strategy = group ? getStrategy(group.strategyKey) : null;

  // `…` while a read is still out, never "not found" — the board's rule, and
  // the same lie it exists to prevent: telling the operator their deployment
  // is gone when the read simply has not landed. Two reads feed this page and
  // either can be the one outstanding, so both are checked: an empty group
  // list is the group read, and a group with no draft is the leg read.
  if (group == null || draft == null) {
    const stillLoading = groups.length === 0 || group != null;
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <BackLink id={id} />
        <p className="mt-6 text-sm text-[var(--muted)]">
          {stillLoading ? "…" : "No deployment with this id. It may have been deleted."}
        </p>
      </div>
    );
  }

  const dirty = isDirty(draft, group, legs);
  const displayName = card?.name ?? group.name ?? group.strategyKey;

  /**
   * Run a plan.
   *
   * Parent first, then structure. A 409 on the parent leaves the legs
   * untouched, so the operator confirms once and the second attempt is the
   * same plan rather than a half-applied one — the alternative is adding a
   * leg and then failing the params it was added for.
   */
  async function runPlan(plan: SavePlan, applyToOverrides: boolean): Promise<void> {
    const headers = { "Content-Type": "application/json" };

    const groupRes = await fetch(`/api/groups/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(applyToOverrides ? { ...plan.group, applyToOverrides: true } : plan.group),
    });
    if (!groupRes.ok) {
      const body: unknown = await groupRes.json().catch(() => null);
      const report = groupRes.status === 409 ? readConflict(body) : null;
      if (report) {
        setConflict(report);
        return;
      }
      const message =
        typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Save failed (${groupRes.status}).`;
      throw new Error(message);
    }
    setConflict(null);

    if (plan.addLegs.length > 0) {
      const res = await fetch(`/api/groups/${id}/add-legs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountIds: plan.addLegs.map((a) => a.accountId) }),
      });
      if (!res.ok) throw new Error(await errorText(res, "Could not add an account."));
    }

    for (const legId of plan.removeLegIds) {
      const res = await fetch(`/api/groups/${id}/remove-leg/${legId}`, { method: "POST", headers });
      // A leg holding an open position is refused by the server, and that
      // refusal is the point rather than an error to retry past — surface it
      // verbatim, because it names the position.
      if (!res.ok) throw new Error(await errorText(res, "Could not remove an account."));
    }

    await refreshGroups();
    router.push(`/deployments/${id}`);
  }

  async function save(applyToOverrides: boolean) {
    if (draft == null || group == null) return;
    setSaving(true);
    setError(null);
    try {
      await runPlan(buildSavePlan(draft, group, legs), applyToOverrides);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-4">
      <BackLink id={id} />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-[var(--foreground)] truncate">{text(displayName)}</h1>
            <IntentBadges intent={strategy?.config.intent} />
          </div>
          {/* Pinned at creation. Stated on the line rather than as a disabled
              input, because there is no field here to disable — the operator
              is not editing these, and a greyed control invites a click that
              can never work. */}
          <p className="mt-1 font-mono text-[11px] text-[var(--muted)]" title={PINNED_FIELD_REASON}>
            {group.strategyKey} · {group.ticker}
            <span className="ml-2 not-italic text-[var(--muted-secondary)]">fixed at creation</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Primary execution action, anchored far right. */}
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save(false)}
            className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <section className={PANEL}>
        <label className={FIELD_LABEL} htmlFor="deployment-name">
          Name
        </label>
        <input
          id="deployment-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={strategy?.config.name ?? group.strategyKey}
          className="mt-1 w-full rounded-md border border-[var(--card-border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)]"
        />
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          Shared across all legs. Leave blank to use the strategy name.
        </p>
      </section>

      <section className={PANEL}>
        <h2 className={`${FIELD_LABEL} mb-3`}>Parameters</h2>
        {/* The second call site the split buys — one component, two pages, so
            a change to the form is inherited by both by construction.
            `hiddenKeys` takes the same cast the strategy page makes:
            `keyof CommonParams` widens to `string | number`. */}
        {strategy ? (
          <ParamForm
            schema={strategy.params}
            values={draft.paramValues}
            onChange={(values: ParamValues) => setDraft({ ...draft, paramValues: values })}
            hiddenKeys={strategy.config.hiddenCommonParams as string[] | undefined}
          />
        ) : (
          <p className="text-xs text-[var(--muted)]">
            <span className="font-mono">{group.strategyKey}</span>: {PLAYBOOK_NOT_IN_BUILD}
          </p>
        )}
      </section>

      <section className={PANEL}>
        <AccountLegPicker
          accounts={trading.accounts}
          accountIds={draft.accountIds}
          onAccountIdsChange={(next) => setDraft({ ...draft, accountIds: next })}
          onAccountChange={() => {}}
          isEditMode
          existingLegAccountIds={new Set(legs.map((l) => l.accountId))}
          gates={gates}
        />
      </section>

      {conflict && (
        <section className="border-l-[3px] border-[var(--danger)] bg-[var(--bg-row)] px-4 py-3 space-y-2">
          <p className="text-xs font-semibold text-[var(--foreground)]">{describeConflict(conflict)}</p>
          <ul className="space-y-1">
            {conflict.blocked.map((row) => (
              <li key={row.legId} className="flex justify-between gap-3 text-xs">
                <span className="font-mono text-[var(--muted)]">
                  {hideAccountIds
                    ? accountLabel(row.accountId)
                    : trading.accounts.find((a) => a.id === row.accountId)?.name ?? `Account ${row.accountId}`}
                </span>
                <span className="font-mono">{row.conflict?.name ?? row.conflict?.strategyKey}</span>
              </li>
            ))}
          </ul>
          {/* Inline confirm rather than a dialog — the page is already the
              confirmation surface, and the sentence above says what applying
              does rather than leaving the button to imply it. */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConflict(null)}
              className="rounded-md border border-[var(--card-border)] px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(true)}
              className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--danger)] disabled:opacity-40"
            >
              Apply anyway
            </button>
          </div>
        </section>
      )}

      {error && (
        <p className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** Its own back affordance, the pattern the drill-in and Strategy Detail set
 *  — nav-only back loses browser-back semantics and forgets where the
 *  operator came from. It points at the drill-in rather than the board,
 *  because that is this route's sibling and the likelier origin. */
function BackLink({ id }: { id: string }) {
  return (
    <Link
      href={`/deployments/${id}`}
      className="text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
    >
      ← Deployment
    </Link>
  );
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `${fallback} (${res.status})`;
}
