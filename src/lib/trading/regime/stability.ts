/**
 * Label-stability metrics — Part 1 of the validation study, computed on the
 * label series alone with no trades in sight.
 *
 * The registered bars are in the proposal, not here: persistence on the
 * `vol` axis (lag-1 autocorrelation ≥ 0.6, equivalently a flip rate ≤ 20%),
 * and ≥ 85% day-level agreement against every perturbed variant. This module
 * produces the numbers; `labels` prints them against those bars.
 */

/**
 * Lag-1 autocorrelation of a 0/1 indicator series, the standard biased
 * estimator: `n−1` cross-products over `n` squared deviations, one mean for
 * both terms. It is what "lag-1 autocorrelation" means without
 * qualification, and its small bias toward zero is the conservative
 * direction for a threshold the label has to clear.
 *
 * A series that never changes has zero variance and no defined correlation;
 * it comes back as **1**, because a label that is the same every day is
 * perfectly persistent, which is what the metric is being asked. Fewer than
 * two samples is 0 — there is no pair to correlate.
 */
export function lag1Autocorrelation(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < values.length; i++) {
    const centred = values[i] - mean;
    variance += centred * centred;
    if (i > 0) covariance += (values[i - 1] - mean) * centred;
  }
  if (variance === 0) return 1;
  return covariance / variance;
}

/** Share of consecutive pairs whose value changed. 0 for fewer than two. */
export function flipRate<T>(values: readonly T[]): number {
  if (values.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) flips++;
  return flips / (values.length - 1);
}

/**
 * Day-level agreement between two label series of the same length — the
 * perturbation test's number. Different lengths are a caller error: the
 * series are two readings of the same days.
 */
export function agreement<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length !== b.length) {
    throw new Error(`agreement: series differ in length (${a.length} vs ${b.length})`);
  }
  if (a.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** The `active` indicator as 0/1, for the persistence metric. */
export function activeIndicator(vols: readonly (string | null)[]): number[] {
  return vols.map((v) => (v === "active" ? 1 : 0));
}
