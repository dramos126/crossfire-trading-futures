import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock hoisting: these must appear before the module under test is imported.

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: "1.2.3" })),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
}));

// Mutable in-memory store that backs the settings mock.
const store: Record<string, string | null> = {};

vi.mock("@/lib/db/settings", () => ({
  // Tradovate identity fields — backed by in-memory store for test isolation.
  getTradovateAppId: vi.fn(() => store["appId"] ?? null),
  setTradovateAppId: vi.fn((v: string) => { store["appId"] = v; }),
  getTradovateAppVersion: vi.fn(() => store["appVersion"] ?? null),
  setTradovateAppVersion: vi.fn((v: string) => { store["appVersion"] = v; }),
  getTradovateDeviceId: vi.fn(() => store["deviceId"] ?? null),
  setTradovateDeviceId: vi.fn((v: string) => { store["deviceId"] = v; }),
  getTradovateDeviceIdUserSet: vi.fn(() => store["deviceIdUserSet"] === "true"),
  setTradovateDeviceIdUserSet: vi.fn((v: boolean) => { store["deviceIdUserSet"] = v ? "true" : "false"; }),
  // Tradovate credential fields — needed by readTradovateCredentialsFromDb.
  getTradovateUsername: vi.fn(() => store["username"] ?? null),
  setTradovateUsername: vi.fn((v: string) => { store["username"] = v; }),
  getTradovatePassword: vi.fn(() => store["password"] ?? null),
  setTradovatePassword: vi.fn((v: string) => { store["password"] = v; }),
  getTradovateApiCid: vi.fn(() => store["apiCid"] ?? null),
  setTradovateApiCid: vi.fn((v: string) => { store["apiCid"] = v; }),
  getTradovateApiSecret: vi.fn(() => store["apiSecret"] ?? null),
  setTradovateApiSecret: vi.fn((v: string) => { store["apiSecret"] = v; }),
  // Topstep fields — consumed by settings-cache.ts at module-evaluation time.
  getTopstepUsername: vi.fn(() => null),
  setTopstepUsername: vi.fn(),
  getTopstepApiKey: vi.fn(() => null),
  setTopstepApiKey: vi.fn(),
  getTopstepWebhookUrl: vi.fn(() => null),
  setTopstepWebhookUrl: vi.fn(),
  // Market-data keys — also read by settings-cache.ts at
  // module-evaluation time.
  getDatabentoApiKey: vi.fn(() => null),
  setDatabentoApiKey: vi.fn(),
  getMarketDataHistoricalProvider: vi.fn(() => null),
  setMarketDataHistoricalProvider: vi.fn(),
  getMarketDataRealtimeProvider: vi.fn(() => null),
  setMarketDataRealtimeProvider: vi.fn(),
  // Misc settings consumed by transitive deps.
  getNotificationsEnabled: vi.fn(() => false),
  setNotificationsEnabled: vi.fn(),
  getSetupConfirmedAt: vi.fn(() => null),
  setSetupConfirmedAt: vi.fn(),
  getSetupConfirmedSignature: vi.fn(() => null),
  setSetupConfirmedSignature: vi.fn(),
}));

import {
  resolveTradovateAppIdentity,
  __resetTradovateAppIdentityCacheForTests,
} from "./tradovate-defaults";
import {
  getTradovateAppId,
  setTradovateAppId,
  getTradovateAppVersion,
  setTradovateAppVersion,
  getTradovateDeviceId,
  setTradovateDeviceId,
  setTradovateDeviceIdUserSet,
} from "@/lib/db/settings";
import { readTradovateCredentialsFromDb } from "@/lib/brokers/tradovate/client";

// Reset shared state before each test so tests are fully isolated.
beforeEach(() => {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  vi.mocked(getTradovateAppId).mockClear();
  vi.mocked(setTradovateAppId).mockClear();
  vi.mocked(getTradovateAppVersion).mockClear();
  vi.mocked(setTradovateAppVersion).mockClear();
  vi.mocked(getTradovateDeviceId).mockClear();
  vi.mocked(setTradovateDeviceId).mockClear();
  vi.mocked(setTradovateDeviceIdUserSet).mockClear();
  // Clear the module-level package.json version cache between tests.
  __resetTradovateAppIdentityCacheForTests();
});

