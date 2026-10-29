/**
 * The two credential-gap faults the operator hit on staging, pinned at the
 * pure layer the block renders from.
 *
 * 1. The Tradovate API Client ID is no longer a secret, so it prefills from
 *    the stored value. An untouched Save must then send nothing — the
 *    data-loss path (a blank seed over a stored cid saved `apiCid: null`) is
 *    closed by `next === prev`.
 * 2. The ✓ Verified badge reflects *stored* validated creds, never a prior
 *    form test: a dirty form clears it.
 */
import { describe, it, expect } from "vitest";
import {
  buildSaveBody,
  visibleTestState,
  type BrokerSchema,
} from "@/components/settings/settings-credential-fields";
import type { SettingsBundle } from "@/lib/settings/parse-bundle";
import type { SettingsTestState } from "@/components/settings/settings-connection-controls";

const TRADOVATE_SCHEMA: BrokerSchema = {
  id: "tradovate",
  displayName: "Tradovate",
  isConfigured: true,
  fields: [
    { key: "tradovateUsername", label: "Username", secret: false, required: true },
    { key: "tradovatePassword", label: "Password", secret: true, required: true },
    { key: "tradovateAppId", label: "App ID", secret: false, required: true },
    { key: "tradovateAppVersion", label: "App Version", secret: false, required: true },
    { key: "tradovateDeviceId", label: "Device ID", secret: false, required: false },
    { key: "tradovateApiCid", label: "API Client ID", secret: false, required: true },
    { key: "tradovateApiSecret", label: "API Secret", secret: true, required: true },
  ],
};

function bundle(): SettingsBundle {
  return {
    topstepUsername: null,
    topstepUsernameSource: "unset",
    hasApiKey: false,
    apiKeySource: "unset",
    hasWebhookUrl: false,
    topstepWebhookUrlPreview: null,
    webhookUrlSource: "unset",
    notificationsEnabled: false,
    needsSetup: false,
    setupConfirmedAt: null,
    tradovate: {
      username: "trader",
      apiCid: "12345",
      appId: "app",
      appVersion: "1.0",
      deviceId: "device",
      hasPassword: true,
      hasApiSecret: true,
      isComplete: true,
      appIdAuto: true,
      appVersionAuto: true,
      deviceIdAuto: true,
    },
    topstepCredsValidated: false,
    topstepCredsValidatedAt: null,
    tradovateCredsValidated: true,
    tradovateCredsValidatedAt: "2026-10-24T00:00:00.000Z",
    marketData: {
      historicalProviderId: "",
      realtimeProviderId: "",
      providers: [],
      databento: {
        hasApiKey: false,
        apiKeySource: "unset",
        credsValidated: false,
        credsValidatedAt: null,
        coverage: null,
      },
    },
  };
}

/** The form as `seedForms` leaves it with the cid non-secret: every non-secret
 *  field prefilled from the stored value, both secrets blank. */
function untouchedValues(b: SettingsBundle): Record<string, string> {
  const tv = b.tradovate;
  return {
    tradovateUsername: tv.username ?? "",
    tradovatePassword: "",
    tradovateAppId: tv.appId ?? "",
    tradovateAppVersion: tv.appVersion ?? "",
    tradovateDeviceId: tv.deviceId ?? "",
    tradovateApiCid: tv.apiCid ?? "",
    tradovateApiSecret: "",
  };
}

describe("buildSaveBody — Tradovate untouched save", () => {
  it("sends no change at all, so the prefilled cid is never nulled", () => {
    const b = bundle();
    const body = buildSaveBody(TRADOVATE_SCHEMA, untouchedValues(b), b);
    expect(body).toEqual({});
  });

  it("does not send apiCid as a change when it equals the stored value", () => {
    const b = bundle();
    // Only the password is being set; the prefilled non-secret fields stay put.
    const values = { ...untouchedValues(b), tradovatePassword: "new-pass" };
    const body = buildSaveBody(TRADOVATE_SCHEMA, values, b) as {
      tradovate?: Record<string, unknown>;
    };
    expect(body.tradovate).toBeDefined();
    expect(body.tradovate).not.toHaveProperty("apiCid");
    expect(body.tradovate?.password).toBe("new-pass");
  });

  it("sends apiCid only when the operator actually changed it", () => {
    const b = bundle();
    const values = { ...untouchedValues(b), tradovateApiCid: "67890" };
    const body = buildSaveBody(TRADOVATE_SCHEMA, values, b) as {
      tradovate?: Record<string, unknown>;
    };
    expect(body.tradovate?.apiCid).toBe("67890");
  });
});

describe("visibleTestState — Verified reflects stored, not a form test", () => {
  const passed: SettingsTestState = { kind: "passed", at: 1000 };

  it("clears a passed badge while the form has unsaved edits", () => {
    expect(visibleTestState(passed, true)).toEqual({ kind: "idle" });
  });

  it("keeps a passed badge once the form matches what is stored", () => {
    expect(visibleTestState(passed, false)).toEqual(passed);
  });

  it("leaves non-passed states alone regardless of dirty", () => {
    const testing: SettingsTestState = { kind: "testing" };
    const failed: SettingsTestState = { kind: "failed", error: "auth", message: "bad" };
    expect(visibleTestState(testing, true)).toEqual(testing);
    expect(visibleTestState(failed, true)).toEqual(failed);
  });
});
