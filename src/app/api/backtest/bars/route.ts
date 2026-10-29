import { NextRequest, NextResponse } from "next/server";
import { getTopstepClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { requireSession } from "@/lib/auth/session";
import { TICKER_CONTRACT_MAP } from "@/lib/trading/broker-access/contract-resolver";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { cacheSymbolForTicker, fetchCachedBars } from "@/lib/data/cached-bars";
import type { BarData, BarUnit } from "@/lib/brokers/types";
import type { Timeframe, TickerSymbol } from "@/lib/trading/domain";

const TIMEFRAME_TO_BAR: Record<Timeframe, { unit: BarUnit; unitNumber: number }> = {
  "1m": { unit: 2, unitNumber: 1 },
  "3m": { unit: 2, unitNumber: 3 },
  "5m": { unit: 2, unitNumber: 5 },
  "15m": { unit: 2, unitNumber: 15 },
  "30m": { unit: 2, unitNumber: 30 },
  "1h": { unit: 3, unitNumber: 1 },
  "4h": { unit: 3, unitNumber: 4 },
  "1d": { unit: 4, unitNumber: 1 },
};

// Per-trade window is always small (pre + duration + post). Hard cap to
// keep a malformed range from spamming the response.
const MAX_BARS = 2000;

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const ticker = url.searchParams.get("ticker") as TickerSymbol | null;
  const timeframe = url.searchParams.get("timeframe") as Timeframe | null;
  const fromIso = url.searchParams.get("from");
  const toIso = url.searchParams.get("to");

  if (!ticker || !timeframe || !fromIso || !toIso) {
    return NextResponse.json(
      { error: "Missing ticker, timeframe, from, or to" },
      { status: 400 },
    );
  }

  const cfg = TIMEFRAME_TO_BAR[timeframe];
  if (!cfg) {
    return NextResponse.json({ error: `Unknown timeframe: ${timeframe}` }, { status: 400 });
  }

  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
  }
  if (from >= to) {
    return NextResponse.json({ error: "from must be before to" }, { status: 400 });
  }

  const mapping = TICKER_CONTRACT_MAP[ticker];
  if (!mapping) {
    return NextResponse.json({ error: `Unknown ticker: ${ticker}` }, { status: 400 });
  }
  const { search: searchText, root: idRoot } = mapping;

  try {
    // See /api/backtest: contract discovery is a `Broker` call now, but it
    // is still Topstep-shaped and still upstream of the bar source.
    const broker: Broker | null = await getTopstepClientIfConfigured();
    if (!broker) {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }

    const cacheSymbol = cacheSymbolForTicker(ticker);
    const collected: BarData[] = [];

    // Both paths need the active contract id — the cache path chains a
    // Topstep tail onto it when the trade window straddles the cache
    // cutoff, the fallback path fetches from it directly. The main
    // backtest route walks active + prior roll, but a per-trade window
    // never straddles a roll (one contract was active when the trade ran).
    const allContracts = await broker.searchContracts(searchText);
    const exactRoot = allContracts.filter((c) => (c.id.split(".")[3] ?? "") === idRoot);
    const active = exactRoot.find((c) => c.activeContract);
    if (!active) {
      return NextResponse.json({ error: `No active contract for ${ticker}` }, { status: 404 });
    }

    if (cacheSymbol) {
      const cached = await fetchCachedBars({
        cacheSymbol,
        timeframe,
        from,
        to,
        tailContractId: active.id,
      });
      // A loop, not push(...bars): a wide range overflows the call stack as spread arguments.
      if (cached.kind === "bars") for (const bar of cached.bars) collected.push(bar);
    }

    if (collected.length === 0) {
      const apiBars = await marketDataRegistry.historical().retrieveBars({
        contractId: active.id,
        live: false,
        startTime: from.toISOString(),
        endTime: to.toISOString(),
        unit: cfg.unit,
        unitNumber: cfg.unitNumber,
        limit: MAX_BARS,
        includePartialBar: false,
      });
      collected.push(...apiBars);
    }

    const bars: BarData[] = collected
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(0, MAX_BARS);

    return NextResponse.json({ bars, timeframe });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch bars" },
      { status: 500 },
    );
  }
}
