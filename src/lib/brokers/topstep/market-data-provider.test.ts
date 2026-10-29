import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted before any import) ──────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  setTopstepUsername: vi.fn(),
  setTopstepApiKey: vi.fn(),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  setTopstepWebhookUrl: vi.fn(),
  getNotificationsEnabled: vi.fn().mockReturnValue(false),
  setNotificationsEnabled: vi.fn(),
  getSetupConfirmedAt: vi.fn().mockReturnValue(null),
  setSetupConfirmedAt: vi.fn(),
  getSetupSignature: vi.fn().mockReturnValue(null),
  setSetupSignature: vi.fn(),
  clearSetupConfirmedAt: vi.fn(),
  clearSetupSignature: vi.fn(),
  getTradovateUsername: vi.fn().mockReturnValue(null),
  setTradovateUsername: vi.fn(),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  setTradovatePassword: vi.fn(),
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  setTradovateApiCid: vi.fn(),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  setTradovateApiSecret: vi.fn(),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  setTradovateAppId: vi.fn(),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  setTradovateAppVersion: vi.fn(),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  setTradovateDeviceId: vi.fn(),
  getTradovateDeviceIdUserSet: vi.fn().mockReturnValue(false),
  setTradovateDeviceIdUserSet: vi.fn(),
  clearTradovateDeviceIdUserSet: vi.fn(),
}));

// Mock the broker registry singleton so tests control which plugin is returned.
// The factory cannot reference outer-scope variables (hoisting), so we use a
// plain vi.fn() and re-capture it after import via vi.mocked().
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    getPlugin: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import type { BarDataApi } from "@/lib/brokers/topstep/types";
import type { RetrieveBarsRequest } from "@/lib/brokers/types";
import type { BrokerPlugin } from "@/lib/brokers/plugin";

// The singleton is the only exported handle on the class. We test through it;
// brokerRegistry is fully mocked at the module boundary, so each test controls
// the full execution path.
import { topstepMarketDataProvider } from "./market-data-provider";

// Typed handle to the mocked module.
const mockGetPlugin = vi.mocked(brokerRegistry.getPlugin);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApiBar(t: string, o: number, h: number, l: number, c: number, v: number): BarDataApi {
  return { t, o, h, l, c, v };
}

function makeRequest(): RetrieveBarsRequest {
  return {
    contractId: "CON.F.US.EP.H26",
    live: false,
    startTime: "2026-01-01T00:00:00Z",
    endTime: "2026-01-02T00:00:00Z",
    unit: 2,
    unitNumber: 1,
    limit: 100,
    includePartialBar: false,
  };
}

