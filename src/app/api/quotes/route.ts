import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

/**
 * Polled "current price" for a batch of contracts. Topstep doesn't expose
 * a top-of-book REST endpoint, so we use the most recent 1m bar with
 * `includePartialBar: true` — the partial bar's close is the latest tick
 * the gateway has accumulated. Used by the dashboard's REST polling path
 * so it doesn't have to open SignalR (which would kick the engine — see
 * `project_dashboard_replaces_webapp.md` memory).
 *
 * Body: { contractIds: string[] }
 * Returns: { quotes: { [contractId]: { mark: number; lastUpdated: string } } }
 */
export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  let body: { contractIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const allIds = body.contractIds ?? [];
  if (!Array.isArray(allIds) || allIds.length === 0) {
    return NextResponse.json({ quotes: {} });
  }

  // Non-dotted ids are Tradovate execution contractIds (e.g. "MNQM6") —
  // translate to the id market data arrives under. That is a live-sub scan
  // first and a contract resolve second, so a manual position the engine
  // holds no sub for still gets a mark. Null = cannot tell, skip this tick.
  // `ContractResolver.resolve` has a TTL but no in-flight coalescing, so N
  // ids of one product on a cold cache issue N concurrent `searchContracts`
  // where the previous serial loop warmed the cache for the rest; bounded at
  // a couple of extra calls per 15-minute TTL.
  const resolved = await Promise.all(
    allIds.map(async (id) => {
      if (id.includes(".")) return { fetchId: id, resultKey: id };
      const marketId = await handle.marketDataContractId(id);
      return marketId ? { fetchId: marketId, resultKey: id } : null;
    }),
  );
  const fetchList = resolved.filter((e) => e !== null);

  if (fetchList.length === 0) {
    return NextResponse.json({ quotes: {} });
  }

  // Anchor a small window for the bar fetch — last 5 minutes is plenty to
  // guarantee at least one closed bar plus any partial. Use UTC ISO so
  // the gateway interprets it consistently regardless of user tz.
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60 * 1000);

  const out: Record<string, { mark: number; lastUpdated: string }> = {};
  // Run in parallel since each is one independent REST call. Failures on
  // any single contract don't block the others — we just omit that quote
  // and the UI will keep showing the prior tick (or "—" if first load).
  await Promise.all(
    fetchList.map(async ({ fetchId, resultKey }) => {
      try {
        const bars = await marketDataRegistry.realtime().retrieveBars({
          contractId: fetchId,
          live: true,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          unit: 2,        // minute
          unitNumber: 1,  // 1m bars
          limit: 5,
          includePartialBar: true,
        });
        // Provider output is ascending, so the last element is the newest
        // bar — the partial one carrying the latest tick. Reading the raw
        // Topstep response here took the *oldest* bar of the window, i.e.
        // a mark up to five minutes stale.
        const last = bars[bars.length - 1];
        if (!last || !Number.isFinite(last.close)) return;
        // Key under original id so quotes[position.contractId] resolves.
        out[resultKey] = { mark: last.close, lastUpdated: last.timestamp };
      } catch {
        // Per-contract failure is non-fatal; just skip it.
      }
    }),
  );

  return NextResponse.json({ quotes: out });
}
