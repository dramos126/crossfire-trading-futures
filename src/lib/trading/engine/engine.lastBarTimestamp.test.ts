/**
 * Tests for lastBarTimestamp persistence across engine restarts.
 *
 * These tests are written against an assumed interface. The dev must implement
 * these exports/behaviors to satisfy the spec.
 *
 * // ASSUMED INTERFACE ────────────────────────────────────────────────────────
 *
 * In `src/lib/db/settings.ts` (or a new `src/lib/db/app-settings.ts`):
 *
 *   export function getLastBarTimestamp(deploymentId: string): string | null
 *   export function setLastBarTimestamp(deploymentId: string, timestamp: string): void
 *
 *   Key pattern: `lastBarTimestamp:${deploymentId}`
 *   Value: ISO string (same format as BarData.timestamp / DeploymentState.lastBarTimestamp)
 *
 * In `src/lib/trading/engine.ts`:
 *
 *   // Called in start() after rebuildStatePositionsFromDb(), before priming tick:
 *   private restoreLastBarTimestamps(deployments: Deployment[]): void
 *     For each deployment, reads getLastBarTimestamp(deployment.id) and seeds
 *     getState(deployment.id).lastBarTimestamp if non-null.
 *
 *   // Called inside processDeployment(), immediately after:
 *   //   deplState.lastBarTimestamp = latestBar.timestamp
 *   // (i.e., only when the bar is NOT a duplicate and will be evaluated):
 *   setLastBarTimestamp(deployment.id, latestBar.timestamp)
 *
 * Note: setLastBarTimestamp is NOT called on early returns (no bars, disabled
 * deployment, group leg blocked, etc.) — only after the dedup gate passes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module-level mocks ────────────────────────────────────────────────────────
// Must be hoisted before any imports that transitively load these modules.

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not wired up");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getLastBarTimestamp: vi.fn().mockReturnValue(null),
  setLastBarTimestamp: vi.fn(),
  // Other settings exports the engine may import:
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

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(),
  listClosingDeployments: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  listManagedDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn().mockReturnValue([]),
  reapDestroyingDeployment: vi.fn(),
  settlePausingDeployment: vi.fn(),
}));

// Every leg has a parent, and the entry gate reads it: a leg whose parent is
// absent from `listGroups()` is refused, which is the conservative answer and
// would silence every entry in this file.
const PARENT = {
  id: "parent-1",
  name: null,
  strategyKey: "test-strategy",
  paramValues: { size: 1 },
  ticker: "/MNQ" as const,
  contractId: null,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(() => PARENT),
  listGroups: vi.fn(() => [PARENT]),
}));

/** Seed the engine's parent cache. `start()`'s first tick primes it in
 *  production and `sync()` keeps it current; these tests call
 *  `processDeployment` directly, and the entry gate refuses a leg whose
 *  parent is not in the cache. */
function primeParent<T>(engine: T): T {
  (engine as unknown as { groupCache: Map<string, unknown> }).groupCache = new Map([
    [PARENT.id, PARENT],
  ]);
  return engine;
}

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  getAccountDeployState: vi.fn().mockReturnValue(null),
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
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

// Force session window to always-open so processDeployment reaches shouldEnter
// regardless of what time the test runs.
vi.mock("@/lib/trading/session/session", () => ({
  collectSessionWindows: vi.fn().mockReturnValue([{ start: "00:00", end: "23:59" }]),
  isInAnySessionWindow: vi.fn().mockReturnValue(true),
  currentCmeSessionStart: vi.fn().mockReturnValue(new Date("2026-05-15T13:30:00Z")),
  isInMaintenanceWindow: vi.fn().mockReturnValue(false),
  nextMaintenanceEnd: vi.fn().mockReturnValue(null),
}));

// Stub indicator calculation so it doesn't fail on minimal bar arrays.
vi.mock("@/lib/trading/indicators", () => ({
  calculateAll: vi.fn().mockReturnValue({}),
}));

// The engine's single bar-read funnel, mocked at the module the funnel wraps
// rather than at the wrapper. The degraded-mode block below needs the real
// `TradingEngine.fetchBars` to run — it is what records the outcome against
// `EngineHealth` and rethrows — so stubbing `(engine as any).fetchBars` there
// would construct a state the running system cannot reach: health reporting
// `down` while the read succeeds. The other blocks in this file stub the
// wrapper deliberately and never reach this mock.
// `computeFetchDepth` is pure arithmetic over the strategy's declarations and
// is the argument to that read, so it stays real — a stub would let the depth
// the engine asks for drift from the depth the module computes.
vi.mock("./realtime/engine-bar-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./realtime/engine-bar-fetch")>()),
  fetchBars: vi.fn().mockResolvedValue([]),
  resolveExitFillPrice: vi.fn().mockResolvedValue(null),
  snapshotTradeBars: vi.fn().mockResolvedValue(undefined),
}));

