import type { MarketDataProvider } from "@/lib/market-data/provider";

/**
 * Selection is per data kind, not per vendor. Two independent slots:
 *
 * - `historical` — backtest, export, per-trade chart and replay. This is
 *   the only slot a cache-backed provider may ever occupy.
 * - `realtime` — the engine (every bar fetch), `/api/quotes` and the dev
 *   probes. Live trading reads live data, always.
 *
 * No engine path may read `historical()`. The Parquet cache is permanently
 * about one session behind Databento's rolling embargo, and a stale bar
 * standing in for a live one at decision time is the failure mode this
 * split exists to make impossible.
 */
export type MarketDataSlot = "historical" | "realtime";

/** Where a slot selection is persisted. `read` returns null when nothing
 *  has been selected; the store is responsible for any default. */
export interface MarketDataSlotStore {
  read(slot: MarketDataSlot): string | null;
  write(slot: MarketDataSlot, providerId: string): void;
}

/** Process-local store. Used by tests and by any registry constructed
 *  without persistence. */
export class InMemorySlotStore implements MarketDataSlotStore {
  private slots = new Map<MarketDataSlot, string>();

  constructor(defaultProviderId?: string) {
    if (defaultProviderId) {
      this.slots.set("historical", defaultProviderId);
      this.slots.set("realtime", defaultProviderId);
    }
  }

  read(slot: MarketDataSlot): string | null {
    return this.slots.get(slot) ?? null;
  }

  write(slot: MarketDataSlot, providerId: string): void {
    this.slots.set(slot, providerId);
  }
}

export class MarketDataRegistry {
  private providers = new Map<string, MarketDataProvider>();

  constructor(private readonly store: MarketDataSlotStore = new InMemorySlotStore()) {}

  register(provider: MarketDataProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): MarketDataProvider | null {
    return this.providers.get(id) ?? null;
  }

  allProviders(): MarketDataProvider[] {
    return [...this.providers.values()];
  }

  /** Selected provider id for a slot, without resolving it. Null when
   *  nothing is selected and the store carries no default. */
  slotProviderId(slot: MarketDataSlot): string | null {
    return this.store.read(slot);
  }

  /**
   * Validate a slot selection without writing it. Throws the same message
   * `setSlot` would.
   *
   * Split out so a caller applying *both* slots can refuse the whole
   * submission before either write lands. `setSlot` is atomic for one
   * slot; two back-to-back calls are not, and a refusal on the second
   * would otherwise leave the first committed.
   */
  assertSlot(slot: MarketDataSlot, providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`MarketDataProvider "${providerId}" is not registered.`);
    }
    if (slot === "realtime" && !provider.capabilities.liveBars) {
      throw new Error(
        `${provider.displayName} cannot serve the realtime slot — it has no live-bar ` +
          "entitlement. The engine reads this slot on every bar fetch, so an archive-only " +
          "provider here would trade on stale bars.",
      );
    }
    if (slot === "historical" && !provider.capabilities.historicalBars) {
      throw new Error(
        `${provider.displayName} cannot serve the historical slot — it has no historical-bar ` +
          "entitlement.",
      );
    }
  }

  /**
   * Select a provider for a slot. Refuses a provider that cannot serve
   * the kind of data the slot is for — selecting a history-only provider
   * for `realtime` would put the engine on an archive, which is the whole
   * reason the slots are separate.
   */
  setSlot(slot: MarketDataSlot, providerId: string): void {
    this.assertSlot(slot, providerId);
    this.store.write(slot, providerId);
  }

  /** Backtest, export, per-trade chart, replay. Never the engine. */
  historical(): MarketDataProvider {
    return this.resolveSlot("historical");
  }

  /** The engine, `/api/quotes`, the dev probes. */
  realtime(): MarketDataProvider {
    const provider = this.resolveSlot("realtime");
    // `setSlot` already refuses a provider without `liveBars`, but the
    // selection outlives the code that made it: a persisted id whose
    // capability was later revoked must fail loudly here rather than quietly
    // serve archived bars to a live decision.
    if (!provider.capabilities.liveBars) {
      throw new Error(
        `Realtime market-data provider "${provider.id}" no longer declares liveBars. ` +
          "Select a live-capable provider in Settings before running the engine.",
      );
    }
    return provider;
  }

  private resolveSlot(slot: MarketDataSlot): MarketDataProvider {
    const id = this.store.read(slot);
    if (!id) throw new Error(`No ${slot} MarketDataProvider selected`);
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(
        `Selected ${slot} MarketDataProvider "${id}" is not registered. ` +
          `Re-select a ${slot} market-data provider in Settings.`,
      );
    }
    return provider;
  }
}
