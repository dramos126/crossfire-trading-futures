/**
 * The engine's half of P6: what `applyRestartVerdict` does with D-13's
 * decision, and where the heartbeat that decision reads is stamped.
 *
 * Access pattern: `(engine as any).state` / `.restartGuard`, as the sibling
 * engine tests do. The mock scaffold is `engine.pluginFor.test.ts`'s — the
 * engine's import graph is what needs it, not these assertions.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ── DB + heavy-dependency stubs (must be hoisted) ─────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
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

// This process holds the engine lease unless a test says otherwise; the
// refusal is pinned under "start() without the engine lease" below.
const LEASE = vi.hoisted(() => ({ held: true, reportLeaseRefused: vi.fn() }));
vi.mock("@/lib/db/lease", () => ({
  holdsLease: () => LEASE.held,
  leaseGate: () => () => LEASE.held,
  reportLeaseRefused: LEASE.reportLeaseRefused,
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
  listSessionLatchedEntries: vi.fn().mockReturnValue([]),
  markBreakEvenMoved: vi.fn(),
  markSlTrailEngaged: vi.fn(),
  markEntryFailed: vi.fn(),
  markEntryFilled: vi.fn(),
  saveTradeBars: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
  setExitReason: vi.fn(),
  backfillExitOrderId: vi.fn(),
}));

// Every leg has a parent, and the entry gate reads it — an absent parent
// refuses the leg, which would silence every entry in this file.
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
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

// Always in-window, so the flap-breaker tests below cannot pass because the
// session gate returned first.
vi.mock("@/lib/trading/session/session", () => ({
  collectSessionWindows: vi.fn().mockReturnValue([{ start: "00:00", end: "23:59" }]),
  isInAnySessionWindow: vi.fn().mockReturnValue(true),
  currentCmeSessionStart: vi.fn().mockReturnValue(new Date("2026-05-15T13:30:00Z")),
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

// `tripped` is the field the engine reads; a `blocked` here was inert and
// passed only because `undefined` is falsy.
vi.mock("@/lib/trading/daily-pnl-gate", () => ({
  evaluateDailyPnlGate: vi
    .fn()
    .mockReturnValue({ tripped: false, side: null, thresholdUsd: null, effectivePnl: 0 }),
}));

// ── Imports (after vi.mock hoisting) ──────────────────────────────────────────

import { TradingEngine } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { BrokerRegistry } from "@/lib/brokers/registry";
import {
  markHeartbeatDegraded,
  readEngineRestartState,
  setPendingFlatten,
  stampEngineHeartbeat,
  type PendingFlatten,
} from "@/lib/db/engine-restart";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { getDeployment } from "@/lib/db/deployments";
import type { BarData, Contract } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { StrategyModule } from "../strategy-types";
import type { RestartVerdict } from "./boot/engine-restart";
import { EVENTS } from "@/lib/logging/vocabulary";

const DEPL_A = "depl-a";
const DEPL_B = "depl-b";

function makeEngine(): TradingEngine {
  return new TradingEngine(
    new TopstepClient("http://localhost:0"),
    null,
    null,
    new BrokerRegistry(),
  );
}

/**
 * Capture every line the engine emits, through **both** seams.
 *
 * The restart path speaks partly through named events and partly through
 * the level-taking seam, and which is which is a classification decision
 * rather than a property these tests are about — they are about whether the
 * breaker's one operator-visible line exists at all. Recording both keeps
 * them asserting that, and the severity a named line reports is the
 * registry's, which is the only place it lives.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching a private seam is the point
function recordLines(engine: any, sink: (line: { level: string; message: string }) => void): void {
  engine.log = (_d: string, severity: string, _category: string, message: string) =>
    sink({ level: severity, message });
  engine.logEvent = (event: string, _d: string, message: string) =>
    sink({ level: EVENTS[event]?.severity ?? "info", message });
}

function verdict(over: Partial<RestartVerdict> = {}): RestartVerdict {
  return {
    gapMs: 20 * 60_000,
    clean: false,
    flatten: true,
    alarm: true,
    heartbeatDegraded: false,
    flapCycles: 1,
    entriesSuspended: false,
    ...over,
  };
}

const OWED_GAP = 20 * 60_000;
const OWED_SEED = Date.parse("2026-05-15T09:00:00.000Z");

function owed(
  deploymentIds: string[] = [],
  gapMs = OWED_GAP,
  seededAt = OWED_SEED,
): PendingFlatten {
  return { entries: deploymentIds.map((deploymentId) => ({ deploymentId, seededAt })), gapMs };
}

function restartState(pendingFlatten: PendingFlatten) {
  return {
    lastSeenAt: null,
    cleanShutdownAt: null,
    resumeCycles: [] as number[],
    pendingFlatten,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- private-surface access, as the sibling engine tests do */

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TradingEngine.applyRestartVerdict", () => {
  it("seeds the downtime sweep and latches suppression on a long gap", () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed([DEPL_A, DEPL_B]));

    expect((engine as any).restartGuard.pendingCount()).toBe(2);
    expect((engine as any).state.get(DEPL_A).signalSuppressed).toBe(true);
    expect((engine as any).state.get(DEPL_B).signalSuppressed).toBe(true);
  });

  it("acts on an owed set that this boot's verdict says to keep", () => {
    // C1 / D-7. The obligation is durable and the boot path re-seeds it
    // regardless of the new classification — which is exactly the boot the old
    // in-memory set was lost on: the operator restarts the container to clear
    // the broker connection the sweep is failing against, and the fresh
    // heartbeat makes the new verdict "keep".
    const engine = makeEngine();
    engine.applyRestartVerdict(
      verdict({ flatten: false, clean: true, alarm: false, gapMs: 30_000, flapCycles: 0 }),
      owed([DEPL_A], 4 * 60 * 60_000),
    );

    expect((engine as any).restartGuard.pendingCount()).toBe(1);
    expect((engine as any).state.get(DEPL_A).signalSuppressed).toBe(true);
  });

  it("reports the outage that created the obligation, not this boot's gap", async () => {
    // The guard's line is what an operator reads after finding a position
    // force-closed. Taking the gap off `verdict.gapMs` instead of off the
    // carried set would say "30s" about a four-hour outage — Injection A's
    // failure arriving through the log rather than through the order.
    const engine = makeEngine();
    engine.applyRestartVerdict(
      verdict({ flatten: false, gapMs: 30_000 }),
      owed([DEPL_A], 4 * 60 * 60_000),
    );
    const logged: string[] = [];
    recordLines(engine, (line) => logged.push(line.message));
    vi.mocked(getDeployment).mockReturnValue(makeDeployment());
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    await (engine as any).restartGuard.runRestartFlatten();

    expect(logged.some((m) => m.includes("4h"))).toBe(true);
    expect(logged.some((m) => m.includes("30s"))).toBe(false);
  });

  it("seeds nothing when nothing is owed, whatever the verdict says", () => {
    // D-13's middle row, and the empty case: a crash that recovered inside the
    // duration rule owes nothing, so the boot path hands over an empty set.
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ flatten: false, clean: false, gapMs: 20_000 }), owed());

    expect((engine as any).restartGuard.pendingCount()).toBe(0);
    expect((engine as any).state.size).toBe(0);
  });

  it("suppresses nothing when the long gap held no positions", () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed());
    expect((engine as any).restartGuard.pendingCount()).toBe(0);
    expect((engine as any).state.size).toBe(0);
  });

  it("carries the flap breaker onto the engine, independently of the flatten", () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(
      verdict({ flatten: false, entriesSuspended: true, flapCycles: 3 }),
      owed(),
    );
    expect((engine as any).entriesSuspended).toBe(true);
  });

  it("announces the tripped flap breaker through the durable log, not just the console", () => {
    // The breaker's ENTIRE operator-visible surface. `@/lib/logger`'s `emit`
    // writes to `console.*` and nothing else, so the boot path's `log.error`
    // never reaches `engine_logs`; `this.log` is the only path that does.
    // Without this line the UI shows every leg `Active` and never entering,
    // with no answer to "why is my bot not trading" — the breaker is
    // deliberately not a deployment status, so nothing else can report it.
    const engine = makeEngine();
    const logged: { level: string; message: string }[] = [];
    recordLines(engine, (line) => logged.push(line));

    engine.applyRestartVerdict(
      verdict({ flatten: false, entriesSuspended: true, flapCycles: 4 }),
      owed(),
    );

    const announcement = logged.find((l) => l.message.includes("Flap breaker"));
    expect(announcement).toBeDefined();
    expect(announcement!.level).toBe("warn");
    // Says the count, and says open positions are still managed — the half
    // operators most need, since "no entries" reads as "engine is off".
    expect(announcement!.message).toContain("4");
    expect(announcement!.message).toMatch(/still|keep/i);
  });

  it("stays silent about the breaker when it did not trip", () => {
    const engine = makeEngine();
    const logged: string[] = [];
    recordLines(engine, (line) => logged.push(line.message));

    engine.applyRestartVerdict(verdict({ entriesSuspended: false }), owed([DEPL_A]));

    expect(logged.some((m) => m.includes("Flap breaker"))).toBe(false);
  });

  it("leaves entries alone below the flap limit", () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ entriesSuspended: false }), owed([DEPL_A]));
    expect((engine as any).entriesSuspended).toBe(false);
  });

  it("writes the seeded set through to the durable record", () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed([DEPL_A, DEPL_B]));
    expect(setPendingFlatten).toHaveBeenCalledWith(
      [
        { deploymentId: DEPL_A, seededAt: OWED_SEED },
        { deploymentId: DEPL_B, seededAt: OWED_SEED },
      ],
      OWED_GAP,
    );
  });

  it("does not let a failed durable write stop the sweep being seeded", () => {
    vi.mocked(setPendingFlatten).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed([DEPL_A]));
    expect((engine as any).restartGuard.pendingCount()).toBe(1);
  });
});

