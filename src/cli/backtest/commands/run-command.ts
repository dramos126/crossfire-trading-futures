/**
 * `run` — one backtest over one range, the building block the trader
 * calibrates against.
 */
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import type { ParamValues, StrategyModule } from "@/lib/trading/strategy-types";
import type { CliArgs } from "../args";
import { loadRunBars, type BarTailInput, type LoadedBars } from "../bars";
import { buildHeader, resolveOutDir, writeJson, writeJsonl } from "../output";
import { resolveParamOverrides, sizingFromArgs } from "../params";
import { buildLabelIndex, labelDistribution } from "../regime-labels";
import { runWindow, type WindowResult } from "../run-window";
import type { CpuThrottle } from "../throttle";
import { openTopstepTail } from "../topstep-tail";

export async function runCommand(
  args: CliArgs,
  strategy: StrategyModule,
  throttle: CpuThrottle,
): Promise<string> {
  const tail = args.topstepTail ? await openTopstepTail() : null;
  const tailInput =
    tail == null ? null : { contractId: await tail.contractId(args.ticker), chain: tail.chain };
  const { outDir } = await runOnce({
    args,
    strategy,
    throttle,
    paramOverrides: resolveParamOverrides(strategy, args),
    tail: tailInput,
  });
  return outDir;
}

export interface RunOnceInput {
  args: CliArgs;
  strategy: StrategyModule;
  throttle: CpuThrottle;
  paramOverrides: ParamValues;
  tail: BarTailInput | null;
  /** Called on the loaded bars before the run; a refusal throws. */
  checkBars?: (loaded: LoadedBars) => void;
  /** Extra top-level keys for `run.json`, beside `header` and `summary`. */
  extra?: Record<string, unknown>;
}

export interface RunOnceResult {
  outDir: string;
  window: WindowResult;
  loaded: LoadedBars;
}

/** One `run` directory: bars, the window, and the four files. */
export async function runOnce(input: RunOnceInput): Promise<RunOnceResult> {
  const { args, strategy, throttle } = input;
  const spec = CONTRACT_SPECS[args.ticker];
  const outDir = resolveOutDir(args);
  const { loaded } = await loadRunBars({
    args,
    spec,
    barSymbol: args.barSymbol,
    tail: input.tail,
    straddleLegs: [{ strategy, paramOverrides: input.paramOverrides }],
  });
  input.checkBars?.(loaded);
  const labels = args.usesClassifier ? buildLabelIndex(loaded.sessionDays) : null;

  const window = await runWindow({
    strategy,
    allBars: loaded.bars,
    subBars: loaded.subBars,
    from: args.from,
    to: args.to,
    warmupDays: args.warmupDays,
    tickSize: spec.tickSize,
    tickValue: spec.tickValue,
    daySession: spec.daySession,
    feePerSideUsd: args.fees ? spec.feePerSide : 0,
    paramOverrides: input.paramOverrides,
    sizing: sizingFromArgs(args),
    dailyLossUsd: args.dailyLossUsd,
    dailyProfitUsd: args.dailyProfitUsd,
    foldId: null,
    sample: null,
    tradeIdStart: 1,
    labels,
    regimes: args.regimes,
    onProgress: throttle.onProgress,
  });

  await writeJson(outDir, "run.json", {
    header: buildHeader({
      args,
      spec,
      playbookVersion: strategy.version,
      paramSchema: strategy.params,
      calibratedFor: strategy.config.calibratedFor ?? null,
      warmupFrom: window.warmupFrom,
      barCount: window.barCount,
      sessionCount: window.sessions.length,
      firstBarTs: window.firstBarTs,
      lastBarTs: window.lastBarTs,
      cacheFiles: loaded.cacheFiles,
      barTail: loaded.barTail,
      resolvedParams: window.resolvedParams,
      cpu: throttle.report(),
    }),
    summary: window.summary,
    // Absent, not null, when nothing classified: a distribution over zero
    // labels is not an empty distribution.
    ...(labels
      ? {
          labelDistribution: labelDistribution(
            labels,
            window.sessions.map((s) => s.sessionDate),
          ),
        }
      : {}),
    warnings: window.warnings,
    ...input.extra,
  });
  await writeJsonl(outDir, "trades.jsonl", window.records);
  await writeJsonl(outDir, "sessions.jsonl", window.sessions);
  // Written even when empty, for the reason `sessions.jsonl` is: a missing
  // file reads as an older build, an empty one reads as "nothing was skipped".
  await writeJsonl(outDir, "skips.jsonl", window.skips);

  return { outDir, window, loaded };
}
