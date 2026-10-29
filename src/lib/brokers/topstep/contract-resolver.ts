import { TopstepClient } from "./client";
import type { Contract } from "@/lib/brokers/types";
import type { TickerSymbol } from "@/lib/trading/domain";

/**
 * Maps global ticker symbols (/NQ, /ES, etc.) to the search text
 * that the Topstep contract search API expects.
 */
// For each ticker we need TWO values:
//   search — what Topstep's /Contract/search accepts (the user-friendly root)
//   root   — the exact id-segment (CON.F.US.<ROOT>.<MYY>) to filter results by
// The search is fuzzy and can return unrelated contracts (searching "ES"
// returns FVA/JY6/TYA/etc; searching "NG" returns MNG). The id-root filter
// is authoritative — it's what we match on to pick the exact product.
export const TICKER_CONTRACT_MAP: Record<TickerSymbol, { search: string; root: string }> = {
  "/ES":  { search: "ES",  root: "EP" },
  "/NQ":  { search: "NQ",  root: "ENQ" },
  "/YM":  { search: "YM",  root: "YM" },
  "/RTY": { search: "RTY", root: "RTY" },
  "/GC":  { search: "GC",  root: "GCE" },
  "/SI":  { search: "SI",  root: "SIE" },
  "/CL":  { search: "CL",  root: "CLE" },
  "/NG":  { search: "NG",  root: "NGE" },
  "/MES": { search: "MES", root: "MES" },
  "/MNQ": { search: "MNQ", root: "MNQ" },
  "/MYM": { search: "MYM", root: "MYM" },
  "/M2K": { search: "M2K", root: "M2K" },
  "/MGC": { search: "MGC", root: "MGC" },
  "/SIL": { search: "SIL", root: "SIL" },
  "/MCL": { search: "MCL", root: "MCLE" },
  "/MNG": { search: "MNG", root: "MNG" },
};

/**
 * Resolves a global ticker symbol to the active front-month Topstep contract.
 * Caches results to avoid repeated API calls.
 */
export class ContractResolver {
  private cache = new Map<TickerSymbol, { contract: Contract; resolvedAt: number }>();
  // 15 min TTL is short enough that a roll-day flip gets picked up quickly
  // without spamming the contract-search endpoint. Topstep says the flip
  // lands in the 17:00–18:00 ET halt; not yet observed (topstep.md, Roll
  // timing). Callers should also invalidate explicitly when
  // they see signal of a stale entry (e.g. retrieveBars returns empty for a
  // contract we believe is active).
  private cacheTtlMs = 15 * 60 * 1000;
  // Every leg on a ticker reaches an expired entry on the same tick, so
  // without this one expiry was one search per leg at the same instant — six
  // identical MNQ searches on 2026-10-22, all refused in a 429 storm (A115).
  private inFlight = new Map<TickerSymbol, Promise<Contract>>();

  constructor(private client: TopstepClient) {}

  async resolve(ticker: TickerSymbol): Promise<Contract> {
    const cached = this.cache.get(ticker);
    if (cached && Date.now() - cached.resolvedAt < this.cacheTtlMs) {
      return cached.contract;
    }
    const pending = this.inFlight.get(ticker);
    if (pending) return pending;
    const lookup = this.lookUp(ticker).finally(() => this.inFlight.delete(ticker));
    this.inFlight.set(ticker, lookup);
    return lookup;
  }

  private async lookUp(ticker: TickerSymbol): Promise<Contract> {
    const { search, root } = TICKER_CONTRACT_MAP[ticker];
    const contracts = await this.client.searchContracts(search);

    // Filter by exact id-root — search results are fuzzy (e.g. "ES" returns
    // unrelated bond/FX contracts; "SIL" returns both SIE mini and SIL micro).
    const exact = contracts.filter((c) => c.id.split(".")[3] === root);

    const active = exact.find((c) => c.activeContract);
    if (!active) {
      throw new Error(`No active contract found for ${ticker} (searched "${search}", root "${root}")`);
    }

    this.cache.set(ticker, { contract: active, resolvedAt: Date.now() });
    return active;
  }

  /** Drop a single ticker's cached contract. Use when downstream code
   *  detects the cached contract is stale (e.g. retrieveBars returns
   *  empty during regular hours, or a place-order returns a contract-
   *  expired error). The next resolve() will re-query Topstep. */
  invalidate(ticker: TickerSymbol): void {
    this.cache.delete(ticker);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
