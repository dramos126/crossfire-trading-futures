import type { TickerSymbol } from "@/lib/trading/domain";

/**
 * TopstepX commissions + exchange/clearing fees per side per contract,
 * sourced from https://help.topstep.com/en/articles/8284213-topstepx-commissions-and-fees.
 *
 * Each entry is the round-trip total split in half (per-side). The
 * backtester deducts `feePerSideUsd * 2 * size` per closed trade so this
 * matches what TopstepX actually bills for both sides of a round trip.
 *
 * Map is keyed by raw symbol string (not TickerSymbol union) so we can
 * carry fee data for every TopstepX-tradeable product even before the
 * platform formally supports trading it. Adding a new symbol to
 * `TickerSymbol` + `TICKER_CONTRACT_MAP` is enough to enable trading; the
 * fee lookup just works on day one. Unmapped symbols fall through to 0.
 */
export const FEE_PER_SIDE_USD: Record<string, number> = {
  // CME Equity Index
  "/ES":  1.90,
  "/MES": 0.62,
  "/NQ":  1.90,
  "/MNQ": 0.62,
  "/RTY": 1.90,
  "/M2K": 0.62,
  "/YM":  1.90,
  "/MYM": 0.62,
  "/NKD": 2.67,

  // Crypto Micro
  "/MBT": 1.42,
  "/MET": 0.42,

  // Metals (COMEX)
  "/GC":  2.12,
  "/MGC": 0.87,
  "/SI":  2.12,
  "/SIL": 1.27,
  "/HG":  2.12,
  "/MHG": 0.87,
  "/PL":  2.12,

  // Energy (NYMEX)
  "/CL":  2.02,
  "/MCL": 0.77,
  "/QM":  1.72,
  "/NG":  2.10,
  "/MNG": 0.87,
  "/QG":  1.02,
  "/RB":  2.02,
  "/HO":  2.02,

  // Agriculture (CBOT / CME)
  "/HE":  2.62,
  "/LE":  2.62,
  "/ZC":  2.65,
  "/ZW":  2.65,
  "/ZS":  2.65,
  "/ZM":  2.65,
  "/ZL":  2.65,

  // Treasuries (CBOT)
  "/ZT":  1.17,
  "/ZF":  1.17,
  "/ZN":  1.30,
  "/ZB":  1.39,
  "/UB":  1.47,
  "/TN":  1.32,
  "/E7":  1.12,

  // Forex Futures (CME)
  "/6A":  2.12,
  "/M6A": 0.51,
  "/6B":  2.12,
  "/M6B": 0.51,
  "/6C":  2.12,
  "/6E":  2.12,
  "/M6E": 0.51,
  "/6J":  2.12,
  "/6S":  2.12,
  "/6M":  2.12,
  "/6N":  2.12,
};

export function feePerSideFor(ticker: TickerSymbol | string): number {
  return FEE_PER_SIDE_USD[ticker] ?? 0;
}
