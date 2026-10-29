import { buildTradeRecord, type CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { BacktestTrade } from "@/lib/trading/backtest";
import type { BarData } from "@/lib/brokers/types";

/**
 * An in-browser run's trades as `trades.jsonl` rows, so the run reader that
 * steps through saved runs reads this one with no second shape.
 *
 * **The CLI's own builder, on the series the run was handed** — the same call
 * `run-window.ts` makes, so the excursion walk indexes the bars the trades'
 * bar indices point into. Server-side because that series never reaches the
 * browser. No fold, no sample and no regime label: this path runs no
 * walk-forward and no classifier, and a null is what the CLI writes for a run
 * that did neither.
 */
export function buildTradeRecords(
  trades: readonly BacktestTrade[],
  bars: BarData[],
  tickSize: number,
): CliTradeRecord[] {
  return trades.map((trade, i) =>
    buildTradeRecord({
      trade,
      bars,
      tickSize,
      tradeId: i + 1,
      foldId: null,
      sample: null,
      regime: null,
    }),
  );
}
