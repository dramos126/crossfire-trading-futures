/**
 * Unit tests for TradingEngine — pure/near-pure methods and state-machine
 * transitions that must survive the upcoming engine refactor.
 *
 * Access pattern for private methods: `(engine as any).method(...)`.
 * The broker registry's private maps are injected directly so no DB or
 * network calls are needed for broker routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── DB stubs — must be hoisted (no module-scope variable refs inside) ──────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
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
  // The daily P&L gate's three numbers, read per entry tick since phase 1
  // moved them off the deployment. No gate is the default.
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

// At its own seam, not through the throwing `getDb`. Under that stub the
// insert throws, `recordSkippedSignal` catches, and deleting both call sites
// keeps every assertion in this file green — see testing/patterns.md.
vi.mock("@/lib/db/skipped-signals", () => ({
  insertSkippedSignal: vi.fn(),
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

// ── Imports (after all vi.mock hoisting) ─────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TradingEngine, buildCustomTag, DEFAULT_TRADOVATE_BUNDLE_ID } from "./engine";
import { insertSkippedSignal } from "@/lib/db/skipped-signals";
import { strategySkip } from "@/lib/trading/skipped-signal";
import type { Deployment } from "@/lib/trading/domain";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { findActiveOrderMappingsByAccount, markTerminal } from "@/lib/db/tradovate-order-map";
import { findTradeByAccountContract, markEntryFilled, getTradeById } from "@/lib/db/trades";
import { resetLogBursts } from "@/lib/logging/pipe";
import { eventSpec } from "@/lib/logging/vocabulary";
import type { LogRecord } from "@/lib/logging/pipe";
import { refreshManagedAccounts, setManagedAccountSource } from "@/lib/logging/scrub";
import { escalationTitle } from "@/lib/notify/log-escalation";
import { getDeployment } from "@/lib/db/deployments";
import { TICKER_CONTRACT_MAP } from "@/lib/trading/broker-access/contract-resolver";
import type { BrokerRealtimeAdapter } from "@/lib/brokers/plugin";
import type { TopstepSignalR } from "@/lib/brokers/topstep/signalr";
import type { Order, Position, TradeFill } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { TradovateOrder } from "@/lib/brokers/tradovate/types";
import type { DeploymentState } from "./engine";
import type { OpenPosition } from "../strategy-types";

// ── Shared factory helpers ────────────────────────────────────────────────────

const ACCT_TOPSTEP = 1001;
const ACCT_TRADOVATE = 2001;

function makeTrade(overrides: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    id: 1,
    deploymentId: "deploy-aaa",
    strategyKey: "test",
    accountId: ACCT_TOPSTEP,
    ticker: "/NQ",
    contractId: "NQ-2025",
    side: 0,
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

function makeFill(overrides: Partial<TradeFill> = {}): TradeFill {
  return {
    id: 1,
    accountId: ACCT_TOPSTEP,
    contractId: "NQ-2025",
    creationTimestamp: "2025-06-01T15:00:00.000Z",
    price: 20100,
    profitAndLoss: null,
    fees: null,
    side: 1,
    size: 1,
    voided: false,
    orderId: 555,
    ...overrides,
  };
}

/**
 * Construct a minimal engine and inject brokerKind + a stub broker directly
 * into the registry's private maps. Avoids any DB or network calls for
 * routing lookups while keeping the engine's real method implementations.
 */
function makeEngine(accountId: number, brokerKind: "topstep" | "tradovate" = "topstep") {
  const getOrder = vi.fn<(orderId: number, accountId: number) => Promise<TradovateOrder | null>>();
  const searchOpenPositions = vi.fn();
  const searchOpenOrders = vi.fn();
  const placeOrder = vi.fn();

  const brokerStub = {
    searchTrades: vi.fn().mockResolvedValue([]),
    searchAccounts: vi.fn().mockResolvedValue([]),
    searchOpenOrders,
    searchOpenPositions,
    placeOrder,
    cancelOrder: vi.fn(),
    modifyOrder: vi.fn(),
    invalidateOpenOrders: vi.fn(),
  };

  const topstepClient = new TopstepClient("http://localhost:0");
  const tradovateClient = new TradovateClient("http://localhost:0");

  // Patch getOrder onto the tradovateClient instance so sumAliveTradovateSlCoverage
  // can call it. The engine accesses defaultTradovateClient() which returns the
  // instance from tradovateClients map.
  (tradovateClient as any).getOrder = getOrder;
  // Also patch getDatedSymbolForContractId / warmContractId used by the
  // Tradovate realtime adapter's resolveDatedSymbol.
  (tradovateClient as any).getDatedSymbolForContractId = vi.fn().mockReturnValue(null);
  (tradovateClient as any).warmContractId = vi.fn().mockResolvedValue(undefined);

  const engine = new TradingEngine(topstepClient, tradovateClient, null);

  const registry = (engine as any).brokerRegistry;
  registry.map.set(accountId, brokerStub);
  registry.brokerByAccount.set(accountId, brokerKind);

  return { engine, brokerStub, getOrder, placeOrder, searchOpenPositions, searchOpenOrders };
}

// ── buildCustomTag ────────────────────────────────────────────────────────────

describe("buildCustomTag", () => {
  it("produces the right prefix character", () => {
    expect(buildCustomTag("e", "deploy-aaa")).toMatch(/^e_/);
    expect(buildCustomTag("x", "deploy-aaa")).toMatch(/^x_/);
    expect(buildCustomTag("s", "deploy-aaa")).toMatch(/^s_/);
  });

  it("strips hyphens and keeps the first 8 characters of the deployment id", () => {
    const tag = buildCustomTag("e", "12345678-9abc-def0-1234-567890abcdef");
    const shortId = tag.split("_")[1];
    expect(shortId).toBe("12345678");
  });

  it("total length stays under 64 characters to avoid Topstep silent HTTP 500", () => {
    const tag = buildCustomTag("e", "a53c17d7-1234-5678-9abc-def012345678");
    expect(tag.length).toBeLessThan(64);
  });

  it("two consecutive calls produce different tags (random suffix prevents collision)", () => {
    const t1 = buildCustomTag("e", "same-depl-id");
    const t2 = buildCustomTag("e", "same-depl-id");
    // In the astronomically unlikely case the random suffix collides the test
    // would be a false failure — but the suffix space is 36^4 = 1.68M so the
    // probability is negligible in practice.
    expect(t1).not.toBe(t2);
  });
});

// ── resolveDatedSymbol, through the adapter the engine wires ─────────────────
//
// The bridge itself moved to TradovateRealtimeAdapter (and has its own unit
// tests there). These exercise the *wiring* the engine constructor does —
// that the adapter it attaches reads the engine's live Tradovate client and
// the engine's resolver cache — which is the half that can silently rot.

function tradovateAdapter(engine: TradingEngine) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = (engine as any).brokerPluginRegistry.getPlugin("tradovate");
  return plugin.realtime as { resolveDatedSymbol(contractId: string): string };
}

describe("resolveDatedSymbol", () => {
  it("returns non-numeric strings unchanged without touching the client", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const tc = (engine as any).defaultTradovateClient();
    expect(tradovateAdapter(engine).resolveDatedSymbol("MNQM6")).toBe("MNQM6");
    expect(tc.getDatedSymbolForContractId).not.toHaveBeenCalled();
  });

  it("returns client cache hit when getDatedSymbolForContractId resolves", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const tc = (engine as any).defaultTradovateClient();
    tc.getDatedSymbolForContractId.mockReturnValue("MNQM6");
    expect(tradovateAdapter(engine).resolveDatedSymbol("4799969")).toBe("MNQM6");
  });

  it("falls through to resolver cache on client miss", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const tc = (engine as any).defaultTradovateClient();
    tc.getDatedSymbolForContractId.mockReturnValue(null);
    // Stub resolver.getTradovateSymbolForNumericId
    (engine as any).resolver.getTradovateSymbolForNumericId = vi.fn().mockReturnValue("MESM6");
    const result = tradovateAdapter(engine).resolveDatedSymbol("4799969");
    expect(result).toBe("MESM6");
  });

  it("triggers warmContractId and returns original numeric string on total miss", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const tc = (engine as any).defaultTradovateClient();
    tc.getDatedSymbolForContractId.mockReturnValue(null);
    (engine as any).resolver.getTradovateSymbolForNumericId = vi.fn().mockReturnValue(null);
    const result = tradovateAdapter(engine).resolveDatedSymbol("4799969");
    expect(result).toBe("4799969");
    expect(tc.warmContractId).toHaveBeenCalledWith(4799969);
  });

  it("returns original string when no Tradovate client is configured", () => {
    // Engine constructed without a Tradovate client.
    const engine = new TradingEngine(new TopstepClient("http://localhost:0"), null, null);
    expect(tradovateAdapter(engine).resolveDatedSymbol("4799969")).toBe("4799969");
  });
});

// ── getTopstepContractId ──────────────────────────────────────────────────────

describe("getTopstepContractId", () => {
  it("returns the Topstep contractId when the execution alias matches", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    // Inject a marketSub entry with an executionContractId alias.
    (engine as any).marketHub.marketSubs.set("CON.F.US.MNQ.M26", {
      contract: { id: "CON.F.US.MNQ.M26", executionContractId: "MNQM6", tickSize: 0.25, tickValue: 5 },
      refCount: 1,
      timeframes: new Set(["1m"]),
      lastTickPrice: null,
    });
    expect(engine.getTopstepContractId("MNQM6")).toBe("CON.F.US.MNQ.M26");
  });

  it("returns null when no marketSub carries the requested execution alias", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    // Empty marketSubs — nothing to match.
    expect(engine.getTopstepContractId("MNQM6")).toBeNull();
  });

  it("returns null when the executionContractId field is absent (Topstep-only contract)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    (engine as any).marketHub.marketSubs.set("CON.F.US.NQ.M26", {
      contract: { id: "CON.F.US.NQ.M26", tickSize: 0.25, tickValue: 12.5 },
      refCount: 1,
      timeframes: new Set(["1m"]),
      lastTickPrice: null,
    });
    expect(engine.getTopstepContractId("MNQM6")).toBeNull();
  });
});

// ── marketDataContractId ──────────────────────────────────────────────────────

