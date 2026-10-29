/**
 * A deployment's saved settings at the API boundary: each value converted to
 * its param's declared type, a calibrated number refused outside its band,
 * then the playbook's own settings refusal — the
 * check `POST /api/deployments`, `POST /api/groups` and `PATCH /api/groups/[id]`
 * run before anything is written.
 *
 * It exists because nothing downstream converts. The merge copies values as
 * they are stored and modules do arithmetic on them, so a number saved as text
 * reaches a hook live: an hourly EMA length of `"21"` makes `period + 1` the
 * string `"211"`.
 */

import { parseHHMM } from "@/lib/trading/session/session";
import { daySessionForTicker } from "@/lib/trading/contracts/contract-specs";
import { playbookSizingRefusal } from "@/lib/trading/orders/risk-sizer";
import { deepEqual } from "@/lib/trading/deep-equal";
import { CALIBRATED_OFF_VALUE, offCalibrationKeys } from "@/lib/trading/param-explore";
import {
  COMMON_PARAMS,
  resolveDeploymentParams,
  type NumericCalibrationRange,
  type ParamSchema,
  type ParamValue,
  type ParamValues,
  type StrategyModule,
} from "@/lib/trading/strategy-types";

export type DeploymentSettingsCheck =
  | { ok: true; values: ParamValues }
  | { ok: false; error: string };

const NUMERIC_TEXT = /^\s*-?\d+(\.\d+)?\s*$/;

/** `value` as `param`'s declared type, or `undefined` when it does not convert. */
function coerce(param: ParamSchema, value: unknown): ParamValue | undefined {
  switch (param.type) {
    case "number":
    case "integer": {
      const n = typeof value === "string" && NUMERIC_TEXT.test(value) ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
      return param.type === "integer" && !Number.isInteger(n) ? undefined : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" ? true : value === "false" ? false : undefined;
    case "select": {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
      const text = String(value);
      return param.options.some((o) => o.value === text) ? text : undefined;
    }
    case "time":
      return typeof value === "string" && parseHHMM(value) != null ? value : undefined;
    case "sessions":
    case "pauseWindows":
      return Array.isArray(value) ? (value as ParamValue) : undefined;
  }
}

function typeRefusal(param: ParamSchema, value: unknown): string {
  const given = JSON.stringify(value);
  switch (param.type) {
    case "number":
      return `${param.label} must be a number, and ${given} is not one.`;
    case "integer":
      return `${param.label} must be a whole number, and ${given} is not one.`;
    case "boolean":
      return `${param.label} is on or off (true or false), and ${given} is neither.`;
    case "select":
      return `${param.label} must be one of ${param.options.map((o) => o.label).join(", ")}, and ${given} is not one of them.`;
    case "time":
      return `${param.label} is a clock time, HH:MM, 24-hour, ET, and ${given} is not one.`;
    case "sessions":
    case "pauseWindows":
      return `${param.label} is a list of windows, and ${given} is not one.`;
  }
}

/** A calibrated number outside its band, naming the setting and the band. */
function calibrationRefusal(label: string, band: NumericCalibrationRange, value: unknown): string {
  const range =
    band.kind === "rangeOrOff"
      ? `from ${band.min} to ${band.max}, or ${CALIBRATED_OFF_VALUE} for off`
      : `from ${band.min} to ${band.max}`;
  return (
    `${label} is calibrated ${range}, and ${JSON.stringify(value)} is outside it. ` +
    "A deployment trades only calibrated values; Try settings runs any other as research."
  );
}

/**
 * Check one create's or edit's settings.
 *
 * Keys the schema does not declare pass unchanged: a retired key is stripped
 * and announced on read by `migrateLegacyParamOverrides`, never here. A key
 * whose playbook this build does not register is checked against
 * `COMMON_PARAMS` alone, which still converts the two sizing settings.
 *
 * The sizing sentences answer before a type sentence, so a cap of `"two"` or
 * `null` reads as the sizer's range, as it did before every param converted.
 */
export function checkDeploymentSettings(input: {
  strategyKey: string;
  ticker: string;
  module: Pick<StrategyModule, "params" | "settingsRefusal"> | undefined;
  values: Readonly<Record<string, unknown>>;
  /** The row's saved settings, on an edit. A key it already holds at the
   *  same value is not refused for being off its calibration. */
  stored?: Readonly<Record<string, unknown>>;
}): DeploymentSettingsCheck {
  const schema = input.module?.params ?? COMMON_PARAMS;
  const values: Record<string, unknown> = { ...input.values };
  let unconverted: { param: ParamSchema; value: unknown } | null = null;
  for (const [key, raw] of Object.entries(input.values)) {
    const param = schema[key];
    if (param == null) continue;
    const converted = coerce(param, raw);
    if (converted === undefined) unconverted ??= { param, value: raw };
    else values[key] = converted;
  }

  const sizing = playbookSizingRefusal(values);
  if (sizing != null) return { ok: false, error: sizing };
  if (unconverted != null) return { ok: false, error: typeRefusal(unconverted.param, unconverted.value) };

  for (const key of offCalibrationKeys(schema, values as ParamValues)) {
    const param = schema[key];
    // An unchanged stored value is exempt: a row saved before this check
    // would otherwise 400 on every unrelated edit, and refusing it there
    // narrows nothing — the edit leaves the value as it was. The stored side
    // is converted first: a row saved before A113 may hold `"0.5"` as text.
    if (input.stored != null && deepEqual(coerce(param, input.stored[key]), values[key])) continue;
    // Only a calibrated number can be named here: `coerce` has already
    // refused a select value its options do not list.
    if ((param.type === "number" || param.type === "integer") && param.calibrated != null) {
      return { ok: false, error: calibrationRefusal(param.label, param.calibrated, values[key]) };
    }
  }

  const module = input.module;
  if (module?.settingsRefusal) {
    const merged = resolveDeploymentParams(module, values as ParamValues, { strategyKey: input.strategyKey });
    const refusal = module.settingsRefusal(merged, daySessionForTicker(input.ticker));
    if (refusal != null) return { ok: false, error: refusal };
  }
  return { ok: true, values: values as ParamValues };
}
