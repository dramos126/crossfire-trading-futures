import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getStrategy } from "@/lib/trading/strategies";
import { runBacktest } from "@/lib/trading/backtest";
import { daySessionForTicker } from "@/lib/trading/contracts/contract-specs";
import type { BarData } from "@/lib/brokers/types";
import type { TickerSymbol, Timeframe } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";
import { chargedFeePerSide, parseSizingInput } from "@/lib/trading/backtest-sizing-input";
import { buildTradeRecords } from "@/app/api/backtest/trade-records";

interface ContractUsed {
  id: string;
  name: string;
  firstBar: string | null;
  lastBar: string | null;
}

interface EvalBody {
  strategyKey: string;
  bars: BarData[];
  tickSize: number;
  tickValue: number;
  paramOverrides?: ParamValues;
  includeFees?: boolean;
  feePerSideUsd?: number;
  startingBalance?: number;
  ticker: TickerSymbol;
  timeframe: Timeframe;
  contract: { id: string; name: string; tickSize: number; tickValue: number };
  contractsUsed?: ContractUsed[];
  requestedRange: { from: string; to: string };
  sizing?: unknown;
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const body = (await request.json()) as EvalBody;
  const {
    strategyKey,
    bars,
    tickSize,
    tickValue,
    paramOverrides = {},
    includeFees = true,
    feePerSideUsd: feeOverride,
    startingBalance,
    ticker,
    timeframe,
    contract,
    contractsUsed,
    requestedRange,
  } = body;

  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    return NextResponse.json({ error: `Unknown strategy: ${strategyKey}` }, { status: 400 });
  }
  if (!Array.isArray(bars)) {
    return NextResponse.json({ error: "Missing bars" }, { status: 400 });
  }
  if (!contract || !requestedRange) {
    return NextResponse.json({ error: "Missing contract or requestedRange" }, { status: 400 });
  }

  const feePerSideUsd = chargedFeePerSide(ticker, includeFees, feeOverride);
  const sizingInput = parseSizingInput(body.sizing, feePerSideUsd);
  if (!sizingInput.ok) {
    return NextResponse.json({ error: sizingInput.error }, { status: 400 });
  }

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
          tickSize,
          tickValue,
          daySession: daySessionForTicker(ticker),
          feePerSideUsd,
          sizing: sizingInput.sizing,
          startingBalance:
            typeof startingBalance === "number" && startingBalance > 0 ? startingBalance : undefined,
          onProgress: (processed, total) => {
            if (closed) return;
            write({ type: "progress", processed, total });
          },
        });

        const actualStart = bars[0]?.timestamp ?? null;
        const actualEnd = bars[bars.length - 1]?.timestamp ?? null;
        const truncated =
          actualStart != null &&
          new Date(actualStart).getTime() - new Date(requestedRange.from).getTime() >
            2 * 60 * 60 * 1000;

        write({
          type: "done",
          result: {
            contract,
            contractsUsed: contractsUsed ?? [],
            ticker,
            timeframe,
            requestedRange,
            actualRange: actualStart && actualEnd ? { from: actualStart, to: actualEnd } : null,
            truncated,
            includeFees,
            feePerSideUsd,
            result,
            tradeRecords: buildTradeRecords(result.trades, bars, tickSize),
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
}
