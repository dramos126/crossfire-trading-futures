/**
 * The live bar-close path: what a queued close is evaluated on, how bar
 * identity is decided, and what the trigger-bar splice refuses (A97).
 *
 * Driven through the shipped `runTickForDeployments` / `drainPendingBarCloses`
 * and the real `processDeployment`; only the bar read (`fetchBars`, the
 * engine's wrapper) and the contract resolve are stubbed, so the queue, the
 * splice and the dedupe under test are the engine's own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not wired up");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getLastBarTimestamp: vi.fn().mockReturnValue(null),
  setLastBarTimestamp: vi.fn(),
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

// Every leg has a parent and the entry gate reads it; an absent parent would
// silence every entry in this file.
const PARENT = {
  id: "parent-1",
  name: null,
  strategyKey: "subject",
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

// Always-open session, so every bar reaches the entry branch whatever the
// pinned clock says.
vi.mock("@/lib/trading/session/session", () => ({
  collectSessionWindows: vi.fn().mockReturnValue([{ start: "00:00", end: "23:59" }]),
  isInAnySessionWindow: vi.fn().mockReturnValue(true),
  currentCmeSessionStart: vi.fn().mockReturnValue(new Date("2026-10-14T13:30:00Z")),
  isInMaintenanceWindow: vi.fn().mockReturnValue(false),
  nextMaintenanceEnd: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/trading/indicators", () => ({
  calculateAll: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/trading/filters", () => ({
  collectExitFilterResults: vi.fn().mockReturnValue([]),
  getExitFilterTimeframes: vi.fn().mockReturnValue([]),
  pickTightestFavorableSl: vi.fn().mockReturnValue(null),
  snapshotAllFilterState: vi.fn().mockReturnValue(null),
  anyExitFilterTriggered: vi.fn().mockReturnValue(false),
}));

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

import { getStrategy } from "@/lib/trading/strategies";
import { collectExitFilterResults } from "@/lib/trading/filters";
import { resetLogBursts } from "@/lib/logging/pipe";
import { ENGINE_SCOPE, EVENTS } from "@/lib/logging/vocabulary";
import type { BarData } from "@/lib/brokers/types";
import type { Deployment, Timeframe } from "@/lib/trading/domain";
import type { StrategyModule } from "@/lib/trading/strategy-types";
import type { DeploymentState, TriggerClose } from "./engine";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SUBJECT = "subject";
const HOLDER = "holder";
const GAP_EVENT = "entry_bar_series_gap";

/** REST's spelling of a bar instant, against the aggregator's `.000Z`. */
const rest = (iso: string) => iso.replace(".000Z", "+00:00");

function bar(timestamp: string, close = 21000): BarData {
  return { timestamp, open: close - 10, high: close + 5, low: close - 15, close, volume: 150 };
}

/** A close as the aggregator publishes it: the bar, the open of the bar it
 *  published before (null for its first), and the aggregator's timeframe. */
function close(timestamp: string, previousPublishedAt: string | null, timeframe: Timeframe = "5m"): TriggerClose {
  return { bar: bar(timestamp), previousPublishedAt, timeframe };
}

function deployment(id: string, strategyKey: string, timeframe: Timeframe): Deployment {
  return {
    id,
    strategyKey,
    accountId: 1001,
    ticker: "/MNQ",
    contractId: "CON.F.US.MNQ.Z26",
    status: "Active",
    paramValues: { timeframe },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: PARENT.id,
    enabledSnapshot: null,
  };
}

interface Ctx {
  bars: BarData[];
  barIndex: number;
}

/** The newest bar of the series each call was handed — the bar evaluated. */
function evaluated(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map(([ctx]) => {
    const c = ctx as Ctx;
    return c.bars[c.barIndex].timestamp;
  });
}

interface EventLine {
  event: string;
  deploymentId: string;
  message: string;
}

