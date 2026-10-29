/**
 * Phase 6b runtime validators for the /api/settings surface. Used by:
 *  - settings page bundle GET response (replaces `as SettingsBundle` cast)
 *  - notifications toggle bundle GET response (consistency)
 *  - PUT route body validation (replaces `body as PutBody` cast)
 *
 * TS types evaporate at runtime, and the Topstep app/Topstep API code
 * already validates at every external boundary; the previous casts here
 * trusted that the route's own response shape couldn't drift from the
 * client's expectations. After 6b's reset/setup paths land, the bundle
 * shape is touched by enough surfaces (route + setup write + reset wipe)
 * that a sloppy server-side change would silently break a client without
 * a TS error to flag it. This validator catches that at parse time.
 *
 * Error shape: each function returns either the parsed value or
 * `{ error: string }`. Callers explicitly handle the error branch — the
 * settings page renders an error block, the toggle stays default-off,
 * the PUT route returns 400 with the validator's message.
 */

export type SettingSource = "db" | "env" | "unset";

export interface SettingsBundle {
  topstepUsername: string | null;
  topstepUsernameSource: SettingSource;
  hasApiKey: boolean;
  apiKeySource: SettingSource;
  hasWebhookUrl: boolean;
  topstepWebhookUrlPreview: string | null;
  webhookUrlSource: SettingSource;
  notificationsEnabled: boolean;
  needsSetup: false;
  setupConfirmedAt: string | null;
  // Tradovate fields (Phase 1). Non-secret fields round-trip; password
  // and apiSecret are write-only and exposed only as boolean presence
  // flags. The wizard/Settings page treats empty input on a secret
  // field as "leave existing value alone" — same contract as
  // topstepApiKey above.
  tradovate: TradovateSettingsBundle;
  // Test-Connection gate-save signatures. We never expose the actual
  // signatures to the client (they're sha256 of the cred fields including
  // secrets — even the digest is "secret-derived" enough to keep server-
  // side). The client gets a boolean "are these creds currently
  // validated against persisted DB state" flag and an informational
  // validated_at timestamp; gate-save logic on the client tracks
  // edited-since-load locally and combines with these flags.
  topstepCredsValidated: boolean;
  topstepCredsValidatedAt: string | null;
  tradovateCredsValidated: boolean;
  tradovateCredsValidatedAt: string | null;
  // Market-data provider selection. Two independent slots, plus enough
  // about each registered provider for the UI to render the pickers and
  // grey out an option with the reason shown.
  marketData: MarketDataSettingsBundle;
}

export interface MarketDataCapabilitiesBundle {
  historicalBars: boolean;
  liveBars: boolean;
  liveQuotes: boolean;
}

export interface MarketDataProviderBundle {
  id: string;
  displayName: string;
  isConfigured: boolean;
  capabilities: MarketDataCapabilitiesBundle;
  // The provider's own credential fields. Empty for a provider that
  // borrows a broker's credentials, which is not the same as "no
  // credential needed" — render nothing rather than an empty form.
  fields: MarketDataCredentialFieldBundle[];
}

export interface MarketDataCredentialFieldBundle {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  envFallback: string | null;
}

export interface DatabentoSettingsBundle {
  // True when a key is present in the DB **or** in the environment. The
  // key itself never crosses the wire.
  hasApiKey: boolean;
  apiKeySource: SettingSource;
  // The key is optional, so `false` here with `hasApiKey: false` is a
  // valid, complete configuration — not an error state. It only blocks
  // Save when a key is actually being entered.
  credsValidated: boolean;
  credsValidatedAt: string | null;
  // Last successful probe's dataset range. Null when never probed.
  coverage: DatabentoCoverageBundle | null;
}

export interface DatabentoCoverageBundle {
  dataset: string;
  start: string;
  end: string;
  probedAt: string;
}

