/**
 * The six lookback variants the validation study registered, one step either
 * side of each of v1's three windows, plus the three-tier `vol` read.
 *
 * They live in their own module because two callers need them and one of
 * them is the flag parser: a variant with a longer baseline needs a longer
 * warmup, and comparing it against the base label over sessions it could not
 * classify would measure the warmup rather than the classifier.
 *
 * Every one of them is **reported, never selected.**
 */
import {
  CLASSIFIER_PARAMS_V1,
  warmupSessionDaysFor,
  type ClassifierParams,
} from "@/lib/trading/regime/classify-regime";

export interface Perturbation {
  name: string;
  params: ClassifierParams;
}

export const PERTURBATIONS: readonly Perturbation[] = [
  { name: "vol5Len=3", params: { ...CLASSIFIER_PARAMS_V1, vol5Len: 3 } },
  { name: "vol5Len=7", params: { ...CLASSIFIER_PARAMS_V1, vol5Len: 7 } },
  { name: "baselineLen=200", params: { ...CLASSIFIER_PARAMS_V1, baselineLen: 200 } },
  { name: "baselineLen=300", params: { ...CLASSIFIER_PARAMS_V1, baselineLen: 300 } },
  { name: "rangeMedianLen=15", params: { ...CLASSIFIER_PARAMS_V1, rangeMedianLen: 15 } },
  { name: "rangeMedianLen=25", params: { ...CLASSIFIER_PARAMS_V1, rangeMedianLen: 25 } },
];

/** The monotonicity read: three `vol` tiers at the 33rd and 67th percentiles. */
export const THREE_TIER_PARAMS: ClassifierParams = {
  ...CLASSIFIER_PARAMS_V1,
  volTiers: [33, 67],
};

/** The widest variant's need — what `--perturb` has to warm up to. */
export const PERTURB_WARMUP_SESSION_DAYS = Math.max(
  ...PERTURBATIONS.map((p) => warmupSessionDaysFor(p.params)),
  warmupSessionDaysFor(THREE_TIER_PARAMS),
);
