import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { getTradovateClientIfConfigured, tradovateAuthError } from "@/lib/trading/engine/engine-singleton";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { contractId } = await request.json();
  if (!contractId || typeof contractId !== "string") {
    return NextResponse.json({ error: "Missing contractId" }, { status: 400 });
  }

  // Tradovate stringifies numeric contractIds (e.g. "12345"); Topstep ids are
  // dotted (e.g. "CON.F.US.MNQ.M25"). A purely numeric id → Tradovate numeric
  // lookup. A dotted id → Topstep lookup. Anything else (e.g. "MNQM6") is a
  // Tradovate dated symbol — translate via engine cache first, then fall back
  // to a fresh Tradovate suggest+spec call.
  const asNum = Number(contractId);
  const isNumeric = /^\d+$/.test(contractId) && Number.isFinite(asNum);
  // Dotted (CON.F.US.MNQ.M25) or hyphenated (NQ-2025) → Topstep symbol.
  // Only purely alphanumeric non-dotted strings (e.g. "MNQM6") are Tradovate dated symbols.
  const isTopstepSymbol = contractId.includes(".") || contractId.includes("-");

  try {
    if (isNumeric) {
      // Engine singleton, never a fresh client — see /api/positions. This
      // route is polled by the browser's contract-meta loop, so
      // `new TradovateClient(); await client.authenticate();` re-authed
      // every 2.5s for as long as the lookup kept failing, which trips the
      // broker-unavailable circuit and auto-pauses deployments.
      const client = await getTradovateClientIfConfigured();
      if (!client) {
        // No empty form to answer with here, so say we cannot answer
        // rather than 404-ing a contract that may well exist. Null also
        // means the first auth failed, so prefer the reason the plugin
        // kept over the not-configured guess.
        return NextResponse.json(
          { error: tradovateAuthError() ?? "Tradovate is not configured" },
          { status: 503 },
        );
      }
      const spec = await client.getContractSpec(asNum);
      if (!spec) {
        return NextResponse.json(
          { error: `Tradovate contract spec not found for ${contractId}` },
          { status: 404 },
        );
      }
      return NextResponse.json({
        contract: {
          id: contractId,
          name: contractId,
          tickSize: spec.tickSize,
          tickValue: spec.tickValue,
        },
      });
    }

    // One token for both Topstep branches below. The plugin caches, so the
    // second call was free — but two calls read as two different questions,
    // and there is only one: does this install have a Topstep JWT.
    const topstepToken = await topstepBrowserToken();

    // Tradovate dated symbol (e.g. "MNQM6", "MYMM6"): non-numeric, no dots or hyphens.
    // Ask the engine which id this contract's market data arrives under — a
    // live-sub scan first, a contract resolve second — and read tick params
    // off the Topstep side without a Tradovate call. The resolve is what
    // answers for a manual position, which no sub covers.
    if (!isTopstepSymbol) {
      const topstepId = await handle.marketDataContractId(contractId);
      if (topstepId && topstepToken) {
        const client = new TopstepClient();
        client.setToken(topstepToken);
        const contract = await client.getContractById(topstepId);
        // Rekey under the original Tradovate symbol so contractMeta[position.contractId] resolves.
        return NextResponse.json({
          contract: {
            id: contractId,
            name: contractId,
            tickSize: contract.tickSize,
            tickValue: contract.tickValue,
          },
        });
      }
    }

    // Dotted, hyphenated, or non-dotted engine cache miss → Topstep lookup.
    if (!topstepToken) {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }
    const client = new TopstepClient();
    client.setToken(topstepToken);
    const contract = await client.getContractById(contractId);
    return NextResponse.json({ contract });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch contract" },
      { status: 500 },
    );
  }
}
