/**
 * The dashboard's ARMED reading through `processDeployment` — when the engine
 * asks a strategy's `setupStatus`, when it clears the answer, and that asking
 * never changes the tick. The harness is `engine.entry.test.ts`'s: the
 * collaborators that decide are real, the account rows and the order are not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  relay: { emitSetupsChanged: vi.fn(), emitDeploymentsChanged: vi.fn(), emitStrategyTradeClosed: vi.fn() },
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// This process holds the engine lease; the entry refusal is pinned in
// `engine.restartEntryHold.test.ts`.
vi.mock("@/lib/db/lease", () => ({ holdsLease: () => true, leaseGate: () => () => true, reportLeaseRefused: vi.fn() }));

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
  getLastExitAt: vi.fn().mockReturnValue(null),
  getOpenTradeForDeployment: vi.fn().mockReturnValue(null),
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
  listSessionLatchedEntries: vi.fn().mockReturnValue([]),
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
  getGroupLegTotal: vi.fn().mockReturnValue(0),
  listGroups: vi.fn().mockReturnValue([]),
  softDeleteGroup: vi.fn(),
}));

// The relay is present, so every change the engine announces is countable.
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  getBroadcaster: vi.fn(() => null),
  peekBroadcaster: vi.fn(() => h.relay),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  getAccountDeployState: vi.fn().mockReturnValue(null),
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  resolveSessionPosture: vi.fn(),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
  toAccountBrokerSeeds: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/skipped-signals", () => ({
  insertSkippedSignal: vi.fn(),
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
  getLastBarTimestamp: vi.fn().mockReturnValue(null),
  setLastBarTimestamp: vi.fn(),
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
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

import { TradingEngine, type DeploymentState } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { BrokerRegistry } from "@/lib/brokers/registry";
import type { BrokerCapabilities, BrokerPlugin } from "@/lib/brokers/plugin";
import type { BarData, Contract } from "@/lib/brokers/types";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";
import type { EntrySignal, EntrySkip, SetupReading, StrategyModule } from "../strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "../strategy-types";
import { insertSkippedSignal } from "@/lib/db/skipped-signals";
import { listGroups } from "@/lib/db/deployment-groups";
import { getStrategy } from "../strategies";
import { resetLogBursts } from "@/lib/logging/pipe";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPL_A = "depl-a";
const GROUP_ID = "grp-1";
const ACCOUNT_ID = 90063379;
const TICKER = "/MNQ" as TickerSymbol;
const NOTE = "Range 21,410–21,452 set · waiting on a 5m close past either side.";
const BAR_MS = 5 * 60_000;

/** 11:00 ET on a Friday — inside the 09:30–15:55 default main session. */
const NOON_ET = new Date("2026-09-04T15:00:00.000Z");

const CONTRACT = {
  id: "CON.F.US.MNQ.U26",
  name: "MNQU6",
  description: "Micro E-mini Nasdaq",
  tickSize: 0.25,
  tickValue: 0.5,
  activeContract: true,
  symbolId: "F.US.MNQ",
} satisfies Contract;

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

function pluginStub(id: string): BrokerPlugin {
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
    searchAccounts: vi.fn().mockResolvedValue([]),
    searchOpenOrders: vi.fn().mockResolvedValue([]),
    searchOpenPositions: vi.fn().mockResolvedValue([]),
    searchTrades: vi.fn().mockResolvedValue([]),
    getFillsForOrder: vi.fn().mockResolvedValue([]),
    searchContracts: vi.fn().mockResolvedValue([]),
    placeOrder: vi
      .fn()
      .mockResolvedValue({ orderId: 0, success: true, errorCode: 0, errorMessage: null }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    modifyOrder: vi.fn().mockResolvedValue(undefined),
    invalidateOpenOrders: vi.fn(),
  } as BrokerPlugin;
}

function deployment(id: string): Deployment {
  return {
    id,
    accountId: ACCOUNT_ID,
    ticker: TICKER,
    strategyKey: "test",
    status: "Active",
    paramValues: {},
    groupId: GROUP_ID,
  } as Deployment;
}

function group(id: string, enabled = true): DeploymentGroup {
  return {
    id,
    name: "Fan-out",
    strategyKey: "test",
    paramValues: {},
    ticker: TICKER,
    contractId: null,
    enabled,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    deletedAt: null,
  } as DeploymentGroup;
}

