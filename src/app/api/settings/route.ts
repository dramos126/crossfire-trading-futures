import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  clearTradovateDeviceIdUserSet,
  getDatabentoApiKey,
  getDatabentoProbeRange,
  getNotificationsEnabled,
  getSetupConfirmedAt,
  getTopstepApiKey,
  getTopstepUsername,
  getTopstepWebhookUrl,
  getTradovateApiCid,
  getTradovateApiSecret,
  getTradovateAppId,
  getTradovateAppVersion,
  getTradovateDeviceId,
  getTradovatePassword,
  getTradovateUsername,
  setDatabentoApiKey,
  setDatabentoProbeRange,
  setNotificationsEnabled,
  setSetupConfirmedAt,
  setSetupSignature,
  setTopstepWebhookUrl,
  setTradovateDeviceIdUserSet,
} from "@/lib/db/settings";
import { resolveTradovateAppIdentity } from "@/lib/settings/tradovate-defaults";
import {
  databentoApiKeySource,
  invalidateSettingsCache,
  topstepApiKeySource,
  topstepUsernameSource,
  topstepWebhookUrlSource,
  type SettingSource,
} from "@/lib/db/settings-cache";
import { computeConfigSignature } from "@/lib/db/setup-signature";
import {
  computeDatabentoCredsSignature,
  getDatabentoCredsValidatedAt,
  getDatabentoCredsValidatedSignature,
  getTopstepCredsValidatedAt,
  getTopstepCredsValidatedSignature,
  getTradovateCredsValidatedAt,
  getTradovateCredsValidatedSignature,
} from "@/lib/db/cred-validation";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import type { MarketDataSlot } from "@/lib/market-data/registry";
import { readTradovateCredentialsFromDb } from "@/lib/brokers/tradovate/client";
import { getDb } from "@/lib/db/connection";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { log } from "@/lib/logger";
import {
  parsePutBody,
  type DatabentoSettingsBundle,
  type MarketDataSettingsBundle,
  type PutBody,
  type TradovatePutBundle,
} from "@/lib/settings/parse-bundle";

const handle = engineHandle();

interface TradovateBundle {
  username: string | null;
  apiCid: string | null;
  appId: string | null;
  appVersion: string | null;
  deviceId: string | null;
  hasPassword: boolean;
  hasApiSecret: boolean;
  isComplete: boolean;
  appIdAuto: boolean;
  appVersionAuto: boolean;
  deviceIdAuto: boolean;
}

interface SettingsBundle {
  topstepUsername: string | null;
  topstepUsernameSource: SettingSource;
  hasApiKey: boolean;
  apiKeySource: SettingSource;
  hasWebhookUrl: boolean;
  topstepWebhookUrlPreview: string | null;
  webhookUrlSource: SettingSource;
  notificationsEnabled: boolean;
  // Phase 6b — needsSetup is always false on this route (its 503 mirror
  // lives at /api/auth). Present for shape parity so the client doesn't
  // have to special-case which response shape it parses. setupConfirmedAt
  // drives <SetupGuard>'s signature-mismatch detection — null means the
  // wizard has never been confirmed and the guard should fire.
  needsSetup: false;
  setupConfirmedAt: string | null;
  // Phase 1 Tradovate — non-secret fields round-trip; password and
  // apiSecret are write-only, exposed as boolean presence flags only.
  tradovate: TradovateBundle;
  topstepCredsValidated: boolean;
  topstepCredsValidatedAt: string | null;
  tradovateCredsValidated: boolean;
  tradovateCredsValidatedAt: string | null;
  // Market-data provider selection — the two slots, what every registered
  // provider can do, and Databento's optional-credential state.
  marketData: MarketDataSettingsBundle;
}

// Discord webhook URLs are quietly sensitive — anyone with the URL can
// post to the channel. Return only a truncated preview to the browser
// (last 4 chars of the token), same write-only treatment as the API key.
function previewWebhookUrl(url: string | null): string | null {
  if (!url) return null;
  const tail = url.length <= 4 ? url : url.slice(-4);
  return `••••${tail}`;
}

/**
 * Build the per-broker fields map the BrokerPlugin contract expects from
 * the parsed PUT body. Wire-level masked-form tri-state collapses here:
 *  - absent key in the input → omitted (plugin leaves the field alone)
 *  - explicit `null` → kept as `null` (plugin clears the field)
 *  - empty string → omitted (masked-form "untouched" — leave alone)
 *  - non-empty string → kept (plugin overwrites)
 */
