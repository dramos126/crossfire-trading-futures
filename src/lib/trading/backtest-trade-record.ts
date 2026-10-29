/**
 * The `trades.jsonl` record. Field names are fixed by the regime-playbooks
 * proposal because the monthly review joins live trades against them; do
 * not rename one to read better.
 */
import type { BacktestTrade, ExitReason } from "@/lib/trading/backtest";
import type { BarData, OrderSide } from "@/lib/brokers/types";
import type { StrategyMeta } from "@/lib/trading/strategy-types";
import { pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";
import type { RegimeResult } from "@/lib/trading/regime/classify-regime";
import { etHourOf, etWeekdayOf, sessionDateOf } from "@/lib/trading/regime/session-dates";

export type FoldSample = "train" | "test";

export interface CliTradeRecord {
  tradeId: number;
  foldId: number | null;
  sample: FoldSample | null;
  sessionDate: string;
  /** The label of the **signal bar's** session — the one that decided
   *  whether this trade was allowed. Null when no classifier ran. */
  regime: RegimeResult | null;
  signalBarTs: string;
  entryTs: string;
  entryBarIndex: number;
  side: OrderSide;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slTicks: number;
  tpTicks: number;
  contracts: number;
  exitTs: string;
  exitBarIndex: number;
  exitPrice: number;
  exitReason: ExitReason;
  pnlTicks: number;
  pnlGrossDollars: number;
  feesDollars: number;
  pnlNetDollars: number;
  /** **Gross**: `pnlTicks / slTicks`, fees not subtracted. Kept under its
   *  recorded meaning because the shelf's figures were quoted off it. */
  rMultiple: number;
  /** Net: `pnlNetDollars` over the dollars the stop risked at entry
   *  (`slTicks × tickValue × contracts`). Written since 2026-10-23, so a row
   *  from an older run has none (A65). */
  rMultipleNet?: number;
  mfeTicks: number;
  /** Index, within this trade's own bar span (0 = entry bar), of the bar
   *  the favourable extreme occurred on. Free by-product of the MFE walk.
   *  The walk starts after the fill, so 0 means no bar beat the entry. */
  mfeBarIndex: number;
  maeTicks: number;
  /** Index, within this trade's own bar span (0 = entry bar), of the bar
   *  the maximum adverse excursion occurred on; ties resolve to the
   *  earliest bar. What an account simulation needs to find the true
   *  simultaneous adverse excursion of overlapping legs — `maeTicks` alone
   *  says how bad each leg got, not whether they got bad at the same time. */
  maeBarIndex: number;
  barsHeld: number;
  slMoved: { breakeven: boolean; trail: boolean };
  entryMeta: StrategyMeta | null;
  exitMeta: StrategyMeta | null;
  entryHourEt: number;
  weekday: number;
}

export interface BuildTradeRecordArgs {
  trade: BacktestTrade;
  /** The exact series the run was handed, so the excursion walk indexes it. */
  bars: BarData[];
  tickSize: number;
  tradeId: number;
  foldId: number | null;
  sample: FoldSample | null;
  /** Resolved from the signal bar's session by the caller, which owns the
   *  label series; null when no classifier ran. */
  regime: RegimeResult | null;
}

export function buildTradeRecord(args: BuildTradeRecordArgs): CliTradeRecord {
  const { trade, bars, tickSize, tradeId, foldId, sample } = args;
  const excursion = excursionTicks(trade, bars, tickSize);
  const signalBar = new Date(trade.signalBarTs);

  return {
    tradeId,
    foldId,
    sample,
    sessionDate: sessionDateOf(signalBar),
    regime: args.regime,
    signalBarTs: trade.signalBarTs,
    entryTs: trade.entryTimestamp,
    entryBarIndex: trade.entryBarIndex,
    side: trade.side,
    entryPrice: trade.entryPrice,
    slPrice: trade.slPrice,
    tpPrice: trade.tpPrice,
    slTicks: trade.slTicks,
    tpTicks: trade.tpTicks,
    contracts: trade.size,
    exitTs: trade.exitTimestamp,
    exitBarIndex: trade.exitBarIndex,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlTicks: trade.pnlTicks,
    pnlGrossDollars: trade.grossPnlDollars,
    feesDollars: trade.feesDollars,
    pnlNetDollars: trade.pnlDollars,
    rMultiple: rMultipleOf(trade),
    rMultipleNet: trade.riskDollars > 0 ? trade.pnlDollars / trade.riskDollars : 0,
    mfeTicks: excursion.mfeTicks,
    mfeBarIndex: excursion.mfeBarIndex,
    maeTicks: excursion.maeTicks,
    maeBarIndex: excursion.maeBarIndex,
    barsHeld: trade.exitBarIndex - trade.entryBarIndex,
    slMoved: { breakeven: trade.breakEvenMoved, trail: trade.trailMoved },
    entryMeta: trade.entryMeta ?? null,
    exitMeta: trade.exitMeta ?? null,
    entryHourEt: etHourOf(signalBar),
    weekday: etWeekdayOf(signalBar),
  };
}

/** Gross P&L against the risk taken at entry, which is what makes trades on
 *  different stops comparable. `slTicks` is the pre-ratchet distance. Fees
 *  are not in it; `rMultipleNet` is the net figure (A65). */
export function rMultipleOf(trade: BacktestTrade): number {
  return trade.slTicks > 0 ? trade.pnlTicks / trade.slTicks : 0;
}

/**
 * Maximum favourable and adverse excursion, both as **positive tick
 * magnitudes**, over the bars the position was held through: from the bar
 * after entry, because the fill is the entry bar's close and its range traded
 * before the position existed (A104), through the exit bar — or the bar before
 * it when the exit was booked at the exit bar's open (A107).
 *
 * Both go through `pnlTicksFromPrices` rather than a float subtract and
 * divide: `0.1` is not a binary fraction, so an MGC excursion divided in
 * doubles lands at 24.000000000000913 ticks. The sign is carried by the
 * direction argument — favourable measured with the trade, adverse against
 * it — so neither needs an `abs` to come back positive.
 */
function excursionTicks(
  trade: BacktestTrade,
  bars: BarData[],
  tickSize: number,
): { mfeTicks: number; mfeBarIndex: number; maeTicks: number; maeBarIndex: number } {
  const isLong = trade.side === 0;
  const favourable: 1 | -1 = isLong ? 1 : -1;
  const adverse: 1 | -1 = isLong ? -1 : 1;
  let best = trade.entryPrice;
  let worst = trade.entryPrice;
  let bestBarIndex = 0;
  let worstBarIndex = 0;
  const lastHeldBarIndex = trade.exitAtBarOpen ? trade.exitBarIndex - 1 : trade.exitBarIndex;
  for (let i = trade.entryBarIndex + 1; i <= lastHeldBarIndex && i < bars.length; i++) {
    const bar = bars[i];
    const localIndex = i - trade.entryBarIndex;
    if (isLong) {
      if (bar.high > best) { best = bar.high; bestBarIndex = localIndex; }
      if (bar.low < worst) { worst = bar.low; worstBarIndex = localIndex; }
    } else {
      if (bar.low < best) { best = bar.low; bestBarIndex = localIndex; }
      if (bar.high > worst) { worst = bar.high; worstBarIndex = localIndex; }
    }
  }
  // `|| 0` turns the -0 of an excursion that never left the entry price into
  // +0: JSON writes both as 0, but a deep-equal on the pins tells them apart.
  return {
    mfeTicks: pnlTicksFromPrices(trade.entryPrice, best, favourable, tickSize) || 0,
    mfeBarIndex: bestBarIndex,
    maeTicks: pnlTicksFromPrices(trade.entryPrice, worst, adverse, tickSize) || 0,
    maeBarIndex: worstBarIndex,
  };
}