export interface MarketDataSettingsBundle {
  historicalProviderId: string;
  realtimeProviderId: string;
  providers: MarketDataProviderBundle[];
  databento: DatabentoSettingsBundle;
}

export interface TradovateSettingsBundle {
  username: string | null;
  apiCid: string | null;
  appId: string | null;
  appVersion: string | null;
  deviceId: string | null;
  hasPassword: boolean;
  hasApiSecret: boolean;
  // True iff every required field is non-null. Convenience for the UI
  // so it doesn't have to AND seven booleans together.
  isComplete: boolean;
  // True when the persisted value still matches the default the server
  // would have served — the operator hasn't customized this field. UI
  // uses these to render an AUTO badge. Flips false the moment the
  // operator saves a divergent value; returns to true if they clear the
  // field (server regenerates the default on next preload).
  appIdAuto: boolean;
  appVersionAuto: boolean;
  deviceIdAuto: boolean;
}

export interface PutBody {
  topstepUsername?: string | null;
  topstepApiKey?: string | null;
  topstepWebhookUrl?: string | null;
  notificationsEnabled?: boolean;
  tradovate?: TradovatePutBundle;
  // Same masked-secret tri-state as topstepApiKey: non-empty string sets,
  // `null` clears, `""` leaves the stored value alone.
  databentoApiKey?: string | null;
  marketData?: MarketDataPutBundle;
  /**
   * The first run's terminal action, and the only thing that clears
   * `<SetupGuard>`. Credential writes stamp `setup_confirmed_at` as a side
   * effect when they touch the Topstep tuple, which covers nothing else — a
   * Tradovate-only install, or an env-creds install where the operator
   * changed no field at all, would otherwise leave the guard redirecting
   * forever with every credential already in place.
   *
   * Write-only and one-way: `true` stamps it, `false` is refused rather than
   * silently reopening first run.
   */
  confirmSetup?: true;
}

export interface MarketDataPutBundle {
  historicalProviderId?: string;
  realtimeProviderId?: string;
}

export interface TradovatePutBundle {
  username?: string | null;
  password?: string | null;
  apiCid?: string | null;
  apiSecret?: string | null;
  appId?: string | null;
  appVersion?: string | null;
  deviceId?: string | null;
}

function isSettingSource(v: unknown): v is SettingSource {
  return v === "db" || v === "env" || v === "unset";
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export function parseSettingsBundle(input: unknown): SettingsBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "Bundle must be an object" };
  }
  const o = input as Record<string, unknown>;
  if (!isStringOrNull(o.topstepUsername)) return { error: "topstepUsername must be string or null" };
  if (!isSettingSource(o.topstepUsernameSource)) return { error: "topstepUsernameSource invalid" };
  if (typeof o.hasApiKey !== "boolean") return { error: "hasApiKey must be boolean" };
  if (!isSettingSource(o.apiKeySource)) return { error: "apiKeySource invalid" };
  if (typeof o.hasWebhookUrl !== "boolean") return { error: "hasWebhookUrl must be boolean" };
  if (!isStringOrNull(o.topstepWebhookUrlPreview)) return { error: "topstepWebhookUrlPreview must be string or null" };
  if (!isSettingSource(o.webhookUrlSource)) return { error: "webhookUrlSource invalid" };
  if (typeof o.notificationsEnabled !== "boolean") return { error: "notificationsEnabled must be boolean" };
  if (o.needsSetup !== false) return { error: "needsSetup must be false on /api/settings" };
  if (!isStringOrNull(o.setupConfirmedAt)) return { error: "setupConfirmedAt must be string or null" };
  if (typeof o.topstepCredsValidated !== "boolean") return { error: "topstepCredsValidated must be boolean" };
  if (!isStringOrNull(o.topstepCredsValidatedAt)) return { error: "topstepCredsValidatedAt must be string or null" };
  if (typeof o.tradovateCredsValidated !== "boolean") return { error: "tradovateCredsValidated must be boolean" };
  if (!isStringOrNull(o.tradovateCredsValidatedAt)) return { error: "tradovateCredsValidatedAt must be string or null" };
  const tradovate = parseTradovateSettingsBundle(o.tradovate);
  if ("error" in tradovate) return tradovate;
  const marketData = parseMarketDataSettingsBundle(o.marketData);
  if ("error" in marketData) return marketData;
  return {
    topstepUsername: o.topstepUsername,
    topstepUsernameSource: o.topstepUsernameSource,
    hasApiKey: o.hasApiKey,
    apiKeySource: o.apiKeySource,
    hasWebhookUrl: o.hasWebhookUrl,
    topstepWebhookUrlPreview: o.topstepWebhookUrlPreview,
    webhookUrlSource: o.webhookUrlSource,
    notificationsEnabled: o.notificationsEnabled,
    needsSetup: false,
    setupConfirmedAt: o.setupConfirmedAt,
    tradovate,
    topstepCredsValidated: o.topstepCredsValidated,
    topstepCredsValidatedAt: o.topstepCredsValidatedAt,
    tradovateCredsValidated: o.tradovateCredsValidated,
    tradovateCredsValidatedAt: o.tradovateCredsValidatedAt,
    marketData,
  };
}