// ── The binding that gives the owed set its trade identity ─────────────────

describe("the sweep's view of which position is owed", () => {
  // `vi.clearAllMocks()` clears calls, not implementations, and the shared
  // trade-row stub is read by every later test in this file.
  afterEach(() => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  /** The one field the identity check reads, off the real binding. */
  function openTradeStartedAt(entrySubmittedAt: string) {
    return { id: 1, deploymentId: DEPL_A, entrySubmittedAt } as unknown as ReturnType<
      typeof getOpenTradeForDeployment
    >;
  }

  it("retires the obligation when the open row postdates the seed", async () => {
    // End to end through the engine's own dep binding, which is where the
    // trade row's `entry_submitted_at` becomes the instant compared against
    // the seed. A deployment id alone cannot tell these two rows apart.
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed([DEPL_A], 4 * 60 * 60_000, OWED_SEED));
    const logged: string[] = [];
    recordLines(engine, (line) => logged.push(line.message));
    vi.mocked(getDeployment).mockReturnValue(makeDeployment());
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      openTradeStartedAt(new Date(OWED_SEED + 5_000).toISOString()),
    );

    await (engine as any).restartGuard.runRestartFlatten();

    expect((engine as any).restartGuard.pendingCount()).toBe(0);
    expect(logged.some((m) => m.includes("after this sweep was seeded"))).toBe(true);
  });

  it("keeps the obligation when the open row predates the seed", async () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict(), owed([DEPL_A], 4 * 60 * 60_000, OWED_SEED));
    recordLines(engine, () => {});
    vi.mocked(getDeployment).mockReturnValue(makeDeployment());
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      openTradeStartedAt(new Date(OWED_SEED - 60_000).toISOString()),
    );

    await (engine as any).restartGuard.runRestartFlatten();

    expect((engine as any).restartGuard.pendingCount()).toBe(1);
  });
});

