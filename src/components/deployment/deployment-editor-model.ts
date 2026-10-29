import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";

/**
 * Every decision `/deployments/[id]/edit` could get wrong, as pure functions.
 *
 * Same split as `deployment-detail-model.ts` and `board-model.ts`, for the
 * same reason: each decision below is worth a test and none of them needs a
 * DOM. The component is composition and event wiring; nothing here imports
 * React.
 *
 * **The editor reads raw `DeploymentGroup` and `Deployment` rows, and that is
 * a deliberate exception to the board's adapter rule rather than a lapse.**
 * `design-language.md` forbids a component reaching past `board-model.ts` to
 * a raw row *to draw a field* — the drill-in obeys it and states its one
 * carve-out (the export, which serializes rather than renders). An editor is
 * not a board render: `BoardDeployment` deliberately carries no `paramValues`,
 * because the board has no business showing them, and the thing being edited
 * *is* the source of truth. Routing an edit through a read-model built for a
 * different question would mean widening that model with fields only one
 * screen wants. The boundary that matters is the other direction and it
 * holds: nothing here renders a board field, and the editor's own status and
 * money readings still come from the adapter.
 *
 * **The six decisions from the model section are enforced here, not just
 * honoured by the UI.** Ticker and strategy are pinned, params live on the
 * parent, per-leg override is size-only, and the final leg cannot be removed.
 * The server enforces the same four; these exist so the operator is told
 * *before* a round trip rather than by a 400.
 */

/** What the editor may change. Anything not here is pinned or lives on
 *  another surface — see {@link PINNED_FIELD_REASON}. */
export interface EditorDraft {
  /** Parent label. Empty string is normalised to null on the way out — the
   *  row's fallback is the strategy display name, and a whitespace name
   *  would render as a blank heading rather than fall back. */
  name: string;
  /** Parent params, including the session keys. Legs have none. */
  paramValues: ParamValues;
  /** The account set, checked-means-leg. The picker owns this.
   *
   *  It used to sit beside a `sizeOverrides` map keyed the same way. The
   *  risk sizer deleted it: how many contracts an account trades is that
   *  account's risk posture in Settings, not a per-leg number typed here. */
  accountIds: Set<number>;
}

/**
 * Why the ticker and strategy fields render disabled.
 *
 * One sentence, shown on both, because the operator's question on seeing a
 * greyed field is *why* and the answer is the same for each. It names the
 * operation that does work, since a refusal with no alternative reads as a
 * bug. Matches the server's own 400 text in `PATCH /api/groups/[id]` so the
 * two surfaces cannot drift into telling different stories.
 */
export const PINNED_FIELD_REASON =
  "Strategy and instrument are fixed when a deployment is created. Delete this deployment and create a new one.";

/**
 * Why the last leg's remove control is disabled.
 *
 * Deleting a whole deployment as a side effect of subtracting a row is a
 * surprise, and delete carries its own confirm, the open-position gate and
 * the `Destroying` path — none of which should be reachable by subtraction.
 */
export const LAST_LEG_REASON =
  "A deployment needs at least one account. Use Delete on the board to remove the whole deployment.";

/** Seed a draft from the rows. */
export function draftFrom(group: DeploymentGroup, legs: readonly Deployment[]): EditorDraft {
  const accountIds = new Set<number>();
  for (const leg of legs) accountIds.add(leg.accountId);
  return {
    name: group.name ?? "",
    paramValues: { ...group.paramValues } as ParamValues,
    accountIds,
  };
}

/** True when the last leg is the one being looked at, so its `−` is refused. */
export function isLastLeg(legs: readonly Deployment[]): boolean {
  return legs.length <= 1;
}

/**
 * The `PATCH /api/groups/[id]` body for the parent half of a save.
 *
 * `name` normalises `""` → `null` so the row falls back to the strategy
 * display name rather than rendering an empty heading. **Ticker and
 * strategyKey are never included**: the route rejects the whole request with
 * a 400 if either key is merely *present*, so a form that sent them
 * unchanged would fail every save.
 */
export function groupPatchFrom(draft: EditorDraft): { name: string | null; paramValues: ParamValues } {
  const trimmed = draft.name.trim();
  return {
    name: trimmed === "" ? null : trimmed,
    paramValues: draft.paramValues,
  };
}

