/**
 * `lift` — the validation study's Part 2 for one playbook.
 *
 * Runs the playbook **ungated** across the registered walk-forward folds,
 * tags every held-out trade with the cell label of its signal bar's session,
 * and asks whether restricting to the cells that look best would have added
 * anything. Six criteria, all of them fixed in the proposal before the first
 * run and exposed as flags only so a re-run under a new classifier version
 * is one flag rather than a code change.
 *
 * **It is not the admission gate.** It answers one platform question — does
 * the regime gate exist at all — using whatever playbooks exist when it
 * runs. Whether a given playbook is fit to trade is a separate pass with its
 * own numbers on its own hooks.
 *
 * The permutation is the load-bearing criterion: shifting the label series
 * circularly preserves each axis's run-length structure exactly and destroys
 * its alignment with the days, and **the cell selection is re-run on every
 * shift** — the null being tested is the whole procedure, not a cell chosen
 * in advance. That is White's Reality Check applied to cell selection, and
 * the quantitative answer to "one observation per day is curve-fitting".
 */
import { CONTRACT_SPECS, type ContractSpec } from "@/lib/trading/contracts/contract-specs";
import type { BacktestTrade } from "@/lib/trading/backtest";
import { REGIME_CELLS, type RegimeCell } from "@/lib/trading/regime/classify-regime";
import { activeIndicator, flipRate, lag1Autocorrelation } from "@/lib/trading/regime/stability";
import type { StrategyModule } from "@/lib/trading/strategy-types";
import type { CliArgs } from "../args";
import { loadRunBars } from "../bars";
import { CliError } from "../cli-error";
import { buildFolds, type Fold } from "../folds";
import { buildHeader, resolveOutDir, writeJson, writeJsonl } from "../output";
import { resolveParamOverrides, sizingFromArgs } from "../params";
import { buildLabelIndex, labelDistribution, type LabelIndex } from "../regime-labels";
import type { CpuThrottle } from "../throttle";
import type { WindowResult } from "../run-window";
import type { WindowPool } from "../worker-pool";
import type { BarData } from "@/lib/brokers/types";
import { buildSummary } from "../summary";
import type { SessionRecord } from "../sessions";
import { appendSkips, skipTruncationWarning, type CliSkipRecord } from "../skip-record";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";

/** A fold must carry this many trades in the claim set before its sign is
 *  read; below it the fold's lift is one trade's noise. */
const MIN_FOLD_TRADES_IN_CLAIM_SET = 10;
/** A shift has to be long enough that a run of labels lands on other days —
 *  at both ends, since a shift of `len − k` is a shift of `−k`. */
export const MIN_SHIFT_SESSIONS = 30;
const PERCENTILE_95 = 0.95;
const FIRST_TRADE_ID = 1;
const UNKNOWN = "unknown";

export interface HeldOutTrade {
  foldId: number;
  sessionDate: string;
  /** R **net of fees** at the run's contract count — the study's unit. */
  r: number;
}

export interface LabelledSession {
  sessionDate: string;
  label: string;
}

export interface LiftThresholds {
  minCellTrades: number;
  minLiftR: number;
  foldConsistency: number;
  permutations: number;
  seed: number;
}

export interface CellStat {
  cell: string;
  sessions: number;
  n: number;
  expectancyR: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownR: number;
  worstSessionR: number;
  perFold: Array<{ foldId: number; n: number; expectancyR: number }>;
}

export interface LiftEvaluation {
  eAll: number;
  cells: CellStat[];
  claimSet: RegimeCell[];
  lift: number;
  foldConsistency: { value: number; eligibleFolds: number; passingFolds: number };
  permutation: { n: number; p: number; percentile95: number };
  drawdown: { gatedR: number; ungatedR: number };
  verdicts: Record<string, boolean>;
  pass: boolean;
}

export interface LiftInput {
  trades: HeldOutTrade[];
  sessions: LabelledSession[];
  foldCount: number;
  thresholds: LiftThresholds;
}