/** Thirty 5m bars ending five minutes before `now`. */
function barsBefore(now: Date): BarData[] {
  const out: BarData[] = [];
  for (let i = 30; i > 0; i--) {
    out.push({
      timestamp: new Date(now.getTime() - i * BAR_MS).toISOString(),
      open: 21_000,
      high: 21_010,
      low: 20_990,
      close: 21_005,
      volume: 500,
    });
  }
  return out;
}

type EnginePrivates = {
  entriesSuspended: boolean;
  fetchBars(contract: Contract, timeframe: string, depth: number): Promise<BarData[]>;
  getState(deploymentId: string): DeploymentState;
  processDeployment(strategy: StrategyModule, deployment: Deployment): Promise<void>;
  resolver: { resolve(ticker: string, accountId: number): Promise<Contract> };
};

type Entry = EntrySignal | EntrySkip | null;

/** A module whose `shouldEnter` and `setupStatus` answers a test sets bar by bar. */
function playbook(answers: { entry: Entry; setup: () => SetupReading | null }) {
  const shouldEnter = vi.fn((): Entry => answers.entry);
  const setupStatus = vi.fn((): SetupReading | null => answers.setup());
  const module: StrategyModule = {
    version: "1.0.0",
    params: withCommonParams({}),
    config: {
      name: "Setup Reading",
      timeframe: "5m",
      session: LEGACY_DAY_SESSION,
      entryType: 2,
      indicators: [],
    },
    buildIndicators: () => [],
    shouldEnter,
    shouldExit: () => false,
    setupStatus,
  };
  return { module, shouldEnter, setupStatus };
}

function makeEngine() {
  const registry = new BrokerRegistry();
  registry.register(pluginStub("topstep"));
  const engine = new TradingEngine(
    new TopstepClient("http://localhost:0"),
    new TradovateClient("http://localhost:0"),
    null,
    registry,
  );
  const priv = engine as unknown as EnginePrivates;
  const warnings: string[] = [];
  engine.setLogHandler((record) => {
    if (record.severity === "warn") warnings.push(record.message);
  });
  priv.resolver.resolve = vi.fn().mockResolvedValue(CONTRACT);
  vi.mocked(listGroups).mockReturnValue([group(GROUP_ID)]);

  // Every call is a new bar: the clock moves a bar and the read ends a bar later.
  let now = NOON_ET;
  const bar = async (module: StrategyModule, depl: Deployment) => {
    now = new Date(now.getTime() + BAR_MS);
    vi.setSystemTime(now);
    priv.fetchBars = vi.fn().mockResolvedValue(barsBefore(now));
    await priv.processDeployment(module, depl);
  };
  return { engine, priv, warnings, bar };
}