function buildPluginFields(
  source: Record<string, string | null | undefined>,
  schemaKeys: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of schemaKeys) {
    if (!(key in source)) continue;
    const v = source[key];
    if (v === null) out[key] = null;
    else if (typeof v === "string" && v.length > 0) out[key] = v;
    // Empty string → leave alone (skip).
  }
  return out;
}

/** Tradovate's per-broker keys live under `body.tradovate.*`; flatten
 *  to the schema's `tradovate*` camelCase before handing to
 *  buildPluginFields. */
function flattenTradovateBundle(tv: TradovatePutBundle): Record<string, string | null | undefined> {
  return {
    tradovateUsername: tv.username,
    tradovatePassword: tv.password,
    tradovateApiCid: tv.apiCid,
    tradovateApiSecret: tv.apiSecret,
    tradovateAppId: tv.appId,
    tradovateAppVersion: tv.appVersion,
    tradovateDeviceId: tv.deviceId,
  };
}

/**
 * Pre-transaction Test-Connection gate. Returns an error message string
 * to surface as 400, or null when the input is acceptable.
 *
 * Topstep: if the post-write Topstep tuple is non-null AND any cred field
 * is in the input, the persisted validation signature must match the
 * post-write tuple. Stale signature on edit means re-test required.
 *
 * Tradovate: same shape over the seven cred fields. If the post-write
 * tuple is fully populated, signature must match. If any required field
 * would be cleared (post-write tuple incomplete), no signature check —
 * we're un-saving the broker.
 *
 * AUTO empty defense: if the operator submits an explicit empty string
 * for an AUTO field (appId/appVersion/deviceId), reject with the Reset
 * hint. The wizard's Reset button reverts AUTO fields to defaults; an
 * inline-blanked AUTO field reaches here as "" (not null) and is the
 * only signal the operator misused the field rather than clearing the
 * whole section.
 */
