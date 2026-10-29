/**
 * `processDeployment`'s entry path — the join, not the pieces.
 *
 * Every `shouldEnter` stub in the engine suite returned `null`, so nothing past
 * the signal was ever executed by a test: the account daily-P&L gate, the
 * contract-lock claim, the bracket validation, the sizer and the entry order
 * itself ([bugs.md](../../../../docs/bugs.md) A64). Each of those is pinned in
 * isolation — `resolveRiskSizedContracts`, `evaluateDailyPnlGate` and
 * `isValidBracketTicks` all have their own suites — and **what was untested is
 * the composition**: which function the entry path calls, with which arguments,
 * in which order, and whether the contract lock is released on every arm that
 * refuses after claiming it.
 *
 * So the collaborators that decide are kept **real** — the daily-P&L gate, the
 * sizer, the bracket validator, the fee table — and the mocks sit at the two
 * ends: the account rows the engine reads, and `placeEntryOrder`, which is the
 * broker round trip and has [`engine-order.ts`](./engine-order.ts)'s own
 * coverage. A gate asserted through a stubbed evaluator would only prove the
 * stub was called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// The three account reads the entry path makes, all on one module. `BrokerKind`
// is a string const enum that does not inline under this transpiler
// (patterns.md), and `resolveSessionPosture` is what the sizer is handed — a
// bare `vi.fn()` there answers `undefined`, which the sizer would size on.
//
// Only the *row* is mocked away: the factory below drives the real
// `resolveSessionBudget` off a fixture row, so the phase arithmetic, the
// stale-sample floor and the flat pass-through are the shipped ones. A stubbed
// budget would only prove the stub was called.
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

// `recordSkippedSignal` swallows its own failures, so the throwing `getDb`
// above would turn every refusal row into a silent `log.warn` and the write
// would be untested *and* deletable while staying green — the seam gets its own
// mock for exactly that reason (patterns.md).
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

import { TradingEngine, type DeploymentState } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { BrokerRegistry } from "@/lib/brokers/registry";
import type { BrokerCapabilities, BrokerPlugin } from "@/lib/brokers/plugin";
import type { BarData, Contract } from "@/lib/brokers/types";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";
import type { EntrySignal, StrategyModule } from "../strategy-types";
import type { AccountRiskPosture } from "@/lib/trading/orders/risk-sizer";
import { LEGACY_DAY_SESSION, withCommonParams } from "../strategy-types";
import { getAccountDailyPnlLimits, resolveSessionPosture } from "@/lib/db/account-brokers";
import {
  resolveSessionBudget,
  type AccountRiskPhase,
  type SessionBudgetRow,
} from "@/lib/trading/orders/account-phase-sizer";
import { getAccountRealizedSinceGross } from "@/lib/db/trades";
import { insertSkippedSignal } from "@/lib/db/skipped-signals";
import { listGroups } from "@/lib/db/deployment-groups";
import { getDeployment } from "@/lib/db/deployments";
import { getStrategy } from "../strategies";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import {
  CONTRACT_HELD_GATE,
  DAILY_PNL_GATE,
  RISK_BUDGET_GATE,
  SIZE_RESOLUTION_GATE,
  STALE_LATCH_GATE,
} from "@/lib/trading/skipped-signal";
import { resetLogBursts } from "@/lib/logging/pipe";
import { failedPreEntrySnapshot, isFailedPreEntrySnapshot } from "./engine-order";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPL_A = "depl-a";
const OTHER_DEPL = "depl-other";
const GROUP_ID = "grp-1";
const ACCOUNT_ID = 90063379;
const TICKER = "/MNQ" as TickerSymbol;

/** 11:00 ET on a Friday — inside the 09:30–15:55 default main session, so the
 *  entry is neither window-gated nor turned into a session-close flatten. */
const NOON_ET = new Date("2026-09-04T15:00:00.000Z");

/** MNQ: $0.50 a tick, and `feePerSideFor("/MNQ")` is $0.62. A 40-tick stop is
 *  therefore $21.24 of risk per contract, which is what every size below is
 *  derived from. */
const CONTRACT = {
  id: "CON.F.US.MNQ.U26",
  name: "MNQU6",
  description: "Micro E-mini Nasdaq",
  tickSize: 0.25,
  tickValue: 0.5,
  activeContract: true,
  symbolId: "F.US.MNQ",
} satisfies Contract;

const SL_TICKS = 40;
const TP_TICKS = 80;
/** floor($100.00 / $21.24) = 4, under the account's 10-contract ceiling. */
const EXPECTED_CONTRACTS = 4;
const RISK_PER_CONTRACT_USD = 21.24;