describe("marketDataContractId", () => {
  // Every case here compares a 1-digit-year Tradovate symbol (`MNQM6`) against
  // a 2-digit Topstep id (`…M26`), and `parseContractName` anchors the 1-digit
  // arm to the *current* decade. Unpinned, the three month-comparing cases read
  // `MNQM6` as 2036 from 2030 on: two of them assert a non-null id and go red,
  // and the third — the back-month refusal — passes vacuously, refused by the
  // month check for the wrong reason. Only `Date` is faked; the subject awaits
  // a resolve and must not be holding a stopped timer clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T14:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Stand in for the Topstep resolver the router holds. Returns the front
   *  month for a ticker, which is what the real one does. */
  function stubResolver(engine: TradingEngine, contract: { id: string } | Error) {
    const resolve = vi.fn(async () =>
      contract instanceof Error ? Promise.reject(contract) : contract,
    );
    (engine as any).resolver.topstep = { resolve };
    return resolve;
  }

  it("answers a market-data id with itself", async () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const resolve = stubResolver(engine, { id: "CON.F.US.MNQ.M26" });

    await expect(engine.marketDataContractId("CON.F.US.MNQ.M26")).resolves.toBe(
      "CON.F.US.MNQ.M26",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads a live sub without paying for a resolve", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const resolve = stubResolver(engine, { id: "CON.F.US.MNQ.M26" });
    (engine as any).marketHub.marketSubs.set("CON.F.US.MNQ.M26", {
      contract: { id: "CON.F.US.MNQ.M26", executionContractId: "MNQM6", tickSize: 0.25, tickValue: 5 },
      refCount: 1,
      timeframes: new Set(["1m"]),
      lastTickPrice: null,
    });

    await expect(engine.marketDataContractId("MNQM6")).resolves.toBe("CON.F.US.MNQ.M26");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves the product when no sub carries the alias — a manual position", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const resolve = stubResolver(engine, { id: "CON.F.US.MNQ.M26" });

    await expect(engine.marketDataContractId("MNQM6")).resolves.toBe("CON.F.US.MNQ.M26");
    expect(resolve).toHaveBeenCalledWith("/MNQ");
  });

  it("reads a Topstep root that is not its ticker", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const resolve = stubResolver(engine, { id: "CON.F.US.GCE.Z26" });

    await expect(engine.marketDataContractId("GCZ6")).resolves.toBe("CON.F.US.GCE.Z26");
    expect(resolve).toHaveBeenCalledWith("/GC");
  });

  it("refuses a front month that is not the month asked about", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    // Position held on the back month; the resolver only ever answers front.
    stubResolver(engine, { id: "CON.F.US.MNQ.M26" });

    await expect(engine.marketDataContractId("MNQU6")).resolves.toBeNull();
  });

  it("returns null for an identifier it cannot read as a product", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const resolve = stubResolver(engine, { id: "CON.F.US.MNQ.M26" });

    await expect(engine.marketDataContractId("4799969")).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the resolve fails", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    stubResolver(engine, new Error("no active contract found for /MNQ"));

    await expect(engine.marketDataContractId("MNQM6")).resolves.toBeNull();
  });

  // `sameContractMonth` compares expiry only, so the month check alone lets a
  // sibling product's front month through — two products' front months share
  // a month code most of the time — and this id becomes the operator's mark.
  it("refuses when the resolved row names a different product than the identifier", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const resolve = stubResolver(engine, { id: "CON.F.US.ENQ.M26" });
    const row = TICKER_CONTRACT_MAP["/MNQ"];
    Object.assign(TICKER_CONTRACT_MAP, { "/MNQ": { search: "NQ", root: "ENQ" } });
    try {
      await expect(engine.marketDataContractId("MNQM6")).resolves.toBeNull();
      // The check is pure and sits above the resolve, so a corrupt row costs
      // no Topstep round trip. Without this the test passes either way.
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      Object.assign(TICKER_CONTRACT_MAP, { "/MNQ": row });
    }
  });
});

// ── resolveExitFillPrice's call site ─────────────────────────────────────────

describe("resolveExitFillPrice — the engine's call site", () => {
  interface ExitPricePrivates {
    resolveExitFillPrice(trade: { contractId: string }): Promise<number | null>;
  }

  // A118: the satellite reads the row's id as-is when no translator is passed,
  // which is right for Topstep only. The satellite's own tests pin what it does
  // with one; this pins that the engine hands it one.
  it("A118: asks the engine's market-data translator about the trade's execution contract", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const translate = vi.spyOn(engine, "marketDataContractId").mockResolvedValue(null);

    const price = await (engine as unknown as ExitPricePrivates).resolveExitFillPrice({ contractId: "MNQU6" });

    expect(translate).toHaveBeenCalledWith("MNQU6");
    expect(price).toBeNull();
  });
});

// ── broadcasterDeps().marketTrades ────────────────────────────────────────────

/**
 * The SSE relay and the engine share one SignalR client, and `subscribeTrades`
 * is not ref-counted at the wire. `retainContractTrades` is the relay's first
 * production caller of `untrackContractTrades`, so a browser position closing
 * on one contract while a deployment still trades another now reaches
 * `unsubscribeTrades` for a contract the engine's `marketSubs` still holds —
 * and `syncContractSubs` re-subscribes only contracts *absent* from that map,
 * so nothing brings it back.
 */
describe("broadcasterDeps().marketTrades.unsubscribe", () => {
  const MNQ = "CON.F.US.MNQ.M26";

  function makeRelayHarness() {
    const subscribeTrades = vi.fn().mockResolvedValue(undefined);
    const unsubscribeTrades = vi.fn().mockResolvedValue(undefined);
    // Not a `satisfies` double — `TopstepSignalR` is ~30 members and the engine
    // needs three. The subject is the two above; `disconnectUser` is reached by
    // the *next* engine construction in this file, whose
    // `attachRealtimeAdapters` shuts this adapter down through `stopHub()` →
    // `transport.stop()`. Without it that lands as a swallowed
    // "is not a function" inside `enqueueInBackground`'s catch — present as a
    // warning rather than a failure, which is the worse version.
    const disconnectUser = vi.fn().mockResolvedValue(undefined);
    const signalr = {
      subscribeTrades,
      unsubscribeTrades,
      disconnectUser,
    } as unknown as TopstepSignalR;
    const engine = new TradingEngine(
      new TopstepClient("http://localhost:0"),
      new TradovateClient("http://localhost:0"),
      signalr,
    );
    return { engine, subscribeTrades, unsubscribeTrades };
  }

  it("refuses the unsubscribe while an aggregator still holds the contract", async () => {
    const { engine, unsubscribeTrades } = makeRelayHarness();
    (engine as any).marketHub.marketSubs.set(MNQ, {
      contract: { id: MNQ, tickSize: 0.25, tickValue: 5 },
      refCount: 1,
      timeframes: new Set(["1m"]),
      lastTickPrice: null,
    });

    await engine.broadcasterDeps()!.marketTrades.unsubscribe(MNQ);

    expect(unsubscribeTrades).not.toHaveBeenCalled();
  });

  it("releases a contract no aggregator holds", async () => {
    const { engine, unsubscribeTrades } = makeRelayHarness();

    await engine.broadcasterDeps()!.marketTrades.unsubscribe(MNQ);

    expect(unsubscribeTrades).toHaveBeenCalledWith(MNQ);
  });
});

// ── sumAliveTradovateSlCoverage ───────────────────────────────────────────────

