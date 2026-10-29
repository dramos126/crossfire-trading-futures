/**
 * Broker-neutral contract-resolver router/facade.
 *
 * Re-exports the per-broker resolvers so the engine has a single import
 * path, and provides `BrokerAwareContractResolver` which dispatches to
 * the right underlying resolver based on a deployment's accountId →
 * BrokerKind lookup.
 *
 * Phase-history note: Phase 2A moved the Topstep resolver here as an
 * unconditional re-export. Phase 2B added the Tradovate resolver as a
 * sibling export. Phase 4 was supposed to wire the broker-aware router
 * but only landed at the `Broker` call-site layer (engine's
 * `brokerFor(deployment).placeOrder`), missing the resolver-dispatch
 * layer — meaning Tradovate orders shipped with Topstep-shaped
 * `contractId` (`CON.F.US.MES.U25`) instead of Tradovate dated symbols
 * (`MESU2025`). This fix lands the missing dispatch.
 *
 * The router returns an extended `Contract` (the Topstep type, with the
 * optional `executionContractId` field). For Topstep-routed deployments,
 * `executionContractId` is undefined and `id` is authoritative for both
 * market data and execution. For Tradovate-routed deployments,
 * `executionContractId` carries the Tradovate dated symbol (the order
 * body's `symbol` field and the position-feed's contractId after the
 * Phase 5 numeric-id bridge translates it). `id` keeps the Topstep
 * shape because bars + market-data subs are the bars carve-out (always
 * Topstep regardless of execution broker — see plan §0).
 *
 * tickSize / tickValue come from the Topstep-side resolution unchanged.
 * Same physical product = same tick parameters; the Tradovate resolver
 * doesn't carry these fields and the prior-art order translator already
 * relies on `order.tickSize` being passed through (engine.ts:3370).
 */

import type { TopstepClient } from "@/lib/brokers/topstep/client";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import type { Contract } from "@/lib/brokers/types";
import type { TickerSymbol } from "@/lib/trading/domain";
import { BrokerKind } from "@/lib/db/account-brokers";
import { ContractResolver as TopstepContractResolver } from "@/lib/brokers/topstep/contract-resolver";
import { TradovateContractResolver } from "@/lib/brokers/tradovate/contract-resolver";
import { TICKER_CONTRACT_MAP } from "@/lib/brokers/topstep/contract-resolver";
import { assertContractsPair, productRootFromContractId } from "./contract-pairing";

export { ContractResolver, TICKER_CONTRACT_MAP } from "@/lib/brokers/topstep/contract-resolver";

export {
  TradovateContractResolver,
  stripContinuousSuffix as stripTradovateContinuousSuffix,
} from "@/lib/brokers/tradovate/contract-resolver";

export { assertContractsPair } from "./contract-pairing";

/** Closure the router uses to discover an account's broker. Engine
 *  passes a thin wrapper over `BrokerRegistry.brokerKind(accountId)` so
 *  this module doesn't import the registry directly. */
export type BrokerKindLookup = (accountId: number) => BrokerKind;

/**
 * Broker-aware resolver router. The engine constructs one of these and
 * calls `resolve(ticker, accountId)` everywhere it used to call
 * `topstepResolver.resolve(ticker)`.
 *
 * Topstep-broker dispatch is byte-identical to using `TopstepContractResolver`
 * directly — same cache, same fields, no `executionContractId` set.
 *
 * Tradovate-broker dispatch resolves both sides, asserts the pair is on
 * the same physical month (`assertContractsPair`), and returns the
 * Topstep contract with `executionContractId` set to the Tradovate
 * dated symbol.
 *
 * Both clients are nullable and a missing one is an **error, not a
 * fallback**. A Tradovate-tagged account with no Tradovate client used to
 * fall through to Topstep dispatch and return a Topstep contract, which
 * is how Tradovate orders once shipped with `CON.F.US.MES.U25` in place
 * of a dated symbol. Silently answering with the other broker's contract
 * is the failure mode this class exists to prevent; throw instead.
 */
