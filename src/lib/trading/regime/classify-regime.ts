/**
 * `classifyRegime` v1 — the day-ahead regime label, from bars and nothing
 * else.
 *
 * **The label is for session `d+1` and every feature reads sessions `≤ d`.**
 * `targetIndex` names the session being labelled, so the classifier reads
 * `days[targetIndex − 1]` and earlier and never touches `days[targetIndex]`
 * — that is what makes a label computable the evening before, and what a
 * test pins by mutating the target day and asserting the label does not
 * move.
 *
 * Two binary axes, four cells, per the taxonomy in
 * `docs/proposals/regime-playbooks.md` §*The regime label*; the evidence is
 * in `docs/strategies/research/regimes.md`. Both cutoffs are quantiles of
 * trailing windows, so **the classifier has no fitted parameter and cannot
 * be tuned to a test period**.
 *
 * `unknown` when the trailing windows are not full — it fails closed, and a
 * playbook in `auto` stands down rather than trading on a label built from
 * half a baseline.
 */
import type { SessionDay } from "./session-days";

export const CLASSIFIER_VERSION = "1";

export const UNKNOWN_LABEL = "unknown";

export type VolTier = "quiet" | "normal" | "active";
export type RangeAxis = "compressed" | "expanded";

export const REGIME_CELLS = [
  "quiet.compressed",
  "quiet.expanded",
  "active.compressed",
  "active.expanded",
] as const;
export type RegimeCell = (typeof REGIME_CELLS)[number];

export function isRegimeCell(value: string): value is RegimeCell {
  return (REGIME_CELLS as readonly string[]).includes(value);
}

export interface RegimeFeatures {
  /** Mean day-session true range over the last `vol5Len` sessions, in ticks. */
  vol5: number;
  /** Percentile rank of `vol5` within its own trailing baseline, 0–100. */
  vol5Pct: number;
  /** Day-session range of session `d`, in ticks. */
  rthRange: number;
  /** `rthRange[d]` over the median of the prior `rangeMedianLen` ranges. */
  rangeRatio: number;
}

export interface RegimeResult {
  /** `<vol>.<range>`, or `"unknown"`. */
  label: string;
  vol: VolTier | null;
  range: RangeAxis | null;
  classifierVersion: string;
  /** Null exactly when the label is `unknown`: a partial feature set is a
   *  number someone will read as a measurement. */
  features: RegimeFeatures | null;
}

export interface ClassifierParams {
  vol5Len: number;
  baselineLen: number;
  rangeMedianLen: number;
  /** Percentile cuts for the `vol` axis. One cut is the v1 two-tier axis;
   *  two are the monotonicity variant, which is reported and never selected. */
  volTiers: readonly number[];
}

/** v1, pre-registered. Changing any of these is a new `CLASSIFIER_VERSION`. */
export const CLASSIFIER_PARAMS_V1: ClassifierParams = {
  vol5Len: 5,
  baselineLen: 250,
  rangeMedianLen: 20,
  volTiers: [50],
};

/**
 * Completed session days of history a parameter set needs before it can
 * answer anything but `unknown`: the `vol` baseline, plus the range median,
 * plus the `vol5` window the oldest baseline sample itself reads.
 *
 * It lives with the params rather than with either caller because it is a
 * property of the classifier, and the two callers — the CLI's warmup floor
 * and the engine's nightly fetch — have to size the same window or one of
 * them classifies on a baseline the other refused.
 */
export function warmupSessionDaysFor(params: ClassifierParams): number {
  return params.baselineLen + params.rangeMedianLen + params.vol5Len;
}

/** v1's own need: 275 completed session days. */
export const CLASSIFIER_WARMUP_SESSION_DAYS = warmupSessionDaysFor(CLASSIFIER_PARAMS_V1);

/**
 * Completed session days below which no label is possible even over a
 * gapless series — the **cliff**, as against the window `warmupSessionDaysFor`
 * sizes a *fetch* with.
 *
 * `volBaseline` ends at `d = targetIndex − 1` and reaches back to
 * `d − baselineLen − vol5Len + 2`; `days[0].rthTR` is null for want of a
 * prior close, so that index has to land at 1 or later, which is
 * `targetIndex ≥ baselineLen + vol5Len`. The `rangeMedianLen` term the
 * warmup carries is slack against it.
 *
 * It exists for diagnostics, not for sizing: a line that reports a count
 * against the warmup reads as short at counts that would have labelled.
 * **Do not fetch against this number** — a window with no slack has no room
 * for the holidays and dropped expiries that thin a session series.
 */
export function minSessionDaysFor(params: ClassifierParams): number {
  return params.baselineLen + params.vol5Len;
}

