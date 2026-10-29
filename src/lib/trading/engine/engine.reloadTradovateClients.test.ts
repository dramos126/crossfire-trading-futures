/**
 * `reloadTradovateClients()` — what a settings save does to a running engine.
 *
 * Saving Tradovate credentials swapped the engine's clients and its routing,
 * so the accounts tagged Tradovate, but the contract resolver the constructor
 * built kept the client it was born with. On an engine started with none,
 * every Tradovate leg's resolve threw *"tagged Tradovate but no Tradovate client
 * is configured"* until a restart, and the numeric-id lookup realtime fill
 * mapping reads answered nothing (bugs.md, "Adding a broker's credentials to a
 * running engine does not make that broker tradable until a restart").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  backfillExitOrderId: vi.fn(),
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
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(),
  listGroups: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

// `BrokerKind` is a string const enum that does not inline under this
// transpiler — engine code reads it off this module (patterns.md).
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
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

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md).
vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

// The client the settings save leaves on the singleton.
const singleton = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./engine-singleton", () => ({
  getTradovateClientIfConfigured: vi.fn(async () => singleton.client),
}));

import { TradingEngine } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import type { Contract } from "@/lib/brokers/types";
import type { TickerSymbol } from "@/lib/trading/domain";

const TRADOVATE_ACCOUNT = 71001;
const TICKER = "/MNQ" as TickerSymbol;
const TOPSTEP_CONTRACT_ID = "CON.F.US.MNQ.U26";
const TRADOVATE_SYMBOL = "MNQU6";
// Tradovate's position and fill frames name a contract by this number.
const TRADOVATE_NUMERIC_ID = 4799969;

type EnginePrivates = {
  resolver: {
    resolve(ticker: TickerSymbol, accountId: number): Promise<Contract>;
    getTradovateSymbolForNumericId(numericId: number): string | null;
  };
  brokerRegistry: { brokerKind(accountId: number): string };
};

function topstepClient(): TopstepClient {
  const client = new TopstepClient("http://localhost:0");
  vi.spyOn(client, "searchContracts").mockResolvedValue([
    {
      id: TOPSTEP_CONTRACT_ID,
      name: TRADOVATE_SYMBOL,
      description: "Micro E-mini Nasdaq-100",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    },
  ]);
  return client;
}

function tradovateClient(): TradovateClient {
  const client = new TradovateClient("http://localhost:0");
  vi.spyOn(client, "suggestContracts").mockResolvedValue([
    { id: TRADOVATE_NUMERIC_ID, name: TRADOVATE_SYMBOL, contractMaturityId: 52_100 },
  ] as Awaited<ReturnType<TradovateClient["suggestContracts"]>>);
  vi.spyOn(client, "getContractMaturity").mockResolvedValue({
    expirationDate: "2026-09-18T13:30:00.000Z",
  } as Awaited<ReturnType<TradovateClient["getContractMaturity"]>>);
  return client;
}

/** An engine started with no Tradovate client, whose registry already tags the
 *  account Tradovate — what the settings save's refresh leaves behind. */
function makeEngine() {
  const engine = new TradingEngine(topstepClient(), null, null);
  const priv = engine as unknown as EnginePrivates;
  vi.spyOn(priv.brokerRegistry, "brokerKind").mockReturnValue("tradovate");
  vi.spyOn(engine, "refreshBrokerRegistry").mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<TradingEngine["refreshBrokerRegistry"]>>,
  );
  engine.setLogHandler(() => {});
  return { engine, priv };
}

beforeEach(() => {
  singleton.client = null;
});

describe("reloadTradovateClients — the contract resolver follows the new client", () => {
  it("refuses a Tradovate leg before the save, which is the state the save has to change", async () => {
    const { priv } = makeEngine();
    await expect(priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT)).rejects.toThrow(
      /no Tradovate client is configured/,
    );
  });

  it("resolves a Tradovate-tagged account's leg after the save, on an engine started without a client", async () => {
    const { engine, priv } = makeEngine();
    singleton.client = tradovateClient();

    await engine.reloadTradovateClients();
    const contract = await priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT);

    expect(contract.id).toBe(TOPSTEP_CONTRACT_ID);
    expect(contract.executionContractId).toBe(TRADOVATE_SYMBOL);
  });

  it("answers the numeric-id lookup realtime fill mapping reads, after the save", async () => {
    const { engine, priv } = makeEngine();
    singleton.client = tradovateClient();

    await engine.reloadTradovateClients();
    await priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT);

    expect(priv.resolver.getTradovateSymbolForNumericId(TRADOVATE_NUMERIC_ID)).toBe(TRADOVATE_SYMBOL);
  });

  it("resolves over the rotated client, not the one it was built with", async () => {
    const { engine, priv } = makeEngine();
    const first = tradovateClient();
    singleton.client = first;
    await engine.reloadTradovateClients();
    const rotated = tradovateClient();
    singleton.client = rotated;

    await engine.reloadTradovateClients();
    await priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT);

    expect(rotated.suggestContracts).toHaveBeenCalled();
    expect(first.suggestContracts).not.toHaveBeenCalled();
  });

  it("keeps the contract cache when a save hands back the same client", async () => {
    const { engine, priv } = makeEngine();
    const client = tradovateClient();
    singleton.client = client;
    await engine.reloadTradovateClients();
    await priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT);

    await engine.reloadTradovateClients();
    await priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT);

    expect(client.suggestContracts).toHaveBeenCalledTimes(1);
  });

  it("refuses again after the credentials are removed", async () => {
    const { engine, priv } = makeEngine();
    singleton.client = tradovateClient();
    await engine.reloadTradovateClients();
    singleton.client = null;

    await engine.reloadTradovateClients();

    await expect(priv.resolver.resolve(TICKER, TRADOVATE_ACCOUNT)).rejects.toThrow(
      /no Tradovate client is configured/,
    );
  });
});