function checkCredSignatureGate(input: PutBody): string | null {
  // Topstep gate.
  const topstepHasCredEdit =
    input.topstepUsername !== undefined ||
    (input.topstepApiKey !== undefined && input.topstepApiKey !== "");
  if (topstepHasCredEdit) {
    const prevUsername = getTopstepUsername();
    const prevApiKey = getTopstepApiKey();
    const nextUsername =
      input.topstepUsername === undefined ? prevUsername : input.topstepUsername;
    const nextApiKey =
      input.topstepApiKey === undefined || input.topstepApiKey === ""
        ? prevApiKey
        : input.topstepApiKey;
    if (nextUsername !== null && nextApiKey !== null) {
      const plugin = brokerRegistry.getPlugin("topstep");
      if (!plugin) return "Topstep broker plugin not registered.";
      const expected = plugin.computeCredsSignature({
        topstepUsername: nextUsername,
        topstepApiKey: nextApiKey,
      });
      if (getTopstepCredsValidatedSignature() !== expected) {
        return "Topstep credentials were not validated. Click Test Connection first.";
      }
    }
  }

  // Tradovate gate.
  if (input.tradovate) {
    const tv = input.tradovate;
    // AUTO empty defense.
    if (tv.appId === "")
      return "App ID cannot be empty. Click the Reset button to revert to the auto-populated default.";
    if (tv.appVersion === "")
      return "App Version cannot be empty. Click the Reset button to revert to the auto-populated default.";
    if (tv.deviceId === "")
      return "Device ID cannot be empty. Click the Reset button to revert to the auto-populated default.";

    const tradovateHasEdit =
      tv.username !== undefined ||
      tv.apiCid !== undefined ||
      tv.appId !== undefined ||
      tv.appVersion !== undefined ||
      tv.deviceId !== undefined ||
      (tv.password !== undefined && tv.password !== "") ||
      (tv.apiSecret !== undefined && tv.apiSecret !== "");
    if (tradovateHasEdit) {
      const prevUsername = getTradovateUsername();
      const prevPassword = getTradovatePassword();
      const prevApiCid = getTradovateApiCid();
      const prevApiSecret = getTradovateApiSecret();
      const prevAppId = getTradovateAppId();
      const prevAppVersion = getTradovateAppVersion();
      const prevDeviceId = getTradovateDeviceId();
      const nextUsername =
        tv.username === undefined ? prevUsername : tv.username;
      const nextApiCid = tv.apiCid === undefined ? prevApiCid : tv.apiCid;
      const nextAppId = tv.appId === undefined ? prevAppId : tv.appId;
      const nextAppVersion =
        tv.appVersion === undefined ? prevAppVersion : tv.appVersion;
      const nextDeviceId =
        tv.deviceId === undefined ? prevDeviceId : tv.deviceId;
      const nextPassword =
        tv.password === undefined || tv.password === ""
          ? prevPassword
          : tv.password;
      const nextApiSecret =
        tv.apiSecret === undefined || tv.apiSecret === ""
          ? prevApiSecret
          : tv.apiSecret;
      // Only enforce when the post-write tuple is complete. Partial =
      // we're either un-saving Tradovate or progressively filling in
      // the form; require the operator to test only when the full tuple
      // would be persisted.
      if (
        nextUsername !== null &&
        nextPassword !== null &&
        nextApiCid !== null &&
        nextApiSecret !== null &&
        nextAppId !== null &&
        nextAppVersion !== null &&
        nextDeviceId !== null
      ) {
        const plugin = brokerRegistry.getPlugin("tradovate");
        if (!plugin) return "Tradovate broker plugin not registered.";
        const expected = plugin.computeCredsSignature({
          tradovateUsername: nextUsername,
          tradovatePassword: nextPassword,
          tradovateApiCid: nextApiCid,
          tradovateApiSecret: nextApiSecret,
          tradovateAppId: nextAppId,
          tradovateAppVersion: nextAppVersion,
          tradovateDeviceId: nextDeviceId,
        });
        if (getTradovateCredsValidatedSignature() !== expected) {
          return "Tradovate credentials were not validated. Click Test Connection first.";
        }
      }
    }
  }

  // Databento gate. Same shape, one difference: the key is optional, so
  // the gate only fires when a key is actually being written. Clearing it
  // (`null`) and leaving it alone (`""` or absent) both skip the check —
  // there is nothing to prove about a credential that will not exist.
  if (input.databentoApiKey !== undefined && input.databentoApiKey !== "") {
    const nextApiKey = input.databentoApiKey;
    if (nextApiKey !== null) {
      const expected = computeDatabentoCredsSignature({ apiKey: nextApiKey });
      if (getDatabentoCredsValidatedSignature() !== expected) {
        return "Databento API key was not validated. Click Test Connection first.";
      }
    }
  }
  return null;
}

/**
 * Databento's key is optional, so "validated" answers a narrower question
 * than it does for a broker: it is true only when a key is actually stored
 * *and* its signature matches. No key at all is a complete configuration
 * that reports `hasApiKey: false, credsValidated: false` — the UI must not
 * render that as a fault.
 */
function readDatabentoBundle(): DatabentoSettingsBundle {
  const source = databentoApiKeySource();
  const dbKey = getDatabentoApiKey();
  let credsValidated = false;
  if (dbKey) {
    credsValidated =
      getDatabentoCredsValidatedSignature() === computeDatabentoCredsSignature({ apiKey: dbKey });
  }
  return {
    hasApiKey: source !== "unset",
    apiKeySource: source,
    credsValidated,
    credsValidatedAt: getDatabentoCredsValidatedAt(),
    coverage: getDatabentoProbeRange(),
  };
}

function readMarketDataBundle(): MarketDataSettingsBundle {
  return {
    historicalProviderId: marketDataRegistry.slotProviderId("historical") ?? "",
    realtimeProviderId: marketDataRegistry.slotProviderId("realtime") ?? "",
    providers: marketDataRegistry.allProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      isConfigured: p.isConfigured(),
      capabilities: {
        historicalBars: p.capabilities.historicalBars,
        liveBars: p.capabilities.liveBars,
        liveQuotes: p.capabilities.liveQuotes,
      },
      fields: p.credentialSchema().map((f) => ({
        key: f.key,
        label: f.label,
        secret: f.secret,
        required: f.required,
        envFallback: f.envFallback ?? null,
      })),
    })),
    databento: readDatabentoBundle(),
  };
}

