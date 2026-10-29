/**
 * Vendor-agnostic interface for reading historical OHLCV bars.
 *
 * Implementations:
 * - ParquetCacheBarSource — local parquet cache populated by a vendor fetcher
 * - TopstepBarSource / TradovateBarSource — broker history APIs (Phase 4.5)
 * - ChainedBarSource — primary + fallback composition (Phase 4.5)
 *
 * Runtime app code depends on this interface only. It does not know which
 * vendor (if any) populated the cache.
 */

export interface Bar {
  /** Nanosecond UTC timestamp (Arrow Timestamp(NANOSECOND) on disk). */
  tsUtc: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume as int64 — bigint to avoid precision loss on large futures volume. */
  volume: bigint;
  /** Canonical symbol form, e.g. "ES.c.0". */
  symbol: string;
}

export interface BarSourceCoverage {
  minUtc: Date | null;
  maxUtc: Date | null;
}

export interface BarSource {
  /**
   * Returns bars in `[fromUtc, toUtc]` (inclusive). Empty array if no data —
   * implementations MUST NOT throw on missing-symbol or missing-range cases.
   * Throw only on actual I/O or schema-corruption errors.
   *
   * Bars are sorted by `tsUtc` ascending.
   */
  getBars(symbol: string, fromUtc: Date, toUtc: Date): Promise<Bar[]>;

  /**
   * Returns the available coverage window for a symbol. `{ minUtc: null, maxUtc: null }`
   * if no data is available. Used by backtest UI to show cache extents and by
   * ChainedBarSource to compute the splice point for fallback gap-fill.
   */
  coverage(symbol: string): Promise<BarSourceCoverage>;
}

/**
 * Canonical Arrow / Parquet schema for OHLCV-1m bars on disk. Vendor-agnostic.
 * Both readers (ParquetCacheBarSource) and writers (Phase 2 fetchers) MUST
 * conform to this. Compression is zstd, sort order is ts_utc ascending.
 *
 * Field types map to Arrow logical types:
 *   ts_utc → Timestamp(NANOSECOND), UTC
 *   open/high/low/close → Float64
 *   volume → Int64
 *   symbol → Utf8
 */
export const CANONICAL_BAR_SCHEMA = {
  fields: [
    { name: "ts_utc", type: "timestamp[ns,UTC]", nullable: false },
    { name: "open", type: "float64", nullable: false },
    { name: "high", type: "float64", nullable: false },
    { name: "low", type: "float64", nullable: false },
    { name: "close", type: "float64", nullable: false },
    { name: "volume", type: "int64", nullable: false },
    { name: "symbol", type: "utf8", nullable: false },
  ],
  compression: "zstd",
  sortOrder: ["ts_utc:asc"],
} as const;

export type CanonicalBarFieldName =
  | "ts_utc"
  | "open"
  | "high"
  | "low"
  | "close"
  | "volume"
  | "symbol";
