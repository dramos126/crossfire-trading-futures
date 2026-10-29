import {
  getDatabentoApiKey,
  getMarketDataHistoricalProvider,
  getMarketDataRealtimeProvider,
  getTopstepApiKey,
  getTopstepUsername,
  getTopstepWebhookUrl,
} from "@/lib/db/settings";

/**
 * Tiny in-memory mirror of the `app_settings` singletons the hot paths
 * read. Sits between auth/notify/market-data and SQLite so the engine's
 * per-tick token resolver — and its per-bar-fetch provider lookup — don't
 * open `app_settings` on every read. Cache is process-local; every Node
 * process boots cold and warms on first read.
 *
 * Writes go through `/api/settings` which calls `invalidateSettingsCache()`
 * (and `clearCachedToken()` for credential changes) so the next
 * `getToken()` mints under the new creds.
 */

export type CacheKey =
  | "topstep_username"
  | "topstep_api_key"
  | "topstep_webhook_url"
  | "market_data_historical_provider"
  | "market_data_realtime_provider"
  | "databento_api_key";

const cache = new Map<CacheKey, string | null>();

const READERS: Record<CacheKey, () => string | null> = {
  topstep_username: getTopstepUsername,
  topstep_api_key: getTopstepApiKey,
  topstep_webhook_url: getTopstepWebhookUrl,
  market_data_historical_provider: getMarketDataHistoricalProvider,
  market_data_realtime_provider: getMarketDataRealtimeProvider,
  databento_api_key: getDatabentoApiKey,
};

function readDbOrCache(key: CacheKey): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  const v = READERS[key]();
  cache.set(key, v);
  return v;
}

export function invalidateSettingsCache(key?: CacheKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/** DB-first / env-fallback resolvers. Empty strings (e.g. an env var set
 *  to "") are treated as unset so a typo doesn't produce a confusing
 *  "Missing TOPSTEP_USERNAME" error pointing at a name that LOOKS set. */
export function resolveTopstepUsername(): string | null {
  const fromDb = readDbOrCache("topstep_username");
  if (fromDb) return fromDb;
  const fromEnv = process.env.TOPSTEP_USERNAME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export function resolveTopstepApiKey(): string | null {
  const fromDb = readDbOrCache("topstep_api_key");
  if (fromDb) return fromDb;
  const fromEnv = process.env.TOPSTEP_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export function resolveTopstepWebhookUrl(): string | null {
  const fromDb = readDbOrCache("topstep_webhook_url");
  if (fromDb) return fromDb;
  const fromEnv = process.env.TRADE_NOTIFIER_WEBHOOK_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

/** Databento's key is optional — null here is a normal configuration, not
 *  a fault. Prod mounts the Parquet cache read-only and holds no key; the
 *  provider still serves historical bars. Only the entitlement probe and
 *  the future live feed need it. */
export function resolveDatabentoApiKey(): string | null {
  const fromDb = readDbOrCache("databento_api_key");
  if (fromDb) return fromDb;
  const fromEnv = process.env.DATABENTO_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

/** Selected market-data provider id per slot, or null when the operator
 *  has never chosen one. The registry applies the default. */
export function resolveMarketDataHistoricalProviderId(): string | null {
  return readDbOrCache("market_data_historical_provider");
}

export function resolveMarketDataRealtimeProviderId(): string | null {
  return readDbOrCache("market_data_realtime_provider");
}

/** Source-of-truth indicator for the settings UI — drives the "loaded
 *  from environment" caption. Keep in sync with the resolvers above:
 *  DB wins, then env, then unset. */
export type SettingSource = "db" | "env" | "unset";

export function topstepUsernameSource(): SettingSource {
  if (readDbOrCache("topstep_username")) return "db";
  const fromEnv = process.env.TOPSTEP_USERNAME;
  return fromEnv && fromEnv.length > 0 ? "env" : "unset";
}

export function topstepApiKeySource(): SettingSource {
  if (readDbOrCache("topstep_api_key")) return "db";
  const fromEnv = process.env.TOPSTEP_API_KEY;
  return fromEnv && fromEnv.length > 0 ? "env" : "unset";
}

export function topstepWebhookUrlSource(): SettingSource {
  if (readDbOrCache("topstep_webhook_url")) return "db";
  const fromEnv = process.env.TRADE_NOTIFIER_WEBHOOK_URL;
  return fromEnv && fromEnv.length > 0 ? "env" : "unset";
}

export function databentoApiKeySource(): SettingSource {
  if (readDbOrCache("databento_api_key")) return "db";
  const fromEnv = process.env.DATABENTO_API_KEY;
  return fromEnv && fromEnv.length > 0 ? "env" : "unset";
}
