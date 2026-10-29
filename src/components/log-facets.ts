/**
 * The Diagnostics lane's model — the facet inventory and the filter.
 *
 * It replaces the seven exclusive chips the operator called *"busy and not
 * great for filtering"*. Those chips were the legacy `level` enum, which is
 * severity and category conflated in one value; the envelope split them, so
 * the filter splits too: **severity × category × deployment**, multi-select,
 * counts shown.
 *
 * No React. The component renders these options and hands the state back.
 *
 * Owned by docs/modules/ui/design-language.md.
 */

import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import type { WireLogRecord } from "@/lib/logging/pipe";
import { presentSubject } from "./log-activity";

export type FacetDimension = "severity" | "category" | "deployment";

export interface FacetOption {
  value: string;
  /** What the button says. Uppercase is the component's job, not this. */
  label: string;
  /** `title=` — the uuid for a deployment, null where there is nothing more. */
  title: string | null;
  /** How many of the fetched records carry this value, **before** filtering
   *  — the same semantics the old chip counts had, so a facet that is off
   *  still tells you what you are not looking at. */
  count: number;
  enabled: boolean;
}

/**
 * What is switched **off**. Storing the negative is what makes a value that
 * appears on a later poll — a deployment that just took its first trade —
 * visible by default instead of silently filtered out.
 */
export interface FacetState {
  severity: ReadonlySet<string>;
  category: ReadonlySet<string>;
  deployment: ReadonlySet<string>;
}

/**
 * The defaults, and both of the non-empty ones are a decision.
 *
 * **INFO is on.** A whole wrong diagnosis was built on a `Pause complete`
 * line that was present and filtered — the viewer's filter state changed the
 * operator's beliefs — and that incident is the reason this default is
 * written down rather than inherited.
 *
 * **HEARTBEAT is off**, which is its old behaviour: it fires on a cadence,
 * it is the "is the engine alive" signal rather than an event, and on
 * anything but a short window it is most of the rows.
 *
 * **`debug` is off**, and the spec was silent on it. Gate decision 2 demoted
 * the raw broker frames to `debug` precisely because dozens of them per fill
 * were burying the four lines that carried the story; they exist below prod
 * so they are *available*, and defaulting them on would restore the burial
 * the demotion was for. The facet shows its count, so they are one click
 * away and visibly there.
 *
 * Neither default is persisted — see the lane note in `engine-logs.tsx`.
 */
export const DEFAULT_FACET_STATE: FacetState = {
  severity: new Set(["debug"]),
  category: new Set(["heartbeat"]),
  deployment: new Set(),
};

/** Loudest first: the order someone scanning for a problem reads in. */
const SEVERITY_ORDER: readonly Severity[] = ["error", "warn", "info", "debug"];

/** Subject-first, then the plumbing, then the cadence. */
const CATEGORY_ORDER: readonly LogCategory[] = [
  "trade",
  "order",
  "safety",
  "connection",
  "lifecycle",
  "broker",
  "system",
  "heartbeat",
];

function deploymentKeyOf(record: WireLogRecord): string {
  return record.deploymentId;
}

/**
 * The three dimensions, each as a rendered option list with counts.
 *
 * Severity and category enumerate their **whole** vocabulary rather than
 * only the values present, so a lane with no errors still shows an ERROR
 * facet reading 0 — an absent chip and a chip reading zero say different
 * things, and the one that matters here is "there are none", not "there is
 * no such thing".
 *
 * Deployment is the opposite: it enumerates what is present, because the set
 * is the operator's deployments and an empty one is not a fact about the
 * vocabulary.
 */
