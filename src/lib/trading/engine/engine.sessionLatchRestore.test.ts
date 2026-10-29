/**
 * The one-per-side latch across a restart (bugs.md A92).
 *
 * The latch is in memory and the strategy reads it through
 * `ctx.hasEnteredThisSession`, so a restart used to hand a playbook a clean
 * slate halfway through its session. The defect lives between the engine and
 * the trade table — the entry writes the key, a later process reads it back —
 * so the real `@/lib/db/trades` runs here against an in-memory database, and
 * the first engine's entry goes through the shipped `placeEntryOrder`. Only
 * the broker and the rows this file is not about are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: Database.Database) => void>,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/db/engine-restart", () => ({
  stampEngineHeartbeat: vi.fn(),
  markHeartbeatDegraded: vi.fn(),
  setPendingFlatten: vi.fn(),
  markCleanShutdown: vi.fn(),
  consumeCleanShutdownMarker: vi.fn(() => null),
  consumeHeartbeatDegradedMarker: vi.fn(() => null),
  readEngineRestartState: vi.fn(() => ({
    lastSeenAt: null,
    cleanShutdownAt: null,
    resumeCycles: [],
    pendingFlatten: { entries: [], gapMs: 0 },
  })),
  recordUncleanResume: vi.fn(() => 1),
}));

// This process holds the engine lease; the refusal is pinned in
// `engine.restartVerdict.test.ts`.
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

// `BrokerKind` is a string const enum that does not inline under this
// transpiler (patterns.md); the posture is the flat pair, so the sizer is real.
vi.mock("@/lib/db/account-brokers", () => ({
  getAccountDeployState: vi.fn().mockReturnValue(null),
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  resolveSessionPosture: vi.fn(() => ({
    posture: { maxRiskPerTradeUsd: 100, maxContracts: 1 },
    phase: "off",
    basis: "flat",
    headroomUsd: null,
    floorUsd: null,
    closeUsd: null,
    peakUsd: null,
    sizesSessionStart: null,
  })),
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
import type { BarData, Contract, Order, OrderSide } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";
import type { EntrySignal, OpenPosition, StrategyContext, StrategyModule } from "../strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "../strategy-types";
import { listGroups } from "@/lib/db/deployment-groups";
import { getStrategy } from "../strategies";
import {
  closeTrade,
  getTradeById,
  insertPendingEntry,
  markEntryFailed,
  markEntryFilled,
} from "@/lib/db/trades";
import { resetLogBursts } from "@/lib/logging/pipe";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPL_A = "depl-a";
const DEPL_B = "depl-b";
const GROUP_ID = "grp-1";
const ACCOUNT_ID = 90063379;
const TICKER = "/MNQ" as TickerSymbol;
const LONG: OrderSide = 0;
const SHORT: OrderSide = 1;

/** 12:00 ET on Friday 2026-10-09 — the bug's scenario: a long filled at 11:19
 *  and stopped at 11:40, and the engine restarts at noon, inside the main
 *  session. */
const NOON_ET = new Date("2026-10-09T16:00:00.000Z");
const TODAY = "2026-10-09";
const YESTERDAY = "2026-10-08";
const FILLED_AT = "2026-10-09T15:19:00.000Z";
const STOPPED_AT = "2026-10-09T15:40:00.000Z";

const CONTRACT = {
  id: "CON.F.US.MNQ.Z26",
  name: "MNQZ6",
  description: "Micro E-mini Nasdaq",
  tickSize: 0.25,
  tickValue: 0.5,
  activeContract: true,
  symbolId: "F.US.MNQ",
} satisfies Contract;

const SL_TICKS = 40;
const TP_TICKS = 80;

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
    strategyKey: "latch-reader",
    status: "Active",
    paramValues: {},
    groupId: GROUP_ID,
  } as Deployment;
}

function group(id: string): DeploymentGroup {
  return {
    id,
    name: "Latch",
    strategyKey: "latch-reader",
    paramValues: {},
    ticker: TICKER,
    contractId: null,
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  } as DeploymentGroup;
}

/** Thirty 5m bars ending five minutes before `end`. */
function bars(end: Date): BarData[] {
  const out: BarData[] = [];
  for (let i = 30; i > 0; i--) {
    out.push({
      timestamp: new Date(end.getTime() - i * 5 * 60_000).toISOString(),
      open: 21_000,
      high: 21_010,
      low: 20_990,
      close: 21_005,
      volume: 500,
    });
  }
  return out;
}