function arm(engine: TradingEngine, module: StrategyModule, depl: Deployment): void {
  vi.mocked(getStrategy).mockReturnValue(module);
  engine.sync([depl]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOON_ET);
  resetLogBursts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processDeployment — the setup reading", () => {
  it("publishes the hook's note on a flat leg whose shouldEnter found nothing, and announces it once", async () => {
    const { engine, bar } = makeEngine();
    const { module, setupStatus } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);

    await bar(module, depl);
    await bar(module, depl);
    await bar(module, depl);

    expect(setupStatus).toHaveBeenCalledTimes(3);
    expect(engine.getSetupReadings()).toEqual({ [DEPL_A]: NOTE });
    expect(h.relay.emitSetupsChanged).toHaveBeenCalledTimes(1);
  });

  it("asks the hook after a skip too, and the skip is still recorded", async () => {
    const { engine, bar } = makeEngine();
    const { module } = playbook({
      entry: { skip: "against the 5m EMA stack", gate: "emaStack" },
      setup: () => ({ note: NOTE }),
    });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);

    await bar(module, depl);

    expect(engine.getSetupReadings()).toEqual({ [DEPL_A]: NOTE });
    expect(insertSkippedSignal).toHaveBeenCalledTimes(1);
  });

  it("reads no hook as flat", async () => {
    const { engine, bar } = makeEngine();
    const { module } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const { setupStatus: _hook, ...withoutHook } = module;
    const depl = deployment(DEPL_A);
    arm(engine, withoutHook, depl);

    await bar(withoutHook, depl);

    expect(engine.getSetupReadings()).toEqual({});
    expect(h.relay.emitSetupsChanged).not.toHaveBeenCalled();
  });

  it("reads a throwing hook as flat, warns once, and leaves the tick to finish", async () => {
    const { engine, priv, warnings, bar } = makeEngine();
    const answers = {
      entry: { skip: "against the 5m EMA stack", gate: "emaStack" } as Entry,
      setup: (): SetupReading | null => ({ note: NOTE }),
    };
    const { module } = playbook(answers);
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    answers.setup = () => {
      throw new Error("bad bars");
    };
    await expect(bar(module, depl)).resolves.toBeUndefined();
    await bar(module, depl);

    expect(engine.getSetupReadings()).toEqual({});
    // The tick ran to its end both times: the bar was stamped and each skip recorded.
    expect(priv.getState(DEPL_A).lastBarTimestamp).not.toBeNull();
    expect(insertSkippedSignal).toHaveBeenCalledTimes(3);
    expect(warnings.filter((m) => m.includes("Setup status hook threw (bad bars)"))).toHaveLength(1);
  });

  it("does not ask the hook on a bar that signals, and clears what the last bar said", async () => {
    const { engine, bar } = makeEngine();
    const answers = { entry: null as Entry, setup: (): SetupReading | null => ({ note: NOTE }) };
    const { module, shouldEnter, setupStatus } = playbook(answers);
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);
    expect(engine.getSetupReadings()).toEqual({ [DEPL_A]: NOTE });

    // Whatever the entry path then does with the signal — here the sizer
    // refuses it — the setup it was waiting on has fired.
    answers.entry = { side: 0, slTicks: 40, tpTicks: 80 };
    await bar(module, depl);

    expect(shouldEnter).toHaveBeenCalledTimes(2);
    expect(setupStatus).toHaveBeenCalledTimes(1);
    expect(engine.getSetupReadings()).toEqual({});
    expect(h.relay.emitSetupsChanged).toHaveBeenCalledTimes(2);
  });

  it("clears on a bar an entry gate returned before shouldEnter, without asking the hook", async () => {
    const { engine, priv, bar } = makeEngine();
    const { module, shouldEnter, setupStatus } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    priv.entriesSuspended = true;
    await bar(module, depl);

    expect(shouldEnter).toHaveBeenCalledTimes(1);
    expect(setupStatus).toHaveBeenCalledTimes(1);
    expect(engine.getSetupReadings()).toEqual({});
  });

  it("clears on a bar the leg spends holding a position", async () => {
    const { engine, priv, bar } = makeEngine();
    const { module, setupStatus } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    priv.getState(DEPL_A).position = {
      side: 0,
      entryPrice: 21_005,
      entryTimestamp: NOON_ET.toISOString(),
      barsSinceEntry: 0,
      entryFilledAt: null,
      size: 1,
      slTicks: 40,
    };
    await bar(module, depl);

    expect(setupStatus).toHaveBeenCalledTimes(1);
    expect(engine.getSetupReadings()).toEqual({});
  });

  it("clears at the sync that disables the leg's parent, before any bar", async () => {
    const { engine, bar } = makeEngine();
    const { module } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    vi.mocked(listGroups).mockReturnValue([group(GROUP_ID, false)]);
    engine.sync([depl]);

    expect(engine.getSetupReadings()).toEqual({});
    expect(h.relay.emitSetupsChanged).toHaveBeenCalledTimes(2);
  });

  it("clears when the bar read throws — a dead feed is not a standing setup", async () => {
    const { engine, priv, bar } = makeEngine();
    const { module } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);
    expect(engine.getSetupReadings()).toEqual({ [DEPL_A]: NOTE });

    priv.fetchBars = vi.fn().mockRejectedValue(new Error("feed down"));
    await expect(priv.processDeployment(module, depl)).rejects.toThrow("feed down");

    expect(engine.getSetupReadings()).toEqual({});
  });

  it("clears when the bar read comes back empty", async () => {
    const { engine, priv, bar } = makeEngine();
    const { module } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    priv.fetchBars = vi.fn().mockResolvedValue([]);
    await priv.processDeployment(module, depl);

    expect(engine.getSetupReadings()).toEqual({});
  });

  it("clears at stop", async () => {
    const { engine, bar } = makeEngine();
    const { module } = playbook({ entry: null, setup: () => ({ note: NOTE }) });
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    await bar(module, depl);

    engine.stop();

    expect(engine.getSetupReadings()).toEqual({});
  });
});
