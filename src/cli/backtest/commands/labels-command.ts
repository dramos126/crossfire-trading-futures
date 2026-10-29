/**
 * `labels` — the classifier's own output, with no playbook in sight.
 *
 * One row per session day in the range plus the stability metrics the
 * validation study's Part 1 scores the taxonomy on. `--perturb` adds the six
 * registered lookback variants and the three-tier `vol` read; every one of
 * them is **reported and never selected** — choosing a lookback by its
 * output is the curve-fitting the whole classifier design exists to avoid.
 */
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import type { RegimeFeatures, VolTier } from "@/lib/trading/regime/classify-regime";
import type { SessionDay } from "@/lib/trading/regime/session-days";
import {
  activeIndicator,
  agreement,
  flipRate,
  lag1Autocorrelation,
} from "@/lib/trading/regime/stability";
import type { CliArgs } from "../args";
import { loadRunBars } from "../bars";
import type { CpuThrottle } from "../throttle";
import { buildHeader, resolveOutDir, writeJson, writeJsonl } from "../output";
import { PERTURBATIONS, THREE_TIER_PARAMS } from "../perturbations";
import { buildLabelIndex, labelDistribution, type LabelIndex } from "../regime-labels";

interface LabelRow {
  sessionDate: string;
  label: string;
  features: RegimeFeatures | null;
  /** `--perturb` only: each variant's label for this session. */
  variants?: Record<string, string>;
  /** `--perturb` only: the three-tier `vol` read. */
  volTier?: VolTier | null;
}

export interface AxisStability {
  vol: { lag1Autocorr: number; flipRate: number };
  range: { flipRate: number };
}

export interface PerturbationRow {
  name: string;
  /** Over `comparedDays` only — see `perturbationTable`. */
  agreement: number;
  comparedDays: number;
  excludedDays: number;
}

const UNKNOWN = "unknown";

export async function labelsCommand(args: CliArgs, throttle: CpuThrottle): Promise<string> {
  const spec = CONTRACT_SPECS[args.ticker];
  const outDir = resolveOutDir(args);
  const { loaded, warmupFrom } = await loadRunBars({ args, spec, barSymbol: args.barSymbol });

  const base = buildLabelIndex(loaded.sessionDays);
  const inRange = sessionsIn(loaded.sessionDays, args.from, args.to);
  const rows = inRange.map((sessionDate) => baseRow(base, sessionDate));

  const perturbation = args.perturb
    ? perturbationTable(loaded.sessionDays, inRange, rows)
    : null;

  const stability = axisStability(base, inRange);
  const distribution = labelDistribution(base, inRange);
  await writeJsonl(outDir, "labels.jsonl", rows);
  await writeJson(outDir, "labels.json", {
    header: buildHeader({
      args,
      spec,
      playbookVersion: null,
      paramSchema: null,
      calibratedFor: null,
      warmupFrom,
      barCount: loaded.bars.length,
      sessionCount: inRange.length,
      firstBarTs: loaded.bars.length > 0 ? loaded.bars[0].timestamp : null,
      lastBarTs: loaded.bars.length > 0 ? loaded.bars[loaded.bars.length - 1].timestamp : null,
      cacheFiles: loaded.cacheFiles,
      resolvedParams: {},
      cpu: throttle.report(),
    }),
    sessionCount: inRange.length,
    labelDistribution: distribution,
    axisStability: stability,
    perturbation,
  });

  process.stdout.write(report(inRange.length, distribution, stability, perturbation));
  return outDir;
}

function baseRow(index: LabelIndex, sessionDate: string): LabelRow {
  const result = index.get(sessionDate);
  return {
    sessionDate,
    label: result?.label ?? UNKNOWN,
    features: result?.features ?? null,
  };
}

/**
 * Each variant's day-level agreement with the base label, and the three-tier
 * `vol` read stamped onto every row. The rows are mutated in place because
 * the variants are columns of the same table, not a second file.
 *
 * **Agreement is measured over the days both sides could label.** A variant
 * with a longer baseline is `unknown` where the base is not, and counting
 * those as disagreements scores the warmup rather than the classifier — so
 * an `unknown` on either side is excluded and the two counts are reported
 * beside the rate.
 */
function perturbationTable(
  days: SessionDay[],
  inRange: string[],
  rows: LabelRow[],
): PerturbationRow[] {
  const baseLabels = rows.map((r) => r.label);
  const table: PerturbationRow[] = [];

  for (const variant of PERTURBATIONS) {
    const index = buildLabelIndex(days, variant.params);
    const labels = inRange.map((d) => index.get(d)?.label ?? UNKNOWN);
    table.push({ name: variant.name, ...agreementOverLabelled(baseLabels, labels) });
    rows.forEach((row, i) => {
      row.variants = { ...(row.variants ?? {}), [variant.name]: labels[i] };
    });
  }

  const tiers = buildLabelIndex(days, THREE_TIER_PARAMS);
  rows.forEach((row) => {
    row.volTier = tiers.get(row.sessionDate)?.vol ?? null;
  });
  return table;
}

/**
 * Agreement over the days **both** series could label, with the excluded
 * count beside it. A day one side calls `unknown` is a day the two were
 * never asked the same question on; counting it as a disagreement measures
 * the longer window's warmup.
 */
export function agreementOverLabelled(
  base: readonly string[],
  variant: readonly string[],
): Omit<PerturbationRow, "name"> {
  const comparable = base
    .map((label, i) => [label, variant[i]] as const)
    .filter(([a, b]) => a !== UNKNOWN && b !== UNKNOWN);
  return {
    agreement: agreement(
      comparable.map(([a]) => a),
      comparable.map(([, b]) => b),
    ),
    comparedDays: comparable.length,
    excludedDays: base.length - comparable.length,
  };
}

function axisStability(index: LabelIndex, inRange: string[]): AxisStability {
  const vols = inRange.map((d) => index.get(d)?.vol ?? null);
  const ranges = inRange.map((d) => index.get(d)?.range ?? null);
  return {
    vol: {
      lag1Autocorr: lag1Autocorrelation(activeIndicator(vols)),
      flipRate: flipRate(vols),
    },
    range: { flipRate: flipRate(ranges) },
  };
}

function sessionsIn(days: SessionDay[], from: string, to: string): string[] {
  return days
    .map((d) => d.sessionDate)
    .filter((sessionDate) => sessionDate >= from && sessionDate <= to);
}

const DECIMALS = 3;

function report(
  sessionCount: number,
  distribution: Record<string, number>,
  stability: AxisStability,
  perturbation: PerturbationRow[] | null,
): string {
  const lines = [`sessions: ${sessionCount}`, "", "label distribution"];
  for (const [label, n] of Object.entries(distribution).sort()) {
    lines.push(`  ${label.padEnd(20)} ${n}`);
  }
  lines.push(
    "",
    "axis stability",
    `  vol   lag1Autocorr ${stability.vol.lag1Autocorr.toFixed(DECIMALS)}  flipRate ${stability.vol.flipRate.toFixed(DECIMALS)}`,
    `  range flipRate     ${stability.range.flipRate.toFixed(DECIMALS)}`,
  );
  if (perturbation) {
    lines.push(
      "",
      "perturbation agreement vs base (over days both could label)",
      "  variant              agreement  compared  excluded",
    );
    for (const row of perturbation) {
      lines.push(
        `  ${row.name.padEnd(20)} ${row.agreement.toFixed(DECIMALS).padStart(9)} ` +
          `${String(row.comparedDays).padStart(9)} ${String(row.excludedDays).padStart(9)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
