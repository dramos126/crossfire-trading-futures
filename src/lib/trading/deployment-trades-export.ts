import type { BarData } from "@/lib/brokers/types";
import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { MainSession } from "@/lib/trading/strategy-types";

export interface TradeBarsEntry {
  bars: BarData[];
  timeframe: string;
  /** ISO8601 wallclock at which this snapshot's post-exit window will be
   *  fully populated. Null = mature now (post-maturityMs re-snapshot, or
   *  row predates the column). The export emits `barsTruncated: true`
   *  when this is non-null and still in the future at serialization time. */
  barsMatureAt: string | null;
}

export interface ExportDeploymentTradesArgs {
  deployment: Deployment;
  trades: StrategyTrade[];
  accountName: string;
  /**
   * The playbook's declared trading window — `config.session`. **Passed in
   * rather than looked up**, for the reason `board-model.ts` states about
   * `BoardStrategy`: the registry is a build-time `require.context` with no
   * test-environment equivalent, so importing it here drags a bundler
   * mechanism into every consumer of this module. `null` when the strategy is
   * not registered.
   */
  session: MainSession | null;
  group?: DeploymentGroup | null;
  /** Per-trade bar snapshot (OHLCV) keyed by trade id. Trades absent from
   *  the map emit `bars: null` + `barsTimeframe: null` in the export.
   *  Omit the arg entirely to skip bars across the whole export. */
  tradesBars?: Map<number, TradeBarsEntry>;
}

interface ExportedTrade {
  tradeIndex: number;
  side: "BUY" | "SELL";
  size: number;
  entryTs: string | null;
  entryTriggerPrice: number | null;
  entryFillPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  exitTs: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlTicks: number | null;
  pnlDollars: number | null;
  grossPnlDollars: number | null;
  feesDollars: number | null;
  entrySlippageTicks: number | null;
  entrySlippageDollars: number | null;
  durationMs: number | null;
  paramSnapshot: Record<string, unknown> | null;
  bars: BarData[] | null;
  barsTimeframe: string | null;
  /** True when the snapshot exists but its post-exit window is still
   *  filling — re-export after `barsMatureAt` for the full window. */
  barsTruncated: boolean;
  /** ISO8601 wallclock at which the post-exit window will be complete.
   *  Null when mature now or no snapshot row exists. */
  barsMatureAt: string | null;
}

interface SessionWindow {
  mainSession: unknown;
  pauseWindows: unknown;
}

/**
 * Serialize every closed trade for one deployment as JSON, mirroring the
 * backtest export's pretty-printing layout (header indented, trade rows on
 * single lines) so a downstream reviewer can apply the same parser to both.
 *
 * Slippage convention: these fields are *entry* slippage only — the
 * difference between the trigger price the strategy intended and the actual
 * fill price the broker gave. Positive = worse than trigger (cost),
 * negative = price improvement. Exit slippage (TP/SL trigger vs fill) is
 * intentionally not exported today; add it as a separate field set if/when
 * needed. Matches the per-row math in deployment-trades.tsx.
 */
export function exportDeploymentTradesAsJson(args: ExportDeploymentTradesArgs): string {
  const { deployment, trades, accountName, session, group, tradesBars } = args;

  const sorted = [...trades].sort((a, b) => {
    const ta = a.entryFilledAt ?? a.entrySubmittedAt;
    const tb = b.entryFilledAt ?? b.entrySubmittedAt;
    return ta.localeCompare(tb);
  });

  const nowMs = Date.now();
  const exported: ExportedTrade[] = sorted.map((t, i) =>
    buildExportedTrade(t, i, tradesBars?.get(t.id) ?? null, nowMs),
  );

  const summary = buildSummary(sorted, deployment, session);

  const header = {
    exportedAt: new Date().toISOString(),
    source: "deployment" as const,
    deployment: {
      id: deployment.id,
      name: deployment.name,
      strategyKey: deployment.strategyKey,
      accountId: deployment.accountId,
      accountName,
      ticker: deployment.ticker,
      contractId: deployment.contractId,
      status: deployment.status,
      createdAt: deployment.createdAt,
      paramValues: deployment.paramValues,
      // filterConfig isn't projected onto the client `Deployment` type today —
      // it lives on `deployment_groups.filter_config` and isn't surfaced on
      // standalone legs either. Emit null until the type carries it.
      filterConfig: null,
      groupId: deployment.groupId,
      ...(group ? { group: { id: group.id, name: group.name } } : {}),
    },
    summary,
  };

  const headerJson = JSON.stringify(header, null, 2);
  const tradesBody = exported.map((t) => "    " + JSON.stringify(t)).join(",\n");
  const tradesBlock = exported.length === 0
    ? `,\n  "trades": []\n}`
    : `,\n  "trades": [\n${tradesBody}\n  ]\n}`;

  return headerJson.replace(/\n}$/, tradesBlock);
}