// Stub filter helpers so the exit-filter and modifySl paths don't throw.
vi.mock("@/lib/trading/filters", () => ({
  collectExitFilterResults: vi.fn().mockReturnValue({ exitResult: null, slModifyResult: null }),
  getExitFilterTimeframes: vi.fn().mockReturnValue([]),
  pickTightestFavorableSl: vi.fn().mockReturnValue(null),
  snapshotAllFilterState: vi.fn().mockReturnValue(null),
  anyExitFilterTriggered: vi.fn().mockReturnValue(false),
}));

// Stub daily P&L gate — always passes so it doesn't block shouldEnter.
// `tripped` is the field the engine reads; a `blocked` here was inert and
// passed only because `undefined` is falsy.
vi.mock("@/lib/trading/daily-pnl-gate", () => ({
  evaluateDailyPnlGate: vi
    .fn()
    .mockReturnValue({ tripped: false, side: null, thresholdUsd: null, effectivePnl: 0 }),
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

// ── Imports (after all vi.mock hoisting) ─────────────────────────────────────

import { getLastBarTimestamp, setLastBarTimestamp } from "@/lib/db/settings";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { resetLogBursts } from "@/lib/logging/pipe";
import { collectExitFilterResults, getExitFilterTimeframes } from "@/lib/trading/filters";
import type { BarData } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import { MARKET_HUB_STALL_MS } from "./engine-market-hub";
import { fetchBars as fetchBarsImpl } from "./realtime/engine-bar-fetch";
import type { DeploymentState } from "./engine";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal Deployment stub. Only fields read by processDeployment / boot paths
 * need values; rest are typed nulls.
 */
function makeDeployment(
  id = "deploy-aaa",
  status: Deployment["status"] = "Active",
): Deployment {
  return {
    id,
    strategyKey: "test-strat",
    accountId: 1001,
    ticker: "/MNQ",
    contractId: "CON.F.US.MNQ.M26",
    status,
    paramValues: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "parent-1",
    enabledSnapshot: null,
  };
}

/** Minimal DeploymentState with lastBarTimestamp initialised to null. */
function makeDeploymentState(overrides: Partial<DeploymentState> = {}): DeploymentState {
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

function makeBar(timestamp: string, close = 21000): BarData {
  return {
    timestamp,
    open: close - 10,
    high: close + 5,
    low: close - 15,
    close,
    volume: 150,
  };
}

// ── Unit tests for the settings helpers ───────────────────────────────────────
//
// These test the two new `app_settings` helper functions in isolation, verifying
// the key format contract and value passthrough. The functions are thin wrappers
// so the tests focus on the key convention and null-fallback — not the SQLite
// mechanics (which are mocked at the DB layer).

describe("getLastBarTimestamp", () => {
  beforeEach(() => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(null);
  });

  it("returns null when no entry exists for the deployment", () => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(null);
    expect(getLastBarTimestamp("deploy-aaa")).toBeNull();
  });

  it("returns the stored ISO timestamp string when an entry exists", () => {
    const ts = "2026-05-15T14:30:00.000Z";
    vi.mocked(getLastBarTimestamp).mockReturnValue(ts);
    expect(getLastBarTimestamp("deploy-aaa")).toBe(ts);
  });

  it("returns null for a deployment id that has never been written", () => {
    vi.mocked(getLastBarTimestamp).mockImplementation((id) =>
      id === "known-deploy" ? "2026-05-15T14:30:00.000Z" : null,
    );
    expect(getLastBarTimestamp("brand-new-deploy")).toBeNull();
  });
});

describe("setLastBarTimestamp", () => {
  beforeEach(() => {
    vi.mocked(setLastBarTimestamp).mockReset();
  });

  it("is called with the deployment id and the bar timestamp string", () => {
    const ts = "2026-05-15T14:30:00.000Z";
    setLastBarTimestamp("deploy-aaa", ts);
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-aaa", ts);
  });

  it("overwrites a previous value when called again for the same deployment", () => {
    setLastBarTimestamp("deploy-aaa", "2026-05-15T14:00:00.000Z");
    setLastBarTimestamp("deploy-aaa", "2026-05-15T14:30:00.000Z");
    expect(setLastBarTimestamp).toHaveBeenCalledTimes(2);
    expect(setLastBarTimestamp).toHaveBeenLastCalledWith("deploy-aaa", "2026-05-15T14:30:00.000Z");
  });

  it("persists independent timestamps per deployment without cross-contamination", () => {
    setLastBarTimestamp("deploy-aaa", "2026-05-15T14:30:00.000Z");
    setLastBarTimestamp("deploy-bbb", "2026-05-15T15:00:00.000Z");
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-aaa", "2026-05-15T14:30:00.000Z");
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-bbb", "2026-05-15T15:00:00.000Z");
  });
});

// ── Behavioural tests against the engine boot / processDeployment contract ───
//
// These tests exercise the semantics of the feature through the engine's
// internal state map, accessed via `(engine as any).getState(id)` and
// `(engine as any).restoreLastBarTimestamps(deployments)`.
//
// They intentionally do NOT call `engine.start()` (which would spin up
// setInterval timers) — only the targeted private helpers.

describe("restoreLastBarTimestamps (engine boot path)", () => {
  // Deferred import so mocks are established first.
  let TradingEngine: typeof import("./engine").TradingEngine;
  let TopstepClient: typeof import("@/lib/brokers/topstep/client").TopstepClient;
  let TradovateClient: typeof import("@/lib/brokers/tradovate/client").TradovateClient;

  beforeEach(async () => {
    vi.mocked(getLastBarTimestamp).mockReset().mockReturnValue(null);
    ({ TradingEngine } = await import("./engine"));
    ({ TopstepClient } = await import("@/lib/brokers/topstep/client"));
    ({ TradovateClient } = await import("@/lib/brokers/tradovate/client"));
  });

  function makeEngine() {
    const topstep = new TopstepClient("http://localhost:0");
    const tradovate = new TradovateClient("http://localhost:0");
    return primeParent(new TradingEngine(topstep, tradovate, null));
  }

  it("seeds lastBarTimestamp from app_settings for each deployment when a value is stored", () => {
    const storedTs = "2026-05-15T14:30:00.000Z";
    vi.mocked(getLastBarTimestamp).mockReturnValue(storedTs);

    const engine = makeEngine();
    const deployment = makeDeployment("deploy-aaa");

    (engine as any).restoreLastBarTimestamps([deployment]);

    const state: DeploymentState = (engine as any).getState("deploy-aaa");
    expect(state.lastBarTimestamp).toBe(storedTs);
  });

  it("leaves lastBarTimestamp as null when app_settings has no entry for the deployment", () => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(null);

    const engine = makeEngine();
    const deployment = makeDeployment("deploy-new");

    (engine as any).restoreLastBarTimestamps([deployment]);

    const state: DeploymentState = (engine as any).getState("deploy-new");
    expect(state.lastBarTimestamp).toBeNull();
  });

  it("restores independently for each deployment without cross-contamination", () => {
    vi.mocked(getLastBarTimestamp).mockImplementation((id) => {
      if (id === "deploy-aaa") return "2026-05-15T14:30:00.000Z";
      if (id === "deploy-bbb") return "2026-05-15T15:00:00.000Z";
      return null;
    });

    const engine = makeEngine();
    const deplA = makeDeployment("deploy-aaa");
    const deplB = makeDeployment("deploy-bbb");
    const deplC = makeDeployment("deploy-ccc");

    (engine as any).restoreLastBarTimestamps([deplA, deplB, deplC]);

    expect((engine as any).getState("deploy-aaa").lastBarTimestamp).toBe("2026-05-15T14:30:00.000Z");
    expect((engine as any).getState("deploy-bbb").lastBarTimestamp).toBe("2026-05-15T15:00:00.000Z");
    expect((engine as any).getState("deploy-ccc").lastBarTimestamp).toBeNull();
  });

  it("reads from app_settings using the deployment id as the key discriminator", () => {
    const engine = makeEngine();
    const deployment = makeDeployment("deploy-xyz");

    (engine as any).restoreLastBarTimestamps([deployment]);

    expect(getLastBarTimestamp).toHaveBeenCalledWith("deploy-xyz");
  });

  it("is a no-op for an empty deployment list without throwing", () => {
    const engine = makeEngine();
    expect(() => (engine as any).restoreLastBarTimestamps([])).not.toThrow();
    expect(getLastBarTimestamp).not.toHaveBeenCalled();
  });
});

// ── Tests via processDeployment (bar evaluation + dedup gate) ────────────────
//
// processDeployment is private — accessed via `(engine as any)`.
// We stub out fetchBars, the contract resolver, and the strategy so we can
// drive the exact code paths without network or DB I/O.

describe("processDeployment — lastBarTimestamp persistence and dedup", () => {
  let engine: import("./engine").TradingEngine;
  let shouldEnterSpy: ReturnType<typeof vi.fn>;

  const BAR_TS_OLD = "2026-05-15T14:00:00.000Z";
  const BAR_TS_NEW = "2026-05-15T14:30:00.000Z";

  const stubContract = {
    id: "CON.F.US.MNQ.M26",
    name: "MNQM6",
    description: "Micro E-mini Nasdaq-100 June 2026",
    activeContract: true,
    symbolId: "/MNQ",
    tickSize: 0.25,
    tickValue: 1.25,
  };

  beforeEach(async () => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(null);
    vi.mocked(setLastBarTimestamp).mockReset();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    shouldEnterSpy = vi.fn().mockReturnValue(null);

    const { TradingEngine } = await import("./engine");
    const { TopstepClient } = await import("@/lib/brokers/topstep/client");
    const { TradovateClient } = await import("@/lib/brokers/tradovate/client");

    engine = primeParent(new TradingEngine(new TopstepClient("http://localhost:0"), new TradovateClient("http://localhost:0"), null));

    // Stub contract resolver so no HTTP call is made.
    (engine as any).resolver = {
      resolve: vi.fn().mockResolvedValue(stubContract),
    };

    // Minimal strategy stub — shouldEnter is a spy so we can assert call count.
    const stubStrategy = {
      version: "1.0.0",
      params: {},
      config: {
        name: "Test Strategy",
        description: "",
        timeframe: "1m" as const,
        size: 1,
        entryType: 2 as const,
        indicators: [],
      },
      shouldEnter: shouldEnterSpy,
      shouldExit: vi.fn().mockReturnValue(false),
    };

    // Point getStrategy to our stub for the test strategy key.
    const { getStrategy } = await import("@/lib/trading/strategies");
    vi.mocked(getStrategy).mockReturnValue(stubStrategy as any);

    // Default: session window is always active (avoid session-gate returns).
    // The engine reads `isInAnySessionWindow` from the session module; stub
    // at the engine's internal level by injecting a params value that covers
    // the full day. The easiest path is to ensure no params key overwrites the
    // default "always-on" window — the empty paramValues on the deployment
    // achieves this, relying on strategy.params defaults producing a 24h window.
  });

  async function callProcessDeployment(
    deployment: Deployment,
    bars: BarData[],
    triggerBar?: BarData,
  ): Promise<void> {
    // Stub fetchBars to return the supplied bar array.
    (engine as any).fetchBars = vi.fn().mockResolvedValue([...bars]);
    await (engine as any).processDeployment(
      // getStrategy is already mocked — the engine calls it internally, so we
      // pass the key and let the mock resolve it. But processDeployment receives
      // the already-resolved StrategyModule as its first arg, so pass our stub.
      {
        version: "1.0.0",
        params: {},
        config: {
          name: "Test Strategy",
          description: "",
          timeframe: "1m" as const,
          size: 1,
          entryType: 2 as const,
          indicators: [],
        },
        shouldEnter: shouldEnterSpy,
        shouldExit: vi.fn().mockReturnValue(false),
      },
      deployment,
      triggerBar,
    );
  }

  it("writes lastBarTimestamp to app_settings after successfully evaluating a bar", async () => {
    const deployment = makeDeployment("deploy-aaa");
    const bar = makeBar(BAR_TS_NEW);

    await callProcessDeployment(deployment, [bar]);

    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-aaa", BAR_TS_NEW);
  });

  it("writes the exact bar timestamp string returned by the bar source, not a reformatted version", async () => {
    const deployment = makeDeployment("deploy-aaa");
    // Use a timestamp with sub-second precision to catch any accidental
    // truncation to whole seconds.
    const precisionTs = "2026-05-15T14:30:00.123Z";
    const bar = makeBar(precisionTs);

    await callProcessDeployment(deployment, [bar]);

    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-aaa", precisionTs);
  });

  it("does NOT write to app_settings when bar list is empty (early return before dedup gate)", async () => {
    const deployment = makeDeployment("deploy-aaa");

    await callProcessDeployment(deployment, []);

    expect(setLastBarTimestamp).not.toHaveBeenCalled();
  });

  it("does NOT call shouldEnter and does NOT write app_settings when latest bar matches restored lastBarTimestamp", async () => {
    const deployment = makeDeployment("deploy-aaa");

    // Simulate post-restart state where lastBarTimestamp was restored from DB.
    const state = (engine as any).getState("deploy-aaa") as DeploymentState;
    state.lastBarTimestamp = BAR_TS_NEW;

    const bar = makeBar(BAR_TS_NEW);
    await callProcessDeployment(deployment, [bar]);

    expect(shouldEnterSpy).not.toHaveBeenCalled();
    // The dedup skip fires before the setLastBarTimestamp call site, so the
    // timestamp must not be re-written (it would be a no-op value-wise, but
    // the DB write is observable and should not happen on a skip).
    expect(setLastBarTimestamp).not.toHaveBeenCalled();
  });

  it("calls shouldEnter when the latest bar has a newer timestamp than the restored lastBarTimestamp", async () => {
    const deployment = makeDeployment("deploy-aaa");

    // Restore an older timestamp (the previous bar).
    const state = (engine as any).getState("deploy-aaa") as DeploymentState;
    state.lastBarTimestamp = BAR_TS_OLD;

    const bar = makeBar(BAR_TS_NEW);
    await callProcessDeployment(deployment, [bar]);

    expect(shouldEnterSpy).toHaveBeenCalled();
  });

  it("writes the new bar timestamp to app_settings when the bar advances past the restored timestamp", async () => {
    const deployment = makeDeployment("deploy-aaa");

    const state = (engine as any).getState("deploy-aaa") as DeploymentState;
    state.lastBarTimestamp = BAR_TS_OLD;

    const bar = makeBar(BAR_TS_NEW);
    await callProcessDeployment(deployment, [bar]);

    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-aaa", BAR_TS_NEW);
  });

  it("a new deployment with no app_settings entry initialises to null and processes the bar normally", async () => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(null);
    const deployment = makeDeployment("deploy-brand-new");

    // Do NOT call restoreLastBarTimestamps — state starts at null by default,
    // matching the getState() lazy-init behavior on a fresh engine.
    const state = (engine as any).getState("deploy-brand-new") as DeploymentState;
    expect(state.lastBarTimestamp).toBeNull();

    const bar = makeBar(BAR_TS_NEW);
    await callProcessDeployment(deployment, [bar]);

    // Bar processed normally — shouldEnter reached.
    expect(shouldEnterSpy).toHaveBeenCalled();
  });

  it("does NOT write app_settings when the deployment leg is disabled (entry-guard early return)", async () => {
    // A non-Active deployment passes through to processDeployment only while
    // the engine still owes it a flatten (exit path). When it is not
    // entry-eligible, isLegEngineEnabled returns false and the function
    // returns before any strategy call. Stub the gate to simulate that.
    const deployment = makeDeployment("deploy-disabled", "Active");

    // Inject the disabled signal via the engine's own gate method.
    (engine as any).isLegEngineEnabled = vi.fn().mockReturnValue(false);

    const bar = makeBar(BAR_TS_NEW);
    await callProcessDeployment(deployment, [bar]);

    // The dedup gate fires and writes lastBarTimestamp BEFORE the leg-disabled
    // check, so setLastBarTimestamp IS expected here. If the implementation
    // moves persistence after the leg check, update this assertion accordingly.
    //
    // Current engine layout (lines 4074-4317):
    //   1. dedup check + deplState.lastBarTimestamp = latestBar.timestamp  ← persist here
    //   2. params merge + indicators
    //   3. exit logic
    //   4. isLegEngineEnabled check ← early return
    //   5. shouldEnter
    //
    // Therefore: setLastBarTimestamp IS called, shouldEnter is NOT.
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-disabled", BAR_TS_NEW);
    expect(shouldEnterSpy).not.toHaveBeenCalled();
  });
});

