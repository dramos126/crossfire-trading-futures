import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  getAccountRealizedSinceGross,
  getPnLSummary,
  getSlippageStats,
  listTrades,
} from "@/lib/db/trades";
import { getDeployment } from "@/lib/db/deployments";
import { getAccountDailyPnlLimits } from "@/lib/db/account-brokers";
import { currentCmeSessionStart, nextCmeSessionRollover } from "@/lib/trading/session/session";
import { evaluateDailyPnlGate } from "@/lib/trading/daily-pnl-gate";

export interface DailyPnlGateStatus {
  /** True when the **account's** daily-PnL gate is currently blocking new
   *  entries. Carries the word "gross" semantics — value compared against
   *  threshold is gross realized (no fees). */
  tripped: boolean;
  /** Which side fired. Null when not tripped. */
  side: "loss" | "profit" | null;
  /** Threshold that fired, in USD. Null when not tripped or both
   *  thresholds are disabled. */
  amountUsd: number | null;
  /** Epoch ms at which the current session ends and the counter resets.
   *  Badge UIs use this to auto-clear at rollover. */
  sessionRolloverEpochMs: number;
  /** Mirrors the account's `dailyPnlIncludeUnrealized` setting so the
   *  badge can label whether unrealized is folded in. */
  includeUnrealized: boolean;
}

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const accountIdRaw = searchParams.get("accountId");
  const deploymentId = searchParams.get("deploymentId") ?? undefined;
  const deploymentIdsRaw = searchParams.get("deploymentIds");
  const limitRaw = searchParams.get("limit");
  const slippageWindowRaw = searchParams.get("slippageWindow");

  const accountId = accountIdRaw ? Number(accountIdRaw) : undefined;
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const slippageWindow = slippageWindowRaw ? Number(slippageWindowRaw) : 20;

  // Several deployments at once — the drill-in's all-accounts view, where one
  // deployment is N `deployments` rows. The parameter being *absent* is no
  // filter; the parameter being present and naming nothing filters to nothing,
  // which is the honest answer for a card whose legs the caller could not
  // resolve. `?deploymentIds=` therefore returns an empty list rather than
  // every trade in the install.
  const deploymentIds =
    deploymentIdsRaw == null
      ? undefined
      : deploymentIdsRaw.split(",").filter((s) => s.length > 0);

  try {
    const trades = listTrades({ accountId, deploymentId, deploymentIds, limit });
    const summary = getPnLSummary({ accountId, deploymentId, deploymentIds });
    // Slippage stats are only meaningful per-deployment (different
    // strategies/contracts have different tick economics). Return null at
    // the account scope so callers don't confuse it with a meaningful zero.
    const slippage = deploymentId
      ? getSlippageStats(deploymentId, slippageWindow)
      : null;

    // Daily-PnL gate status. The gate is per **account** now, so the badge is
    // too: the account comes from `?accountId` when the caller gave one, else
    // from the deployment it scoped to. A query naming neither cannot say whose
    // gate to report and answers null. Reads the same two things the engine
    // consults — `account_brokers` and the account's session-realized sum — so
    // the badge cannot disagree with the gate decision.
    const gateAccountId =
      accountId ?? (deploymentId ? getDeployment(deploymentId)?.accountId : undefined);
    let dailyPnlGate: DailyPnlGateStatus | null = null;
    if (gateAccountId != null) {
      const now = new Date();
      const sessionStart = currentCmeSessionStart(now);
      const limits = getAccountDailyPnlLimits(gateAccountId);
      const result = evaluateDailyPnlGate({
        ...limits,
        realizedGross: getAccountRealizedSinceGross(gateAccountId, sessionStart),
        // Server-side has no unrealized stream; the badge consumer (client)
        // folds in live unrealized when rendering. The gate's
        // tripped/side/amountUsd here therefore reflects the realized-only
        // decision; the client adds unrealized into its own evaluator for
        // display purposes.
        unrealized: 0,
      });
      dailyPnlGate = {
        tripped: result.tripped,
        side: result.side,
        amountUsd: result.thresholdUsd,
        sessionRolloverEpochMs: nextCmeSessionRollover(now).getTime(),
        includeUnrealized: limits.dailyPnlIncludeUnrealized,
      };
    }

    return NextResponse.json({ trades, summary, slippage, dailyPnlGate });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load trades" },
      { status: 500 },
    );
  }
}
