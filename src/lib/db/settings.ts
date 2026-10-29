import { getDb, registerMigration } from "./connection";

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
});

interface SettingRow {
  value: string;
}

function getSetting(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as SettingRow | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

const NOTIFICATIONS_KEY = "notifications_enabled";

// Off by default: prevents Discord blasts on a fresh deploy until the
// operator explicitly opts in via the TopNav toggle.
export function getNotificationsEnabled(): boolean {
  const raw = getSetting(NOTIFICATIONS_KEY);
  return raw === "true";
}

export function setNotificationsEnabled(value: boolean): void {
  setSetting(NOTIFICATIONS_KEY, value ? "true" : "false");
}

// Broker-prefixed singletons for Topstep credentials + webhook. Keys carry
// the `topstep_` prefix from day one so a future Tradovate-on-DB move can
// add `tradovate_username` etc. alongside without rename + back-fill.
//
// v1 = ONE Topstep login per install. If multi-login ever ships, the
// contract is: new logins get a numeric suffix (`topstep_username_<id>`),
// deployments get bound to a `login_id` at create time, and switching the
// active login in place is forbidden — every deployment row's account
// list is scoped to the login that owned it. Don't refactor these
// singletons into a "switch the active login" hook without doing the
// deployment-rebinding work first.
const TOPSTEP_USERNAME_KEY = "topstep_username";
const TOPSTEP_API_KEY_KEY = "topstep_api_key";
const TOPSTEP_WEBHOOK_URL_KEY = "topstep_webhook_url";

export function getTopstepUsername(): string | null {
  return getSetting(TOPSTEP_USERNAME_KEY);
}

export function setTopstepUsername(value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(TOPSTEP_USERNAME_KEY);
    return;
  }
  setSetting(TOPSTEP_USERNAME_KEY, value);
}

export function getTopstepApiKey(): string | null {
  return getSetting(TOPSTEP_API_KEY_KEY);
}

export function setTopstepApiKey(value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(TOPSTEP_API_KEY_KEY);
    return;
  }
  setSetting(TOPSTEP_API_KEY_KEY, value);
}

export function getTopstepWebhookUrl(): string | null {
  return getSetting(TOPSTEP_WEBHOOK_URL_KEY);
}

export function setTopstepWebhookUrl(value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(TOPSTEP_WEBHOOK_URL_KEY);
    return;
  }
  setSetting(TOPSTEP_WEBHOOK_URL_KEY, value);
}

// Phase 6b confirmation. setup_confirmed_at is the ISO timestamp of the
// last wizard confirmation (or PUT touching creds). setup_confirmed_signature
// is the SHA-256 hash of the inputs at that moment — see setup-signature.ts
// for the contract. Both are app-wide (not broker-prefixed) because
// confirmation is a single-install concept, not a per-broker credential.
const SETUP_CONFIRMED_AT_KEY = "setup_confirmed_at";
const SETUP_CONFIRMED_SIGNATURE_KEY = "setup_confirmed_signature";

export function getSetupConfirmedAt(): string | null {
  return getSetting(SETUP_CONFIRMED_AT_KEY);
}

export function setSetupConfirmedAt(value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(SETUP_CONFIRMED_AT_KEY);
    return;
  }
  setSetting(SETUP_CONFIRMED_AT_KEY, value);
}

export function getSetupSignature(): string | null {
  return getSetting(SETUP_CONFIRMED_SIGNATURE_KEY);
}

export function setSetupSignature(value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(SETUP_CONFIRMED_SIGNATURE_KEY);
    return;
  }
  setSetting(SETUP_CONFIRMED_SIGNATURE_KEY, value);
}

export function clearSetupConfirmedAt(): void {
  setSetupConfirmedAt(null);
}

export function clearSetupSignature(): void {
  setSetupSignature(null);
}

