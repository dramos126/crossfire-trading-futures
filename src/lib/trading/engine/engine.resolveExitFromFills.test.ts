/**
 * Integration-style tests for TradingEngine.resolveExitFromFills (private).
 *
 * Access pattern: (engine as any).resolveExitFromFills(trade, accountId).
 *
 * Isolation: the broker registry's private maps are populated directly so
 * brokerKindFor() and brokerForAccount() never fall through to the DB layer.
 * searchTrades is replaced with vi.fn() per test. No DB is opened.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock every DB module before engine.ts is imported so that any accidental
// module-level call that reaches getDb() uses an in-memory stub rather than
// opening a real SQLite file.
vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// Silence Discord alert calls that fire inside maybeOrphanFromTradovateError
// and other paths touched by the error branch.
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

// DB modules: stub exported functions that engine.ts or its transitive deps call.
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
  findTradeByAccountContract: vi.fn(),
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
vi.mock("@/lib/db/deployment-groups", () => ({ getGroup: vi.fn() }));
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

// Strategies use webpack's require.context which isn't available in vitest.
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

import { TradingEngine } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import { healApproximatedExit } from "@/lib/db/trades";
import type { TradeFill } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_TOPSTEP = 1001;
const ACCOUNT_TRADOVATE = 2001;

/** Minimal StrategyTrade with sensible defaults for /NQ futures. */
function makeTrade(overrides: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    id: 1,
    deploymentId: "test-deploy",
    strategyKey: "test",
    accountId: ACCOUNT_TOPSTEP,
    ticker: "/NQ",
    contractId: "NQ-2025",
    side: 0, // long
    size: 1,
    entryOrderId: 999,
    entryPrice: 20000,
    entryFilledAt: "2025-06-01T14:30:00.000Z",
    entrySubmittedAt: "2025-06-01T14:29:59.000Z",
    signalBarTs: "2025-06-01T14:25:00.000Z",
    regimeLabel: null,
    regimeClassifierVersion: null,
    sessionKey: null,
    tpOrderId: null,
    slOrderId: null,
    exitOrderId: null,
    exitPrice: null,
    exitFilledAt: null,
    exitSubmittedAt: null,
    exitReason: null,
    exitReasonCode: null,
    breakEvenMoved: false,
    slMovedToBreakeven: false,
    slTrailEngaged: false,
    pnlTicks: null,
    pnlDollars: null,
    feesDollars: null,
    tickSize: 0.25,
    tickValue: 12.5,
    status: "open",
    createdAt: "2025-06-01T14:29:59.000Z",
    updatedAt: "2025-06-01T14:30:00.000Z",
    desiredEntryPrice: null,
    entrySlippageTicks: null,
    entrySlippageDollars: null,
    desiredTpPrice: null,
    tpSlippageTicks: null,
    tpSlippageDollars: null,
    desiredSlPrice: null,
    slSlippageTicks: null,
    slSlippageDollars: null,
    desiredTpTicks: null,
    desiredSlTicks: null,
    exitApproximated: false,
    exitResolutionSource: null,
    exitDetectedAt: null,
    paramSnapshot: null,
    filterSnapshot: null,
    replayResultJson: null,
    engineSessionId: null,
    deploymentVersionId: null,
    ...overrides,
  };
}

/** Minimal TradeFill. Side 1 = Sell (closing a long). */
function makeFill(overrides: Partial<TradeFill> = {}): TradeFill {
  return {
    id: 1,
    accountId: ACCOUNT_TOPSTEP,
    contractId: "NQ-2025",
    creationTimestamp: "2025-06-01T15:00:00.000Z", // post-entry
    price: 20100,
    profitAndLoss: null,
    fees: null,
    side: 1, // sell — closes a long
    size: 1,
    voided: false,
    orderId: 555,
    ...overrides,
  };
}

/** Build an engine and wire accountId into the broker registry internals
 *  so brokerKindFor() and brokerForAccount() work without a DB call.
 *  Returns the engine, searchTrades mock, and getFillsForOrder mock for assertion. */