const STUB_CAPABILITIES: BrokerCapabilities = {
  fillCarriesPnl: false,
  historicalFillsRequireOrderLookup: false,
  bracketAttribution: "reconciler",
  bracketAnchor: "fill",
  positionCloseGraceMs: 0,
  stopCoverageSource: "open-orders",
  realtimeAccountScope: "traded",
  // False, so the post-entry `getTradeById` promotion is not on this path.
  // The racing-fill promotion is `engine-fill`'s subject, not the entry join's.
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

function deployment(id: string, over: Partial<Deployment> = {}): Deployment {
  return {
    id,
    accountId: ACCOUNT_ID,
    ticker: TICKER,
    strategyKey: "test",
    status: "Active",
    paramValues: {},
    groupId: GROUP_ID,
    ...over,
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

/** Thirty 5m bars ending five minutes before the pinned instant. */
function bars(): BarData[] {
  const out: BarData[] = [];
  for (let i = 30; i > 0; i--) {
    out.push({
      timestamp: new Date(NOON_ET.getTime() - i * 5 * 60_000).toISOString(),
      open: 21_000,
      high: 21_010,
      low: 20_990,
      close: 21_005,
      volume: 500,
    });
  }
  return out;
}

const LATEST_BAR = bars()[bars().length - 1];

type EnginePrivates = {
  contractLocks: Map<string, { deploymentId: string; tradeId: number | null }>;
  acquireContractLock(
    accountId: number,
    contractId: string,
    deploymentId: string,
    tradeId: number | null,
  ): boolean;
  releaseContractLock(accountId: number, contractId: string, deploymentId: string): void;
  fetchBars(contract: Contract, timeframe: string, depth: number): Promise<BarData[]>;
  getState(deploymentId: string): DeploymentState;
  placeEntryOrder(...args: unknown[]): Promise<{ tradeId: number | null; preEntryOrderIds: number[] }>;
  processDeployment(strategy: StrategyModule, deployment: Deployment): Promise<void>;
  resolver: { resolve(ticker: string, accountId: number): Promise<Contract> };
};

/** A module that always wants the trade, with the bracket the strategy owns. */
function enteringStrategy(signal: Partial<EntrySignal> = {}) {
  const shouldEnter = vi.fn(
    (): EntrySignal => ({ side: 0, slTicks: SL_TICKS, tpTicks: TP_TICKS, ...signal }),
  );
  return {
    module: {
      version: "1.0.0",
      params: withCommonParams({}),
      config: {
        name: "Entry Join",
        timeframe: "5m",
        session: LEGACY_DAY_SESSION,
        size: 1,
        entryType: 2,
        indicators: [],
      },
      buildIndicators: () => [],
      shouldEnter,
      shouldExit: vi.fn().mockReturnValue(false),
    } as unknown as StrategyModule,
    shouldEnter,
  };
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
  const events: Array<string | null> = [];
  engine.setLogHandler((record) => void events.push(record.event));
  priv.resolver.resolve = vi.fn().mockResolvedValue(CONTRACT);
  priv.fetchBars = vi.fn().mockResolvedValue(bars());
  vi.mocked(listGroups).mockReturnValue([group(GROUP_ID)]);

  // What the three account rows say. A test moves a number here rather than
  // re-stubbing the mock: `mockReturnValue` would replace the implementation
  // and with it the recorder below, which is how a call-order assertion ends
  // up reading an empty array and passing for the wrong reason.
  const account = {
    realizedGross: 0,
    limits: { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false },
    posture: { maxRiskPerTradeUsd: 100, maxContracts: 10 } as AccountRiskPosture | null,
    /** The row's phase columns. `off` is what every account carries until the
     *  operator opts in, and on `off` the resolver hands back the flat pair
     *  unchanged — which is what makes the cases below byte-for-byte the
     *  pre-phase behaviour. */
    phase: "off" as AccountRiskPhase,
    mllUsd: null as number | null,
    startBalanceUsd: null as number | null,
    eodBalanceUsd: null as number | null,
    eodPeakUsd: null as number | null,
    eodSizesSessionStart: null as string | null,
  };

  // The call recorder. Every seam the entry path reaches between the signal
  // and the order pushes its name, so the assertions can state the *order* —
  // the property the release arms below depend on, since the lock is claimed
  // before anything that can still refuse.
  const calls: string[] = [];
  vi.mocked(getAccountRealizedSinceGross).mockImplementation(() => {
    calls.push("realized-pnl");
    return account.realizedGross;
  });
  vi.mocked(getAccountDailyPnlLimits).mockImplementation(() => {
    calls.push("daily-limits");
    return account.limits;
  });
  vi.mocked(resolveSessionPosture).mockImplementation((_accountId, now = new Date()) => {
    calls.push("risk-posture");
    const row: SessionBudgetRow = {
      broker: "topstep",
      riskPhase: account.phase,
      mllUsd: account.mllUsd,
      startBalanceUsd: account.startBalanceUsd,
      pressAtUsd: null,
      eodBalanceUsd: account.eodBalanceUsd,
      eodPeakUsd: account.eodPeakUsd,
      eodSizesSessionStart: account.eodSizesSessionStart,
      maxRiskPerTradeUsd: account.posture?.maxRiskPerTradeUsd ?? null,
      maxContracts: account.posture?.maxContracts ?? null,
    };
    return resolveSessionBudget(row, now);
  });
  const claim = priv.acquireContractLock.bind(engine);
  priv.acquireContractLock = (a, c, d, t) => {
    calls.push("acquire-lock");
    return claim(a, c, d, t);
  };
  const release = priv.releaseContractLock.bind(engine);
  const releases: Array<[number, string, string]> = [];
  priv.releaseContractLock = (a, c, d) => {
    calls.push("release-lock");
    releases.push([a, c, d]);
    release(a, c, d);
  };
  // What the entry answers; a test swaps the snapshot here, not on the mock.
  const entry = { preEntryOrderIds: [11], slCurrentPrice: null as number | null };
  const placeEntryOrder = vi
    .fn()
    .mockImplementation(
      async (): Promise<{ tradeId: number | null; preEntryOrderIds: number[]; slCurrentPrice: number | null }> => {
        calls.push("place-entry");
        return { tradeId: 77, preEntryOrderIds: entry.preEntryOrderIds, slCurrentPrice: entry.slCurrentPrice };
      },
    );
  priv.placeEntryOrder = placeEntryOrder;

  return { engine, priv, events, calls, releases, placeEntryOrder, account, entry };
}

/** Sync the leg in (which primes the group cache and the refusal set), then run
 *  one bar through the shipped tick path. */
async function tickOnce(
  engine: TradingEngine,
  priv: EnginePrivates,
  module: StrategyModule,
  depl: Deployment,
): Promise<void> {
  vi.mocked(getStrategy).mockReturnValue(module);
  engine.sync([depl]);
  await priv.processDeployment(module, depl);
}

/** The lock map's holder for this account and contract, or null. */
function lockHolder(priv: EnginePrivates): string | null {
  return [...priv.contractLocks.values()][0]?.deploymentId ?? null;
}

/**
 * `placeEntryOrder`'s fourteen positional arguments, named once.
 *
 * A test that wants one of them reaches for the name, not `calls[0][9]`: an
 * argument inserted into the signature fails the whole-call assertion loudly
 * and re-points a bare index at its neighbour silently.
 */
function entryArgs(placeEntryOrder: { mock: { calls: unknown[][] } }) {
  const [
    strategy,
    deployment,
    contract,
    side,
    params,
    tpTicks,
    slTicks,
    entryPrice,
    filterSnapshot,
    size,
    risk,
    signalBarTs,
    regime,
    sessionKey,
  ] = placeEntryOrder.mock.calls[0];
  return {
    strategy,
    deployment,
    contract,
    side,
    params,
    tpTicks,
    slTicks,
    entryPrice,
    filterSnapshot,
    size,
    risk,
    signalBarTs,
    regime,
    sessionKey,
  };
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

describe("processDeployment — the entry path", () => {
  it("gates on the account, claims the lock, sizes from the posture, then places the order", async () => {
    const { engine, priv, calls, placeEntryOrder } = makeEngine();
    const { module } = enteringStrategy();
    const depl = deployment(DEPL_A);

    await tickOnce(engine, priv, module, depl);

    // The order is the contract: both account reads feed the gate, the lock is
    // claimed before anything that can still refuse, and the posture is read
    // *inside* the lock — which is why every arm below has to release.
    expect(calls).toEqual([
      "realized-pnl",
      "daily-limits",
      "acquire-lock",
      "risk-posture",
      "place-entry",
    ]);
    expect(getAccountRealizedSinceGross).toHaveBeenCalledWith(
      ACCOUNT_ID,
      currentCmeSessionStart(NOON_ET),
    );
    expect(getAccountDailyPnlLimits).toHaveBeenCalledWith(ACCOUNT_ID);
    // The session's budget, not the flat field — and read on the tick's own
    // clock, because the sample only sizes the session `now` falls in.
    expect(resolveSessionPosture).toHaveBeenCalledWith(ACCOUNT_ID, NOON_ET);
    expect(placeEntryOrder).toHaveBeenCalledWith(
      module,
      depl,
      CONTRACT,
      0,
      expect.any(Object),
      TP_TICKS,
      SL_TICKS,
      LATEST_BAR.close,
      expect.objectContaining({ triggerBarTimestamp: LATEST_BAR.timestamp }),
      EXPECTED_CONTRACTS,
      // On phase `off` every phase fact is null and the budget is the flat
      // field, so the trade row records the same three numbers it always did.
      {
        maxRiskPerTradeUsd: 100,
        maxContracts: 10,
        riskPerContractUsd: RISK_PER_CONTRACT_USD,
        // No playbook settings: no cap, the full budget.
        appliedPlaybookMaxContracts: null,
        appliedPlaybookRiskPercent: 100,
        playbookBudgetUsd: 100,
        phase: "off",
        basis: "flat",
        headroomUsd: null,
        floorUsd: null,
        closeUsd: null,
        peakUsd: null,
        sizesSessionStart: null,
      },
      LATEST_BAR.timestamp,
      // The regime stamp is a diagnostic read over a database this file does
      // not wire up. Null rather than a throw is the guarantee: a missing
      // label must not turn a fillable entry into a tick failure.
      null,
      // This strategy emits no session key, so it opts out of the latch.
      undefined,
    );
    // Held, not released — the position is the engine's until it exits.
    expect(lockHolder(priv)).toBe(DEPL_A);
  });

  it("caps the count at the playbook's own limit and hands the facts to the trade row", async () => {
    const { engine, priv, placeEntryOrder } = makeEngine();
    const { module } = enteringStrategy();

    // The budget alone buys 4 (see EXPECTED_CONTRACTS); the playbook says 1.
    await tickOnce(engine, priv, module, deployment(DEPL_A, { paramValues: { playbookMaxContracts: 1 } }));

    const { size, risk } = entryArgs(placeEntryOrder);
    expect(size).toBe(1);
    expect(risk).toMatchObject({
      maxContracts: 10,
      appliedPlaybookMaxContracts: 1,
      appliedPlaybookRiskPercent: 100,
      playbookBudgetUsd: 100,
    });
  });

  it("writes the position the sizer decided, not the strategy's declared size", async () => {
    const { engine, priv } = makeEngine();
    const { module } = enteringStrategy();
    const depl = deployment(DEPL_A);

    await tickOnce(engine, priv, module, depl);

    const state = priv.getState(DEPL_A);
    expect(state.position).toMatchObject({
      side: 0,
      entryPrice: LATEST_BAR.close,
      size: EXPECTED_CONTRACTS,
      slTicks: SL_TICKS,
    });
    expect(state.activeTradeId).toBe(77);
    expect(state.preEntryOrderIds).toEqual([11]);
    expect(state.activeTpTicks).toBe(TP_TICKS);
    expect(state.activeSlTicks).toBe(SL_TICKS);
  });

  // The order row is where a restart rebuilds the one-per-side latch from
  // (A92), so the key has to reach it, not only the in-memory stash.
  it("hands the signal's session key to the order and stashes it for the fill", async () => {
    const { engine, priv, placeEntryOrder } = makeEngine();
    const { module } = enteringStrategy({ sessionKey: "2026-09-04" });

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(entryArgs(placeEntryOrder).sessionKey).toBe("2026-09-04");
    expect(priv.getState(DEPL_A).pendingEntrySessionKey).toBe("2026-09-04");
  });

  it("takes the posture's ceiling when the budget would afford more", async () => {
    const { engine, priv, placeEntryOrder, account } = makeEngine();
    // $1,000 affords 47 contracts at a $21.24 stop; the account's ceiling is 2.
    account.posture = { maxRiskPerTradeUsd: 1_000, maxContracts: 2 };
    const { module } = enteringStrategy();

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(entryArgs(placeEntryOrder).size).toBe(2);
  });

  // The gate is the account's, and it reads two rows to decide. Asserting the
  // refusal through the *real* evaluator is what makes both reads load-bearing:
  // a mocked gate would pass on either number being wrong.
  it("refuses the entry when the account's daily loss limit is already breached, before claiming the lock", async () => {
    const { engine, priv, calls, events, placeEntryOrder, account } = makeEngine();
    account.limits = {
      dailyMaxLossUsd: 500,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    };
    account.realizedGross = -500.01;
    const { module } = enteringStrategy();

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(calls).toEqual(["realized-pnl", "daily-limits"]);
    expect(placeEntryOrder).not.toHaveBeenCalled();
    expect(lockHolder(priv)).toBeNull();
    expect(events).not.toContain("entry_blocked");
  });

  it("enters when the same loss limit is one cent short of breached", async () => {
    const { engine, priv, placeEntryOrder, account } = makeEngine();
    account.limits = {
      dailyMaxLossUsd: 500,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    };
    account.realizedGross = -499.99;
    const { module } = enteringStrategy();

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(placeEntryOrder).toHaveBeenCalledTimes(1);
  });

  // The lock map is also what `hasOpenPositionOnContract` reads, so a contract
  // another deployment holds is refused one gate *above* the claim. What must
  // not happen either way is this leg touching the holder's lock.
  it("drops the signal and latches suppression while another deployment holds the contract", async () => {
    const { engine, priv, releases, placeEntryOrder } = makeEngine();
    const { module } = enteringStrategy();
    priv.acquireContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL, 4321);

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(placeEntryOrder).not.toHaveBeenCalled();
    expect(lockHolder(priv)).toBe(OTHER_DEPL);
    expect(releases).toEqual([]);
    expect(priv.getState(DEPL_A).signalSuppressed).toBe(true);
  });

  // The book models these three refusals (`REFUSALS` in backtest-book.ts); live
  // used to drop them at `debug` or say nothing, so the daily parity check
  // could not see a block live as the book does (A108). Each now writes one row
  // under the book's gate id and a line that survives prod.
  describe("the account's three refusals leave a skip row and a prod-visible line", () => {
    type Line = { event: string | null; severity: string; message: string };
    function captureLines(engine: TradingEngine): Line[] {
      const lines: Line[] = [];
      engine.setLogHandler((r) => void lines.push({ event: r.event, severity: r.severity, message: r.message }));
      return lines;
    }
    const skipRows = () => vi.mocked(insertSkippedSignal).mock.calls.map(([who, row]) => ({ who, row }));
    const holderModule = (module: StrategyModule) =>
      ({ ...module, config: { ...module.config, name: "Epsilon Close Break — MES" } }) as StrategyModule;

    it("records contract_held and names the holder by its app name when another deployment holds the contract", async () => {
      const { engine, priv, placeEntryOrder } = makeEngine();
      const lines = captureLines(engine);
      const { module } = enteringStrategy();
      priv.acquireContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL, 4321);
      vi.mocked(getDeployment).mockReturnValue(deployment(OTHER_DEPL, { strategyKey: "orcb-mes" }));
      vi.mocked(getStrategy).mockImplementation((key) => (key === "orcb-mes" ? holderModule(module) : module));
      engine.sync([deployment(DEPL_A)]);

      await priv.processDeployment(module, deployment(DEPL_A));

      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(priv.getState(DEPL_A).signalSuppressed).toBe(true);
      expect(skipRows()).toEqual([
        {
          who: expect.objectContaining({ deploymentId: DEPL_A, accountId: ACCOUNT_ID }),
          row: expect.objectContaining({
            gate: CONTRACT_HELD_GATE,
            source: "platform",
            signalBarTs: LATEST_BAR.timestamp,
            detail: { holderDeploymentId: OTHER_DEPL },
          }),
        },
      ]);
      expect(CONTRACT_HELD_GATE).toBe("contract_held");
      const held = lines.filter((l) => l.event === "entry_contract_locked");
      expect(held).toEqual([
        {
          event: "entry_contract_locked",
          severity: "info",
          message: "Entry signal dropped: /MNQ is held by deployment Epsilon Close Break — MES (depl-oth)",
        },
      ]);
    });

    it("still records contract_held, under the holder's short id, when the holder lookup throws", async () => {
      const { engine, priv, placeEntryOrder } = makeEngine();
      const lines = captureLines(engine);
      const { module } = enteringStrategy();
      priv.acquireContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL, 4321);
      // The holder's row only: the entry gate reads the leg's own row first.
      vi.mocked(getDeployment).mockImplementation((id) => {
        if (id === OTHER_DEPL) throw new Error("SQLITE_BUSY");
        return null;
      });
      vi.mocked(getStrategy).mockReturnValue(module);
      engine.sync([deployment(DEPL_A)]);

      await priv.processDeployment(module, deployment(DEPL_A));

      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(skipRows()).toEqual([
        expect.objectContaining({ row: expect.objectContaining({ gate: CONTRACT_HELD_GATE }) }),
      ]);
      expect(lines.filter((l) => l.event === "entry_contract_locked")).toEqual([
        expect.objectContaining({ message: "Entry signal dropped: /MNQ is held by deployment depl-oth" }),
      ]);
      expect(lines.some((l) => l.event === "deployment_tick_failed")).toBe(false);
    });

    it("records stale_latch when the latch is still set on a flat account", async () => {
      const { engine, priv, calls, placeEntryOrder } = makeEngine();
      const lines = captureLines(engine);
      const { module } = enteringStrategy();
      vi.mocked(getStrategy).mockReturnValue(module);
      engine.sync([deployment(DEPL_A)]);
      priv.getState(DEPL_A).signalSuppressed = true;

      await priv.processDeployment(module, deployment(DEPL_A));

      // Refused above the daily gate and the claim, as before.
      expect(calls).toEqual([]);
      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(priv.getState(DEPL_A).signalSuppressed).toBe(true);
      expect(skipRows().map(({ row }) => [row.gate, row.signalBarTs])).toEqual([
        [STALE_LATCH_GATE, LATEST_BAR.timestamp],
      ]);
      expect(STALE_LATCH_GATE).toBe("stale_latch");
      expect(lines.filter((l) => l.event === "entry_stale_signal").map((l) => l.severity)).toEqual(["info"]);
    });

    it("records daily_pnl with the numbers the gate tripped on", async () => {
      const { engine, priv, calls, placeEntryOrder, account } = makeEngine();
      const lines = captureLines(engine);
      account.limits = { dailyMaxLossUsd: 500, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false };
      account.realizedGross = -500.01;
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(calls).toEqual(["realized-pnl", "daily-limits"]);
      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(skipRows().map(({ row }) => row)).toEqual([
        expect.objectContaining({
          gate: DAILY_PNL_GATE,
          source: "platform",
          signalBarTs: LATEST_BAR.timestamp,
          reason: "the account's daily loss limit of $500.00 is reached (-$500.01 this session)",
          detail: { side: "loss", thresholdUsd: 500, effectivePnlUsd: -500.01 },
        }),
      ]);
      expect(DAILY_PNL_GATE).toBe("daily_pnl");
      expect(lines.filter((l) => l.event === "entry_daily_pnl_limit")).toEqual([
        {
          event: "entry_daily_pnl_limit",
          severity: "info",
          message:
            "[Entry Join] Entry signal dropped: the account's daily loss limit of $500.00 is reached (-$500.01 this session)",
        },
      ]);
    });

    it("writes nothing on a bare null, even with the contract held and the latch set, and clears the latch", async () => {
      const { engine, priv, events } = makeEngine();
      const { module, shouldEnter } = enteringStrategy();
      shouldEnter.mockReturnValue(null as unknown as EntrySignal);
      vi.mocked(getStrategy).mockReturnValue(module);
      engine.sync([deployment(DEPL_A)]);
      priv.acquireContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL, 4321);
      priv.getState(DEPL_A).signalSuppressed = true;

      await priv.processDeployment(module, deployment(DEPL_A));

      expect(insertSkippedSignal).not.toHaveBeenCalled();
      expect(events).not.toContain("entry_contract_locked");
      expect(events).not.toContain("entry_stale_signal");
      expect(priv.getState(DEPL_A).signalSuppressed).toBe(false);
    });

    // The latch's life, unchanged by the recording: set by the held contract,
    // held through a flat account until a bare null, then the next signal enters.
    it("leaves the latch's set, hold and clear exactly as they were", async () => {
      const { engine, priv, placeEntryOrder } = makeEngine();
      const { module, shouldEnter } = enteringStrategy();
      vi.mocked(getStrategy).mockReturnValue(module);
      engine.sync([deployment(DEPL_A)]);
      const nextBar = async () => {
        priv.getState(DEPL_A).lastBarTimestamp = null;
        await priv.processDeployment(module, deployment(DEPL_A));
      };

      priv.acquireContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL, 4321);
      await nextBar();
      priv.releaseContractLock(ACCOUNT_ID, CONTRACT.id, OTHER_DEPL);
      await nextBar();
      shouldEnter.mockReturnValueOnce(null as unknown as EntrySignal);
      await nextBar();
      expect(placeEntryOrder).not.toHaveBeenCalled();
      await nextBar();

      expect(skipRows().map(({ row }) => row.gate)).toEqual([CONTRACT_HELD_GATE, STALE_LATCH_GATE]);
      expect(placeEntryOrder).toHaveBeenCalledTimes(1);
    });
  });

  // The operator reads these lines in /logs and in the parity report, where a
  // key is a string the app never shows.
  describe("names a playbook in its log lines as the app does", () => {
    function captureMessages(engine: TradingEngine): Array<{ event: string | null; message: string }> {
      const lines: Array<{ event: string | null; message: string }> = [];
      engine.setLogHandler((record) => void lines.push({ event: record.event, message: record.message }));
      return lines;
    }

    it("prefixes a skipped entry with the module's name, not its key", async () => {
      const { engine, priv } = makeEngine();
      const lines = captureMessages(engine);
      const { module, shouldEnter } = enteringStrategy();
      shouldEnter.mockReturnValue({ skip: "range too wide", gate: "rangeTier" } as unknown as EntrySignal);

      await tickOnce(engine, priv, module, deployment(DEPL_A, { strategyKey: "entry-join-key" }));

      const skip = lines.find((l) => l.event === "entry_skipped");
      expect(skip?.message).toBe("[Entry Join] range too wide — gate:rangeTier");
    });

    it("names the holder of a locked contract by its module's name, and by its key when no module is loaded", async () => {
      const { engine, priv, placeEntryOrder } = makeEngine();
      const lines = captureMessages(engine);
      const { module } = enteringStrategy();
      const holder = { ...module, config: { ...module.config, name: "Epsilon Close Break — MES" } } as StrategyModule;
      const withHolder = (holderKey: string) => {
        // The lock is lost between the open-position read and the claim: the
        // race this line exists for, which a serial tick cannot reach.
        const p = priv as unknown as EnginePrivates & { getContractLockHolder(a: number, c: string): string | null };
        p.acquireContractLock = () => false;
        p.getContractLockHolder = () => "depl-holder-1942";
        vi.mocked(getDeployment).mockReturnValue(deployment("depl-holder-1942", { strategyKey: holderKey }));
      };

      withHolder("relay-mes-s05-or-break");
      vi.mocked(getStrategy).mockImplementation((key) => (key === "relay-mes-s05-or-break" ? holder : module));
      engine.sync([deployment(DEPL_A)]);
      await priv.processDeployment(module, deployment(DEPL_A));

      withHolder("retired-key");
      vi.mocked(getStrategy).mockImplementation((key) => (key === "retired-key" ? undefined : module));
      priv.getState(DEPL_A).lastBarTimestamp = null;
      await priv.processDeployment(module, deployment(DEPL_A));

      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(lines.filter((l) => l.event === "entry_contract_locked").map((l) => l.message)).toEqual([
        "Entry signal dropped: /MNQ is held by deployment Epsilon Close Break — MES (depl-hol)",
        "Entry signal dropped: /MNQ is held by deployment retired-key (depl-hol)",
      ]);
    });
  });

  describe("every arm that refuses after the claim gives the lock back", () => {
    it("releases it on an invalid slTicks", async () => {
      const { engine, priv, events, releases, placeEntryOrder } = makeEngine();
      const { module } = enteringStrategy({ slTicks: 0 });

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(events).toContain("entry_blocked");
      expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
      expect(lockHolder(priv)).toBeNull();
      expect(placeEntryOrder).not.toHaveBeenCalled();
    });

    it("releases it on an invalid tpTicks", async () => {
      const { engine, priv, events, releases, placeEntryOrder } = makeEngine();
      const { module } = enteringStrategy({ tpTicks: Number.NaN });

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(events).toContain("entry_blocked");
      expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
      expect(lockHolder(priv)).toBeNull();
      expect(placeEntryOrder).not.toHaveBeenCalled();
    });

    // No posture is the fresh-build case: the sizer throws rather than picking
    // a number, and the row is the only evidence a quiet staging session
    // leaves behind.
    it("releases it when the account has no risk posture, and records the skip", async () => {
      const { engine, priv, events, releases, placeEntryOrder, account } = makeEngine();
      account.posture = null;
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(events).toContain("entry_blocked");
      expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
      expect(lockHolder(priv)).toBeNull();
      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(insertSkippedSignal).toHaveBeenCalledWith(
        expect.objectContaining({ deploymentId: DEPL_A, accountId: ACCOUNT_ID }),
        expect.objectContaining({ gate: SIZE_RESOLUTION_GATE }),
      );
    });

    // A budget refusal is transient — the next setup's stop may fit — so it is
    // its own event and its own gate id, and the lock must not survive it or
    // the contract is poisoned for every later signal.
    it("releases it when one contract's stop does not fit the budget, and records the skip", async () => {
      const { engine, priv, events, releases, placeEntryOrder, account } = makeEngine();
      account.posture = { maxRiskPerTradeUsd: 21.23, maxContracts: 10 };
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(events).toContain("entry_risk_budget");
      expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
      expect(lockHolder(priv)).toBeNull();
      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(insertSkippedSignal).toHaveBeenCalledWith(
        expect.objectContaining({ deploymentId: DEPL_A }),
        expect.objectContaining({ gate: RISK_BUDGET_GATE }),
      );
    });

    // A playbook setting the sizer cannot use is a misconfiguration, not a
    // size: text the API would have converted, or a cap above the reviewed one.
    for (const [label, paramValues] of [
      ["a cap stored as text", { playbookMaxContracts: "1" }],
      ["a cap above the reviewed ceiling", { playbookMaxContracts: 4 }],
      ["a share of 0%", { playbookRiskPercent: 0 }],
      ["a cap stored as null", { playbookMaxContracts: null }],
      ["a share stored as null", { playbookRiskPercent: null }],
    ] as const) {
      it(`releases it on ${label}, and records the skip`, async () => {
        const { engine, priv, events, releases, placeEntryOrder } = makeEngine();
        const { module } = enteringStrategy();

        await tickOnce(engine, priv, module, deployment(DEPL_A, { paramValues: { ...paramValues } as Deployment["paramValues"] }));

        expect(events).toContain("entry_blocked");
        expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
        expect(placeEntryOrder).not.toHaveBeenCalled();
        expect(insertSkippedSignal).toHaveBeenCalledWith(
          expect.objectContaining({ deploymentId: DEPL_A }),
          expect.objectContaining({ gate: SIZE_RESOLUTION_GATE }),
        );
      });
    }

    it("releases it when the playbook's share leaves less than one contract — a skip, not a 1-lot", async () => {
      const { engine, priv, events, releases, placeEntryOrder } = makeEngine();
      const { module } = enteringStrategy();

      // $100 × 21% = $21.00 against one contract's $21.24.
      await tickOnce(engine, priv, module, deployment(DEPL_A, { paramValues: { playbookRiskPercent: 21 } }));

      expect(events).toContain("entry_risk_budget");
      expect(releases).toEqual([[ACCOUNT_ID, CONTRACT.id, DEPL_A]]);
      expect(placeEntryOrder).not.toHaveBeenCalled();
      expect(insertSkippedSignal).toHaveBeenCalledWith(
        expect.objectContaining({ deploymentId: DEPL_A }),
        expect.objectContaining({ gate: RISK_BUDGET_GATE }),
      );
    });

    // The fifth arm, and the only one whose release is not the engine's: a
    // rejected order releases inside `placeEntryOrder` (engine-order.ts, both
    // the pre-insert and the placeOrder catch) and rethrows. What this pins is
    // the caller's half — it does not release a second time, and it writes no
    // position state for an entry that never opened.
    it("leaves the release to placeEntryOrder when the order throws, and opens no position", async () => {
      const { engine, priv, calls, releases, placeEntryOrder } = makeEngine();
      // `mockRejectedValue` would replace the factory's implementation and with
      // it the recorder push — the hazard patterns.md names one rule above, and
      // the reason this arm needs an implementation rather than a value.
      placeEntryOrder.mockImplementation(async () => {
        calls.push("place-entry");
        throw new Error("Topstep API error 400: RiskExceeded");
      });
      const { module } = enteringStrategy();

      await expect(tickOnce(engine, priv, module, deployment(DEPL_A))).resolves.toBeUndefined();

      // Both assertions below — no release, no position — are equally true of
      // every arm that refuses *before* the claim, so the order is what says
      // the throw is the thing being tested rather than an upstream gate.
      expect(calls).toEqual([
        "realized-pnl",
        "daily-limits",
        "acquire-lock",
        "risk-posture",
        "place-entry",
      ]);
      expect(placeEntryOrder).toHaveBeenCalledTimes(1);
      expect(releases).toEqual([]);
      const state = priv.getState(DEPL_A);
      expect(state.position).toBeNull();
      expect(state.activeTradeId).toBeNull();
    });
  });

  // The phase's half of the same join. `off` is covered by every case above —
  // the row's flat pair reaches the sizer unchanged — so what is left is a row
  // the operator has opted in, which sizes from a close the app records for
  // itself and falls to the phase's floor when it has none.
  describe("the session's phase budget", () => {
    /** A 50K combine with the ceiling the form asks for, and no close on
     *  record — the state every opted-in account is in until the sampler has
     *  run once through a session gap. */
    function combineWithNoSample(account: ReturnType<typeof makeEngine>["account"]): void {
      account.phase = "combine";
      account.mllUsd = 2_000;
      account.startBalanceUsd = 50_000;
      account.posture = { maxRiskPerTradeUsd: 500, maxContracts: 10 };
    }

    it("sizes a combine with no close on record at the phase's lowest budget, and says so once", async () => {
      const { engine, priv, events, placeEntryOrder, account } = makeEngine();
      combineWithNoSample(account);
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      // $225, not the $500 ceiling on the form: an unknown state never sizes up.
      expect(entryArgs(placeEntryOrder).risk).toEqual({
        maxRiskPerTradeUsd: 225,
        maxContracts: 10,
        riskPerContractUsd: RISK_PER_CONTRACT_USD,
        appliedPlaybookMaxContracts: null,
        appliedPlaybookRiskPercent: 100,
        playbookBudgetUsd: 225,
        phase: "combine",
        basis: "stale_floor",
        headroomUsd: null,
        floorUsd: null,
        closeUsd: null,
        peakUsd: null,
        sizesSessionStart: null,
      });
      expect(events.filter((e) => e === "risk_phase_stale")).toHaveLength(1);
    });

    it("scales the phase's budget by the playbook's share, not the form's ceiling", async () => {
      const { engine, priv, placeEntryOrder, account } = makeEngine();
      combineWithNoSample(account);
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A, { paramValues: { playbookRiskPercent: 50 } }));

      // $225 × 50% = $112.50; floor($112.50 / $21.24) = 5.
      const { size, risk } = entryArgs(placeEntryOrder);
      expect(size).toBe(5);
      expect(risk).toMatchObject({ maxRiskPerTradeUsd: 225, appliedPlaybookRiskPercent: 50, playbookBudgetUsd: 112.5 });
    });

    it("does not repeat the warning on a second entry in the same session", async () => {
      const { engine, priv, events, placeEntryOrder, account } = makeEngine();
      combineWithNoSample(account);
      const { module } = enteringStrategy();
      const depl = deployment(DEPL_A);

      await tickOnce(engine, priv, module, depl);
      // What a closed trade on the next bar leaves behind: the mirror is torn
      // down, the contract lock is given back, and the bar-dedup anchor has
      // moved on — so the second tick reaches the sizer rather than returning
      // at the already-evaluated-this-bar guard.
      const state = priv.getState(DEPL_A);
      state.position = null;
      state.activeTradeId = null;
      state.lastBarTimestamp = null;
      priv.releaseContractLock(ACCOUNT_ID, CONTRACT.id, DEPL_A);

      await tickOnce(engine, priv, module, depl);

      expect(placeEntryOrder).toHaveBeenCalledTimes(2);
      expect(events.filter((e) => e === "risk_phase_stale")).toHaveLength(1);
    });

    it("says nothing about the phase on an `off` account", async () => {
      const { engine, priv, events } = makeEngine();
      const { module } = enteringStrategy();

      await tickOnce(engine, priv, module, deployment(DEPL_A));

      expect(events).not.toContain("risk_phase_stale");
    });
  });
});