function parseMarketDataSettingsBundle(
  input: unknown,
): MarketDataSettingsBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "marketData bundle missing" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.historicalProviderId !== "string") {
    return { error: "marketData.historicalProviderId must be a string" };
  }
  if (typeof o.realtimeProviderId !== "string") {
    return { error: "marketData.realtimeProviderId must be a string" };
  }
  if (!Array.isArray(o.providers)) return { error: "marketData.providers must be an array" };
  const providers: MarketDataProviderBundle[] = [];
  for (const raw of o.providers) {
    const provider = parseMarketDataProviderBundle(raw);
    if ("error" in provider) return provider;
    providers.push(provider);
  }
  const databento = parseDatabentoSettingsBundle(o.databento);
  if ("error" in databento) return databento;
  return {
    historicalProviderId: o.historicalProviderId,
    realtimeProviderId: o.realtimeProviderId,
    providers,
    databento,
  };
}

function parseMarketDataProviderBundle(
  input: unknown,
): MarketDataProviderBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "marketData.providers entry must be an object" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string") return { error: "provider.id must be a string" };
  if (typeof o.displayName !== "string") return { error: "provider.displayName must be a string" };
  if (typeof o.isConfigured !== "boolean") return { error: "provider.isConfigured must be boolean" };
  if (typeof o.capabilities !== "object" || o.capabilities === null) {
    return { error: "provider.capabilities missing" };
  }
  const c = o.capabilities as Record<string, unknown>;
  if (typeof c.historicalBars !== "boolean") return { error: "capabilities.historicalBars invalid" };
  if (typeof c.liveBars !== "boolean") return { error: "capabilities.liveBars invalid" };
  if (typeof c.liveQuotes !== "boolean") return { error: "capabilities.liveQuotes invalid" };
  if (!Array.isArray(o.fields)) return { error: "provider.fields must be an array" };
  const fields: MarketDataCredentialFieldBundle[] = [];
  for (const raw of o.fields) {
    if (typeof raw !== "object" || raw === null) {
      return { error: "provider.fields entry must be an object" };
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.key !== "string") return { error: "field.key must be a string" };
    if (typeof f.label !== "string") return { error: "field.label must be a string" };
    if (typeof f.secret !== "boolean") return { error: "field.secret must be boolean" };
    if (typeof f.required !== "boolean") return { error: "field.required must be boolean" };
    if (!isStringOrNull(f.envFallback)) return { error: "field.envFallback must be string or null" };
    fields.push({
      key: f.key,
      label: f.label,
      secret: f.secret,
      required: f.required,
      envFallback: f.envFallback,
    });
  }
  return {
    id: o.id,
    displayName: o.displayName,
    isConfigured: o.isConfigured,
    capabilities: {
      historicalBars: c.historicalBars,
      liveBars: c.liveBars,
      liveQuotes: c.liveQuotes,
    },
    fields,
  };
}