// ── Integration: boot → tick → dedup ─────────────────────────────────────────
//
// Simulates the full restart scenario end-to-end through the engine's private
// helpers, without spinning up timers.

describe("end-to-end restart scenario — restored timestamp prevents re-evaluation", () => {
  const BAR_TS = "2026-05-15T14:30:00.000Z";

  it("after restoreLastBarTimestamps seeds the state, processDeployment skips shouldEnter on the same bar", async () => {
    vi.mocked(getLastBarTimestamp).mockReturnValue(BAR_TS);

    const { TradingEngine } = await import("./engine");
    const { TopstepClient } = await import("@/lib/brokers/topstep/client");
    const { TradovateClient } = await import("@/lib/brokers/tradovate/client");

    const engine = primeParent(new TradingEngine(
      new TopstepClient("http://localhost:0"),
      new TradovateClient("http://localhost:0"),
      null,
    ));

    const deployment = makeDeployment("deploy-restart");
    const shouldEnterSpy = vi.fn().mockReturnValue(null);

    const stubStrategy = {
      version: "1.0.0",
      params: {},
      config: {
        name: "Test",
        description: "",
        timeframe: "1m" as const,
        size: 1,
        entryType: 2 as const,
        indicators: [],
      },
      shouldEnter: shouldEnterSpy,
      shouldExit: vi.fn().mockReturnValue(false),
    };

    (engine as any).resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "CON.F.US.MNQ.M26",
        name: "MNQM6",
        description: "",
        activeContract: true,
        symbolId: "/MNQ",
        tickSize: 0.25,
        tickValue: 1.25,
      }),
    };
    (engine as any).fetchBars = vi.fn().mockResolvedValue([makeBar(BAR_TS)]);

    // Boot phase: restore persisted timestamps into state (simulates what
    // start() will call before the priming tick).
    (engine as any).restoreLastBarTimestamps([deployment]);

    // Verify state was seeded correctly.
    const state: DeploymentState = (engine as any).getState("deploy-restart");
    expect(state.lastBarTimestamp).toBe(BAR_TS);

    // Priming tick fires processDeployment with the same bar that was already
    // evaluated pre-restart — dedup gate must fire.
    await (engine as any).processDeployment(stubStrategy, deployment);

    expect(shouldEnterSpy).not.toHaveBeenCalled();
  });

  it("after restoreLastBarTimestamps, a bar with a new timestamp is evaluated normally", async () => {
    const storedTs = "2026-05-15T14:00:00.000Z";
    const nextBarTs = "2026-05-15T14:30:00.000Z";

    vi.mocked(getLastBarTimestamp).mockReturnValue(storedTs);

    const { TradingEngine } = await import("./engine");
    const { TopstepClient } = await import("@/lib/brokers/topstep/client");
    const { TradovateClient } = await import("@/lib/brokers/tradovate/client");

    const engine = primeParent(new TradingEngine(
      new TopstepClient("http://localhost:0"),
      new TradovateClient("http://localhost:0"),
      null,
    ));

    const deployment = makeDeployment("deploy-advance");
    const shouldEnterSpy = vi.fn().mockReturnValue(null);

    const stubStrategy = {
      version: "1.0.0",
      params: {},
      config: {
        name: "Test",
        description: "",
        timeframe: "1m" as const,
        size: 1,
        entryType: 2 as const,
        indicators: [],
      },
      shouldEnter: shouldEnterSpy,
      shouldExit: vi.fn().mockReturnValue(false),
    };

    (engine as any).resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "CON.F.US.MNQ.M26",
        name: "MNQM6",
        description: "",
        activeContract: true,
        symbolId: "/MNQ",
        tickSize: 0.25,
        tickValue: 1.25,
      }),
    };
    (engine as any).fetchBars = vi.fn().mockResolvedValue([makeBar(storedTs), makeBar(nextBarTs)]);

    (engine as any).restoreLastBarTimestamps([deployment]);

    // The newest bar is nextBarTs — one bar after the restored timestamp.
    await (engine as any).processDeployment(stubStrategy, deployment);

    expect(shouldEnterSpy).toHaveBeenCalled();
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-advance", nextBarTs);
  });
});