interface EnginePrivates {
  ticking: boolean;
  realtimeDeployments: Deployment[];
  pendingBarCloses: Map<string, TriggerClose | null>;
  groupCache: Map<string, unknown>;
  resolver: { resolve: (...args: unknown[]) => Promise<unknown> };
  fetchBars: (...args: unknown[]) => Promise<BarData[]>;
  getState(id: string): DeploymentState;
  runTickForDeployments(deployments: Deployment[], trigger?: TriggerClose): Promise<void>;
  runBarCloses(closes: ReadonlyArray<readonly [Deployment, TriggerClose | null]>): Promise<void>;
  drainPendingBarCloses(): void;
  restoreLastBarTimestamps(deployments: Deployment[]): void;
  applySync(deployments: Deployment[]): void;
  syncRealtimeAdapters(): Promise<void>;
  spliceGapWarnedAt: Map<string, number>;
  barAheadWarnedAt: Map<string, Partial<Record<"feed" | "cursor", number>>>;
  logEvent(event: string, deploymentId: string, message: string): void;
  log(
    deploymentId: string,
    severity: string,
    category: string,
    message: string,
    subject?: { burstKey?: string | null },
  ): void;
}

/** A line written through the engine's `log()`, which names no event. */
interface PlainLine {
  deploymentId: string;
  severity: string;
  category: string;
  message: string;
  burstKey: string | null;
}

// ── Harness ─────────────────────────────────────────────────────────────────