describe("resolveTradovateAppIdentity — fresh DB (all null)", () => {
  it("writes appId = 'TopstepAPI' to DB", () => {
    resolveTradovateAppIdentity();
    expect(setTradovateAppId).toHaveBeenCalledWith("TopstepAPI");
  });

  it("writes appVersion from package.json to DB", () => {
    resolveTradovateAppIdentity();
    expect(setTradovateAppVersion).toHaveBeenCalledWith("1.2.3");
  });

  it("generates a deviceId and writes it to DB", () => {
    resolveTradovateAppIdentity();
    expect(setTradovateDeviceId).toHaveBeenCalledWith("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("returned appId and appVersion match the written values, not null", () => {
    const result = resolveTradovateAppIdentity();
    expect(result.appId).toBe("TopstepAPI");
    expect(result.appVersion).toBe("1.2.3");
    expect(result.deviceId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("appIdAuto, appVersionAuto, and deviceIdAuto are all true on fresh DB", () => {
    const result = resolveTradovateAppIdentity();
    expect(result.appIdAuto).toBe(true);
    expect(result.appVersionAuto).toBe(true);
    expect(result.deviceIdAuto).toBe(true);
  });
});

describe("resolveTradovateAppIdentity — DB already populated", () => {
  it("does NOT call setTradovateAppId when DB already has appId", () => {
    store["appId"] = "TopstepAPI";
    resolveTradovateAppIdentity();
    expect(setTradovateAppId).not.toHaveBeenCalled();
  });

  it("does NOT call setTradovateAppVersion when DB already has appVersion", () => {
    store["appVersion"] = "1.2.3";
    resolveTradovateAppIdentity();
    expect(setTradovateAppVersion).not.toHaveBeenCalled();
  });

  it("does NOT call setTradovateDeviceId when DB already has a non-empty deviceId", () => {
    store["deviceId"] = "existing-device-uuid";
    resolveTradovateAppIdentity();
    expect(setTradovateDeviceId).not.toHaveBeenCalled();
  });

  it("appIdAuto is false when DB has a custom appId that differs from the default", () => {
    store["appId"] = "MyCustomApp";
    const result = resolveTradovateAppIdentity();
    expect(result.appIdAuto).toBe(false);
  });

  it("appVersionAuto is false when DB has a custom appVersion that differs from package version", () => {
    store["appVersion"] = "0.0.1-custom";
    const result = resolveTradovateAppIdentity();
    expect(result.appVersionAuto).toBe(false);
  });

  it("deviceIdAuto is false when deviceIdUserSet flag is true in DB", () => {
    store["deviceId"] = "operator-chosen-uuid";
    store["deviceIdUserSet"] = "true";
    const result = resolveTradovateAppIdentity();
    expect(result.deviceIdAuto).toBe(false);
  });
});

describe("resolveTradovateAppIdentity — idempotency", () => {
  it("does not call any setter on a second call once DB has all three values", () => {
    // First call populates DB (via mock store side-effects).
    resolveTradovateAppIdentity();
    // Clear call counts only (store is already populated from first call).
    vi.mocked(setTradovateAppId).mockClear();
    vi.mocked(setTradovateAppVersion).mockClear();
    vi.mocked(setTradovateDeviceId).mockClear();
    vi.mocked(setTradovateDeviceIdUserSet).mockClear();

    resolveTradovateAppIdentity();

    expect(setTradovateAppId).not.toHaveBeenCalled();
    expect(setTradovateAppVersion).not.toHaveBeenCalled();
    expect(setTradovateDeviceId).not.toHaveBeenCalled();
    expect(setTradovateDeviceIdUserSet).not.toHaveBeenCalled();
  });

  it("returns identical values on both calls", () => {
    const first = resolveTradovateAppIdentity();
    const second = resolveTradovateAppIdentity();
    expect(second.appId).toBe(first.appId);
    expect(second.appVersion).toBe(first.appVersion);
    expect(second.deviceId).toBe(first.deviceId);
  });
});

describe("regression: readTradovateCredentialsFromDb returns non-null after resolveTradovateAppIdentity", () => {
  it("returns a full credential bundle when the other 4 credential fields are set", () => {
    // Pre-populate the account-specific fields that the operator enters manually.
    store["username"] = "trader@example.com";
    store["password"] = "s3cr3t";
    store["apiCid"] = "12345";
    store["apiSecret"] = "api-secret-value";

    // This is the call that the fix ensures populates appId, appVersion, deviceId.
    resolveTradovateAppIdentity();

    const bundle = readTradovateCredentialsFromDb();
    expect(bundle).not.toBeNull();
    expect(bundle?.appId).toBe("TopstepAPI");
    expect(bundle?.appVersion).toBe("1.2.3");
    expect(bundle?.deviceId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(bundle?.username).toBe("trader@example.com");
  });

  it("returns null when resolveTradovateAppIdentity has NOT been called and DB is fresh", () => {
    // Simulate the pre-fix scenario: account fields present but appId/appVersion never persisted.
    store["username"] = "trader@example.com";
    store["password"] = "s3cr3t";
    store["apiCid"] = "12345";
    store["apiSecret"] = "api-secret-value";
    // appId, appVersion, deviceId remain null in store.

    const bundle = readTradovateCredentialsFromDb();
    expect(bundle).toBeNull();
  });
});