function buildExportedTrade(
  t: StrategyTrade,
  tradeIndex: number,
  barsEntry: TradeBarsEntry | null,
  nowMs: number,
): ExportedTrade {
  const grossPnlDollars =
    t.pnlDollars != null && t.feesDollars != null ? t.pnlDollars + t.feesDollars : null;

  let durationMs: number | null = null;
  if (t.entryFilledAt && t.exitFilledAt) {
    const start = Date.parse(t.entryFilledAt);
    const end = Date.parse(t.exitFilledAt);
    if (!Number.isNaN(start) && !Number.isNaN(end)) durationMs = end - start;
  }

  // Truncated when a snapshot row exists AND its bars_mature_at is in the
  // future. Mature snapshots and rows predating the column carry
  // barsMatureAt = null and serialize as not-truncated. No snapshot row =
  // bars: null, barsTruncated: false, barsMatureAt: null (rare edge case
  // — engine writes a snapshot on every exit fill).
  let barsTruncated = false;
  let barsMatureAt: string | null = null;
  if (barsEntry && barsEntry.barsMatureAt != null) {
    const matureMs = Date.parse(barsEntry.barsMatureAt);
    if (!Number.isNaN(matureMs) && matureMs > nowMs) {
      barsTruncated = true;
      barsMatureAt = barsEntry.barsMatureAt;
    }
  }

  return {
    tradeIndex,
    side: t.side === 0 ? "BUY" : "SELL",
    size: t.size,
    entryTs: t.entryFilledAt ?? t.entrySubmittedAt,
    entryTriggerPrice: t.desiredEntryPrice,
    entryFillPrice: t.entryPrice,
    slPrice: t.desiredSlPrice,
    tpPrice: t.desiredTpPrice,
    exitTs: t.exitFilledAt,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    pnlTicks: t.pnlTicks,
    pnlDollars: t.pnlDollars,
    grossPnlDollars,
    feesDollars: t.feesDollars,
    entrySlippageTicks: t.entrySlippageTicks,
    entrySlippageDollars: t.entrySlippageDollars,
    durationMs,
    paramSnapshot: t.paramSnapshot,
    bars: barsEntry ? barsEntry.bars : null,
    barsTimeframe: barsEntry ? barsEntry.timeframe : null,
    barsTruncated,
    barsMatureAt,
  };
}

interface Summary {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  profitFactor: number;
  totalPnlDollars: number;
  totalGrossPnlDollars: number;
  totalFeesDollars: number;
  avgWinDollars: number;
  avgLossDollars: number;
  largestWinDollars: number;
  largestLossDollars: number;
  avgSlippageTicks: number | null;
  totalEntrySlippageDollars: number;
  sessionWindow: SessionWindow | null;
}

function buildSummary(
  trades: StrategyTrade[],
  deployment: Deployment,
  session: MainSession | null,
): Summary {
  let wins = 0, losses = 0, breakEven = 0;
  let sumWinDollars = 0, sumLossDollars = 0;
  let totalPnlDollars = 0, totalFeesDollars = 0;
  let largestWin = -Infinity, largestLoss = Infinity;
  let slipTickSum = 0, slipTickCount = 0, slipDollarSum = 0;

  for (const t of trades) {
    if (t.pnlDollars != null) {
      totalPnlDollars += t.pnlDollars;
      if (t.pnlDollars > 0) {
        wins += 1;
        sumWinDollars += t.pnlDollars;
        if (t.pnlDollars > largestWin) largestWin = t.pnlDollars;
      } else if (t.pnlDollars < 0) {
        losses += 1;
        sumLossDollars += t.pnlDollars;
        if (t.pnlDollars < largestLoss) largestLoss = t.pnlDollars;
      } else {
        breakEven += 1;
      }
    }
    if (t.feesDollars != null) totalFeesDollars += t.feesDollars;
    if (t.entrySlippageTicks != null) {
      slipTickSum += t.entrySlippageTicks;
      slipTickCount += 1;
    }
    if (t.entrySlippageDollars != null) slipDollarSum += t.entrySlippageDollars;
  }

  const totalGrossPnlDollars = totalPnlDollars + totalFeesDollars;
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : 0;
  // Profit factor: gross wins / |gross losses|. Matches the backtest
  // formulation in src/lib/trading/backtest.ts.
  const profitFactor = sumLossDollars < 0
    ? sumWinDollars / Math.abs(sumLossDollars)
    : (sumWinDollars > 0 ? Infinity : 0);

  const pv = deployment.paramValues as Record<string, unknown>;
  // The window is the playbook's; the pauses are the deployment's. Both halves
  // stay on the export because the reader is reconstructing *when this row was
  // armed*, and either one alone answers half of it.
  const pw = pv["pauseWindows"] ?? null;
  const sessionWindow: SessionWindow | null =
    session == null && pw == null ? null : { mainSession: session, pauseWindows: pw };

  return {
    totalTrades: trades.length,
    wins,
    losses,
    breakEven,
    winRate,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
    totalPnlDollars,
    totalGrossPnlDollars,
    totalFeesDollars,
    avgWinDollars: wins > 0 ? sumWinDollars / wins : 0,
    avgLossDollars: losses > 0 ? sumLossDollars / losses : 0,
    largestWinDollars: wins > 0 ? largestWin : 0,
    largestLossDollars: losses > 0 ? largestLoss : 0,
    avgSlippageTicks: slipTickCount > 0 ? slipTickSum / slipTickCount : null,
    totalEntrySlippageDollars: slipDollarSum,
    sessionWindow,
  };
}
