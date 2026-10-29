"use client";

import { useState } from "react";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { getStrategy } from "@/lib/trading/strategies";
import { getCachedBars } from "@/lib/data/bar-cache-idb";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import type { ParamValues } from "@/lib/trading/strategy-types";
import type { BacktestResult, BacktestSizing } from "@/lib/trading/backtest";
import type { TickerSymbol, Timeframe } from "@/lib/trading/domain";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";

interface ContractUsed {
  id: string;
  name: string;
  firstBar: string | null;
  lastBar: string | null;
}

export interface BacktestResponse {
  contract: { id: string; name: string; tickSize: number; tickValue: number };
  contractsUsed?: ContractUsed[];
  /** Echoed back from the request so the per-trade chart can call the
   *  `/api/backtest/bars` endpoint without re-deriving the ticker from
   *  the contract name. */
  ticker: TickerSymbol;
  timeframe: Timeframe;
  requestedRange: { from: string; to: string };
  actualRange: { from: string; to: string } | null;
  truncated: boolean;
  includeFees: boolean;
  feePerSideUsd: number;
  result: BacktestResult;
  /** `result.trades` as `trades.jsonl` rows, built server-side by the CLI's
   *  own `buildTradeRecord` — what the run reader steps through. */
  tradeRecords: CliTradeRecord[];
}

/** The window a fresh runner opens on, and what a reset returns to. */
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_INCLUDE_FEES = true;

/**
 * Topstep gates intraday history to the active contract + most recent
 * prior expiry — typically ~3 months on /NQ. Anything older returns
 * success with empty bars. Cap the picker at 90 days so users don't
 * waste a click submitting unbacktest-able ranges.
 */
export const MAX_LOOKBACK_DAYS = 90;

export function toDateInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateInputValue(d);
}

interface RunnerArgs {
  strategyKey: string;
  ticker: TickerSymbol;
  params: ParamValues;
  /** Absent is one contract. */
  sizing?: BacktestSizing;
}

export interface BacktestProgress {
  processed: number;
  total: number;
}

export interface BacktestRunner {
  /** Strategy key the runner is bound to. Surfaced so a consumer can look up
   *  the module without needing it threaded as a separate prop. */
  strategyKey: string;
  params: ParamValues;
  startDate: string;
  setStartDate: (d: string) => void;
  endDate: string;
  setEndDate: (d: string) => void;
  includeFees: boolean;
  setIncludeFees: (v: boolean) => void;
  running: boolean;
  error: string | null;
  result: BacktestResponse | null;
  /** Streaming evaluation progress while the SSE backtest is running.
   *  Null between runs; non-null after the first progress event arrives. */
  progress: BacktestProgress | null;
  /** Whether a run is allowed in the current state (token + dates valid). */
  canRun: boolean;
  /** True when the last completed run satisfied bars from the IDB cache
   *  and skipped the bar-fetch path. Resets to false at the start of each
   *  new run. */
  barsFromCache: boolean;
  applyPreset: (days: number) => void;
  run: () => Promise<void>;
}

/**
 * Hoisted backtest state. *Try settings* on the Playbook page owns the
 * runner, so its Run button and the result below it render the same loading
 * state and error; nothing it renders owns its own fetch state.
 */
export function useBacktestRunner({ strategyKey, ticker, params, sizing }: RunnerArgs): BacktestRunner {
  const { token } = useTrading();
  const strategy = getStrategy(strategyKey);

  const [startDate, setStartDateRaw] = useState(daysAgo(DEFAULT_LOOKBACK_DAYS));
  const [endDate, setEndDateRaw] = useState(toDateInputValue(new Date()));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [includeFees, setIncludeFees] = useState(DEFAULT_INCLUDE_FEES);
  const [progress, setProgress] = useState<BacktestProgress | null>(null);
  const [barsFromCache, setBarsFromCache] = useState(false);

  const timeframe: Timeframe =
    (params.timeframe as Timeframe | undefined) ?? strategy?.config.timeframe ?? "5m";

  // Wrap date setters to clear stale results whenever the range changes.
  const setStartDate = (v: string) => { setStartDateRaw(v); setResult(null); };
  const setEndDate = (v: string) => { setEndDateRaw(v); setResult(null); };

  const applyPreset = (days: number) => {
    setStartDateRaw(daysAgo(days));
    setEndDateRaw(toDateInputValue(new Date()));
    setResult(null);
  };

  const canRun = Boolean(token && !running && startDate && endDate);

  const run = async () => {
    if (!token) {
      setError("Not connected to Topstep.");
      return;
    }
    if (!startDate || !endDate) {
      setError("Pick a start and end date.");
      return;
    }
    if (new Date(startDate) >= new Date(endDate)) {
      setError("Start date must be before end date.");
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setBarsFromCache(false);

    try {
      const startIso = new Date(`${startDate}T00:00:00`).toISOString();
      const endIso = new Date(`${endDate}T23:59:59`).toISOString();
      const cacheKey = `${ticker}|${timeframe}|${startIso}|${endIso}`;
      const cached = await getCachedBars(cacheKey);

      const res = cached
        ? await fetch("/api/backtest/eval", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              strategyKey,
              bars: cached.bars,
              tickSize: cached.tickSize,
              tickValue: cached.tickValue,
              paramOverrides: params,
              includeFees,
              // The route takes a number here over `includeFees`, so sending
              // the ticker's fee unconditionally charged fees on a cached run
              // with the box unticked.
              feePerSideUsd: includeFees ? feePerSideFor(ticker) : 0,
              sizing,
              ticker,
              timeframe,
              contract: {
                id: cached.contractId,
                name: cached.contractName,
                tickSize: cached.tickSize,
                tickValue: cached.tickValue,
              },
              requestedRange: { from: startIso, to: endIso },
            }),
          })
        : await fetch("/api/backtest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              strategyKey,
              ticker,
              timeframe,
              startDate: startIso,
              endDate: endIso,
              paramOverrides: params,
              includeFees,
              sizing,
            }),
          });

      if (!res.ok || !res.body) {
        // Pre-stream failures (auth, validation) still come back as JSON.
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Backtest failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: BacktestResponse | null = null;
      let streamError: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // An SSE event may have multiple `data:` lines; concatenate them.
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          const payload = JSON.parse(dataLines.join("\n")) as
            | { type: "progress"; processed: number; total: number }
            | { type: "done"; result: BacktestResponse }
            | { type: "error"; message: string };
          if (payload.type === "progress") {
            setProgress({ processed: payload.processed, total: payload.total });
          } else if (payload.type === "done") {
            finalResult = payload.result;
          } else {
            streamError = payload.message;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      if (!finalResult) throw new Error("Backtest stream closed without a result");
      setResult(finalResult);
      setBarsFromCache(Boolean(cached));

    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return {
    strategyKey,
    params,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    includeFees,
    setIncludeFees,
    running,
    error,
    result,
    progress,
    canRun,
    barsFromCache,
    applyPreset,
    run,
  };
}