function readBundle(): SettingsBundle {
  const usernameSource = topstepUsernameSource();
  const apiKeySource = topstepApiKeySource();
  const webhookSource = topstepWebhookUrlSource();
  const dbUsername = getTopstepUsername();
  const dbWebhook = getTopstepWebhookUrl();
  const rawWebhook =
    webhookSource === "db"
      ? dbWebhook
      : webhookSource === "env"
        ? (process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? null)
        : null;
  const tUsername = getTradovateUsername();
  const tApiCid = getTradovateApiCid();
  // Resolve app-identity defaults. deviceId persist-on-generate happens
  // here on the first GET after a fresh DB; subsequent GETs short-circuit
  // (DB has the value) and don't write.
  const identity = resolveTradovateAppIdentity();
  const tHasPassword = getTradovatePassword() !== null;
  const tHasApiSecret = getTradovateApiSecret() !== null;
  // Cred-validation status. "validated" = a signature is on disk AND it
  // matches what we'd compute from the current persisted cred values.
  // The mismatch case fires when an operator edits creds via PUT (which
  // intentionally does NOT roll the validation signature) — the next GET
  // sees stale signature and tells the UI to re-test.
  const topstepDbUsername = getTopstepUsername();
  const topstepDbApiKey = getTopstepApiKey();
  let topstepCredsValidated = false;
  if (topstepDbUsername && topstepDbApiKey) {
    const plugin = brokerRegistry.getPlugin("topstep");
    if (plugin) {
      const expected = plugin.computeCredsSignature({
        topstepUsername: topstepDbUsername,
        topstepApiKey: topstepDbApiKey,
      });
      topstepCredsValidated =
        getTopstepCredsValidatedSignature() === expected;
    }
  }
  const tradovateCreds = readTradovateCredentialsFromDb();
  let tradovateCredsValidated = false;
  if (tradovateCreds) {
    const plugin = brokerRegistry.getPlugin("tradovate");
    if (plugin) {
      const expected = plugin.computeCredsSignature({
        tradovateUsername: tradovateCreds.username,
        tradovatePassword: tradovateCreds.password,
        tradovateApiCid: tradovateCreds.apiCid,
        tradovateApiSecret: tradovateCreds.apiSecret,
        tradovateAppId: tradovateCreds.appId,
        tradovateAppVersion: tradovateCreds.appVersion,
        tradovateDeviceId: tradovateCreds.deviceId,
      });
      tradovateCredsValidated =
        getTradovateCredsValidatedSignature() === expected;
    }
  }
  return {
    topstepUsername:
      usernameSource === "db"
        ? dbUsername
        : usernameSource === "env"
          ? (process.env.TOPSTEP_USERNAME ?? null)
          : null,
    topstepUsernameSource: usernameSource,
    // hasApiKey is true if EITHER DB or env has a value — operator should
    // see "loaded" state regardless of source. The actual key value is
    // never returned over the wire.
    hasApiKey: apiKeySource !== "unset",
    apiKeySource,
    hasWebhookUrl: webhookSource !== "unset",
    topstepWebhookUrlPreview: previewWebhookUrl(rawWebhook),
    webhookUrlSource: webhookSource,
    notificationsEnabled: getNotificationsEnabled(),
    needsSetup: false,
    setupConfirmedAt: getSetupConfirmedAt(),
    tradovate: {
      username: tUsername,
      apiCid: tApiCid,
      appId: identity.appId,
      appVersion: identity.appVersion,
      deviceId: identity.deviceId,
      hasPassword: tHasPassword,
      hasApiSecret: tHasApiSecret,
      // identity.* is always non-null (defaults fill in), so isComplete
      // collapses to the four account-specific fields + the two secrets.
      isComplete:
        tUsername !== null &&
        tApiCid !== null &&
        tHasPassword &&
        tHasApiSecret,
      appIdAuto: identity.appIdAuto,
      appVersionAuto: identity.appVersionAuto,
      deviceIdAuto: identity.deviceIdAuto,
    },
    topstepCredsValidated,
    topstepCredsValidatedAt: getTopstepCredsValidatedAt(),
    tradovateCredsValidated,
    tradovateCredsValidatedAt: getTradovateCredsValidatedAt(),
    marketData: readMarketDataBundle(),
  };
}

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  try {
    return NextResponse.json(readBundle());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read settings" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parsePutBody(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const input = parsed;

  // Test-Connection gate-save. Compute what the Topstep + Tradovate cred
  // tuples would look like AFTER applying the input, then require that
  // the persisted validation signature matches that post-write tuple.
  // The Test Connection endpoint is the only path that writes a signature,
  // so signature-match proves the operator clicked Test against these
  // exact values. Computed before any writes so we reject before mutating.
  const credValidation = checkCredSignatureGate(input);
  if (credValidation !== null) {
    return NextResponse.json({ error: credValidation }, { status: 400 });
  }

  // Market-data slot selection, applied before any credential write so a
  // refusal leaves the whole PUT untouched. Both slots are validated
  // before either is written: `setSlot` is atomic per slot but not across
  // a pair, so committing `historical` and then refusing `realtime` would
  // half-apply the submission. `assertSlot` is the only path that
  // enforces "the realtime slot needs liveBars", and it throws with the
  // vendor-specific reason the UI shows.
  if (input.marketData) {
    const pendingSlots: [MarketDataSlot, string][] = [];
    if (input.marketData.historicalProviderId !== undefined) {
      pendingSlots.push(["historical", input.marketData.historicalProviderId]);
    }
    if (input.marketData.realtimeProviderId !== undefined) {
      pendingSlots.push(["realtime", input.marketData.realtimeProviderId]);
    }
    try {
      for (const [slot, providerId] of pendingSlots) {
        marketDataRegistry.assertSlot(slot, providerId);
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to select market-data provider" },
        { status: 400 },
      );
    }
    for (const [slot, providerId] of pendingSlots) {
      marketDataRegistry.setSlot(slot, providerId);
    }
  }

  // Databento's key is route-owned: `MarketDataProvider` has no
  // `applyCredentials`, and one optional key does not justify porting the
  // whole plugin credential surface onto the provider interface.
  // Clearing the key drops the probe range with it — coverage is a
  // property of the key's entitlement, and showing it for a key that is
  // gone is a lie.
  if (input.databentoApiKey !== undefined && input.databentoApiKey !== "") {
    setDatabentoApiKey(input.databentoApiKey);
    invalidateSettingsCache("databento_api_key");
    if (input.databentoApiKey === null) setDatabentoProbeRange(null);
  }

  // Capture pre-write state for change detection AFTER plugin writes.
  // The route still owns:
  //   - webhook URL + notifications (not plugin credentials)
  //   - setup-confirmation signature recompute (engine-activation gate)
  //   - tradovate_device_id_user_set flag (UI AUTO badge state — depends
  //     on whether the submitted device_id diverged from the prefilled value)
  //   - engine hot-reload (async, can't run inside the plugin)
  const prevTopstepUsername = getTopstepUsername();
  const prevTopstepApiKey = getTopstepApiKey();
  const prevTopstepWebhook = getTopstepWebhookUrl();
  const prevTradovateUsername = getTradovateUsername();
  const prevTradovateApiCid = getTradovateApiCid();
  const prevTradovatePassword = getTradovatePassword();
  const prevTradovateApiSecret = getTradovateApiSecret();
  const prevTradovateDeviceId = getTradovateDeviceId();
  const brokerWasConfigured = brokerRegistry.allPlugins().some((p) => p.isConfigured());

  // Phase 8 step 2 trade-off: per-plugin cred writes happen OUTSIDE the
  // SQL txn that previously wrapped the whole PUT body. The Tier 1.1
  // audit's atomicity guarantee for two concurrent Save clicks is weakened
  // for the cred path — plugin.applyCredentials is async and better-sqlite3
  // transactions are sync-only, so we can't both delegate the write and
  // keep the txn. Single-operator scale makes the residual race acceptable;
  // each plugin's internal compare-then-write per field is still correct
  // in isolation. The webhook + notifications + setup-signature recompute
  // stays inside a small txn below for the route-owned writes.
  try {
    for (const plugin of brokerRegistry.allPlugins()) {
      const schemaKeys = plugin.credentialSchema().map((f) => f.key);
      let pluginInput: Record<string, string | null | undefined>;
      if (plugin.id === "tradovate") {
        if (!input.tradovate) continue;
        pluginInput = flattenTradovateBundle(input.tradovate);
      } else {
        // Topstep + any future top-level broker: keys live at body top-level.
        pluginInput = input as unknown as Record<string, string | null | undefined>;
      }
      const fields = buildPluginFields(pluginInput, schemaKeys);
      if (Object.keys(fields).length === 0) continue;
      await plugin.applyCredentials(fields);
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write credentials" },
      { status: 500 },
    );
  }

  // Tradovate device-id-user-set flag. The plugin writes device_id but
  // doesn't track WHY (operator override vs auto-generation). The AUTO
  // badge in the UI flips off when the operator submits a value that
  // differs from the prefilled UUID; clearing the field reverts the
  // badge by wiping both value + flag.
  if (input.tradovate?.deviceId !== undefined) {
    const submitted = input.tradovate.deviceId;
    if (submitted === null || (typeof submitted === "string" && submitted.length === 0)) {
      clearTradovateDeviceIdUserSet();
    } else if (submitted !== prevTradovateDeviceId) {
      setTradovateDeviceIdUserSet(true);
    }
  }

  // Route-owned writes wrapped in a small txn for atomicity between the
  // webhook write and the setup-signature recompute (those two together
  // are the engine-activation gate and need to commit as a unit).
  let webhookChanged = false;
  const usernameChanged = getTopstepUsername() !== prevTopstepUsername;
  const apiKeyChanged = getTopstepApiKey() !== prevTopstepApiKey;
  try {
    getDb().transaction(() => {
      if (input.topstepWebhookUrl !== undefined) {
        const next = input.topstepWebhookUrl === null
          ? null
          : input.topstepWebhookUrl.length === 0
            ? null
            : input.topstepWebhookUrl;
        if (next !== prevTopstepWebhook) {
          setTopstepWebhookUrl(next);
          webhookChanged = true;
        }
      }
      if (input.notificationsEnabled !== undefined) {
        setNotificationsEnabled(input.notificationsEnabled);
      }
      // `confirmSetup` is the first run's terminal action; the credential
      // arm is the side effect that already existed. Both write the same
      // pair, because a confirm with a stale signature is a confirm the
      // guard will reopen on the next signature check.
      if (input.confirmSetup === true || usernameChanged || apiKeyChanged || webhookChanged) {
        const sig = computeConfigSignature({
          username:
            getTopstepUsername() ?? (process.env.TOPSTEP_USERNAME ?? null),
          hasDbKey: getTopstepApiKey() !== null,
          hasEnvKey: (process.env.TOPSTEP_API_KEY ?? "").length > 0,
          webhookUrl:
            getTopstepWebhookUrl() ?? (process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? null),
        });
        setSetupSignature(sig);
        setSetupConfirmedAt(new Date().toISOString());
      }
    })();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write settings" },
      { status: 500 },
    );
  }

  if (webhookChanged) invalidateSettingsCache("topstep_webhook_url");

  // Plugin.applyCredentials already invalidated the per-broker settings
  // cache + cleared the per-broker cached client. Engine-side bookkeeping
  // (account-name cache + Tradovate broker reload) is route-owned because
  // it touches the trading engine singleton.
  if (usernameChanged || apiKeyChanged) {
    await handle.invalidateAccountNames();
  }
  const tradovateCredsChanged =
    getTradovateUsername() !== prevTradovateUsername ||
    getTradovateApiCid() !== prevTradovateApiCid ||
    getTradovatePassword() !== prevTradovatePassword ||
    getTradovateApiSecret() !== prevTradovateApiSecret;
  if (tradovateCredsChanged) {
    // Hot-reload the engine's Tradovate broker so the new credentials
    // take effect without a container restart. Fire-and-forget — the
    // response shouldn't block on broker searchAccounts fan-out.
    handle.reloadTradovateClients().catch((err) => {
      log.event(
        "broker_auth_failed",
        "settings.route",
        `Tradovate hot-reload after settings save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // An install set up with the sign-in alone booted with no broker, in
  // passive-no-creds mode; the first broker saved here is what wakes it, as
  // first run's confirm used to. Fire-and-forget, logged by the boot itself.
  if (!brokerWasConfigured && brokerRegistry.allPlugins().some((p) => p.isConfigured())) {
    void handle.activateFromSettings().catch(() => {});
  }

  try {
    return NextResponse.json(readBundle());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read settings" },
      { status: 500 },
    );
  }
}
