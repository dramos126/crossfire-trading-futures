import { describe, it, expect } from "vitest";
import { BrokerRegistry } from "./registry";
import type { BrokerCapabilities, BrokerPlugin } from "./plugin";

// ── Stub factory ──────────────────────────────────────────────────────────────

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

function makePlugin(id: string, displayName = id): BrokerPlugin {
  return {
    id,
    displayName,
    capabilities: STUB_CAPABILITIES,
    isConfigured: () => false,
    isExpected: () => false,
    initialize: async () => {},
    invalidate: () => {},
    getClient: () => null,
    getBrowserToken: async () => null,
    credentialSchema: () => [],
    applyCredentials: async () => {},
    testConnection: async () => undefined,
    classifyError: () => "network",
    ownsError: () => false,
    computeCredsSignature: () => "",
    // Broker methods
    searchAccounts: async () => [],
    searchOpenOrders: async () => [],
    searchOpenPositions: async () => [],
    searchTrades: async () => [],
    getFillsForOrder: async () => [],
    searchContracts: async () => [],
    placeOrder: async () => ({ orderId: 0, success: true, errorCode: 0, errorMessage: null }),
    cancelOrder: async () => {},
    modifyOrder: async () => {},
    invalidateOpenOrders: () => {},
  } as BrokerPlugin;
}

// ── BrokerRegistry ────────────────────────────────────────────────────────────

describe("BrokerRegistry", () => {
  it("register then getPlugin round-trip returns the same plugin", () => {
    const reg = new BrokerRegistry();
    const plugin = makePlugin("topstep");
    reg.register(plugin);
    expect(reg.getPlugin("topstep")).toBe(plugin);
  });

  it("getPlugin with unregistered id returns null, does not throw", () => {
    const reg = new BrokerRegistry();
    expect(reg.getPlugin("nonexistent")).toBeNull();
  });

  it("getPlugin with a different id than what was registered returns null", () => {
    const reg = new BrokerRegistry();
    reg.register(makePlugin("topstep"));
    expect(reg.getPlugin("tradovate")).toBeNull();
  });

  it("allPlugins returns all registered plugins", () => {
    const reg = new BrokerRegistry();
    const a = makePlugin("topstep");
    const b = makePlugin("tradovate");
    reg.register(a);
    reg.register(b);
    const all = reg.allPlugins();
    expect(all).toHaveLength(2);
    expect(all).toContain(a);
    expect(all).toContain(b);
  });

  it("allPlugins on an empty registry returns []", () => {
    const reg = new BrokerRegistry();
    expect(reg.allPlugins()).toEqual([]);
  });

  it("double-register same id: second registration silently overwrites the first", () => {
    const reg = new BrokerRegistry();
    const first = makePlugin("topstep", "First");
    const second = makePlugin("topstep", "Second");
    reg.register(first);
    reg.register(second);
    // Second plugin wins
    expect(reg.getPlugin("topstep")).toBe(second);
    expect(reg.getPlugin("topstep")).not.toBe(first);
    // Only one entry in the list — no duplicate
    expect(reg.allPlugins()).toHaveLength(1);
  });
});
