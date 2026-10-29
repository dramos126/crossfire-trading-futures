import type { BacktestResult, BacktestTrade } from "./backtest";
import type { StrategyMeta } from "./strategy-types";
import type { BarData } from "@/lib/brokers/types";

interface ExportResultsArgs {
  result: BacktestResult;
  bars: BarData[];
  /** Indicator series keyed by id, aligned 1:1 with `bars`. Values may be
   *  null where the indicator hadn't warmed up; written through to the
   *  exported bar columns as-is so the consumer sees the same alignment
   *  the backtest used. */
  indicators: Record<string, (number | null)[]>;
  preBars: number;
  postBars: number;
  config: { strategy: string; instrument: string; tf: string; params: Record<string, unknown> };
}

interface ExportResultsFromBarsArgs {
  result: BacktestResult;
  bars: BarData[];
  preBars: number;
  postBars: number;
  config: { strategy: string; instrument: string; tf: string; params: Record<string, unknown> };
}

/**
 * Server-side export: full bar array is available, slice windows per trade
 * using bar indices. No indicators (not in the backtest response).
 */
export function exportResultsFromBarsAsJson(args: ExportResultsFromBarsArgs): string {
  const { result, bars, preBars, postBars, config } = args;
  const safePre = Math.max(0, Math.floor(preBars));
  const safePost = Math.max(0, Math.floor(postBars));

  const trades: ExportedTrade[] = result.trades.map((trade, i) =>
    buildExportedTrade(trade, i, bars, {}, safePre, safePost),
  );

  const header = {
    exportedAt: new Date().toISOString(),
    config,
    summary: buildSummary(result),
  };
  return serializeExport(header, trades);
}

/** Per-trade bar windows fetched lazily (post-64e1c92 flow). Each entry is the
 *  bar array for the corresponding trade index. Bars are matched to entry/exit
 *  by timestamp rather than absolute index since each window is independent. */
export interface TradeBarWindows {
  [tradeIndex: number]: BarData[];
}

interface ExportResultsWithWindowsArgs {
  result: BacktestResult;
  tradeBarWindows: TradeBarWindows;
  config: { strategy: string; instrument: string; tf: string; params: Record<string, unknown> };
}

interface ExportedBar {
  ts: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  marker: "entry" | "exit" | null;
  [indicatorId: string]: number | string | null;
}

interface ExportedTrade {
  tradeIndex: number;
  side: "BUY" | "SELL";
  entryTs: string;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  exitTs: string;
  exitPrice: number;
  exitReason: BacktestTrade["exitReason"];
  pnlTicks: number;
  pnlDollars: number;
  entryMeta?: StrategyMeta;
  exitMeta?: StrategyMeta;
  bars: ExportedBar[];
}

/**
 * Serialize every trade from a backtest run plus a window of bars around
 * each. The summary block mirrors `BacktestStats` so the file matches the
 * on-screen UI numbers exactly.
 *
 * Window is clamped to `[0, bars.length-1]` per trade; trades near series
 * boundaries get whatever bars are available with no padding.
 */
export function exportResultsAsJson(args: ExportResultsArgs): string {
  const { result, bars, indicators, preBars, postBars, config } = args;
  const safePre = Math.max(0, Math.floor(preBars));
  const safePost = Math.max(0, Math.floor(postBars));

  const trades: ExportedTrade[] = result.trades.map((trade, i) =>
    buildExportedTrade(trade, i, bars, indicators, safePre, safePost),
  );

  const header = {
    exportedAt: new Date().toISOString(),
    config,
    summary: buildSummary(result),
  };
  return serializeExport(header, trades);
}

/** Build the summary block shared by both export variants. */
function buildSummary(result: BacktestResult) {
  const { stats } = result;
  return {
    totalTrades: stats.totalTrades,
    wins: stats.wins,
    losses: stats.losses,
    breakEven: stats.breakEven,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    totalPnlDollars: stats.totalPnlDollars,
    totalGrossPnlDollars: stats.totalGrossPnlDollars,
    totalFeesDollars: stats.totalFeesDollars,
    maxDrawdownDollars: stats.maxDrawdownDollars,
    avgWinTicks: stats.avgWinTicks,
    avgLossTicks: stats.avgLossTicks,
    largestWinTicks: stats.largestWinTicks,
    largestLossTicks: stats.largestLossTicks,
  };
}