export function buildFacets(
  records: readonly WireLogRecord[],
  state: FacetState,
): Record<FacetDimension, FacetOption[]> {
  const severityCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const deploymentCounts = new Map<string, { count: number; label: string; title: string }>();

  for (const record of records) {
    severityCounts.set(record.severity, (severityCounts.get(record.severity) ?? 0) + 1);
    categoryCounts.set(record.category, (categoryCounts.get(record.category) ?? 0) + 1);
    const key = deploymentKeyOf(record);
    const existing = deploymentCounts.get(key);
    if (existing) {
      existing.count += 1;
      // A `display` arrives only on lines that carry a subject, so the first
      // line seen for a deployment may be a legacy row with none. Upgrade
      // the label the moment one does, rather than leaving the facet reading
      // as a uuid for the whole session.
      if (record.display != null && existing.label !== record.display) {
        existing.label = presentSubject(record).label;
      }
    } else {
      const subject = presentSubject(record);
      deploymentCounts.set(key, { count: 1, label: subject.label, title: subject.title });
    }
  }

  return {
    severity: SEVERITY_ORDER.map((value) => ({
      value,
      label: value,
      title: null,
      count: severityCounts.get(value) ?? 0,
      enabled: !state.severity.has(value),
    })),
    category: CATEGORY_ORDER.map((value) => ({
      value,
      label: value,
      title: null,
      count: categoryCounts.get(value) ?? 0,
      enabled: !state.category.has(value),
    })),
    deployment: [...deploymentCounts.entries()]
      .map(([value, meta]) => ({
        value,
        label: meta.label,
        title: meta.title,
        count: meta.count,
        enabled: !state.deployment.has(value),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

/**
 * A record survives when **every** dimension says yes, and the free-text
 * query matches its message, subject or event name.
 *
 * Switching a dimension entirely off shows nothing, which is the same
 * semantics the seven chips had and is legible in a way "empty means all"
 * is not — a reader who deselected everything can see that they did.
 */
export function applyFacets(
  records: readonly WireLogRecord[],
  state: FacetState,
  query = "",
): WireLogRecord[] {
  const q = query.trim().toLowerCase();
  return records.filter((record) => {
    if (state.severity.has(record.severity)) return false;
    if (state.category.has(record.category)) return false;
    if (state.deployment.has(deploymentKeyOf(record))) return false;
    if (q.length === 0) return true;
    const haystack = `${record.message} ${record.display ?? record.deploymentId} ${record.event ?? ""}`;
    return haystack.toLowerCase().includes(q);
  });
}

/** What `?deployment=` resolves to: the records and what to call them. */
export interface DeploymentScope {
  ids: readonly string[];
  /** The display name the lines carry, or the id where none does. */
  label: string;
  records: WireLogRecord[];
}

/**
 * `?deployment=<id>`, repeatable — the lines belonging to a named set of
 * deployments, keyed on the same field the `deployment` facet groups by, so
 * the URL names a value the operator can already see in the facet strip.
 *
 * **A scope rather than a facet preset, and that is the load-bearing part.**
 * The facet state is a store of what is switched *off*, which is what lets a
 * deployment appearing on a later poll be visible by default — a property
 * worth keeping, and the opposite of what a focused link wants. Worse, the
 * facets are the Diagnostics lane's control alone: the Activity lane renders
 * the whole stream and has no strip to say what it is hiding, so a preset
 * would hold on one lane and silently lapse on the other. A scope applies
 * before either lane sees the records, and its escape hatch is the URL.
 *
 * **Repeatable because a drill-in is one deployment across N legs and each
 * leg is what the engine stamps.** A link that only worked once the operator
 * had narrowed to a single account would be the wrong shape for the page it
 * comes from.
 *
 * An id with no lines in the window is not an error — it answers with an
 * empty list under its own id, and the viewer says so. An empty id list is
 * no scope at all, so the caller gets one branch rather than a scope that
 * matches everything.
 */
export function scopeToDeployments(
  records: readonly WireLogRecord[],
  deploymentIds: readonly string[],
): DeploymentScope | null {
  if (deploymentIds.length === 0) return null;
  const wanted = new Set(deploymentIds);
  // A `display` arrives only on lines carrying a subject, so the first line
  // seen for an id may be a legacy row with none — take each label off the
  // first line that has one rather than leaving the banner reading as a uuid.
  const labels = new Map<string, string>(deploymentIds.map((id) => [id, id]));
  const scoped: WireLogRecord[] = [];
  for (const record of records) {
    const key = deploymentKeyOf(record);
    if (!wanted.has(key)) continue;
    scoped.push(record);
    if (record.display != null && labels.get(key) === key) {
      labels.set(key, presentSubject(record).label);
    }
  }
  return {
    ids: deploymentIds,
    label: deploymentIds.map((id) => labels.get(id) ?? id).join(" · "),
    records: scoped,
  };
}

/** Toggle one value in one dimension, returning a fresh state. */
export function toggleFacet(
  state: FacetState,
  dimension: FacetDimension,
  value: string,
): FacetState {
  const next = new Set(state[dimension]);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return { ...state, [dimension]: next };
}

/** Every value in a dimension back on — the escape hatch from a filter that
 *  hid the line someone is looking for, which is this viewer's one recorded
 *  way of misleading its reader. */
export function clearFacetDimension(state: FacetState, dimension: FacetDimension): FacetState {
  return { ...state, [dimension]: new Set<string>() };
}
