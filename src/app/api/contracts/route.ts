import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getTopstepClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { searchText } = await request.json();
  if (!searchText) {
    return NextResponse.json({ error: "Missing searchText" }, { status: 400 });
  }

  // No accountId is in scope, so there is nothing to route on: contract
  // search is a Topstep question here. `searchContracts` is a `Broker`
  // member, but Tradovate's implementation throws by design — see
  // `TradovateClient.searchContracts`.
  try {
    const broker: Broker | null = await getTopstepClientIfConfigured();
    if (!broker) {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }
    const contracts = await broker.searchContracts(searchText);
    return NextResponse.json({ contracts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to search contracts" },
      { status: 500 },
    );
  }
}
