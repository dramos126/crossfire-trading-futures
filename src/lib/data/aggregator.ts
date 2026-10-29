/**
 * 1m → Nm bar aggregation by absolute timestamp bucket.
 *
 * The cache stores 1m bars; the backtest walker needs bars at the strategy's
 * timeframe (typically 5m). Bucketing is keyed by minutes-since-epoch divided
 * by `targetMinutes`, so sparse input (gaps from sessions, weekends, holidays)
 * collapses naturally — empty buckets produce no output, and a partial bucket
 * is still emitted for whatever bars it contains. Never group by "take next N
 * bars": that would shift bucket boundaries across gaps and silently misalign
 * indicator timestamps.
 */
import type { Bar } from "./bar-source";

const NS_PER_MINUTE = BigInt(60_000_000_000);

export function aggregateBars(bars: Bar[], targetMinutes: number): Bar[] {
  if (!Number.isInteger(targetMinutes) || targetMinutes <= 0) {
    throw new Error(`targetMinutes must be a positive integer (got ${targetMinutes})`);
  }
  if (targetMinutes === 1) return bars;
  if (bars.length === 0) return [];

  const buckets = new Map<number, Bar[]>();
  for (const bar of bars) {
    const minutes = Number(bar.tsUtc / NS_PER_MINUTE);
    const bucketStartMin = Math.floor(minutes / targetMinutes) * targetMinutes;
    let arr = buckets.get(bucketStartMin);
    if (!arr) {
      arr = [];
      buckets.set(bucketStartMin, arr);
    }
    arr.push(bar);
  }

  const out: Bar[] = [];
  for (const [bucketStartMin, group] of buckets) {
    // Sort within the bucket so first-bar/last-bar attribution is deterministic
    // even when input bars within a bucket arrive out of order.
    group.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
    const first = group[0];
    const last = group[group.length - 1];
    let high = first.high;
    let low = first.low;
    let volume = BigInt(0);
    for (const b of group) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
    }
    out.push({
      tsUtc: BigInt(bucketStartMin) * NS_PER_MINUTE,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      symbol: first.symbol,
    });
  }

  out.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
  return out;
}
