/**
 * Settings outside a playbook's calibration list, for the two research
 * surfaces that may run them: *Try settings* and the backtest CLI under
 * `--explore`. Browser-safe, so the form and the command refuse in one voice.
 *
 * **Which values count is decided by the values, never by a flag.** A select
 * that declares `explore` and holds a value its options do not list is off the
 * calibration, and so is a number that declares `calibrated` and holds a value
 * outside that band; the run header records that list and *Export settings* adds
 * `--explore` from it, so a research run is identifiable afterwards whichever
 * flags were typed — the reasoning the header's `calibratedFor` and
 * `sizing.maxContracts` already carry.
 */
import type {
  ExploreDomain,
  MainSession,
  ParamSchema,
  ParamValues,
  SelectParam,
} from "./strategy-types";
import { collectSessionWindows, parseHHMM, pausesOverlap } from "./session/session";
import type { TimeWindowFilterParams } from "./filters";

/** A select whose options are a calibration list over an open domain. */
export function isExplorable(param: ParamSchema): param is SelectParam & { explore: ExploreDomain } {
  return param.type === "select" && param.explore != null;
}

/** How a number param spells a `rangeOrOff` constant's off: a param value cannot be null. */
export const CALIBRATED_OFF_VALUE = 0;

/**
 * True when `value` is outside the param's calibration: not one of an
 * explorable select's options, or outside a calibrated number's band (its off
 * value, for a `rangeOrOff` constant, is a calibrated cell).
 */
export function isOffCalibration(param: ParamSchema, value: unknown): boolean {
  if (param.type === "number" || param.type === "integer") {
    const band = param.calibrated;
    if (band == null) return false;
    const n = Number(value);
    if (band.kind === "rangeOrOff" && n === CALIBRATED_OFF_VALUE) return false;
    return !(n >= band.min && n <= band.max);
  }
  if (!isExplorable(param)) return false;
  return !param.options.some((o) => o.value === String(value));
}

/** The keys whose value is outside the playbook's calibration, in schema order. */
export function offCalibrationKeys(
  schema: Record<string, ParamSchema>,
  params: ParamValues,
): string[] {
  return Object.entries(schema)
    .filter(([key, param]) => key in params && isOffCalibration(param, params[key]))
    .map(([key]) => key);
}

/**
 * Why `raw` is not a value of `domain`, or null when it is. Subject-neutral, so
 * the form says it beside the setting's label and the CLI after `--set key:`.
 */
export function exploreValueRefusal(domain: ExploreDomain, raw: string): string | null {
  if (domain.type === "time") {
    return parseHHMM(raw) == null ? `"${raw}" is not a clock time. Use HH:MM, 24-hour, ET.` : null;
  }
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return `"${raw}" is not a number.`;
  if (domain.type === "integer" && !Number.isInteger(n)) return `"${raw}" must be a whole number.`;
  if (domain.min != null && n < domain.min) return `"${raw}" must be ${domain.min} or more.`;
  if (domain.exclusiveMin != null && n <= domain.exclusiveMin) {
    return `"${raw}" must be above ${domain.exclusiveMin}.`;
  }
  if (domain.max != null && n > domain.max) return `"${raw}" must be ${domain.max} or less.`;
  return null;
}

/** The first off-calibration value the hooks cannot take, as `Label: reason`. */
export function offCalibrationRefusal(
  schema: Record<string, ParamSchema>,
  params: ParamValues,
): string | null {
  for (const key of offCalibrationKeys(schema, params)) {
    const param = schema[key];
    if (!isExplorable(param)) continue;
    const refusal = exploreValueRefusal(param.explore, String(params[key]));
    if (refusal != null) return `${param.label}: ${refusal}`;
  }
  return null;
}

/**
 * The time-of-day window filter set to a window the playbook's own session
 * never reaches. The filter narrows the session and never widens it, so such a
 * run takes no entry and reads as a playbook that found no signals. The CLI
 * refuses it before reading a bar and appends its own clause; the form refuses
 * it before Run.
 */
export function timeWindowOutsideSessionRefusal(
  playbookKey: string,
  session: MainSession | undefined,
  params: ParamValues,
): string | null {
  // The cast `runBacktest` makes on the same object: the filter registry
  // declares these keys and registration enforces the shape.
  const filter = params as unknown as TimeWindowFilterParams;
  if (filter.timeWindowEnabled !== true) return null;

  const requested = { start: filter.timeWindowStartEt, end: filter.timeWindowEndEt };
  const windows = collectSessionWindows(session, params);
  if (windows.some((window) => pausesOverlap(window, requested))) return null;

  const named = windows.map((w) => `${w.start}-${w.end}`).join(", ");
  return (
    `The time-of-day window ${requested.start}-${requested.end} ET never overlaps ` +
    `"${playbookKey}"'s session ${named} ET, so the run would take no entry. The window narrows ` +
    `the playbook's own session and never widens it: set one inside ${named} ET, or turn it off.`
  );
}