// ── Tradovate credentials ─────────────────────────────────────────────
//
// Phase 1 of the Tradovate integration. Same broker-prefixed singleton
// pattern as Topstep — one Tradovate login per install. Secrets
// (password, api_secret) are write-only on the wire (mirrors how
// topstep_api_key is handled in /api/settings); non-secrets (username,
// app_id, app_version, device_id, api_cid) round-trip to the client.
//
// Stored in the same `app_settings` table — no schema migration needed
// since it's a key/value store. Existing installs see NULL until the
// operator fills in the wizard or Settings page.

const TRADOVATE_USERNAME_KEY = "tradovate_username";
const TRADOVATE_PASSWORD_KEY = "tradovate_password";
const TRADOVATE_API_CID_KEY = "tradovate_api_cid";
const TRADOVATE_API_SECRET_KEY = "tradovate_api_secret";
const TRADOVATE_APP_ID_KEY = "tradovate_app_id";
const TRADOVATE_APP_VERSION_KEY = "tradovate_app_version";
const TRADOVATE_DEVICE_ID_KEY = "tradovate_device_id";
// Tracks whether the operator has explicitly overridden the auto-generated
// deviceId. Unlike appId/appVersion (which compare against constant
// defaults), deviceId is a random UUID per install — there's no constant
// to diff against, so we record intent here instead. Drives the AUTO
// badge predicate in the wizard / Settings page.
const TRADOVATE_DEVICE_ID_USER_SET_KEY = "tradovate_device_id_user_set";

function setOrDelete(key: string, value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
    return;
  }
  setSetting(key, value);
}

export function getTradovateUsername(): string | null {
  return getSetting(TRADOVATE_USERNAME_KEY);
}
export function setTradovateUsername(value: string | null): void {
  setOrDelete(TRADOVATE_USERNAME_KEY, value);
}

export function getTradovatePassword(): string | null {
  return getSetting(TRADOVATE_PASSWORD_KEY);
}
export function setTradovatePassword(value: string | null): void {
  setOrDelete(TRADOVATE_PASSWORD_KEY, value);
}

export function getTradovateApiCid(): string | null {
  return getSetting(TRADOVATE_API_CID_KEY);
}
export function setTradovateApiCid(value: string | null): void {
  setOrDelete(TRADOVATE_API_CID_KEY, value);
}

export function getTradovateApiSecret(): string | null {
  return getSetting(TRADOVATE_API_SECRET_KEY);
}
export function setTradovateApiSecret(value: string | null): void {
  setOrDelete(TRADOVATE_API_SECRET_KEY, value);
}

export function getTradovateAppId(): string | null {
  return getSetting(TRADOVATE_APP_ID_KEY);
}
export function setTradovateAppId(value: string | null): void {
  setOrDelete(TRADOVATE_APP_ID_KEY, value);
}

export function getTradovateAppVersion(): string | null {
  return getSetting(TRADOVATE_APP_VERSION_KEY);
}
export function setTradovateAppVersion(value: string | null): void {
  setOrDelete(TRADOVATE_APP_VERSION_KEY, value);
}

export function getTradovateDeviceId(): string | null {
  return getSetting(TRADOVATE_DEVICE_ID_KEY);
}
export function setTradovateDeviceId(value: string | null): void {
  setOrDelete(TRADOVATE_DEVICE_ID_KEY, value);
}

export function getTradovateDeviceIdUserSet(): boolean {
  return getSetting(TRADOVATE_DEVICE_ID_USER_SET_KEY) === "true";
}
export function setTradovateDeviceIdUserSet(value: boolean): void {
  setSetting(TRADOVATE_DEVICE_ID_USER_SET_KEY, value ? "true" : "false");
}
export function clearTradovateDeviceIdUserSet(): void {
  setOrDelete(TRADOVATE_DEVICE_ID_USER_SET_KEY, null);
}

// ── Databento credential ──────────────────────────────────────────────
//
// Same broker-prefixed singleton pattern as Topstep/Tradovate, keyed by
// the vendor rather than a broker. Write-only on the wire.
//
// OPTIONAL, unlike every broker credential. The provider serves historical
// bars out of the Parquet cache and `isConfigured()` keys on
// BAR_CACHE_DIR — prod mounts the cache read-only and holds no key at all.
// The key is stored anyway because Databento's live feed will need it on a
// Standard subscription, and the entitlement probe needs it today.
// `resolveDatabentoApiKey()` in settings-cache.ts falls back to
// DATABENTO_API_KEY; the backfill script reads env directly because it
// runs on a dev machine or a CI agent, not against this DB.