// ── Every entry point, not just the boot path ──────────────────────────────

describe("TradingEngine.start and the outstanding obligation", () => {
  // `runBootSequence` hands the verdict over after seven early returns, and
  // two other callers reach `start()` without going through it at all
  // (`maybeAutoStart` and `action: "start"` on /api/engine). The reachable
  // sequence: a long outage with the broker unreachable orphans every account,
  // `listManagedDeployments()` comes back empty, boot returns
  // `no-enabled-after-orphan-check` having applied nothing, the broker
  // recovers, and the operator re-enables from the UI.
  it("seeds a carried obligation the boot path never handed over", () => {
    vi.mocked(readEngineRestartState).mockReturnValueOnce(
      restartState(owed([DEPL_A], 4 * 60 * 60_000)),
    );
    const engine = makeEngine();
    const logged: { level: string; message: string }[] = [];
    recordLines(engine, (line) => logged.push(line));

    try {
      engine.start([]);
      expect((engine as any).restartGuard.pendingCount()).toBe(1);
      expect((engine as any).state.get(DEPL_A).signalSuppressed).toBe(true);
      const announcement = logged.find((l) => l.message.includes("[RESTART]"));
      expect(announcement).toBeDefined();
      expect(announcement!.level).toBe("error");
      // Same units as the boot lines it stands in for: this one prints minutes
      // after them, into the same stream.
      expect(announcement!.message).toContain("after 4h unmanaged");
      expect(announcement!.message).not.toContain("14400s");
    } finally {
      engine.stop();
      (engine as any).stopRestartFlattenGuard();
    }
  });

  it("does not re-read the obligation once the boot path has applied a verdict", () => {
    // The latch is the whole reason a 09:00 verdict cannot force-close a
    // position opened at 14:15. `start()` must observe it, not bypass it.
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ flatten: false }), owed());
    vi.mocked(readEngineRestartState).mockClear();

    try {
      engine.start([]);
      expect(readEngineRestartState).not.toHaveBeenCalled();
    } finally {
      engine.stop();
    }
  });

  it("starts normally when nothing is owed and nothing was applied", () => {
    vi.mocked(readEngineRestartState).mockReturnValueOnce(
      restartState({ entries: [], gapMs: 0 }),
    );
    const engine = makeEngine();
    const logged: string[] = [];
    recordLines(engine, (line) => logged.push(line.message));

    try {
      engine.start([]);
      expect((engine as any).restartGuard.pendingCount()).toBe(0);
      expect(logged.some((m) => m.includes("[RESTART]"))).toBe(false);
    } finally {
      engine.stop();
    }
  });

  it("does not let an unreadable obligation stop the engine starting", () => {
    vi.mocked(readEngineRestartState).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const engine = makeEngine();
    try {
      expect(() => engine.start([])).not.toThrow();
    } finally {
      engine.stop();
    }
  });

  it("does not latch the hand-over when the read threw and nothing was applied", () => {
    // The latch is set at the point of application, not at classification. A
    // transient SQLITE_BUSY on this read applied nothing, so latching here
    // would close the boot door for the life of the process: a later
    // `runBootSequence` carrying a live `flatten` verdict reads
    // `hasAppliedRestartVerdict()` and never hands it over.
    vi.mocked(readEngineRestartState).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const engine = makeEngine();
    try {
      engine.start([]);
      expect(engine.hasAppliedRestartVerdict()).toBe(false);
    } finally {
      engine.stop();
    }
  });

  it("does not latch the hand-over when nothing was owed", () => {
    vi.mocked(readEngineRestartState).mockReturnValueOnce(
      restartState({ entries: [], gapMs: 0 }),
    );
    const engine = makeEngine();
    try {
      engine.start([]);
      expect(engine.hasAppliedRestartVerdict()).toBe(false);
    } finally {
      engine.stop();
    }
  });
});

