import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { ContractResolver } from "@/lib/trading/broker-access/contract-resolver";
import { getDeployment } from "@/lib/db/deployments";
import type { OrderSide, PlaceOrderRequest, BracketConfig, Order } from "@/lib/brokers/types";

/**
 * Probe Topstep's behavior when an active stop order is modified to a price
 * already through the current market. Documented in the punchlist as the
 * load-bearing question for intrabar breakeven (Reliability #4).
 *
 * Sequence:
 *   1. Resolve contract + read latest bar close (proxy for current price).
 *   2. Place a market order with a wide protective stop (100 ticks away).
 *   3. Poll searchOpen for ~3s to find the resulting SL order.
 *   4. Modify the SL to a price clearly through market (entry direction):
 *        - long position  → new stop ABOVE last close + 50 ticks
 *        - short position → new stop BELOW last close - 50 ticks
 *      ...which is on the wrong side of market for a stop-loss.
 *   5. Re-fetch searchOpen and report whether the SL is still resting,
 *      its new stopPrice, status, etc.
 *
 * Position is intentionally LEFT OPEN at the end so the caller can inspect
 * the post-modify state in the orders table. The dev page surfaces a
 * Flatten button next to the result.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: { deploymentId?: string; side?: OrderSide };
  try {
    body = (await request.json()) as { deploymentId?: string; side?: OrderSide };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { deploymentId, side } = body;
  if (!deploymentId || (side !== 0 && side !== 1)) {
    return NextResponse.json({ error: "deploymentId and side (0|1) required" }, { status: 400 });
  }

  const deployment = getDeployment(deploymentId);
  if (!deployment) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const token = await topstepBrowserToken();
  if (!token) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }
  const client = new TopstepClient();
  client.setToken(token);

  const steps: Array<{ step: string; data: unknown }> = [];
  const log = (step: string, data: unknown) => steps.push({ step, data });

  try {
    // 1. Resolve contract.
    const resolver = new ContractResolver(client);
    const contract = await resolver.resolve(deployment.ticker);
    log("contract resolved", { id: contract.id, tickSize: contract.tickSize });

    // 2. Fetch latest 1-minute bar with includePartialBar to approximate
    //    current price. No top-of-book REST endpoint exists.
    const now = new Date();
    const start = new Date(now.getTime() - 5 * 60 * 1000);
    const bars = await marketDataRegistry.realtime().retrieveBars({
      contractId: contract.id,
      live: false,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      unit: 2,
      unitNumber: 1,
      limit: 5,
      includePartialBar: true,
    });
    if (bars.length === 0) {
      return NextResponse.json(
        { error: "No bars returned — market closed?", steps },
        { status: 502 },
      );
    }
    const lastClose = bars[bars.length - 1].close;
    log("market price (last close)", { lastClose, bars: bars.length });

    // 3. Place market order with a wide stop (100 ticks).
    //    Bracket sign: long SL = -ticks, short SL = +ticks.
    const SL_TICKS = 100;
    const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
    const placeReq: PlaceOrderRequest = {
      accountId: deployment.accountId,
      contractId: contract.id,
      type: 2, // Market
      side,
      size: 1,
      customTag: `probe_${deployment.id.replace(/-/g, "").slice(0, 8)}_${Date.now().toString(36)}`,
      stopLossBracket: { ticks: slBracketTicks, type: 4 } as BracketConfig,
    };
    const placeRes = await client.placeOrderRaw(placeReq);
    log("place order response", placeRes);

    // 4. Poll searchOpen for the SL order. Topstep returns the SL as a
    //    standalone Order with type=4 and side opposite to the entry.
    //    Filter by recent creation + opposite side + stop type. The entry
    //    market order itself won't appear (filled immediately).
    const slSide: OrderSide = side === 0 ? 1 : 0;
    let slOrder: Order | null = null;
    const POLL_DEADLINE = Date.now() + 3000;
    while (Date.now() < POLL_DEADLINE) {
      const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
      slOrder = open.find(
        (o) => o.contractId === contract.id && o.type === 4 && o.side === slSide && o.status === 1,
      ) ?? null;
      if (slOrder) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!slOrder) {
      const finalOpen = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
      log("FAILED to find SL order after 3s", { open: finalOpen });
      return NextResponse.json(
        { error: "SL order not found after place — position may be open without SL", steps },
        { status: 502 },
      );
    }
    log("SL order found", {
      id: slOrder.id,
      stopPrice: slOrder.stopPrice,
      status: slOrder.status,
    });

    // 5. Modify SL to a price clearly through market.
    //    - long position (side 0)  → SL is sell-stop. Through-market = ABOVE current.
    //    - short position (side 1) → SL is buy-stop. Through-market = BELOW current.
    const offset = 50 * contract.tickSize;
    const throughPrice = side === 0 ? lastClose + offset : lastClose - offset;
    const rounded = Math.round(throughPrice / contract.tickSize) * contract.tickSize;

    let modifyResponse: unknown = null;
    let modifyError: string | null = null;
    try {
      // Use raw passthrough so we capture { success, errorCode, errorMessage }
      // verbatim instead of throwing on success=false.
      const raw = await fetch("https://api.topstepx.com/api/Order/modify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          accountId: deployment.accountId,
          orderId: slOrder.id,
          stopPrice: rounded,
        }),
      });
      const text = await raw.text();
      try {
        modifyResponse = { status: raw.status, body: JSON.parse(text) };
      } catch {
        modifyResponse = { status: raw.status, bodyText: text };
      }
    } catch (err) {
      modifyError = err instanceof Error ? err.message : String(err);
    }
    log("modify SL through market", {
      attemptedStopPrice: rounded,
      lastClose,
      direction: side === 0 ? "ABOVE (long stop)" : "BELOW (short stop)",
      response: modifyResponse,
      error: modifyError,
    });

    // 6. Re-fetch open orders to see whether the SL survived, mutated, or vanished.
    const afterOpen = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    const afterSL = afterOpen.find((o) => o.id === slOrder!.id);
    log("post-modify SL state", {
      foundById: afterSL ? {
        id: afterSL.id,
        stopPrice: afterSL.stopPrice,
        status: afterSL.status,
        type: afterSL.type,
      } : null,
      allOpen: afterOpen.map((o) => ({
        id: o.id,
        type: o.type,
        side: o.side,
        status: o.status,
        stopPrice: o.stopPrice,
        limitPrice: o.limitPrice,
      })),
    });

    return NextResponse.json({
      ok: true,
      summary: {
        slOrderId: slOrder.id,
        originalStopPrice: slOrder.stopPrice,
        attemptedStopPrice: rounded,
        modifyHttpStatus: (modifyResponse as { status?: number } | null)?.status ?? null,
        slStillResting: !!afterSL && afterSL.status === 1,
        slPostStopPrice: afterSL?.stopPrice ?? null,
      },
      steps,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        steps,
      },
      { status: 502 },
    );
  }
}