// ── Degraded mode and the post-outage entry gate (D-10) ──────────────────────
//
// These live in this file rather than beside the rest of the health tests
// because what they defend is *where inside `processDeployment`* each half of
// D-10 acts, which is invisible from `engine-health.ts`:
//
//   `down`      — enforced by `fetchBars` throwing, above everything else.
//                 There is no gate; the throw is the gate.
//   post-outage — enforced by `mayEnterOnBar`, in the entry branch only.
//                 Exits, break-even and trailing resume on the first bar the
//                 provider serves, whenever it opened.
//
// **Every outage here is driven through the real bar read**, by rejecting the
// module function the engine's own `fetchBars` wraps. Two earlier tests in
// this block stubbed `(engine as any).fetchBars` to a resolving mock and then
// wrote `down` into the health controller by hand — a state the running system
// cannot produce, because a feed that is down is a feed whose read throws. The
// gate arm they reached was consequently never reached in production and has
// been deleted.

describe("processDeployment — degraded mode and post-outage resume", () => {
  let engine: import("./engine").TradingEngine;
  let shouldEnterSpy: ReturnType<typeof vi.fn>;
  let shouldExitSpy: ReturnType<typeof vi.fn>;
  let stubStrategy: unknown;

  const BAR_TS = "2026-05-15T14:30:00.000Z";
  const BAR_OPEN_MS = new Date(BAR_TS).getTime();

  /** Reject the real bar read for long enough that the seam reports `down`.
   *  Returns the instant the run crossed the threshold. */
  async function realOutage(deployment: Deployment): Promise<number> {
    vi.mocked(fetchBarsImpl).mockRejectedValue(new Error("provider 503"));
    const start = Date.now();
    await expect(evaluate(deployment)).rejects.toThrow("provider 503");
    vi.setSystemTime(start + MARKET_HUB_STALL_MS);
    await expect(evaluate(deployment)).rejects.toThrow("provider 503");
    return Date.now();
  }

  /** Let the real bar read succeed again, at `at`, returning `bars`. */
  function realRecovery(at: number, bars: BarData[]): void {
    vi.setSystemTime(at);
    vi.mocked(fetchBarsImpl).mockResolvedValue([...bars]);
  }

  async function evaluate(deployment: Deployment): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).processDeployment(stubStrategy, deployment, undefined);
  }

  /**
   * A real signal on the held bar. The gate still asks `shouldEnter` there —
   * only to log the held signal for the parity check — so "refused" is the
   * gate's own line with nothing placed, not that the strategy went unasked.
   */
  function heldSignal(): { placeEntryOrder: ReturnType<typeof vi.fn>; heldEvents: string[] } {
    shouldEnterSpy.mockReturnValue({ side: 0, slTicks: 10, tpTicks: 20 });
    const placeEntryOrder = vi.fn(async () => ({ tradeId: 1, preEntryOrderIds: [] }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).placeEntryOrder = placeEntryOrder;
    // The previous test's held line has the same burst shape; collapsed into
    // it, this one would never reach the handler.
    resetLogBursts();
    const heldEvents: string[] = [];
    engine.setLogHandler((entry) => {
      const event = (entry as { event?: string | null }).event;
      if (event === "entry_held_after_restart") heldEvents.push(event);
    });
    return { placeEntryOrder, heldEvents };
  }

  /** Give the deployment an open position so the exit half of the tick runs. */
  function openPosition(deploymentId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (engine as any).getState(deploymentId) as DeploymentState;
    state.position = {
      side: 0,
      entryPrice: 21000,
      entryTimestamp: "2026-05-15T14:00:00.000Z",
      barsSinceEntry: 3,
      entryFilledAt: "2026-05-15T14:00:05.000Z",
      size: 1,
      slTicks: 40,
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    // Start far enough before the bar opens that a full `MARKET_HUB_STALL_MS`
    // outage still crosses into `down` while the bar is forming — which is the
    // shape of the incident: the feed dies mid-bar and comes back mid-bar.
    vi.setSystemTime(BAR_OPEN_MS - 150_000);

    vi.mocked(getLastBarTimestamp).mockReturnValue(null);
    vi.mocked(setLastBarTimestamp).mockReset();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    vi.mocked(fetchBarsImpl).mockReset().mockResolvedValue([]);
    // The exit-filter sweep (break-even + trailing) reads this. An empty
    // candidate list keeps the sweep observable without issuing a modify.
    vi.mocked(collectExitFilterResults).mockReset().mockReturnValue([]);
    // No declared cross-timeframe by default; one test opts in.
    vi.mocked(getExitFilterTimeframes).mockReset().mockReturnValue([]);

    shouldEnterSpy = vi.fn().mockReturnValue(null);
    shouldExitSpy = vi.fn().mockReturnValue(false);

    const { TradingEngine } = await import("./engine");
    const { TopstepClient } = await import("@/lib/brokers/topstep/client");
    const { TradovateClient } = await import("@/lib/brokers/tradovate/client");

    engine = primeParent(new TradingEngine(
      new TopstepClient("http://localhost:0"),
      new TradovateClient("http://localhost:0"),
      null,
    ));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "CON.F.US.MNQ.M26",
        name: "MNQM6",
        description: "",
        activeContract: true,
        symbolId: "/MNQ",
        tickSize: 0.25,
        tickValue: 1.25,
      }),
    };

    stubStrategy = {
      version: "1.0.0",
      params: {},
      config: {
        name: "Test Strategy",
        description: "",
        timeframe: "1m" as const,
        size: 1,
        entryType: 2 as const,
        indicators: [],
      },
      shouldEnter: shouldEnterSpy,
      shouldExit: shouldExitSpy,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── `down`: the throw is the enforcement ───────────────────────────

  it("aborts the whole tick by throwing while the bar read is failing", async () => {
    const deployment = makeDeployment("deploy-degraded");
    vi.mocked(fetchBarsImpl).mockRejectedValue(new Error("provider 503"));

    await expect(evaluate(deployment)).rejects.toThrow("provider 503");

    expect(shouldEnterSpy).not.toHaveBeenCalled();
    expect(shouldExitSpy).not.toHaveBeenCalled();
    expect(setLastBarTimestamp).not.toHaveBeenCalled();
  });

  it("drives the market-data seam to down through the engine's own funnel", async () => {
    // The wrapper is what records the outcome, so a real failure is the only
    // thing that can put the seam in this state. `degraded` is what the
    // dashboard renders.
    const deployment = makeDeployment("deploy-degraded");
    await realOutage(deployment);

    expect(engine.getSeamHealth().degraded).toBe(true);
    expect(engine.getSeamHealth().marketData.realtime.state).toBe("down");
  });

  it("does not read an empty series as a failing feed", async () => {
    // The provider answered; it just had nothing for the window. Counting it
    // as a failure — `ok: bars.length > 0` — reports a closed market, a
    // pre-session warmup and a holiday as a market-data outage, and freezes
    // tier 1 for every deployment on every broker while it does so.
    const deployment = makeDeployment("deploy-degraded");
    const start = Date.now();
    vi.mocked(fetchBarsImpl).mockResolvedValue([]);

    await evaluate(deployment);
    vi.setSystemTime(start + MARKET_HUB_STALL_MS * 2);
    await evaluate(deployment);

    expect(engine.getSeamHealth().degraded).toBe(false);
    expect(engine.getSeamHealth().marketData.realtime.state).toBe("healthy");
  });

  it("does not fold a tolerated exit-filter bar read into the global seam", async () => {
    // The cross-timeframe read is best-effort: its failure is caught, warned
    // and the filter skips, so it cannot mean "no bars for evaluation". It is
    // also contradicted in the same tick by the evaluation read, which
    // necessarily succeeded — nothing below that read runs otherwise. Folded
    // in, one tolerated 15m failure would manufacture a threshold-crossing
    // outage on any timeframe past 2m, because the run would be measured
    // against the *next* read's clock: entries held globally, an alert fired,
    // and a feed that never stopped serving the evaluation series.
    const deployment = makeDeployment("deploy-degraded");
    openPosition("deploy-degraded");
    vi.mocked(getExitFilterTimeframes).mockReturnValue(["15m"]);
    vi.mocked(fetchBarsImpl).mockImplementation(async (_contract, tf) =>
      tf === "15m" ? Promise.reject(new Error("15m provider 503")) : [makeBar(BAR_TS)],
    );

    const start = Date.now();
    await evaluate(deployment);
    vi.setSystemTime(start + 180_000);
    await evaluate(deployment);

    expect(engine.getSeamHealth().marketData.realtime.resumeFromBarOpenMs).toBeNull();
    expect(engine.getSeamHealth().degraded).toBe(false);
  });

  it("clears degraded the moment a real bar read succeeds again", async () => {
    const deployment = makeDeployment("deploy-degraded");
    const downAt = await realOutage(deployment);
    realRecovery(downAt + 30_000, [makeBar(BAR_TS)]);

    await evaluate(deployment);

    expect(engine.getSeamHealth().degraded).toBe(false);
  });

  // ── Post-outage: entries wait, position management does not ────────

  it("resumes break-even, trailing and strategy exits on the first bar after a real outage", async () => {
    // The Critical. A bar that opened before the feed recovered is still the
    // bar the provider is serving, and on a 1h deployment the next one that
    // postdates the recovery is up to two hours away. Freezing exit
    // management for that long on a live position — while the dashboard
    // reports the feed healthy — is worse than acting on this bar.
    const deployment = makeDeployment("deploy-degraded");
    openPosition("deploy-degraded");
    const downAt = await realOutage(deployment);

    // Recovery lands after the bar opened, so the bar is a pre-recovery one.
    realRecovery(BAR_OPEN_MS + 30_000, [makeBar(BAR_TS)]);
    expect(engine.getSeamHealth().degraded).toBe(true);
    await evaluate(deployment);
    expect(engine.getSeamHealth().degraded).toBe(false);
    expect(downAt).toBeLessThan(BAR_OPEN_MS + 30_000);

    expect(collectExitFilterResults).toHaveBeenCalled();
    expect(shouldExitSpy).toHaveBeenCalled();
  });

  it("still refuses an ENTRY on a bar that opened before the feed recovered", async () => {
    const deployment = makeDeployment("deploy-degraded");
    const downAt = await realOutage(deployment);
    realRecovery(BAR_OPEN_MS + 30_000, [makeBar(BAR_TS)]);
    expect(downAt).toBeLessThan(BAR_OPEN_MS + 30_000);
    const { placeEntryOrder, heldEvents } = heldSignal();

    await evaluate(deployment);

    expect(heldEvents).toHaveLength(1);
    expect(placeEntryOrder).not.toHaveBeenCalled();
  });

  it("stamps lastBarTimestamp on a bar whose entry was refused — the bar was evaluated", async () => {
    // The stamp means "this bar has been through the tick", and under the
    // narrowed gate it has: only the entry was skipped. The next bar is a new
    // bar and is unaffected, which is what the already-processed check needs.
    const deployment = makeDeployment("deploy-degraded");
    await realOutage(deployment);
    realRecovery(BAR_OPEN_MS + 30_000, [makeBar(BAR_TS)]);

    await evaluate(deployment);

    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-degraded", BAR_TS);
  });

  it("refuses an ENTRY after an outage that fell entirely between two reads (3m cadence)", async () => {
    // The read cadence *is* the timeframe: `fetchBars` has two call sites,
    // both in `processDeployment`, and in realtime mode that runs at bar
    // close. So a 180s outage on a 3m deployment produces one failing read
    // and one succeeding read, and the 120s crossing in between has no read
    // to observe it. A 1m deployment gets three reads inside the same outage
    // and was protected; every timeframe from 3m up was not — and since the
    // gate narrowed to entries, this anchor is the only protection left.
    const deployment = makeDeployment("deploy-degraded");
    const start = Date.now();
    vi.mocked(fetchBarsImpl).mockRejectedValue(new Error("provider 503"));
    await expect(evaluate(deployment)).rejects.toThrow("provider 503");

    // One read, 3m later. The bar it serves opened mid-blackout.
    realRecovery(start + 180_000, [makeBar(BAR_TS)]);
    expect(BAR_OPEN_MS).toBeGreaterThan(start);
    expect(BAR_OPEN_MS).toBeLessThan(start + 180_000);
    const { placeEntryOrder, heldEvents } = heldSignal();

    await evaluate(deployment);

    expect(heldEvents).toHaveLength(1);
    expect(placeEntryOrder).not.toHaveBeenCalled();
    // The bar was still evaluated — only the entry was refused.
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-degraded", BAR_TS);
  });

  it("admits an entry on the first bar that opens after the recovery", async () => {
    const deployment = makeDeployment("deploy-degraded");
    await realOutage(deployment);
    const recoveredAt = BAR_OPEN_MS - 10_000;
    realRecovery(recoveredAt, [makeBar(BAR_TS)]);

    await evaluate(deployment);

    expect(shouldEnterSpy).toHaveBeenCalledTimes(1);
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-degraded", BAR_TS);
  });

  it("evaluates normally when the feed has never failed", async () => {
    const deployment = makeDeployment("deploy-degraded");
    // After the bar has closed: the shared start sits before it opens, and a
    // bar more than one bar ahead of the clock is left out of the series (A97).
    vi.setSystemTime(BAR_OPEN_MS + 90_000);
    vi.mocked(fetchBarsImpl).mockResolvedValue([makeBar(BAR_TS)]);

    await evaluate(deployment);

    expect(shouldEnterSpy).toHaveBeenCalledTimes(1);
    expect(setLastBarTimestamp).toHaveBeenCalledWith("deploy-degraded", BAR_TS);
  });
});