export class BrokerAwareContractResolver {
  private topstep: TopstepContractResolver | null;
  private tradovate: TradovateContractResolver | null;
  private tradovateClient: TradovateClient | null;

  constructor(
    topstepClient: TopstepClient | null,
    tradovateClient: TradovateClient | null,
    private brokerKindFor: BrokerKindLookup,
  ) {
    this.topstep = topstepClient ? new TopstepContractResolver(topstepClient) : null;
    this.tradovateClient = tradovateClient;
    this.tradovate = tradovateClient
      ? new TradovateContractResolver(tradovateClient)
      : null;
  }

  /**
   * Point the Tradovate arm at the engine's current client. The engine's
   * `reloadTradovateClients()` calls it after a settings save: without it an
   * engine built with no Tradovate client never resolved a Tradovate leg, and
   * a rotation kept resolving over the old client. The same instance is a
   * no-op, so its contract cache survives; a new one starts a cold cache,
   * which the next resolve fills.
   */
  setTradovateClient(client: TradovateClient | null): void {
    if (client === this.tradovateClient) return;
    this.tradovateClient = client;
    this.tradovate = client ? new TradovateContractResolver(client) : null;
  }

  /**
   * Resolve a deployment's ticker to a broker-appropriate `Contract`.
   *
   * @param ticker  Topstep-style ticker (`/MES`, `/ES`, etc.) — the
   *                engine's deployment.ticker shape.
   * @param accountId Used to look up which broker owns the deployment.
   *                  Pass the deployment's accountId.
   */
  async resolve(ticker: TickerSymbol, accountId: number): Promise<Contract> {
    const kind = this.brokerKindFor(accountId);

    if (kind === BrokerKind.Tradovate) {
      if (!this.tradovate) {
        throw new Error(
          `BrokerAwareContractResolver: account ${accountId} is tagged Tradovate but no ` +
            `Tradovate client is configured. Refusing to answer with a Topstep contract — ` +
            `an order placed on it would carry a Topstep contract id.`,
        );
      }
      // The returned Contract's tickSize / tickValue and its Topstep-shaped
      // `id` (the bars carve-out) both come from the Topstep side, and the
      // cross-broker pairing assertion needs both months to compare. So a
      // Tradovate deployment still needs Topstep resolution today. Sourcing
      // tick params from Tradovate's own contract spec is E4/E5 work; until
      // then, say so rather than guessing at a tick size.
      if (!this.topstep) {
        throw new Error(
          `BrokerAwareContractResolver: account ${accountId} is tagged Tradovate but no ` +
            `Topstep client is configured, and tick parameters plus the market-data ` +
            `contract id are still sourced from Topstep. Configure Topstep, or see E4/E5 ` +
            `of the decoupling proposal.`,
        );
      }
      const topstepContract = await this.topstep.resolve(ticker);
      const map = TICKER_CONTRACT_MAP[ticker];
      if (!map) {
        throw new Error(
          `BrokerAwareContractResolver: ticker ${ticker} not in TICKER_CONTRACT_MAP — ` +
            `cannot derive Tradovate root for resolution.`,
        );
      }
      // Anchored, never independent: Tradovate is asked for the month the
      // Topstep contract above already named. Two resolvers each picking a
      // front month is what broke every Tradovate deployment on 2026-09-11.
      const tradovateContract = await this.tradovate.resolveForMonth(
        map.search,
        topstepContract.id,
      );
      // Structurally unable to fire on a roll now, and it still stays — it is
      // the last guard before an order.
      assertContractsPair(topstepContract, tradovateContract);

      return {
        ...topstepContract,
        executionContractId: tradovateContract.symbol,
      };
    }

    if (!this.topstep) {
      throw new Error(
        `BrokerAwareContractResolver: account ${accountId} routes to Topstep but no ` +
          `Topstep client is configured.`,
      );
    }
    return this.topstep.resolve(ticker);
  }

