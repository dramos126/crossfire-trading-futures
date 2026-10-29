/**
 * BarSource adapter over the Topstep market-data provider's `retrieveBars`
 * for 1m OHLCV.
 *
 * Used by Phase 4.5 to extend the parquet cache (2020–2025) into the live
 * present via `ChainedBarSource`. The cache covers the historical bulk;
 * Topstep fills the post-cache tail. Coverage is reported as nulls — the
 * caller decides when this source is in scope, not the source itself.
 *
 * The `provider` argument is the *Topstep* provider specifically, not
 * whichever provider happens to be active: this source exists to be the
 * live-capable tail spliced under a cache-backed primary, so handing it a
 * cache-backed provider would make the chain read the same store twice.
 * `cached-bars.ts` is the one place that binds it.
 */
import type { MarketDataProvider } from "@/lib/market-data/provider";
import type { Bar, BarSource, BarSourceCoverage } from "./bar-source";
import { barDataToBar } from "./bar-source-adapter";

const CHUNK_BARS = 10_000;
const MAX_CHUNKS = 50;

export class TopstepBarSource implements BarSource {
  constructor(
    private readonly provider: MarketDataProvider,
    private readonly contractId: string,
  ) {}

  async getBars(symbol: string, fromUtc: Date, toUtc: Date): Promise<Bar[]> {
    if (fromUtc > toUtc) return [];

    const seen = new Set<string>();
    const out: Bar[] = [];
    let chunkEnd = toUtc;
    let chunks = 0;

    while (chunks < MAX_CHUNKS) {
      const apiBars = await this.provider.retrieveBars({
        contractId: this.contractId,
        live: false,
        startTime: fromUtc.toISOString(),
        endTime: chunkEnd.toISOString(),
        unit: 2,
        unitNumber: 1,
        limit: CHUNK_BARS,
        includePartialBar: false,
      });
      chunks++;

      if (apiBars.length === 0) break;

      let oldestMs = Infinity;
      let added = 0;
      for (const b of apiBars) {
        if (seen.has(b.timestamp)) continue;
        seen.add(b.timestamp);
        added++;
        out.push(barDataToBar(b, symbol));
        const ms = new Date(b.timestamp).getTime();
        if (ms < oldestMs) oldestMs = ms;
      }

      if (added === 0) break;
      if (oldestMs <= fromUtc.getTime()) break;

      const nextEndMs = oldestMs - 1;
      if (nextEndMs >= chunkEnd.getTime()) break;
      chunkEnd = new Date(nextEndMs);
      if (chunkEnd.getTime() <= fromUtc.getTime()) break;
    }

    out.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
    return out;
  }

  async coverage(_symbol: string): Promise<BarSourceCoverage> {
    return { minUtc: null, maxUtc: null };
  }
}
