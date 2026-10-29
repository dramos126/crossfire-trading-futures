/**
 * `walk-forward` — rolling folds, an optional sweep on each training
 * window, held-out results per fold.
 *
 * Two guards are the point of the command rather than decoration. The grid
 * is capped at two keys and 25 points, and **no fold is swept whose
 * training window carries fewer than 100 trades at base constants** — a
 * best-of-25 over thirty trades is noise wearing a number, and the refusal
 * is loud because the alternative is a plausible-looking constant set.
 */
import { CONTRACT_SPECS, type ContractSpec } from "@/lib/trading/contracts/contract-specs";
import type { StrategyModule } from "@/lib/trading/strategy-types";
import type { BacktestTrade } from "@/lib/trading/backtest";
import type { BarData } from "@/lib/brokers/types";
import type { CliArgs, Objective, SweepAxis } from "../args";
import { sweepAxisPoints } from "../args";
import { loadRunBars } from "../bars";
import { CliError } from "../cli-error";
import { buildFolds, type Fold, type FoldWindow } from "../folds";
import { buildHeader, resolveOutDir, writeJson, writeJsonl } from "../output";
import { resolveFullParams, resolveParamOverrides, sizingFromArgs } from "../params";
import { buildLabelIndex, type LabelIndex } from "../regime-labels";
import { runWindow, type WindowResult } from "../run-window";
import type { CpuThrottle } from "../throttle";
import type { WindowJob, WindowPool } from "../worker-pool";
import { buildSummary, type CliSummary } from "../summary";
import type { SessionRecord } from "../sessions";
import { appendSkips, skipTruncationWarning, type CliSkipRecord } from "../skip-record";
import type { CliTradeRecord, FoldSample } from "@/lib/trading/backtest-trade-record";

const MIN_TRAINING_TRADES_TO_SWEEP = 100;

export interface FoldReport {
  foldId: number;
  train: FoldWindow;
  test: FoldWindow;
  constantsPicked: Record<string, number>;
  /** Null when the training window was never run — the no-sweep default.
   *  The header's `walkForward.inSample` says which it was. */
  inSample: CliSummary | null;
  outOfSample: CliSummary;
  /** OOS expectancy over IS expectancy. Null unless the training window ran
   *  and its expectancy is positive — degradation is measured against
   *  something the training window earned, and a ratio against zero or a
   *  loss is a division rather than a measurement. */
  walkForwardEfficiency: number | null;
}

