/**
 * One backtest over one session-date window — the building block both
 * `run` and each `walk-forward` fold are made of.
 *
 * Two rules live here and nowhere else. **Warmup is history, never a source
 * of trades:** the window is handed bars reaching back `--warmup-days`
 * session days before `--from`, and every trade whose signal bar falls
 * before `--from`'s session start is dropped before a statistic sees it.
 * And the drop happens on `signalBarTs`, not on the exit — a trade that
 * opened in warmup and closed inside the window is a warmup trade.
 */
import {
  runBacktest,
  type BacktestResult,
  type BacktestSizing,
  type BacktestTrade,
} from "@/lib/trading/backtest";
import type { BarData } from "@/lib/brokers/types";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import type { ParamValues, StrategyModule } from "@/lib/trading/strategy-types";
import {
  sessionDateOf,
  sessionEndUtc,
  sessionStartUtc,
  shiftSessionDatesBack,
} from "@/lib/trading/regime/session-dates";
import { REGIME_SKIP_GATE, withRegimeGate } from "@/lib/trading/regime/gate";
import {
  riskBudgetSkip,
  strategySkip,
  type SkippedSignal,
} from "@/lib/trading/skipped-signal";
import { labelForBar, type LabelIndex } from "./regime-labels";
import { buildTradeRecord, type CliTradeRecord, type FoldSample } from "@/lib/trading/backtest-trade-record";
import { buildSessionRecords, type SessionRecord } from "./sessions";
import { appendSkips, skipTruncationWarning, type CliSkipRecord } from "./skip-record";
import { buildSummary, type CliSummary } from "./summary";

export interface RunWindowArgs {
  strategy: StrategyModule;
  /** Aggregated series covering the whole invocation, warmup included. */
  allBars: BarData[];
  /** The 1m bars `allBars` was aggregated from; see `runBacktest`'s `subBars`. */
  subBars?: BarData[];
  from: string;
  to: string;
  warmupDays: number;
  tickSize: number;
  tickValue: number;
  /** The instrument's cash-session bounds — every day-session quantity a
   *  strategy measures is anchored on it. */
  daySession: DaySessionWindow;
  feePerSideUsd: number;
  paramOverrides: ParamValues;
  /** `--risk-usd` (every entry sized by the engine's own risk sizer, and one
   *  it cannot fit becomes a `risk_budget` skip) or `--contracts`. */
  sizing: BacktestSizing;
  dailyLossUsd: number | null;
  dailyProfitUsd: number | null;
  foldId: number | null;
  sample: FoldSample | null;
  /** First `tradeId` to hand out, so ids stay unique across folds. */
  tradeIdStart: number;
  /** The run's label series, or null when no classifier is in play. */
  labels: LabelIndex | null;
  /** Cells entries are restricted to. Null wraps nothing. */
  regimes: readonly string[] | null;
  /** The CPU throttle's hook into the bar loop. */
  onProgress?: () => Promise<void>;
}

export interface WindowResult {
  records: CliTradeRecord[];
  keptBacktestTrades: BacktestTrade[];
  /** Every entry the run considered and did not take, one row each, capped at
   *  `MAX_SKIP_RECORDS` with the overflow reported in `warnings`. Same
   *  constructors the engine's `skipped_signals` writer uses. */
  skips: CliSkipRecord[];
  sessions: SessionRecord[];
  summary: CliSummary;
  warmupFrom: string;
  barCount: number;
  firstBarTs: string | null;
  lastBarTs: string | null;
  resolvedParams: ParamValues;
  warnings: string[];
}

