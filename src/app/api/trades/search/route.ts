import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { BrokerKind, getAccountBrokerOrTopstep } from "@/lib/db/account-brokers";
import { getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";

// Topstep returns bars/trades only for the active contract + the prior
// roll, which empirically caps history around 3 months. Allowing 180 days
// produces confusing upstream 500s when callers go past the real cap; 100
// days gives breathing room while still failing fast inside our app.
// Applied to both brokers: Tradovate's `/fill/list` is session-scoped and
// well inside this bound, so the clamp costs it nothing.
const MAX_LOOKBACK_MS = 100 * 24 * 60 * 60 * 1000;

/**
 * Broker fills for a time window, routed per account through the
 * `searchTrades` primitive. Was written to re-seed `sessionRealizedPnl` on
 * cold-load and on hub reconnect, since GatewayUserTrade events that fired
 * while we were disconnected are not replayed; that seeding has since moved
 * to `useTrades`, so the route currently has no caller in `src/`.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const body = (await request.json()) as {
    accountId?: unknown;
    startTimestamp?: unknown;
    endTimestamp?: unknown;
  };

  // `typeof x === "number"` accepts NaN; Number.isFinite rejects both NaN
  // and ±Infinity, which is what we actually want for a broker account id.
  const accountId =
    typeof body.accountId === "number" && Number.isFinite(body.accountId)
      ? body.accountId
      : null;
  const startTimestamp =
    typeof body.startTimestamp === "string" ? body.startTimestamp : null;
  const endTimestamp =
    typeof body.endTimestamp === "string" ? body.endTimestamp : undefined;

  if (accountId == null || !startTimestamp) {
    return NextResponse.json(
      { error: "Missing or invalid accountId / startTimestamp" },
      { status: 400 },
    );
  }

  // Clamp the lookback so a bogus year-1900 timestamp can't amplify a
  // tiny request into a huge Topstep response that we then forward.
  const startMs = Date.parse(startTimestamp);
  if (!Number.isFinite(startMs)) {
    return NextResponse.json(
      { error: "startTimestamp must be a valid ISO date" },
      { status: 400 },
    );
  }
  if (Date.now() - startMs > MAX_LOOKBACK_MS) {
    return NextResponse.json(
      { error: `startTimestamp must be within the last ${MAX_LOOKBACK_MS / 86_400_000} days` },
      { status: 400 },
    );
  }

  try {
    if (getAccountBrokerOrTopstep(accountId) === BrokerKind.Tradovate) {
      // Engine singleton, not a fresh client — see /api/positions for why.
      const tradovate = await getTradovateClientIfConfigured();
      if (!tradovate) return NextResponse.json({ trades: [] });
      const trades = await tradovate.searchTrades(accountId, startTimestamp, endTimestamp);
      return NextResponse.json({ trades });
    }
    const topstepToken = await topstepBrowserToken();
    if (!topstepToken) {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }
    const client = new TopstepClient();
    client.setToken(topstepToken);
    const trades = await client.searchTrades(accountId, startTimestamp, endTimestamp);
    return NextResponse.json({ trades });
  } catch (err) {
    // 502 Bad Gateway is more honest than 500 for upstream failures —
    // lets us distinguish "the broker rejected us" from "our route
    // crashed" in logs/metrics later.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to search trades" },
      { status: 502 },
    );
  }
}
