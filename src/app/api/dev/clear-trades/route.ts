import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { clearAllTrades } from "@/lib/db/trades";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { listDeployments } from "@/lib/db/deployments";

const handle = engineHandle();

/**
 * Dev-only endpoint to wipe `strategy_trades` and start fresh. Gated by
 * the same DEV_TOOLS_ENABLED middleware that hides /dev altogether.
 *
 * Behavior:
 *   - Refuses if any trade is in-flight (pending_entry/open/pending_exit).
 *   - On success, broadcasts a `strategyTrade` SSE event for every active
 *     deployment so connected dashboards refresh their useTrades cache
 *     immediately and show the cleared state without an F5.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  // Confirmation phrase guard so a stray click can't nuke the table.
  let body: { confirm?: string };
  try {
    body = (await request.json()) as { confirm?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.confirm !== "DELETE ALL TRADES") {
    return NextResponse.json(
      { error: "Confirmation phrase mismatch — type DELETE ALL TRADES" },
      { status: 400 },
    );
  }

  try {
    const result = clearAllTrades();
    // Push an invalidation per active deployment so every open dashboard
    // (Dashboard, Deployments page, Strategy detail) refetches and shows
    // the cleared state. Best-effort — no broadcaster, no harm done; the
    // 5s useTrades poll catches up regardless.
    await handle.emitStrategyTradeClosedIfRunning(
      listDeployments().map((d) => ({ accountId: d.accountId, deploymentId: d.id })),
    );
    return NextResponse.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const status = code === "TRADES_IN_FLIGHT" ? 409 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear trades", code },
      { status },
    );
  }
}