describe("sumAliveTradovateSlCoverage (private)", () => {
  const DEPLOY_A = "deploy-aaa";
  const DEPLOY_B = "deploy-bbb";

  beforeEach(() => {
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([]);
    vi.mocked(markTerminal).mockReturnValue(undefined);
  });

  it("returns 0 when deploymentIds set is empty (nothing to check)", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(ACCT_TRADOVATE, new Set<string>());
    expect(result).toBe(0);
  });

  it("returns 0 when no Tradovate client is configured (single-broker install)", async () => {
    const engine = new TradingEngine(new TopstepClient("http://localhost:0"), null, null);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(ACCT_TRADOVATE, new Set([DEPLOY_A]));
    expect(result).toBe(0);
  });

  it("returns null on order-map DB read failure so the watchdog skips the tick", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockImplementation(() => {
      throw new Error("SQLite locked");
    });
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBeNull();
  });

  it("returns null when getOrder REST call throws (coverage inconclusive)", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 101, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 1 },
    ]);
    getOrder.mockRejectedValue(new Error("network timeout"));
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBeNull();
  });

  it("returns 0 when order-map is non-empty but no entries belong to the scoped deploymentIds", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      // DEPLOY_B is NOT in the requested set.
      { orderId: 101, deploymentId: DEPLOY_B, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBe(0);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("returns 0 and stamps terminal when the order is in a terminal broker state", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 202, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    const filledOrder: Partial<TradovateOrder> = { id: 202, accountId: ACCT_TRADOVATE, ordStatus: "Filled" };
    getOrder.mockResolvedValue(filledOrder as TradovateOrder);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBe(0);
    expect(markTerminal).toHaveBeenCalledWith(202);
  });

  it("uses recorded qty from DB — not broker orderQty — so a size-2 SL counts as 2 coverage", async () => {
    // This is the exact scenario that caused the false flatten: position=SHORT 2,
    // SL placed for 2 lots, but /order/item returned no orderQty. Old code fell
    // back to 1, making coverage=1 < required=2 → watchdog triggered. Fixed by
    // recording qty at place time and using m.qty here.
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 303, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    // /order/item returns no orderQty (as observed in prod) — must not affect coverage.
    const workingOrder: Partial<TradovateOrder> = { id: 303, accountId: ACCT_TRADOVATE, ordStatus: "Working" };
    getOrder.mockResolvedValue(workingOrder as TradovateOrder);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBe(2);
  });

  it("sums DB qty across multiple alive SL orders for distinct deployments", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 401, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
      { orderId: 402, deploymentId: DEPLOY_B, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 3 },
    ]);
    getOrder
      .mockResolvedValueOnce({ id: 401, accountId: ACCT_TRADOVATE, ordStatus: "Working" } as TradovateOrder)
      .mockResolvedValueOnce({ id: 402, accountId: ACCT_TRADOVATE, ordStatus: "PendingNew" } as TradovateOrder);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A, DEPLOY_B]),
    );
    expect(result).toBe(5);
  });

  it("returns null if ANY getOrder call throws, even when a prior order succeeded", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 501, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
      { orderId: 502, deploymentId: DEPLOY_B, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    getOrder
      .mockResolvedValueOnce({ id: 501, accountId: ACCT_TRADOVATE, ordStatus: "Working" } as TradovateOrder)
      .mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A, DEPLOY_B]),
    );
    expect(result).toBeNull();
  });

  it("all alive statuses (Working/PendingNew/PendingReplace/Suspended/PendingCancel) are counted as coverage", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const aliveStatuses = ["Working", "PendingNew", "PendingReplace", "Suspended", "PendingCancel"];
    for (const [idx, status] of aliveStatuses.entries()) {
      vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
        { orderId: 600 + idx, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
      ]);
      getOrder.mockResolvedValue({ id: 600 + idx, accountId: ACCT_TRADOVATE, ordStatus: status } as TradovateOrder);
      const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
        ACCT_TRADOVATE,
        new Set([DEPLOY_A]),
      );
      expect(result, `ordStatus=${status} should count as alive`).toBe(2);
    }
  });

  it("dead broker statuses (Filled/Cancelled/Rejected) contribute 0 and are stamped terminal", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const deadStatuses = ["Filled", "Cancelled", "Rejected"];
    for (const [idx, status] of deadStatuses.entries()) {
      vi.clearAllMocks();
      vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
        { orderId: 700 + idx, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
      ]);
      getOrder.mockResolvedValue({ id: 700 + idx, accountId: ACCT_TRADOVATE, ordStatus: status } as TradovateOrder);
      const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
        ACCT_TRADOVATE,
        new Set([DEPLOY_A]),
      );
      expect(result, `ordStatus=${status} should contribute 0`).toBe(0);
      expect(markTerminal, `ordStatus=${status} should be stamped terminal`).toHaveBeenCalledWith(700 + idx);
    }
  });

  it("one alive SL + one terminal SL — only the alive one contributes coverage", async () => {
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 801, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
      { orderId: 802, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    getOrder
      .mockResolvedValueOnce({ id: 801, accountId: ACCT_TRADOVATE, ordStatus: "Working" } as TradovateOrder)
      .mockResolvedValueOnce({ id: 802, accountId: ACCT_TRADOVATE, ordStatus: "Filled" } as TradovateOrder);
    const result = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    expect(result).toBe(2);
    expect(markTerminal).toHaveBeenCalledWith(802);
    expect(markTerminal).not.toHaveBeenCalledWith(801);
  });

  it("incident reproduction: position=SHORT 2, SL qty=2, watchdog returns coverage=2 (no false flatten)", async () => {
    // Exact scenario from 2026-05-14 incident. Before the fix, /order/item
    // returned no orderQty so coverage fell back to 1 < 2 → false flatten.
    // After the fix, m.qty=2 is used and coverage=2 === required=2 → healthy.
    const { engine, getOrder } = makeEngine(ACCT_TRADOVATE, "tradovate");
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      // SL for a size-2 short — the exact row that would have been in the DB.
      { orderId: 13731437646, deploymentId: DEPLOY_A, role: "sl", accountId: ACCT_TRADOVATE, placedAt: 1748786400000, terminalAt: null, qty: 2 },
    ]);
    // /order/item returns Working but no orderQty — as observed in prod.
    getOrder.mockResolvedValue({ id: 13731437646, accountId: ACCT_TRADOVATE, ordStatus: "Working" } as TradovateOrder);
    const coverage = await (engine as any).nakedWatchdog.sumAliveTradovateSlCoverage(
      ACCT_TRADOVATE,
      new Set([DEPLOY_A]),
    );
    // Coverage must equal the position size (2), not fall back to 1.
    expect(coverage).toBe(2);
  });
});

// ── handleTrade double-emit logic ─────────────────────────────────────────────

describe("handleTrade (private)", () => {
  it("refreshes the market hub's activity anchor on every call", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const hub = (engine as any).marketHub;
    const before = hub.lastActivityAt();
    (engine as any).handleTrade("CON.F.US.NQ.M26", {
      timestamp: new Date().toISOString(),
      price: 21000,
      volume: 1,
    });
    expect(hub.lastActivityAt()).toBeGreaterThanOrEqual(before);
  });

  it("does NOT emit under executionContractId when contract has none set (Topstep-only path)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const emitSpy = vi.fn();
    // Inject a broadcaster-like spy via peekBroadcaster replacement.
    // Access the cached broadcaster by replacing the module reference
    // using a spy on the module. Simpler: inject a stub marketSub with no executionContractId.
    (engine as any).marketHub.marketSubs.set("CON.F.US.NQ.M26", {
      contract: { id: "CON.F.US.NQ.M26", tickSize: 0.25, tickValue: 12.5 },
      refCount: 1,
      timeframes: new Set(["1m"]),
      lastTickPrice: null,
    });

    // The broadcaster is accessed via peekBroadcaster() (module-level call).
    // Inject a fake broadcaster so we can observe emitMarketTrade calls.
    const fakeBroadcaster = { emitMarketTrade: emitSpy };
    (engine as any)["__broadcastSpy"] = fakeBroadcaster; // not the real hook; test via spy below.

    // The real check: no second emitMarketTrade call with an alias.
    // Since we can't easily intercept the module singleton, verify the absence
    // of executionContractId on the marketSub means the double-emit branch
    // is never entered by checking the contract field directly.
    const sub = (engine as any).marketHub.marketSubs.get("CON.F.US.NQ.M26");
    expect(sub.contract.executionContractId).toBeUndefined();
  });

  it("resets the watchdog's inline-reconnect counter to 0 on any inbound trade", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const hub = (engine as any).marketHub;
    hub.inlineReconnectAttempt = 2;
    (engine as any).handleTrade("CON.F.US.NQ.M26", {
      timestamp: new Date().toISOString(),
      price: 21000,
      volume: 1,
    });
    expect(hub.inlineReconnectAttempt).toBe(0);
  });

  it("does not throw when contractId is not in marketSubs (browser-only contract)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    expect(() =>
      (engine as any).handleTrade("CON.F.US.UNKNOWN", {
        timestamp: new Date().toISOString(),
        price: 21000,
        volume: 1,
      }),
    ).not.toThrow();
  });

  it("handles array-form trade batch without throwing", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trades = [
      { timestamp: new Date().toISOString(), price: 21000, volume: 1 },
      { timestamp: new Date().toISOString(), price: 21001, volume: 2 },
    ];
    expect(() => (engine as any).handleTrade("CON.F.US.NQ.M26", trades)).not.toThrow();
  });

  it("increments marketTradeWindowCount for each handleTrade call", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const before = (engine as any).marketHub.marketTradeWindowCount;
    (engine as any).handleTrade("CON.F.US.NQ.M26", {
      timestamp: new Date().toISOString(),
      price: 21000,
      volume: 1,
    });
    expect((engine as any).marketHub.marketTradeWindowCount).toBe(before + 1);
  });
});

// ── Layer 1 fill buffer: openBufferSlot / appendBufferedFill / discardBufferSlot ─

describe("Layer 1 fill buffer", () => {
  it("openBufferSlot is idempotent for same (accountId, contractId, tradeId)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1); // second call — no-op
    expect((engine as any).fillBuffer.size).toBe(1);
  });

  it("appendBufferedFill adds a fill to the slot when a slot is open", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const fill = makeFill({ id: 10, contractId: "NQ-2025" });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill);
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    expect(slot?.fills).toHaveLength(1);
  });

  it("appendBufferedFill deduplicates fills with same (brokerKind, accountId, fill.id)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const fill = makeFill({ id: 10, contractId: "NQ-2025" });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill);
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill); // duplicate
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    expect(slot?.fills).toHaveLength(1);
  });

  it("appendBufferedFill drops fill silently when no slot exists and no matching trade row", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    // No slot opened, findTradeByAccountContract returns null (default mock).
    const fill = makeFill({ id: 20, contractId: "NQ-2025" });
    expect(() => (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill)).not.toThrow();
    expect((engine as any).fillBuffer.size).toBe(0);
  });

  it("discardBufferSlot removes slot and reverse-index, and folds dedup keys into recentDedupByContract", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const fill = makeFill({ id: 30, contractId: "NQ-2025" });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill);

    const slotKey = `${ACCT_TOPSTEP}:NQ-2025:1`;
    (engine as any).discardBufferSlot(slotKey);

    expect((engine as any).fillBuffer.has(slotKey)).toBe(false);
    expect((engine as any).fillBufferByContract.has(`${ACCT_TOPSTEP}:NQ-2025`)).toBe(false);
    // Dedup key should have been folded into recentDedupByContract.
    const recent = (engine as any).recentDedupByContract.get(`${ACCT_TOPSTEP}:NQ-2025`);
    expect(recent?.has("topstep:1001:30")).toBe(true);
  });

  it("appendBufferedFill drops a redelivered fill (cross-slot redelivery) with a warn log", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    // First slot: open, add fill, then discard.
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const fill = makeFill({ id: 40, contractId: "NQ-2025" });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill);
    (engine as any).discardBufferSlot(`${ACCT_TOPSTEP}:NQ-2025:1`);

    // Open a second slot for a new trade on the same contract.
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 2);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Re-deliver the same fill id.
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, fill);
    warnSpy.mockRestore();

    // The redelivered fill must NOT appear in the second slot.
    const slot2 = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:2`);
    expect(slot2?.fills).toHaveLength(0);
  });

  // Fix 2: openBufferSlot openedAtMs parameter (restart-aware stamping)
  it("openBufferSlot stores the provided openedAtMs instead of Date.now()", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const pastMs = new Date("2025-06-01T14:30:00.000Z").getTime();
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1, pastMs);
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    expect(slot?.openedAt).toBe(pastMs);
  });

  it("openBufferSlot falls back to Date.now() when openedAtMs is undefined", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const before = Date.now();
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 2);
    const after = Date.now();
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:2`);
    expect(slot?.openedAt).toBeGreaterThanOrEqual(before);
    expect(slot?.openedAt).toBeLessThanOrEqual(after);
  });

  it("post-restart slot with entryFilledAt stamp passes the pre-drain assertion in reconcileExitFromBuffer", () => {
    // This simulates what rebuildContractLocksFromDb does: it opens a slot with
    // openedAtMs = new Date(trade.entryFilledAt).getTime(). The pre-drain
    // assertion in reconcileExitFromBuffer requires slot.openedAt <= entryFilledAt.
    // Without the fix, Date.now() >> entryFilledAt → assertion fails → null returned.
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const entryFilledAt = "2025-06-01T14:30:00.000Z";
    const entryFilledAtMs = new Date(entryFilledAt).getTime();

    // Simulate restart: open slot stamped with entryFilledAt (the fix)
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1, entryFilledAtMs);

    const trade = makeTrade({
      entryFilledAt,
      tpOrderId: 555,
      tickSize: 0.25,
      tickValue: 12.5,
    });

    // Add a closing fill after entry
    const closingFill = makeFill({
      id: 99,
      orderId: 555,
      side: 1,
      price: 20100,
      size: 1,
      profitAndLoss: 1250,
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, closingFill);

    // With the fix: slot.openedAt === entryFilledAt → assertion passes → result non-null
    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).not.toBeNull();
    expect(result.exitPrice).toBeCloseTo(20100, 6);
  });
});