/**
 * A119: a failed pre-entry snapshot is a marked `[]` that the exit's stage-2
 * cancel tells apart from an empty book by identity (`isFailedPreEntrySnapshot`
 * over a WeakSet). The mark survives only if nothing between `placeEntryOrder`
 * and the exit copies the array; the exit reads the same `this.state` map this
 * asserts on (`stateMap` in the exit deps), so identity here is identity there.
 */
describe("processDeployment — the stop the placement reports becomes the mirror's reference stop", () => {
  // `placeEntryOrder` is stubbed here, so what these pin is the threading in
  // `processDeployment`, not the fast path's arithmetic (engine-order.test.ts
  // pins that). Deleting the store line brought back the wave 4 C1 Critical
  // on Tradovate with every other test green, which is why it has its own.
  it("stores the SL price a sync-attributed placement returns", async () => {
    const { engine, priv, entry } = makeEngine();
    const { module } = enteringStrategy();
    const depl = deployment(DEPL_A);
    entry.slCurrentPrice = LATEST_BAR.close - SL_TICKS * CONTRACT.tickSize;

    await tickOnce(engine, priv, module, depl);

    expect(priv.getState(DEPL_A).slCurrentPrice).toBe(21_005 - 10);
  });

  it("clears a stale stop when the placement reports none, so the previous trade's stop cannot be compared against", async () => {
    const { engine, priv, entry } = makeEngine();
    const { module } = enteringStrategy();
    const depl = deployment(DEPL_A);
    engine.sync([depl]);
    priv.getState(DEPL_A).slCurrentPrice = 20_950;
    entry.slCurrentPrice = null;

    await tickOnce(engine, priv, module, depl);

    expect(priv.getState(DEPL_A).slCurrentPrice).toBeNull();
  });
});

describe("processDeployment — a failed pre-entry snapshot reaches the exit marked", () => {
  it("stores the entry's marked array itself on the deployment state, not a copy", async () => {
    const { engine, priv, entry } = makeEngine();
    const { module } = enteringStrategy();
    entry.preEntryOrderIds = failedPreEntrySnapshot();

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    const stored = priv.getState(DEPL_A).preEntryOrderIds;
    expect(stored).toBe(entry.preEntryOrderIds);
    expect(isFailedPreEntrySnapshot(stored)).toBe(true);
  });

  it("does not mark an empty book the entry read successfully", async () => {
    const { engine, priv, entry } = makeEngine();
    const { module } = enteringStrategy();
    entry.preEntryOrderIds = [];

    await tickOnce(engine, priv, module, deployment(DEPL_A));

    expect(isFailedPreEntrySnapshot(priv.getState(DEPL_A).preEntryOrderIds)).toBe(false);
  });
});