export async function runWindow(args: RunWindowArgs): Promise<WindowResult> {
  const warmupFrom = shiftSessionDatesBack(args.from, args.warmupDays);
  const sliceStart = sessionStartUtc(warmupFrom).getTime();
  const windowStart = sessionStartUtc(args.from).getTime();
  const windowEnd = sessionEndUtc(args.to).getTime();

  const bars = args.allBars.filter((bar) => {
    const at = new Date(bar.timestamp).getTime();
    return at >= sliceStart && at <= windowEnd;
  });

  // Skips are counted over the requested range only: a warmup bar produces
  // no trade, so a skip on one is not a skip the run is reporting about.
  const skipReasonCounts: Record<string, number> = {};
  const skips: CliSkipRecord[] = [];
  let skipsDropped = 0;
  const countGate = (gate: string) => {
    skipReasonCounts[gate] = (skipReasonCounts[gate] ?? 0) + 1;
  };
  /**
   * Counted and recorded, on the same in-window rule the counts use. **The
   * count is taken before the cap**, so the bound costs rows in the file and
   * never a number in the summary — and the append is the same capped one
   * `walk-forward` and `lift` aggregate through, rather than a second
   * spelling of the bound.
   */
  const record = (bar: BarData, skip: SkippedSignal) => {
    if (new Date(bar.timestamp).getTime() < windowStart) return;
    countGate(skip.gate);
    skipsDropped += appendSkips(skips, [
      {
        ...skip,
        foldId: args.foldId,
        sample: args.sample,
        regime: args.labels ? args.labels.get(skip.sessionDate) ?? null : null,
      },
    ]);
  };
  // The regime gate is the CLI's own and has no engine counterpart yet, so it
  // is counted and deliberately not written to `skips.jsonl` — see
  // `skip-record.ts`.
  const strategy = gatedStrategy(args, (bar) => {
    if (new Date(bar.timestamp).getTime() < windowStart) return;
    countGate(REGIME_SKIP_GATE);
  });

  const result: BacktestResult = await runBacktest({
    strategy,
    bars,
    subBars: args.subBars,
    paramOverrides: args.paramOverrides,
    tickSize: args.tickSize,
    tickValue: args.tickValue,
    daySession: args.daySession,
    feePerSideUsd: args.feePerSideUsd,
    sizing: args.sizing,
    // `--daily-loss-usd` and `--daily-profit-usd` reach the gate as an
    // argument now that the gate numbers are the account's rather than a
    // deployment's params. One evaluator, one counter, both sides.
    ...(args.dailyLossUsd == null && args.dailyProfitUsd == null
      ? {}
      : {
          dailyPnl: {
            dailyMaxLossUsd: args.dailyLossUsd ?? 0,
            dailyMaxProfitUsd: args.dailyProfitUsd ?? 0,
            dailyPnlIncludeUnrealized: false,
          },
        }),
    // Counted on the same rule as the regime gate's skips and for the same
    // reason: a skip on a warmup bar is not a skip this run is reporting on.
    onRiskBudgetSkip: (bar, numbers) => record(bar, riskBudgetSkip(bar, numbers)),
    onEntrySkip: (skip, bar) => record(bar, strategySkip(skip, bar)),
    onProgress: args.onProgress,
  });

  const kept = result.trades.filter(
    (trade) => new Date(trade.signalBarTs).getTime() >= windowStart,
  );
  const records = kept.map((trade, i) =>
    buildTradeRecord({
      trade,
      bars,
      tickSize: args.tickSize,
      tradeId: args.tradeIdStart + i,
      foldId: args.foldId,
      sample: args.sample,
      regime: args.labels
        ? args.labels.get(sessionDateOf(new Date(trade.signalBarTs))) ?? null
        : null,
    }),
  );

  const sessions = buildSessionRecords(
    sessionDatesIn(bars, windowStart, windowEnd),
    records,
    args.dailyLossUsd,
    args.labels,
  );

  return {
    records,
    keptBacktestTrades: kept,
    skips,
    sessions,
    summary: buildSummary({ records, backtestTrades: kept, sessions, skipReasonCounts }),
    warmupFrom,
    barCount: bars.length,
    firstBarTs: bars.length > 0 ? bars[0].timestamp : null,
    lastBarTs: bars.length > 0 ? bars[bars.length - 1].timestamp : null,
    resolvedParams: result.params,
    warnings: [
      ...(result.warnings ?? []),
      ...(skipsDropped > 0 ? [skipTruncationWarning(skipsDropped)] : []),
    ],
  };
}

/**
 * The regime gate, when one was asked for. `--regime all` (a null cell set)
 * wraps nothing at all rather than wrapping with a predicate that always
 * passes, so a run without a gate runs the module the engine would.
 */
function gatedStrategy(
  args: RunWindowArgs,
  onSkip: (bar: BarData) => void,
): StrategyModule {
  const { labels, regimes } = args;
  if (labels == null || regimes == null) return args.strategy;
  return withRegimeGate(args.strategy, {
    allowed: new Set(regimes),
    labelForBar: (bar) => labelForBar(labels, bar),
    onSkip: (_label, bar) => onSkip(bar),
  });
}

/** Distinct session dates the window's own bars fall in, ascending. */
function sessionDatesIn(bars: BarData[], startMs: number, endMs: number): string[] {
  const seen = new Set<string>();
  for (const bar of bars) {
    const at = new Date(bar.timestamp).getTime();
    if (at < startMs || at > endMs) continue;
    seen.add(sessionDateOf(new Date(bar.timestamp)));
  }
  return [...seen].sort();
}