const DATABENTO_API_KEY_KEY = "databento_api_key";

export function getDatabentoApiKey(): string | null {
  return getSetting(DATABENTO_API_KEY_KEY);
}

export function setDatabentoApiKey(value: string | null): void {
  setOrDelete(DATABENTO_API_KEY_KEY, value);
}

// Last successful entitlement probe, cached so Settings can render
// "historical coverage through …" and a staleness age without making a
// network call on every GET. Written only by the provider's
// testConnection; a probe is the only thing that knows the answer.
const DATABENTO_PROBE_RANGE_KEY = "databento_probe_range";

export interface DatabentoProbeRange {
  dataset: string;
  start: string;
  end: string;
  probedAt: string;
}

export function getDatabentoProbeRange(): DatabentoProbeRange | null {
  const raw = getSetting(DATABENTO_PROBE_RANGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.dataset !== "string" ||
    typeof o.start !== "string" ||
    typeof o.end !== "string" ||
    typeof o.probedAt !== "string"
  ) {
    return null;
  }
  return { dataset: o.dataset, start: o.start, end: o.end, probedAt: o.probedAt };
}

export function setDatabentoProbeRange(value: DatabentoProbeRange | null): void {
  setOrDelete(DATABENTO_PROBE_RANGE_KEY, value === null ? null : JSON.stringify(value));
}

// ── Market-data provider selection ────────────────────────────────────
//
// Two independent slots, not one active provider: `historical` feeds
// backtest / export / chart / replay, `realtime` feeds the engine,
// /api/quotes and the dev probes. Unset means "the registry's default",
// which is Topstep — so an install that never opens Settings behaves
// exactly as it did before the slots existed.
//
// Deliberately no exported key array here. `CRED_VALIDATION_KEYS` has
// that shape because /api/settings/reset spreads it into its delete
// list; these keys are operator preferences rather than secrets and are
// preserved across a factory reset, so an array beside them is an
// invitation to wipe them by pattern-match.

const MARKET_DATA_HISTORICAL_PROVIDER_KEY = "market_data_historical_provider";
const MARKET_DATA_REALTIME_PROVIDER_KEY = "market_data_realtime_provider";

export function getMarketDataHistoricalProvider(): string | null {
  return getSetting(MARKET_DATA_HISTORICAL_PROVIDER_KEY);
}

export function setMarketDataHistoricalProvider(value: string | null): void {
  setOrDelete(MARKET_DATA_HISTORICAL_PROVIDER_KEY, value);
}

export function getMarketDataRealtimeProvider(): string | null {
  return getSetting(MARKET_DATA_REALTIME_PROVIDER_KEY);
}

export function setMarketDataRealtimeProvider(value: string | null): void {
  setOrDelete(MARKET_DATA_REALTIME_PROVIDER_KEY, value);
}

// The one-shot retirement of derived rows on cells their book no longer
// carries ran on this database (ISO instant). One key per run-once step,
// as persistence/README.md says; nothing else reads it.
const OFF_CELL_ROWS_RETIRED_KEY = "derived_off_cell_rows_retired_at";

export function getOffCellRowsRetiredAt(): string | null {
  return getSetting(OFF_CELL_ROWS_RETIRED_KEY);
}

export function setOffCellRowsRetiredAt(value: string): void {
  setSetting(OFF_CELL_ROWS_RETIRED_KEY, value);
}

// prevents priming-tick re-entry after restart bypassing SL/filter gates
export function getLastBarTimestamp(deploymentId: string): string | null {
  return getSetting(`lastBarTimestamp:${deploymentId}`);
}

export function setLastBarTimestamp(deploymentId: string, timestamp: string): void {
  setSetting(`lastBarTimestamp:${deploymentId}`, timestamp);
}