/** v1's own cliff: 255 completed session days. */
export const CLASSIFIER_MIN_SESSION_DAYS = minSessionDaysFor(CLASSIFIER_PARAMS_V1);

const RANGE_EXPANDED_RATIO = 1.0;
const PERCENT = 100;

/** Tier names by cut count. Anything else is a caller error, not a variant. */
const TIER_NAMES: Readonly<Record<number, readonly VolTier[]>> = {
  1: ["quiet", "active"],
  2: ["quiet", "normal", "active"],
};

export function classifyRegime(days: SessionDay[], targetIndex: number): RegimeResult {
  return classifyWithParams(days, targetIndex, CLASSIFIER_PARAMS_V1);
}

/**
 * The same classifier with the lookbacks and cuts exposed, for the
 * perturbation study's six variants and the three-tier monotonicity report.
 * `labels --perturb` is its only caller; nothing selects a variant.
 */
export function classifyWithParams(
  days: SessionDay[],
  targetIndex: number,
  params: ClassifierParams,
): RegimeResult {
  const names = TIER_NAMES[params.volTiers.length];
  if (!names) {
    throw new Error(
      `classifyWithParams: ${params.volTiers.length} volatility cuts has no tier naming; 1 or 2`,
    );
  }

  const d = targetIndex - 1;
  if (d < 0 || d >= days.length) return unknownRegime();

  const baseline = volBaseline(days, d, params);
  const priorRanges = rangeWindow(days, d, params.rangeMedianLen);
  if (baseline == null || priorRanges == null) return unknownRegime();

  const priorMedian = median(priorRanges);
  if (!(priorMedian > 0)) return unknownRegime();

  const vol5 = baseline[baseline.length - 1];
  const vol5Pct = percentileRank(baseline, vol5);
  const rthRange = days[d].rthRange;
  const rangeRatio = rthRange / priorMedian;

  const vol = tierOf(vol5Pct, params.volTiers, names);
  const range: RangeAxis = rangeRatio >= RANGE_EXPANDED_RATIO ? "expanded" : "compressed";

  return {
    label: `${vol}.${range}`,
    vol,
    range,
    classifierVersion: CLASSIFIER_VERSION,
    features: { vol5, vol5Pct, rthRange, rangeRatio },
  };
}

/**
 * The fail-closed answer. Exported because a caller that could not *reach* the
 * bars owes the same row a caller that read short ones does — a written
 * `unknown` is what a later fill heals, and an unwritten day is silence.
 */
export function unknownRegime(): RegimeResult {
  return {
    label: UNKNOWN_LABEL,
    vol: null,
    range: null,
    classifierVersion: CLASSIFIER_VERSION,
    features: null,
  };
}

/**
 * The `baselineLen` trailing `vol5` values ending at `d`, oldest first, or
 * null when the window is not full.
 *
 * A gap anywhere in it — a missing session, or the first row, which has no
 * prior close and therefore no true range — is `unknown` rather than a mean
 * over whatever survived.
 */
function volBaseline(
  days: SessionDay[],
  d: number,
  params: ClassifierParams,
): number[] | null {
  const out: number[] = [];
  for (let i = d - params.baselineLen + 1; i <= d; i++) {
    const value = meanTrueRange(days, i, params.vol5Len);
    if (value == null) return null;
    out.push(value);
  }
  return out.length === params.baselineLen ? out : null;
}

/** `mean(rthTR[i−len+1 .. i])`, or null if any of them is missing. */
function meanTrueRange(days: SessionDay[], i: number, len: number): number | null {
  if (i - len + 1 < 0 || i >= days.length) return null;
  let total = 0;
  for (let k = i - len + 1; k <= i; k++) {
    const tr = days[k].rthTR;
    if (tr == null) return null;
    total += tr;
  }
  return total / len;
}

/** The `len` day-session ranges **before** `d` — the median this compares
 *  against deliberately excludes the day being measured. */
function rangeWindow(days: SessionDay[], d: number, len: number): number[] | null {
  if (d - len < 0) return null;
  const out: number[] = [];
  for (let i = d - len; i <= d - 1; i++) out.push(days[i].rthRange);
  return out;
}

/**
 * Weak percentile rank: the share of the window at or below `value`, times
 * 100. `value` is a member of `window`, so the result is in (0, 100]; the
 * cutoff comparison is `≥`, which puts an exact 50 in the upper tier.
 */
export function percentileRank(window: number[], value: number): number {
  let atOrBelow = 0;
  for (const x of window) if (x <= value) atOrBelow++;
  return (atOrBelow * PERCENT) / window.length;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tierOf(
  percentile: number,
  cuts: readonly number[],
  names: readonly VolTier[],
): VolTier {
  let tier = 0;
  for (const cut of cuts) if (percentile >= cut) tier++;
  return names[tier];
}
