"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type {
  MainSession,
  ParamSchema,
  ParamValues,
  ParamValue,
  PauseWindow,
  SessionWindow,
} from "@/lib/trading/strategy-types";
import { mainSessionsOverlap, pauseStrictlyInsideMain, pausesOverlap } from "@/lib/trading/session/session";
import { FilterSelector } from "@/components/filter-selector";
import { FixedChoiceValue, isFixedChoice } from "@/components/fixed-choice-field";
import {
  CalibrationNote,
  describeCalibratedBand,
  ExploreParamField,
} from "@/components/explore-param-field";
import { isOffCalibration } from "@/lib/trading/param-explore";
import { CollapsibleSection } from "@/components/collapsible-section";
import { TimeStepInput } from "@/components/time-step-input";
import { InfoIcon } from "@/components/info-icon";
import { SessionTimeline } from "@/components/session-timeline";
import { ENTRY_FILTER_REGISTRY, EXIT_FILTER_REGISTRY } from "@/lib/trading/filters";

/** Subset of `ParamValue` ParamField may receive. Session-shape values
 *  (`MainSession`, `PauseWindow[]`, `SessionWindow[]`) flow through
 *  because the same prop type is shared with parent rows; ParamField
 *  early-returns null for those `param.type` values, so the cast is
 *  safe at runtime. */
type ParamFieldValue = ParamValue;

/** Whether this form is a research form (`ParamForm`'s `explore`). A context
 *  rather than a prop because `ParamField` is reached from five layouts. */
const ExploreModeContext = createContext(false);

/** Standalone toggle row used inside plain-group mini-cards. Distinct
 *  from `PlainParamRow` (which is for filter-aware groups with
 *  zebra/accent gating) — these are simple bottom-section booleans
 *  with no zebra, no accent border, no indent. */
function BooleanRow({
  param,
  value,
  onChange,
  readOnly,
  forceIcon,
}: {
  name: string;
  param: ParamSchema;
  value: ParamFieldValue;
  onChange: (value: ParamFieldValue) => void;
  readOnly?: boolean;
  forceIcon?: boolean;
}) {
  const modified = !valuesEqual(value, param.default);
  const longDesc = !!param.description && (forceIcon || param.description.length > 60);
  return (
    <div className="flex items-start gap-2 py-1">
      <input
        type="checkbox"
        checked={Boolean(value)}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded-sm shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span
            className={`text-sm whitespace-nowrap ${modified ? "text-[var(--accent)]" : "text-[var(--foreground)]"}`}
          >
            {param.label}
          </span>
          {longDesc && <InfoIcon description={param.description!} />}
        </div>
        {param.description && !longDesc && (
          <p className="text-xs text-[var(--muted)] mt-0.5 leading-snug">
            {param.description}
          </p>
        )}
      </div>
    </div>
  );
}

/** Set of every param key owned by any registered filter. Used to
 *  separate plain params from filter-card params when a group holds
 *  both (e.g. "Exit Filters" — breakeven is plain, the
 *  EMA close-through exit is a registry filter). */
const FILTER_OWNED_KEYS = new Set<string>([
  ...Object.values(ENTRY_FILTER_REGISTRY).flatMap((f) => Object.keys(f.paramSchema)),
  ...Object.values(EXIT_FILTER_REGISTRY).flatMap((f) => Object.keys(f.paramSchema)),
]);

/** Value-level equality for the modified-from-default check. Numbers
 *  compare loosely (1 === "1") because number inputs sometimes
 *  surface as strings when freshly typed. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return false;
}

/** Whether `param`'s `visibleWhen` holds. A saved row is sparse — a key the
 *  operator never touched is absent — so the controlling value falls back to
 *  its own schema default, as `filter-selector.tsx` does. */
function passesVisibleWhen(
  param: ParamSchema,
  values: ParamValues,
  schema: Record<string, ParamSchema>,
): boolean {
  if (!param.visibleWhen) return true;
  const ref = values[param.visibleWhen.key] ?? schema[param.visibleWhen.key]?.default;
  return 'values' in param.visibleWhen
    ? param.visibleWhen.values.includes(ref)
    : ref === param.visibleWhen.value;
}

/** Count of enabled boolean toggles in a group. Drives the active dot
 *  and count badge on collapsed Entry Filters / Brackets / Exit
 *  Filters sections so the operator can see at a glance whether
 *  anything inside is engaged without expanding. */
function countGroupActive(fields: [string, ParamSchema][], values: ParamValues): number {
  let count = 0;
  for (const [key, param] of fields) {
    if (param.type === "boolean" && Boolean(values[key] ?? param.default)) {
      count++;
    }
  }
  return count;
}

