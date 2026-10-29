import { NextRequest, NextResponse } from "next/server";
import { getTopstepClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { requireSession } from "@/lib/auth/session";
import { getStrategy } from "@/lib/trading/strategies";
import { runBacktest } from "@/lib/trading/backtest";
import { daySessionForTicker } from "@/lib/trading/contracts/contract-specs";
import { TICKER_CONTRACT_MAP } from "@/lib/trading/broker-access/contract-resolver";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { cacheSymbolForTicker, fetchCachedBars } from "@/lib/data/cached-bars";
import type { BarData, BarUnit, Contract } from "@/lib/brokers/types";
import type { Timeframe, TickerSymbol } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";
import { chargedFeePerSide, parseSizingInput } from "@/lib/trading/backtest-sizing-input";
import { buildTradeRecords } from "@/app/api/backtest/trade-records";

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

/**
 * Sort contracts newest → oldest by the month-code/year suffix embedded in
 * their id or name (e.g. `CON.F.US.ENQ.M26` → Jun 2026).
 */
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
    startingBalance,
    sizing,
  } = body as {
    strategyKey: string;
    ticker: TickerSymbol;
    timeframe?: Timeframe;
    startDate: string;
    endDate: string;
    paramOverrides?: ParamValues;
    /** When true (default), backtest deducts TopstepX commission/fees per
     *  trade per the lookup table in lib/trading/fees.ts. Set false to see
     *  gross numbers. */
    includeFees?: boolean;
    /** Optional starting balance in dollars for account-blowup simulation. */
    startingBalance?: number;
    sizing?: unknown;
  };

  const feePerSideUsd = chargedFeePerSide(ticker, includeFees);
  const sizingInput = parseSizingInput(sizing, feePerSideUsd);
  if (!sizingInput.ok) {
    return NextResponse.json({ error: sizingInput.error }, { status: 400 });
  }

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
    // Contract discovery goes through `Broker.searchContracts` rather than
    // a client this route builds, but it is still Topstep discovery and
    // still upstream of the bar source: the walk below filters and sorts
    // on Topstep's dotted id, and `retrieveBars` is keyed on it. A
    // Databento backtest therefore still needs Topstep configured. Making
    // that untrue means sourcing the contract chain from the bar source,
    // which is Phase D work, not a member on `Broker`.
    const broker: Broker | null = await getTopstepClientIfConfigured();
    if (!broker) {
      return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
    }
    const allContracts = await broker.searchContracts(searchText);
    // Fuzzy search returns unrelated products — filter by exact id-root.
    const exactRoot = allContracts.filter((c) => (c.id.split(".")[3] ?? "") === idRoot);
    const active = exactRoot.find((c) => c.activeContract);
    if (!active) {
      return NextResponse.json({ error: `No active contract for ${ticker} (searched "${searchText}", root "${idRoot}")` }, { status: 404 });
    }

    // Topstep only returns history for the active contract and the most
    // recent prior expiry (the roll partner). Older contracts resolve via
    // `/Contract/searchById` but `/History/retrieveBars` returns empty for
    // them. So we build a 2-contract chain: active + one prior expiry.
    const activeRoot = active.id.split(".")[3] ?? "";
    const sameRootPrior = allContracts
      .filter((c) => (c.id.split(".")[3] ?? "") === activeRoot && c.id !== active.id)
      .sort((a, b) => (contractTimeKey(b) ?? 0) - (contractTimeKey(a) ?? 0));
    const priorRoll = sameRootPrior[0];

    const walk: Contract[] = priorRoll ? [active, priorRoll] : [active];

    const cfg = TIMEFRAME_TO_BAR[tf];
    const seen = new Set<string>();
    const collected: BarData[] = [];
    const contractsUsed: { id: string; name: string; firstBar: string | null; lastBar: string | null }[] = [];
    let chunkEnd = end;
    let barSource: "cache" | "topstep" = "topstep";

    // Cache path: only when (a) ticker is in the cache map and (b) the cache
    // actually has coverage for it. Falls through to the Topstep walk
    // otherwise — no silent shrink of the requested range.
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
        contractsUsed.push({
          id: `cache:${cacheSymbol}`,
          name: cacheSymbol,
          firstBar: collected[0]?.timestamp ?? null,
          lastBar: collected[collected.length - 1]?.timestamp ?? null,
        });
        barSource = "cache";
        const sourceLabel = cached.topstepContributed ? "cache+topstep" : "cache";
        console.log(
          `[backtest] source=${sourceLabel} symbol=${cacheSymbol} timeframe=${tf} bars=${collected.length} range=${start.toISOString()}..${end.toISOString()}`,
        );
      } else if (cached.reason === "htf-bucket-mismatch") {
        console.log(
          `[backtest] cache-skip symbol=${cacheSymbol} reason=htf-bucket-mismatch timeframe=${tf}`,
        );
      } else if (cached.reason === "no-bars") {
        console.log(
          `[backtest] cache-miss symbol=${cacheSymbol} range=${start.toISOString()}..${end.toISOString()} — falling through to Topstep walk`,
        );
      }
    }

    if (barSource === "topstep") {
      console.log(
        `[backtest] source=topstep ticker=${ticker} timeframe=${tf} range=${start.toISOString()}..${end.toISOString()}`,
      );
    }

    for (const contract of barSource === "cache" ? [] : walk) {
      if (chunkEnd.getTime() <= start.getTime()) break;

      let chunks = 0;
      let contractFirstBar: string | null = null;
      let contractLastBar: string | null = null;

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
        let newestMs = -Infinity;
        let addedThisChunk = 0;
        for (const b of apiBars) {
          if (seen.has(b.timestamp)) continue;
          seen.add(b.timestamp);
          addedThisChunk++;
          collected.push(b);
          const ms = new Date(b.timestamp).getTime();
          if (ms < oldestMs) oldestMs = ms;
          if (ms > newestMs) newestMs = ms;
        }

        if (addedThisChunk > 0) {
          const oldestIso = new Date(oldestMs).toISOString();
          const newestIso = new Date(newestMs).toISOString();
          if (contractFirstBar == null || oldestIso < contractFirstBar) contractFirstBar = oldestIso;
          if (contractLastBar == null || newestIso > contractLastBar) contractLastBar = newestIso;
        }

        if (addedThisChunk === 0) break;
        if (oldestMs <= start.getTime()) break;

        const nextEndMs = oldestMs - 1;
        if (nextEndMs >= chunkEnd.getTime()) break;
        chunkEnd = new Date(nextEndMs);
        if (chunkEnd.getTime() <= start.getTime()) break;
      }

      if (contractFirstBar || contractLastBar) {
        contractsUsed.push({
          id: contract.id,
          name: contract.name,
          firstBar: contractFirstBar,
          lastBar: contractLastBar,
        });
      }

      if (chunkEnd.getTime() <= start.getTime()) break;
    }

    const startMs = start.getTime();
    const endMs = end.getTime();
    const bars: BarData[] = collected
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .filter((b) => {
        const ms = new Date(b.timestamp).getTime();
        return ms >= startMs && ms <= endMs;
      });

    // Bar fetch is done. Open the SSE stream and run the evaluation loop
    // inside it, emitting progress and a final `done` payload that carries
    // the same response shape the JSON endpoint used to return.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        let closed = false;
        const safeClose = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };
        try {
          const result = await runBacktest({
            strategy,
            bars,
            paramOverrides,
            tickSize: active.tickSize,
            tickValue: active.tickValue,
            daySession: daySessionForTicker(ticker),
            feePerSideUsd,
            sizing: sizingInput.sizing,
            startingBalance: typeof startingBalance === "number" && startingBalance > 0 ? startingBalance : undefined,
            onProgress: (processed, total) => {
              if (closed) return;
              write({ type: "progress", processed, total });
            },
          });

          const actualStart = bars[0]?.timestamp ?? null;
          const actualEnd = bars[bars.length - 1]?.timestamp ?? null;
          const truncated =
            actualStart != null &&
            new Date(actualStart).getTime() - start.getTime() > 2 * 60 * 60 * 1000;

          write({
            type: "done",
            result: {
              contract: {
                id: active.id,
                name: active.name,
                tickSize: active.tickSize,
                tickValue: active.tickValue,
              },
              contractsUsed,
              ticker,
              timeframe: tf,
              requestedRange: { from: start.toISOString(), to: end.toISOString() },
              actualRange: actualStart && actualEnd ? { from: actualStart, to: actualEnd } : null,
              truncated,
              includeFees,
              feePerSideUsd,
              result,
              tradeRecords: buildTradeRecords(result.trades, bars, active.tickSize),
            },
          });
        } catch (err) {
          write({ type: "error", message: err instanceof Error ? err.message : "Backtest failed" });
        } finally {
          safeClose();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backtest failed" },
      { status: 500 },
    );
  }
}
