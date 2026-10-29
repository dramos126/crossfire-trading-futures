import { NextRequest, NextResponse } from "next/server";
import { getTopstepClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { requireSession } from "@/lib/auth/session";
import { getStrategy } from "@/lib/trading/strategies";
import { runBacktest } from "@/lib/trading/backtest";
import { daySessionForTicker } from "@/lib/trading/contracts/contract-specs";
import { TICKER_CONTRACT_MAP } from "@/lib/trading/broker-access/contract-resolver";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { cacheSymbolForTicker, fetchCachedBars } from "@/lib/data/cached-bars";
import { exportResultsFromBarsAsJson } from "@/lib/trading/backtest-export";
import type { BarData, BarUnit, Contract } from "@/lib/brokers/types";
import type { Timeframe, TickerSymbol } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";

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

const CHUNK_BARS = 10_000;
const MAX_CHUNKS_PER_CONTRACT = 50;
const MONTH_CODES = "FGHJKMNQUVXZ";

const PRE_BARS = 30;
const POST_BARS = 15;

/**
 * Build a short filename suffix from params that differ from their schema
 * defaults. E.g. `{ maxStopTicks: 200, stopMode: "atr" }` with defaults
 * `{ maxStopTicks: 0, stopMode: "opposite-edge" }` →
 * `-maxStopTicks200-stopModeAtr`
 */
function buildParamSuffix(
  schema: Record<string, { default: unknown }>,
  overrides: ParamValues,
): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(overrides)) {
    const def = schema[key]?.default;
    if (def === undefined || val === def) continue;
    // Skip object/array params (sessions, pauseWindows, etc.) — not filename-safe
    if (typeof val === "object" || Array.isArray(val)) continue;
    let compact: string;
    if (typeof val === "boolean") {
      compact = val ? "t" : "f";
    } else if (typeof val === "string") {
      compact = val.replace(/[^a-zA-Z0-9.]/g, "");
    } else {
      compact = String(val);
    }
    parts.push(`${key}${compact}`);
  }
  if (parts.length === 0) return "";
  // Cap at 80 chars total to keep filenames sane
  let suffix = "-" + parts.join("-");
  if (suffix.length > 80) suffix = suffix.slice(0, 77) + "...";
  return suffix;
}

function contractTimeKey(c: Contract): number | null {
  const idTail = c.id.split(".").pop() ?? "";
  let m = idTail.match(/^([FGHJKMNQUVXZ])(\d{2})$/i);
  if (!m) m = c.name.match(/([FGHJKMNQUVXZ])(\d{1,2})$/i);
  if (!m) return null;
  const monthIdx = MONTH_CODES.indexOf(m[1].toUpperCase());
  let year = parseInt(m[2], 10);
  if (m[2].length === 1) {
    const decade = Math.floor(new Date().getFullYear() / 10) * 10;
    year = decade + year;
  } else {
    year = 2000 + year;
  }
  return year * 12 + monthIdx;
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const body = await request.json();
  const {
    strategyKey,
    ticker,
    timeframe,
    startDate,
    endDate,
    paramOverrides = {},
    includeFees = true,
    preBars = PRE_BARS,
    postBars = POST_BARS,
  } = body as {
    strategyKey: string;
    ticker: TickerSymbol;
    timeframe?: Timeframe;
    startDate: string;
    endDate: string;
    paramOverrides?: ParamValues;
    includeFees?: boolean;
    preBars?: number;
    postBars?: number;
  };

  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    return NextResponse.json({ error: `Unknown strategy: ${strategyKey}` }, { status: 400 });
  }
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "Missing startDate or endDate" }, { status: 400 });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }
  if (start >= end) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  const tf = timeframe ?? strategy.config.timeframe;
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
    const allContracts = await broker.searchContracts(searchText);
    const exactRoot = allContracts.filter((c) => (c.id.split(".")[3] ?? "") === idRoot);
    const active = exactRoot.find((c) => c.activeContract);
    if (!active) {
      return NextResponse.json(
        { error: `No active contract for ${ticker} (searched "${searchText}", root "${idRoot}")` },
        { status: 404 },
      );
    }

    const activeRoot = active.id.split(".")[3] ?? "";
    const sameRootPrior = allContracts
      .filter((c) => (c.id.split(".")[3] ?? "") === activeRoot && c.id !== active.id)
      .sort((a, b) => (contractTimeKey(b) ?? 0) - (contractTimeKey(a) ?? 0));
    const priorRoll = sameRootPrior[0];
    const walk: Contract[] = priorRoll ? [active, priorRoll] : [active];

    const cfg = TIMEFRAME_TO_BAR[tf];
    const seen = new Set<string>();
    const collected: BarData[] = [];
    let chunkEnd = end;
    let barSource: "cache" | "topstep" = "topstep";

    const cacheSymbol = cacheSymbolForTicker(ticker);
    if (cacheSymbol) {
      const cached = await fetchCachedBars({
        cacheSymbol,
        timeframe: tf,
        from: start,
        to: end,
        tailContractId: active.id,
      });
      if (cached.kind === "bars") {
        // A loop, not push(...bars): years of 1m bars overflow the call stack as spread arguments.
        for (const bar of cached.bars) collected.push(bar);
        barSource = "cache";
      }
    }

    if (barSource === "topstep") {
      for (const contract of walk) {
        if (chunkEnd.getTime() <= start.getTime()) break;
        let chunks = 0;
        while (chunks < MAX_CHUNKS_PER_CONTRACT) {
          const apiBars = await marketDataRegistry.historical().retrieveBars({
            contractId: contract.id,
            live: false,
            startTime: start.toISOString(),
            endTime: chunkEnd.toISOString(),
            unit: cfg.unit,
            unitNumber: cfg.unitNumber,
            limit: CHUNK_BARS,
            includePartialBar: false,
          });
          chunks++;
          if (apiBars.length === 0) break;

          let oldestMs = Infinity;
          let addedThisChunk = 0;
          for (const b of apiBars) {
            if (seen.has(b.timestamp)) continue;
            seen.add(b.timestamp);
            addedThisChunk++;
            collected.push(b);
            const ms = new Date(b.timestamp).getTime();
            if (ms < oldestMs) oldestMs = ms;
          }
          if (addedThisChunk === 0) break;
          if (oldestMs <= start.getTime()) break;
          const nextEndMs = oldestMs - 1;
          if (nextEndMs >= chunkEnd.getTime()) break;
          chunkEnd = new Date(nextEndMs);
          if (chunkEnd.getTime() <= start.getTime()) break;
        }
        if (chunkEnd.getTime() <= start.getTime()) break;
      }
    }

    const bars: BarData[] = collected.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const feePerSideUsd = includeFees ? feePerSideFor(ticker) : 0;
    const result = await runBacktest({
      strategy,
      bars,
      paramOverrides,
      tickSize: active.tickSize,
      tickValue: active.tickValue,
      daySession: daySessionForTicker(ticker),
      feePerSideUsd,
    });

    const json = exportResultsFromBarsAsJson({
      result,
      bars,
      preBars,
      postBars,
      config: {
        strategy: strategyKey,
        instrument: active.name,
        tf,
        params: paramOverrides as Record<string, unknown>,
      },
    });

    const paramSuffix = buildParamSuffix(strategy.params, paramOverrides);
    const filename = `backtest-${active.name}-${tf}-${new Date().toISOString().slice(0, 10)}${paramSuffix}.json`;

    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 },
    );
  }
}