export async function liftCommand(
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
  const { loaded, warmupFrom } = await loadRunBars({
    args,
    spec,
    barSymbol: args.barSymbol,
    straddleLegs: [{ strategy, paramOverrides: resolveParamOverrides(strategy, args) }],
  });
  const labels = buildLabelIndex(loaded.sessionDays);

  const { records, pooledTrades, sessionRecords, trades, skips, skipsDropped } =
    await runLiftFolds({ args, strategy, spec, allBars: loaded.bars, subBars: loaded.subBars, folds, labels, pool });

  const sessions: LabelledSession[] = sessionRecords.map((s) => ({
    sessionDate: s.sessionDate,
    label: s.label ?? UNKNOWN,
  }));
  const evaluation = evaluateLift({
    trades,
    sessions,
    foldCount: folds.length,
    thresholds: args,
  });

  await writeJson(outDir, "run.json", {
    header: buildHeader({
      args,
      spec,
      playbookVersion: strategy.version,
      paramSchema: strategy.params,
      calibratedFor: strategy.config.calibratedFor ?? null,
      warmupFrom,
      barCount: loaded.bars.length,
      sessionCount: sessions.length,
      firstBarTs: loaded.bars.length > 0 ? loaded.bars[0].timestamp : null,
      lastBarTs: loaded.bars.length > 0 ? loaded.bars[loaded.bars.length - 1].timestamp : null,
      cacheFiles: loaded.cacheFiles,
      resolvedParams: resolveParamOverrides(strategy, args),
      cpu: throttle.report(),
    }),
    summary: buildSummary({
      records,
      backtestTrades: pooledTrades,
      sessions: sessionRecords,
    }),
  });
  await writeJson(outDir, "cells.json", {
    cells: evaluation.cells,
    labelDistribution: labelDistribution(
      labels,
      sessions.map((s) => s.sessionDate),
    ),
    axisStability: {
      vol: {
        lag1Autocorr: lag1Autocorrelation(
          activeIndicator(sessions.map((s) => labels.get(s.sessionDate)?.vol ?? null)),
        ),
        flipRate: flipRate(sessions.map((s) => labels.get(s.sessionDate)?.vol ?? null)),
      },
      range: {
        flipRate: flipRate(sessions.map((s) => labels.get(s.sessionDate)?.range ?? null)),
      },
    },
  });
  await writeJson(outDir, "lift.json", {
    eAll: evaluation.eAll,
    claimSet: evaluation.claimSet,
    lift: evaluation.lift,
    foldConsistency: evaluation.foldConsistency.value,
    permutation: evaluation.permutation,
    drawdown: evaluation.drawdown,
    pass: evaluation.pass,
    verdicts: evaluation.verdicts,
  });
  await writeJsonl(outDir, "trades.jsonl", records);
  await writeJsonl(outDir, "skips.jsonl", skips);
  if (skipsDropped > 0) process.stderr.write(`${skipTruncationWarning(skipsDropped)}\n`);

  process.stdout.write(report(evaluation, args));
  return outDir;
}

export interface LiftFoldsInput {
  args: CliArgs;
  strategy: StrategyModule;
  spec: ContractSpec;
  allBars: BarData[];
  subBars?: BarData[];
  folds: Fold[];
  labels: LabelIndex;
  pool: WindowPool;
}

export interface LiftFolds {
  records: CliTradeRecord[];
  pooledTrades: BacktestTrade[];
  sessionRecords: SessionRecord[];
  trades: HeldOutTrade[];
  skips: CliSkipRecord[];
  skipsDropped: number;
}

/**
 * One held-out window per fold, through the pool. The folds would chain
 * `nextTradeId` run one after another, so each is run from id 1 and its
 * records are renumbered here, in fold order, once every fold has returned —
 * the ids the chain would have handed out. `tradeId` is the only place a
 * `WindowResult` carries the id. Everything else is appended in fold order
 * too, so `appendSkips`'s command-wide cap drops the same rows at any worker
 * count.
 */
