import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { ContractResolver } from "@/lib/trading/broker-access/contract-resolver";
import { getDeployment } from "@/lib/db/deployments";

/**
 * Flatten the deployment's resolved contract for the given account via
 * /api/Position/closeContract, then cancel any resting orders left on the
 * same contract. closeContract only flattens the position — orphaned
 * trailing stops / brackets keep working and can re-enter the market, so
 * we sweep them after the close.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: { deploymentId?: string };
  try {
    body = (await request.json()) as { deploymentId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { deploymentId } = body;
  if (!deploymentId) return NextResponse.json({ error: "deploymentId required" }, { status: 400 });

  const deployment = getDeployment(deploymentId);
  if (!deployment) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const token = await topstepBrowserToken();
  if (!token) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }
  const client = new TopstepClient();
  client.setToken(token);

  try {
    const resolver = new ContractResolver(client);
    const contract = await resolver.resolve(deployment.ticker);

    const raw = await fetch("https://api.topstepx.com/api/Position/closeContract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ accountId: deployment.accountId, contractId: contract.id }),
    });
    const text = await raw.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }

    // Sweep any resting working orders on this contract for this account.
    // Trailing stops (and any orphaned bracket children) survive
    // /Position/closeContract, so we cancel them explicitly.
    const cancelled: Array<{ id: number; ok: boolean; error?: string }> = [];
    try {
      const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
      const restingOnContract = open.filter(
        (o) => o.contractId === contract.id && o.status === 1,
      );
      for (const order of restingOnContract) {
        try {
          await client.cancelOrder(order.id, deployment.accountId);
          cancelled.push({ id: order.id, ok: true });
        } catch (err) {
          cancelled.push({
            id: order.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      cancelled.push({
        id: -1,
        ok: false,
        error: `searchOpenOrders failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return NextResponse.json({
      ok: raw.ok,
      status: raw.status,
      contractId: contract.id,
      response: parsed,
      cancelledOrders: cancelled,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