/**
 * A module whose setup stays armed after it trades — a pullback fade's rule
 * 10 — and which leaves one-per-side to the latch, as its rule 12 does.
 * It fires on every bar unless the latch says the side is taken.
 */
function armedSetup(side: OrderSide, sessionKey = TODAY): StrategyModule {
  return {
    version: "1.0.0",
    params: withCommonParams({}),
    config: {
      name: "Latch reader",
      timeframe: "5m",
      session: LEGACY_DAY_SESSION,
      size: 1,
      entryType: 2,
      indicators: [],
    },
    buildIndicators: () => [],
    shouldEnter: (ctx: StrategyContext): EntrySignal | null =>
      ctx.hasEnteredThisSession(sessionKey, side)
        ? null
        : { side, slTicks: SL_TICKS, tpTicks: TP_TICKS, sessionKey },
    shouldExit: () => false,
  } as unknown as StrategyModule;
}

type EnginePrivates = {
  fetchBars(contract: Contract, timeframe: string, depth: number): Promise<BarData[]>;
  getState(deploymentId: string): DeploymentState;
  brokerForAccount(accountId: number): unknown;
  processDeployment(strategy: StrategyModule, deployment: Deployment): Promise<void>;
  resolver: { resolve(ticker: string, accountId: number): Promise<Contract> };
  handleUserPositionEvent(payload: {
    accountId: number;
    contractId: string;
    size: number;
    averagePrice: number;
    creationTimestamp: string;
  }): Promise<void>;
  reconcileOneTrade(
    trade: StrategyTrade,
    accountId: number,
    openOrders: Order[],
    openOrderIds: Set<number>,
    positionsByContract: Map<string, { size: number; avgPrice: number }>,
  ): Promise<void>;
  modifyStopLossToPrice(
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    tradeId: number | null,
    targetPrice: number,
    marketPrice: number | null,
    storedStopPrice: number | null,
    label: string,
  ): Promise<number>;
};