function parseDatabentoSettingsBundle(
  input: unknown,
): DatabentoSettingsBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "marketData.databento missing" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.hasApiKey !== "boolean") return { error: "databento.hasApiKey must be boolean" };
  if (!isSettingSource(o.apiKeySource)) return { error: "databento.apiKeySource invalid" };
  if (typeof o.credsValidated !== "boolean") {
    return { error: "databento.credsValidated must be boolean" };
  }
  if (!isStringOrNull(o.credsValidatedAt)) {
    return { error: "databento.credsValidatedAt must be string or null" };
  }
  let coverage: DatabentoCoverageBundle | null = null;
  if (o.coverage !== null && o.coverage !== undefined) {
    if (typeof o.coverage !== "object") return { error: "databento.coverage must be an object" };
    const c = o.coverage as Record<string, unknown>;
    if (
      typeof c.dataset !== "string" ||
      typeof c.start !== "string" ||
      typeof c.end !== "string" ||
      typeof c.probedAt !== "string"
    ) {
      return { error: "databento.coverage fields must be strings" };
    }
    coverage = { dataset: c.dataset, start: c.start, end: c.end, probedAt: c.probedAt };
  }
  return {
    hasApiKey: o.hasApiKey,
    apiKeySource: o.apiKeySource,
    credsValidated: o.credsValidated,
    credsValidatedAt: o.credsValidatedAt,
    coverage,
  };
}

function parseTradovateSettingsBundle(
  input: unknown,
): TradovateSettingsBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "tradovate bundle missing" };
  }
  const o = input as Record<string, unknown>;
  if (!isStringOrNull(o.username)) return { error: "tradovate.username must be string or null" };
  if (!isStringOrNull(o.apiCid)) return { error: "tradovate.apiCid must be string or null" };
  if (!isStringOrNull(o.appId)) return { error: "tradovate.appId must be string or null" };
  if (!isStringOrNull(o.appVersion)) return { error: "tradovate.appVersion must be string or null" };
  if (!isStringOrNull(o.deviceId)) return { error: "tradovate.deviceId must be string or null" };
  if (typeof o.hasPassword !== "boolean") return { error: "tradovate.hasPassword must be boolean" };
  if (typeof o.hasApiSecret !== "boolean") return { error: "tradovate.hasApiSecret must be boolean" };
  if (typeof o.isComplete !== "boolean") return { error: "tradovate.isComplete must be boolean" };
  if (typeof o.appIdAuto !== "boolean") return { error: "tradovate.appIdAuto must be boolean" };
  if (typeof o.appVersionAuto !== "boolean") return { error: "tradovate.appVersionAuto must be boolean" };
  if (typeof o.deviceIdAuto !== "boolean") return { error: "tradovate.deviceIdAuto must be boolean" };
  return {
    username: o.username,
    apiCid: o.apiCid,
    appId: o.appId,
    appVersion: o.appVersion,
    deviceId: o.deviceId,
    hasPassword: o.hasPassword,
    hasApiSecret: o.hasApiSecret,
    isComplete: o.isComplete,
    appIdAuto: o.appIdAuto,
    appVersionAuto: o.appVersionAuto,
    deviceIdAuto: o.deviceIdAuto,
  };
}

