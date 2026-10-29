import { MarketDataRegistry, type MarketDataSlot, type MarketDataSlotStore } from "@/lib/market-data/registry";
import { topstepMarketDataProvider } from "@/lib/brokers/topstep/market-data-provider";
import { databentoMarketDataProvider } from "@/lib/market-data/databento/provider";
import {
  invalidateSettingsCache,
  resolveMarketDataHistoricalProviderId,
  resolveMarketDataRealtimeProviderId,
} from "@/lib/db/settings-cache";
import {
  setMarketDataHistoricalProvider,
  setMarketDataRealtimeProvider,
} from "@/lib/db/settings";

/**
 * Both slots fall back to Topstep, so an install that never opens Settings
 * behaves exactly as it did when there was a single active provider.
 */
const DEFAULT_SLOT_PROVIDER_ID = topstepMarketDataProvider.id;

/**
 * Reads go through `settings-cache` because `realtime()` is resolved on
 * every engine bar fetch; writes invalidate the same key so the next read
 * sees the new selection without a restart.
 */
const settingsSlotStore: MarketDataSlotStore = {
  read(slot: MarketDataSlot): string {
    const selected =
      slot === "historical"
        ? resolveMarketDataHistoricalProviderId()
        : resolveMarketDataRealtimeProviderId();
    // Empty is unset, the same way `settings-cache`'s resolvers treat it.
    // `?? DEFAULT` would let an empty-string row past the default and
    // straight into `resolveSlot`'s "no provider selected" throw.
    return selected && selected.length > 0 ? selected : DEFAULT_SLOT_PROVIDER_ID;
  },
  write(slot: MarketDataSlot, providerId: string): void {
    if (slot === "historical") {
      setMarketDataHistoricalProvider(providerId);
      invalidateSettingsCache("market_data_historical_provider");
    } else {
      setMarketDataRealtimeProvider(providerId);
      invalidateSettingsCache("market_data_realtime_provider");
    }
  },
};

export const marketDataRegistry = new MarketDataRegistry(settingsSlotStore);
marketDataRegistry.register(topstepMarketDataProvider);
// Databento serves historical bars from the Parquet cache. It declares no
// live-bar entitlement, so `setSlot("realtime", "databento")` is refused —
// which is the whole point of the two slots.
marketDataRegistry.register(databentoMarketDataProvider);