export async function walkForwardCommand(
  args: CliArgs,
  strategy: StrategyModule,
  throttle: CpuThrottle,
  pool: WindowPool,
): Promise<string> {
  const spec = CONTRACT_SPECS[args.ticker];
  const folds = buildFolds({
    from: args.from,
    to: args.to,
    trainMonths: args.train,
    testMonths: args.test,
    stepMonths: args.step,
  });
  if (folds.length === 0) {
    throw new CliError(
      `${args.from}..${args.to} is too short for ${args.train}m train + ${args.test}m test. ` +
        `Widen the range or shorten the windows.`,
    );
  }

  const outDir = resolveOutDir(args);
  // A sweep moves numbers only, never the session or pause windows, so the
  // base constants name every bar any grid point flattens inside.
  const { loaded, warmupFrom } = await loadRunBars({
    args,
    spec,
    barSymbol: args.barSymbol,
    straddleLegs: [{ strategy, paramOverrides: resolveParamOverrides(strategy, args) }],
  });
  const labels = args.usesClassifier ? buildLabelIndex(loaded.sessionDays) : null;

  const grid = sweepGrid(args.sweep);
  const reports: FoldReport[] = [];
  const allRecords: CliTradeRecord[] = [];
  // The same in-sample-plus-test set `trades.jsonl` carries, and from the
  // winning grid point only — a losing sweep point's skips describe constants
  // no fold went on to trade. Capped across the whole command, not per fold:
  // twelve folds under a per-fold cap is twelve times the bound.
  const allSkips: CliSkipRecord[] = [];
  let skipsDropped = 0;
  const pooledTrades: BacktestTrade[] = [];
  const pooledRecords: CliTradeRecord[] = [];
  const pooledSessions: SessionRecord[] = [];
  let nextTradeId = 1;

  for (const fold of folds) {
    let constantsPicked: Record<string, number> = {};
    // Without a sweep there is nothing to pick on the training window, so
    // running it is a second pass over base constants for a comparison
    // nobody asked for — half the work of the whole command.
    let inSample: WindowResult | null = null;
    if (grid.length > 0) {
      const base = await window(args, strategy, spec, loaded.bars, fold.train, {
        foldId: fold.foldId,
        sample: "train",
        tradeIdStart: nextTradeId,
        labels,
        subBars: loaded.subBars,
        onProgress: throttle.onProgress,
      });
      assertSweepable(fold, base.records.length);
      const best = await pickBest(args, strategy, spec, loaded.bars, fold, grid, nextTradeId, labels, pool, loaded.subBars);
      constantsPicked = best.constants;
      inSample = best.window;
    } else if (args.inSample) {
      inSample = await window(args, strategy, spec, loaded.bars, fold.train, {
        foldId: fold.foldId,
        sample: "train",
        tradeIdStart: nextTradeId,
        labels,
        subBars: loaded.subBars,
        onProgress: throttle.onProgress,
      });
    }
    if (inSample) nextTradeId += inSample.records.length;

    const outOfSample = await window(args, strategy, spec, loaded.bars, fold.test, {
      foldId: fold.foldId,
      sample: "test",
      tradeIdStart: nextTradeId,
      labels,
      subBars: loaded.subBars,
      onProgress: throttle.onProgress,
      sweepValues: constantsPicked,
    });
    nextTradeId += outOfSample.records.length;

    if (inSample) allRecords.push(...inSample.records);
    allRecords.push(...outOfSample.records);
    if (inSample) skipsDropped += appendSkips(allSkips, inSample.skips);
    skipsDropped += appendSkips(allSkips, outOfSample.skips);
    pooledTrades.push(...outOfSample.keptBacktestTrades);
    pooledRecords.push(...outOfSample.records);
    pooledSessions.push(...outOfSample.sessions);
    reports.push({
      foldId: fold.foldId,
      train: fold.train,
      test: fold.test,
      constantsPicked,
      inSample: inSample?.summary ?? null,
      outOfSample: outOfSample.summary,
      walkForwardEfficiency: inSample
        ? efficiencyOf(inSample.summary, outOfSample.summary)
        : null,
    });
  }

  await writeJson(outDir, "folds.json", {
    header: buildHeader({
      args,
      spec,
      playbookVersion: strategy.version,
      paramSchema: strategy.params,
      calibratedFor: strategy.config.calibratedFor ?? null,
      warmupFrom,
      barCount: loaded.bars.length,
      sessionCount: pooledSessions.length,
      firstBarTs: loaded.bars.length > 0 ? loaded.bars[0].timestamp : null,
      lastBarTs: loaded.bars.length > 0 ? loaded.bars[loaded.bars.length - 1].timestamp : null,
      cacheFiles: loaded.cacheFiles,
      // Base constants, fully resolved: the per-fold picks live on each fold
      // report, and a header claiming one of them would misdescribe every
      // other fold.
      resolvedParams: resolveFullParams(strategy, args),
      cpu: throttle.report(),
    }),
    folds: reports,
    pooledOutOfSample: buildSummary({
      records: pooledRecords,
      backtestTrades: pooledTrades,
      sessions: pooledSessions,
    }),
  });
  await writeJsonl(outDir, "trades.jsonl", allRecords);
  await writeJsonl(outDir, "skips.jsonl", allSkips);
  // stderr rather than a `warnings` key: `folds.json` has none, and inventing
  // one for this alone is an output-shape change for a diagnostic.
  if (skipsDropped > 0) process.stderr.write(`${skipTruncationWarning(skipsDropped)}\n`);

  return outDir;
}

export function efficiencyOf(inSample: CliSummary, outOfSample: CliSummary): number | null {
  if (!(inSample.expectancyR > 0)) return null;
  return outOfSample.expectancyR / inSample.expectancyR;
}

interface WindowOptions {
  foldId: number;
  sample: FoldSample;
  tradeIdStart: number;
  labels: LabelIndex | null;
  subBars?: BarData[];
  sweepValues?: Record<string, number>;
}

async function window(
  args: CliArgs,
  strategy: StrategyModule,
  spec: ContractSpec,
  allBars: BarData[],
  bounds: FoldWindow,
  opts: WindowOptions & { onProgress: () => Promise<void> },
): Promise<WindowResult> {
  return runWindow({
    ...windowJob(args, strategy, spec, bounds, opts),
    strategy,
    allBars,
    subBars: opts.subBars,
    labels: opts.labels,
    onProgress: opts.onProgress,
  });
}

