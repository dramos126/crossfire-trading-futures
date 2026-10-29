/**
 * The broker-shaped half of the Settings page: how a schema field maps onto
 * the settings bundle, and what a Save or a Test carries.
 *
 * **The blocks are generated, not hand-written** — the Connections section is
 * `schemas.map(...)`, so registering a broker adds its block with no UI
 * change. What cannot be generated is the *mapping* between a schema's field
 * keys and the bundle's own shape, which is per-broker by construction; this
 * file is where that lives so the component stays a renderer.
 *
 * Owned by docs/modules/ui/design-language.md.
 */

import type { SettingsBundle, SettingSource } from "@/lib/settings/parse-bundle";
import type { SettingsTestState } from "@/components/settings/settings-connection-controls";
/** The server's own field descriptor, type-only so nothing server-side reaches
 *  the bundle. A second client-side declaration drifted from it immediately —
 *  it grew a `hint` no plugin emits (three unreachable branches) and dropped
 *  `envFallback`, which Topstep's two fields carry and Tradovate's seven do
 *  not. Both routes serve `credentialSchema()` verbatim, so this is the wire
 *  shape. */
import type { CredentialField } from "@/lib/brokers/plugin";

export interface BrokerSchema {
  id: string;
  displayName: string;
  isConfigured: boolean;
  fields: CredentialField[];
}

/**
 * The broker schema list, from either route that serves it.
 *
 * Both arms of the first run read `credentialSchema()` output over the network
 * — `/api/settings/schemas` with a session, `/api/settings/setup-prefill`
 * without one — and both hand it straight to `seedForms`, which reads
 * `field.secret` and `field.key` off every element. A cast let a malformed
 * element through to throw inside a state updater, which on the no-session arm
 * degrades to an error box with no way forward.
 */
export function parseBrokerSchemas(input: unknown): BrokerSchema[] | null {
  if (!Array.isArray(input)) return null;
  const schemas: BrokerSchema[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.displayName !== "string") return null;
    if (!Array.isArray(o.fields)) return null;
    const fields: CredentialField[] = [];
    for (const rawField of o.fields) {
      if (typeof rawField !== "object" || rawField === null) return null;
      const f = rawField as Record<string, unknown>;
      if (typeof f.key !== "string" || typeof f.label !== "string") return null;
      if (typeof f.secret !== "boolean" || typeof f.required !== "boolean") return null;
      fields.push({
        key: f.key,
        label: f.label,
        secret: f.secret,
        required: f.required,
        ...(typeof f.envFallback === "string" ? { envFallback: f.envFallback } : {}),
      });
    }
    schemas.push({
      id: o.id,
      displayName: o.displayName,
      isConfigured: o.isConfigured === true,
      fields,
    });
  }
  return schemas;
}

/** The three Tradovate fields the server fills in unless the operator says otherwise. */
const TRADOVATE_AUTO_FIELDS = [
  "tradovateAppId",
  "tradovateAppVersion",
  "tradovateDeviceId",
] as const;

export function isAutoField(key: string): boolean {
  return (TRADOVATE_AUTO_FIELDS as readonly string[]).includes(key);
}

/** A field's stored value, or null where the bundle has none to give. */
export function resolveBundleValue(
  brokerId: string,
  fieldKey: string,
  bundle: SettingsBundle,
): string | null {
  if (brokerId === "topstep") {
    if (fieldKey === "topstepUsername") return bundle.topstepUsername;
    // topstepApiKey is secret — always seed empty
    return null;
  }
  if (brokerId === "tradovate") {
    const tv = bundle.tradovate;
    if (fieldKey === "tradovateUsername") return tv.username;
    if (fieldKey === "tradovateApiCid") return tv.apiCid;
    if (fieldKey === "tradovateAppId") return tv.appId;
    if (fieldKey === "tradovateAppVersion") return tv.appVersion;
    if (fieldKey === "tradovateDeviceId") return tv.deviceId;
    // tradovatePassword / tradovateApiSecret: secrets — always empty
    return null;
  }
  return null;
}

export function buildLockedFields(brokerId: string, bundle: SettingsBundle | null): Set<string> {
  const locked = new Set<string>();
  if (bundle === null) return locked;
  if (brokerId === "topstep") {
    if (bundle.topstepUsernameSource === "db") locked.add("topstepUsername");
    if (bundle.apiKeySource === "db") locked.add("topstepApiKey");
  }
  return locked;
}