export async function runLiftFolds(input: LiftFoldsInput): Promise<LiftFolds> {
  const { args, strategy, spec, folds, labels } = input;
  const windows: WindowResult[] = [];
  await input.pool.run(
    { strategy, allBars: input.allBars, subBars: input.subBars, labels },
    folds.map((fold) => ({
      label: `fold ${fold.foldId} test ${fold.test.from}..${fold.test.to}`,
      // Ungated and at base constants: the study measures what the label
      // would have added to the playbook as it stands, and a sweep would move
      // two things at once.
      job: {
        from: fold.test.from,
        to: fold.test.to,
        warmupDays: args.warmupDays,
        tickSize: spec.tickSize,
        tickValue: spec.tickValue,
        daySession: spec.daySession,
        feePerSideUsd: args.fees ? spec.feePerSide : 0,
        paramOverrides: resolveParamOverrides(strategy, args),
        sizing: sizingFromArgs(args),
        dailyLossUsd: args.dailyLossUsd,
        dailyProfitUsd: args.dailyProfitUsd,
        foldId: fold.foldId,
        sample: "test",
        tradeIdStart: FIRST_TRADE_ID,
        regimes: null,
      },
    })),
    // Handed over in fold order, so the index is the array's next slot.
    (_, window) => {
      windows.push(window);
    },
  );

  const out: LiftFolds = {
    records: [],
    pooledTrades: [],
    sessionRecords: [],
    trades: [],
    // `lift` runs the same held-out folds `walk-forward` does and writes the
    // same `trades.jsonl`; a skip file it alone omitted would make "why was
    // this cell empty" answerable from one command and not the other.
    skips: [],
    skipsDropped: 0,
  };
  let nextTradeId = FIRST_TRADE_ID;
  for (const [i, fold] of folds.entries()) {
    const window = windows[i];
    const offset = nextTradeId - FIRST_TRADE_ID;
    const records = window.records.map((record) => ({ ...record, tradeId: record.tradeId + offset }));
    nextTradeId += records.length;
    out.records.push(...records);
    out.pooledTrades.push(...window.keptBacktestTrades);
    out.sessionRecords.push(...window.sessions);
    out.skipsDropped += appendSkips(out.skips, window.skips);
    for (const record of records) {
      out.trades.push({
        foldId: fold.foldId,
        sessionDate: record.sessionDate,
        r: netR(record, spec),
      });
    }
  }
  return out;
}

/**
 * Everything the study decides, from the held-out trades and the label
 * series alone. Pure, so the arithmetic is testable on a synthetic set where
 * the answer is known by construction.
 */
export function evaluateLift(input: LiftInput): LiftEvaluation {
  const { trades, sessions, foldCount, thresholds } = input;
  const cellOf = new Map<string, string>();
  for (const session of sessions) cellOf.set(session.sessionDate, session.label);

  const eAll = mean(trades.map((t) => t.r));
  const claimSet = selectClaimSet(trades, cellOf, eAll, thresholds);
  const claimed = new Set<string>(claimSet);
  const inClaimSet = trades.filter((t) => claimed.has(cellOf.get(t.sessionDate) ?? UNKNOWN));
  const lift = claimSet.length === 0 ? 0 : mean(inClaimSet.map((t) => t.r)) - eAll;

  const consistency = foldConsistencyOf(trades, inClaimSet, foldCount);
  const permutation = permutationTest(trades, cellOf, sessions, eAll, lift, thresholds);
  const drawdown = {
    gatedR: maxDrawdownR(inClaimSet.map((t) => t.r)),
    ungatedR: maxDrawdownR(trades.map((t) => t.r)),
  };

  const verdicts = {
    claimSetNonEmpty: claimSet.length > 0,
    lift: lift >= thresholds.minLiftR,
    foldConsistency:
      consistency.eligibleFolds > 0 && consistency.value >= thresholds.foldConsistency,
    permutation: permutation.n > 0 && lift > permutation.percentile95,
    drawdown: drawdown.gatedR <= drawdown.ungatedR,
  };

  return {
    eAll,
    cells: cellStats(trades, sessions, cellOf),
    claimSet,
    lift,
    foldConsistency: consistency,
    permutation,
    drawdown,
    verdicts,
    pass: Object.values(verdicts).every(Boolean),
  };
}

/**
 * R net of fees: the trade's net dollars over the dollars its initial stop
 * put at risk. `rMultiple` on the record is `pnlTicks / slTicks`, which is
 * gross — the study says net, and a 0.10R floor against fee-free trades
 * would be a different floor.
 */
function netR(record: CliTradeRecord, spec: ContractSpec): number {
  const riskDollars = record.slTicks * spec.tickValue * record.contracts;
  return riskDollars > 0 ? record.pnlNetDollars / riskDollars : 0;
}

/**
 * `S = { c : n_c ≥ min, E_c > 0, E_c − E_all ≥ minLift }`, over the four
 * cells only. An `unknown` session is never claimable — it is the label
 * standing down, not a regime — however many trades landed in one.
 */
