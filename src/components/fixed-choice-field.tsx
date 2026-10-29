import type { ParamValue, SelectParam } from "@/lib/trading/strategy-types";

export const FIXED_CHOICE_NOTE = "set by the playbook";
export const FIXED_CHOICE_TITLE =
  "The playbook's calibration allows only this value, so there is nothing to choose here. Another value would be a change to the playbook itself.";

/**
 * A select whose schema offers exactly one option. Read off the options, never
 * off a list of keys: the day a calibration gains a value, the param is a
 * normal select again with no change here.
 */
export function isFixedChoice(param: SelectParam): boolean {
  return param.options.length === 1;
}

/**
 * The value of a fixed choice as text, in the slot the select would take.
 * An `<output>` so the field's `<label htmlFor>` still names it. It prints the
 * value actually held — a run loaded from an older header can carry one the
 * option list no longer has, and printing the option instead would hide that.
 */
export function FixedChoiceValue({
  id,
  param,
  value,
  modified,
}: {
  id: string;
  param: SelectParam;
  value: ParamValue;
  modified?: boolean;
}) {
  const held = String(value);
  const text = param.options.find((o) => o.value === held)?.label ?? held;
  return (
    <div className="flex items-baseline gap-2 py-2" title={FIXED_CHOICE_TITLE}>
      <output
        id={id}
        className={`text-sm font-mono tabular ${modified ? "text-[var(--accent)]" : "text-[var(--foreground)]"}`}
      >
        {text}
      </output>
      <span className="text-[11px] text-[var(--muted)]">{FIXED_CHOICE_NOTE}</span>
    </div>
  );
}
