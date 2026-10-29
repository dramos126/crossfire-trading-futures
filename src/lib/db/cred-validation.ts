import { createHash } from "node:crypto";
import { getDb } from "./connection";

/**
 * Per-member credential validation signatures — brokers and market-data
 * providers alike; the `{member}_creds_validated_*` key prefix is the only
 * thing that distinguishes them. Distinct from the Phase 6b
 * `setup_confirmed_signature` (which gates engine activation off the
 * username + has_db_key + has_env_key + webhook tuple) — these signatures
 * gate Save: the operator must click Test Connection successfully against
 * a given set of cred values before Save will accept them.
 *
 * The signature is sha256 of the cred fields. The signature itself is
 * non-secret (a 32-byte digest), but it includes secret values in its
 * input — DO NOT log or return the signature to a non-operator surface.
 *
 * Lifetime: indefinite. Re-validation is required only when the operator
 * edits any of the cred fields (signature mismatch). The
 * `_validated_at` timestamp is informational ("Last verified: 3d ago").
 *
 * Databento's key is OPTIONAL where every broker credential is required,
 * so its gate means "if a key is entered it must validate", never "a key
 * must be entered". An absent key is a valid configuration.
 */

const TOPSTEP_VALIDATED_SIG_KEY = "topstep_creds_validated_signature";
const TOPSTEP_VALIDATED_AT_KEY = "topstep_creds_validated_at";
const TRADOVATE_VALIDATED_SIG_KEY = "tradovate_creds_validated_signature";
const TRADOVATE_VALIDATED_AT_KEY = "tradovate_creds_validated_at";
const DATABENTO_VALIDATED_SIG_KEY = "databento_creds_validated_signature";
const DATABENTO_VALIDATED_AT_KEY = "databento_creds_validated_at";

function getSetting(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
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

function clearSetting(key: string): void {
  getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
}

export interface TopstepCredsSignatureInput {
  username: string;
  apiKey: string;
}

export function computeTopstepCredsSignature(input: TopstepCredsSignatureInput): string {
  // CRITICAL: insertion order matters. The ECMAScript spec guarantees
  // JSON.stringify preserves own-property insertion order for string
  // keys, and we rely on that here — every persisted
  // `topstep_creds_validated_signature` was computed against THIS
  // exact field order. If you reorder these keys (or sort them, or
  // switch to a canonical-form library), you will silently invalidate
  // every persisted signature. Operators will see "credentials need
  // to be re-validated" with no obvious cause. DO NOT REORDER.
  const normalized = JSON.stringify({ u: input.username, k: input.apiKey });
  return createHash("sha256").update(normalized).digest("hex");
}

export interface TradovateCredsSignatureInput {
  username: string;
  password: string;
  apiCid: string;
  apiSecret: string;
  appId: string;
  appVersion: string;
  deviceId: string;
}

export function computeTradovateCredsSignature(input: TradovateCredsSignatureInput): string {
  // CRITICAL: insertion order matters. The ECMAScript spec guarantees
  // JSON.stringify preserves own-property insertion order for string
  // keys, and we rely on that here — every persisted
  // `tradovate_creds_validated_signature` was computed against THIS
  // exact field order. If you reorder these keys (or sort them, or
  // switch to a canonical-form library), you will silently invalidate
  // every persisted signature. Operators will see "credentials need
  // to be re-validated" with no obvious cause. DO NOT REORDER.
  const normalized = JSON.stringify({
    u: input.username,
    p: input.password,
    c: input.apiCid,
    s: input.apiSecret,
    a: input.appId,
    v: input.appVersion,
    d: input.deviceId,
  });
  return createHash("sha256").update(normalized).digest("hex");
}

export interface DatabentoCredsSignatureInput {
  apiKey: string;
}

export function computeDatabentoCredsSignature(input: DatabentoCredsSignatureInput): string {
  // CRITICAL: insertion order matters — see the broker signatures above.
  // Single field, but the shape is the same and the same rule applies:
  // adding a field silently invalidates every persisted signature.
  const normalized = JSON.stringify({ k: input.apiKey });
  return createHash("sha256").update(normalized).digest("hex");
}

export function getTopstepCredsValidatedSignature(): string | null {
  return getSetting(TOPSTEP_VALIDATED_SIG_KEY);
}

export function setTopstepCredsValidatedSignature(value: string | null): void {
  if (value === null) clearSetting(TOPSTEP_VALIDATED_SIG_KEY);
  else setSetting(TOPSTEP_VALIDATED_SIG_KEY, value);
}

export function getTopstepCredsValidatedAt(): string | null {
  return getSetting(TOPSTEP_VALIDATED_AT_KEY);
}

export function setTopstepCredsValidatedAt(value: string | null): void {
  if (value === null) clearSetting(TOPSTEP_VALIDATED_AT_KEY);
  else setSetting(TOPSTEP_VALIDATED_AT_KEY, value);
}

export function getTradovateCredsValidatedSignature(): string | null {
  return getSetting(TRADOVATE_VALIDATED_SIG_KEY);
}

export function setTradovateCredsValidatedSignature(value: string | null): void {
  if (value === null) clearSetting(TRADOVATE_VALIDATED_SIG_KEY);
  else setSetting(TRADOVATE_VALIDATED_SIG_KEY, value);
}

export function getTradovateCredsValidatedAt(): string | null {
  return getSetting(TRADOVATE_VALIDATED_AT_KEY);
}

export function setTradovateCredsValidatedAt(value: string | null): void {
  if (value === null) clearSetting(TRADOVATE_VALIDATED_AT_KEY);
  else setSetting(TRADOVATE_VALIDATED_AT_KEY, value);
}

export function getDatabentoCredsValidatedSignature(): string | null {
  return getSetting(DATABENTO_VALIDATED_SIG_KEY);
}

export function setDatabentoCredsValidatedSignature(value: string | null): void {
  if (value === null) clearSetting(DATABENTO_VALIDATED_SIG_KEY);
  else setSetting(DATABENTO_VALIDATED_SIG_KEY, value);
}

export function getDatabentoCredsValidatedAt(): string | null {
  return getSetting(DATABENTO_VALIDATED_AT_KEY);
}

export function setDatabentoCredsValidatedAt(value: string | null): void {
  if (value === null) clearSetting(DATABENTO_VALIDATED_AT_KEY);
  else setSetting(DATABENTO_VALIDATED_AT_KEY, value);
}

/** Settings keys for /api/settings/reset to wipe along with the rest. */
export const CRED_VALIDATION_KEYS = [
  TOPSTEP_VALIDATED_SIG_KEY,
  TOPSTEP_VALIDATED_AT_KEY,
  TRADOVATE_VALIDATED_SIG_KEY,
  TRADOVATE_VALIDATED_AT_KEY,
  DATABENTO_VALIDATED_SIG_KEY,
  DATABENTO_VALIDATED_AT_KEY,
] as const;
