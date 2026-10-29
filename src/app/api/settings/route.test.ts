import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => ({
    transaction: vi.fn((fn: () => void) => fn),
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
  })),
  registerMigration: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const mockGetTopstepUsername = vi.fn().mockReturnValue(null);
const mockGetTopstepApiKey = vi.fn().mockReturnValue(null);
const mockGetTopstepWebhookUrl = vi.fn().mockReturnValue(null);
const mockGetTradovateUsername = vi.fn().mockReturnValue(null);
const mockGetTradovateApiCid = vi.fn().mockReturnValue(null);
const mockGetTradovateApiSecret = vi.fn().mockReturnValue(null);
const mockGetTradovatePassword = vi.fn().mockReturnValue(null);
const mockGetTradovateDeviceId = vi.fn().mockReturnValue(null);
const mockGetTradovateAppId = vi.fn().mockReturnValue(null);
const mockGetTradovateAppVersion = vi.fn().mockReturnValue(null);
const mockGetNotificationsEnabled = vi.fn().mockReturnValue(false);
const mockGetSetupConfirmedAt = vi.fn().mockReturnValue(null);
const mockGetDatabentoApiKey = vi.fn().mockReturnValue(null);
const mockSetDatabentoApiKey = vi.fn();
const mockSetDatabentoProbeRange = vi.fn();

vi.mock("@/lib/db/settings", () => ({
  getTopstepUsername: (...a: unknown[]) => mockGetTopstepUsername(...a),
  getTopstepApiKey: (...a: unknown[]) => mockGetTopstepApiKey(...a),
  getTopstepWebhookUrl: (...a: unknown[]) => mockGetTopstepWebhookUrl(...a),
  getTradovateUsername: (...a: unknown[]) => mockGetTradovateUsername(...a),
  getTradovateApiCid: (...a: unknown[]) => mockGetTradovateApiCid(...a),
  getTradovateApiSecret: (...a: unknown[]) => mockGetTradovateApiSecret(...a),
  getTradovatePassword: (...a: unknown[]) => mockGetTradovatePassword(...a),
  getTradovateDeviceId: (...a: unknown[]) => mockGetTradovateDeviceId(...a),
  getTradovateAppId: (...a: unknown[]) => mockGetTradovateAppId(...a),
  getTradovateAppVersion: (...a: unknown[]) => mockGetTradovateAppVersion(...a),
  getNotificationsEnabled: (...a: unknown[]) => mockGetNotificationsEnabled(...a),
  getSetupConfirmedAt: (...a: unknown[]) => mockGetSetupConfirmedAt(...a),
  getDatabentoApiKey: (...a: unknown[]) => mockGetDatabentoApiKey(...a),
  getDatabentoProbeRange: vi.fn().mockReturnValue(null),
  setDatabentoApiKey: (...a: unknown[]) => mockSetDatabentoApiKey(...a),
  setDatabentoProbeRange: (...a: unknown[]) => mockSetDatabentoProbeRange(...a),
  setTopstepWebhookUrl: vi.fn(),
  setNotificationsEnabled: vi.fn(),
  setSetupConfirmedAt: vi.fn(),
  setSetupSignature: vi.fn(),
  setTradovateDeviceIdUserSet: vi.fn(),
  clearTradovateDeviceIdUserSet: vi.fn(),
}));

const mockResolveTradovateAppIdentity = vi.fn().mockReturnValue({
  appId: "CrossfireTrader",
  appVersion: "1.0",
  deviceId: "auto-uuid",
  appIdAuto: true,
  appVersionAuto: true,
  deviceIdAuto: true,
});

vi.mock("@/lib/settings/tradovate-defaults", () => ({
  resolveTradovateAppIdentity: (...a: unknown[]) => mockResolveTradovateAppIdentity(...a),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  invalidateSettingsCache: vi.fn(),
  topstepApiKeySource: vi.fn().mockReturnValue("unset"),
  topstepUsernameSource: vi.fn().mockReturnValue("unset"),
  topstepWebhookUrlSource: vi.fn().mockReturnValue("unset"),
  databentoApiKeySource: vi.fn().mockReturnValue("unset"),
}));