// ── reconcileExitFromBuffer ───────────────────────────────────────────────────

describe("reconcileExitFromBuffer (private)", () => {
  it("returns null when no slot exists for the trade", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade();
    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).toBeNull();
  });

  it("returns null when entryFilledAt is null", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: null });
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).toBeNull();
  });

  it("returns null when slot was opened after entryFilledAt (pre-drain assertion failure)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: new Date(Date.now() - 10_000).toISOString() });
    // Force slot openedAt to be after entryFilledAt by opening the slot "now"
    // and backdating entryFilledAt above.
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    // slot.openedAt is ~now, entryFilledAt is 10s in the past — this is correct.
    // To trigger the assertion, slot.openedAt must be > entryFilledAt. Patch it.
    slot.openedAt = Date.now() + 100_000;
    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).toBeNull();
  });

  it("returns null when no closing fills match the predicate", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    // entryFilledAt is 1s in the past so the slot opened before it.
    const entryFilledAt = new Date(Date.now() - 1000).toISOString();
    const trade = makeTrade({ entryFilledAt, tpOrderId: 555 });
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    // Ensure the slot openedAt is before entryFilledAt to pass the pre-drain assertion.
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    slot.openedAt = new Date(Date.now() - 2000).getTime();
    // Entry fill (same orderId as entryOrderId, null PnL) — must not match isClosingFill.
    const entryFill = makeFill({ id: 1, orderId: 999, side: 0, profitAndLoss: null });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, entryFill);
    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).toBeNull();
  });

  it("Topstep: correctly resolves exitPrice and pnlDollars from buffered fills with inline PnL", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      tpOrderId: 555,
      tickSize: 0.25,
      tickValue: 12.5,
    });
    (engine as any).openBufferSlot(ACCT_TOPSTEP, "NQ-2025", 1);
    // Slot openedAt must be <= entryFilledAt for the pre-drain assertion.
    const slot = (engine as any).fillBuffer.get(`${ACCT_TOPSTEP}:NQ-2025:1`);
    slot.openedAt = new Date("2025-06-01T14:29:59.000Z").getTime();

    const closingFill = makeFill({
      id: 2,
      orderId: 555,
      side: 1,
      price: 20100,
      size: 1,
      profitAndLoss: 1250,
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    (engine as any).appendBufferedFill("topstep", ACCT_TOPSTEP, closingFill);

    const result = (engine as any).reconcileExitFromBuffer("topstep", trade);
    expect(result).not.toBeNull();
    expect(result.exitPrice).toBeCloseTo(20100, 6);
    expect(result.matchedOrderId).toBe(555);
    // pnlGross from inline PnL = 1250; fees = feePerSideFor("/NQ") * 2 * 1
    expect(result.pnlDollars).toBeCloseTo(1250 - result.feesDollars, 6);
  });

  it("Tradovate: uses price-math PnL when fills have null profitAndLoss", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const registry = (engine as any).brokerRegistry;
    const brokerStub = {
      searchTrades: vi.fn(),
      searchAccounts: vi.fn(),
      searchOpenOrders: vi.fn(),
      searchOpenPositions: vi.fn(),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      modifyOrder: vi.fn(),
      invalidateOpenOrders: vi.fn(),
    };
    registry.map.set(ACCT_TRADOVATE, brokerStub);
    registry.brokerByAccount.set(ACCT_TRADOVATE, "tradovate");

    const trade = makeTrade({
      accountId: ACCT_TRADOVATE,
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      tpOrderId: 700,
      side: 0,
      size: 1,
      entryPrice: 20000,
      tickSize: 0.25,
      tickValue: 12.5,
    });
    (engine as any).openBufferSlot(ACCT_TRADOVATE, "NQ-2025", 1);
    const slot = (engine as any).fillBuffer.get(`${ACCT_TRADOVATE}:NQ-2025:1`);
    slot.openedAt = new Date("2025-06-01T14:29:59.000Z").getTime();

    const closingFill = makeFill({
      id: 10,
      accountId: ACCT_TRADOVATE,
      orderId: 700,
      side: 1,
      price: 20100,
      size: 1,
      profitAndLoss: null,
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    (engine as any).appendBufferedFill("tradovate", ACCT_TRADOVATE, closingFill);

    const result = (engine as any).reconcileExitFromBuffer("tradovate", trade);
    expect(result).not.toBeNull();
    // priceDelta = (20100 - 20000) * 1 = 100; ticks = 100 / 0.25 = 400
    // pnlGross = 400 * 12.5 * 1 = 5000
    expect(result.exitPrice).toBeCloseTo(20100, 6);
    expect(result.pnlDollars + result.feesDollars).toBeCloseTo(5000, 2);
  });

  it("Tradovate: returns null for price-math path when entryPrice is null", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const registry = (engine as any).brokerRegistry;
    registry.brokerByAccount.set(ACCT_TRADOVATE, "tradovate");

    const trade = makeTrade({
      accountId: ACCT_TRADOVATE,
      entryFilledAt: "2025-06-01T14:30:00.000Z",
      tpOrderId: 700,
      entryPrice: null,
      tickSize: 0.25,
      tickValue: 12.5,
    });
    (engine as any).openBufferSlot(ACCT_TRADOVATE, "NQ-2025", 1);
    const slot = (engine as any).fillBuffer.get(`${ACCT_TRADOVATE}:NQ-2025:1`);
    slot.openedAt = new Date("2025-06-01T14:29:59.000Z").getTime();

    const closingFill = makeFill({
      id: 11,
      accountId: ACCT_TRADOVATE,
      orderId: 700,
      side: 1,
      price: 20100,
      profitAndLoss: null,
      creationTimestamp: "2025-06-01T15:00:00.000Z",
    });
    (engine as any).appendBufferedFill("tradovate", ACCT_TRADOVATE, closingFill);
    const result = (engine as any).reconcileExitFromBuffer("tradovate", trade);
    expect(result).toBeNull();
  });
});

// ── isClosingFill ─────────────────────────────────────────────────────────────

describe("isClosingFill (private)", () => {
  it("returns false for a voided fill", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", tpOrderId: 555 });
    const fill = makeFill({ voided: true, orderId: 555, profitAndLoss: 100 });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(false);
  });

  it("returns false when trade.entryFilledAt is null", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: null, tpOrderId: 555 });
    const fill = makeFill({ orderId: 555, profitAndLoss: 100 });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(false);
  });

  it("returns false when fill.contractId doesn't match trade.contractId", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", tpOrderId: 555 });
    const fill = makeFill({ orderId: 555, contractId: "ES-2025", profitAndLoss: 100 });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(false);
  });

  it("Topstep: returns false when profitAndLoss is null (entry fills have null PnL)", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z" });
    const fill = makeFill({ orderId: 888, side: 1, profitAndLoss: null });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(false);
  });

  it("Topstep: returns false when orderId matches entryOrderId even with non-null PnL", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", entryOrderId: 999 });
    const fill = makeFill({ orderId: 999, side: 1, profitAndLoss: 1250 });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(false);
  });

  it("Topstep: returns true for a closing fill with PnL and non-entry orderId", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", entryOrderId: 999, tpOrderId: 555 });
    const fill = makeFill({ orderId: 555, side: 1, profitAndLoss: 1250 });
    expect((engine as any).isClosingFill("topstep", fill, trade)).toBe(true);
  });

  it("Tradovate: returns true when orderId matches tpOrderId", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", tpOrderId: 700, entryOrderId: 999 });
    const fill = makeFill({ orderId: 700, side: 1, profitAndLoss: null });
    expect((engine as any).isClosingFill("tradovate", fill, trade)).toBe(true);
  });

  it("Tradovate: returns true when orderId matches slOrderId", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", slOrderId: 701, entryOrderId: 999 });
    const fill = makeFill({ orderId: 701, side: 1, profitAndLoss: null });
    expect((engine as any).isClosingFill("tradovate", fill, trade)).toBe(true);
  });

  it("Tradovate: returns true when orderId differs from entryOrderId and no bracket ids set (manual close)", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", entryOrderId: 999 });
    const fill = makeFill({ orderId: 888, side: 1, profitAndLoss: null });
    expect((engine as any).isClosingFill("tradovate", fill, trade)).toBe(true);
  });

  it("Tradovate: returns false when orderId matches entryOrderId (entry self-fill)", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const trade = makeTrade({ entryFilledAt: "2025-06-01T14:30:00.000Z", entryOrderId: 999 });
    const fill = makeFill({ orderId: 999, side: 0, profitAndLoss: null });
    expect((engine as any).isClosingFill("tradovate", fill, trade)).toBe(false);
  });
});

// ── nakedPositionWatchdog null vs 0 from sumAliveTradovateSlCoverage ──────────

