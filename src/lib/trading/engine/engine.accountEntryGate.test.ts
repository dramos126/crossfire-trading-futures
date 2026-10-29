/**
 * The account-state entry gate through `processDeployment`: a running
 * deployment on a dead, locked or Topstep OCO-off account takes no entry, its
 * open position is still evaluated for exit, and the skip is said once per
 * reason. The harness is `engine.setupStatus.test.ts`'s: the collaborators
 * that decide are real, the account rows and the order are not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountDeployState } from "@/lib/trading/broker-access/account-state-gate";

const h = vi.hoisted(() => ({
  state: null as AccountDeployState | null,
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

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  getBroadcaster: vi.fn(() => null),
  peekBroadcaster: vi.fn(() => null),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  getAccountDeployState: vi.fn(() => h.state),
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
import type { StrategyModule } from "../strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "../strategy-types";
import { listGroups } from "@/lib/db/deployment-groups";
import { getStrategy } from "../strategies";
import { resetLogBursts } from "@/lib/logging/pipe";
import type { LogRecord } from "@/lib/logging/pipe";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPL_A = "depl-a";
const GROUP_ID = "grp-1";
const ACCOUNT_ID = 90043379;
const TICKER = "/MNQ" as TickerSymbol;
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

function accountState(over: Partial<AccountDeployState> = {}): AccountDeployState {
  return {
    broker: "topstep",
    status: "ok",
    cause: null,
    lockoutReason: null,
    lockoutUntil: null,
    autoOcoBrackets: true,
    bracketAutoApply: false,
    bracketRiskUsd: null,
    bracketTargetUsd: null,
    ...over,
  };
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

function group(id: string): DeploymentGroup {
  return {
    id,
    name: "Fan-out",
    strategyKey: "test",
    paramValues: {},
    ticker: TICKER,
    contractId: null,
    enabled: true,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    deletedAt: null,
  } as DeploymentGroup;
}

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
  fetchBars(contract: Contract, timeframe: string, depth: number): Promise<BarData[]>;
  getState(deploymentId: string): DeploymentState;
  processDeployment(strategy: StrategyModule, deployment: Deployment): Promise<void>;
  resolver: { resolve(ticker: string, accountId: number): Promise<Contract> };
};

function playbook() {
  const shouldEnter = vi.fn(() => null);
  const shouldExit = vi.fn(() => false);
  const module: StrategyModule = {
    version: "1.0.0",
    params: withCommonParams({}),
    config: {
      name: "Account Gate",
      timeframe: "5m",
      session: LEGACY_DAY_SESSION,
      entryType: 2,
      indicators: [],
    },
    buildIndicators: () => [],
    shouldEnter,
    shouldExit,
  };
  return { module, shouldEnter, shouldExit };
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
  const lines: LogRecord[] = [];
  engine.setLogHandler((record) => lines.push(record));
  priv.resolver.resolve = vi.fn().mockResolvedValue(CONTRACT);
  vi.mocked(listGroups).mockReturnValue([group(GROUP_ID)]);

  let now = NOON_ET;
  const bar = async (module: StrategyModule, depl: Deployment) => {
    now = new Date(now.getTime() + BAR_MS);
    vi.setSystemTime(now);
    priv.fetchBars = vi.fn().mockResolvedValue(barsBefore(now));
    await priv.processDeployment(module, depl);
  };
  const accountLines = () =>
    lines.filter((l) => l.event?.startsWith("deployment_account_")).map((l) => l.event);
  return { engine, priv, bar, accountLines };
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
  h.state = accountState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processDeployment — the account-state entry gate", () => {
  it("skips entries on a dead account and says so once", async () => {
    const { engine, bar, accountLines } = makeEngine();
    const { module, shouldEnter } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    h.state = accountState({ status: "dead" });

    await bar(module, depl);
    await bar(module, depl);
    await bar(module, depl);

    expect(shouldEnter).not.toHaveBeenCalled();
    expect(accountLines()).toEqual(["deployment_account_dead"]);
  });

  it("skips entries on a locked account until the lock's end, then resumes and says so once", async () => {
    const { engine, bar, accountLines } = makeEngine();
    const { module, shouldEnter } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    // Ends between the second and third bar.
    h.state = accountState({
      status: "locked",
      lockoutReason: "Daily loss limit",
      lockoutUntil: new Date(NOON_ET.getTime() + 2.5 * BAR_MS).toISOString(),
    });

    await bar(module, depl);
    await bar(module, depl);
    expect(shouldEnter).not.toHaveBeenCalled();

    await bar(module, depl);
    await bar(module, depl);
    expect(shouldEnter).toHaveBeenCalledTimes(2);
    expect(accountLines()).toEqual(["deployment_account_locked", "deployment_account_entries_resumed"]);
  });

  it("skips entries on a Topstep account whose OCO setting reads off", async () => {
    const { engine, bar, accountLines } = makeEngine();
    const { module, shouldEnter } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    h.state = accountState({ autoOcoBrackets: false });

    await bar(module, depl);

    expect(shouldEnter).not.toHaveBeenCalled();
    expect(accountLines()).toEqual(["deployment_account_oco_off"]);
  });

  it("keeps entering on a Topstep account whose OCO setting is unknown", async () => {
    const { engine, bar, accountLines } = makeEngine();
    const { module, shouldEnter } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    h.state = accountState({ autoOcoBrackets: null });

    await bar(module, depl);

    expect(shouldEnter).toHaveBeenCalledTimes(1);
    expect(accountLines()).toEqual([]);
  });

  it("keeps entering on a Tradovate account whatever its OCO column reads", async () => {
    const { engine, bar, accountLines } = makeEngine();
    const { module, shouldEnter } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    h.state = accountState({ broker: "tradovate", autoOcoBrackets: false });

    await bar(module, depl);

    expect(shouldEnter).toHaveBeenCalledTimes(1);
    expect(accountLines()).toEqual([]);
  });

  it("still evaluates exits on an open position while the account is dead", async () => {
    const { engine, priv, bar, accountLines } = makeEngine();
    const { module, shouldEnter, shouldExit } = playbook();
    const depl = deployment(DEPL_A);
    arm(engine, module, depl);
    h.state = accountState({ status: "dead" });
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
    await bar(module, depl);

    expect(shouldExit).toHaveBeenCalledTimes(2);
    expect(shouldEnter).not.toHaveBeenCalled();
    // Holding, the entry gate is never reached, so nothing is said yet.
    expect(accountLines()).toEqual([]);
  });
});
