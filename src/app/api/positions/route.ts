import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BrokerKind, getAccountBrokerOrTopstep } from "@/lib/db/account-brokers";
import { getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

export async function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  const accountId = req.nextUrl.searchParams.get("accountId");
  if (!accountId) return NextResponse.json({ error: "Missing accountId" }, { status: 400 });

  // `Number("abc")` is NaN, and NaN reaches `getAccountBrokerOrTopstep`
  // as an untagged account, defaults to Topstep, and goes out as
  // `{ accountId: null }` on the wire — a broker round-trip for a
  // question that was malformed here. 400 it instead.
  const numericAccountId = Number(accountId);
  if (!Number.isInteger(numericAccountId)) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }
  const broker = getAccountBrokerOrTopstep(numericAccountId);

  try {
    if (broker === BrokerKind.Tradovate) {
      // Use the engine singleton — already authenticated, token-refreshes lazily.
      // A fresh client per request re-auths on every 2.5s poll and hammers
      // Tradovate's auth endpoint into timeout, triggering the broker-unavailable
      // circuit and auto-pausing deployments.
      const client = await getTradovateClientIfConfigured();
      if (!client) return NextResponse.json({ positions: [] });
      const positions = await client.searchOpenPositions(numericAccountId);
      // Normalize numeric contractIds to dated symbols so the UI quote key matches
      // the SSE-emitted key. The realtime adapter owns the bridge — it is the
      // same cache its WS dispatcher reads, and it is warmer than the client's
      // own at poll time.
      const dated = await handle.resolveDatedSymbols(positions.map((p) => p.contractId));
      if (dated) {
        positions.forEach((p, i) => {
          p.contractId = dated[i];
        });
      }
      return NextResponse.json({ positions });
    }
    // Topstep answers from the engine's account view (A115): every request
    // counts against one 200/min limit the engine's own orders share. Only a
    // missing or stale view costs a live read, one per account however many
    // tabs are asking.
    const answer = await handle.readPositions(numericAccountId);
    if (answer.kind === "topstep-not-configured") {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }
    return NextResponse.json({
      positions: answer.items,
      asOf: new Date(answer.asOf).toISOString(),
      source: answer.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch positions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