const mockSetSlot = vi.fn();
const mockAssertSlot = vi.fn();
const mockDatabentoProvider = {
  id: "databento",
  displayName: "Databento",
  isConfigured: vi.fn().mockReturnValue(true),
  capabilities: { historicalBars: true, liveBars: false, liveQuotes: false },
  credentialSchema: vi.fn().mockReturnValue([
    {
      key: "databentoApiKey",
      label: "Databento API Key",
      secret: true,
      required: false,
      envFallback: "DATABENTO_API_KEY",
    },
  ]),
};

vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: {
    slotProviderId: vi.fn(() => "topstep"),
    allProviders: vi.fn(() => [
      {
        id: "topstep",
        displayName: "Topstep",
        isConfigured: () => true,
        capabilities: { historicalBars: true, liveBars: true, liveQuotes: true },
        credentialSchema: () => [],
      },
      mockDatabentoProvider,
    ]),
    setSlot: (...a: unknown[]) => mockSetSlot(...a),
    assertSlot: (...a: unknown[]) => mockAssertSlot(...a),
  },
}));

vi.mock("@/lib/db/setup-signature", () => ({
  computeConfigSignature: vi.fn().mockReturnValue("sig"),
}));

const mockGetTopstepCredsValidatedSignature = vi.fn().mockReturnValue(null);
const mockGetTradovateCredsValidatedSignature = vi.fn().mockReturnValue(null);

const mockGetDatabentoCredsValidatedSignature = vi.fn().mockReturnValue(null);

vi.mock("@/lib/db/cred-validation", () => ({
  getTopstepCredsValidatedAt: vi.fn().mockReturnValue(null),
  getTopstepCredsValidatedSignature: (...a: unknown[]) => mockGetTopstepCredsValidatedSignature(...a),
  getTradovateCredsValidatedAt: vi.fn().mockReturnValue(null),
  getTradovateCredsValidatedSignature: (...a: unknown[]) => mockGetTradovateCredsValidatedSignature(...a),
  getDatabentoCredsValidatedAt: vi.fn().mockReturnValue(null),
  getDatabentoCredsValidatedSignature: (...a: unknown[]) =>
    mockGetDatabentoCredsValidatedSignature(...a),
  computeDatabentoCredsSignature: vi.fn(() => "databento-sig"),
}));

vi.mock("@/lib/brokers/tradovate/client", () => ({
  readTradovateCredentialsFromDb: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn().mockReturnValue(null),
}));

const mockTopstepPlugin = {
  id: "topstep",
  credentialSchema: vi.fn().mockReturnValue([
    { key: "topstepUsername" },
    { key: "topstepApiKey" },
  ]),
  applyCredentials: vi.fn().mockResolvedValue(undefined),
  computeCredsSignature: vi.fn().mockReturnValue("topstep-sig"),
};