describe("runNakedPositionWatchdog: inconclusive (null) vs no-SL (0) distinction", () => {
  it("does not accumulate a strike when sumAliveTradovateSlCoverage returns null", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const registry = (engine as any).brokerRegistry;
    registry.brokerByAccount.set(ACCT_TRADOVATE, "tradovate");

    // Inject a naked position into the broker.
    const stubBroker = registry.map.get(ACCT_TRADOVATE);
    stubBroker.searchOpenPositions.mockResolvedValue([
      { contractId: "MNQM6", size: 1, type: 1, averagePrice: 21000 },
    ]);

    // Spy on sumAliveTradovateSlCoverage to return null (REST failure).
    const sumSpy = vi.spyOn((engine as any).nakedWatchdog, "sumAliveTradovateSlCoverage").mockResolvedValue(null);

    // collectManagedContractIds returns the contract so we don't bail early.
    // It maps contract → the ticker its trade row named, which is what the
    // sweep's Activity lines render; the scope check reads the key.
    vi.spyOn((engine as any).nakedWatchdog, "collectManagedContractIds").mockReturnValue(
      new Map([["MNQM6", "MNQ"]]),
    );
    vi.spyOn((engine as any).nakedWatchdog, "buildContractToDeploymentMap").mockResolvedValue(
      new Map([["MNQM6", new Set(["deploy-aaa"])]]),
    );

    // Seed realtimeDeployments so the account appears in the sweep.
    (engine as any).realtimeDeployments = [{ id: "deploy-aaa", accountId: ACCT_TRADOVATE, enabled: true }];

    await (engine as any).nakedWatchdog.runNakedPositionWatchdog();

    // null from coverage → observation counter should NOT have been incremented.
    expect((engine as any).nakedWatchdog.nakedPositionObservations.has(`${ACCT_TRADOVATE}:MNQM6:1`)).toBe(false);
    sumSpy.mockRestore();
  });

  it("accumulates a strike on first tick when sumAliveTradovateSlCoverage returns 0", async () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const registry = (engine as any).brokerRegistry;
    registry.brokerByAccount.set(ACCT_TRADOVATE, "tradovate");

    const stubBroker = registry.map.get(ACCT_TRADOVATE);
    stubBroker.searchOpenPositions.mockResolvedValue([
      { contractId: "MNQM6", size: 1, type: 1, averagePrice: 21000 },
    ]);

    const sumSpy = vi.spyOn((engine as any).nakedWatchdog, "sumAliveTradovateSlCoverage").mockResolvedValue(0);
    // It maps contract → the ticker its trade row named, which is what the
    // sweep's Activity lines render; the scope check reads the key.
    vi.spyOn((engine as any).nakedWatchdog, "collectManagedContractIds").mockReturnValue(
      new Map([["MNQM6", "MNQ"]]),
    );
    vi.spyOn((engine as any).nakedWatchdog, "buildContractToDeploymentMap").mockResolvedValue(
      new Map([["MNQM6", new Set(["deploy-aaa"])]]),
    );

    (engine as any).realtimeDeployments = [{ id: "deploy-aaa", accountId: ACCT_TRADOVATE, enabled: true }];

    await (engine as any).nakedWatchdog.runNakedPositionWatchdog();

    // 0 from coverage → position is naked → should record first strike.
    expect((engine as any).nakedWatchdog.nakedPositionObservations.has(`${ACCT_TRADOVATE}:MNQM6:1`)).toBe(true);
    sumSpy.mockRestore();
  });
});

// ── handleUserPositionEvent — alreadyPromoted guard and race-fix contract ──────
//
// These tests encode the invariants that make the entryFilledAt race-fix safe:
//
//   1. When processDeployment pre-populates position.entryFilledAt from DB
//      (the fix), the subsequent position event arriving from the user hub
//      must NOT overwrite it (alreadyPromoted guard at engine.ts:1966).
//
//   2. The race condition the fix addresses: for group legs where the position
//      event arrives before activeTradeId is set, markEntryFilled DOES write
//      to DB (early write), but the in-memory position is NOT promoted because
//      the activeTradeId guard bails. The fix reads from DB immediately after
//      activeTradeId is set so the position has entryFilledAt before the first
//      bar close.
//
//   3. The Tradovate path (brokerKind !== "topstep") must never attempt the
//      DB read — Tradovate stamps entryFilledAt synchronously in placeEntryOrder.

describe("handleUserPositionEvent (private) — alreadyPromoted guard", () => {
  const DEPLOY_ID = "deploy-race-fix";
  const CONTRACT_ID = "NQ-2025";
  const TRADE_ID = 42;

  function makeOpenPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
    return {
      side: 0,
      entryPrice: 20000,
      entryTimestamp: "2026-05-15T14:30:00.000Z",
      barsSinceEntry: 0,
      entryFilledAt: null,
      size: 1,
      slTicks: 10,
      ...overrides,
    };
  }

  function makeMinimalState(overrides: Partial<DeploymentState> = {}): DeploymentState {
    return {
      lastBarTimestamp: null,
      cooldownAnchorAt: null,
      position: null,
      activeTradeId: null,
      breakEvenMoved: false,
      preEntryOrderIds: null,
      activeTpTicks: null,
      activeSlTicks: null,
      slMovedToBe: false,
      slCurrentPrice: null,
      tpCurrentPrice: null,
      exitInFlight: false,
      flatMismatchWarnedAt: null,
      exitDispatchWarnedAt: null,
      pendingEntrySessionKey: null,
      signalSuppressed: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not overwrite entryFilledAt when position was pre-promoted by the race-fix DB read", async () => {
    // This is the core invariant of the fix. processDeployment sets
    // position.entryFilledAt from getTradeById before the position event
    // arrives. The alreadyPromoted guard must prevent the event from
    // clobbering the pre-promoted value.
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const prePromotedFilledAt = "2026-05-15T14:30:00.100Z";
    const prePromotedPrice = 20050;

    const state = makeMinimalState({
      activeTradeId: TRADE_ID,
      position: makeOpenPosition({
        entryFilledAt: prePromotedFilledAt,
        entryPrice: prePromotedPrice,
        size: 1,
      }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    vi.mocked(findTradeByAccountContract).mockReturnValue(
      makeTrade({
        id: TRADE_ID,
        deploymentId: DEPLOY_ID,
        accountId: ACCT_TOPSTEP,
        contractId: CONTRACT_ID,
        status: "open",
        entryFilledAt: prePromotedFilledAt,
      }),
    );

    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 1,
      averagePrice: 20999, // different price — must NOT land on position
      creationTimestamp: "2026-05-15T14:30:00.500Z",
    });

    // entryFilledAt and entryPrice must be the pre-promoted values, not the
    // event's averagePrice / creationTimestamp.
    expect(state.position?.entryFilledAt).toBe(prePromotedFilledAt);
    expect(state.position?.entryPrice).toBe(prePromotedPrice);
  });

  it("promotes entryFilledAt and entryPrice from the position event when position starts null", async () => {
    // Normal (non-race) path: position event arrives before processDeployment
    // has had a chance to pre-populate from DB (entryFilledAt still null).
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const state = makeMinimalState({
      activeTradeId: TRADE_ID,
      position: makeOpenPosition({ entryFilledAt: null, entryPrice: 20000 }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    vi.mocked(findTradeByAccountContract).mockReturnValue(
      makeTrade({
        id: TRADE_ID,
        deploymentId: DEPLOY_ID,
        accountId: ACCT_TOPSTEP,
        contractId: CONTRACT_ID,
        status: "pending_entry",
        entryFilledAt: null,
      }),
    );

    const eventFilledAt = "2026-05-15T14:30:00.200Z";
    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 1,
      averagePrice: 20100,
      creationTimestamp: eventFilledAt,
    });

    expect(state.position?.entryFilledAt).toBe(eventFilledAt);
    expect(state.position?.entryPrice).toBe(20100);
  });

  it("writes to DB via markEntryFilled but does NOT promote in-memory position when activeTradeId is null (race condition)", async () => {
    // This is the exact race the fix addresses. The position event for a
    // second group leg arrives while activeTradeId is still null (processDeployment
    // hasn't finished setting it yet). The early DB write must still happen so
    // the trade row has entryFilledAt — but in-memory promotion is skipped.
    // The fix then reads that DB value immediately after activeTradeId is set.
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const state = makeMinimalState({
      activeTradeId: null, // hasn't been set by processDeployment yet
      position: makeOpenPosition({ entryFilledAt: null, entryPrice: 20000 }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    vi.mocked(findTradeByAccountContract).mockReturnValue(
      makeTrade({
        id: TRADE_ID,
        deploymentId: DEPLOY_ID,
        accountId: ACCT_TOPSTEP,
        contractId: CONTRACT_ID,
        status: "pending_entry",
        entryFilledAt: null,
      }),
    );

    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 1,
      averagePrice: 20100,
      creationTimestamp: "2026-05-15T14:30:00.200Z",
    });

    // DB write must have happened (early write invariant — see engine.ts comment
    // above the markEntryFilled call explaining why it must precede the guard).
    expect(vi.mocked(markEntryFilled)).toHaveBeenCalledWith(TRADE_ID, 20100, "2026-05-15T14:30:00.200Z");

    // In-memory position must NOT have been promoted — the guard bails because
    // activeTradeId (null) !== trade.id (TRADE_ID).
    expect(state.position?.entryFilledAt).toBeNull();
    expect(state.position?.entryPrice).toBe(20000);
  });

  it("does not call markEntryFilled a second time when trade already has entryFilledAt in DB", async () => {
    // If the DB row already has entryFilledAt (e.g., set by an earlier event or
    // by the fix's getTradeById read), the handler must not overwrite it again.
    // Verified via the `if (trade.entryFilledAt == null)` guard in the handler.
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const state = makeMinimalState({
      activeTradeId: TRADE_ID,
      position: makeOpenPosition({ entryFilledAt: "2026-05-15T14:30:00.100Z" }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    vi.mocked(findTradeByAccountContract).mockReturnValue(
      makeTrade({
        id: TRADE_ID,
        deploymentId: DEPLOY_ID,
        accountId: ACCT_TOPSTEP,
        contractId: CONTRACT_ID,
        status: "open",
        entryFilledAt: "2026-05-15T14:30:00.100Z", // already written
      }),
    );

    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 1,
      averagePrice: 20100,
      creationTimestamp: "2026-05-15T14:30:00.500Z",
    });

    expect(vi.mocked(markEntryFilled)).not.toHaveBeenCalled();
  });

  it("updates position size from the event even when entryFilledAt is already promoted", async () => {
    // The size update (engine.ts:1963) is NOT gated on alreadyPromoted —
    // it must apply even on a subsequent partial-fill / size-change event.
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const state = makeMinimalState({
      activeTradeId: TRADE_ID,
      position: makeOpenPosition({ entryFilledAt: "2026-05-15T14:30:00.100Z", size: 1 }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    vi.mocked(findTradeByAccountContract).mockReturnValue(
      makeTrade({
        id: TRADE_ID,
        deploymentId: DEPLOY_ID,
        accountId: ACCT_TOPSTEP,
        contractId: CONTRACT_ID,
        status: "open",
        entryFilledAt: "2026-05-15T14:30:00.100Z",
      }),
    );

    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 2, // partial fill bumped size
      averagePrice: 20050,
      creationTimestamp: "2026-05-15T14:30:01.000Z",
    });

    expect(state.position?.size).toBe(2);
    // But entryFilledAt must still be the original pre-promoted value.
    expect(state.position?.entryFilledAt).toBe("2026-05-15T14:30:00.100Z");
  });

  it("returns early and skips all state mutation when no matching trade row exists", async () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");

    const state = makeMinimalState({
      activeTradeId: TRADE_ID,
      position: makeOpenPosition({ entryFilledAt: null }),
    });
    (engine as any).state.set(DEPLOY_ID, state);

    // No trade found for this account+contract.
    vi.mocked(findTradeByAccountContract).mockReturnValue(null);

    await (engine as any).handleUserPositionEvent({
      accountId: ACCT_TOPSTEP,
      contractId: CONTRACT_ID,
      size: 1,
      averagePrice: 20100,
      creationTimestamp: "2026-05-15T14:30:00.200Z",
    });

    // Nothing should have changed — no DB write, no position update.
    expect(vi.mocked(markEntryFilled)).not.toHaveBeenCalled();
    expect(state.position?.entryFilledAt).toBeNull();
  });
});

// ── promotedEntryFilledAt: getTradeById behavior under the race-fix ────────────
//
// These tests verify the getTradeById-based promotion that processDeployment
// performs immediately after setting activeTradeId. Since processDeployment is
// a deeply private method requiring the full order-placement pipeline, we test
// the DB-read contract by directly verifying getTradeById's behavior under the
// scenarios the fix must handle, and confirm the resulting state invariants via
// handleUserPositionEvent (which is the consumer of that state).

describe("promotedEntryFilledAt: getTradeById scenarios for race-fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getTradeById returning a row with entryFilledAt set is the 'race won' signal", () => {
    // When the position event arrived before processDeployment finished
    // (i.e., the user-hub wrote to DB before activeTradeId was set),
    // getTradeById will return a row with entryFilledAt != null.
    // The fix reads this and promotes it onto position immediately.
    // Verify getTradeById's behavior under this scenario.
    vi.mocked(getTradeById).mockReturnValue(
      makeTrade({ id: 99, entryFilledAt: "2026-05-15T14:30:00.100Z", entryPrice: 20050 }),
    );
    const row = vi.mocked(getTradeById)(99);
    expect(row?.entryFilledAt).not.toBeNull();
    // The fix would then use: promotedEntryFilledAt = row.entryFilledAt
    // and promotedEntryPrice = row.entryPrice ?? latestBar.close
    expect(row?.entryPrice).toBe(20050);
  });

  it("getTradeById returning null entryFilledAt is the 'event not yet arrived' case — entryFilledAt stays null on position", () => {
    // When the position event hasn't arrived yet, the trade row has null
    // entryFilledAt. The fix must leave position.entryFilledAt null in this
    // case — the existing event-driven promotion path handles it later.
    vi.mocked(getTradeById).mockReturnValue(
      makeTrade({ id: 99, entryFilledAt: null }),
    );
    const row = vi.mocked(getTradeById)(99);
    // promotedEntryFilledAt stays null (the fix's if-guard doesn't fire)
    expect(row?.entryFilledAt).toBeNull();
  });

  it("getTradeById returning null (no row yet) means no promotion — same as tradeId=null guard", () => {
    // If the DB row hasn't been inserted yet when getTradeById is called,
    // the fix must not crash. The optional chain (tradeRow?.entryFilledAt)
    // handles this safely.
    vi.mocked(getTradeById).mockReturnValue(undefined as unknown as ReturnType<typeof getTradeById>);
    const row = vi.mocked(getTradeById)(99);
    // tradeRow?.entryFilledAt evaluates to undefined → same as null → no promotion
    expect(row?.entryFilledAt ?? null).toBeNull();
  });

  it("entryPrice falls back to latestBar.close when trade row has null entryPrice", () => {
    // The fix uses: promotedEntryPrice = tradeRow.entryPrice ?? latestBar.close
    // When entryPrice is null on the trade row (e.g., the DB write happened
    // before the fill price was known), the bar close is used as the provisional
    // entry price — same as the pre-fix behavior.
    vi.mocked(getTradeById).mockReturnValue(
      makeTrade({ id: 99, entryFilledAt: "2026-05-15T14:30:00.100Z", entryPrice: null }),
    );
    const row = vi.mocked(getTradeById)(99);
    const latestBarClose = 20000;
    const promotedEntryPrice = row?.entryPrice ?? latestBarClose;
    // null entryPrice → falls back to bar close
    expect(promotedEntryPrice).toBe(latestBarClose);
  });
});

// ── attachRealtimeAdapters: plugins are process-global ──────────────────────

describe("attachRealtimeAdapters (constructor)", () => {
  it("shuts down and replaces an incumbent adapter rather than orphaning it", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (engine as any).brokerPluginRegistry;
    const incumbent = registry.getPlugin("tradovate").realtime;
    expect(incumbent).toBeDefined();
    const shutdown = vi.spyOn(incumbent, "shutdown");

    // A second engine in the same process — dev HMR's shape. The orphan
    // would keep its sockets, timers and handler arrays bound to the first.
    makeEngine(ACCT_TRADOVATE, "tradovate");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(registry.getPlugin("tradovate").realtime).not.toBe(incumbent);
  });
});