function serializeExport(
  header: { exportedAt: string; config: unknown; summary: unknown },
  trades: ExportedTrade[],
): string {
  const headerJson = JSON.stringify(header, null, 2);
  const tradesBody = trades.map((t) => "    " + JSON.stringify(t)).join(",\n");
  const tradesBlock =
    trades.length === 0
      ? `,\n  "trades": []\n}`
      : `,\n  "trades": [\n${tradesBody}\n  ]\n}`;
  return headerJson.replace(/\n}$/, tradesBlock);
}

/**
 * Windowed export variant for the post-64e1c92 flow where bars are fetched
 * lazily per-trade rather than carried in the backtest response. Entry/exit
 * bars are matched by timestamp — the windows are independent slices and
 * `entryBarIndex`/`exitBarIndex` are relative to the full series, not the
 * window.
 */
export function exportResultsWithWindowsAsJson(
  args: ExportResultsWithWindowsArgs,
): string {
  const { result, tradeBarWindows, config } = args;

  const trades: ExportedTrade[] = result.trades.map((trade, i) => {
    const bars = tradeBarWindows[i] ?? [];
    return buildExportedTradeFromWindow(trade, i, bars);
  });

  const header = {
    exportedAt: new Date().toISOString(),
    config,
    summary: buildSummary(result),
  };
  return serializeExport(header, trades);
}

function buildExportedTradeFromWindow(
  trade: BacktestTrade,
  tradeIndex: number,
  bars: BarData[],
): ExportedTrade {
  const entryMs = new Date(trade.entryTimestamp).getTime();
  const exitMs = new Date(trade.exitTimestamp).getTime();

  const exportedBars: ExportedBar[] = bars.map((bar) => {
    const barMs = new Date(bar.timestamp).getTime();
    const marker: ExportedBar["marker"] =
      barMs === entryMs ? "entry" : barMs === exitMs ? "exit" : null;
    return {
      ts: bar.timestamp,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      marker,
    };
  });

  return {
    tradeIndex,
    side: trade.side === 0 ? "BUY" : "SELL",
    entryTs: trade.entryTimestamp,
    entryPrice: trade.entryPrice,
    slPrice: trade.slPrice,
    tpPrice: trade.tpPrice,
    exitTs: trade.exitTimestamp,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlTicks: trade.pnlTicks,
    pnlDollars: trade.pnlDollars,
    ...(trade.entryMeta ? { entryMeta: trade.entryMeta } : {}),
    ...(trade.exitMeta ? { exitMeta: trade.exitMeta } : {}),
    bars: exportedBars,
  };
}

function buildExportedTrade(
  trade: BacktestTrade,
  tradeIndex: number,
  bars: BarData[],
  indicators: Record<string, (number | null)[]>,
  preBars: number,
  postBars: number,
): ExportedTrade {
  const start = Math.max(0, trade.entryBarIndex - preBars);
  const end = Math.min(bars.length - 1, trade.exitBarIndex + postBars);

  const exportedBars: ExportedBar[] = [];
  for (let i = start; i <= end; i++) {
    const bar = bars[i];
    const marker: ExportedBar["marker"] =
      i === trade.entryBarIndex ? "entry" : i === trade.exitBarIndex ? "exit" : null;
    const out: ExportedBar = {
      ts: bar.timestamp,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      marker,
    };
    for (const [id, series] of Object.entries(indicators)) {
      out[id] = series[i] ?? null;
    }
    exportedBars.push(out);
  }

  return {
    tradeIndex,
    side: trade.side === 0 ? "BUY" : "SELL",
    entryTs: trade.entryTimestamp,
    entryPrice: trade.entryPrice,
    slPrice: trade.slPrice,
    tpPrice: trade.tpPrice,
    exitTs: trade.exitTimestamp,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlTicks: trade.pnlTicks,
    pnlDollars: trade.pnlDollars,
    ...(trade.entryMeta ? { entryMeta: trade.entryMeta } : {}),
    ...(trade.exitMeta ? { exitMeta: trade.exitMeta } : {}),
    bars: exportedBars,
  };
}