/**
 * Which of a block's fields currently hold a server-filled value.
 *
 * **Keyed off `TRADOVATE_AUTO_FIELDS` rather than re-listing the three**, so
 * the badge and `brokerInUse`'s exclusion cannot drift apart. They were two
 * independent literals that happened to agree; a fourth seeded field added to
 * this one and not to that one would get an AUTO badge, get server-filled, and
 * then be counted as operator input — which is the redirect-loop defect this
 * phase shipped and fixed, re-entered with a green suite, because a fixture
 * carrying both brokers does not catch a missing *field*.
 */
export function buildAutoState(
  brokerId: string,
  auto: { appIdAuto: boolean; appVersionAuto: boolean; deviceIdAuto: boolean } | null,
): Record<string, boolean> {
  if (brokerId !== "tradovate" || auto === null) return {};
  const flags: Record<(typeof TRADOVATE_AUTO_FIELDS)[number], boolean> = {
    tradovateAppId: auto.appIdAuto,
    tradovateAppVersion: auto.appVersionAuto,
    tradovateDeviceId: auto.deviceIdAuto,
  };
  return Object.fromEntries(TRADOVATE_AUTO_FIELDS.map((key) => [key, flags[key]]));
}

/**
 * A block opens showing `✓ Verified` when the stored credentials already
 * passed one. **This is the only thing that counts as verified**, and it is
 * what keeps a saved-but-wrong credential from unlocking the Market Data
 * block on a first run.
 *
 * **It reads two columns, and that is load-bearing rather than defensive.**
 * `POST /api/settings/setup` writes the validated *signature* with no
 * authentication attempt — the deliberate escape for env credentials the
 * engine authenticated at boot but never stamped — which is enough on its own
 * to flip `credsValidated`. Only `plugin.testConnection()` writes
 * `credsValidatedAt`, so requiring both is what makes this a probe result
 * rather than a stored field. Do not relax it to the boolean.
 */
export function buildInitialTestState(
  brokerId: string,
  bundle: SettingsBundle | null,
): SettingsTestState {
  if (bundle === null) return { kind: "idle" };
  if (brokerId === "topstep" && bundle.topstepCredsValidated && bundle.topstepCredsValidatedAt) {
    const ts = Date.parse(bundle.topstepCredsValidatedAt);
    return { kind: "passed", at: Number.isFinite(ts) ? ts : Date.now() };
  }
  if (
    brokerId === "tradovate" &&
    bundle.tradovateCredsValidated &&
    bundle.tradovateCredsValidatedAt
  ) {
    const ts = Date.parse(bundle.tradovateCredsValidatedAt);
    return { kind: "passed", at: Number.isFinite(ts) ? ts : Date.now() };
  }
  return { kind: "idle" };
}

/**
 * The test state the block actually renders. A `passed` result from a form
 * Test Connection stands for "these typed values authenticate", not "the
 * stored credentials are validated" — so while the form has unsaved edits
 * (`dirty`), it is downgraded to `idle` and the ✓ Verified badge clears. A
 * green badge then always means what is stored passed, which is the only
 * thing `buildInitialTestState` ever reports and what Save is gated on.
 */
export function visibleTestState(
  testState: SettingsTestState,
  dirty: boolean,
): SettingsTestState {
  if (dirty && testState.kind === "passed") return { kind: "idle" };
  return testState;
}

export function buildTestFields(
  schema: BrokerSchema,
  fieldValues: Record<string, string>,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    const v = fieldValues[f.key];
    if (typeof v === "string" && v.length > 0) fields[f.key] = v;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function buildCanTest(
  schema: BrokerSchema,
  fieldValues: Record<string, string>,
  bundle: SettingsBundle | null,
  testState: SettingsTestState,
): boolean {
  if (testState.kind === "testing") return false;
  if (bundle !== null && schema.isConfigured) return true;
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = fieldValues[f.key];
    if (f.secret) {
      const stored = bundle !== null && hasStoredSecret(schema.id, f.key, bundle);
      if (!stored && (!v || v.length === 0)) return false;
    } else {
      if (!v || v.trim().length === 0) return false;
    }
  }
  return true;
}

export function hasStoredSecret(
  brokerId: string,
  fieldKey: string,
  bundle: SettingsBundle,
): boolean {
  if (brokerId === "tradovate") {
    if (fieldKey === "tradovatePassword") return bundle.tradovate.hasPassword;
    if (fieldKey === "tradovateApiSecret") return bundle.tradovate.hasApiSecret;
  }
  if (brokerId === "topstep") {
    if (fieldKey === "topstepApiKey") return bundle.hasApiKey;
  }
  return false;
}