/**
 * Everything one Save has to send, derived rather than decided while
 * awaiting.
 *
 * The component executes this in order; nothing about *what* to send is
 * worked out between requests, which is what makes the whole save testable
 * without a network. Empty arrays mean "no request of that kind" — a save
 * that only renames sends one PATCH and nothing else.
 */
export interface SavePlan {
  group: { name: string | null; paramValues: ParamValues };
  /** Accounts checked that are not legs yet. */
  addLegs: Array<{ accountId: number }>;
  /** Legs whose account was unchecked. Leg ids, because these rows exist. */
  removeLegIds: string[];
}

/**
 * Build the plan.
 *
 * **Compared against the rows, never against a snapshot of the draft.** A
 * refetch between load and save means the rows are the truth about what is
 * stored; diffing against a stale snapshot would re-send a value the
 * operator never touched and bump `updated_at` on a leg somebody else's tab
 * just changed.
 */
export function buildSavePlan(
  draft: EditorDraft,
  group: DeploymentGroup,
  legs: readonly Deployment[],
): SavePlan {
  const byAccount = new Map(legs.map((l) => [l.accountId, l]));
  const addLegs: SavePlan["addLegs"] = [];
  for (const accountId of draft.accountIds) {
    if (byAccount.has(accountId)) continue;
    addLegs.push({ accountId });
  }
  const removeLegIds: string[] = [];
  for (const leg of legs) {
    if (!draft.accountIds.has(leg.accountId)) removeLegIds.push(leg.id);
  }
  return { group: groupPatchFrom(draft), addLegs, removeLegIds };
}

/**
 * Nothing to save.
 *
 * Derived from the plan rather than computed alongside it, so the disabled
 * Save button and the requests a press would fire cannot disagree — the
 * failure being avoided is a Save that looks live and sends nothing, or one
 * that looks inert over a real edit.
 */
export function isDirty(draft: EditorDraft, group: DeploymentGroup, legs: readonly Deployment[]): boolean {
  const plan = buildSavePlan(draft, group, legs);
  if (plan.group.name !== group.name) return true;
  if (JSON.stringify(plan.group.paramValues) !== JSON.stringify(group.paramValues)) return true;
  return plan.addLegs.length > 0 || plan.removeLegIds.length > 0;
}

/** One account's conflict, as the 409 body reports it. */
export interface PerLegConflict {
  legId: string;
  accountId: number;
  conflict: { id: string; name: string | null; strategyKey: string } | null;
}

/** What the editor shows when the server refuses a session-window change. */
export interface ConflictReport {
  /** Only the legs that actually conflict — the response carries every leg. */
  blocked: PerLegConflict[];
  totalLegs: number;
}

/**
 * Read a 409 `partialConflict` body.
 *
 * **The server half has been built and unread since it was written**, so this
 * is the first consumer and the shape is taken from the route rather than
 * assumed: `{ partialConflict: true, error, perLeg }`, where `perLeg` carries
 * *every* leg and the conflicting ones are those with a non-null `conflict`.
 * Returns null for any other body so an ordinary 409 — or a shape change —
 * falls through to the generic error path instead of rendering an empty
 * conflict panel that claims nothing is wrong.
 */
export function readConflict(body: unknown): ConflictReport | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { partialConflict?: unknown; perLeg?: unknown };
  if (b.partialConflict !== true || !Array.isArray(b.perLeg)) return null;
  const perLeg = b.perLeg as PerLegConflict[];
  const blocked = perLeg.filter((r) => r != null && r.conflict != null);
  if (blocked.length === 0) return null;
  return { blocked, totalLegs: perLeg.length };
}

/**
 * The sentence above the conflict list.
 *
 * Says what was refused, on how many accounts, and what confirming will do —
 * the operator is about to run two deployments with overlapping windows on
 * one account, and "Apply anyway" with no consequence stated is a button that
 * hides its own effect.
 */
export function describeConflict(report: ConflictReport): string {
  const n = report.blocked.length;
  const accounts = n === 1 ? "account" : "accounts";
  return (
    `These session windows overlap an existing deployment on ${n} of ${report.totalLegs} ${accounts}. ` +
    `Applying anyway leaves both running on the same account at the same time.`
  );
}