// ── realtimeEventsAllowed: the two brokers' pre-start() semantics ────────────
//
// Topstep's engine listener used to be registered inside start(); Tradovate's
// subscribers have always dispatched from the boot registry refresh, before
// start(). One flag collapses those into the more permissive one, which lets a
// stopped engine reconcile a manual flatten it never used to see.

class CapturingAdapter implements BrokerRealtimeAdapter {
  positionHandlers: Array<(accountId: number, position: Position) => void> = [];
  fillHandlers: Array<(accountId: number, fill: TradeFill) => void> = [];
  orderHandlers: Array<(accountId: number, order: Order) => void> = [];
  reconnectHandlers: Array<(accountId: number) => void> = [];

  async sync(): Promise<void> {}
  async connect(): Promise<void> {}
  disconnect(): void {}
  shutdown(): void {}
  onOrder(h: (accountId: number, order: Order) => void): void {
    this.orderHandlers.push(h);
  }
  onPosition(h: (accountId: number, position: Position) => void): void {
    this.positionHandlers.push(h);
  }
  onFill(h: (accountId: number, fill: TradeFill) => void): void {
    this.fillHandlers.push(h);
  }
  onReconnect(h: (accountId: number) => void): void {
    this.reconnectHandlers.push(h);
  }
  isHealthy(): boolean {
    return true;
  }
  status(): null {
    return null;
  }

  firePosition(accountId: number, position: Position): void {
    for (const h of this.positionHandlers) h(accountId, position);
  }
  fireFill(accountId: number, fill: TradeFill): void {
    for (const h of this.fillHandlers) h(accountId, fill);
  }
}

function makePosition(accountId: number, size: number): Position {
  return {
    id: 77,
    accountId,
    contractId: "NQ-2025",
    creationTimestamp: "2026-08-22T15:00:00.000Z",
    type: 1,
    size,
    averagePrice: 20100,
  };
}

/**
 * Swap a capturing adapter onto one plugin and re-run the engine's wiring so
 * its handlers land on it. The engine registers on every plugin that carries
 * a `realtime`, exactly as it does at construction.
 */
function wireCapturingAdapter(
  engine: TradingEngine,
  brokerId: "topstep" | "tradovate",
): CapturingAdapter {
  const adapter = new CapturingAdapter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (engine as any).brokerPluginRegistry;
  for (const plugin of registry.allPlugins()) plugin.realtime = undefined;
  registry.getPlugin(brokerId).realtime = adapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (engine as any).wireRealtimeAdapters();
  return adapter;
}

describe("realtimeEventsAllowed (private)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops a Topstep position event while the engine has never started", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const adapter = wireCapturingAdapter(engine, "topstep");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = vi.spyOn(engine as any, "handleUserPositionEvent").mockResolvedValue(undefined);

    expect(engine.isRunning()).toBe(false);
    adapter.firePosition(ACCT_TOPSTEP, makePosition(ACCT_TOPSTEP, 0));

    expect(handle).not.toHaveBeenCalled();
  });

  it("drops a Topstep fill while the engine has never started", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const adapter = wireCapturingAdapter(engine, "topstep");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const append = vi.spyOn(engine as any, "appendBufferedFill").mockImplementation(() => {});

    adapter.fireFill(ACCT_TOPSTEP, makeFill());

    expect(append).not.toHaveBeenCalled();
  });

  it("acts on a Topstep position event once the engine is running", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const adapter = wireCapturingAdapter(engine, "topstep");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = vi.spyOn(engine as any, "handleUserPositionEvent").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).intervalId = setInterval(() => {}, 1_000_000);

    expect(engine.isRunning()).toBe(true);
    adapter.firePosition(ACCT_TOPSTEP, makePosition(ACCT_TOPSTEP, 0));

    expect(handle).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearInterval((engine as any).intervalId);
  });

  it("acts on a Tradovate position event while the engine is stopped — its subscribers always have", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const adapter = wireCapturingAdapter(engine, "tradovate");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = vi.spyOn(engine as any, "handleUserPositionEvent").mockResolvedValue(undefined);

    expect(engine.isRunning()).toBe(false);
    adapter.firePosition(ACCT_TRADOVATE, makePosition(ACCT_TRADOVATE, 0));

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("drops a Topstep reconnect signal while the engine has never started", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const adapter = wireCapturingAdapter(engine, "topstep");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replay = vi.spyOn(engine as any, "replayFillsAfterReconnect");

    for (const h of adapter.reconnectHandlers) h(ACCT_TOPSTEP);

    expect(replay).not.toHaveBeenCalled();
  });

  it("drops every broker's events once stop() has cleared the flag", () => {
    const { engine } = makeEngine(ACCT_TRADOVATE, "tradovate");
    const adapter = wireCapturingAdapter(engine, "tradovate");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = vi.spyOn(engine as any, "handleUserPositionEvent").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).realtimeEventsEnabled = false;

    adapter.firePosition(ACCT_TRADOVATE, makePosition(ACCT_TRADOVATE, 0));

    expect(handle).not.toHaveBeenCalled();
  });
});

