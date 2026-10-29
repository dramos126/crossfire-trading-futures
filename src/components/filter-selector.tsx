"use client";

import { useEffect, useState } from "react";
import type { ParamSchema, ParamValues } from "@/lib/trading/strategy-types";
import {
  ENTRY_FILTER_REGISTRY,
  EXIT_FILTER_REGISTRY,
  type FilterMetadata,
} from "@/lib/trading/filters";
import { FixedChoiceValue, isFixedChoice } from "@/components/fixed-choice-field";
import { InfoIcon } from "@/components/info-icon";
import { TimeStepInput } from "@/components/time-step-input";

interface FilterSelectorProps {
  /** Which registry to render ("entry", "brackets", or "exit"). "brackets"
   *  has no registered filters today and renders nothing. */
  category: "entry" | "brackets" | "exit";
  /**
   * Full strategy param schema. Only the subset of keys that map to a filter
   * in the selected registry are rendered here; everything else is rendered
   * by the parent ParamForm.
   */
  schema: Record<string, ParamSchema>;
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  readOnly?: boolean;
  /** Where this section's rows start in the parent's overall row
   *  count. Lets the zebra striping continue uninterrupted across
   *  plain-param rows and filter rows. */
  startIndex?: number;
}

/**
 * Each filter renders as a single row. Inputs and the enable
 * description are always visible — unchecked rows dim to 40% opacity
 * so the operator can see what would activate without the section
 * collapsing. Active rows get a 2px accent left-border. Rows are
 * separated by a 1px bottom border to keep the editor visually flat.
 */
export function FilterSelector({
  category,
  schema,
  values,
  onChange,
  readOnly,
  startIndex = 0,
}: FilterSelectorProps) {
  const filters: FilterMetadata[] =
    category === "entry"
      ? Object.values(ENTRY_FILTER_REGISTRY)
      : category === "exit"
        ? Object.values(EXIT_FILTER_REGISTRY)
        : [];
  const visibleFilters = filters.filter((f) => f.enableKey in schema);
  if (visibleFilters.length === 0) return null;

  return (
    <div>
      {visibleFilters.map((filter, i) => (
        <FilterRow
          key={filter.key}
          filter={filter}
          schema={schema}
          values={values}
          onChange={onChange}
          readOnly={readOnly}
          rowIndex={startIndex + i}
        />
      ))}
    </div>
  );
}

function FilterRow({
  filter,
  schema,
  values,
  onChange,
  readOnly,
  rowIndex,
}: {
  filter: FilterMetadata;
  schema: Record<string, ParamSchema>;
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  readOnly?: boolean;
  rowIndex: number;
}) {
  const zebra = rowIndex % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]";
  const enableParam = schema[filter.enableKey];
  const enabled = Boolean(values[filter.enableKey] ?? enableParam?.default ?? false);

  // Collapse animation — same pattern as PlainParamRow.
  const [hasInteracted, setHasInteracted] = useState(false);
  const [overflowVisible, setOverflowVisible] = useState(enabled);

  useEffect(() => {
    if (!hasInteracted) return;
    if (!enabled) setOverflowVisible(false);
  }, [enabled, hasInteracted]);

  const handleToggle = (checked: boolean) => {
    setHasInteracted(true);
    onChange({ ...values, [filter.enableKey]: checked });
  };

  const bodyEntries = Object.entries(filter.paramSchema).filter(
    ([key, p]) => key !== filter.enableKey && p.type !== "boolean",
  );

  function update(key: string, value: number | boolean | string) {
    onChange({ ...values, [key]: value });
  }

  const inputClass =
    "w-full px-3 py-2 rounded-md bg-[var(--background)] border border-[var(--card-border)] text-sm focus:outline-none focus:border-[var(--accent)] disabled:opacity-60 tabular font-mono";
  const labelClass = "block text-xs text-[var(--muted)] mb-1";

  const hasBody = bodyEntries.length > 0 || !!enableParam?.description;

  return (
    <div
      className={`${zebra} border-b border-[var(--card-border)] last:border-b-0 transition-colors px-3 ${
        enabled ? "border-l-2 border-l-[var(--accent)]" : "border-l-2 border-l-transparent"
      }`}
    >
      {/* Checkbox + label — always visible */}
      <label className="flex items-center gap-2 cursor-pointer py-3">
        <input
          type="checkbox"
          checked={enabled}
          disabled={readOnly}
          onChange={(e) => handleToggle(e.target.checked)}
          className="rounded-sm shrink-0"
        />
        <span className="text-sm font-medium text-[var(--foreground)]">
          {filter.name}
        </span>
      </label>

      {/* Collapsible body: inputs + description hint */}
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
          {bodyEntries.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 pb-3">
              {bodyEntries.map(([key, param]) => {
                if (param.visibleWhen) {
                  const ref = values[param.visibleWhen.key] ?? (filter.paramSchema[param.visibleWhen.key] as { default?: unknown } | undefined)?.default;
                  if ('values' in param.visibleWhen) {
                    if (!param.visibleWhen.values.includes(ref)) return null;
                  } else {
                    if (ref !== param.visibleWhen.value) return null;
                  }
                }
                return (
                <div key={key}>
                  <label className="flex items-center gap-1 text-xs text-[var(--muted)] mb-1" htmlFor={`${filter.key}-${key}`}>
                    {param.label}
                    {param.description && <InfoIcon description={param.description} />}
                  </label>
                  {param.type === "select" && isFixedChoice(param) ? (
                    <FixedChoiceValue
                      id={`${filter.key}-${key}`}
                      param={param}
                      value={values[key] ?? param.default}
                    />
                  ) : param.type === "select" ? (
                    <select
                      id={`${filter.key}-${key}`}
                      className={inputClass}
                      value={String(values[key] ?? param.default)}
                      disabled={readOnly}
                      onChange={(e) => update(key, e.target.value)}
                    >
                      {param.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : param.type === "time" ? (
                    <TimeStepInput
                      value={String(values[key] ?? param.default)}
                      onChange={(v) => update(key, v)}
                      readOnly={readOnly}
                      ariaLabel={param.label}
                    />
                  ) : (
                    <input
                      id={`${filter.key}-${key}`}
                      className={inputClass}
                      type="number"
                      step={
                        param.type === "integer"
                          ? 1
                          : param.type === "number"
                          ? param.step ?? "any"
                          : undefined
                      }
                      min={param.type === "number" || param.type === "integer" ? param.min : undefined}
                      max={param.type === "number" || param.type === "integer" ? param.max : undefined}
                      value={Number(values[key] ?? param.default)}
                      disabled={readOnly}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isNaN(n)) {
                          update(key, param.type === "integer" ? Math.round(n) : n);
                        }
                      }}
                    />
                  )}
                </div>
                );
              })}
            </div>
          )}

          {/* Rationale from the enable param's description */}
          {enableParam?.description && (
            <div className="pb-3 text-xs leading-snug text-[var(--muted)]">
              <p>{enableParam.description}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