function MiniCard({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-4 ${className}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
        {title}
      </p>
      {children}
    </div>
  );
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 last:mb-0">{children}</div>;
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--muted)] italic">{children}</p>;
}

interface PlainRow {
  /** The leading boolean that gates this row, if any. */
  toggleKey: string | null;
  toggleParam: ParamSchema | null;
  /** Non-boolean fields that belong to this toggle (or a leading row
   *  with no toggle, e.g. params before the first boolean). */
  inputs: [string, ParamSchema][];
}

/** Walk a flat field list and emit rows: each leading boolean starts
 *  a new row that owns every non-boolean param until the next boolean.
 *  Pre-boolean inputs collect into a row with no toggle (always
 *  visible). */
function groupByLeadingBoolean(fields: [string, ParamSchema][]): PlainRow[] {
  const rows: PlainRow[] = [];
  let current: PlainRow = { toggleKey: null, toggleParam: null, inputs: [] };
  for (const [key, param] of fields) {
    // Sub-toggles flagged `inline` join the current row's inputs rather
    // than starting a new row — used for booleans that modify a sibling
    // input's behavior.
    const isInlineBoolean =
      param.type === "boolean" && (param as { inline?: boolean }).inline === true;
    if (param.type === "boolean" && !isInlineBoolean) {
      if (current.toggleKey || current.inputs.length > 0) rows.push(current);
      current = { toggleKey: key, toggleParam: param, inputs: [] };
    } else {
      current.inputs.push([key, param]);
    }
  }
  if (current.toggleKey || current.inputs.length > 0) rows.push(current);
  return rows;
}