  /**
   * Resolve a ticker to its **market-data** contract, with no account and
   * no execution side. Legitimate without an accountId precisely because
   * market data is the bars carve-out: one global slot, Topstep-sourced for
   * every broker, so there is no per-account answer to give.
   *
   * Do not reach for this when an order, a broker position match or a
   * contract lock is downstream — those are per-deployment and go through
   * `resolve(ticker, accountId)`.
   */
  async resolveMarketData(ticker: TickerSymbol): Promise<Contract> {
    if (!this.topstep) {
      throw new Error(
        `BrokerAwareContractResolver: no Topstep client is configured, and market-data ` +
          `contracts are sourced from Topstep for every broker.`,
      );
    }
    return this.topstep.resolve(ticker);
  }

  /** Drop a single ticker's cached entry on both resolvers. The next
   *  `resolve(...)` re-queries whichever broker is in scope. */
  invalidate(ticker: TickerSymbol): void {
    this.topstep?.invalidate(ticker);
    if (this.tradovate) {
      const map = TICKER_CONTRACT_MAP[ticker];
      if (map) this.tradovate.invalidate(map.search);
    }
  }

  clearCache(): void {
    this.topstep?.clearCache();
    this.tradovate?.clearCache();
  }

  /** Resolve a Tradovate numeric contractId to its dated symbol via the
   *  Tradovate resolver's cache (e.g. 4799969 → "MNQM6"). Returns null
   *  on miss or when no Tradovate resolver is configured. */
  getTradovateSymbolForNumericId(numericId: number): string | null {
    return this.tradovate?.getSymbolForNumericId(numericId) ?? null;
  }
}

/** Convenience helper: returns the broker-side identifier to use when
 *  placing/cancelling/modifying orders or matching against broker
 *  position/order/fill feeds. Falls back to `id` when the router didn't
 *  set `executionContractId` (i.e. Topstep deployments). */
export function executionContractId(contract: Contract): string {
  return contract.executionContractId ?? contract.id;
}

/**
 * A broker contract identifier as the **rendered ticker** an operator
 * reads — `CON.F.US.ENQ.U26` → `NQ`, `MNQU6` → `MNQ`. This is the inverse
 * of `TICKER_CONTRACT_MAP` and there is deliberately no second map: the
 * product root comes from `productRootFromContractId`, which already reads
 * both identifier shapes, and the ticker comes from inverting the one table
 * that owns the mapping.
 *
 * **Two namespaces, one lookup, in this order.** Topstep's root is
 * sometimes not the ticker (`ENQ` is `/NQ`, `GCE` is `/GC`, `MCLE` is
 * `/MCL`), so the map's own roots are checked first; Tradovate's root *is*
 * the ticker, so a root that matched nothing is tried as one. The two
 * cannot collide — no Topstep root in the table is another product's
 * ticker — and the order is what keeps `GCE` from being read as an unknown
 * product rather than as gold.
 *
 * **`null` is "cannot tell", and every caller must render nothing rather
 * than guess.** A contract this install does not trade, a numeric
 * Tradovate id its symbol cache has not warmed, or a shape the parser does
 * not recognise all land here — and a log line naming the *wrong* symbol is
 * worse than one naming none, because the operator acts on it.
 */
export function tickerForContractId(contractId: string): string | null {
  return tickerSymbolForContractId(contractId)?.replace(/^\//, "") ?? null;
}

/** The same lookup as `tickerForContractId`, answering with the deployment
 *  ticker itself (`/NQ`) rather than the rendered one (`NQ`) — what a
 *  resolver call needs. Both namespaces and both orderings are described
 *  above; this is the function that implements them. */
export function tickerSymbolForContractId(contractId: string): TickerSymbol | null {
  const root = productRootFromContractId(contractId);
  if (root == null) return null;
  const tickers = Object.keys(TICKER_CONTRACT_MAP) as TickerSymbol[];
  for (const ticker of tickers) {
    if (TICKER_CONTRACT_MAP[ticker].root === root) return ticker;
  }
  return tickers.find((t) => t === `/${root}`) ?? null;
}
