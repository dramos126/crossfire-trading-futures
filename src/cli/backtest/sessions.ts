/**
 * Per-session-day rollup — one line per session in `sessions.jsonl`.
 *
 * `label` and `features` are null when no classifier ran; the keys exist
 * either way so the file shape does not change under a consumer.
 */
import { sessionDateOf } from "@/lib/trading/regime/session-dates";
import type { RegimeFeatures } from "@/lib/trading/regime/classify-regime";
import { labelOfSession, type LabelIndex } from "./regime-labels";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";

export interface SessionRecord {
  sessionDate: string;
  label: string | null;
  features: RegimeFeatures | null;
  tradeCount: number;
  netDollars: number;
  netR: number;
  fired: boolean;
  dailyLossBreached: boolean;
}

/**
 * Rows are bucketed by **signal-bar** session, because that is the session
 * the trade belongs to and the one whose regime label decided it.
 * `dailyLossBreached` is the one exception — see below.
 */
export function buildSessionRecords(
  sessionDates: string[],
  trades: CliTradeRecord[],
  dailyLossUsd: number | null,
  labels: LabelIndex | null = null,
): SessionRecord[] {
  const byDate = new Map<string, CliTradeRecord[]>();
  for (const trade of trades) {
    const bucket = byDate.get(trade.sessionDate);
    if (bucket) bucket.push(trade);
    else byDate.set(trade.sessionDate, [trade]);
  }
  const breached = breachedSessions(trades, dailyLossUsd);

  return sessionDates.map((sessionDate) => {
    const dayTrades = byDate.get(sessionDate) ?? [];
    let netDollars = 0;
    let netR = 0;
    for (const trade of dayTrades) {
      netDollars += trade.pnlNetDollars;
      netR += trade.rMultiple;
    }
    return {
      sessionDate,
      label: labels ? labelOfSession(labels, sessionDate) : null,
      features: labels ? labels.get(sessionDate)?.features ?? null : null,
      tradeCount: dayTrades.length,
      netDollars,
      netR,
      fired: dayTrades.length > 0,
      dailyLossBreached: breached.has(sessionDate),
    };
  });
}

/**
 * Sessions whose running **gross** realised total reached the limit.
 *
 * Two details make this agree with the gate rather than shadow it. It reads
 * gross, matching `evaluateDailyPnlGate`'s input — Topstep's published limit
 * is gross of exchange fees. And it buckets each trade on its **exit** bar's
 * CME session, which is what `runBacktest` does when it accumulates
 * `grossRealizedBySession`: a trade that signalled before 17:00 ET and
 * closed after 18:00 ET counts against the session it closed in, on both
 * sides. Bucketing on the signal bar here would produce a count that
 * disagrees with the gate that actually stopped the entries.
 */
function breachedSessions(
  trades: CliTradeRecord[],
  dailyLossUsd: number | null,
): Set<string> {
  const out = new Set<string>();
  if (dailyLossUsd == null) return out;

  const runningGross = new Map<string, number>();
  for (const trade of trades) {
    const exitSession = sessionDateOf(new Date(trade.exitTs));
    const total = (runningGross.get(exitSession) ?? 0) + trade.pnlGrossDollars;
    runningGross.set(exitSession, total);
    if (total <= -dailyLossUsd) out.add(exitSession);
  }
  return out;
}