function makeEngine(accountId: number, brokerKind: "topstep" | "tradovate") {
  const searchTrades = vi.fn<(accountId: number, startTimestamp: string, endTimestamp?: string) => Promise<TradeFill[]>>();
  const getFillsForOrder = vi.fn<(orderId: number, accountId: number) => Promise<TradeFill[]>>().mockResolvedValue([]);

  const brokerStub = {
    searchTrades,
    getFillsForOrder,
    searchAccounts: vi.fn(),
    searchOpenOrders: vi.fn(),
    searchOpenPositions: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    modifyOrder: vi.fn(),
    invalidateOpenOrders: vi.fn(),
  };

  const topstepClient = new TopstepClient("http://localhost:0");
  const tradovateClient = new TradovateClient("http://localhost:0");

  const engine = new TradingEngine(topstepClient, tradovateClient, null);

  // Inject the stub broker and kind tag directly into the registry's private
  // maps so neither get() nor brokerKind() reach the DB.
  const registry = (engine as any).brokerRegistry;
  registry.map.set(accountId, brokerStub);
  registry.brokerByAccount.set(accountId, brokerKind);

  return { engine, searchTrades, getFillsForOrder };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("resolveExitFromFills", () => {
  // ── Test 8: entryFilledAt is null → always returns null ───────────────────
  it("returns null when entryFilledAt is null", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: null });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).toBeNull();
    expect(searchTrades).not.toHaveBeenCalled();
  });

  // ── Test 7: no matching fills → returns null ───────────────────────────────
  it("returns null when searchTrades returns no fills", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");
    searchTrades.mockResolvedValue([]);
    const trade = makeTrade({ tpOrderId: 555 });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).toBeNull();
  });

  // ── Test 4: Topstep path — fills with profitAndLoss → summed directly ──────
  it("Topstep: sums profitAndLoss from fills and nets fees", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");
    const tpOrderId = 555;
    const fills: TradeFill[] = [
      makeFill({ id: 1, orderId: tpOrderId, price: 20100, size: 1, profitAndLoss: 1250, creationTimestamp: "2025-06-01T15:00:01.000Z" }),
      makeFill({ id: 2, orderId: tpOrderId, price: 20200, size: 1, profitAndLoss: 2500, creationTimestamp: "2025-06-01T15:00:02.000Z" }),
    ];
    // Also include entry fill (same orderId as entryOrderId) — must be excluded.
    const entryFill = makeFill({ id: 0, orderId: 999, side: 0, price: 20000, profitAndLoss: null, creationTimestamp: "2025-06-01T14:30:00.000Z" });
    searchTrades.mockResolvedValue([entryFill, ...fills]);

    const trade = makeTrade({ tpOrderId, size: 2 });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);

    expect(result).not.toBeNull();

    // exitPrice is size-weighted: (20100*1 + 20200*1) / 2 = 20150
    expect(result!.exitPrice).toBeCloseTo(20150, 6);

    // pnl from fills (not price math): 1250 + 2500 = 3750 gross
    const fees = feePerSideFor("/NQ") * 2 * 2; // 1.90 * 4 = 7.60
    expect(result!.feesDollars).toBeCloseTo(fees, 6);
    expect(result!.pnlDollars).toBeCloseTo(3750 - fees, 6);

    // Both fills from same orderId → matchedOrderId = tpOrderId
    expect(result!.matchedOrderId).toBe(tpOrderId);

    // filledAt = latest timestamp
    expect(result!.filledAt).toBe("2025-06-01T15:00:02.000Z");
  });

  // ── Test 1: Tradovate — null PnL fills → price-math PnL ──────────────────
  it("Tradovate: null-PnL fills use price math to derive pnlDollars", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    // Two partial fills at different prices (iceberg-style exit).
    const tpOrderId = 700;
    const fills: TradeFill[] = [
      makeFill({ id: 10, orderId: tpOrderId, price: 20125, size: 1, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE, creationTimestamp: "2025-06-01T15:00:01.000Z" }),
      makeFill({ id: 11, orderId: tpOrderId, price: 20175, size: 3, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE, creationTimestamp: "2025-06-01T15:00:02.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      side: 0,        // long
      size: 4,        // total size matches fills
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).not.toBeNull();

    // exitPrice = (20125*1 + 20175*3) / 4 = (20125 + 60525) / 4 = 80650 / 4 = 20162.5
    expect(result!.exitPrice).toBeCloseTo(20162.5, 6);

    // direction=1 (long), priceDelta = (20162.5 - 20000)*1 = 162.5
    // ticks = 162.5 / 0.25 = 650
    // pnlGross = 650 * 12.5 * 4 = 32500
    const fees = feePerSideFor("/NQ") * 2 * 4; // 1.90 * 8 = 15.20
    expect(result!.feesDollars).toBeCloseTo(fees, 6);
    expect(result!.pnlDollars).toBeCloseTo(32500 - fees, 6);

    expect(result!.matchedOrderId).toBe(tpOrderId);
  });

  // ── Test 1b: short Tradovate trade, negative price delta = positive PnL ───
  it("Tradovate: short trade exit above entry yields negative price-math PnL", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const slOrderId = 800;
    const fills: TradeFill[] = [
      makeFill({ id: 20, orderId: slOrderId, price: 20100, size: 1, profitAndLoss: null, side: 0 /* buy to close short */, accountId: ACCOUNT_TRADOVATE, creationTimestamp: "2025-06-01T15:01:00.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      slOrderId,
      side: 1,        // short
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).not.toBeNull();

    // direction=-1 (short), priceDelta = (20100 - 20000) * -1 = -100
    // ticks = -100 / 0.25 = -400
    // pnlGross = -400 * 12.5 * 1 = -5000
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(-5000 - fees, 6);
  });

  // ── Test 2: Tradovate — entryPrice null → returns null ───────────────────
  it("Tradovate: returns null when entryPrice is null (cannot derive price-math PnL)", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 701;
    searchTrades.mockResolvedValue([
      makeFill({ id: 30, orderId: tpOrderId, price: 20100, size: 1, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      entryPrice: null, // missing
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).toBeNull();
  });

  // ── Test 2b: Tradovate — entryPrice is 0 → returns null ──────────────────
  it("Tradovate: returns null when entryPrice is 0 (treated as missing)", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 702;
    searchTrades.mockResolvedValue([
      makeFill({ id: 31, orderId: tpOrderId, price: 20100, size: 1, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      entryPrice: 0, // invalid
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).toBeNull();
  });

  // ── Test 3: Tradovate — tickSize is 0 → returns null ─────────────────────
  it("Tradovate: returns null when tickSize is 0 (cannot derive price-math PnL)", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 703;
    searchTrades.mockResolvedValue([
      makeFill({ id: 40, orderId: tpOrderId, price: 20100, size: 1, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      tickSize: 0, // invalid
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).toBeNull();
  });

  // ── Test 3b: Tradovate — tickSize is null → returns null ─────────────────
  it("Tradovate: returns null when tickSize is null (cannot derive price-math PnL)", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 704;
    searchTrades.mockResolvedValue([
      makeFill({ id: 41, orderId: tpOrderId, price: 20100, size: 1, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      tickSize: null,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).toBeNull();
  });

  // ── Test 5: Tradovate fallback — orderId miss → contract+side picks it up ─
  it("Tradovate: fallback match picks up manual-close fill when orderId not in exitOrderIds", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    // The engine knows tpOrderId=900, but the fill that arrived has orderId=901
    // (operator manually closed via Tradovate UI with a different order).
    const tpOrderId = 900;
    const manualOrderId = 901;
    const fills: TradeFill[] = [
      // Entry fill — must be excluded (same orderId as entryOrderId=999, side=0)
      makeFill({ id: 0, orderId: 999, side: 0, price: 20000, profitAndLoss: null, accountId: ACCOUNT_TRADOVATE, creationTimestamp: "2025-06-01T14:30:00.000Z" }),
      // Manual-close fill — orderId NOT in exitOrderIds, but correct contract/side/post-entry
      makeFill({ id: 50, orderId: manualOrderId, price: 20050, size: 1, profitAndLoss: null, side: 1 /* sell, closing long */, accountId: ACCOUNT_TRADOVATE, contractId: "NQ-2025", creationTimestamp: "2025-06-01T15:05:00.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      side: 0,
      entryPrice: 20000,
      size: 1,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);
    expect(result).not.toBeNull();

    expect(result!.exitPrice).toBeCloseTo(20050, 6);

    // price math: direction=1, priceDelta = 50, ticks = 200, pnlGross = 200 * 12.5 * 1 = 2500
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(2500 - fees, 6);

    // orderId was manualOrderId (single fill) → matchedOrderId resolved
    expect(result!.matchedOrderId).toBe(manualOrderId);
  });

  // ── Test 6: Topstep fallback — null-PnL fill is NOT picked up ────────────
  it("Topstep: fallback does NOT match a null-PnL fill (profitAndLoss guard applies)", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    // tpOrderId is known, but the manual-close fill has a different orderId
    // AND profitAndLoss=null — Topstep gate must block it.
    const tpOrderId = 500;
    const manualOrderId = 501;
    const fills: TradeFill[] = [
      makeFill({
        id: 60,
        orderId: manualOrderId,
        price: 20050,
        size: 1,
        profitAndLoss: null, // Topstep gate should block this
        side: 1,
        contractId: "NQ-2025",
        creationTimestamp: "2025-06-01T15:05:00.000Z",
      }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({ tpOrderId });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).toBeNull();
  });

  // ── Topstep fallback: fill with non-null PnL IS picked up ────────────────
  it("Topstep: fallback matches a non-null-PnL fill when orderId not in exitOrderIds", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    const tpOrderId = 502;
    const manualOrderId = 503;
    const fills: TradeFill[] = [
      makeFill({
        id: 61,
        orderId: manualOrderId,
        price: 20050,
        size: 1,
        profitAndLoss: 625, // non-null → Topstep allows it
        side: 1,
        contractId: "NQ-2025",
        creationTimestamp: "2025-06-01T15:05:00.000Z",
      }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({ tpOrderId });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).not.toBeNull();
    expect(result!.exitPrice).toBeCloseTo(20050, 6);
    // PnL from fill sum (not price math): 625 - fees
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(625 - fees, 6);
  });

  // ── Primary match excludes entry fill and pre-entry fills ─────────────────
  it("excludes fills at or before entryFilledAt even if orderId matches", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    const tpOrderId = 555;
    // Fill timestamped BEFORE entryFilledAt — must be excluded.
    const staleExitFill = makeFill({
      id: 70,
      orderId: tpOrderId,
      price: 19900,
      profitAndLoss: 1000,
      creationTimestamp: "2025-06-01T14:00:00.000Z", // before entry at 14:30
    });
    // Fill after entry — valid.
    const validExitFill = makeFill({
      id: 71,
      orderId: tpOrderId,
      price: 20100,
      profitAndLoss: 1250,
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    searchTrades.mockResolvedValue([staleExitFill, validExitFill]);

    const trade = makeTrade({ tpOrderId });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).not.toBeNull();
    expect(result!.exitPrice).toBeCloseTo(20100, 6);
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(1250 - fees, 6);
  });

  // ── Voided fills are excluded ──────────────────────────────────────────────
  it("ignores voided fills", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    const tpOrderId = 600;
    const fills: TradeFill[] = [
      makeFill({ id: 80, orderId: tpOrderId, price: 20100, profitAndLoss: 1250, voided: true, creationTimestamp: "2025-06-01T15:00:00.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({ tpOrderId });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).toBeNull();
  });

  // ── Multi-order fills → matchedOrderId is null ────────────────────────────
  it("sets matchedOrderId to null when fills span multiple orders", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    // Trade has both TP and SL order ids — both contributed fills (unusual but
    // defensively handled by the engine).
    const tpOrderId = 610;
    const slOrderId = 611;
    const fills: TradeFill[] = [
      makeFill({ id: 90, orderId: tpOrderId, price: 20100, profitAndLoss: 625, size: 1, creationTimestamp: "2025-06-01T15:00:01.000Z" }),
      makeFill({ id: 91, orderId: slOrderId, price: 20050, profitAndLoss: 312, size: 1, creationTimestamp: "2025-06-01T15:00:02.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({ tpOrderId, slOrderId, size: 2 });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).not.toBeNull();
    expect(result!.matchedOrderId).toBeNull();
  });

  // ── feesDollars uses published rate, not per-fill fees field ──────────────
  it("feesDollars uses feePerSideFor * 2 * size, ignoring TradeFill.fees field", async () => {
    const { engine, searchTrades } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    const tpOrderId = 620;
    // Fill.fees is a bogus value — it must be ignored by the engine.
    const fills: TradeFill[] = [
      makeFill({ id: 100, orderId: tpOrderId, price: 20100, profitAndLoss: 1250, fees: 9999, size: 2, creationTimestamp: "2025-06-01T15:00:00.000Z" }),
    ];
    searchTrades.mockResolvedValue(fills);

    const trade = makeTrade({ tpOrderId, size: 2 });
    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);
    expect(result).not.toBeNull();

    const expectedFees = feePerSideFor("/NQ") * 2 * 2; // 1.90 * 4 = 7.60
    expect(result!.feesDollars).toBeCloseTo(expectedFees, 6);
    // NOT 9999 × 2 or any combination of fill.fees
    expect(result!.feesDollars).not.toBeCloseTo(9999 * 2, 0);
  });

  // ── /fill/deps fallback tests ─────────────────────────────────────────────

  // Tradovate post-restart: /fill/list is session-scoped so searchTrades returns
  // no exit fills. getFillsForOrder (/fill/deps?masterid=) returns historical fills.
  it("Tradovate: fires getFillsForOrder when searchTrades returns no exit fills (post-restart TP hit)", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 750;

    // searchTrades returns session-only fills — none match tpOrderId.
    searchTrades.mockResolvedValue([]);

    // /fill/deps returns the historical TP fill.
    const tpFill = makeFill({
      id: 200,
      orderId: tpOrderId,
      price: 20200,
      size: 1,
      profitAndLoss: null, // Tradovate never sends PnL
      side: 1,
      accountId: ACCOUNT_TRADOVATE,
      contractId: "NQ-2025",
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    getFillsForOrder.mockImplementation(async (orderId: number) =>
      orderId === tpOrderId ? [tpFill] : [],
    );

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);

    expect(result).not.toBeNull();
    // exitPrice = 20200
    expect(result!.exitPrice).toBeCloseTo(20200, 6);
    // matchedOrderId = tpOrderId → exitKind would be "tp"
    expect(result!.matchedOrderId).toBe(tpOrderId);
    // priceMath: direction=1, priceDelta=200, ticks=800, gross=800*12.5*1=10000
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(10000 - fees, 6);
    expect(getFillsForOrder).toHaveBeenCalledWith(tpOrderId, ACCOUNT_TRADOVATE);
  });

  it("Tradovate: getFillsForOrder is NOT called when searchTrades already matched the exit fill", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 751;

    // searchTrades returns the fill directly (current-session trade — no restart).
    searchTrades.mockResolvedValue([
      makeFill({
        id: 201,
        orderId: tpOrderId,
        price: 20150,
        size: 1,
        profitAndLoss: null,
        side: 1,
        accountId: ACCOUNT_TRADOVATE,
        contractId: "NQ-2025",
        creationTimestamp: "2025-06-01T15:00:00.000Z",
      }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);

    expect(result).not.toBeNull();
    expect(result!.exitPrice).toBeCloseTo(20150, 6);
    // Fallback must not have been invoked.
    expect(getFillsForOrder).not.toHaveBeenCalled();
  });

  it("Tradovate: fallback iterates all exit order IDs and uses the one that returns fills (SL hit)", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 760;
    const slOrderId = 761;

    // searchTrades returns nothing (prior-session trade).
    searchTrades.mockResolvedValue([]);

    // Only slOrderId has a fill via /fill/deps.
    const slFill = makeFill({
      id: 210,
      orderId: slOrderId,
      price: 19800,
      size: 1,
      profitAndLoss: null,
      side: 1,
      accountId: ACCOUNT_TRADOVATE,
      contractId: "NQ-2025",
      creationTimestamp: "2025-06-01T15:05:00.000Z",
    });
    getFillsForOrder.mockImplementation(async (orderId: number) =>
      orderId === slOrderId ? [slFill] : [],
    );

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      slOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);

    expect(result).not.toBeNull();
    expect(result!.exitPrice).toBeCloseTo(19800, 6);
    expect(result!.matchedOrderId).toBe(slOrderId);
    // priceMath: direction=1, priceDelta=(19800-20000)=-200, ticks=-800, gross=-800*12.5*1=-10000
    const fees = feePerSideFor("/NQ") * 2 * 1;
    expect(result!.pnlDollars).toBeCloseTo(-10000 - fees, 6);
    // Both exit order IDs were tried.
    expect(getFillsForOrder).toHaveBeenCalledWith(tpOrderId, ACCOUNT_TRADOVATE);
    expect(getFillsForOrder).toHaveBeenCalledWith(slOrderId, ACCOUNT_TRADOVATE);
  });

  it("Tradovate: getFillsForOrder throws — heal degrades gracefully to null without crashing", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 770;
    searchTrades.mockResolvedValue([]);
    getFillsForOrder.mockRejectedValue(new Error("network timeout"));

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    const result = await (engine as any).resolveExitFromFills(trade, ACCOUNT_TRADOVATE);

    // Fallback threw — no exit fills resolved — return null rather than crash.
    expect(result).toBeNull();
  });

  // The fallback is guarded by brokerKind === "tradovate"; Topstep must never call it.
  it("Topstep: getFillsForOrder is NOT called even when searchTrades returns no exit fills", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TOPSTEP, "topstep");

    const tpOrderId = 780;
    searchTrades.mockResolvedValue([]);

    const trade = makeTrade({ tpOrderId });

    await (engine as any).resolveExitFromFills(trade, ACCOUNT_TOPSTEP);

    expect(getFillsForOrder).not.toHaveBeenCalled();
  });
});

// ── validateClosedTradePrices — /fill/deps fallback ────────────────────────────

describe("validateClosedTradePrices /fill/deps fallback (private)", () => {
  it("fires getFillsForOrder and calls healApproximatedExit when searchTrades returns no fills (post-restart)", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 850;

    // searchTrades returns empty — simulates session-scope miss after restart.
    searchTrades.mockResolvedValue([]);

    const tpFill = makeFill({
      id: 300,
      orderId: tpOrderId,
      price: 20300,
      size: 1,
      profitAndLoss: null,
      side: 1,
      accountId: ACCOUNT_TRADOVATE,
      contractId: "NQ-2025",
      creationTimestamp: "2025-06-01T15:10:00.000Z",
    });
    getFillsForOrder.mockImplementation(async (orderId: number) =>
      orderId === tpOrderId ? [tpFill] : [],
    );

    // Trade must be "closed" with entryPrice set so the "entry missing + exit present"
    // branch inside validateClosedTradePrices calls healApproximatedExit.
    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      status: "closed",
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      exitPrice: 20000, // wrong approximated value — heal should correct it
      pnlDollars: 0,
      tickSize: 0.25,
      tickValue: 12.5,
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      exitFilledAt: "2025-06-01T15:10:00.000Z",
    });

    await (engine as any).validateClosedTradePrices(trade, ACCOUNT_TRADOVATE);

    expect(getFillsForOrder).toHaveBeenCalledWith(tpOrderId, ACCOUNT_TRADOVATE);
    expect(vi.mocked(healApproximatedExit)).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeId: trade.id,
        exitPrice: expect.closeTo(20300, 4),
        exitKind: "tp",
      }),
    );
  });

  it("does NOT call healApproximatedExit when getFillsForOrder throws", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 851;
    searchTrades.mockResolvedValue([]);
    getFillsForOrder.mockRejectedValue(new Error("503 upstream"));

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      status: "closed",
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      exitPrice: 20000,
      pnlDollars: 0,
      tickSize: 0.25,
      tickValue: 12.5,
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      exitFilledAt: "2025-06-01T15:10:00.000Z",
    });

    vi.mocked(healApproximatedExit).mockClear();

    await (engine as any).validateClosedTradePrices(trade, ACCOUNT_TRADOVATE);

    expect(healApproximatedExit).not.toHaveBeenCalled();
  });

  it("does NOT fire getFillsForOrder when searchTrades already returns matching exit fills", async () => {
    const { engine, searchTrades, getFillsForOrder } = makeEngine(ACCOUNT_TRADOVATE, "tradovate");

    const tpOrderId = 852;
    const entryOrderId = 999;

    // searchTrades returns both an entry fill and the TP exit fill.
    searchTrades.mockResolvedValue([
      makeFill({
        id: 400,
        orderId: entryOrderId,
        price: 20000,
        size: 1,
        profitAndLoss: null,
        side: 0,
        accountId: ACCOUNT_TRADOVATE,
        contractId: "NQ-2025",
        creationTimestamp: "2025-06-01T14:30:00.000Z",
      }),
      makeFill({
        id: 401,
        orderId: tpOrderId,
        price: 20200,
        size: 1,
        profitAndLoss: null,
        side: 1,
        accountId: ACCOUNT_TRADOVATE,
        contractId: "NQ-2025",
        creationTimestamp: "2025-06-01T15:00:00.000Z",
      }),
    ]);

    const trade = makeTrade({
      accountId: ACCOUNT_TRADOVATE,
      status: "closed",
      entryOrderId,
      tpOrderId,
      side: 0,
      size: 1,
      entryPrice: 20000,
      exitPrice: 20000, // drift present so heal would fire if data matches
      pnlDollars: 0,
      tickSize: 0.25,
      tickValue: 12.5,
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      exitFilledAt: "2025-06-01T15:00:00.000Z",
    });

    await (engine as any).validateClosedTradePrices(trade, ACCOUNT_TRADOVATE);

    expect(getFillsForOrder).not.toHaveBeenCalled();
  });
});