describe("start() without the engine lease", () => {
  // `start()` is reached from `/api/engine` and `maybeAutoStart` as well as
  // from boot, which is where the lease is taken. Another process holding it
  // means another engine on this database: starting here double-trades.
  afterEach(() => {
    LEASE.held = true;
  });

  it("arms nothing, reads no obligation, and says why", () => {
    LEASE.held = false;
    const engine = makeEngine();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      engine.start([]);

      expect(LEASE.reportLeaseRefused).toHaveBeenCalledWith("start()");
      expect(engine.isRunning()).toBe(false);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(readEngineRestartState).not.toHaveBeenCalled();
      expect((engine as any).restartGuard.pendingCount()).toBe(0);
      expect(engine.hasAppliedRestartVerdict()).toBe(false);
    } finally {
      setIntervalSpy.mockRestore();
      engine.stop();
    }
  });
});

describe("engine heartbeat", () => {
  it("stamps on a tick", async () => {
    const engine = makeEngine();
    await (engine as any).runTick([]);
    expect(stampEngineHeartbeat).toHaveBeenCalled();
  });

  it("stamps even when the tick is skipped because the previous one is still running", async () => {
    // A tick skipped for single-flight is an engine that is very much alive.
    // Reading that as absence is how a slow reconciler would manufacture a
    // flatten on the next boot.
    const engine = makeEngine();
    (engine as any).ticking = true;
    await (engine as any).runTick([]);
    expect(stampEngineHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("stamps on a reconcile-only tick that is skipped for the same reason", async () => {
    const engine = makeEngine();
    (engine as any).ticking = true;
    await (engine as any).runReconcileOnly();
    expect(stampEngineHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed heartbeat write take down the tick", async () => {
    const engine = makeEngine();
    vi.mocked(stampEngineHeartbeat).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect((engine as any).runTick([])).resolves.toBeUndefined();
  });

  it("records that the next boot's duration reading is untrustworthy", async () => {
    // `classifyRestart` cannot tell "absent for twelve minutes" from "running
    // and could not write", and the second reads here as the first. Without
    // this marker a healthy, trading engine on a locked database gets
    // everything force-closed on the next boot.
    const engine = makeEngine();
    vi.mocked(stampEngineHeartbeat).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await (engine as any).runTick([]);
    expect(markHeartbeatDegraded).toHaveBeenCalledTimes(1);
  });

  it("records nothing on a stamp that succeeded", () => {
    // The negative is only evidence beside a positive: the marker must not be
    // written by every tick, or the duration rule is disabled permanently.
    const engine = makeEngine();
    (engine as any).noteEngineAlive();
    expect(markHeartbeatDegraded).not.toHaveBeenCalled();
  });

  it("keeps recording past the log throttle window", async () => {
    // The throttle exists for the ring buffer, not for the record. A failure
    // window that opened before the first warning and closes after it must
    // still leave a marker behind.
    const engine = makeEngine();
    (engine as any).heartbeatWriteWarnedAt = Date.now();
    const boom = (): never => {
      throw new Error("database is locked");
    };
    vi.mocked(stampEngineHeartbeat).mockImplementationOnce(boom).mockImplementationOnce(boom);
    await (engine as any).runTick([]);
    await (engine as any).runTick([]);
    expect(markHeartbeatDegraded).toHaveBeenCalledTimes(2);
  });

  it("survives a database that cannot take the marker either", async () => {
    const engine = makeEngine();
    vi.mocked(stampEngineHeartbeat).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    vi.mocked(markHeartbeatDegraded).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect((engine as any).runTick([])).resolves.toBeUndefined();
  });
});

// ── first_tick: the deploy measurement's last boundary ─────────────────────

describe("first_tick", () => {
  /** A fresh copy of the engine module, so its once-per-process latch starts
   *  unset, with the pipe's `log.event` watched for the line. */
  async function freshProcess() {
    vi.resetModules();
    const { log } = await import("@/lib/logger");
    const events = vi.spyOn(log, "event");
    const { TradingEngine: FreshEngine } = await import("./engine");
    const { TopstepClient: FreshClient } = await import("@/lib/brokers/topstep/client");
    const { BrokerRegistry: FreshRegistry } = await import("@/lib/brokers/registry");
    const make = () =>
      new FreshEngine(new FreshClient("http://localhost:0"), null, null, new FreshRegistry());
    const firstTicks = () => events.mock.calls.filter((c) => c[0] === "first_tick");
    return { make, firstTicks, events };
  }

  it("is said once, on the first tick body that has a deployment to run", async () => {
    const { make, firstTicks, events } = await freshProcess();
    const engine = make();

    await (engine as any).runTick([]);
    expect(firstTicks()).toHaveLength(0);

    await (engine as any).runTick([makeDeployment()]);
    await (engine as any).runTick([makeDeployment()]);
    expect(firstTicks()).toHaveLength(1);
    expect(String(firstTicks()[0][2])).toMatch(
      /^First engine tick ran \d+ms after process start, with 1 deployment\(s\)$/,
    );
    events.mockRestore();
  });

  it("is said once per process, not once per engine start — a second engine says nothing", async () => {
    // An in-process stop → start is not a deploy; neither is the wizard
    // building an engine after a cold start did.
    const { make, firstTicks, events } = await freshProcess();
    await (make() as any).runTick([makeDeployment()]);
    const second = make();
    await (second as any).runTick([makeDeployment()]);

    expect(firstTicks()).toHaveLength(1);
    events.mockRestore();
  });

  it("is not said by a tick skipped for a predecessor still running", async () => {
    const { make, firstTicks, events } = await freshProcess();
    const engine = make();
    (engine as any).ticking = true;
    await (engine as any).runTick([makeDeployment()]);

    expect(firstTicks()).toHaveLength(0);
    expect(EVENTS.first_tick).toMatchObject({ severity: "info", category: "lifecycle" });
    events.mockRestore();
  });
});

// ── The flap breaker, through processDeployment ────────────────────────────

const STUB_CONTRACT = {
  id: "CON.F.US.MNQ.M26",
  name: "MNQM26",
  description: "",
  tickSize: 0.25,
  tickValue: 0.5,
  activeContract: true,
} as unknown as Contract;

function makeDeployment(): Deployment {
  return {
    id: DEPL_A,
    strategyKey: "test-strat",
    accountId: 1001,
    ticker: "/MNQ",
    contractId: "CON.F.US.MNQ.M26",
    status: "Active",
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

function makeBar(timestamp: string, close = 21000): BarData {
  return { timestamp, open: close - 10, high: close + 5, low: close - 15, close, volume: 150 };
}

function makeStrategy(over: Partial<StrategyModule> = {}): StrategyModule {
  return {
    version: "1.0.0",
    params: {},
    config: {
      name: "Test Strategy",
      description: "",
      timeframe: "1m",
      size: 1,
      entryType: 2,
      indicators: [],
    },
    shouldEnter: vi.fn().mockReturnValue(null),
    shouldExit: vi.fn().mockReturnValue(false),
    ...over,
  } as unknown as StrategyModule;
}

async function runEval(
  engine: TradingEngine,
  strategy: StrategyModule,
  bar: BarData,
): Promise<void> {
  (engine as any).resolver = { resolve: vi.fn().mockResolvedValue(STUB_CONTRACT) };
  (engine as any).fetchBars = vi.fn().mockResolvedValue([bar]);
  // `processDeployment` is called directly here, so nothing has run
  // `refreshGroupCache()` — `start()`'s first tick primes it in production
  // and `sync()` keeps it current. The entry gate reads that cache and
  // refuses a leg whose parent is not in it.
  (engine as unknown as { groupCache: Map<string, unknown> }).groupCache = new Map([
    [PARENT.id, PARENT],
  ]);
  await (engine as any).processDeployment(strategy, makeDeployment());
}

describe("flap breaker", () => {
  it("stops the entry evaluation from running at all", async () => {
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ flatten: false, entriesSuspended: true }), owed());
    const strategy = makeStrategy();

    await runEval(engine, strategy, makeBar("2026-05-15T14:30:00.000Z"));

    expect(strategy.shouldEnter).not.toHaveBeenCalled();
  });

  it("evaluates entries normally when it has not tripped", async () => {
    // The negative above is only evidence if the same harness reaches
    // `shouldEnter` with the breaker off — otherwise it would keep passing
    // against a gate that never runs.
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ flatten: false, entriesSuspended: false }), owed());
    const strategy = makeStrategy();

    await runEval(engine, strategy, makeBar("2026-05-15T14:30:00.000Z"));

    expect(strategy.shouldEnter).toHaveBeenCalled();
  });

  it("still exits an open position while entries are suspended", async () => {
    // Entries only. A crash loop is not a reason to stop managing a position
    // the engine already opened — if this gate ever moved above the exit
    // evaluation it would strand every open trade for the life of the process.
    const engine = makeEngine();
    engine.applyRestartVerdict(verdict({ flatten: false, entriesSuspended: true }), owed());
    const exitSpy = vi.fn().mockResolvedValue(undefined);
    (engine as any).placeExitOrder = exitSpy;
    (engine as any).state.set(DEPL_A, {
      lastBarTimestamp: null,
      cooldownAnchorAt: null,
      position: {
        side: 0,
        entryPrice: 21000,
        entryTimestamp: "2026-05-15T14:00:00.000Z",
        barsSinceEntry: 3,
        entryFilledAt: "2026-05-15T14:00:01.000Z",
        size: 1,
        slTicks: 40,
      },
      activeTradeId: 77,
      breakEvenMoved: false,
      preEntryOrderIds: null,
      activeTpTicks: null,
      activeSlTicks: null,
      slMovedToBe: false,
      slCurrentPrice: null,
      tpCurrentPrice: null,
      exitInFlight: false,
      flatMismatchWarnedAt: null,
      pendingEntrySessionKey: null,
      signalSuppressed: false,
    });
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const strategy = makeStrategy({ shouldExit: vi.fn().mockReturnValue(true) });

    await runEval(engine, strategy, makeBar("2026-05-15T14:30:00.000Z"));

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