const mockTradovatePlugin = {
  id: "tradovate",
  credentialSchema: vi.fn().mockReturnValue([
    { key: "tradovateUsername" },
    { key: "tradovatePassword" },
    { key: "tradovateApiCid" },
    { key: "tradovateApiSecret" },
    { key: "tradovateAppId" },
    { key: "tradovateAppVersion" },
    { key: "tradovateDeviceId" },
  ]),
  applyCredentials: vi.fn().mockResolvedValue(undefined),
  computeCredsSignature: vi.fn().mockReturnValue("tradovate-sig"),
};

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    allPlugins: vi.fn(() => [mockTopstepPlugin, mockTradovatePlugin]),
    getPlugin: vi.fn((id: string) => {
      if (id === "topstep") return mockTopstepPlugin;
      if (id === "tradovate") return mockTradovatePlugin;
      return null;
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PUT } from "./route";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/connection";

// ── Helpers ───────────────────────────────────────────────────────────────────

function putRequest(body: unknown, token = "valid-token"): NextRequest {
  return new NextRequest("http://localhost/api/settings", {
    method: "PUT",
    headers: {
      "x-session-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetTopstepUsername.mockReturnValue(null);
  mockGetTopstepApiKey.mockReturnValue(null);
  mockGetTopstepWebhookUrl.mockReturnValue(null);
  mockGetTradovateUsername.mockReturnValue(null);
  mockGetTradovateApiCid.mockReturnValue(null);
  mockGetTradovateApiSecret.mockReturnValue(null);
  mockGetTradovatePassword.mockReturnValue(null);
  mockGetTradovateDeviceId.mockReturnValue(null);
  mockGetTradovateAppId.mockReturnValue(null);
  mockGetTradovateAppVersion.mockReturnValue(null);
  mockGetTopstepCredsValidatedSignature.mockReturnValue(null);
  mockGetTradovateCredsValidatedSignature.mockReturnValue(null);
  mockGetDatabentoCredsValidatedSignature.mockReturnValue(null);
  mockGetDatabentoApiKey.mockReturnValue(null);
  mockSetDatabentoApiKey.mockReset();
  mockSetDatabentoProbeRange.mockReset();
  mockSetSlot.mockReset();
  mockAssertSlot.mockReset();
  mockTopstepPlugin.applyCredentials.mockReset();
  mockTopstepPlugin.applyCredentials.mockResolvedValue(undefined);
  mockTopstepPlugin.computeCredsSignature.mockReturnValue("topstep-sig");
  mockTradovatePlugin.applyCredentials.mockReset();
  mockTradovatePlugin.applyCredentials.mockResolvedValue(undefined);
  mockTradovatePlugin.computeCredsSignature.mockReturnValue("tradovate-sig");
  vi.mocked(getDb).mockReturnValue({
    transaction: vi.fn((fn: () => void) => fn),
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
  } as never);
});

// ── PUT 401 ───────────────────────────────────────────────────────────────────

describe("PUT /api/settings — auth", () => {
  it("returns 401 when token header is missing", async () => {
    const req = new NextRequest("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });
});

// ── PUT cred-signature gate ───────────────────────────────────────────────────

describe("PUT /api/settings — credential signature gate", () => {
  it("rejects with 400 when topstep username is edited but signature does not match", async () => {
    // DB has existing creds so the post-write tuple is non-null
    mockGetTopstepUsername.mockReturnValue("existing-user");
    mockGetTopstepApiKey.mockReturnValue("existing-key");
    // Persisted signature doesn't match what computeCredsSignature would return
    mockGetTopstepCredsValidatedSignature.mockReturnValue("stale-sig");
    mockTopstepPlugin.computeCredsSignature.mockReturnValue("fresh-sig");

    const res = await PUT(putRequest({ topstepUsername: "new-user" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/test connection/i);
  });
});

// ── PUT Topstep-only fields ───────────────────────────────────────────────────

describe("PUT /api/settings — Topstep-only cred fields", () => {
  it("calls only the Topstep plugin when only Topstep fields are in the body (no tradovate key)", async () => {
    // Signature gate: username absent from DB so post-write tuple won't be fully non-null
    // (username would be non-null after write, but apiKey is null → gate skips check)
    mockGetTopstepUsername.mockReturnValue(null);
    mockGetTopstepApiKey.mockReturnValue(null);

    const res = await PUT(putRequest({ topstepUsername: "new-user" }));
    expect(res.status).toBe(200);

    expect(mockTopstepPlugin.applyCredentials).toHaveBeenCalledTimes(1);
    // Tradovate plugin must NOT be called — no 'tradovate' key in body
    expect(mockTradovatePlugin.applyCredentials).not.toHaveBeenCalled();
  });

  it("passes only the fields present in the body to the Topstep plugin", async () => {
    mockGetTopstepUsername.mockReturnValue(null);
    mockGetTopstepApiKey.mockReturnValue(null);

    await PUT(putRequest({ topstepUsername: "user-x" }));

    const callArgs = mockTopstepPlugin.applyCredentials.mock.calls[0][0] as Record<string, string | null>;
    expect(callArgs).toHaveProperty("topstepUsername", "user-x");
    // topstepApiKey was absent in the request body
    expect(callArgs).not.toHaveProperty("topstepApiKey");
  });
});

// ── PUT tri-state field normalization ─────────────────────────────────────────

describe("PUT /api/settings — buildPluginFields tri-state normalization", () => {
  it("non-empty string field is passed through to the plugin as-is", async () => {
    mockGetTopstepUsername.mockReturnValue(null);
    mockGetTopstepApiKey.mockReturnValue(null);

    await PUT(putRequest({ topstepUsername: "real-user" }));

    const fields = mockTopstepPlugin.applyCredentials.mock.calls[0][0] as Record<string, string | null>;
    expect(fields.topstepUsername).toBe("real-user");
  });

  it("null field is passed as null to the plugin (explicit clear)", async () => {
    mockGetTopstepUsername.mockReturnValue("current-user");
    mockGetTopstepApiKey.mockReturnValue(null);
    // null value: post-write topstepUsername would be null → gate skips
    mockGetTopstepCredsValidatedSignature.mockReturnValue("some-sig");

    await PUT(putRequest({ topstepUsername: null }));

    const fields = mockTopstepPlugin.applyCredentials.mock.calls[0][0] as Record<string, string | null>;
    expect(fields.topstepUsername).toBeNull();
  });

  it("absent key is omitted from the plugin fields map (leave-alone)", async () => {
    mockGetTopstepUsername.mockReturnValue(null);
    mockGetTopstepApiKey.mockReturnValue(null);

    // Body only has webhook — no topstep cred keys
    await PUT(putRequest({ topstepWebhookUrl: null }));

    // buildPluginFields maps body keys against schema keys.
    // topstepUsername and topstepApiKey are absent from body → omitted
    if (mockTopstepPlugin.applyCredentials.mock.calls.length > 0) {
      const fields = mockTopstepPlugin.applyCredentials.mock.calls[0][0] as Record<string, string | null>;
      expect(Object.keys(fields)).not.toContain("topstepUsername");
      expect(Object.keys(fields)).not.toContain("topstepApiKey");
    }
    // May not be called at all if fields object is empty (Object.keys(fields).length === 0 → continue)
  });
});

// ── PUT no cred changes ───────────────────────────────────────────────────────

describe("PUT /api/settings — no cred changes", () => {
  it("does not call any plugin when body has no cred fields", async () => {
    // Only notificationsEnabled — no Topstep or Tradovate cred fields
    await PUT(putRequest({ notificationsEnabled: true }));

    expect(mockTopstepPlugin.applyCredentials).not.toHaveBeenCalled();
    expect(mockTradovatePlugin.applyCredentials).not.toHaveBeenCalled();
  });

  it("returns 200 when only non-cred fields are updated", async () => {
    const res = await PUT(putRequest({ notificationsEnabled: false }));
    expect(res.status).toBe(200);
  });
});

// ── PUT market-data slot selection ────────────────────────────────────────────

describe("PUT /api/settings — market-data slots", () => {
  it("applies each selected slot through the registry", async () => {
    const res = await PUT(
      putRequest({
        marketData: { historicalProviderId: "databento", realtimeProviderId: "topstep" },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockSetSlot).toHaveBeenCalledWith("historical", "databento");
    expect(mockSetSlot).toHaveBeenCalledWith("realtime", "topstep");
  });

  it("leaves the other slot alone when only one is submitted", async () => {
    await PUT(putRequest({ marketData: { historicalProviderId: "databento" } }));

    expect(mockSetSlot).toHaveBeenCalledTimes(1);
    expect(mockSetSlot).toHaveBeenCalledWith("historical", "databento");
  });

  it("surfaces a registry refusal as 400 with the registry's own reason", async () => {
    mockAssertSlot.mockImplementation(() => {
      throw new Error("Databento cannot serve the realtime slot — it has no live-bar entitlement.");
    });

    const res = await PUT(putRequest({ marketData: { realtimeProviderId: "databento" } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("cannot serve the realtime slot");
  });

  it("writes nothing else when a slot selection is refused", async () => {
    mockAssertSlot.mockImplementation(() => {
      throw new Error("nope");
    });

    await PUT(
      putRequest({
        marketData: { realtimeProviderId: "databento" },
        databentoApiKey: null,
      }),
    );

    expect(mockSetSlot).not.toHaveBeenCalled();
    expect(mockSetDatabentoApiKey).not.toHaveBeenCalled();
    expect(mockTopstepPlugin.applyCredentials).not.toHaveBeenCalled();
  });

  it("leaves the historical slot unwritten when the realtime half of the same PUT is refused", async () => {
    // Both slots submitted, only the realtime one refused. Validating
    // slot-by-slot as it is written would have committed `historical`
    // before the `realtime` refusal fired.
    mockAssertSlot.mockImplementation((slot: unknown) => {
      if (slot === "realtime") {
        throw new Error("Databento cannot serve the realtime slot — it has no live-bar entitlement.");
      }
    });

    const res = await PUT(
      putRequest({
        marketData: { historicalProviderId: "databento", realtimeProviderId: "databento" },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockSetSlot).not.toHaveBeenCalled();
  });

  it("rejects a non-string provider id at the parser", async () => {
    const res = await PUT(putRequest({ marketData: { realtimeProviderId: 3 } }));
    expect(res.status).toBe(400);
    expect(mockSetSlot).not.toHaveBeenCalled();
  });
});

// ── PUT Databento key ─────────────────────────────────────────────────────────

describe("PUT /api/settings — Databento API key", () => {
  it("rejects an unvalidated key with 400 and writes nothing", async () => {
    mockGetDatabentoCredsValidatedSignature.mockReturnValue("some-other-sig");

    const res = await PUT(putRequest({ databentoApiKey: "db-key" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not validated");
    expect(mockSetDatabentoApiKey).not.toHaveBeenCalled();
  });

  it("writes a key whose signature matches the persisted one", async () => {
    mockGetDatabentoCredsValidatedSignature.mockReturnValue("databento-sig");

    const res = await PUT(putRequest({ databentoApiKey: "db-key" }));

    expect(res.status).toBe(200);
    expect(mockSetDatabentoApiKey).toHaveBeenCalledWith("db-key");
  });

  it("clears the key without a gate — un-saving an optional credential needs no proof", async () => {
    mockGetDatabentoCredsValidatedSignature.mockReturnValue(null);

    const res = await PUT(putRequest({ databentoApiKey: null }));

    expect(res.status).toBe(200);
    expect(mockSetDatabentoApiKey).toHaveBeenCalledWith(null);
    expect(mockSetDatabentoProbeRange).toHaveBeenCalledWith(null);
  });

  it("treats an empty string as untouched — masked input, no write, no gate", async () => {
    mockGetDatabentoCredsValidatedSignature.mockReturnValue(null);

    const res = await PUT(putRequest({ databentoApiKey: "" }));

    expect(res.status).toBe(200);
    expect(mockSetDatabentoApiKey).not.toHaveBeenCalled();
    expect(mockSetDatabentoProbeRange).not.toHaveBeenCalled();
  });
});

// ── PUT confirmSetup ──────────────────────────────────────────────────────────

describe("PUT /api/settings — confirmSetup", () => {
  it("refuses `false` rather than letting a payload reopen first run", async () => {
    // The confirm is write-only and one-way. Accepting `false` would let any
    // authenticated body clear `setup_confirmed_at`, which is the single flag
    // `<SetupGuard>` reads — a dashboard that redirects to Settings forever,
    // written by a request that looks like a settings save.
    const res = await PUT(putRequest({ confirmSetup: false }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/confirmSetup may only be true/);
  });
});
