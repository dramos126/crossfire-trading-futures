/**
 * Translation between the cache's `Bar` shape (bigint ns timestamps, bigint
 * volume) and the backtest walker's `BarData` shape (ISO string timestamps,
 * number volume). The walker is unchanged — it stays on `BarData`.
 *
 * Lossy paths to be aware of:
 * - bigint ns → JS Date drops sub-millisecond precision (Date is ms). This is
 *   acceptable for the bar walker; OHLCV-1m bars are minute-aligned.
 * - bigint volume → number is safe up to 2^53; futures volume rarely
 *   approaches this within a 1m bar.
 */
import type { Bar } from "./bar-source";
import type { BarData } from "@/lib/brokers/types";

const NS_PER_MS = BigInt(1_000_000);

export function barToBarData(bar: Bar): BarData {
  const ms = Number(bar.tsUtc / NS_PER_MS);
  return {
    timestamp: new Date(ms).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: Number(bar.volume),
  };
}

export function barDataToBar(barData: BarData, symbol: string): Bar {
  return {
    tsUtc: BigInt(new Date(barData.timestamp).getTime()) * NS_PER_MS,
    open: barData.open,
    high: barData.high,
    low: barData.low,
    close: barData.close,
    volume: BigInt(Math.trunc(barData.volume)),
    symbol,
  };
}
