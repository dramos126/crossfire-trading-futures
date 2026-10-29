/**
 * The `run.json` summary block.
 *
 * Every win / loss / break-even count comes from `computeStats`, never from
 * a second pass over the trades here — a surface that re-derives the
 * buckets will eventually disagree with the one on screen, which
 * backtest.md records as a settled rule. What this module adds is the
 * R-denominated and session-denominated statistics `BacktestStats` has no
 * concept of, because it has no notion of a session or of initial risk.
 */
import { computeStats, type BacktestStats, type BacktestTrade } from "@/lib/trading/backtest";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { SessionRecord } from "./sessions";

export interface BucketStat {
  n: number;
  expectancyR: number;
}

export interface CliSummary extends BacktestStats {
  trades: number;
  sessions: number;
  sessionsWithTrade: number;
  tradesPerSession: number;
  expectancyR: number;
  stdR: number;
  medianR: number;
  avgWinR: number;
  avgLossR: number;
  payoffRatio: number;
  maxDrawdownR: number;
  maxDrawdownDurationSessions: number;
  longestLossStreak: number;
  worstSessionDollars: number;
  worstSessionDate: string | null;
  dailyLossBreaches: number;
  exitReasonCounts: Record<string, number>;
  /** Only the gates the CLI itself applies — `regime` today. `runBacktest`
   *  discards a strategy's own `EntrySkip`s, so nothing else can appear here
   *  until the engine persists skipped signals. */
  skipReasonCounts: Record<string, number>;
  avgBarsHeld: number;
  byEntryHourEt: Array<BucketStat & { hour: number }>;
  byWeekday: Array<BucketStat & { weekday: number }>;
}

export interface BuildSummaryArgs {
  /** Kept trades only — warmup and pre-`--from` entries are already gone. */
  records: CliTradeRecord[];
  backtestTrades: BacktestTrade[];
  sessions: SessionRecord[];
  skipReasonCounts?: Record<string, number>;
}

export function buildSummary(args: BuildSummaryArgs): CliSummary {
  const { records, backtestTrades, sessions } = args;
  const rs = records.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const avgWinR = mean(wins);
  const avgLossR = mean(losses);
  const drawdown = drawdownInR(records);
  const worstSession = worstSessionBy(sessions);

  return {
    ...computeStats(backtestTrades),
    trades: records.length,
    sessions: sessions.length,
    sessionsWithTrade: sessions.filter((s) => s.fired).length,
    tradesPerSession: sessions.length > 0 ? records.length / sessions.length : 0,
    expectancyR: mean(rs),
    stdR: sampleStdDev(rs),
    medianR: median(rs),
    avgWinR,
    avgLossR,
    payoffRatio: avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : 0,
    maxDrawdownR: drawdown.maxDrawdownR,
    maxDrawdownDurationSessions: drawdown.maxDurationSessions,
    longestLossStreak: longestLossStreak(records),
    worstSessionDollars: worstSession?.netDollars ?? 0,
    worstSessionDate: worstSession?.sessionDate ?? null,
    dailyLossBreaches: sessions.filter((s) => s.dailyLossBreached).length,
    exitReasonCounts: countBy(records, (t) => t.exitReason),
    skipReasonCounts: args.skipReasonCounts ?? {},
    avgBarsHeld: mean(records.map((t) => t.barsHeld)),
    byEntryHourEt: bucketBy(records, (t) => t.entryHourEt).map(([hour, stat]) => ({
      hour,
      ...stat,
    })),
    byWeekday: bucketBy(records, (t) => t.weekday).map(([weekday, stat]) => ({
      weekday,
      ...stat,
    })),
  };
}

/**
 * Drawdown on the cumulative R series, trade by trade. The duration is
 * counted in **session days between the peak and the trade under water**,
 * over the sessions that actually carried a trade — a run that fires twice
 * a week measures its underwater stretch in its own sessions, not in
 * calendar days it never traded.
 */
export function drawdownInR(records: CliTradeRecord[]): {
  maxDrawdownR: number;
  maxDurationSessions: number;
} {
  const ordinalOf = new Map<string, number>();
  for (const trade of records) {
    if (!ordinalOf.has(trade.sessionDate)) ordinalOf.set(trade.sessionDate, ordinalOf.size);
  }

  let cumulative = 0;
  let peak = 0;
  let peakOrdinal = 0;
  let maxDrawdownR = 0;
  let maxDurationSessions = 0;

  for (const trade of records) {
    cumulative += trade.rMultiple;
    const ordinal = ordinalOf.get(trade.sessionDate) ?? 0;
    if (cumulative > peak) {
      peak = cumulative;
      peakOrdinal = ordinal;
      continue;
    }
    const depth = peak - cumulative;
    if (depth > maxDrawdownR) maxDrawdownR = depth;
    const duration = ordinal - peakOrdinal;
    if (depth > 0 && duration > maxDurationSessions) maxDurationSessions = duration;
  }
  return { maxDrawdownR, maxDurationSessions };
}

export function longestLossStreak(records: CliTradeRecord[]): number {
  let longest = 0;
  let current = 0;
  for (const trade of records) {
    if (trade.pnlTicks < 0) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function worstSessionBy(sessions: SessionRecord[]): SessionRecord | null {
  let worst: SessionRecord | null = null;
  for (const session of sessions) {
    if (!session.fired) continue;
    if (worst === null || session.netDollars < worst.netDollars) worst = session;
  }
  return worst;
}

function bucketBy(
  records: CliTradeRecord[],
  keyOf: (t: CliTradeRecord) => number,
): Array<[number, BucketStat]> {
  const buckets = new Map<number, number[]>();
  for (const trade of records) {
    const key = keyOf(trade);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(trade.rMultiple);
    else buckets.set(key, [trade.rMultiple]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, rs]) => [key, { n: rs.length, expectancyR: mean(rs) }]);
}

function countBy(
  records: CliTradeRecord[],
  keyOf: (t: CliTradeRecord) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const trade of records) {
    const key = keyOf(trade);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sample (n−1) standard deviation — the study reads it as the standard
 *  error's numerator, which is a sample estimate, not a population one. */
function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