export function selectClaimSet(
  trades: HeldOutTrade[],
  cellOf: Map<string, string>,
  eAll: number,
  thresholds: Pick<LiftThresholds, "minCellTrades" | "minLiftR">,
): RegimeCell[] {
  const claimed: RegimeCell[] = [];
  for (const cell of REGIME_CELLS) {
    const rs = trades.filter((t) => cellOf.get(t.sessionDate) === cell).map((t) => t.r);
    if (rs.length < thresholds.minCellTrades) continue;
    const expectancy = mean(rs);
    if (expectancy > 0 && expectancy - eAll >= thresholds.minLiftR) claimed.push(cell);
  }
  return claimed;
}

function cellStats(
  trades: HeldOutTrade[],
  sessions: LabelledSession[],
  cellOf: Map<string, string>,
): CellStat[] {
  const sessionsPerCell = new Map<string, number>();
  for (const session of sessions) {
    sessionsPerCell.set(session.label, (sessionsPerCell.get(session.label) ?? 0) + 1);
  }

  return [...sessionsPerCell.keys()].sort().map((cell) => {
    const inCell = trades.filter((t) => cellOf.get(t.sessionDate) === cell);
    const rs = inCell.map((t) => t.r);
    const wins = rs.filter((r) => r > 0);
    const lossTotal = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    const bySession = new Map<string, number>();
    for (const trade of inCell) {
      bySession.set(trade.sessionDate, (bySession.get(trade.sessionDate) ?? 0) + trade.r);
    }
    const foldIds = [...new Set(inCell.map((t) => t.foldId))].sort((a, b) => a - b);

    return {
      cell,
      sessions: sessionsPerCell.get(cell) ?? 0,
      n: rs.length,
      expectancyR: mean(rs),
      winRate: rs.length > 0 ? wins.length / rs.length : 0,
      profitFactor: lossTotal > 0 ? wins.reduce((a, b) => a + b, 0) / lossTotal : 0,
      maxDrawdownR: maxDrawdownR(rs),
      worstSessionR: bySession.size > 0 ? Math.min(...bySession.values()) : 0,
      perFold: foldIds.map((foldId) => {
        const foldRs = inCell.filter((t) => t.foldId === foldId).map((t) => t.r);
        return { foldId, n: foldRs.length, expectancyR: mean(foldRs) };
      }),
    };
  });
}

/**
 * Share of folds whose own lift is non-negative, over the folds carrying at
 * least ten held-out trades in the claim set. A fold with fewer is neither
 * counted for nor against — its sign is one trade from flipping.
 */
function foldConsistencyOf(
  all: HeldOutTrade[],
  inClaimSet: HeldOutTrade[],
  foldCount: number,
): { value: number; eligibleFolds: number; passingFolds: number } {
  let eligibleFolds = 0;
  let passingFolds = 0;
  for (let foldId = 0; foldId < foldCount; foldId++) {
    const claimed = inClaimSet.filter((t) => t.foldId === foldId).map((t) => t.r);
    if (claimed.length < MIN_FOLD_TRADES_IN_CLAIM_SET) continue;
    eligibleFolds++;
    const foldAll = all.filter((t) => t.foldId === foldId).map((t) => t.r);
    if (mean(claimed) - mean(foldAll) >= 0) passingFolds++;
  }
  return {
    value: eligibleFolds > 0 ? passingFolds / eligibleFolds : 0,
    eligibleFolds,
    passingFolds,
  };
}

/**
 * The circular-shift null. `E_all` does not move under a shift — the trades
 * and their R are untouched — so each shift recomputes only the selection
 * and the claimed mean. A shift that claims nothing scores 0, which is the
 * honest reading: the procedure found no cell worth gating on.
 *
 * `p` is the pre-registered formula and nothing else: the share of shifted
 * lifts at or above the observed one, with no `+1` correction. The criterion
 * `pass` reads is `percentile95`; redefining `p` would silently move a number
 * the study fixed before the first run.
 */
