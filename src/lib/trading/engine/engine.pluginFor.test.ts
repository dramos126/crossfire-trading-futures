/**
 * Unit tests for TradingEngine.pluginFor() — the private helper that resolves
 * a BrokerPlugin from the injected BrokerPluginRegistry by broker kind.
 *
 * Access pattern: (engine as any).pluginFor(kind).
 * Uses a real BrokerRegistry with stub plugins; does NOT mock the registry class.
 */

import { describe, it, expect, vi } from "vitest";

// ── DB + heavy-dependency stubs (must be hoisted) ─────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  sendOrphanAlert: vi.fn().mockResolvedValue(undefined),
  formatNyTime: vi.fn().mockReturnValue(""),
  formatAccountLabel: vi.fn().mockReturnValue(""),
  COLOR_ENTRY_LONG: 0,
  COLOR_ENTRY_SHORT: 0,
  COLOR_EXIT_WIN: 0,
  COLOR_EXIT_LOSS: 0,
  COLOR_EXIT_FLAT: 0,
  COLOR_EXIT_BE: 0,
  COLOR_EXIT_TRAIL: 0,
  COLOR_EXIT_STRATEGY: 0,
  COLOR_EXIT_MANUAL: 0,
  COLOR_BRACKET_FAILURE: 0,
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
  ansiGreen: (s: string) => s,
  ansiRed: (s: string) => s,
  ansiBlue: (s: string) => s,
  ansiGray: (s: string) => s,
  ANSI_LINE_WIDTH: 80,
  padAnsiLine: (s: string) => s,
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(),
  listClosingDeployments: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  listManagedDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn().mockReturnValue([]),
  reapDestroyingDeployment: vi.fn(),
  settlePausingDeployment: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  abandonSnapshotQueue: vi.fn(),
  backfillEntryFilledAt: vi.fn(),
  backfillExitFilledAt: vi.fn(),
  closeTrade: vi.fn(),
  findRecentApproximatedTradeByAccountContract: vi.fn(),
  findTradeByAccountContract: vi.fn().mockReturnValue(null),
  getAllOpenTrades: vi.fn().mockReturnValue([]),
  getApproximatedClosedTrades: vi.fn().mockReturnValue([]),
  getBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  getAccountRealizedSinceGross: vi.fn().mockReturnValue(0),
  getLastExitAt: vi.fn(),
  getOpenTradeForDeployment: vi.fn(),
  getReconcilableTrades: vi.fn().mockReturnValue([]),
  getRecentlyClosedTrades: vi.fn().mockReturnValue([]),
  getTradeById: vi.fn(),
  getTradesNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  healApproximatedExit: vi.fn(),
  incrementSnapshotRetry: vi.fn(),
  insertPendingEntry: vi.fn(),
  listAccountsNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  listAccountsWithBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  listAccountsWithReconcilableTrades: vi.fn().mockReturnValue([]),
  listAllAccountsWithApproximatedTrades: vi.fn().mockReturnValue([]),
  listDueSnapshots: vi.fn().mockReturnValue([]),
  markBreakEvenMoved: vi.fn(),
  markSlTrailEngaged: vi.fn(),
  markEntryFailed: vi.fn(),
  markEntryFilled: vi.fn(),
  saveTradeBars: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
  setExitReason: vi.fn(),
  backfillExitOrderId: vi.fn(),
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(),
  listGroups: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  getNotificationsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/engine-logs", () => ({
  appendLog: vi.fn(),
  getRecentLogs: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

// ── Imports (after vi.mock hoisting) ──────────────────────────────────────────

import { TradingEngine } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { BrokerRegistry } from "@/lib/brokers/registry";
import type { BrokerCapabilities, BrokerPlugin } from "@/lib/brokers/plugin";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Neutral capability set for stubs that never exercise one. Deliberately
 *  not a copy of either real broker's answers — a stub that silently
 *  matched one of them would make a capability regression invisible. */
const STUB_CAPABILITIES: BrokerCapabilities = {
  fillCarriesPnl: false,
  historicalFillsRequireOrderLookup: false,
  bracketAttribution: "reconciler",
  bracketAnchor: "fill",
  positionCloseGraceMs: 0,
  stopCoverageSource: "open-orders",
  realtimeAccountScope: "traded",
  entryFillMayRacePlaceResponse: false,
  realtimeDrivesReconciliation: false,
  realtimeFeedOutlivesEngineStop: false,
  authFailureScope: "account",
};

