import { NextRequest, NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { getAccountBrokerOrNull, type BrokerKind } from "@/lib/db/account-brokers";
import { listTradesForExport } from "@/lib/db/trades";
import type { StrategyTrade } from "@/lib/db/trade-types";
import { log } from "@/lib/logger";
import { exitReasonCodeOf } from "@/lib/logging/exit-reasons";
import { getStrategy } from "@/lib/trading/strategies";
import { riskAnchorOf, type RiskAnchor } from "@/lib/trading/risk-anchor";
import { isProductionEnv } from "@/lib/env";

/**
 * The monthly review's pull: a date range of closed live trades as JSON,
 * over the LAN, with the session token the UI already holds. It exists so
 * the review never needs a database copy or a shell on the engine VM.
 *
 * The backtest CLI is the other half; the join key is
 * `(strategyKey, ticker, signalBarTs)`.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ExportedTrade {
  tradeId: number;
  environment: string;
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  /** **Resolved from the registry at export time, not from the row.**
   *  Nothing persists a strategy version on a trade, so a playbook that has
   *  been bumped since the trade fired reports the *current* version here.
   *  Null when the module no longer exists. Treat it as "which code is on
   *  disk now", never as "which code placed this order". */
  strategyVersion: string | null;
  ticker: string;
  contractId: string;
  /** Which broker filled it, resolved from the account. The bracket-anchor
   *  review is per broker, and the account id alone does not say. Null when
   *  the account is no longer in the catalogue. */
  broker: BrokerKind | null;
  side: 0 | 1;
  signalBarTs: string | null;
  /** The fill, not the submit — null only if the fill was never stamped. */
  entryTs: string | null;
  entryPrice: number | null;
  contracts: number;
  slPrice: number | null;
  tpPrice: number | null;
  slTicks: number | null;
  tpTicks: number | null;
  /** Null on a closed row whose exit fill has not been healed yet, which is
   *  an ordinary state rather than a corrupt one. */
  exitTs: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlGrossDollars: number | null;
  feesDollars: number | null;
  pnlNetDollars: number | null;
  paramSnapshot: Record<string, unknown> | null;
  /**
   * What the stop was worth when the trade was sized against what it is
   * worth from the fill, plus the signed distance between the two. Derived
   * from the columns above — see `riskAnchorOf`. This is what the monthly
   * bracket-anchor review reads, grouped by `broker`.
   */
  riskAnchor: RiskAnchor;
  regime: { label: string | null; classifierVersion: string | null };
  brokerOrderIds: {
    entry: number | null;
    tp: number | null;
    sl: number | null;
    exit: number | null;
  };
}

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from == null || to == null || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json(
      { error: "from and to are required, as YYYY-MM-DD" },
      { status: 400 },
    );
  }

  try {
    const trades = listTradesForExport({
      from,
      to,
      ticker: searchParams.get("ticker") ?? undefined,
      strategyKey: searchParams.get("strategyKey") ?? undefined,
    });
    return NextResponse.json({
      environment: environmentName(),
      from,
      to,
      count: trades.length,
      trades: trades.map(toExportedTrade),
    });
  } catch (err) {
    // The detail goes to the log, not to the response: this route answers a
    // session-token holder over the LAN and a SQLite error message names the
    // database file and the failing statement.
    log.error("trades-export", `export query failed: ${messageOf(err)}`);
    return NextResponse.json({ error: "Failed to export trades" }, { status: 500 });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function environmentName(): string {
  return isProductionEnv() ? "prod" : "staging";
}

function toExportedTrade(trade: StrategyTrade): ExportedTrade {
  return {
    tradeId: trade.id,
    environment: environmentName(),
    deploymentId: trade.deploymentId,
    accountId: trade.accountId,
    strategyKey: trade.strategyKey,
    strategyVersion: getStrategy(trade.strategyKey)?.version ?? null,
    ticker: trade.ticker,
    contractId: trade.contractId,
    broker: getAccountBrokerOrNull(trade.accountId),
    side: trade.side,
    signalBarTs: trade.signalBarTs,
    entryTs: trade.entryFilledAt,
    entryPrice: trade.entryPrice,
    contracts: trade.size,
    slPrice: trade.desiredSlPrice,
    tpPrice: trade.desiredTpPrice,
    slTicks: trade.desiredSlTicks,
    tpTicks: trade.desiredTpTicks,
    exitTs: trade.exitFilledAt,
    exitPrice: trade.exitPrice,
    // The code, never the rendered label: `exit_reason` is prose that is
    // free to be reworded and two writers disagree on its shape.
    exitReason: exitReasonCodeOf(trade.exitReasonCode),
    pnlGrossDollars: grossOf(trade),
    feesDollars: trade.feesDollars,
    pnlNetDollars: trade.pnlDollars,
    paramSnapshot: trade.paramSnapshot,
    riskAnchor: riskAnchorOf(trade),
    // The label as it was at entry, off the row — never a fresh classify.
    // Both null on a row written before the columns existed; `"unknown"` is
    // a label the classifier emits and comes through as itself.
    regime: { label: trade.regimeLabel, classifierVersion: trade.regimeClassifierVersion },
    brokerOrderIds: {
      entry: trade.entryOrderId,
      tp: trade.tpOrderId,
      sl: trade.slOrderId,
      exit: trade.exitOrderId,
    },
  };
}

/**
 * `pnl_dollars` has two generations — net of fees since 2026-04-26, gross
 * before — and `fees_dollars` is null on the older rows, so adding the two
 * recovers gross across both. See persistence/README.md.
 */
function grossOf(trade: StrategyTrade): number | null {
  if (trade.pnlDollars == null) return null;
  return trade.pnlDollars + (trade.feesDollars ?? 0);
}