function PlainParamRow({
  row,
  values,
  schema,
  update,
  readOnly,
  rowIndex,
}: {
  row: PlainRow;
  values: ParamValues;
  schema: Record<string, ParamSchema>;
  update: (key: string, value: ParamValue) => void;
  readOnly?: boolean;
  rowIndex: number;
}) {
  const hasToggle = row.toggleKey != null && row.toggleParam != null;
  const enabled = hasToggle
    ? Boolean(values[row.toggleKey!] ?? row.toggleParam!.default)
    : true;
  const zebra = rowIndex % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]";

  // Collapse animation state. `hasInteracted` stays false on mount so
  // the initial render never animates. `overflowVisible` trails behind
  // the transition: set to true only after the expand transition ends
  // so dropdowns inside aren't clipped mid-animation.
  const [hasInteracted, setHasInteracted] = useState(false);
  const [overflowVisible, setOverflowVisible] = useState(enabled);

  // Sync overflowVisible when enabled changes (user toggles the checkbox).
  // On collapse, clip immediately (overflow:hidden allows the transition).
  // On expand, wait for transitionend to restore overflow:visible.
  useEffect(() => {
    if (!hasInteracted) return;
    if (!enabled) setOverflowVisible(false);
    // expand: overflowVisible is restored by onTransitionEnd below
  }, [enabled, hasInteracted]);

  const handleToggle = (checked: boolean) => {
    setHasInteracted(true);
    update(row.toggleKey!, checked);
  };

  // Lead-in row with no toggle (params before the first boolean) —
  // render inputs in a responsive 2-col grid without checkbox or border accents.
  if (!hasToggle) {
    if (row.inputs.length === 0) return null;
    return (
      <div className={`${zebra} border-b border-[var(--card-border)] py-3 px-3`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {row.inputs.map(([key, param]) => {
            if (!passesVisibleWhen(param, values, schema)) return null;
            return (
              <ParamField
                key={key}
                name={key}
                param={param}
                value={values[key] ?? param.default}
                onChange={(v) => update(key, v)}
                readOnly={readOnly}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const hasBody = row.inputs.length > 0 || !!row.toggleParam!.description;

  return (
    <div
      className={`${zebra} border-b border-[var(--card-border)] last:border-b-0 transition-colors px-3 ${
        enabled ? "border-l-2 border-l-[var(--accent)]" : "border-l-2 border-l-transparent"
      }`}
    >
      {/* Checkbox + label — always visible on one line */}
      <label className="flex items-center gap-2 cursor-pointer py-3">
        <input
          type="checkbox"
          checked={enabled}
          disabled={readOnly}
          onChange={(e) => handleToggle(e.target.checked)}
          className="rounded-sm shrink-0"
        />
        <span className="text-sm font-medium text-[var(--foreground)]">
          {row.toggleParam!.label}
        </span>
      </label>

      {/* Collapsible body: inputs + description. Hidden when toggle is off. */}
      {hasBody && (
        <div
          style={{
            maxHeight: enabled ? "600px" : "0px",
            overflow: overflowVisible ? "visible" : "hidden",
            transition: hasInteracted ? "max-height 150ms ease-out" : "none",
          }}
          onTransitionEnd={() => {
            if (enabled) setOverflowVisible(true);
          }}
        >
          {row.inputs.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 pb-3">
              {row.inputs.map(([key, param]) => {
                if (!passesVisibleWhen(param, values, schema)) return null;
                return (
                  <ParamField
                    key={key}
                    name={key}
                    param={param}
                    value={values[key] ?? param.default}
                    onChange={(v) => update(key, v)}
                    readOnly={readOnly}
                    forceIcon
                  />
                );
              })}
            </div>
          )}
          {row.toggleParam!.description && (
            <div className="pb-3 text-xs leading-snug text-[var(--muted)]">
              <p>{row.toggleParam!.description}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Stacked-column render of a single group's fields. Used by the
 *  Risk / Session mini-cards in the 3-column header — single column
 *  fits the narrow card better than a 3-up grid. */
function renderInlineGroup(
  fields: [string, ParamSchema][],
  buildVisibilitySet: (fs: [string, ParamSchema][]) => Set<number>,
  values: ParamValues,
  update: (key: string, value: ParamValue) => void,
  readOnly?: boolean,
): React.ReactNode {
  const visibleSet = buildVisibilitySet(fields);
  return (
    <div className="space-y-3">
      {fields.map(([key, param], i) =>
        visibleSet.has(i) ? (
          <ParamField
            key={key}
            name={key}
            param={param}
            value={values[key] ?? param.default}
            onChange={(v) => update(key, v)}
            readOnly={readOnly}
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * Optional Execution-mini-card content. When passed, ParamForm renders
 * a 3-column header with Execution / Risk / Session subgroups before
 * the rest of the strategy-specific groups. Ticker lives here because
 * it's user-editable; entryType + timeframe are read-only summaries
 * pulled from StrategyConfig.
 */
export interface ExecutionConfig {
  ticker: string;
  setTicker: (next: string) => void;
  /** Free-text label for the strategy's entry type ("Market", "Stop", …). */
  entryTypeLabel: string;
  /** The playbook's `config.session` — the Session card states it, nothing
   *  edits it. Here rather than in the schema because it is not a param. */
  session: MainSession;
  /** Render-prop for the ticker <select>. Lets the caller own the
   *  TICKER_OPTIONS shape without ParamForm reaching into UI types. */
  renderTickerSelect: (props: {
    value: string;
    onChange: (next: string) => void;
    className: string;
  }) => React.ReactNode;
}

interface ParamFormProps {
  schema: Record<string, ParamSchema>;
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  readOnly?: boolean;
  /**
   * Keys to skip when rendering. Their values stay in `values` (so defaults
   * still flow through), they just don't appear in the form. Used by
   * strategies that opt out of a CommonParams knob via
   * `StrategyConfig.hiddenCommonParams`.
   */
  hiddenKeys?: string[];
  /**
   * When true, every group beyond the first ("Parameters") renders as a
   * collapsible section that's collapsed by default. The first group
   * stays inline since it's already inside an outer collapsible.
   */
  collapsibleGroups?: boolean;
  /**
   * Prefix for the localStorage key used by collapsible groups. Required
   * when `collapsibleGroups` is true and you want state to persist.
   */
  storageKeyPrefix?: string;
  /**
   * When set (strategy-detail mode), the Risk + Session groups are
   * pulled out of the plain-group flow and rendered alongside the
   * Execution mini-card in a 3-column grid above the rest.
   */
  execution?: ExecutionConfig;
  /**
   * Research mode, for *Try settings* only: a select whose schema declares
   * `explore` renders a free input of that type instead of its calibration
   * list. The deployment editor never sets it — a live deployment keeps the
   * calibrated values.
   */
  explore?: boolean;
}

/** Group name → filter-registry category. Groups in this map get the
 *  per-filter card UI from FilterSelector for any registry entries that
 *  match the category; plain params still in the group render above the
 *  filter cards as a normal grid. Groups not in this map render with
 *  the legacy flat grid only. */
const FILTER_GROUP_CATEGORY: Record<string, "entry" | "brackets" | "exit"> = {
  "Entry Filters": "entry",
  Brackets: "brackets",
  "Exit Filters": "exit",
};

/**
 * Renders a form automatically from a strategy's `params` schema.
 * Groups fields by `group` when present.
 */
export function ParamForm({ explore = false, ...props }: ParamFormProps) {
  return (
    <ExploreModeContext.Provider value={explore}>
      <ParamFormBody {...props} />
    </ExploreModeContext.Provider>
  );
}

function ParamFormBody({
  schema,
  values,
  onChange,
  readOnly,
  hiddenKeys,
  collapsibleGroups,
  storageKeyPrefix,
  execution,
}: Omit<ParamFormProps, "explore">) {
  const hidden = new Set(hiddenKeys ?? []);
  const entries = Object.entries(schema).filter(([key]) => !hidden.has(key));
  if (entries.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No parameters.</p>;
  }

  // Group fields by the optional `group` field
  const groups = new Map<string, [string, ParamSchema][]>();
  for (const [key, param] of entries) {
    const g = param.group ?? "Parameters";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([key, param]);
  }

  function update(key: string, value: ParamValue) {
    onChange({ ...values, [key]: value });
  }

  // Within each group, a boolean param gates every non-boolean param that
  // follows it (until the next boolean). Walk each group once forward,
  // tracking the most recent boolean and its current value, so visibility
  // is O(n) per group instead of O(n²).
  function buildVisibilitySet(fields: [string, ParamSchema][]): Set<number> {
    const visible = new Set<number>();
    let gateOpen = true;
    for (let i = 0; i < fields.length; i++) {
      const [key, param] = fields[i];
      if (param.type === "boolean") {
        gateOpen = Boolean(values[key] ?? param.default);
        visible.add(i);
        continue;
      }
      if (!gateOpen) continue;
      if (!passesVisibleWhen(param, values, schema)) continue;
      visible.add(i);
    }
    return visible;
  }

  function renderGroupBody(
    groupName: string,
    fields: [string, ParamSchema][],
  ): React.ReactNode {
    const filterCategory = FILTER_GROUP_CATEGORY[groupName];
    // For filter-aware groups, split fields into plain params (rendered
    // as a grid above) and registry-owned params (rendered by
    // FilterSelector below). Plain params keep the boolean-gate
    // visibility logic so things like "Break-even at % of TP" still
    // gate "Break-even offset (ticks)" correctly.
    if (filterCategory) {
      // Plain params inside a filter-aware group render in the same
      // row pattern as registered filters: a leading boolean acts as
      // the row's enable toggle, and any non-boolean params that
      // follow it (until the next boolean) only render when that
      // boolean is on. Rows have a 1px bottom border between them and
      // a 2px accent left-border on the active row, matching FilterRow.
      const plainFields = fields.filter(([key]) => !FILTER_OWNED_KEYS.has(key));
      const plainRows = groupByLeadingBoolean(plainFields);
      return (
        <div>
          {plainRows.map((row, idx) => (
            <PlainParamRow
              key={row.toggleKey ?? `row-${idx}`}
              row={row}
              values={values}
              schema={schema}
              update={update}
              readOnly={readOnly}
              rowIndex={idx}
            />
          ))}
          <FilterSelector
            category={filterCategory}
            schema={schema}
            values={values}
            onChange={onChange}
            readOnly={readOnly}
            startIndex={plainRows.length}
          />
        </div>
      );
    }
    const visibleSet = buildVisibilitySet(fields);
    const visibleFields = fields.filter((_, i) => visibleSet.has(i));
    const numericFields = visibleFields.filter(
      ([, p]) => p.type !== "boolean" && p.type !== "select",
    );
    const selectFields = visibleFields.filter(([, p]) => p.type === "select");
    const booleanFields = visibleFields.filter(([, p]) => p.type === "boolean");
    const cardUsesIcons = fields.some(
      ([, p]) => p.description != null && p.description.length > 60,
    );
    const hasStacked = selectFields.length > 0 || booleanFields.length > 0;
    return (
      <div>
        {numericFields.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0 mb-3">
            {numericFields.map(([key, param]) => (
              <ParamField
                key={key}
                name={key}
                param={param}
                value={values[key] ?? param.default}
                onChange={(v) => update(key, v)}
                readOnly={readOnly}
                forceIcon={cardUsesIcons}
              />
            ))}
          </div>
        )}
        {hasStacked && (
          <div
            className={`${numericFields.length > 0 ? "border-t border-[var(--card-border)] pt-3" : ""}`}
          >
            {selectFields.length > 0 && (
              <div className="space-y-3 mb-3 last:mb-0">
                {selectFields.map(([key, param]) => (
                  <div key={key} className="[&>div]:mb-0">
                    <ParamField
                      name={key}
                      param={param}
                      value={values[key] ?? param.default}
                      onChange={(v) => update(key, v)}
                      readOnly={readOnly}
                      forceIcon={cardUsesIcons}
                    />
                  </div>
                ))}
              </div>
            )}
            {booleanFields.length > 0 && (
              <div className="space-y-2">
                {booleanFields.map(([key, param]) => (
                  <BooleanRow
                    key={key}
                    name={key}
                    param={param}
                    value={(values[key] ?? param.default) as ParamFieldValue}
                    onChange={(v) => update(key, v)}
                    readOnly={readOnly}
                    forceIcon={cardUsesIcons}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (collapsibleGroups) {
    // Strategy-detail mode. Layout has three tiers:
    //   1. Top 3-column grid (Execution / Risk / Session mini-cards),
    //      only when an `execution` config is provided.
    //   2. Flex-wrap row of mini-cards for every other plain group
    //      (Indicators, ORB, Trend, etc.) — fills horizontal space
    //      so simple strategies stay one row, complex ones stack.
    //   3. Filter-aware groups (Entry Filters / Brackets / Exit
    //      Filters) as nested full-width collapsibles below.
    // Critically: every group from the schema is placed in exactly
    // one tier, so no params get dropped.
    const filterGroups: [string, [string, ParamSchema][]][] = [];
    const plainGroups: [string, [string, ParamSchema][]][] = [];
    let executionGroup: [string, ParamSchema][] | null = null;
    let riskGroup: [string, ParamSchema][] | null = null;
    let sessionGroup: [string, ParamSchema][] | null = null;
    for (const [name, fields] of groups.entries()) {
      if (FILTER_GROUP_CATEGORY[name]) {
        filterGroups.push([name, fields]);
        continue;
      }
      if (execution && name === "Execution") {
        executionGroup = fields;
        continue;
      }
      if (execution && name === "Risk") {
        riskGroup = fields;
        continue;
      }
      if (execution && name === "Session") {
        sessionGroup = fields;
        continue;
      }
      plainGroups.push([name, fields]);
    }

    return (
      <div>
        {execution && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
            <MiniCard title="Execution">
              <FieldRow>
                <label className="block text-xs text-[var(--muted)] mb-1">Ticker</label>
                {execution.renderTickerSelect({
                  value: execution.ticker,
                  onChange: execution.setTicker,
                  className:
                    "w-full px-3 py-2 rounded-md bg-[var(--background)] border border-[var(--card-border)] text-sm focus:outline-none focus:border-[var(--accent)]",
                })}
              </FieldRow>
              {executionGroup && (
                <div className="mb-3 last:mb-0">
                  {renderInlineGroup(executionGroup, buildVisibilitySet, values, update, readOnly)}
                </div>
              )}
              <ReadOnlyRow label="Entry" value={execution.entryTypeLabel} />
            </MiniCard>
            <MiniCard title="Risk">
              {riskGroup
                ? renderInlineGroup(riskGroup, buildVisibilitySet, values, update, readOnly)
                : <EmptyHint>No risk params.</EmptyHint>}
            </MiniCard>
            <MiniCard title="Session">
              {renderSessionCard(sessionGroup ?? [], execution.session, values, update, readOnly)}
            </MiniCard>
          </div>
        )}
        {plainGroups.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,480px),1fr))] gap-4 mb-5">
            {plainGroups.map(([groupName, fields]) => (
              <MiniCard key={groupName} title={groupName}>
                {renderGroupBody(groupName, fields)}
              </MiniCard>
            ))}
          </div>
        )}
        {filterGroups.map(([groupName, fields]) => {
          const activeCount = countGroupActive(fields, values);
          return (
            <div
              key={groupName}
              className="-mx-5 border-t border-[var(--card-border)] first:border-t-0"
            >
              <CollapsibleSection
                title={groupName}
                defaultOpen={false}
                hasActive={activeCount > 0}
                activeCount={activeCount}
                storageKey={storageKeyPrefix ? storageKeyPrefix + groupName : undefined}
              >
                {renderGroupBody(groupName, fields)}
              </CollapsibleSection>
            </div>
          );
        })}
      </div>
    );
  }

  // Non-collapsible legacy path (used wherever ParamForm renders
  // outside the strategy-detail page). Keeps the inline group
  // headings so the form stays self-explanatory.
  return (
    <div className="space-y-5">
      {Array.from(groups.entries()).map(([groupName, fields]) => (
        <div key={groupName}>
          <p className="text-xs text-[var(--muted)] uppercase tracking-wide mb-2">
            {groupName}
          </p>
          {renderGroupBody(groupName, fields)}
        </div>
      ))}
    </div>
  );
}

/** Primary start/end row + "to" separator. Reused for additional
 *  windows so the two layouts stay visually identical. */
function SessionWindowRow({
  start,
  end,
  onStartChange,
  onEndChange,
  readOnly,
}: {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <TimeStepInput
          value={start}
          onChange={onStartChange}
          readOnly={readOnly}
          ariaLabel="Window start"
        />
      </div>
      <span className="text-xs text-[var(--muted)]">to</span>
      <div className="flex-1">
        <TimeStepInput
          value={end}
          onChange={onEndChange}
          readOnly={readOnly}
          ariaLabel="Window end"
        />
      </div>
    </div>
  );
}

function SessionsEditor({
  windows,
  onChange,
  maxItems,
  readOnly,
}: {
  windows: SessionWindow[];
  onChange: (next: SessionWindow[]) => void;
  maxItems: number;
  readOnly?: boolean;
}) {
  const atCap = windows.length >= maxItems;
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={readOnly || atCap}
        onClick={() => onChange([...windows, { start: "09:30", end: "15:55" }])}
        className={`w-full px-3 py-2 rounded-md text-sm border transition-colors ${
          atCap
            ? "border-[var(--card-border)] text-[var(--muted)] opacity-50 cursor-not-allowed bg-transparent"
            : "border-[var(--card-border)] text-[var(--foreground)] bg-transparent hover:border-[var(--accent)] hover:bg-[var(--accent)]/10"
        }`}
      >
        {atCap ? `Max windows reached (${maxItems})` : "+ Add session window"}
      </button>
      <p className="text-xs text-[var(--muted)] mt-1">
        Up to {maxItems} additional windows, same rules.
      </p>
      {windows.length > 0 && (
        <div className="mt-3 space-y-3">
          {windows.map((w, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-[var(--muted)] shrink-0">Window {i + 2}</span>
                <span className="flex-1 h-px bg-[var(--card-border)]" />
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange(windows.filter((_, idx) => idx !== i))}
                  aria-label={`Remove window ${i + 2}`}
                  className="w-5 h-5 flex items-center justify-center rounded-md text-[var(--danger)] hover:bg-[var(--danger)]/15 transition-colors leading-none"
                >
                  ×
                </button>
              </div>
              <SessionWindowRow
                start={w.start}
                end={w.end}
                onStartChange={(start) =>
                  onChange([...windows.slice(0, i), { start, end: w.end }, ...windows.slice(i + 1)])
                }
                onEndChange={(end) =>
                  onChange([...windows.slice(0, i), { start: w.start, end }, ...windows.slice(i + 1)])
                }
                readOnly={readOnly}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dedicated render for the Session schedule: the playbook's own trading
 *  window, read-only, plus the deployment's `pauseWindows` editor and the
 *  shared `SessionTimeline` visualization.
 *
 *  **The window is not a field.** It is `StrategyConfig.session` and arrives
 *  through `ExecutionConfig` beside the other read-only summaries the same
 *  config supplies — entry type and timeframe. There is nothing to edit and
 *  nothing to save; what the operator still owns is the pauses carved inside
 *  it.
 *
 *  The `Session` group's remaining key is `pauseWindows`, plus any
 *  strategy-specific session fields (rare). Any unknown extras fall through
 *  to the generic field grid below the timeline. */
function renderSessionCard(
  fields: [string, ParamSchema][],
  session: MainSession,
  values: ParamValues,
  update: (key: string, value: ParamValue) => void,
  readOnly?: boolean,
): React.ReactNode {
  const pauseEntry = fields.find(([, p]) => p.type === "pauseWindows");
  const otherFields = fields.filter(([, p]) => p.type !== "pauseWindows");

  const pauseKey = pauseEntry?.[0] ?? "pauseWindows";
  const pauses: PauseWindow[] = (values[pauseKey] as PauseWindow[] | undefined) ?? [];

  const setPauses = (next: PauseWindow[]) => update(pauseKey, next);

  return (
    <div>
      <SessionScheduleEditor
        main={session}
        pauses={pauses}
        onPausesChange={setPauses}
        readOnly={readOnly}
      />
      {otherFields.length > 0 && (
        <div className="mt-3 space-y-3 border-t border-[var(--card-border)] pt-3">
          {otherFields.map(([key, param]) => (
            <ParamField
              key={key}
              name={key}
              param={param}
              value={(values[key] ?? param.default) as ParamFieldValue}
              onChange={(v) => update(key, v)}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** "Session schedule" editor — the playbook's window as a stated fact, a
 *  1-to-N pause-windows list with inline validation, and the shared
 *  `SessionTimeline` overlay.
 *
 *  `main` is `StrategyConfig.session` and has no setter: the playbook owns the
 *  window it trades. */
export function SessionScheduleEditor({
  main,
  pauses,
  onPausesChange,
  readOnly,
}: {
  main: MainSession;
  pauses: PauseWindow[];
  onPausesChange: (next: PauseWindow[]) => void;
  readOnly?: boolean;
}) {
  // Per-row validation. Only flag a row when validation fails; clean
  // rows render with no error annotation.
  const errors = useMemo(() => {
    const out: (string | null)[] = pauses.map(() => null);
    for (let i = 0; i < pauses.length; i++) {
      const p = pauses[i];
      if (!pauseStrictlyInsideMain(p, main)) {
        out[i] = "Pause must fall strictly inside the main session.";
        continue;
      }
      // Pairwise non-overlap.
      for (let j = 0; j < pauses.length; j++) {
        if (i === j) continue;
        if (pausesOverlap(p, pauses[j])) {
          out[i] = "Pause overlaps another pause window.";
          break;
        }
      }
    }
    return out;
  }, [pauses, main]);

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
        Session schedule
      </p>

      <div className="rounded-md border border-[var(--card-border)] bg-[var(--bg-row-alt)] p-3 mb-3">
        <ReadOnlyRow label="Trading window" value={`${main.start} – ${main.end}`} />
        <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
          {main.timezone}. Set by the strategy. Positions force-exit at the window end; entries blocked outside the active interval.
        </p>
      </div>

      <div className="rounded-md border border-[var(--card-border)] bg-[var(--card)] p-3 mb-3">
        <p className="text-xs text-[var(--muted)] mb-2">
          Pause windows — no new entries during these times; open positions exit at pause start.
        </p>
        {pauses.length === 0 ? (
          <p className="text-xs text-[var(--muted)] italic mb-2">No pauses configured.</p>
        ) : (
          <div className="space-y-2 mb-2">
            {pauses.map((p, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-sm ${
                  i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
                }`}
              >
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <TimeStepInput
                    value={p.start}
                    onChange={(v) =>
                      onPausesChange(pauses.map((q, idx) => (idx === i ? { ...q, start: v } : q)))
                    }
                    readOnly={readOnly}
                    ariaLabel={`Pause ${i + 1} start`}
                  />
                  <TimeStepInput
                    value={p.end}
                    onChange={(v) =>
                      onPausesChange(pauses.map((q, idx) => (idx === i ? { ...q, end: v } : q)))
                    }
                    readOnly={readOnly}
                    ariaLabel={`Pause ${i + 1} end`}
                  />
                </div>
                {errors[i] && (
                  <span className="text-[10px] font-mono text-[var(--danger)] max-w-[200px] truncate">
                    {errors[i]}
                  </span>
                )}
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onPausesChange(pauses.filter((_, idx) => idx !== i))}
                  aria-label={`Remove pause ${i + 1}`}
                  className="w-5 h-5 flex items-center justify-center rounded-md text-[var(--danger)] hover:bg-[var(--danger)]/15 transition-colors leading-none"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onPausesChange([...pauses, { start: "12:30", end: "13:00" }])}
          className="w-full px-3 py-2 rounded-md text-sm border border-[var(--card-border)] text-[var(--foreground)] bg-transparent hover:border-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-50"
        >
          + Add pause window
        </button>
      </div>

      <SessionTimeline main={main} pauses={pauses} />

      <p className="text-[10px] text-[var(--muted)] mt-2 leading-relaxed">
        Trader is responsible for pausing on half-days (Thanksgiving, Christmas Eve, July 3) until calendar support lands.
      </p>
    </div>
  );
}

function ParamField({
  name,
  param,
  value,
  onChange,
  readOnly,
  forceIcon,
  disabledOverride,
  annotation,
}: {
  name: string;
  param: ParamSchema;
  value: ParamFieldValue;
  onChange: (value: ParamFieldValue) => void;
  readOnly?: boolean;
  forceIcon?: boolean;
  /** Force the input into a disabled+dimmed state without changing
   *  readOnly semantics. Used for sub-toggle-driven dimming. */
  disabledOverride?: boolean;
  /** Optional muted annotation rendered after the input value when this
   *  field is dimmed by a sibling toggle. */
  annotation?: string;
}) {
  const exploreMode = useContext(ExploreModeContext);
  // Session-shape params are rendered by the dedicated Session card —
  // skip them in the generic field grid.
  if (param.type === "sessions" || param.type === "pauseWindows") {
    return null;
  }
  // "Modified from default" glance-test: when the live value differs
  // from the schema default, ring the input in accent so an operator
  // can see at a glance which knobs they've changed from baseline.
  // Booleans use a colored label instead of a ring (no input border).
  const modified = !valuesEqual(value, param.default);
  const ringClass = modified ? "border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]" : "border-[var(--card-border)]";
  const inputClass =
    `w-full px-3 py-2 rounded-md bg-[var(--background)] border text-sm focus:outline-none focus:border-[var(--accent)] disabled:opacity-60 transition-colors ${ringClass}`;
  const numericClass = `${inputClass} tabular font-mono`;

  const longDesc = !!param.description && (forceIcon || param.description.length > 60);

  if (param.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded-sm"
        />
        <span className={modified ? "text-[var(--accent)]" : ""}>{param.label}</span>
        {longDesc && <InfoIcon description={param.description!} />}
        {param.description && !longDesc && (
          <span className="text-xs text-[var(--muted)]">{param.description}</span>
        )}
      </label>
    );
  }

  if (param.type === "select") {
    return (
      <div className="mb-3">
        <label htmlFor={name} className="flex items-center gap-1 text-xs text-[var(--muted)] mb-1">
          {param.label}
          {longDesc && <InfoIcon description={param.description!} />}
        </label>
        {exploreMode && param.explore != null ? (
          <ExploreParamField
            id={name}
            param={param}
            domain={param.explore}
            value={value}
            onChange={onChange}
            readOnly={readOnly}
            modified={modified}
            inputClass={inputClass}
          />
        ) : isFixedChoice(param) ? (
          <FixedChoiceValue id={name} param={param} value={value} modified={modified} />
        ) : (
          <select
            id={name}
            className={inputClass}
            value={String(value)}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
          >
            {param.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}
        {param.description && !longDesc && (
          <p className="text-xs text-[var(--muted)] mt-1">{param.description}</p>
        )}
      </div>
    );
  }

  if (param.type === "time") {
    return (
      <div className="mb-3">
        <label htmlFor={name} className="flex items-center gap-1 text-xs text-[var(--muted)] mb-1">
          {param.label}
          {longDesc && <InfoIcon description={param.description!} />}
        </label>
        <TimeStepInput
          name={name}
          value={String(value)}
          onChange={(v) => onChange(v)}
          readOnly={readOnly}
          ariaLabel={param.label}
          modified={modified}
        />
        {param.description && !longDesc && (
          <p className="text-xs text-[var(--muted)] mt-1">{param.description}</p>
        )}
      </div>
    );
  }

  // number / integer
  const isInt = param.type === "integer";
  const dimmed = !!disabledOverride;
  const isZeroOff =
    "zeroMeansDisabled" in param &&
    param.zeroMeansDisabled === true &&
    Number(value) === 0 &&
    (param.min === undefined || param.min <= 0);
  const resolvedAnnotation = annotation ?? (isZeroOff ? "OFF" : undefined);
  // Research mode only: a calibrated range is what was measured, not what the
  // hooks can take, so the input leaves it and the note says when it is left.
  const calibrated = exploreMode ? param.calibrated : undefined;
  return (
    <div className="mb-3" style={dimmed ? { opacity: 0.4 } : undefined}>
      <label htmlFor={name} className="flex items-center gap-1 text-xs text-[var(--muted)] mb-1">
        {param.label}
        {longDesc && <InfoIcon description={param.description!} />}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={name}
          className={numericClass}
          type="number"
          step={isInt ? 1 : param.step ?? "any"}
          min={calibrated ? undefined : param.min}
          max={calibrated ? undefined : param.max}
          value={Number(value)}
          disabled={readOnly || dimmed}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(isInt ? Math.round(n) : n);
          }}
        />
        {resolvedAnnotation && (
          <span className="text-xs font-mono text-[var(--muted)] whitespace-nowrap">
            {resolvedAnnotation}
          </span>
        )}
      </div>
      {calibrated && (
        <CalibrationNote
          hint={describeCalibratedBand(param, calibrated)}
          off={isOffCalibration(param, value)}
        />
      )}
      {param.description && !longDesc && (
        <p className="text-xs text-[var(--muted)] mt-1">{param.description}</p>
      )}
    </div>
  );
}