function windowJob(
  args: CliArgs,
  strategy: StrategyModule,
  spec: ContractSpec,
  bounds: FoldWindow,
  opts: Omit<WindowOptions, "labels">,
): WindowJob {
  return {
    from: bounds.from,
    to: bounds.to,
    warmupDays: args.warmupDays,
    tickSize: spec.tickSize,
    tickValue: spec.tickValue,
    daySession: spec.daySession,
    feePerSideUsd: args.fees ? spec.feePerSide : 0,
    paramOverrides: resolveParamOverrides(strategy, args, opts.sweepValues ?? {}),
    sizing: sizingFromArgs(args),
    dailyLossUsd: args.dailyLossUsd,
    dailyProfitUsd: args.dailyProfitUsd,
    foldId: opts.foldId,
    sample: opts.sample,
    tradeIdStart: opts.tradeIdStart,
    regimes: args.regimes,
  };
}

export interface SweepPick {
  constants: Record<string, number>;
  window: WindowResult;
}

/**
 * Every grid point on the fold's training window, through the pool. All of
 * them take the same `tradeIdStart`, so they are independent and the order
 * they finish in is irrelevant: the pool hands them over in grid order and
 * they are judged as they arrive, which keeps `isBetter`'s tie rule — the
 * first grid point wins — whatever the worker count. Only the incumbent is
 * kept; a grid point's full result (records, sessions, up to the skip cap)
 * is dropped the moment it loses.
 */
export async function pickBest(
  args: CliArgs,
  strategy: StrategyModule,
  spec: ContractSpec,
  allBars: BarData[],
  fold: Fold,
  grid: Array<Record<string, number>>,
  tradeIdStart: number,
  labels: LabelIndex | null,
  pool: WindowPool,
  subBars?: BarData[],
): Promise<SweepPick> {
  // A holder, not a `let`: the callback assigns it, and narrowing would read
  // a `let` as still `null` after the await.
  const incumbent: { best: SweepPick | null } = { best: null };
  await pool.run(
    { strategy, allBars, subBars, labels },
    grid.map((constants) => ({
      label: `fold ${fold.foldId} sweep ${JSON.stringify(constants)}`,
      job: windowJob(args, strategy, spec, fold.train, {
        foldId: fold.foldId,
        sample: "train",
        tradeIdStart,
        sweepValues: constants,
      }),
    })),
    (i, candidate) => {
      // A zero-trade candidate has no expectancy, a zero drawdown and a zero
      // profit factor, so it wins `maxDrawdownR` outright and ties everything
      // else — the grid point that traded nothing is the last one that should
      // be carried into the held-out window.
      if (candidate.records.length === 0) return;
      const { best } = incumbent;
      if (best === null || isBetter(args.objective, candidate.summary, best.window.summary)) {
        incumbent.best = { constants: grid[i], window: candidate };
      }
    },
  );
  const { best } = incumbent;
  if (best === null) {
    throw new CliError(
      `Fold ${fold.foldId} (${fold.train.from}..${fold.train.to}): every one of the ` +
        `${grid.length} sweep points produced zero training trades. Widen the grid or the ` +
        `training window.`,
    );
  }
  return best;
}

export function isBetter(
  objective: Objective,
  candidate: CliSummary,
  incumbent: CliSummary,
): boolean {
  switch (objective) {
    case "expectancyR":
      return candidate.expectancyR > incumbent.expectancyR;
    case "netDollars":
      return candidate.totalPnlDollars > incumbent.totalPnlDollars;
    case "profitFactor":
      return candidate.profitFactor > incumbent.profitFactor;
    case "maxDrawdownR":
      return candidate.maxDrawdownR < incumbent.maxDrawdownR;
  }
}

export function sweepGrid(axes: SweepAxis[]): Array<Record<string, number>> {
  if (axes.length === 0) return [];
  let grid: Array<Record<string, number>> = [{}];
  for (const axis of axes) {
    const next: Array<Record<string, number>> = [];
    for (const point of sweepAxisPoints(axis)) {
      for (const partial of grid) next.push({ ...partial, [axis.key]: point });
    }
    grid = next;
  }
  return grid;
}

export function assertSweepable(fold: Fold, trainingTrades: number): void {
  if (trainingTrades >= MIN_TRAINING_TRADES_TO_SWEEP) return;
  throw new CliError(
    `Fold ${fold.foldId} (${fold.train.from}..${fold.train.to}) has ${trainingTrades} training ` +
      `trades at base constants; the sweep floor is ${MIN_TRAINING_TRADES_TO_SWEEP}. ` +
      `Widen the training window or run without --sweep.`,
  );
}

export { MIN_TRAINING_TRADES_TO_SWEEP };
