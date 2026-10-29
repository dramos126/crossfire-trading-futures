import { log } from "@/lib/logger";
import { contractMonthKey, sameContractMonth } from "@/lib/trading/broker-access/contract-pairing";
import type { TradovateClient } from "./client";
import type {
  TradovateActiveContract,
  TradovateContractSuggestion,
} from "./types";

/**
 * Tradovate-side contract resolver.
 *
 * **It does not pick a month.** The market-data contract — and therefore
 * every indicator the signal was built on — comes from Topstep, so the
 * execution contract must name the month Topstep already chose. The caller
 * passes that choice in as an anchor and this resolver only finds the
 * matching Tradovate listing for it.
 *
 * It used to decide independently, with its own invented 7-day roll-forward:
 * once the front suggestion's expiry came inside the window it skipped to
 * `suggestions[1]`. Topstep has no such rule, so on 2026-09-11 at 09:30:01 ET
 * — MNQU26's settlement minus exactly seven days — every Tradovate-executed
 * deployment started throwing `assertContractsPair`'s expiry mismatch, on
 * exits as well as entries, and would have for a full week every quarter.
 * Two independent roll policies with no coordination is the defect; asking
 * for a month rather than choosing one is the fix. See bugs.md.
 *
 * Cache shape mirrors the Topstep resolver moved in Phase 2A:
 *
 *   - 15-min TTL by default
 *   - per-root `invalidate(root)` helper
 *   - periodic full refresh every 12h (`MAPPING_REFRESH_MINUTES`)
 *
 * There is no near-roll refresh and there must not be one: entries are keyed
 * by month, so Topstep rolling *is* a cache miss.
 */

/**
 * Cache TTL for resolved contracts. Matches the Topstep resolver
 * (15 min) so cross-broker pairing assertions don't see one side's
 * cached front and the other side's freshly-rotated next.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Wholesale refresh cadence. After this many minutes since the last
 * full refresh, the next `resolveForMonth(...)` triggers a re-decide for
 * every cached entry. Mirrors the prior-art's `MAPPING_REFRESH_MINUTES`
 * (default 720 = 12h).
 */
const MAPPING_REFRESH_MINUTES = 720;

const MAPPING_REFRESH_MS = MAPPING_REFRESH_MINUTES * 60 * 1000;

interface CacheEntry {
  contract: TradovateActiveContract;
  resolvedAt: number;
}

/**
 * Strip TradingView continuous-suffix (`MES1!` → `MES`) AND Topstep
 * `/` prefix (`/MES` → `MES`), uppercase. Tradovate's
 * `/contract/suggest?t=` accepts only the bare root ("MNQ", not "/MNQ"
 * or "MNQ1!"); without the `/` strip the engine pre-warm at boot
 * silently misses every Topstep-style ticker and the WS dispatcher
 * drops the entire boot-burst of order/position events.
 *
 * Exported for the probe script + the broker-aware router; kept as a free
 * function so it can be called without instantiating the resolver.
 */