export function buildSaveBody(
  schema: BrokerSchema,
  fieldValues: Record<string, string>,
  bundle: SettingsBundle,
): Record<string, unknown> {
  if (schema.id === "topstep") return buildTopstepSaveBody(fieldValues, bundle);
  if (schema.id === "tradovate") return buildTradovateSaveBody(fieldValues, bundle);
  return {};
}

function buildTopstepSaveBody(
  fieldValues: Record<string, string>,
  bundle: SettingsBundle,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const username = (fieldValues["topstepUsername"] ?? "").trim();
  if (username !== (bundle.topstepUsername ?? "")) {
    body.topstepUsername = username.length === 0 ? null : username;
  }
  const apiKey = fieldValues["topstepApiKey"] ?? "";
  if (apiKey.length > 0) body.topstepApiKey = apiKey;
  return body;
}

function buildTradovateSaveBody(
  fieldValues: Record<string, string>,
  bundle: SettingsBundle,
): Record<string, unknown> {
  const tv: Record<string, string | null> = {};
  const nonSecret = (key: string, prev: string | null): string | null | undefined => {
    const trimmed = (fieldValues[key] ?? "").trim();
    const next = trimmed.length === 0 ? null : trimmed;
    return next === prev ? undefined : next;
  };
  const u = nonSecret("tradovateUsername", bundle.tradovate.username);
  if (u !== undefined) tv.username = u;
  const c = nonSecret("tradovateApiCid", bundle.tradovate.apiCid);
  if (c !== undefined) tv.apiCid = c;
  const ai = nonSecret("tradovateAppId", bundle.tradovate.appId);
  if (ai !== undefined) tv.appId = ai;
  const av = nonSecret("tradovateAppVersion", bundle.tradovate.appVersion);
  if (av !== undefined) tv.appVersion = av;
  const d = nonSecret("tradovateDeviceId", bundle.tradovate.deviceId);
  if (d !== undefined) tv.deviceId = d;
  const pass = fieldValues["tradovatePassword"] ?? "";
  if (pass.length > 0) tv.password = pass;
  const sec = fieldValues["tradovateApiSecret"] ?? "";
  if (sec.length > 0) tv.apiSecret = sec;
  if (Object.keys(tv).length === 0) return {};
  return { tradovate: tv };
}

export function resolveBundleSource(
  brokerId: string,
  fieldKey: string,
  bundle: SettingsBundle | null,
): SettingSource | undefined {
  if (bundle === null) return undefined;
  if (brokerId === "topstep") {
    if (fieldKey === "topstepUsername") return bundle.topstepUsernameSource;
    if (fieldKey === "topstepApiKey") return bundle.apiKeySource;
  }
  return undefined;
}

export function buildPlaceholder(
  field: CredentialField,
  source: SettingSource | undefined,
): string {
  if (field.secret) {
    if (source && source !== "unset") return "•••••• (saved — leave blank to keep)";
    return `Enter ${field.label.toLowerCase()}`;
  }
  if (source === "env") return "•••••• (loaded from env — leave blank to keep)";
  return `Enter ${field.label.toLowerCase()}`;
}

/**
 * Is this broker part of the setup being confirmed?
 *
 * **A server-provided default is not operator input**, and that distinction is
 * the whole predicate. `seedForms` pre-fills Tradovate's three app-identity
 * fields from `resolveTradovateAppIdentity()`, which always returns three
 * non-empty strings — so "any field holds a value" read *every* install as a
 * Tradovate install. The confirm then refused an in-use, unverified broker
 * while `buildCanTest` kept the Test button that would clear the refusal
 * disabled on an empty username, and the only escape was blanking three fields
 * the block simultaneously rendered a `Cannot be empty` error over. That is
 * the redirect loop `confirmSetup` exists to break, re-entered one predicate
 * over.
 *
 * The exclusion reuses `isAutoField` — the same list that draws the AUTO
 * badge and clears it on an edit — rather than restating the three keys.
 */
export function brokerInUse(
  schema: BrokerSchema,
  values: Record<string, string>,
  bundle: SettingsBundle | null,
): boolean {
  if (bundle !== null && schema.isConfigured) return true;
  return schema.fields.some(
    (f) => !isAutoField(f.key) && (values[f.key] ?? "").trim().length > 0,
  );
}