describe("bar close (A97)", () => {
  let engine: import("./engine").TradingEngine;
  let priv: EnginePrivates;
  let shouldEnter: Record<string, ReturnType<typeof vi.fn>>;
  let shouldExit: ReturnType<typeof vi.fn>;
  let events: EventLine[];
  let lines: PlainLine[];
  /** REST's answer for the subject's read — what the provider is serving. */
  let restBars: BarData[];
  let drains: Promise<void>[];
  /** The subject's timeframe, read by the `getStrategy` double. */
  let currentTimeframe: Timeframe = "5m";

  function strategy(key: string, timeframe: Timeframe): StrategyModule {
    return {
      version: "1.0.0",
      params: {},
      config: { name: key, description: "", timeframe, size: 1, entryType: 2, indicators: [] },
      shouldEnter: shouldEnter[key],
      shouldExit,
    } as unknown as StrategyModule;
  }

  const gapLines = () => events.filter((e) => e.event === GAP_EVENT);

  beforeEach(async () => {
    vi.useFakeTimers();
    // 2026-10-14 10:00 ET, inside RTH: the boundary the ORB miss happened on.
    vi.setSystemTime(new Date("2026-10-14T14:00:01Z"));
    resetLogBursts();
    vi.mocked(collectExitFilterResults).mockClear();

    shouldEnter = { [SUBJECT]: vi.fn().mockReturnValue(null), [HOLDER]: vi.fn().mockReturnValue(null) };
    shouldExit = vi.fn().mockReturnValue(false);
    events = [];
    lines = [];
    restBars = [];
    drains = [];

    const { TradingEngine } = await import("./engine");
    const { TopstepClient } = await import("@/lib/brokers/topstep/client");
    const { TradovateClient } = await import("@/lib/brokers/tradovate/client");
    engine = new TradingEngine(new TopstepClient("http://localhost:0"), new TradovateClient("http://localhost:0"), null);
    priv = engine as unknown as EnginePrivates;
    priv.groupCache = new Map([[PARENT.id, PARENT]]);
    priv.resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "CON.F.US.MNQ.Z26",
        name: "MNQZ6",
        description: "",
        activeContract: true,
        symbolId: "/MNQ",
        tickSize: 0.25,
        tickValue: 0.5,
      }),
    };
    priv.fetchBars = vi.fn(async () => [...restBars]);
    vi.mocked(getStrategy).mockImplementation((key: string) =>
      key === SUBJECT ? strategy(SUBJECT, currentTimeframe) : strategy(key, "5m"),
    );
    vi.spyOn(priv, "logEvent").mockImplementation((event, deploymentId, message) => {
      events.push({ event, deploymentId, message });
    });
    vi.spyOn(priv, "log").mockImplementation((deploymentId, severity, category, message, subject) => {
      lines.push({ deploymentId, severity, category, message, burstKey: subject?.burstKey ?? null });
    });
    // Collect every drain the engine launches, so a test can await it.
    const runBarCloses = priv.runBarCloses.bind(priv);
    vi.spyOn(priv, "runBarCloses").mockImplementation((closes) => {
      const p = runBarCloses(closes);
      drains.push(p);
      return p;
    });
  });

  afterEach(() => {
    // An evaluation that threw is caught and logged by the tick-holder; a
    // green test over a swallowed throw asserts nothing.
    expect(events.filter((e) => e.event === "deployment_tick_failed")).toEqual([]);
    vi.useRealTimers();
  });

  function subject(timeframe: Timeframe = "5m"): Deployment {
    currentTimeframe = timeframe;
    const d = deployment("depl-subject", SUBJECT, timeframe);
    priv.realtimeDeployments = [...priv.realtimeDeployments.filter((x) => x.id !== d.id), d];
    return d;
  }

  /**
   * Another market's close takes `ticking` and parks on its bar read, which
   * is the 5m-boundary race: the MNQ 5m aggregator wins and the leg under
   * test arrives behind it. Returns the release.
   */
  function holdTicking(): { release: () => Promise<void> } {
    const holder = deployment("depl-holder", HOLDER, "5m");
    priv.realtimeDeployments = [...priv.realtimeDeployments, holder];
    let open!: () => void;
    const parked = new Promise<void>((r) => {
      open = r;
    });
    const subjectRead = priv.fetchBars;
    priv.fetchBars = vi.fn(async () => {
      priv.fetchBars = subjectRead;
      await parked;
      return [bar("2026-10-14T13:55:00.000Z")];
    });
    const run = priv.runTickForDeployments([holder], close("2026-10-14T13:55:00.000Z", null));
    expect(priv.ticking).toBe(true);
    return {
      release: async () => {
        open();
        await run;
        await settleDrains();
      },
    };
  }

  /** Settle every drain launched so far, including any a drain launched —
   *  the drain runs from a holder's `finally` and is not awaited there. */
  async function settleDrains(): Promise<void> {
    for (let seen = 0; seen < drains.length; seen++) await drains[seen];
  }

  // ── The queue ─────────────────────────────────────────────────────────────

  it("A97: a close queued behind a held tick is evaluated on its own trigger bar, not REST's older newest", async () => {
    const d = subject("5m");
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T13:50:00.000Z";
    // REST still lags at drain time: its newest is the bar before the close.
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];

    const held = holdTicking();
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
    await held.release();

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z"]);
  });

  it("A97: two queued closes for one deployment keep only the newer bar, in either arrival order", async () => {
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T13:45:00.000Z")), bar(rest("2026-10-14T13:50:00.000Z"))];

    priv.ticking = true;
    await priv.runTickForDeployments([d], close("2026-10-14T13:50:00.000Z", "2026-10-14T13:45:00.000Z"));
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    // A bar-less re-queue must not erase the bar already held.
    await priv.runTickForDeployments([d]);
    expect([...priv.pendingBarCloses.values()].map((c) => c?.bar.timestamp)).toEqual([
      "2026-10-14T13:55:00.000Z",
    ]);
    // An older close arriving late does not displace the newer one.
    await priv.runTickForDeployments([d], close("2026-10-14T13:50:00.000Z", "2026-10-14T13:45:00.000Z"));
    priv.ticking = false;
    priv.drainPendingBarCloses();
    await settleDrains();

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z"]);
  });

  it("A97: a queued close replaced by a newer one is logged at info with a burst key, naming both bars", async () => {
    const d = subject("5m");
    priv.ticking = true;
    await priv.runTickForDeployments([d], close("2026-10-14T13:50:00.000Z", "2026-10-14T13:45:00.000Z"));
    // Neither a bar-less re-queue nor an older close replaces anything.
    await priv.runTickForDeployments([d]);
    await priv.runTickForDeployments([d], close("2026-10-14T13:45:00.000Z", "2026-10-14T13:40:00.000Z"));
    expect(lines).toEqual([]);

    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    priv.ticking = false;

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      deploymentId: d.id,
      severity: "info",
      burstKey: `bar_close_replaced:${d.id}`,
    });
    expect(lines[0].message).toContain("2026-10-14T13:50:00.000Z");
    expect(lines[0].message).toContain("2026-10-14T13:55:00.000Z");
  });

  it("A97: two legs queued behind one holder each evaluate their own bar (MNQ 1m and MES 5m behind MNQ 5m)", async () => {
    shouldEnter.mnq1m = vi.fn().mockReturnValue(null);
    shouldEnter.mes5m = vi.fn().mockReturnValue(null);
    const mnq1m = { ...deployment("depl-mnq-1m", "mnq1m", "1m") };
    const mes5m = { ...deployment("depl-mes-5m", "mes5m", "5m"), ticker: "/MES" as const, contractId: "CON.F.US.MES.Z26" };
    priv.realtimeDeployments = [mnq1m, mes5m];
    priv.resolver.resolve = vi.fn(async (ticker: unknown) =>
      ticker === "/MES"
        ? { id: "CON.F.US.MES.Z26", name: "MESZ6", description: "", activeContract: true, symbolId: "/MES", tickSize: 0.25, tickValue: 1.25 }
        : { id: "CON.F.US.MNQ.Z26", name: "MNQZ6", description: "", activeContract: true, symbolId: "/MNQ", tickSize: 0.25, tickValue: 0.5 },
    );
    // Both REST reads lag their close by one bar.
    priv.fetchBars = vi.fn(async (contract: unknown, tf: unknown) =>
      (contract as { id: string }).id === "CON.F.US.MES.Z26"
        ? [bar(rest("2026-10-14T13:50:00.000Z"))]
        : tf === "1m"
          ? [bar(rest("2026-10-14T13:58:00.000Z"))]
          : [],
    );

    const held = holdTicking();
    await priv.runTickForDeployments([mnq1m], close("2026-10-14T13:59:00.000Z", "2026-10-14T13:58:00.000Z", "1m"));
    await priv.runTickForDeployments([mes5m], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z", "5m"));
    expect(priv.pendingBarCloses.size).toBe(2);
    await held.release();

    expect(evaluated(shouldEnter.mnq1m)).toEqual(["2026-10-14T13:59:00.000Z"]);
    expect(evaluated(shouldEnter.mes5m)).toEqual(["2026-10-14T13:55:00.000Z"]);
  });

  it("A97: a close queued before the leg's timeframe changed is dropped on drain, not evaluated on the new timeframe, with an info line prod keeps", async () => {
    const d = subject("5m");
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T13:50:00.000Z";
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];
    priv.ticking = true;
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z", "5m"));

    // A sync re-points the leg at 1m while the close waits.
    subject("1m");
    priv.ticking = false;
    priv.drainPendingBarCloses();
    await settleDrains();

    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-14T13:50:00.000Z");
    // A failed resubscribe drops every close here; this line is the record.
    expect(lines).toEqual([
      expect.objectContaining({
        deploymentId: d.id,
        severity: "info",
        category: "system",
        burstKey: `tf_mismatch_drop:${d.id}`,
      }),
    ]);
    expect(lines[0].message).toContain("2026-10-14T13:55:00.000Z");
    expect(lines[0].message).toContain("1m");
  });

  it("A97: stop() clears the queued bar-close slot", async () => {
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];
    priv.ticking = true;
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    expect(priv.pendingBarCloses.size).toBe(1);

    engine.stop();
    priv.ticking = false;
    priv.realtimeDeployments = [d];
    priv.drainPendingBarCloses();
    await settleDrains();

    expect(priv.pendingBarCloses.size).toBe(0);
    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
  });

  // ── Bar identity ──────────────────────────────────────────────────────────

  it("A97: a trigger bar 14:30:00.000Z and a REST bar 14:30:00+00:00 are one bar — the second evaluation is skipped", async () => {
    const d = subject("5m");
    vi.setSystemTime(new Date("2026-10-15T14:35:01Z"));
    priv.getState(d.id).lastBarTimestamp = "2026-10-15T14:25:00+00:00";

    // The direct close: REST lags, the trigger bar is spliced and evaluated.
    restBars = [bar("2026-10-15T14:25:00+00:00")];
    await priv.runTickForDeployments([d], close("2026-10-15T14:30:00.000Z", "2026-10-15T14:25:00.000Z"));
    // REST catches up and a bar-less pass reads it: the same bar, spelled
    // REST's way.
    restBars = [bar("2026-10-15T14:25:00+00:00"), bar("2026-10-15T14:30:00+00:00")];
    await priv.runTickForDeployments([d]);

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-15T14:30:00.000Z"]);
  });

  it("A97: a lagging REST bar older than the bar already evaluated is not new", async () => {
    const d = subject("5m");
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T13:55:00.000Z";
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];

    await priv.runTickForDeployments([d]);

    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-14T13:55:00.000Z");
  });

  it("A97: a queued evaluation then a direct one never skips a bar (ORB 1m, 09:59 bar closing on the 10:00 boundary, 2026-10-14)", async () => {
    const d = subject("1m");
    // 09:58 ET was evaluated on the direct path.
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T13:58:00.000Z";

    // 10:00:00 ET: MNQ 5m takes `ticking`, the 1m close of 09:59 queues, and
    // REST's newest at drain time is still 09:58.
    vi.setSystemTime(new Date("2026-10-14T14:00:00.300Z"));
    restBars = [bar(rest("2026-10-14T13:57:00.000Z")), bar(rest("2026-10-14T13:58:00.000Z"))];
    const held = holdTicking();
    await priv.runTickForDeployments([d], close("2026-10-14T13:59:00.000Z", "2026-10-14T13:58:00.000Z", "1m"));
    await held.release();

    // 10:01:00 ET: the next 1m close goes direct; REST now has 09:59.
    vi.setSystemTime(new Date("2026-10-14T14:01:00.300Z"));
    restBars = [...restBars, bar(rest("2026-10-14T13:59:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:00:00.000Z", "2026-10-14T13:59:00.000Z", "1m"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual([
      "2026-10-14T13:59:00.000Z",
      "2026-10-14T14:00:00.000Z",
    ]);
  });

  // ── The splice ────────────────────────────────────────────────────────────

  it("A97: a bar the aggregator published that REST does not hold refuses the entry with one entry_bar_series_gap line, and still manages an open position", async () => {
    // The event the engine names is one the registry carries, or the pipe
    // would downgrade it to `info`/`system` without a word.
    expect(EVENTS[GAP_EVENT]?.severity).toBe("warn");

    const flat = subject("5m");
    // REST two bars behind: 13:45 is its newest, the aggregator published
    // 13:50 and now closes 13:55. 13:50 is the hole.
    restBars = [bar(rest("2026-10-14T13:40:00.000Z")), bar(rest("2026-10-14T13:45:00.000Z"))];
    await priv.runTickForDeployments([flat], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));

    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
    expect(gapLines()).toHaveLength(1);
    expect(gapLines()[0]).toMatchObject({ deploymentId: flat.id });
    expect(gapLines()[0].message).toContain("2026-10-14T13:50:00.000Z");
    expect(gapLines()[0].message).toContain("2026-10-14T13:45:00+00:00");
    // Marked processed, as the post-outage refusal does: REST catching up
    // with the same bar later is not a second chance at the entry.
    expect(priv.getState(flat.id).lastBarTimestamp).toBe("2026-10-14T13:55:00.000Z");

    // The same hole on a leg holding a position: exits and position
    // management run on the trigger bar.
    const held = deployment("depl-in-position", SUBJECT, "5m");
    priv.realtimeDeployments = [...priv.realtimeDeployments, held];
    priv.getState(held.id).position = {
      side: 0,
      entryPrice: 21000,
      entryTimestamp: "2026-10-14T13:30:00.000Z",
      barsSinceEntry: 3,
      entryFilledAt: "2026-10-14T13:30:05.000Z",
      size: 1,
      slTicks: 40,
    };
    await priv.runTickForDeployments([held], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));

    expect(evaluated(shouldExit)).toEqual(["2026-10-14T13:55:00.000Z"]);
    expect(collectExitFilterResults).toHaveBeenCalled();
  });

  it("A97: the gap warn repeats for one deployment at most once per thirty minutes, and every repeat inside the window is an info line prod keeps", async () => {
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T13:45:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    // Inside the window (the first line went out at 14:00:01).
    vi.setSystemTime(new Date("2026-10-14T14:05:00Z"));
    await priv.runTickForDeployments([d], close("2026-10-14T14:00:00.000Z", "2026-10-14T13:55:00.000Z"));
    const repeats = () => lines.filter((l) => l.message.startsWith("Entry check skipped"));
    expect(gapLines()).toHaveLength(1);
    expect(repeats()).toHaveLength(1);
    expect(repeats()[0]).toMatchObject({ deploymentId: d.id, severity: "info", category: "trade" });
    expect(repeats()[0].message).toContain("2026-10-14T14:00:00.000Z");

    // Past five minutes is still inside: a five-minute window is one 5m bar.
    vi.setSystemTime(new Date("2026-10-14T14:10:01Z"));
    await priv.runTickForDeployments([d], close("2026-10-14T14:05:00.000Z", "2026-10-14T14:00:00.000Z"));
    expect(gapLines()).toHaveLength(1);
    expect(repeats()).toHaveLength(2);

    vi.setSystemTime(new Date("2026-10-14T14:30:02Z"));
    await priv.runTickForDeployments([d], close("2026-10-14T14:25:00.000Z", "2026-10-14T14:20:00.000Z"));
    expect(gapLines()).toHaveLength(2);
    expect(repeats()).toHaveLength(2);
    expect(shouldEnter[SUBJECT]).not.toHaveBeenCalled();
  });

  it("A97: applySync drops the gap and ahead-of-clock anchors of a removed deployment", () => {
    const kept = subject("5m");
    priv.spliceGapWarnedAt.set(kept.id, 1);
    priv.spliceGapWarnedAt.set("depl-removed", 1);
    priv.barAheadWarnedAt.set(kept.id, { feed: 1 });
    priv.barAheadWarnedAt.set("depl-removed", { cursor: 1 });
    // The broker-adapter reconcile at the end of a sync is not this test's.
    vi.spyOn(priv, "syncRealtimeAdapters").mockResolvedValue(undefined);

    priv.applySync([kept]);

    expect([...priv.spliceGapWarnedAt.keys()]).toEqual([kept.id]);
    expect([...priv.barAheadWarnedAt.keys()]).toEqual([kept.id]);
  });

  it("A97: the first bar after the daily halt enters normally", async () => {
    // 16:55 ET is the last 5m bar before the 17:00 halt; 18:00 ET opens the
    // next Globex session. Both sides published 16:55 and nothing between.
    vi.setSystemTime(new Date("2026-10-14T22:05:01Z"));
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T20:50:00.000Z")), bar(rest("2026-10-14T20:55:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-14T22:00:00.000Z", "2026-10-14T20:55:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T22:00:00.000Z"]);
    expect(gapLines()).toEqual([]);
  });

  it("A97: the first bar after a weekend enters normally", async () => {
    // Friday 2026-10-16 16:55 ET, then Sunday 2026-10-18 18:00 ET.
    vi.setSystemTime(new Date("2026-10-18T22:05:01Z"));
    const d = subject("5m");
    restBars = [bar(rest("2026-10-16T20:55:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-18T22:00:00.000Z", "2026-10-16T20:55:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-18T22:00:00.000Z"]);
    expect(gapLines()).toEqual([]);
  });

  it("A97: the bar after a bucket nobody traded in enters normally", async () => {
    // 1m: 13:58 printed nothing, so neither REST nor the aggregator has it.
    const d = subject("1m");
    restBars = [bar(rest("2026-10-14T13:56:00.000Z")), bar(rest("2026-10-14T13:57:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-14T13:59:00.000Z", "2026-10-14T13:57:00.000Z", "1m"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:59:00.000Z"]);
    expect(gapLines()).toEqual([]);
  });

  it("A97: an aggregator's first close (no previous on record) splices and enters as before", async () => {
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T13:45:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", null));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z"]);
    expect(gapLines()).toEqual([]);
  });

  // ── Bars ahead of the clock ───────────────────────────────────────────────

  const aheadLines = () => events.filter((e) => e.event === "bar_ahead_of_clock");

  it("A97: a REST bar more than one bar ahead of the clock is left out and never stamped — later closes still evaluate, and it warns once", async () => {
    expect(EVENTS.bar_ahead_of_clock?.severity).toBe("warn");
    const d = subject("5m");
    const future = rest("2026-10-14T15:00:00.000Z");
    restBars = [bar(rest("2026-10-14T13:50:00.000Z")), bar(future)];

    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-14T13:55:00.000Z");

    // The feed keeps serving the bad bar; the next close is still evaluated.
    // Inside the window the first warn opened at 14:00:01.
    vi.setSystemTime(new Date("2026-10-14T14:05:00Z"));
    restBars = [bar(rest("2026-10-14T13:50:00.000Z")), bar(rest("2026-10-14T13:55:00.000Z")), bar(future)];
    await priv.runTickForDeployments([d], close("2026-10-14T14:00:00.000Z", "2026-10-14T13:55:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z", "2026-10-14T14:00:00.000Z"]);
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-14T14:00:00.000Z");
    expect(aheadLines()).toHaveLength(1);
    expect(aheadLines()[0].message).toContain(future);
  });

  /** Every warn written, through either seam. */
  const warns = () => [
    ...events.filter((e) => EVENTS[e.event]?.severity === "warn"),
    ...lines.filter((l) => l.severity === "warn"),
  ];

  it("A97: a feed serving a new bar ahead of the clock on every close warns once per deployment per thirty minutes, not once per bar", async () => {
    const d = subject("5m");
    restBars = [bar(rest("2026-10-14T13:50:00.000Z")), bar(rest("2026-10-14T15:00:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));

    // Inside the window: a different bad bar, so a timestamp key would warn.
    vi.setSystemTime(new Date("2026-10-14T14:05:00Z"));
    restBars = [bar(rest("2026-10-14T13:55:00.000Z")), bar(rest("2026-10-14T15:05:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:00:00.000Z", "2026-10-14T13:55:00.000Z"));
    expect(aheadLines()).toHaveLength(1);

    // Past five minutes is still inside: a five-minute window is one 5m bar.
    vi.setSystemTime(new Date("2026-10-14T14:10:02Z"));
    restBars = [bar(rest("2026-10-14T14:00:00.000Z")), bar(rest("2026-10-14T15:10:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:05:00.000Z", "2026-10-14T14:00:00.000Z"));
    expect(aheadLines()).toHaveLength(1);

    // Past the window it warns again.
    vi.setSystemTime(new Date("2026-10-14T14:30:03Z"));
    restBars = [bar(rest("2026-10-14T14:20:00.000Z")), bar(rest("2026-10-14T15:35:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:25:00.000Z", "2026-10-14T14:20:00.000Z"));

    expect(aheadLines()).toHaveLength(2);
    expect(aheadLines()[1].message).toContain(rest("2026-10-14T15:35:00.000Z"));
    expect(evaluated(shouldEnter[SUBJECT])).toEqual([
      "2026-10-14T13:55:00.000Z",
      "2026-10-14T14:00:00.000Z",
      "2026-10-14T14:05:00.000Z",
      "2026-10-14T14:25:00.000Z",
    ]);
  });

  it("A97: a trigger bar ahead of the clock is a clock fault — not appended, stamped or evaluated; REST's new newest is; one engine-scoped warn says how far behind", async () => {
    expect(EVENTS.engine_clock_behind?.severity).toBe("warn");
    const d = subject("5m");
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T13:50:00.000Z";
    // 14:00:01 on the engine's clock; the feed closed 14:10, which opens past
    // 14:05:01. The exchange was at 14:15:00 or later when it closed.
    restBars = [bar(rest("2026-10-14T13:50:00.000Z")), bar(rest("2026-10-14T13:55:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:10:00.000Z", "2026-10-14T14:05:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual([rest("2026-10-14T13:55:00.000Z")]);
    expect(priv.getState(d.id).lastBarTimestamp).toBe(rest("2026-10-14T13:55:00.000Z"));
    // The trigger's `previousPublishedAt` is ahead of REST too: a splice that
    // ran would have refused the entry over a hole.
    expect(gapLines()).toEqual([]);
    expect(warns()).toEqual([expect.objectContaining({ event: "engine_clock_behind", deploymentId: ENGINE_SCOPE })]);
    expect(warns()[0].message).toContain("899s behind the exchange");

    // The next close, still ahead: REST's newest is not new, nothing is
    // evaluated, and the engine-wide throttle holds the warn.
    vi.setSystemTime(new Date("2026-10-14T14:05:00Z"));
    await priv.runTickForDeployments([d], close("2026-10-14T14:15:00.000Z", "2026-10-14T14:10:00.000Z"));
    expect(shouldEnter[SUBJECT]).toHaveBeenCalledTimes(1);
    expect(warns()).toHaveLength(1);
  });

  it("A97: a bar exactly one bar ahead of the clock is still a bar", async () => {
    const d = subject("5m");
    // 14:00:01 + 5m: a bar opening at 14:05:01 would be the limit; 14:05:00 is inside it.
    restBars = [bar(rest("2026-10-14T14:05:00.000Z"))];

    await priv.runTickForDeployments([d]);

    expect(evaluated(shouldEnter[SUBJECT])).toEqual([rest("2026-10-14T14:05:00.000Z")]);
    expect(aheadLines()).toEqual([]);
  });

  it("A97: a live bar cursor ahead of the clock is stale — one warn, the bar is evaluated, and the cursor is overwritten", async () => {
    const { setLastBarTimestamp } = await import("@/lib/db/settings");
    const d = subject("5m");
    priv.getState(d.id).lastBarTimestamp = "2026-10-14T16:00:00.000Z";
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z"]);
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-14T13:55:00.000Z");
    expect(vi.mocked(setLastBarTimestamp)).toHaveBeenLastCalledWith(d.id, "2026-10-14T13:55:00.000Z");
    expect(aheadLines()).toHaveLength(1);
    expect(aheadLines()[0].message).toContain("2026-10-14T16:00:00.000Z");
  });

  it("A97: a bar cursor restored from the database ahead of the clock is stale too", async () => {
    const { getLastBarTimestamp } = await import("@/lib/db/settings");
    const d = subject("5m");
    vi.mocked(getLastBarTimestamp).mockReturnValueOnce("2026-10-15T09:00:00+00:00");
    priv.restoreLastBarTimestamps([d]);
    expect(priv.getState(d.id).lastBarTimestamp).toBe("2026-10-15T09:00:00+00:00");
    restBars = [bar(rest("2026-10-14T13:50:00.000Z"))];

    await priv.runTickForDeployments([d], close("2026-10-14T13:55:00.000Z", "2026-10-14T13:50:00.000Z"));
    vi.setSystemTime(new Date("2026-10-14T14:05:01Z"));
    restBars = [...restBars, bar(rest("2026-10-14T13:55:00.000Z"))];
    await priv.runTickForDeployments([d], close("2026-10-14T14:00:00.000Z", "2026-10-14T13:55:00.000Z"));

    expect(evaluated(shouldEnter[SUBJECT])).toEqual(["2026-10-14T13:55:00.000Z", "2026-10-14T14:00:00.000Z"]);
    expect(aheadLines()).toHaveLength(1);
  });

  // ── Passive mode ──────────────────────────────────────────────────────────

  it("A97: passive mode, with no trigger bar, evaluates REST's newest bar once and refuses nothing over a gap", async () => {
    const d = subject("5m");
    // A gap in REST's own series is the provider's answer, not a splice.
    restBars = [bar(rest("2026-10-14T13:40:00.000Z")), bar(rest("2026-10-14T13:50:00.000Z"))];

    await priv.runTickForDeployments([d]);
    await priv.runTickForDeployments([d]);

    expect(evaluated(shouldEnter[SUBJECT])).toEqual([rest("2026-10-14T13:50:00.000Z")]);
    expect(gapLines()).toEqual([]);
  });
});
