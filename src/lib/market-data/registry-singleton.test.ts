import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

// The singleton registers both real providers, and the Topstep one reaches
// the broker registry, which reaches the strategy loader's `require.context`.
// Cut the chain at the registry. The stub plugin has to answer
// `isConfigured()` — the Topstep provider's `capabilities` derives from it,
// so slot resolution consults the plugin now.
const mockTopstepConfigured = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    getPlugin: vi.fn((id: string) =>
      id === "topstep" ? { id, isConfigured: mockTopstepConfigured } : null,
    ),
  },
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  setMarketDataHistoricalProvider: vi.fn(),
  setMarketDataRealtimeProvider: vi.fn(),
  setDatabentoProbeRange: vi.fn(),
}));

vi.mock("@/lib/db/cred-validation", () => ({
  computeDatabentoCredsSignature: vi.fn(() => "sig"),
  setDatabentoCredsValidatedAt: vi.fn(),
  setDatabentoCredsValidatedSignature: vi.fn(),
}));

const mockResolveHistorical = vi.fn<() => string | null>();
const mockResolveRealtime = vi.fn<() => string | null>();

vi.mock("@/lib/db/settings-cache", () => ({
  invalidateSettingsCache: vi.fn(),
  resolveDatabentoApiKey: vi.fn(() => null),
  resolveMarketDataHistoricalProviderId: () => mockResolveHistorical(),
  resolveMarketDataRealtimeProviderId: () => mockResolveRealtime(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { marketDataRegistry } from "./registry-singleton";

beforeEach(() => {
  mockResolveHistorical.mockReturnValue(null);
  mockResolveRealtime.mockReturnValue(null);
  mockTopstepConfigured.mockReturnValue(true);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("marketDataRegistry slot defaults", () => {
  it("resolves both slots to Topstep on a fresh database", () => {
    expect(marketDataRegistry.historical().id).toBe("topstep");
    expect(marketDataRegistry.realtime().id).toBe("topstep");
  });

  it("defaults only the missing slot when the other one is selected", () => {
    mockResolveHistorical.mockReturnValue("databento");

    expect(marketDataRegistry.historical().id).toBe("databento");
    expect(marketDataRegistry.realtime().id).toBe("topstep");
  });

  it("treats an empty-string row as unset rather than a selection", () => {
    // `?? DEFAULT` would pass "" through and `resolveSlot` would throw
    // "No realtime MarketDataProvider selected" on a row that means unset.
    mockResolveHistorical.mockReturnValue("");
    mockResolveRealtime.mockReturnValue("");

    expect(marketDataRegistry.historical().id).toBe("topstep");
    expect(marketDataRegistry.realtime().id).toBe("topstep");
  });

  it("throws naming the id and pointing at Settings when the selection is garbage", () => {
    mockResolveRealtime.mockReturnValue("not-a-provider");

    expect(() => marketDataRegistry.realtime()).toThrow("not-a-provider");
    expect(() => marketDataRegistry.realtime()).toThrow("is not registered");
    expect(() => marketDataRegistry.realtime()).toThrow("in Settings");
  });

  it("refuses the realtime slot when Topstep is selected but not configured", () => {
    // The static `liveBars: true` used to let the boot pre-flight pass on
    // an install with zero Topstep credentials, and the failure landed on
    // the first fetchBars — one error per deployment per tick, forever.
    mockTopstepConfigured.mockReturnValue(false);

    expect(() => marketDataRegistry.realtime()).toThrow("no longer declares liveBars");
  });
});