export function parsePutBody(input: unknown): PutBody | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "Expected object body" };
  }
  const o = input as Record<string, unknown>;
  const out: PutBody = {};
  if ("topstepUsername" in o) {
    if (!isStringOrNull(o.topstepUsername)) {
      return { error: "topstepUsername must be string or null" };
    }
    if (typeof o.topstepUsername === "string" && (o.topstepUsername.length < 1 || o.topstepUsername.length > 128)) {
      return { error: "topstepUsername must be 1-128 chars" };
    }
    out.topstepUsername = o.topstepUsername;
  }
  if ("topstepApiKey" in o) {
    if (!isStringOrNull(o.topstepApiKey)) {
      return { error: "topstepApiKey must be string or null" };
    }
    if (typeof o.topstepApiKey === "string" && o.topstepApiKey.length > 512) {
      return { error: "topstepApiKey must be ≤ 512 chars" };
    }
    out.topstepApiKey = o.topstepApiKey;
  }
  if ("topstepWebhookUrl" in o) {
    if (!isStringOrNull(o.topstepWebhookUrl)) {
      return { error: "topstepWebhookUrl must be string or null" };
    }
    if (typeof o.topstepWebhookUrl === "string" && o.topstepWebhookUrl.length > 0 && !o.topstepWebhookUrl.startsWith("https://")) {
      return { error: "topstepWebhookUrl must start with https://" };
    }
    out.topstepWebhookUrl = o.topstepWebhookUrl;
  }
  if ("notificationsEnabled" in o) {
    if (typeof o.notificationsEnabled !== "boolean") {
      return { error: "notificationsEnabled must be boolean" };
    }
    out.notificationsEnabled = o.notificationsEnabled;
  }
  if ("databentoApiKey" in o) {
    if (!isStringOrNull(o.databentoApiKey)) {
      return { error: "databentoApiKey must be string or null" };
    }
    if (typeof o.databentoApiKey === "string" && o.databentoApiKey.length > 512) {
      return { error: "databentoApiKey must be ≤ 512 chars" };
    }
    out.databentoApiKey = o.databentoApiKey;
  }
  if ("tradovate" in o) {
    const tradovate = parseTradovatePutBundle(o.tradovate);
    if ("error" in tradovate) return tradovate;
    out.tradovate = tradovate;
  }
  if ("marketData" in o) {
    const marketData = parseMarketDataPutBundle(o.marketData);
    if ("error" in marketData) return marketData;
    out.marketData = marketData;
  }
  if ("confirmSetup" in o) {
    if (o.confirmSetup !== true) {
      return { error: "confirmSetup may only be true" };
    }
    out.confirmSetup = true;
  }
  return out;
}

/** Selections are ids, never null — there is no "unselected" state; both
 *  slots always resolve, defaulting to Topstep. Whether an id is
 *  registered and capable is the registry's question, not the parser's. */
function parseMarketDataPutBundle(input: unknown): MarketDataPutBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "marketData must be an object" };
  }
  const o = input as Record<string, unknown>;
  const out: MarketDataPutBundle = {};
  for (const field of ["historicalProviderId", "realtimeProviderId"] as const) {
    if (!(field in o)) continue;
    const v = o[field];
    if (typeof v !== "string" || v.length === 0 || v.length > 64) {
      return { error: `marketData.${field} must be a non-empty string` };
    }
    out[field] = v;
  }
  return out;
}

const TRADOVATE_FIELD_LIMITS: Record<keyof TradovatePutBundle, number> = {
  username: 128,
  password: 256,
  apiCid: 128,
  apiSecret: 512,
  appId: 128,
  appVersion: 64,
  deviceId: 128,
};

function parseTradovatePutBundle(
  input: unknown,
): TradovatePutBundle | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "tradovate must be an object" };
  }
  const o = input as Record<string, unknown>;
  const out: TradovatePutBundle = {};
  for (const field of Object.keys(TRADOVATE_FIELD_LIMITS) as Array<
    keyof TradovatePutBundle
  >) {
    if (!(field in o)) continue;
    const v = o[field];
    if (!isStringOrNull(v)) {
      return { error: `tradovate.${field} must be string or null` };
    }
    if (typeof v === "string" && v.length > TRADOVATE_FIELD_LIMITS[field]) {
      return {
        error: `tradovate.${field} must be ≤ ${TRADOVATE_FIELD_LIMITS[field]} chars`,
      };
    }
    out[field] = v;
  }
  return out;
}