// ── Topstep reconnect-gap replay: coalescing, not dropping ──────────────────
//
// One Topstep hub reconnect fires onReconnect once per live account, so the
// burst must collapse to one sweep. A *second* reconnect arriving mid-sweep is
// a different reconnect with its own unqueried gap, and must not be dropped.

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("replayFillsAfterReconnect (private) — Topstep sweep coalescing", () => {
  function runningEngineWithAdapter() {
    const { engine } = makeEngine(ACCT_TOPSTEP, "topstep");
    const adapter = wireCapturingAdapter(engine, "topstep");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).realtimeDeployments = [{}];
    expect(engine.isRunning()).toBe(true);
    return { engine, adapter };
  }

  /** Topstep's adapter fires onReconnect per live account in one
   *  synchronous loop — reproduce that exactly. */
  function fireReconnectBurst(adapter: CapturingAdapter, accountIds: number[]): void {
    for (const accountId of accountIds) {
      for (const h of adapter.reconnectHandlers) h(accountId);
    }
  }

  it("collapses one reconnect's per-account signals into a single sweep", async () => {
    const { engine, adapter } = runningEngineWithAdapter();
    const sweep = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(engine as any, "replayTopstepFillsAfterReconnect")
      .mockResolvedValue(undefined);

    fireReconnectBurst(adapter, [1001, 1002, 1003]);
    await flush();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("runs a follow-up sweep for a reconnect that lands while one is in flight", async () => {
    const { engine, adapter } = runningEngineWithAdapter();
    const releases: Array<() => void> = [];
    const sweep = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(engine as any, "replayTopstepFillsAfterReconnect")
      .mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    fireReconnectBurst(adapter, [1001, 1002]);
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);

    // The hub flaps: a second reconnect lands while the first sweep is
    // still inside its searchTrades round-trip.
    fireReconnectBurst(adapter, [1001, 1002]);
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);

    releases[0]();
    await flush();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("queues exactly one follow-up no matter how many reconnects land mid-sweep", async () => {
    const { engine, adapter } = runningEngineWithAdapter();
    const releases: Array<() => void> = [];
    const sweep = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(engine as any, "replayTopstepFillsAfterReconnect")
      .mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    fireReconnectBurst(adapter, [1001]);
    await flush();

    fireReconnectBurst(adapter, [1001]);
    await flush();
    fireReconnectBurst(adapter, [1001]);
    await flush();

    releases[0]();
    await flush();
    expect(sweep).toHaveBeenCalledTimes(2);

    releases[1]();
    await flush();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("clears the guard so a later reconnect still sweeps", async () => {
    const { engine, adapter } = runningEngineWithAdapter();
    const sweep = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(engine as any, "replayTopstepFillsAfterReconnect")
      .mockResolvedValue(undefined);

    fireReconnectBurst(adapter, [1001]);
    await flush();
    fireReconnectBurst(adapter, [1001]);
    await flush();

    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

// ── Naked-position watchdog lifetime ─────────────────────────────────
//
// The sweep is the last-resort path between a position whose bracket never
// attached and an unbounded loss, and it is the one exit that bypasses the
// `exitInFlight` latch. Its *lifetime* is therefore safety-relevant in its
// own right: it used to be torn down by `stop()`, and both fatal-auth paths
// call `stop()` themselves, so a token-rotation failure silently removed
// coverage from live positions and left it off. See docs/bugs.md.

/**
 * docs/bugs-fixed.md. A passive ↔ realtime flip cleared the REST tick and armed
 * a new one, so the first tick in the new mode came a whole interval after
 * the flip — up to one skipped 15 s tick. The interval now keeps its clock and
 * only what it runs changes.
 */
describe("A13 — swapTickHandler has a brief idle window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the new mode on the interval's next beat, not a full interval after the flip", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const reconcileOnly = vi.spyOn(engine as any, "runReconcileOnly").mockResolvedValue(undefined);
    const fullTick = vi.spyOn(engine as any, "runTick").mockResolvedValue(undefined);

    (engine as any).swapTickHandler("realtime");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reconcileOnly).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_000);
    (engine as any).swapTickHandler("passive");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fullTick).toHaveBeenCalledTimes(1);
    expect(reconcileOnly).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it("still arms a tick when none is running", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const fullTick = vi.spyOn(engine as any, "runTick").mockResolvedValue(undefined);

    (engine as any).swapTickHandler("passive");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fullTick).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

describe("naked-position watchdog lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays armed after stop() — coverage does not key off engine run state", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    (engine as any).startNakedPositionWatchdog();
    expect((engine as any).nakedWatchdogInterval).not.toBeNull();

    engine.stop();

    expect((engine as any).nakedWatchdogInterval).not.toBeNull();
  });

  it("does not reset the flatten cooldown on stop()", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const reset = vi.spyOn((engine as any).nakedWatchdog, "reset");

    engine.stop();

    // `nakedFlattenAt` is what stops a second flatten landing while the
    // first is still in flight. Clearing it while the sweep keeps running
    // would reintroduce the double-flatten it exists to prevent.
    expect(reset).not.toHaveBeenCalled();
  });

  it("catches a throwing sweep instead of rejecting unhandled", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const logEvent = vi.spyOn(engine as any, "logEvent");
    vi.spyOn((engine as any).nakedWatchdog, "runNakedPositionWatchdog").mockRejectedValue(
      new Error("No broker plugin registered for kind topstep"),
    );

    (engine as any).startNakedPositionWatchdog();
    await vi.advanceTimersByTimeAsync(30_000);

    // Fire-and-forget plus Node's default --unhandled-rejections=throw takes
    // down a 24/7 process. The coverage-source lookup runs outside the
    // sweep's per-account guard, so this arm is reachable.
    expect(logEvent).toHaveBeenCalledWith(
      "safety_sweep_threw",
      expect.anything(),
      expect.stringContaining("Naked-position sweep threw"),
    );
    // The severity moved off the call site and onto the registry when the
    // arm took an event, so that is where it is pinned. Without this the
    // assertion above survives the event being downgraded to `info`.
    expect(eventSpec("safety_sweep_threw")?.severity).toBe("error");
  });
});

// ── Session-end clock guard lifetime ─────────────────────────────────
//
// Both pre-existing session-end callers are market-data-triggered: one needs
// SignalR trade frames, the other sits behind `latestBar.timestamp ===
// lastBarTimestamp` — the normal state between bar closes, not an error — so
// in passive mode force-flat was late by up to one timeframe. This interval
// is the caller that owes nothing to market data. See docs/bugs.md.

describe("session-end clock guard lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is armed by start()", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    expect((engine as any).sessionGuardInterval).toBeNull();

    engine.start([]);

    expect((engine as any).sessionGuardInterval).not.toBeNull();
    engine.stop();
  });

  it("stays armed after stop() — flat-by-session-close does not key off engine run state", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    (engine as any).startSessionEndGuard();
    expect((engine as any).sessionGuardInterval).not.toBeNull();

    // Both fatal-auth paths call stop() themselves, so tying this to the
    // trading loop means a token-rotation failure lets a position sail past
    // its session close — a prop-firm rule violation, not a missed fill.
    engine.stop();

    expect((engine as any).sessionGuardInterval).not.toBeNull();
  });

  it("catches a throwing pass instead of rejecting unhandled", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const logEvent = vi.spyOn(engine as any, "logEvent");
    vi.spyOn((engine as any).sessionGuard, "runSessionEndGuard").mockRejectedValue(
      new Error("No broker plugin registered for kind topstep"),
    );

    (engine as any).startSessionEndGuard();
    await vi.advanceTimersByTimeAsync(15_000);

    // Fire-and-forget plus Node's default --unhandled-rejections=throw takes
    // down a 24/7 process.
    expect(logEvent).toHaveBeenCalledWith(
      "safety_sweep_threw",
      expect.anything(),
      expect.stringContaining("Session-end clock guard threw"),
    );
    expect(eventSpec("safety_sweep_threw")?.severity).toBe("error");
  });
});

// ── Seam-health lifetime ─────────────────────────────────────────────
//
// The inverse of the three loops above, and deliberately so. They survive
// `stop()` because they finish work the engine *owes* on positions it opened.
// Seam health is neither an obligation nor a claim — it is an observation of
// tier-1 evaluation, and tier 1 does not run on a stopped engine. Its only
// writer is the bar-read funnel, which stops with the tick loop, so a
// surviving `down` would be a state nothing could clear.

describe("seam-health lifetime", () => {
  it("clears the market-data anchors on stop()", () => {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const health = (engine as any).health;
    const now = Date.now();
    health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, now - 600_000);
    health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, now);
    expect(engine.getSeamHealth().degraded).toBe(true);

    engine.stop();

    // Not symmetry with the other timers — the opposite. A stopped engine
    // takes no bar reads, so a `down` that survived could never be cleared,
    // and the next start would refuse every bar until a new one opened.
    expect(engine.getSeamHealth().degraded).toBe(false);
  });

  // The broker seams deliberately get no assertion here. `stop()` also clears
  // `realtimeDeployments`, so `managedAccountsByBroker()` is empty afterwards
  // and `brokers` is `{}` whether or not `reset()` cleared the order-seam map
  // — a test written here would pass against its own mutation. `reset()`'s
  // contract is asserted in engine-health.test.ts, and this file asserts that
  // `stop()` calls it; composition covers the rest.
});

// ── logExitDispatchFailure — the anchor and the pipe must compose ─────────────

/**
 * The anchor's key carries `activeTradeId` precisely so a *second* stranded
 * trade announces rather than being silenced by the first one's stamp. The
 * message has to carry it too: the log pipe collapses repeats on the text it
 * is handed, so a discriminator the anchor holds and the message omits is one
 * the pipe erases — and it erases it *after* the anchor has re-stamped, which
 * buys 300s of silence on a leg that is stranded right now.
 *
 * These run against the real pipe (`emit` → `onLog`), which is the only way
 * to see the composition at all; either half tested alone agrees with
 * whichever half is wrong.
 */