export function stripContinuousSuffix(input: string): string {
  return String(input ?? "").trim().toUpperCase().replace(/1!$/, "").replace(/^\//, "");
}

export class TradovateContractResolver {
  private cache = new Map<string, CacheEntry>();
  private lastFullRefreshAt = 0;

  constructor(private client: TradovateClient) {}

  /**
   * Resolve a root (or continuous symbol like `MES1!`) to the Tradovate
   * dated contract for the month `topstepContractId` names.
   *
   * @param input             Tradovate root, in Tradovate's own namespace.
   * @param topstepContractId The already-resolved Topstep market-data
   *                          contract id (`CON.F.US.MNQ.U26`). Its month is
   *                          the anchor; this resolver never picks one.
   */
  async resolveForMonth(input: string, topstepContractId: string): Promise<TradovateActiveContract> {
    const root = stripContinuousSuffix(input);
    if (!root) {
      throw new Error(
        `TradovateContractResolver.resolveForMonth: empty root after strip ("${input}")`,
      );
    }

    const month = contractMonthKey(topstepContractId);
    if (month === null) {
      throw new Error(
        `TradovateContractResolver: cannot read a contract month from the Topstep anchor ` +
          `"${topstepContractId}" for root ${root}. Refusing to pick a Tradovate contract ` +
          `without one — the execution contract must name the month the market-data ` +
          `contract describes.`,
      );
    }

    await this.maybeFullRefresh();

    const key = cacheKey(root, month);
    const cached = this.cache.get(key);
    if (cached && this.isCacheUsable(cached)) {
      return cached.contract;
    }

    const fresh = await this.selectForMonth(root, month, topstepContractId);
    // Refuse to cache entries with a null expiry — the maturity lookup
    // failed, so `maturityIso` would lock a blank into the pairing error
    // text for 15min and mask a transient API issue. Re-resolve on every
    // lookup until a real expiry comes back.
    if (fresh.expiryTs !== null) {
      this.cache.set(key, { contract: fresh, resolvedAt: Date.now() });
    }
    return fresh;
  }

  /** Drop every cached month for a root. Use when downstream code detects
   *  the cached contract is stale (e.g. an order-place returns a
   *  contract-expired error). The next resolve re-queries Tradovate.
   *  Mirrors the Topstep resolver's `invalidate(ticker)`. */
  invalidate(input: string): void {
    const root = stripContinuousSuffix(input);
    for (const [key, entry] of this.cache) {
      if (entry.contract.root === root) this.cache.delete(key);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.lastFullRefreshAt = 0;
  }

  /** Reverse-lookup by numeric contractId. Returns the dated symbol
   *  (e.g. "MNQM6") if any cached entry matches, null otherwise. */
  getSymbolForNumericId(numericId: number): string | null {
    for (const { contract } of this.cache.values()) {
      if (contract.contractId === numericId) return contract.symbol;
    }
    return null;
  }

  // ── Internals ────────────────────────────────────────────────────

  private isCacheUsable(entry: CacheEntry): boolean {
    return Date.now() - entry.resolvedAt < CACHE_TTL_MS;
  }

  /**
   * Periodic wholesale refresh. After `MAPPING_REFRESH_MS` since the
   * last sweep, drop every cached entry so the next resolve re-decides
   * from scratch. Mirrors the prior-art's `maybeRefreshSymbolMapping`
   * periodic branch.
   */
  private async maybeFullRefresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullRefreshAt < MAPPING_REFRESH_MS) return;
    this.lastFullRefreshAt = now;
    if (this.cache.size > 0) {
      log.debug(
        "tradovate.resolver",
        `periodic full refresh (cache had ${this.cache.size} entries)`,
      );
    }
    this.cache.clear();
  }

  /**
   * Find the `/contract/suggest` item whose month matches the anchor.
   * Suggest ordering is irrelevant here — the anchor decides, so a
   * truncated or re-ordered list changes nothing but whether we find it.
   */
  private async selectForMonth(
    root: string,
    month: string,
    topstepContractId: string,
  ): Promise<TradovateActiveContract> {
    const suggestions = await this.client.suggestContracts(root);
    const match = suggestions.find((s) =>
      sameContractMonth(topstepContractId, suggestionSymbol(s)),
    );
    if (!match) {
      throw new Error(
        `Tradovate lists no ${month} contract for root ${root}. /contract/suggest returned ` +
          `[${suggestions.map(describeSuggestion).join(", ") || "nothing"}], and the ` +
          `execution contract must name the month the Topstep market-data contract ` +
          `${topstepContractId} describes. Refusing to resolve — Tradovate may be missing ` +
          `the listing, or the suggestion list was truncated.`,
      );
    }

    const maturity = match.contractMaturityId
      ? await this.client.getContractMaturity(match.contractMaturityId)
      : null;
    if (match.contractMaturityId && maturity === null) {
      log.event(
        "broker_response_malformed",
        "tradovate.resolver",
        `getContractMaturity returned null for the anchored contract`,
        {
          contractId: String(match.id),
          meta: {
            root,
            month,
            contractName: match.name,
            contractId: match.id,
            contractMaturityId: match.contractMaturityId,
          },
        },
      );
    }

    return buildActiveContract(
      root,
      match,
      parseExpirationToEpochMs(maturity?.expirationDate),
    );
  }
}

function cacheKey(root: string, month: string): string {
  return `${root}:${month}`;
}

function suggestionSymbol(suggestion: TradovateContractSuggestion): string {
  return suggestion.name || suggestion.symbol || "";
}

function describeSuggestion(suggestion: TradovateContractSuggestion): string {
  return suggestionSymbol(suggestion) || `id ${suggestion.id}`;
}

function buildActiveContract(
  root: string,
  suggestion: TradovateContractSuggestion,
  expiryTs: number | null,
): TradovateActiveContract {
  return {
    root,
    // The same accessor the match used. `suggestContracts` admits items whose
    // `name` is empty when `symbol` carries the dated symbol, so reading `name`
    // raw here hands a `""` to `assertContractsPair` and refuses every tick on
    // an error that names nothing.
    symbol: suggestionSymbol(suggestion),
    contractId: suggestion.id,
    maturityIso: expiryTs !== null ? new Date(expiryTs).toISOString() : null,
    expiryTs,
    decidedAt: Date.now(),
  };
}

function parseExpirationToEpochMs(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