/** Minimal BrokerPlugin stub — every required property/method present. */
function makePluginStub(id: string): BrokerPlugin {
  return {
    id,
    displayName: id,
    capabilities: STUB_CAPABILITIES,
    isConfigured: vi.fn().mockReturnValue(false),
    isExpected: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
    getClient: vi.fn().mockReturnValue(null),
    getBrowserToken: vi.fn().mockResolvedValue(null),
    credentialSchema: vi.fn().mockReturnValue([]),
    applyCredentials: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue(undefined),
    classifyError: vi.fn().mockReturnValue("network"),
    ownsError: vi.fn().mockReturnValue(false),
    computeCredsSignature: vi.fn().mockReturnValue(""),
    // Broker interface
    searchAccounts: vi.fn().mockResolvedValue([]),
    searchOpenOrders: vi.fn().mockResolvedValue([]),
    searchOpenPositions: vi.fn().mockResolvedValue([]),
    searchTrades: vi.fn().mockResolvedValue([]),
    getFillsForOrder: vi.fn().mockResolvedValue([]),
    searchContracts: vi.fn().mockResolvedValue([]),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 0, success: true, errorCode: 0, errorMessage: null }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    modifyOrder: vi.fn().mockResolvedValue(undefined),
    invalidateOpenOrders: vi.fn(),
  } as BrokerPlugin;
}

/**
 * Construct a minimal TradingEngine injecting the given BrokerPluginRegistry.
 * The engine's internal BrokerRegistry (routing table) is left empty — these
 * tests only exercise pluginFor(), which reads from brokerPluginRegistry, not
 * the routing registry.
 */
function makeEngine(pluginRegistry: BrokerRegistry): TradingEngine {
  const topstepClient = new TopstepClient("http://localhost:0");
  const tradovateClient = new TradovateClient("http://localhost:0");
  // Patch the minimum surface the constructor touches on TradovateClient.
  (tradovateClient as any).getDatedSymbolForContractId = vi.fn().mockReturnValue(null);
  (tradovateClient as any).warmContractId = vi.fn().mockResolvedValue(undefined);
  return new TradingEngine(topstepClient, tradovateClient, null, pluginRegistry);
}

// ── pluginFor ─────────────────────────────────────────────────────────────────

describe("TradingEngine.pluginFor (private)", () => {
  it("returns the registered topstep plugin when called with 'topstep'", () => {
    const topstepPlugin = makePluginStub("topstep");
    const tradovatePlugin = makePluginStub("tradovate");
    const registry = new BrokerRegistry();
    registry.register(topstepPlugin);
    registry.register(tradovatePlugin);

    const engine = makeEngine(registry);
    const result = (engine as any).pluginFor("topstep");
    expect(result).toBe(topstepPlugin);
  });

  it("returns the registered tradovate plugin when called with 'tradovate'", () => {
    const topstepPlugin = makePluginStub("topstep");
    const tradovatePlugin = makePluginStub("tradovate");
    const registry = new BrokerRegistry();
    registry.register(topstepPlugin);
    registry.register(tradovatePlugin);

    const engine = makeEngine(registry);
    const result = (engine as any).pluginFor("tradovate");
    expect(result).toBe(tradovatePlugin);
  });

  it("throws when called with an unregistered broker kind, and the error message includes the kind string", () => {
    const registry = new BrokerRegistry();
    registry.register(makePluginStub("topstep"));
    // "unknown-broker" intentionally not registered

    const engine = makeEngine(registry);
    expect(() => (engine as any).pluginFor("unknown-broker")).toThrow("unknown-broker");
  });

  it("throws for any kind when the registry is completely empty", () => {
    const emptyRegistry = new BrokerRegistry();
    const engine = makeEngine(emptyRegistry);
    expect(() => (engine as any).pluginFor("topstep")).toThrow();
    expect(() => (engine as any).pluginFor("tradovate")).toThrow();
  });

  it("pluginFor does not cross-return: 'topstep' kind does not return the tradovate plugin", () => {
    const topstepPlugin = makePluginStub("topstep");
    const tradovatePlugin = makePluginStub("tradovate");
    const registry = new BrokerRegistry();
    registry.register(topstepPlugin);
    registry.register(tradovatePlugin);

    const engine = makeEngine(registry);
    expect((engine as any).pluginFor("topstep")).not.toBe(tradovatePlugin);
    expect((engine as any).pluginFor("tradovate")).not.toBe(topstepPlugin);
  });
});