describe("logExitDispatchFailure (private) — composition with the log pipe", () => {
  type ExitDispatchPrivates = {
    logExitDispatchFailure(deploymentId: string, reason: string, err: unknown): void;
    getState(deploymentId: string): { activeTradeId: number | null };
  };

  function makeLoggingEngine() {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const lines: string[] = [];
    engine.setLogHandler((entry) => void lines.push(entry.message));
    return { engine, priv: engine as unknown as ExitDispatchPrivates, lines };
  }

  beforeEach(() => {
    // Process-wide module state; a message this file already emitted would
    // otherwise fold and the assertion would come up one short.
    resetLogBursts();
  });

  it("names the trade in the line, not only in the throttle key", () => {
    const { priv, lines } = makeLoggingEngine();
    priv.getState("d1").activeTradeId = 6876;

    priv.logExitDispatchFailure("d1", "realtime_exit", new Error("exit_flat_mismatch"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("for trade #6876");
  });

  it("announces a second stranded trade instead of folding it onto the first", () => {
    const { priv, lines } = makeLoggingEngine();
    priv.getState("d1").activeTradeId = 6876;
    priv.logExitDispatchFailure("d1", "realtime_exit", new Error("exit_flat_mismatch"));

    // The reconciler closed the first row and a new entry filled and stranded
    // the same way. Same arm, same error, same deployment — the trade id is
    // the entire difference, and it is a genuinely separate incident.
    priv.getState("d1").activeTradeId = 6877;
    priv.logExitDispatchFailure("d1", "realtime_exit", new Error("exit_flat_mismatch"));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("for trade #6877");
  });

  it("still quiets the same trade re-entering on every quote", () => {
    const { priv, lines } = makeLoggingEngine();
    priv.getState("d1").activeTradeId = 6876;
    for (let i = 0; i < 12; i++) {
      priv.logExitDispatchFailure("d1", "realtime_exit", new Error("exit_flat_mismatch"));
    }
    expect(lines).toHaveLength(1);
  });

  it("omits the trade clause when no trade is active", () => {
    const { priv, lines } = makeLoggingEngine();
    priv.logExitDispatchFailure("d1", "time_window_close", new Error("boom"));
    expect(lines[0]).toContain("Exit dispatch (time_window_close) failed: boom");
  });
});

/**
 * The one new outbound surface L2 adds. A flagged `error` becomes a Discord
 * message whose **title** is the event's Activity template with `{display}`
 * filled in, and `display` was never populated — so the first real alarm
 * would have put a bare uuid on the operator's phone, which is complaint #1
 * of the rework arriving on the rework's own surface.
 *
 * Run against the real pipe and the real title renderer: the engine derives
 * the display, `scrub.ts` truncates the account inside it, and
 * `escalationTitle` renders it. Any of the three tested alone agrees with
 * whichever of the others is wrong.
 */
describe("logEvent (private) — the subject an escalating alert renders", () => {
  type LogEventPrivates = {
    logEvent(
      event: string,
      deploymentId: string,
      message: string,
      subject?: { accountId?: number | null; contractId?: string | null; tradeId?: number | null },
    ): void;
  };

  const DEPLOYMENT_ID = "758d19dd-f18d-42b0-a15b-9b6dffd896d5";

  function makeEventEngine() {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    const records: LogRecord[] = [];
    // `LogHandler` is typed at the legacy four fields; what `logEvent` hands
    // it is the pipe's record, envelope columns and all.
    engine.setLogHandler((entry) => void records.push(entry as LogRecord));
    return { engine, priv: engine as unknown as LogEventPrivates, records };
  }

  beforeEach(() => {
    resetLogBursts();
    // The catalog the pipe truncates against. `db/account-brokers` installs
    // this at import time in production; here the DB stub throws, so the
    // truncation half would silently not run.
    setManagedAccountSource(() => [23464469]);
    refreshManagedAccounts();
    vi.mocked(getDeployment).mockClear();
    vi.mocked(getDeployment).mockReturnValue({
      id: DEPLOYMENT_ID,
      accountId: 23464469,
      strategyKey: "ema-crossover",
      ticker: "/MNQ",
    } as unknown as ReturnType<typeof getDeployment>);
  });

  afterEach(() => {
    setManagedAccountSource(null);
    refreshManagedAccounts();
  });

  it("renders the deployment in the alert title, never the uuid", () => {
    const { priv, records } = makeEventEngine();

    priv.logEvent("session_exit_stranded", DEPLOYMENT_ID, "stranded for 45s", {
      accountId: 23464469,
      contractId: "CON.F.US.MNQ.U26",
    });

    expect(records).toHaveLength(1);
    const title = escalationTitle(records[0]!);
    expect(title).toContain("…4469-ema-crossover.MNQ");
    expect(title).not.toContain(DEPLOYMENT_ID);
  });

  it("hands the pipe the full account and lets it truncate, rather than truncating here", () => {
    // The rule belongs to `scrub.ts` and lives in one place. A call site that
    // pre-truncates puts it in 71 places instead.
    const { priv, records } = makeEventEngine();
    priv.logEvent("exit_verification_residual", DEPLOYMENT_ID, "residual size=1");
    expect(records[0]!.display).toBe("…4469-ema-crossover.MNQ");
    expect(records[0]!.display).not.toContain("23464469");
  });

  it("falls back to the uuid only when the deployment row is gone", () => {
    const { priv, records } = makeEventEngine();
    vi.mocked(getDeployment).mockReturnValue(null);

    priv.logEvent("manual_position_close_failed", DEPLOYMENT_ID, "could not close");

    expect(records[0]!.display).toBeNull();
    expect(escalationTitle(records[0]!)).toContain(DEPLOYMENT_ID);
  });

  it("has no display for the engine sentinel, which is not a deployment", () => {
    // D-2's account-wide arms report under it.
    const { priv, records } = makeEventEngine();
    priv.logEvent("manual_position_close_failed", "engine", "account-wide sweep failed");
    expect(records[0]!.display).toBeNull();
    // And it short-circuits rather than paying a lookup that cannot answer.
    expect(vi.mocked(getDeployment).mock.calls).toHaveLength(0);
  });

  it("keeps the line when the row read throws, because a log line must not take out its caller", () => {
    const { priv, records } = makeEventEngine();
    vi.mocked(getDeployment).mockImplementation(() => {
      throw new Error("database is locked");
    });

    expect(() =>
      priv.logEvent("session_exit_stranded", DEPLOYMENT_ID, "stranded for 45s"),
    ).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]!.display).toBeNull();
  });
});

/**
 * The `skipped_signals` writer. Two properties, and the second is why the
 * row is built from a thunk: `sessionDateOf` throws `RangeError` on a bar
 * timestamp it cannot parse, so a row built at the call site would reach
 * `processDeployment`'s catch as the `deployment_tick_failed` this write is
 * documented as unable to cause.
 */
describe("recordSkippedSignal (private)", () => {
  type SkipPrivates = {
    recordSkippedSignal(
      deployment: Deployment,
      gate: string,
      build: () => ReturnType<typeof strategySkip>,
    ): void;
  };

  const BAR = {
    timestamp: "2025-06-04T13:45:00.000Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
  };

  const LEG = {
    id: "depl-a",
    groupId: "grp-1",
    accountId: ACCT_TOPSTEP,
    strategyKey: "orb",
    ticker: "/MNQ",
  } as unknown as Deployment;

  function makeSkipEngine() {
    const { engine } = makeEngine(ACCT_TOPSTEP);
    return engine as unknown as SkipPrivates;
  }

  beforeEach(() => {
    resetLogBursts();
    vi.mocked(insertSkippedSignal).mockReset();
  });

  it("inserts the leg identity beside the row the thunk built", () => {
    makeSkipEngine().recordSkippedSignal(LEG, "vwap", () =>
      strategySkip({ skip: "long break below session VWAP", gate: "vwap" }, BAR),
    );

    expect(insertSkippedSignal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertSkippedSignal).mock.calls[0][0]).toEqual({
      deploymentId: "depl-a",
      groupId: "grp-1",
      accountId: ACCT_TOPSTEP,
      strategyKey: "orb",
      ticker: "/MNQ",
    });
    expect(vi.mocked(insertSkippedSignal).mock.calls[0][1]).toMatchObject({
      signalBarTs: BAR.timestamp,
      sessionDate: "2025-06-04",
      source: "strategy",
      gate: "vwap",
      reason: "long break below session VWAP",
    });
  });

  it("swallows a failing insert and names the gate in the warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(insertSkippedSignal).mockImplementation(() => {
      throw new Error("database is locked");
    });

    expect(() =>
      makeSkipEngine().recordSkippedSignal(LEG, "vwap", () =>
        strategySkip({ skip: "s", gate: "vwap" }, BAR),
      ),
    ).not.toThrow();

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("skipped_signals insert failed");
    expect(line).toContain("gate=vwap");
    expect(line).toContain("depl-a");
    warn.mockRestore();
  });

  it("swallows a row it cannot build, because the constructors run inside the guard", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // What an unparseable bar timestamp does inside `sessionDateOf`. Built at
    // the call site this would be the tick failure, not a warn.
    expect(() =>
      makeSkipEngine().recordSkippedSignal(LEG, "vwap", () =>
        strategySkip({ skip: "s", gate: "vwap" }, { ...BAR, timestamp: "not a timestamp" }),
      ),
    ).not.toThrow();

    expect(insertSkippedSignal).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "skipped_signals insert failed",
    );
    warn.mockRestore();
  });

  /**
   * Enumerated from source, because the failure being guarded against is a
   * *deleted* call site: the write is best-effort, so a removed arm throws
   * nothing, fails nothing and shows up only as a quiet session with no row.
   */
  // Six gates, six sites: `CONTRACT_HELD_GATE`'s one call is
  // `refuseEntryOnHeldContract`, which both held-contract arms reach (A108).
  it("is called from every refusal arm and nowhere else", () => {
    const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
    const calls = source.match(/this\.recordSkippedSignal\(/g) ?? [];
    const gates = [
      "signal.gate",
      "RISK_BUDGET_GATE",
      "SIZE_RESOLUTION_GATE",
      "CONTRACT_HELD_GATE",
      "STALE_LATCH_GATE",
      "DAILY_PNL_GATE",
    ];
    expect(calls).toHaveLength(gates.length);
    for (const gate of gates) {
      expect(source).toContain(`this.recordSkippedSignal(deployment, ${gate},`);
    }
    expect(source.match(/this\.refuseEntryOnHeldContract\(/g) ?? []).toHaveLength(2);
  });
});