/** A fresh process: new engine, nothing in memory, the same database. */
function bootEngine() {
  const registry = new BrokerRegistry();
  registry.register(pluginStub("topstep"));
  const engine = new TradingEngine(
    new TopstepClient("http://localhost:0"),
    new TradovateClient("http://localhost:0"),
    null,
    registry,
  );
  const priv = engine as unknown as EnginePrivates;
  const lines: Array<{ level: string; message: string; event: string | null | undefined }> = [];
  engine.setLogHandler(
    (record) => void lines.push({ level: record.level, message: record.message, event: record.event }),
  );
  priv.resolver.resolve = vi.fn().mockResolvedValue(CONTRACT);
  priv.fetchBars = vi.fn(async () => bars(new Date(Date.now())));
  const broker = {
    searchOpenOrders: vi.fn().mockResolvedValue([]),
    searchOpenPositions: vi.fn().mockResolvedValue([]),
    searchTrades: vi.fn().mockResolvedValue([]),
    placeOrder: vi
      .fn()
      .mockResolvedValue({ orderId: 501, success: true, errorCode: 0, errorMessage: null }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    modifyOrder: vi.fn().mockResolvedValue(undefined),
  };
  priv.brokerForAccount = () => broker;
  return { engine, priv, broker, lines };
}

/** Sync the leg in, then run one bar through the shipped tick path. */
async function tick(
  engine: TradingEngine,
  priv: EnginePrivates,
  module: StrategyModule,
  depl: Deployment,
): Promise<void> {
  vi.mocked(getStrategy).mockReturnValue(module);
  engine.sync([depl]);
  await priv.processDeployment(module, depl);
}

/** A row in the state the live fill paths leave it in. */
function tradedRow(opts: {
  deploymentId?: string;
  side: OrderSide;
  sessionKey: string;
  submittedAt?: string;
  outcome: "closed" | "open" | "pending" | "cancelled";
}): number {
  const id = insertPendingEntry({
    deploymentId: opts.deploymentId ?? DEPL_A,
    strategyKey: "latch-reader",
    accountId: ACCOUNT_ID,
    ticker: TICKER,
    contractId: CONTRACT.id,
    side: opts.side,
    size: 1,
    entryOrderId: null,
    entrySubmittedAt: opts.submittedAt ?? FILLED_AT,
    sessionKey: opts.sessionKey,
  });
  if (opts.outcome === "cancelled") markEntryFailed(id, "entry_not_filled");
  if (opts.outcome === "open" || opts.outcome === "closed") markEntryFilled(id, 21_000, FILLED_AT);
  if (opts.outcome === "closed") {
    closeTrade({ tradeId: id, exitPrice: 20_990, exitFilledAt: STOPPED_AT, pnlTicks: -40, pnlDollars: -20 });
  }
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOON_ET);
  resetLogBursts();
  db = new Database(":memory:");
  for (const m of migrations) m(db);
  vi.mocked(listGroups).mockReturnValue([group(GROUP_ID)]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The scenario ─────────────────────────────────────────────────────────────

describe("the one-per-side latch across a restart", () => {
  it("takes no second entry on a side that filled before the restart, in the same session", async () => {
    // Before the restart: the long fires through the shipped entry path,
    // which is what writes the key to the row, and then fills and stops out
    // the way the fill paths record it.
    vi.setSystemTime(new Date(FILLED_AT));
    const before = bootEngine();
    await tick(before.engine, before.priv, armedSetup(LONG), deployment(DEPL_A));
    expect(before.broker.placeOrder).toHaveBeenCalledTimes(1);
    const tradeId = before.priv.getState(DEPL_A).activeTradeId;
    expect(tradeId).not.toBeNull();
    markEntryFilled(tradeId!, 21_000, FILLED_AT);
    closeTrade({ tradeId: tradeId!, exitPrice: 20_990, exitFilledAt: STOPPED_AT, pnlTicks: -40, pnlDollars: -20 });

    // The restart, and a later trigger with the setup still armed.
    vi.setSystemTime(NOON_ET);
    const after = bootEngine();
    await tick(after.engine, after.priv, armedSetup(LONG), deployment(DEPL_A));

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
    expect(after.broker.placeOrder).not.toHaveBeenCalled();
  });

  it("still enters the opposite side after the restart", async () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "closed" });
    const after = bootEngine();

    await tick(after.engine, after.priv, armedSetup(SHORT), deployment(DEPL_A));

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, SHORT)).toBe(false);
    expect(after.broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("does not cap today's session with a fill from the previous one", async () => {
    tradedRow({ side: LONG, sessionKey: YESTERDAY, submittedAt: "2026-10-08T15:19:00.000Z", outcome: "closed" });
    const after = bootEngine();

    await tick(after.engine, after.priv, armedSetup(LONG), deployment(DEPL_A));

    expect(after.engine.hasEnteredThisSession(DEPL_A, YESTERDAY, LONG)).toBe(true);
    expect(after.broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("does not cap the side with an order that was cancelled before it filled", async () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "cancelled" });
    const after = bootEngine();

    await tick(after.engine, after.priv, armedSetup(LONG), deployment(DEPL_A));

    expect(after.broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  // The live latch is set on the fill, so a pending order at the restart has
  // not latched. The open row blocks a second entry on its own, so this reads
  // the latch directly rather than through an entry.
  it("does not latch an order that was still pending at the restart", () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "pending" });
    const after = bootEngine();

    after.engine.sync([deployment(DEPL_A)]);

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(false);
  });

  it("latches a fill that was still open at the restart", () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "open" });
    const after = bootEngine();

    after.engine.sync([deployment(DEPL_A)]);

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
  });

  it("rebuilds per deployment: another deployment's fill does not cap this one", async () => {
    tradedRow({ deploymentId: DEPL_B, side: LONG, sessionKey: TODAY, outcome: "closed" });
    const after = bootEngine();

    await tick(after.engine, after.priv, armedSetup(LONG), deployment(DEPL_A));

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(false);
    expect(after.broker.placeOrder).toHaveBeenCalledTimes(1);
  });
});

// ── An entry in flight across the restart ────────────────────────────────────

/**
 * The first process submits a long through the shipped entry path and the
 * restart lands before the fill: the row is `pending_entry`, and the new
 * process has neither the stashed key nor the trade as its `activeTradeId`.
 */
async function longPendingAcrossRestart() {
  vi.setSystemTime(new Date(FILLED_AT));
  const before = bootEngine();
  await tick(before.engine, before.priv, armedSetup(LONG), deployment(DEPL_A));
  const tradeId = before.priv.getState(DEPL_A).activeTradeId;
  expect(tradeId).not.toBeNull();
  expect(getTradeById(tradeId!)?.status).toBe("pending_entry");

  const after = bootEngine();
  after.engine.sync([deployment(DEPL_A)]);
  expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(false);
  return { after, tradeId: tradeId! };
}