/** Build a minimal mock TopstepBrokerPlugin with controllable client behaviour. */
function makePlugin(opts: {
  configured?: boolean;
  client?: { retrieveBars: ReturnType<typeof vi.fn> } | null;
  /** Client the plugin exposes only after `initialize()` has been awaited —
   *  the cold-route case where no boot sequence ran first. */
  clientAfterInitialize?: { retrieveBars: ReturnType<typeof vi.fn> };
}): BrokerPlugin {
  const clientObj = opts.client !== undefined ? opts.client : { retrieveBars: vi.fn() };
  let current = clientObj;
  const initialize = vi.fn(async () => {
    if (opts.clientAfterInitialize) current = opts.clientAfterInitialize;
  });
  return {
    id: "topstep",
    isConfigured: vi.fn().mockReturnValue(opts.configured ?? true),
    getClient: vi.fn(() => current),
    initialize,
  } as unknown as BrokerPlugin;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TopstepMarketDataProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── isConfigured ─────────────────────────────────────────────────────────

  describe("isConfigured()", () => {
    it("returns true when plugin.isConfigured() is true", () => {
      const plugin = makePlugin({ configured: true });
      mockGetPlugin.mockReturnValue(plugin);

      expect(topstepMarketDataProvider.isConfigured()).toBe(true);
    });

    it("returns false when plugin.isConfigured() is false", () => {
      const plugin = makePlugin({ configured: false });
      mockGetPlugin.mockReturnValue(plugin);

      expect(topstepMarketDataProvider.isConfigured()).toBe(false);
    });
  });

  // ── requireClient error path ─────────────────────────────────────────────

  describe("requireClient error paths", () => {
    it("throws when plugin.getClient() returns null", async () => {
      const plugin = makePlugin({ client: null });
      mockGetPlugin.mockReturnValue(plugin);

      await expect(topstepMarketDataProvider.retrieveBars(makeRequest())).rejects.toThrow(
        "topstep broker plugin has no client",
      );
    });

    it("throws when the topstep plugin is not registered in brokerRegistry", async () => {
      mockGetPlugin.mockReturnValue(null);

      await expect(topstepMarketDataProvider.retrieveBars(makeRequest())).rejects.toThrow(
        "topstep broker plugin not registered",
      );
    });

    it("initializes the plugin when the client is still null, then reads it back", async () => {
      const mockRetrieveBars = vi.fn().mockResolvedValue([]);
      const plugin = makePlugin({
        client: null,
        clientAfterInitialize: { retrieveBars: mockRetrieveBars },
      });
      mockGetPlugin.mockReturnValue(plugin);

      await topstepMarketDataProvider.retrieveBars(makeRequest());

      expect(plugin.initialize).toHaveBeenCalledTimes(1);
      expect(mockRetrieveBars).toHaveBeenCalledTimes(1);
    });
  });

  // ── retrieveBars ─────────────────────────────────────────────────────────

  describe("retrieveBars()", () => {
    it("maps BarDataApi fields (t→timestamp, o→open, h→high, l→low, c→close, v→volume)", async () => {
      const apiBars: BarDataApi[] = [
        makeApiBar("2026-01-01T14:00:00Z", 5900, 5910, 5895, 5905, 120),
      ];
      const mockRetrieveBars = vi.fn().mockResolvedValue(apiBars);
      const plugin = makePlugin({ client: { retrieveBars: mockRetrieveBars } });
      mockGetPlugin.mockReturnValue(plugin);

      const result = await topstepMarketDataProvider.retrieveBars(makeRequest());

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        timestamp: "2026-01-01T14:00:00Z",
        open: 5900,
        high: 5910,
        low: 5895,
        close: 5905,
        volume: 120,
      });
    });

    it("returns bars sorted ascending by timestamp when provider returns newest-first", async () => {
      // Topstep returns newest-first; provider must normalize to oldest-first.
      const apiBars: BarDataApi[] = [
        makeApiBar("2026-01-01T14:02:00Z", 5905, 5915, 5900, 5910, 80),
        makeApiBar("2026-01-01T14:01:00Z", 5900, 5910, 5895, 5905, 60),
        makeApiBar("2026-01-01T14:00:00Z", 5895, 5905, 5890, 5900, 40),
      ];
      const mockRetrieveBars = vi.fn().mockResolvedValue(apiBars);
      const plugin = makePlugin({ client: { retrieveBars: mockRetrieveBars } });
      mockGetPlugin.mockReturnValue(plugin);

      const result = await topstepMarketDataProvider.retrieveBars(makeRequest());

      expect(result[0].timestamp).toBe("2026-01-01T14:00:00Z");
      expect(result[1].timestamp).toBe("2026-01-01T14:01:00Z");
      expect(result[2].timestamp).toBe("2026-01-01T14:02:00Z");
    });

    it("returns [] when client returns an empty array", async () => {
      const mockRetrieveBars = vi.fn().mockResolvedValue([]);
      const plugin = makePlugin({ client: { retrieveBars: mockRetrieveBars } });
      mockGetPlugin.mockReturnValue(plugin);

      const result = await topstepMarketDataProvider.retrieveBars(makeRequest());

      expect(result).toEqual([]);
    });

    it("propagates errors thrown by client.retrieveBars()", async () => {
      const networkErr = new Error("socket hang up");
      const mockRetrieveBars = vi.fn().mockRejectedValue(networkErr);
      const plugin = makePlugin({ client: { retrieveBars: mockRetrieveBars } });
      mockGetPlugin.mockReturnValue(plugin);

      await expect(topstepMarketDataProvider.retrieveBars(makeRequest())).rejects.toThrow(
        "socket hang up",
      );
    });
  });

});
