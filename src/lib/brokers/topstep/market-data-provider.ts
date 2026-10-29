import type { MarketDataCapabilities, MarketDataProvider } from "@/lib/market-data/provider";
import type { BarData, RetrieveBarsRequest } from "@/lib/brokers/types";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import type { TopstepBrokerPlugin } from "@/lib/brokers/topstep/index";
import type { TopstepClient } from "@/lib/brokers/topstep/client";
import type { BrokerErrorKind, CredentialField } from "@/lib/brokers/plugin";

/**
 * Topstep market-data provider — thin delegate over `TopstepClient`'s
 * historical-bars endpoint. Hands the engine a broker-neutral seam so
 * the Databento provider can serve the historical slot without touching
 * any bar-fetch call site.
 *
 * Engine carve-out reminder (per phase plan §0): bars are Topstep-only
 * regardless of execution broker. Tradovate-routed deployments still
 * fetch bars via this provider; only execution flows through their own
 * client.
 *
 * Contract resolution is not here and never was used from here — every
 * real resolution goes through `BrokerAwareContractResolver`, which is
 * per-account and broker-aware.
 */
class TopstepMarketDataProvider implements MarketDataProvider {
  readonly id = "topstep";
  readonly displayName = "Topstep";

  // The gateway serves history, the current session and a live tick feed,
  // so all three are declared — **when Topstep is configured**. `liveQuotes`
  // is served through the engine's SignalR hub rather than
  // `subscribeQuotes`; capabilities describe the vendor and plan, not which
  // method happens to be wired.
  //
  // A getter, not a static object, because an unconfigured Topstep can
  // serve none of them. The static `true` made the boot pre-flight pass on
  // an install with zero Topstep credentials and pushed the failure to the
  // first `fetchBars` — one error per deployment per tick, forever, visible
  // only in /logs. That is precisely the mode the pre-flight exists to
  // prevent, so the honest answer belongs here.
  get capabilities(): MarketDataCapabilities {
    const configured = this.isConfigured();
    return {
      historicalBars: configured,
      liveBars: configured,
      liveQuotes: configured,
    };
  }

  isConfigured(): boolean {
    return this.plugin().isConfigured();
  }

  async retrieveBars(request: RetrieveBarsRequest): Promise<BarData[]> {
    const client = await this.requireClient();
    const apiBars = await client.retrieveBars(request);
    // Topstep returns newest-first; engine consumers expect ascending
    // timestamp order. Mapping + sort move here so every call site
    // gets the same shape without re-implementing the conversion.
    return apiBars
      .map((b) => ({
        timestamp: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /** None of its own — this provider authenticates with the Topstep
   *  broker's credentials, which the broker section already renders. */
  credentialSchema(): CredentialField[] {
    return [];
  }

  /** Same gateway, same credentials, so the broker plugin's implementation
   *  is the whole answer — including the validation signature it writes. */
  async testConnection(fields?: Record<string, string>): Promise<unknown> {
    return this.plugin().testConnection(fields);
  }

  classifyError(err: unknown): BrokerErrorKind {
    return this.plugin().classifyError(err);
  }

  private plugin(): TopstepBrokerPlugin {
    const p = brokerRegistry.getPlugin("topstep") as TopstepBrokerPlugin | null;
    if (!p) {
      throw new Error("TopstepMarketDataProvider: topstep broker plugin not registered");
    }
    return p;
  }

  /**
   * Every non-engine caller (backtest, chart, quotes, replay) now reaches
   * bars through the registry, and those routes run without the engine
   * boot sequence having fired — so the plugin's client can legitimately
   * still be null here. Mirror `getEngineClient()` / `boot-engine`'s
   * lazy-init-then-read-back pattern rather than making every route
   * remember to initialize the plugin first.
   */
  private async requireClient(): Promise<TopstepClient> {
    const plugin = this.plugin();
    let client = plugin.getClient();
    if (!client) {
      await plugin.initialize();
      client = plugin.getClient();
    }
    if (!client) {
      throw new Error(
        "TopstepMarketDataProvider: topstep broker plugin has no client — " +
          "credentials missing or initialize() never ran.",
      );
    }
    return client;
  }
}

export const topstepMarketDataProvider: MarketDataProvider = new TopstepMarketDataProvider();