/** The filled long stops out, and the armed setup triggers again at noon. */
async function stopThenRetrigger(after: ReturnType<typeof bootEngine>, tradeId: number) {
  expect(getTradeById(tradeId)?.status).toBe("open");
  closeTrade({ tradeId, exitPrice: 20_990, exitFilledAt: STOPPED_AT, pnlTicks: -40, pnlDollars: -20 });
  vi.setSystemTime(NOON_ET);
  await tick(after.engine, after.priv, armedSetup(LONG), deployment(DEPL_A));
}

describe("an entry pending at the restart that fills afterwards", () => {
  it("latches from the row's key when the user hub reports the fill", async () => {
    const { after, tradeId } = await longPendingAcrossRestart();

    await after.priv.handleUserPositionEvent({
      accountId: ACCOUNT_ID,
      contractId: CONTRACT.id,
      size: 1,
      averagePrice: 21_000,
      creationTimestamp: FILLED_AT,
    });
    await stopThenRetrigger(after, tradeId);

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
    expect(after.broker.placeOrder).not.toHaveBeenCalled();
  });

  it("latches from the row's key when the reconciler finds the fill", async () => {
    const { after, tradeId } = await longPendingAcrossRestart();

    await after.priv.reconcileOneTrade(
      getTradeById(tradeId)!,
      ACCOUNT_ID,
      [],
      new Set(),
      new Map([[CONTRACT.id, { size: 1, avgPrice: 21_000 }]]),
    );
    await stopThenRetrigger(after, tradeId);

    expect(after.engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
    expect(after.broker.placeOrder).not.toHaveBeenCalled();
  });
});

// ── Its brackets ─────────────────────────────────────────────────────────────

/**
 * The same entry, and the question the restart leaves on it: the pre-entry
 * snapshot attribution diffs against lived in the first process, so the new
 * one has none. Attribution is then a no-op by design (engine-realtime.md,
 * *Bracket attribution*): the row stays `open` with no bracket ids, and the
 * stop is found by the heuristic in `modifyStopLossToPrice` when it moves.
 * Zero-downtime deploys, step 1 case 2.
 */
describe("an entry pending at the restart that fills during the gap: its brackets", () => {
  const TP_ID = 7001;
  const SL_ID = 7002;
  const SL_PRICE = 21_000 - SL_TICKS * CONTRACT.tickSize;
  const leg = (id: number, type: 1 | 4, price: number): Order =>
    ({
      id,
      accountId: ACCOUNT_ID,
      contractId: CONTRACT.id,
      creationTimestamp: FILLED_AT,
      updateTimestamp: FILLED_AT,
      status: 1,
      type,
      side: SHORT,
      size: 1,
      limitPrice: type === 1 ? price : null,
      stopPrice: type === 4 ? price : null,
      filledPrice: null,
    }) satisfies Order;
  /** The pair the broker hung on the fill while no engine was running. */
  const bracketPair = (): Order[] => [leg(TP_ID, 1, 21_000 + TP_TICKS * CONTRACT.tickSize), leg(SL_ID, 4, SL_PRICE)];
  const held = () => new Map([[CONTRACT.id, { size: 1, avgPrice: 21_000 }]]);

  /** Two reconciler passes on the new process: the promotion, then the `open` row. */
  async function filledDuringGap() {
    const { after, tradeId } = await longPendingAcrossRestart();
    after.broker.searchOpenOrders.mockResolvedValue(bracketPair());
    after.broker.searchOpenPositions.mockResolvedValue([{ contractId: CONTRACT.id, size: 1 }]);
    const openIds = new Set([TP_ID, SL_ID]);

    await after.priv.reconcileOneTrade(getTradeById(tradeId)!, ACCOUNT_ID, bracketPair(), openIds, held());
    expect(getTradeById(tradeId)?.status).toBe("open");
    await after.priv.reconcileOneTrade(getTradeById(tradeId)!, ACCOUNT_ID, bracketPair(), openIds, held());
    return { after, tradeId };
  }

  it("saves no bracket ids, starts no recovery and cancels nothing", async () => {
    const { after, tradeId } = await filledDuringGap();

    const row = getTradeById(tradeId)!;
    expect(row.tpOrderId).toBeNull();
    expect(row.slOrderId).toBeNull();
    const events = after.lines.map((l) => l.event);
    expect(events).not.toContain("bracket_ids_attributed");
    expect(events).not.toContain("bracket_recovery_started");
    expect(after.broker.cancelOrder).not.toHaveBeenCalled();
  });

  it("places no second bracket pair", async () => {
    const { after } = await filledDuringGap();

    expect(after.broker.placeOrder).not.toHaveBeenCalled();
  });

  it("still moves the stop, finding the leg without an slOrderId", async () => {
    const { after, tradeId } = await filledDuringGap();
    const position = { side: LONG, entryPrice: 21_000 } as OpenPosition;

    const sent = await after.priv.modifyStopLossToPrice(
      deployment(DEPL_A),
      CONTRACT,
      position,
      tradeId,
      21_000,
      21_010,
      null,
      "Breakeven",
    );

    expect(sent).toBe(21_000);
    expect(after.broker.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, SL_ID, { stopPrice: 21_000 });
  });
});

// ── A read that fails ────────────────────────────────────────────────────────

/** The same database, except the latch read throws — the rest of the tick
 *  still has to work, or the test cannot tell fail-closed from a crash. */
function latchReadFails(real: InstanceType<typeof Database>): InstanceType<typeof Database> {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("session_key IS NOT NULL")) throw new Error("database is locked");
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const FIVE_MINUTES_MS = 5 * 60_000;

describe("a latch read that fails", () => {
  it("takes no entry until the rows are read, and says so once, not on every tick", async () => {
    db = latchReadFails(db);
    const { engine, priv, broker, lines } = bootEngine();

    await tick(engine, priv, armedSetup(LONG), deployment(DEPL_A));
    vi.setSystemTime(new Date(NOON_ET.getTime() + FIVE_MINUTES_MS));
    await priv.processDeployment(armedSetup(LONG), deployment(DEPL_A));

    expect(broker.placeOrder).not.toHaveBeenCalled();
    const failures = lines.filter((l) => l.message.includes("already traded this session"));
    expect(failures.map((l) => l.level)).toEqual(["error"]);
  });

  // Sync runs only when the deployment set changes, so a tick is what
  // retries; no sync happens between the failure and the recovery here.
  it("reads the rows on a later tick with no sync, and enters again", async () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "closed" });
    const healthy = db;
    db = latchReadFails(healthy);
    const { engine, priv, broker, lines } = bootEngine();
    engine.sync([deployment(DEPL_A)]);
    expect(engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(false);

    db = healthy;
    await priv.processDeployment(armedSetup(SHORT), deployment(DEPL_A));

    expect(engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
    expect(broker.placeOrder).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.level === "info" && l.message.includes("takes new trades again"))).toBe(true);
  });
});

