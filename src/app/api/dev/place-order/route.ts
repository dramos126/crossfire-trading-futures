import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { ContractResolver } from "@/lib/trading/broker-access/contract-resolver";
import { buildCustomTag } from "@/lib/trading/engine/engine";
import { getStrategy } from "@/lib/trading/strategies";
import { defaultParamValues, migrateLegacyParamOverrides } from "@/lib/trading/strategy-types";
import { getDeployment } from "@/lib/db/deployments";
import type {
  OrderSide,
  PlaceOrderRequest,
  BracketConfig,
  OrderType,
} from "@/lib/brokers/types";

interface DevPlaceOrderBody {
  deploymentId: string;
  side: OrderSide;
  sendNullPrices?: boolean;
  bracketTpType?: OrderType;
  bracketSlType?: OrderType;
  customTagSuffix?: string;
  /** Override the deployment's ticker (e.g. "/ES", "/MES") to test different contracts. */
  tickerOverride?: string;
  /** Override the contract id directly, bypassing the resolver. */
  contractIdOverride?: string;
  /** Omit TP/SL brackets entirely — pure market order. */
  skipBrackets?: boolean;
  /** Override size (deployment default if omitted). */
  sizeOverride?: number;
  /** Override account id — defaults to the deployment's accountId. */
  accountIdOverride?: number;
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: DevPlaceOrderBody;
  try {
    body = (await request.json()) as DevPlaceOrderBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    deploymentId,
    side,
    sendNullPrices,
    bracketTpType,
    bracketSlType,
    customTagSuffix,
    tickerOverride,
    contractIdOverride,
    skipBrackets,
    sizeOverride,
    accountIdOverride,
  } = body;
  if (!deploymentId || (side !== 0 && side !== 1)) {
    return NextResponse.json({ error: "deploymentId and side (0|1) required" }, { status: 400 });
  }

  const deployment = getDeployment(deploymentId);
  if (!deployment) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const strategy = getStrategy(deployment.strategyKey);
  if (!strategy) return NextResponse.json({ error: "Strategy not found" }, { status: 404 });

  const params = {
    ...defaultParamValues(strategy.params),
    ...migrateLegacyParamOverrides(deployment.strategyKey, deployment.paramValues, { deploymentId: deployment.id }),
  } as Record<string, number | boolean | string>;
  // This probe does not size off the account's risk posture, deliberately:
  // it invents its own 50-tick stop below, so the sizer's answer would be a
  // contract count for a bracket no strategy asked for. `sizeOverride` from
  // the request body is the only knob, and one contract is the default —
  // there is no operator-typed count on a deployment to fall back to.
  let size = 1;
  if (sizeOverride != null) {
    if (!Number.isInteger(sizeOverride) || sizeOverride < 1) {
      return NextResponse.json(
        { error: "sizeOverride must be a positive integer" },
        { status: 400 },
      );
    }
    size = sizeOverride;
  }
  // Dev tool only — no signal to derive a bracket from, so the probe invents
  // one: a 50-tick stop at 2R. Both numbers are this route's, not the
  // deployment's; `riskRewardRatio` is deleted and a strategy's own reward
  // constant belongs to a signal this probe never asked for. Caller can pass
  // `skipBrackets` for a pure market order, or `bracketTpType` /
  // `bracketSlType` to override.
  const sl = 50;
  const tp = sl * 2;

  const topstepToken = await topstepBrowserToken();
  if (!topstepToken) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }
  const client = new TopstepClient();
  client.setToken(topstepToken);

  let contractId: string;
  if (contractIdOverride) {
    contractId = contractIdOverride;
  } else {
    try {
      const resolver = new ContractResolver(client);
      const tickerToUse = (tickerOverride ?? deployment.ticker) as typeof deployment.ticker;
      const contract = await resolver.resolve(tickerToUse);
      contractId = contract.id;
    } catch (err) {
      return NextResponse.json(
        { error: `Contract resolve failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
  }

  const order: PlaceOrderRequest = {
    accountId: accountIdOverride ?? deployment.accountId,
    contractId,
    type: strategy.config.entryType,
    side,
    size,
    customTag: customTagSuffix
      ? `d_${deployment.id.replace(/-/g, "").slice(0, 8)}_${customTagSuffix}`
      : buildCustomTag("e", deployment.id),
  };

  if (!skipBrackets) {
    // Topstep brackets use signed offsets: long TP +, SL -; short TP -, SL +.
    const tpTicks = side === 0 ? tp : -tp;
    const slTicks = side === 0 ? -sl : sl;
    const tpBracket: BracketConfig = { ticks: tpTicks, type: bracketTpType ?? 1 };
    const slBracket: BracketConfig = { ticks: slTicks, type: bracketSlType ?? 4 };
    order.takeProfitBracket = tpBracket;
    order.stopLossBracket = slBracket;
  }

  // Optional: mirror the docs sample by sending explicit nulls for unused price fields.
  const payload: Record<string, unknown> = { ...order };
  if (sendNullPrices) {
    payload.limitPrice = null;
    payload.stopPrice = null;
    payload.trailPrice = null;
  }

  try {
    const result = await client.placeOrderRaw(payload);
    return NextResponse.json({ payload, response: result });
  } catch (err) {
    return NextResponse.json(
      {
        payload,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
