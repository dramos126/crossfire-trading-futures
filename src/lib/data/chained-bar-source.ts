/**
 * Composite BarSource: serves from `primary` for the historical span it
 * covers, then splices in `fallback` for any tail that extends past the
 * primary's `coverage().maxUtc`.
 *
 * Designed for the Phase 4.5 parquet-cache + Topstep-live combination, where
 * the cache covers 2020–2025 and the live broker fills the present. The
 * splice point sits in weekend dead air (cache ends 2025-12-31, CME reopens
 * 2026-01-05 Sunday evening), so no bar reconciliation is needed at the
 * boundary — but we still dedupe on `tsUtc` defensively.
 */
import type { Bar, BarSource, BarSourceCoverage } from "./bar-source";

export class ChainedBarSource implements BarSource {
  constructor(private readonly primary: BarSource, private readonly fallback: BarSource) {}

  async getBars(symbol: string, fromUtc: Date, toUtc: Date): Promise<Bar[]> {
    const cov = await this.primary.coverage(symbol);
    if (cov.maxUtc === null) {
      return this.fallback.getBars(symbol, fromUtc, toUtc);
    }
    if (toUtc.getTime() <= cov.maxUtc.getTime()) {
      return this.primary.getBars(symbol, fromUtc, toUtc);
    }

    const primaryBars = await this.primary.getBars(symbol, fromUtc, cov.maxUtc);
    // Use the later of cov.maxUtc and fromUtc as the fallback start — when
    // fromUtc is already past the cache boundary, the primary returns nothing
    // and we should start the fallback at fromUtc, not at cov.maxUtc (which
    // would pull in bars the caller didn't ask for).
    const fallbackFrom = fromUtc > cov.maxUtc ? fromUtc : cov.maxUtc;
    const fallbackBars = await this.fallback.getBars(symbol, fallbackFrom, toUtc);

    if (fallbackBars.length === 0) {
      console.warn(
        `[ChainedBarSource] fallback returned 0 bars for gap window [${cov.maxUtc.toISOString()}, ${toUtc.toISOString()}] — result may have a gap`,
      );
    }

    const merged: Bar[] = [];
    const seen = new Set<string>();
    for (const arr of [primaryBars, fallbackBars]) {
      for (const b of arr) {
        const key = b.tsUtc.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(b);
      }
    }
    merged.sort((a, b) => (a.tsUtc < b.tsUtc ? -1 : a.tsUtc > b.tsUtc ? 1 : 0));
    return merged;
  }

  async coverage(symbol: string): Promise<BarSourceCoverage> {
    return this.primary.coverage(symbol);
  }
}