// ── Both doors ───────────────────────────────────────────────────────────────

describe("where the latch is rebuilt", () => {
  it("rebuilds at start(), before the first tick can evaluate", () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "closed" });
    const { engine } = bootEngine();
    try {
      engine.start([deployment(DEPL_A)]);
      expect(engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
    } finally {
      engine.stop();
    }
  });

  // A leg paused across the restart and resumed at noon reaches the engine
  // through a sync, not through start().
  it("rebuilds a leg that joins on a later sync", () => {
    tradedRow({ deploymentId: DEPL_B, side: SHORT, sessionKey: TODAY, outcome: "closed" });
    const { engine } = bootEngine();

    engine.sync([deployment(DEPL_A)]);
    expect(engine.hasEnteredThisSession(DEPL_B, TODAY, SHORT)).toBe(false);
    engine.sync([deployment(DEPL_A), deployment(DEPL_B)]);

    expect(engine.hasEnteredThisSession(DEPL_B, TODAY, SHORT)).toBe(true);
  });

  it("says so at error when the rows cannot be read, and reads them on the next sync", () => {
    tradedRow({ side: LONG, sessionKey: TODAY, outcome: "closed" });
    const healthy = db;
    const { engine, lines } = bootEngine();

    db = new Database(":memory:");
    engine.sync([deployment(DEPL_A)]);
    const failure = lines.find((l) => l.message.includes("already traded this session"));
    expect(failure?.level).toBe("error");
    expect(engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(false);

    db = healthy;
    engine.sync([deployment(DEPL_A)]);
    expect(engine.hasEnteredThisSession(DEPL_A, TODAY, LONG)).toBe(true);
  });
});