export function permutationTest(
  trades: HeldOutTrade[],
  cellOf: Map<string, string>,
  sessions: LabelledSession[],
  eAll: number,
  observedLift: number,
  thresholds: LiftThresholds,
): { n: number; p: number; percentile95: number } {
  const order = [...new Set(sessions.map((s) => s.sessionDate))].sort();
  if (shiftSpan(order.length) <= 0) {
    process.stderr.write(
      `permutation: ${order.length} labelled sessions leaves no shift of at least ` +
        `${MIN_SHIFT_SESSIONS} sessions from either end; the null is not computed.\n`,
    );
    return { n: 0, p: 1, percentile95: 0 };
  }

  const random = mulberry32(thresholds.seed);
  const lifts: number[] = [];
  for (let i = 0; i < thresholds.permutations; i++) {
    const offset = drawShiftOffset(random, order.length);
    const shifted = new Map<string, string>();
    for (let d = 0; d < order.length; d++) {
      shifted.set(order[d], cellOf.get(order[(d + offset) % order.length]) ?? UNKNOWN);
    }
    const claimSet = new Set<string>(selectClaimSet(trades, shifted, eAll, thresholds));
    const claimed = trades.filter((t) => claimSet.has(shifted.get(t.sessionDate) ?? UNKNOWN));
    lifts.push(claimSet.size === 0 ? 0 : mean(claimed.map((t) => t.r)) - eAll);
  }

  const atOrAbove = lifts.filter((l) => l >= observedLift).length;
  const sorted = [...lifts].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(PERCENTILE_95 * sorted.length) - 1);
  return {
    n: lifts.length,
    p: atOrAbove / lifts.length,
    percentile95: sorted[Math.max(0, rank)],
  };
}

/** Offsets are drawn from `[30, len − 30)`. A shift of `len − 1` is a shift
 *  of −1: it moves every label one day and destroys nothing, so the far end
 *  needs the same margin the near end has. */
function shiftSpan(sessionCount: number): number {
  return sessionCount - 2 * MIN_SHIFT_SESSIONS;
}

export function drawShiftOffset(random: () => number, sessionCount: number): number {
  return MIN_SHIFT_SESSIONS + Math.floor(random() * shiftSpan(sessionCount));
}

/** Peak-to-trough of the cumulative R series, in order. */
export function maxDrawdownR(rs: number[]): number {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const r of rs) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const depth = peak - cumulative;
    if (depth > worst) worst = depth;
  }
  return worst;
}

/** Deterministic 32-bit PRNG — the seed is the whole reproducibility story,
 *  and `Math.random` would make a p-value unrepeatable. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const DECIMALS = 3;

function report(evaluation: LiftEvaluation, thresholds: LiftThresholds): string {
  const total = evaluation.cells.reduce((n, c) => n + c.n, 0);
  const lines = [
    `E_all ${evaluation.eAll.toFixed(DECIMALS)}R over ${total} held-out trades`,
    "",
    "cell                     n      E_c  winRate   maxDD_R",
  ];
  for (const cell of evaluation.cells) {
    lines.push(
      `  ${cell.cell.padEnd(18)} ${String(cell.n).padStart(5)} ${cell.expectancyR
        .toFixed(DECIMALS)
        .padStart(8)} ${cell.winRate.toFixed(DECIMALS).padStart(8)} ${cell.maxDrawdownR
        .toFixed(DECIMALS)
        .padStart(9)}`,
    );
  }
  lines.push(
    "",
    `claim set: ${evaluation.claimSet.length > 0 ? evaluation.claimSet.join(", ") : "(empty)"}`,
    `lift ${evaluation.lift.toFixed(DECIMALS)}R against a floor of ${thresholds.minLiftR}R`,
    `fold consistency ${evaluation.foldConsistency.passingFolds}/${evaluation.foldConsistency.eligibleFolds} = ${evaluation.foldConsistency.value.toFixed(DECIMALS)} against ${thresholds.foldConsistency}`,
    `permutation n=${evaluation.permutation.n} p=${evaluation.permutation.p.toFixed(DECIMALS)} p95=${evaluation.permutation.percentile95.toFixed(DECIMALS)}`,
    `drawdown gated ${evaluation.drawdown.gatedR.toFixed(DECIMALS)}R vs ungated ${evaluation.drawdown.ungatedR.toFixed(DECIMALS)}R`,
    "",
    ...Object.entries(evaluation.verdicts).map(([name, ok]) => `  ${ok ? "pass" : "FAIL"}  ${name}`),
    `pass: ${evaluation.pass}`,
  );
  return `${lines.join("\n")}\n`;
}
