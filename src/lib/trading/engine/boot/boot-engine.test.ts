/**
 * The boot sequence's restart half: where D-13's classification sits relative
 * to the early returns, and what stops a verdict from being applied twice.
 *
 * Both properties are stated as load-bearing in the module doc and neither was
 * enforced by anything until this file — moving `classifyBoot()` below the
 * early returns, and deleting the memo, both passed the whole suite.
 *
 * Everything `boot-engine` imports is mocked: the assertions are about *order*
 * and *arity*, not about broker or database behaviour. `vi.hoisted` holds the
 * stubs so `vi.resetModules()` can give each test a fresh copy of the module's
 * own `bootVerdict` / `verdictApplied` without also resetting them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Account, Contract } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { DeploymentState } from "../engine";
import type { LivenessGate, RestartVerdict } from "./engine-restart";
import type { PendingFlatten } from "@/lib/db/engine-restart";
import type { HandoffAsk } from "@/lib/db/lease";
import { FlattenCooldown } from "../engine-flatten-cooldown";
import { describeHubReadiness } from "./boot-engine";
import { EVENTS, type Severity } from "@/lib/logging/vocabulary";
import { PROD_PLAYBOOK_KEYS } from "@/lib/trading/strategies/prod-playbooks";

const H = vi.hoisted(() => {
  /** A fan-out where every configured arm answered. */
  const cleanRefresh = () => ({
    partial: false,
    errors: { topstep: null as string | null, tradovate: null as string | null },
    size: 1,
    removed: [] as number[],
    kindChanges: [] as unknown[],
  });
  /** A fan-out where one arm threw and the other answered. */
  const armDown = (
    kind: "topstep" | "tradovate",
    message: string,
  ): ReturnType<typeof cleanRefresh> => {
    const r = cleanRefresh();
    r.partial = true;
    r.errors[kind] = message;
    return r;
  };
  // The application latch lives on the engine, because `start()` is the other
  // door onto the same obligation. Modelled statefully here rather than as a
  // bare `vi.fn()`: the once-per-process property is what several of these
  // tests are about, and a latch that always answers "not yet" would let them
  // pass against an engine that had none.
  const applied = { value: false };
  const hubs: { value: { attempted: boolean; market: boolean; user: boolean } } = {
    value: { attempted: true, market: true, user: true },
  };
  const engine = {
    // Returns a readiness reading, because the idle-boot line renders it
    // rather than asserting it (A56). Both feeds up by default.
    ensureHubsReady: vi.fn(async () => hubs.value),
    refreshBrokerRegistry: vi.fn(async () => cleanRefresh()),
    isAccountRegistered: vi.fn(() => true),
    handleOrphanedAccount: vi.fn(async () => {}),
    isRunning: vi.fn(() => false),
    hasAppliedRestartVerdict: vi.fn(() => applied.value),
    applyRestartVerdict: vi.fn((_verdict: RestartVerdict, _owed: PendingFlatten) => {
      applied.value = true;
    }),
    start: vi.fn(),
  };
  return {
    engine,
    applied,
    hubs,
    cleanRefresh,
    armDown,
    getAccountBrokerOrNull: vi.fn<(accountId: number) => "topstep" | "tradovate" | null>(
      () => "topstep",
    ),
    getEngine: vi.fn(async () => engine),
    evaluateRestart: vi.fn(),
    readOwedFlatten: vi.fn(),
    installCleanShutdownMarker: vi.fn(),
    startProcessLiveness: vi.fn(),
    getAllOpenTrades: vi.fn(() => [] as Array<{ deploymentId: string }>),
    listAccountsWithReconcilableTrades: vi.fn(() => [] as number[]),
    getEngineIfReady: vi.fn<() => { isRunning: () => boolean; stop?: () => void } | null>(
      () => null,
    ),
    listManagedDeployments: vi.fn(() => [] as Deployment[]),
    readManagedDeployments: vi.fn(() => ({
      deployments: [] as Deployment[],
      withheldLiveAccounts: [] as Array<{ id: string; reason: string }>,
      skippedNotAllowed: [] as Array<{ id: string; accountId: number }>,
    })),
    runPendingSessionMigrations: vi.fn(async () => ({ migrated: [], blocked: [] })),
    getOpenTradeForDeployment: vi.fn(() => null),
    runBookReconcile: vi.fn((_opts: { resumed?: unknown; inPosition: unknown }) => ({
      plan: { creates: [], standDowns: [], resumes: [], conflicts: [], refusals: [] },
      created: [],
      stoodDown: [],
      resumed: [],
      pausing: 0,
    })),
    runRetireOffCellRows: vi.fn(() => ({ retired: [] })),
    reportBookMigrations: vi.fn(),
    registeredStrategyKeys: vi.fn<() => string[]>(() => []),
    isStagingEnv: vi.fn(() => false),
    realtime: vi.fn(() => ({})),
    markBootAssertionFailed: vi.fn(),
    markBootAssertionPassed: vi.fn(),
    sendDiscordAlert: vi.fn(async (_embed: AlertEmbed) => {}),
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logEvent: vi.fn(),
    tryAcquireLease: vi.fn(
      (_holder: string, _now: number): {
        acquired: boolean;
        holder: string | null;
        generation: number;
        renewedAt: number | null;
      } => ({ acquired: true, holder: "self", generation: 1, renewedAt: 0 }),
    ),
    reportLeaseRefused: vi.fn(),
    startLeaseRenewal: vi.fn(),
    runsEngine: vi.fn(() => true),
    requestHandoff: vi.fn(
      (_requester: string, _now: number): HandoffAsk => ({ kind: "requested", holder: "active", generation: 1 }),
    ),
    refreshHandoffRequest: vi.fn((_requester: string, _now: number) => true),
    withdrawHandoff: vi.fn((_requester: string) => true),
    handoffAcceptedBy: vi.fn((_holder: string) => true),
    releaseLease: vi.fn((_holder: string) => true),
    isShutdownStarted: vi.fn(() => false),
    holdTokenRefresh: vi.fn((_held: boolean) => {}),
    registerPreCloseHook: vi.fn((_hook: (signal: string) => void) => {}),
    // No broker is configured unless a test hands `getPlugin` these.
    getPlugin: vi.fn<(id: string) => unknown>(() => null),
    topstepSearchAccounts: vi.fn(async (): Promise<Account[]> => []),
    tradovateSearchAccounts: vi.fn(async (): Promise<Account[]> => []),
    /** The Tradovate login: `initialize()` is what mints the session. */
    tradovateInitialize: vi.fn(async () => {}),
    isPracticeAccount: vi.fn((_account: Account) => false),
    setStagingAllowlist: vi.fn((_ids: number[]) => {}),
  };
});

// The lease's storage is pinned in `db/lease.test.ts`; this file owns where
// boot takes it and what it does while it cannot.
vi.mock("@/lib/db/lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/lease")>();
  return {
    describeLeaseHolder: actual.describeLeaseHolder,
    LEASE_FRESH_MS: actual.LEASE_FRESH_MS,
    leaseHolderId: () => "self",
    tryAcquireLease: H.tryAcquireLease,
    reportLeaseRefused: H.reportLeaseRefused,
    requestHandoff: H.requestHandoff,
    refreshHandoffRequest: H.refreshHandoffRequest,
    withdrawHandoff: H.withdrawHandoff,
    handoffAcceptedBy: H.handoffAcceptedBy,
    releaseLease: H.releaseLease,
    // The downtime sweep below is the real one; this process holds the lease.
    leaseGate: () => () => true,
  };
});

vi.mock("@/lib/brokers/topstep/auth", () => ({ holdTokenRefresh: H.holdTokenRefresh }));

vi.mock("@/lib/db/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/connection")>()),
  registerPreCloseHook: H.registerPreCloseHook,
  isShutdownStarted: H.isShutdownStarted,
}));

vi.mock("@/lib/role", async (importOriginal) => ({
  EngineNotInThisProcessError: (await importOriginal<typeof import("@/lib/role")>())
    .EngineNotInThisProcessError,
  runsEngine: H.runsEngine,
}));

/** The half of the Discord embed the boot alert fills in. */
interface AlertEmbed {
  title?: string;
  fields?: Array<{ name: string; value: string }>;
}

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngine: H.getEngine,
  // The liveness gate reads it. Stubbed to null rather than to the engine
  // stub, because `classifyBoot` composes the gate before anything is built.
  getEngineIfReady: H.getEngineIfReady,
}));

vi.mock("@/lib/trading/engine/boot/engine-restart", async (importOriginal) => ({
  // The real formatter: these tests assert the units an operator reads, and a
  // stubbed one would assert the stub. Everything else is a stub because the
  // assertions are about order and arity.
  formatGapDuration: (await importOriginal<typeof import("./engine-restart")>()).formatGapDuration,
  evaluateRestart: H.evaluateRestart,
  readOwedFlatten: H.readOwedFlatten,
  installCleanShutdownMarker: H.installCleanShutdownMarker,
  startProcessLiveness: H.startProcessLiveness,
  startLeaseRenewal: H.startLeaseRenewal,
  RESUME_FLAP_LIMIT: 3,
  RESUME_FLAP_WINDOW_MS: 15 * 60_000,
  UNMANAGED_FLATTEN_MS: 10 * 60_000,
}));

// Not a dependency of `boot-engine`: the real `engine-restart` is imported
// through `vi.importActual` at the bottom of this file, and the strategy
// loader it reaches uses webpack's `require.context`, which has no vitest
// equivalent (patterns.md).
vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
  registeredStrategyKeys: H.registeredStrategyKeys,
}));

vi.mock("@/lib/db/trades", () => ({
  getAllOpenTrades: H.getAllOpenTrades,
  getOpenTradeForDeployment: H.getOpenTradeForDeployment,
  listAccountsWithReconcilableTrades: H.listAccountsWithReconcilableTrades,
}));

// Mocked rather than let through: the real reconciler opens the database, and
// its own rules are pinned in `trading/books/reconcile.test.ts`. What this file
// owns is the wiring — that it runs, where it runs, and that it cannot take
// boot down.
vi.mock("@/lib/trading/books/reconcile", () => ({
  runBookReconcile: H.runBookReconcile,
}));
// Same reason: the one-shot's predicate is pinned in `retire-off-cell-rows.test.ts`.
vi.mock("@/lib/trading/books/retire-off-cell-rows", () => ({
  runRetireOffCellRows: H.runRetireOffCellRows,
}));

// The migration's own commit-then-report rule is pinned in `db/books.test.ts`;
// this file owns where boot drains it.
vi.mock("@/lib/db/books", () => ({ reportBookMigrations: H.reportBookMigrations }));

vi.mock("@/lib/db/deployments", () => ({
  listManagedDeployments: H.listManagedDeployments,
  readManagedDeployments: H.readManagedDeployments,
  runPendingSessionMigrations: H.runPendingSessionMigrations,
}));

vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrNull: H.getAccountBrokerOrNull,
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  toAccountBrokerSeeds: vi.fn(() => []),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({ cleanupExpiredOrderMappings: vi.fn() }));

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: H.getPlugin },
}));

vi.mock("@/lib/brokers/topstep/account-classification", () => ({
  isPracticeAccount: H.isPracticeAccount,
}));

vi.mock("@/lib/trading/broker-access/open-position-lookup", () => ({
  createBootOpenPositionLookup: vi.fn(() => vi.fn()),
  hasOpenPositionOnBroker: vi.fn(async () => false),
}));

vi.mock("@/lib/trading/broker-access/staging-allowlist", () => ({ setStagingAllowlist: H.setStagingAllowlist }));
vi.mock("@/lib/trading/session/session-migration-status", () => ({ setMigrationBlocked: vi.fn() }));

vi.mock("@/lib/trading/engine/boot/boot-assertion", () => ({
  markBootAssertionFailed: H.markBootAssertionFailed,
  markBootAssertionPassed: H.markBootAssertionPassed,
}));

vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: { realtime: H.realtime, slotProviderId: vi.fn(() => "databento") },
}));

vi.mock("@/lib/env", () => ({ isStagingEnv: H.isStagingEnv }));

vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: H.sendDiscordAlert,
  COLOR_CONNECTION_LOST: 0,
  COLOR_EXIT_LOSS: 1,
}));

vi.mock("@/lib/logger", () => ({
  log: {
    info: H.logInfo,
    warn: H.logWarn,
    error: H.logError,
    debug: vi.fn(),
    event: H.logEvent,
  },
}));

const DEPL_A = "depl-a";
const DEPL_B = "depl-b";

/**
 * Every boot message at a given severity, whichever seam carried it.
 *
 * These assertions are about the boot *wording* — which line the operator
 * reads and how loud it is — and that survives a site moving from a
 * severity helper to a named event. The event half reads its severity from
 * `EVENTS`, so a hand-changed severity fails this file rather than passing
 * it.
 */
function bootLines(severity: Severity): string[] {
  const helper =
    severity === "info" ? H.logInfo : severity === "warn" ? H.logWarn : H.logError;
  const levelled = helper.mock.calls.map((c: unknown[]) => String(c[1]));
  const evented = H.logEvent.mock.calls
    .filter((c: unknown[]) => EVENTS[String(c[0])]?.severity === severity)
    .map((c: unknown[]) => String(c[2]));
  return [...levelled, ...evented];
}

function deployment(id: string, status: Deployment["status"] = "Active"): Deployment {
  return {
    id,
    strategyKey: "test",
    accountId: 4242,
    ticker: "/MNQ",
    contractId: null,
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

const NOTHING_OWED: PendingFlatten = { entries: [], gapMs: 0 };

/** A seed instant from a previous boot — well before anything this file runs. */
const CARRIED_SEED = Date.parse("2026-05-15T05:00:00.000Z");

/** What a previous boot recorded: one deployment against the instant its own
 *  obligation was taken on. */
function carried(deploymentId: string, gapMs: number): PendingFlatten {
  return { entries: [{ deploymentId, seededAt: CARRIED_SEED }], gapMs };
}

function ownedIds(owed: PendingFlatten): string[] {
  return owed.entries.map((e) => e.deploymentId);
}

/** A fresh copy of the module, so `bootVerdict` and `verdictApplied` start
 *  unset. The mocks are hoisted objects and survive the reset. */
async function freshBoot(): Promise<typeof import("./boot-engine")> {
  vi.resetModules();
  return import("./boot-engine");
}

/** The healthy path: one Active deployment, everything reachable. */
function healthy(): void {
  H.readManagedDeployments.mockReturnValue({
    deployments: [deployment(DEPL_A)],
    withheldLiveAccounts: [],
    skippedNotAllowed: [],
  });
  H.listManagedDeployments.mockReturnValue([deployment(DEPL_A)]);
}

beforeEach(() => {
  vi.clearAllMocks();
  H.applied.value = false;
  // `clearAllMocks` does not touch the hoisted objects, and the wired
  // idle-boot test sets both feeds down. Without this it stays down for
  // whatever is appended after it.
  H.hubs.value = { attempted: true, market: true, user: true };
  H.engine.isRunning.mockReturnValue(false);
  H.engine.isAccountRegistered.mockReturnValue(true);
  H.engine.refreshBrokerRegistry.mockResolvedValue(H.cleanRefresh());
  H.getAccountBrokerOrNull.mockReturnValue("topstep");
  // The two readers the liveness gate closes over. Same reason as the line
  // above: the gate-composition tests drive them, and `clearAllMocks` leaves
  // a `mockReturnValue` standing for whatever runs next.
  H.getEngineIfReady.mockReturnValue(null);
  H.listAccountsWithReconcilableTrades.mockReturnValue([]);
  H.evaluateRestart.mockReturnValue(verdict({ flatten: false, alarm: false, clean: true }));
  H.readOwedFlatten.mockReturnValue(NOTHING_OWED);
  H.getAllOpenTrades.mockReturnValue([]);
  H.isStagingEnv.mockReturnValue(false);
  H.realtime.mockReturnValue({});
  H.readManagedDeployments.mockReturnValue({
    deployments: [],
    withheldLiveAccounts: [],
    skippedNotAllowed: [],
  });
  H.listManagedDeployments.mockReturnValue([]);
  H.registeredStrategyKeys.mockReturnValue([...PROD_PLAYBOOK_KEYS]);
  H.tryAcquireLease.mockImplementation(() => ({
    acquired: true,
    holder: "self",
    generation: 1,
    renewedAt: 0,
  }));
  H.runsEngine.mockReturnValue(true);
  H.requestHandoff.mockImplementation(() => ({ kind: "requested", holder: "active", generation: 1 }));
  H.refreshHandoffRequest.mockReturnValue(true);
  H.withdrawHandoff.mockReturnValue(true);
  H.handoffAcceptedBy.mockReturnValue(true);
  H.isShutdownStarted.mockReturnValue(false);
  H.getPlugin.mockImplementation(() => null);
  H.isPracticeAccount.mockImplementation(() => false);
  H.topstepSearchAccounts.mockImplementation(async () => []);
  H.tradovateSearchAccounts.mockImplementation(async () => []);
  H.tradovateInitialize.mockImplementation(async () => {});
});

// ── The classification runs ahead of every early return ────────────────────

describe("classifyBoot runs before anything can return early", () => {
  // `evaluateRestart` *consumes* the clean-shutdown marker. A boot that skips
  // it leaves the marker behind for a later boot to read, and one clean
  // shutdown then makes every later crash look intentional. The placement is
  // the whole mechanism; nothing else enforces it.

  it("classifies on the healthy path", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a boot with no enabled deployments", async () => {
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "no-deployments" });
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a boot where every enabled deployment was withheld", async () => {
    H.readManagedDeployments.mockReturnValue({
      deployments: [],
      withheldLiveAccounts: [{ id: DEPL_A, reason: "live account" }],
      skippedNotAllowed: [],
    });
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "all-withheld", withheldCount: 1 });
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a staging boot that refuses to start on an empty allowlist", async () => {
    H.isStagingEnv.mockReturnValue(true);
    const { runBootSequence } = await freshBoot();
    const result = await runBootSequence({ rethrowAllowlistFailure: true });
    expect(result.kind).toBe("staging-allowlist-empty");
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a boot that refuses to start on an unusable realtime slot", async () => {
    healthy();
    H.realtime.mockImplementation(() => {
      throw new Error("provider lost liveBars");
    });
    const { runBootSequence } = await freshBoot();
    const result = await runBootSequence();
    expect(result.kind).toBe("error");
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a boot where every deployment orphaned out", async () => {
    H.readManagedDeployments.mockReturnValue({
      deployments: [deployment(DEPL_A)],
      withheldLiveAccounts: [],
      skippedNotAllowed: [],
    });
    H.listManagedDeployments.mockReturnValue([]);
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "no-enabled-after-orphan-check" });
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("classifies on a boot that finds the engine already running", async () => {
    healthy();
    H.engine.isRunning.mockReturnValue(true);
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "already-running" });
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("arms the next stop's marker on every one of those boots", async () => {
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.installCleanShutdownMarker).toHaveBeenCalled();
  });
});

// ── …and the liveness stamp starts after it, never before ──────────────────

describe("the process-liveness stamp", () => {
  // A57. `last_seen_at` advanced only on ticks, so a boot ending at
  // `no-deployments` never started a tick loop and never stamped: the column
  // froze at whatever instant a deployment last ticked, and every restart
  // after that read the idle hours as unmanaged time. The stamper closes
  // that, and where it sits is the whole of its correctness — started ahead of
  // `evaluateRestart()` it overwrites the gap the duration rule exists to
  // measure, and every outage reports as zero.

  it("starts only after the classification has read the gap", async () => {
    const stampedFirst = { value: false };
    H.evaluateRestart.mockImplementation(() => {
      stampedFirst.value = H.startProcessLiveness.mock.calls.length > 0;
      return verdict({ flatten: false, alarm: false, clean: true });
    });
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.startProcessLiveness).toHaveBeenCalledTimes(1);
    expect(stampedFirst.value).toBe(false);
  });

  it("starts on the boot with no deployments, which is the one that never ticks", async () => {
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "no-deployments" });
    expect(H.startProcessLiveness).toHaveBeenCalledTimes(1);
  });

  it("starts even on a boot whose classification threw", async () => {
    // That boot measured nothing, but the process is alive and the next boot
    // is owed a real number.
    H.evaluateRestart.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.startProcessLiveness).toHaveBeenCalledTimes(1);
  });

  it("starts once per process, behind the same memo as the classification", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    H.engine.isRunning.mockReturnValue(false);
    await runBootSequence();
    expect(H.startProcessLiveness).toHaveBeenCalledTimes(1);
  });
});

// ── …and the gate it is handed answers off the two readers ─────────────────

describe("the liveness gate this file composes", () => {
  // The gate is composed here rather than imported in `engine-restart`,
  // because `engine-singleton` → `engine` → `engine-restart` is already an
  // edge. What that costs is that nothing checks the composition: swapping the
  // two predicate bodies kept the whole suite green, and the resulting gate
  // stamps for a stopped engine holding rows — the fatal-auth stop A57's fix
  // was written to stop claiming liveness for.

  async function composedGate(): Promise<LivenessGate> {
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    return H.startProcessLiveness.mock.calls[0][0] as LivenessGate;
  }

  it("reads engineRunning off the engine singleton, not off the trade rows", async () => {
    const gate = await composedGate();

    H.getEngineIfReady.mockReturnValue(null);
    expect(gate.engineRunning()).toBe(false);

    H.getEngineIfReady.mockReturnValue({ isRunning: () => true });
    expect(gate.engineRunning()).toBe(true);

    // The other reader must not be what answered.
    H.listAccountsWithReconcilableTrades.mockReturnValue([11224469]);
    expect(gate.engineRunning()).toBe(true);
  });

  it("reads openTradesExist off the reconcilable-trade query, not off the engine", async () => {
    const gate = await composedGate();

    H.listAccountsWithReconcilableTrades.mockReturnValue([]);
    expect(gate.openTradesExist()).toBe(false);

    H.listAccountsWithReconcilableTrades.mockReturnValue([11224469]);
    expect(gate.openTradesExist()).toBe(true);

    H.getEngineIfReady.mockReturnValue({ isRunning: () => true });
    expect(gate.openTradesExist()).toBe(true);
  });
});

// ── Once per process: the memo and the application latch ───────────────────

describe("a second runBootSequence in one process", () => {
  it("does not classify again", async () => {
    // A second classification finds the marker already consumed and the
    // heartbeat freshly stamped by the engine the first call started, so it
    // reads a *running* engine as a crash: a false alarm and a false entry in
    // the counter that decides whether to stop entering.
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    H.engine.isRunning.mockReturnValue(false);
    await runBootSequence();
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("does not apply the first call's verdict to a later candidate set", async () => {
    // The verdict is memoised; `getAllOpenTrades()` is not. `isRunning()` is
    // false after either fatal-auth `stop()`, and `activateFromSettings` is
    // reachable from POST /api/settings/setup at any time — so without a latch
    // the 09:00 outage verdict meets the position opened at 14:15 and
    // force-closes it, logging "went unmanaged for 4h" about thirty
    // seconds.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 4 * 60 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([]);

    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.engine.applyRestartVerdict).toHaveBeenCalledTimes(1);
    // Nothing owed, so nothing describes it: the gap belongs to a set, and
    // there is no set here.
    expect(H.engine.applyRestartVerdict.mock.calls[0][1]).toEqual({ entries: [], gapMs: 0 });

    // Hours later: token rotation stopped the engine, the operator re-enters
    // the key, and a position has been opened since.
    H.engine.isRunning.mockReturnValue(false);
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    await runBootSequence();

    expect(H.engine.applyRestartVerdict).toHaveBeenCalledTimes(1);
  });

  it("still starts the engine on that second call", async () => {
    // The latch must not turn into a refusal to boot — the second call has a
    // job, it just is not re-deciding a four-hour-old flatten.
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    H.engine.start.mockClear();
    H.engine.isRunning.mockReturnValue(false);
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(H.engine.start).toHaveBeenCalledTimes(1);
  });
});

// ── What goes into the owed set ────────────────────────────────────────────

describe("the downtime-flatten candidate set", () => {
  it("takes the Active rows holding a position across the outage", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 20 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.engine.applyRestartVerdict.mock.calls[0][1]).toEqual({
      entries: [{ deploymentId: DEPL_A, seededAt: expect.any(Number) }],
      gapMs: 20 * 60_000,
    });
  });

  it("excludes a row that is no longer Active", async () => {
    // A `Pausing` or `Destroying` row is already owed the same flatten by the
    // closing guard, which has a status behind it. Acting here would fire the
    // exit twice and attribute it to the wrong cause.
    H.readManagedDeployments.mockReturnValue({
      deployments: [deployment(DEPL_A), deployment(DEPL_B, "Pausing")],
      withheldLiveAccounts: [],
      skippedNotAllowed: [],
    });
    H.listManagedDeployments.mockReturnValue([
      deployment(DEPL_A),
      deployment(DEPL_B, "Pausing"),
    ]);
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }, { deploymentId: DEPL_B }]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(ownedIds(H.engine.applyRestartVerdict.mock.calls[0][1])).toEqual([DEPL_A]);
  });

  it("stays empty when this boot's verdict says the positions were fine", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: false, gapMs: 20_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.engine.applyRestartVerdict.mock.calls[0][1].entries).toEqual([]);
    expect(H.getAllOpenTrades).not.toHaveBeenCalled();
  });

  it("re-seeds a previous boot's unfinished obligation even when this boot says keep", async () => {
    // C1 / D-7. The sweep retries against an unreachable broker and the
    // operator restarts the container to clear it; the heartbeat was stamped
    // throughout, so this boot measures seconds and classifies "keep". The
    // obligation is the database's, not the process's.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: false, clean: true, gapMs: 30_000 }));
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.engine.applyRestartVerdict.mock.calls[0][1]).toEqual(
      carried(DEPL_B, 4 * 60 * 60_000),
    );
  });

  it("does not adopt the gap of a set that has already drained", async () => {
    // `persist()` writes the gap on every mutation *including* the one that
    // empties the set, and the carried half returns early on an empty set, so
    // nothing writes it back down. An eleven-minute outage then reports itself
    // as four hours — in the boot log, in the Discord embed, in the per-
    // deployment log line and in the row an operator reads afterwards. The
    // soak's entire output is that log.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 11 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue({ entries: [], gapMs: 4 * 60 * 60_000 });
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;
    expect(owed.gapMs).toBe(11 * 60_000);
  });

  it("keeps a carried obligation's own seed instant rather than re-stamping it", async () => {
    // The re-seed must not move the instant forward: a position this process
    // opened after the previous boot took the obligation on is not what the
    // obligation is about, and a re-stamped seed makes it look like it is.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: false, clean: true, gapMs: 30_000 }));
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;
    expect(owed.entries).toEqual([{ deploymentId: DEPL_B, seededAt: CARRIED_SEED }]);
  });

  it("unions a carried obligation with this boot's own set and keeps the larger gap", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 20 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;
    expect(new Set(ownedIds(owed))).toEqual(new Set([DEPL_A, DEPL_B]));
    expect(owed.gapMs).toBe(4 * 60 * 60_000);
    // **Each half keeps its own instant.** The gap merges because it describes
    // the outage; the instant does not, because it identifies a position. One
    // threshold across both applies the carried obligation's to this boot's
    // half, and a position opened between the two — held across *this* boot's
    // outage, so genuinely owed — reads as newer than the sweep and is dropped.
    expect(owed.entries.find((e) => e.deploymentId === DEPL_B)?.seededAt).toBe(CARRIED_SEED);
    expect(owed.entries.find((e) => e.deploymentId === DEPL_A)?.seededAt).toBeGreaterThan(
      CARRIED_SEED,
    );
  });

  it("does not double-count a deployment that is owed by both halves", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue(carried(DEPL_A, 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;
    expect(ownedIds(owed)).toEqual([DEPL_A]);
    // This boot's instant, not the carried one. The obligation may be the
    // older of the two, but the position the sweep will meet under this id is
    // the fresh half's — it is open right now, so it predates this instant by
    // construction and the earlier threshold would discard a real flatten.
    expect(owed.entries[0].seededAt).toBeGreaterThan(CARRIED_SEED);
  });

  it("reports a database that cannot answer instead of silently owing nothing", async () => {
    healthy();
    H.readOwedFlatten.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(
      bootLines("error").some((m) => m.includes("outstanding downtime-flatten set")),
    ).toBe(true);
  });
});

// ── The merged set, read by the sweep that acts on it ──────────────────────

/**
 * The real `RestartFlattenGuard`, run against the payload `collectOwedFlatten`
 * actually produced.
 *
 * The merge and the refusal live in different modules, and a defect that only
 * exists *between* them is invisible to either module's own tests: one writes
 * the seed instant, the other decides a force-close against it, and a stub on
 * the seam agrees with whichever side is wrong.
 */
describe("a merged obligation reaching RestartFlattenGuard", () => {
  /** Between the carried obligation's instant and this boot's. A position
   *  opened here was open across *this* boot's outage, so it is what this
   *  boot's half of the merged set is about — and it is not the carried
   *  half's, which predates it. */
  const OPENED_BETWEEN_SEEDS = CARRIED_SEED + 60_000;

  function deploymentState(): DeploymentState {
    return {
      lastBarTimestamp: null,
      cooldownAnchorAt: null,
      position: {
        side: 0,
        entryPrice: 21000,
        entryTimestamp: "2026-05-15T05:01:00Z",
        barsSinceEntry: 3,
        entryFilledAt: "2026-05-15T05:01:01Z",
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
    } as DeploymentState;
  }

  /** Hand the boot's own payload to the real guard and take one pass. */
  async function sweep(owed: PendingFlatten, startedAt: number) {
    const { RestartFlattenGuard } = await vi.importActual<typeof import("./engine-restart")>(
      "./engine-restart",
    );
    const state = deploymentState();
    const placeExitOrder = vi.fn(async () => {});
    const logs: string[] = [];
    const guard = new RestartFlattenGuard({
      log: (_id, _severity, _category, message) => void logs.push(message),
      logEvent: (_event, _id, message) => void logs.push(message),
      getDeployment: (id) => (id === DEPL_A ? deployment(DEPL_A) : null),
      hasOpenTrade: (id) => id === DEPL_A,
      openTradeStartedAt: (id) => (id === DEPL_A ? startedAt : null),
      stateFor: (id) => (id === DEPL_A ? state : undefined),
      persistPending: () => {},
      resolveContract: async () => ({ id: "CON.F.US.MNQ.Z26", tickSize: 0.25 }) as Contract,
      placeExitOrder,
      // A fresh instance per sweep: this harness is about the boot payload
      // reaching the guard, not about the interlock with the other three
      // flatten actors. That is engine-flatten-cooldown.test.ts.
      flattenCooldown: new FlattenCooldown(),
    });
    guard.markUnmanaged(owed.entries, owed.gapMs);
    await guard.runRestartFlatten();
    return { placeExitOrder, logs };
  }

  it("force-closes a position that belongs to this boot's half of the set", async () => {
    // A carried obligation seeded at T1 merges with a fresh one computed at
    // T2. The position under DEPL_A opened at T1.5 — after the *carried*
    // obligation was taken on, before this boot's — was open across this
    // boot's outage and is exactly what this boot's half owes a flatten. A
    // seed instant shared by the whole set is T1, so the sweep reads it as
    // younger than the obligation and silently discards it.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 20 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;

    const { placeExitOrder } = await sweep(owed, OPENED_BETWEEN_SEEDS);
    expect(placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("force-closes a position owed by both halves and held across this boot's outage", async () => {
    // The both-halves collision, run through the guard rather than asserted at
    // the merge. DEPL_A is carried from a previous boot *and* holding a
    // position now, and that position opened after the carried instant — so it
    // was held across *this* boot's twenty-minute outage and this boot's half
    // owes it a flatten. Keeping the earlier of the two instants makes the
    // sweep refuse it under a log line that is false about that row.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: true, gapMs: 20 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue(carried(DEPL_A, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;

    const { placeExitOrder } = await sweep(owed, OPENED_BETWEEN_SEEDS);
    expect(placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("still refuses a position opened after its own deployment's seed instant", async () => {
    // The Critical the seed instant was added for, restated per obligation:
    // the outage-era position closed at the broker on its own bracket and a
    // genuine signal opened another under the same id. Nothing in this boot
    // vouches for that row, and the sweep must leave it to normal management.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ flatten: false, clean: true, gapMs: 30_000 }));
    H.readOwedFlatten.mockReturnValue(carried(DEPL_A, 4 * 60 * 60_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const owed = H.engine.applyRestartVerdict.mock.calls[0][1] as PendingFlatten;

    const { placeExitOrder, logs } = await sweep(owed, OPENED_BETWEEN_SEEDS);
    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("after this sweep was seeded"))).toBe(true);
  });
});

// ── What the boot line claims the number is ────────────────────────────────

/**
 * A57's wording half. `last_seen_at` is stamped per *tick*, not per second the
 * process is alive, so an engine that was up with nothing to trade leaves it
 * frozen and the gap measures idleness as readily as absence — two staging
 * deploys eight minutes apart both reported ~12.7 hours off one frozen stamp.
 * The semantics are deferred; the sentence is not allowed to keep saying
 * "resumed 45640s after a clean shutdown", and nothing pinned it before this.
 */
describe("the restart boot line", () => {
  const RESTART_LINE_PREFIX = "boot: no engine activity for ";

  /** The one classification line at that level. Length is asserted, not
   *  assumed: a regression to the old wording produces zero matches here
   *  rather than a green test against a line that no longer exists. */
  function restartLine(severity: Severity): string {
    const lines = bootLines(severity).filter((message) =>
      message.startsWith(RESTART_LINE_PREFIX),
    );
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  function alert(): AlertEmbed {
    expect(H.sendDiscordAlert).toHaveBeenCalledTimes(1);
    return H.sendDiscordAlert.mock.calls[0][0];
  }

  it("reports the gap as engine inactivity rather than as downtime", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ clean: true, flatten: true, gapMs: 45_640_000, flapCycles: 0 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = restartLine("error");
    expect(line).toContain(
      "boot: no engine activity for 12h 40m (previous process stopped cleanly)",
    );
    expect(line).not.toContain("resumed");
    expect(line).not.toContain("45640s");
  });

  it("promises the force-flatten conditionally, because there may be nothing open", async () => {
    // This line prints on a boot with zero deployments too — the candidate set
    // is collected after the classification and is routinely empty.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ clean: true, flatten: true, gapMs: 45_640_000 }));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = restartLine("error");
    expect(line).toContain("Past the 10min duration rule — any open position will be force-flattened");
    expect(line).not.toContain("open positions will be force-flattened");
  });

  it("keeps positions on an unclean stop inside the duration rule", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ clean: false, flatten: false, gapMs: 98_000, flapCycles: 1 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = restartLine("error");
    expect(line).toContain("no engine activity for 98s (unclean stop — no shutdown marker)");
    expect(line).toContain("Positions kept: inside the 10min duration rule");
    expect(line).toContain("1 crash-resume cycle(s) inside 15min");
    expect(line).not.toContain("a unclean");
  });

  it("still says the degraded gap measures a failed write, not idle time", async () => {
    // engine.ts:1940 — the degraded marker exists to separate "could not
    // write" from "was not running", and the fix for a *third* state (up but
    // idle) must not fold itself into that distinction.
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ flatten: false, heartbeatDegraded: true, gapMs: 12 * 60_000 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = restartLine("error");
    expect(line).toContain("could not write its heartbeat");
    expect(line).toContain("measures a failed write rather than unmanaged time");
    expect(line).toContain("The duration rule is not being applied on this boot");
  });

  it("uses the same framing on the quiet info-level boot", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ clean: true, flatten: false, alarm: false, gapMs: 30_000 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = restartLine("info");
    expect(line).toContain(
      "boot: no engine activity for 30s (previous process stopped cleanly) — inside the 10min duration rule, positions kept",
    );
    expect(H.sendDiscordAlert).not.toHaveBeenCalled();
  });

  it("does not announce an outage the heartbeat cannot prove happened", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ clean: true, flatten: true, gapMs: 45_640_000 }));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const embed = alert();
    expect(embed.title).toBe(
      "Engine restarted past the duration rule — flattening any open position",
    );
    expect(embed.fields?.[0]).toEqual({ name: "No engine activity for", value: "12h 40m" });
    const text = [embed.title ?? "", ...(embed.fields ?? []).flatMap((f) => [f.name, f.value])];
    expect(text.filter((t) => t.includes("outage"))).toEqual([]);
  });

  it("keeps the alert's degraded field pointed at the failed write", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ flatten: false, heartbeatDegraded: true, gapMs: 12 * 60_000 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const embed = alert();
    expect(embed.title).toBe("Engine restarted — the duration rule could not be applied");
    expect(embed.fields?.[0]?.name).toBe("Last heartbeat");
    expect(embed.fields?.[0]?.value).toContain("could not write it");
    expect(embed.fields?.[0]?.value).toContain("not a measure of unmanaged time");
  });
});

// ── The two lines the owed set writes, on the same boot ────────────────────

/**
 * `collectOwedFlatten` prints immediately after the classification line, so
 * both are read together: one boot said "no engine activity for 22m" and then
 * "held a position across the outage" two lines later, which restates the
 * assertion the first line exists to avoid. These three say what is known —
 * there was a gap in engine activity — and never why.
 */
describe("the downtime-flatten boot lines", () => {
  /** The single error line carrying that fragment. Length is asserted so a
   *  reworded line fails here instead of leaving the branch unexercised. */
  function errorLineContaining(fragment: string): string {
    const lines = bootLines("error").filter((message) => message.includes(fragment));
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  it("says a position was held across the gap in engine activity", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ clean: true, flatten: true, gapMs: 22 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = errorLineContaining("held a position");
    expect(line).toContain("1 deployment(s) held a position across the gap in engine activity");
    // The same words as the alert's Entries field, which describes the same
    // suppression: two surfaces disagreeing about what was discarded is how
    // an operator stops trusting either.
    expect(line).toContain("resuming with any signal standing before the stop discarded");
  });

  it("reports a carried obligation's gap in the same words and the same units", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ clean: true, flatten: false, gapMs: 30_000 }));
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 45_640_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = errorLineContaining("still owed a downtime flatten");
    expect(line).toContain("after 12h 40m with no engine activity");
    expect(line).not.toContain("unmanaged");
    expect(line).not.toContain("45640s");
  });

  it("announces an outage on none of the three lines one boot can print", async () => {
    // The classification, the carried half and the fresh half all fire on this
    // boot. Asserting each is present first is what stops the sweep below from
    // passing against a boot that logged nothing at all.
    healthy();
    H.evaluateRestart.mockReturnValue(verdict({ clean: true, flatten: true, gapMs: 22 * 60_000 }));
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    H.readOwedFlatten.mockReturnValue(carried(DEPL_B, 45_640_000));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const lines = bootLines("error");
    expect(errorLineContaining("boot: no engine activity for")).toBeTruthy();
    expect(errorLineContaining("still owed a downtime flatten")).toBeTruthy();
    expect(errorLineContaining("held a position")).toBeTruthy();
    expect(lines.filter((message) => message.includes("outage"))).toEqual([]);
  });
});

// ── A classification that throws must not take out boot ────────────────────

describe("a throwing evaluateRestart", () => {
  it("yields an inert verdict rather than failing the boot", async () => {
    healthy();
    H.evaluateRestart.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(H.engine.applyRestartVerdict.mock.calls[0][0]).toEqual({
      gapMs: null,
      clean: false,
      flatten: false,
      alarm: false,
      heartbeatDegraded: false,
      flapCycles: 0,
      entriesSuspended: false,
    });
  });

  it("does not flatten anything off the inert verdict", async () => {
    healthy();
    H.evaluateRestart.mockImplementation(() => {
      throw new Error("database is locked");
    });
    H.getAllOpenTrades.mockReturnValue([{ deploymentId: DEPL_A }]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(H.engine.applyRestartVerdict.mock.calls[0][1].entries).toEqual([]);
  });

  it("memoises the inert verdict too, so a retry does not reclassify", async () => {
    healthy();
    H.evaluateRestart.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    H.engine.isRunning.mockReturnValue(false);
    await runBootSequence();
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });
});

/**
 * A56. `boot: no enabled deployments — engine idle (hubs ready)` was a fixed
 * string on a path that consulted no hub state, and it printed on a staging
 * boot where **both** SignalR hubs had just failed to construct — so the
 * loudest line on a container with no market data and no account events said
 * everything was fine. The failure was found days later, by accident.
 *
 * Pinned as strings for the reason [copy.md] gives about the boot lines the
 * A57 fix rewrote: nothing else fails when one drifts from the code.
 */
describe("describeHubReadiness — the idle-boot line quotes a reading", () => {
  it("names both feeds when both came up", () => {
    const { text, healthy } = describeHubReadiness({ attempted: true, market: true, user: true });
    expect(text).toBe("Market data and the account feed are both connected.");
    expect(healthy).toBe(true);
  });

  it("names the feed that did not come up, and is not healthy", () => {
    const { text, healthy } = describeHubReadiness({ attempted: true, market: false, user: true });
    // Sentence-cased: the line it lands in ends `… engine idle.` first.
    expect(text).toContain("Market data did not come up");
    expect(text).toContain("see the errors above");
    expect(healthy).toBe(false);
  });

  it("sentence-cases the head whichever feed leads it", () => {
    const { text } = describeHubReadiness({ attempted: true, market: true, user: false });
    expect(text).toContain("The account feed did not come up");
  });

  it("names both when neither came up — the boot this entry is about", () => {
    const { text, healthy } = describeHubReadiness({ attempted: true, market: false, user: false });
    expect(text).toContain("Market data and the account feed did not come up");
    expect(healthy).toBe(false);
  });

  it("says what state the engine is left in, not just which feed is down", () => {
    // The half that makes the line worth reading: an operator scanning a
    // boot summary needs the consequence, which is that the engine would
    // accept a deployment and sit blind.
    const { text } = describeHubReadiness({ attempted: true, market: false, user: false });
    expect(text).toContain("sit blind");
  });

  it("reports what was observed, not what the config says, when nothing was started", () => {
    // `attempted: false` covers two causes — Topstep unconfigured and
    // realtime bars off — and naming only the second is a claim this
    // function cannot check.
    const { text, healthy } = describeHubReadiness({ attempted: false, market: false, user: false });
    expect(text).toBe("No Topstep hubs were started, so there is no feed to report on.");
    expect(healthy).toBe(true);
  });

  it("never claims readiness it was not handed", () => {
    // The shape of the original defect: a fixed string. Every text this
    // function can produce has to vary with its input.
    const texts = new Set(
      [
        { attempted: true, market: true, user: true },
        { attempted: true, market: false, user: true },
        { attempted: true, market: true, user: false },
        { attempted: true, market: false, user: false },
        { attempted: false, market: false, user: false },
      ].map((h) => describeHubReadiness(h).text),
    );
    expect(texts.size).toBe(5);
  });
});

describe("the idle-boot line, wired", () => {
  it("logs at info and names both feeds on a healthy idle boot", async () => {
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(bootLines("info")).toContain(
      "boot: no enabled deployments — engine idle. Market data and the account feed are both connected.",
    );
  });

  it("drops to warn and names the dead feeds when the hubs did not come up", async () => {
    H.hubs.value = { attempted: true, market: false, user: false };
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    expect(bootLines("warn")).toContain(
      "boot: no enabled deployments — engine idle. Market data and the account feed did not come up — " +
        "see the errors above. The engine will accept a deployment and sit blind until a feed reconnects.",
    );
    // The defect was that this boot's summary read as healthy.
    expect(bootLines("info").some((m) => m.includes("both connected"))).toBe(false);
  });
});

describe("the book reconcile", () => {
  it("runs before the first read of the deployment set, so a row a book asked for joins this boot", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.runBookReconcile).toHaveBeenCalledTimes(1);
    expect(H.runBookReconcile.mock.invocationCallOrder[0]).toBeLessThan(
      H.readManagedDeployments.mock.invocationCallOrder[0],
    );
  });

  it("takes no transition, so a boot never re-arms a row the operator paused by hand", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.runBookReconcile.mock.calls[0][0].resumed).toBeUndefined();
  });

  it("reports the books migrations once, after getEngine has started the log store", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.reportBookMigrations).toHaveBeenCalledTimes(1);
    expect(H.reportBookMigrations.mock.invocationCallOrder[0]).toBeGreaterThan(
      H.getEngine.mock.invocationCallOrder[0],
    );
  });

  it("does not take boot down when it throws", async () => {
    healthy();
    H.runBookReconcile.mockImplementationOnce(() => {
      throw new Error("books table is missing");
    });
    const { runBootSequence } = await freshBoot();

    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(bootLines("warn").some((m) => m.includes("book reconcile failed"))).toBe(true);
  });
});

describe("the one-time retirement of off-cell rows", () => {
  it("runs once, after the reconcile so a re-added cell is resumed first, and before the deployment read so the retired rows leave the set this boot", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.runRetireOffCellRows).toHaveBeenCalledTimes(1);
    expect(H.runRetireOffCellRows.mock.invocationCallOrder[0]).toBeGreaterThan(
      H.runBookReconcile.mock.invocationCallOrder[0],
    );
    expect(H.runRetireOffCellRows.mock.invocationCallOrder[0]).toBeLessThan(
      H.readManagedDeployments.mock.invocationCallOrder[0],
    );
  });

  it("does not take boot down when it throws", async () => {
    healthy();
    H.runRetireOffCellRows.mockImplementationOnce(() => {
      throw new Error("app_settings is missing");
    });
    const { runBootSequence } = await freshBoot();

    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(bootLines("warn").some((m) => m.includes("retiring off-cell derived rows failed"))).toBe(true);
  });
});

// ── The build registers what prod-playbooks.ts says ─────────────────────────

/**
 * `registry.test.ts` pins the regex against the list in source; this is the
 * runtime half, for a bundle that came out different anyway.
 */
describe("the prod-playbook check", () => {
  const mismatch = () =>
    H.logEvent.mock.calls.filter((c: unknown[]) => c[0] === "boot_playbooks_mismatch");

  it("says nothing when the registry is exactly the list", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.registeredStrategyKeys).toHaveBeenCalled();
    expect(mismatch()).toEqual([]);
  });

  it("names a listed playbook the build does not register, at error, and boots anyway", async () => {
    healthy();
    const dropped = PROD_PLAYBOOK_KEYS[0];
    H.registeredStrategyKeys.mockReturnValue(PROD_PLAYBOOK_KEYS.filter((k) => k !== dropped));
    const { runBootSequence } = await freshBoot();

    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    expect(mismatch()).toHaveLength(1);
    expect(EVENTS.boot_playbooks_mismatch.severity).toBe("error");
    expect(String(mismatch()[0][2])).toContain(dropped);
  });

  it("names a registered playbook that is not on the list, on prod", async () => {
    healthy();
    H.registeredStrategyKeys.mockReturnValue([...PROD_PLAYBOOK_KEYS, "ema-bounce"]);
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(mismatch()).toHaveLength(1);
    expect(String(mismatch()[0][2])).toContain("ema-bounce");
  });

  // The message is the Discord title: the consequence leads, no file names.
  it("leads the line with what the rows will do and names no source file", async () => {
    healthy();
    const dropped = PROD_PLAYBOOK_KEYS[0];
    H.registeredStrategyKeys.mockReturnValue(PROD_PLAYBOOK_KEYS.filter((k) => k !== dropped));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = String(mismatch()[0][2]);
    expect(line.startsWith(`Rows of ${dropped} take no entries`)).toBe(true);
    expect(line).not.toMatch(/\.ts\b/);
  });

  // A staging boot with no broker refuses before the check is reached, so the
  // staging arm is pinned on `prodRegistryMismatch` in prod-playbooks.test.ts.
  it("runs after getEngine, so the line reaches engine_logs", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.registeredStrategyKeys.mock.invocationCallOrder[0]).toBeGreaterThan(
      H.getEngine.mock.invocationCallOrder[0],
    );
  });
});

// ── The orphan cross-check reads an answer, never a silence (A74) ───────────

/**
 * A74: a restart inside the maintenance window orphan-paused both legs of a
 * live combine for two trading days. A cold boot has nothing to carry forward,
 * so one Topstep `searchAccounts` throw left every Topstep account absent from
 * the registry and the cross-check read that absence as "the account is gone".
 * Orphaning is one-way — the row leaves the managed set — so nothing revisited
 * it.
 *
 * What these pin is that the attribution is **per arm**. A blanket skip on
 * `partial` would fix the incident and blind real detection on the broker that
 * did answer, which is the regression that matters more than the bug.
 */
// A75 / review of fc3192d7 #3: a detached row stays in the managed set and
// boots into the engine; boot names it once as exits-only.
describe("a detached row at boot", () => {
  it("boots the engine with it and says once that it exits only", async () => {
    const detached = { ...deployment(DEPL_A), orphanReason: "account_unavailable_at_boot" };
    H.readManagedDeployments.mockReturnValue({
      deployments: [detached],
      withheldLiveAccounts: [],
      skippedNotAllowed: [],
    });
    H.listManagedDeployments.mockReturnValue([detached]);
    const { runBootSequence } = await freshBoot();
    const outcome = await runBootSequence();

    expect(outcome.kind).not.toBe("no-deployments");
    expect(outcome.kind).not.toBe("all-withheld");
    const lines = bootLines("warn").filter((m) => m.includes("is detached"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DEPL_A);
    expect(lines[0]).toContain("exits only");
  });

  it("says nothing about a row that is not detached", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(bootLines("warn").some((m) => m.includes("is detached"))).toBe(false);
  });
});

describe("boot's orphan cross-check attributes an absent account to a broker arm", () => {
  /** One enabled deployment on an account the registry does not hold. */
  function absentAccount(): void {
    healthy();
    H.engine.isAccountRegistered.mockReturnValue(false);
  }

  it("does not orphan a Topstep account when the Topstep arm threw on a cold registry", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue("topstep");
    H.engine.refreshBrokerRegistry.mockResolvedValue(
      H.armDown("topstep", "504 from /Account/search"),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.engine.handleOrphanedAccount).not.toHaveBeenCalled();
  });

  it("names the account, the arm and the broker's error on every skip", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue("topstep");
    H.engine.refreshBrokerRegistry.mockResolvedValue(
      H.armDown("topstep", "504 from /Account/search"),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    const line = bootLines("warn").find((m) => m.includes("orphan check skipped"));
    expect(line).toContain("4242");
    expect(line).toContain("topstep");
    expect(line).toContain("504 from /Account/search");
  });

  it("still orphans an account genuinely absent from a clean fan-out", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue("topstep");
    H.engine.refreshBrokerRegistry.mockResolvedValue(H.cleanRefresh());
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      4242,
      "account_unavailable_at_boot",
    );
  });

  it("still orphans a Topstep account when it is the Tradovate arm that threw", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue("topstep");
    H.engine.refreshBrokerRegistry.mockResolvedValue(H.armDown("tradovate", "ws handshake failed"));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      4242,
      "account_unavailable_at_boot",
    );
  });

  it("skips an account with no persisted broker row when the refresh was partial", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue(null);
    H.engine.refreshBrokerRegistry.mockResolvedValue(H.armDown("topstep", "504"));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.engine.handleOrphanedAccount).not.toHaveBeenCalled();
    expect(bootLines("warn").some((m) => m.includes("orphan check skipped"))).toBe(true);
  });

  it("orphans an account with no persisted broker row when every arm answered", async () => {
    absentAccount();
    H.getAccountBrokerOrNull.mockReturnValue(null);
    H.engine.refreshBrokerRegistry.mockResolvedValue(H.cleanRefresh());
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      4242,
      "account_unavailable_at_boot",
    );
  });

  it("reads the persisted row through the OrNull form, so unknown is not confirmed Topstep", async () => {
    absentAccount();
    H.engine.refreshBrokerRegistry.mockResolvedValue(H.armDown("topstep", "504"));
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(H.getAccountBrokerOrNull).toHaveBeenCalledWith(4242);
  });
});

// ── The deploy measurement ─────────────────────────────────────────────────

/**
 * `boot_timing` is step 1's measurement of a deploy (zero-downtime-deploys.md):
 * one line per pass, however the pass ends, naming every stage it reached in ms
 * since process start. The numbers ride in the message because `meta` reaches
 * the console only, and the coordinator reads the ring.
 */
describe("boot_timing", () => {
  const COLD_START = { registerEnteredMs: 812.4, dbOpenMs: 1040.6 };
  const ALL_STAGES = [
    "registerEnteredMs",
    "dbOpenMs",
    "leaseAcquiredMs",
    "restartClassifiedMs",
    "accountsFannedOutMs",
    "hubsReadyMs",
    "realtimePreflightPassedMs",
    "booksReconciledMs",
    "engineStartedMs",
  ];

  interface TimingLine {
    message: string;
    meta: Record<string, unknown>;
  }

  function timingLines(): TimingLine[] {
    return H.logEvent.mock.calls
      .filter((c: unknown[]) => c[0] === "boot_timing")
      .map((c: unknown[]) => ({
        message: String(c[2]),
        meta: (c[3] as { meta: Record<string, unknown> }).meta,
      }));
  }

  function onlyTimingLine(): TimingLine {
    const lines = timingLines();
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  function stagesReached(line: TimingLine): string[] {
    return ALL_STAGES.filter((k) => k in line.meta);
  }

  it("is registered as an info diagnostics line", () => {
    expect(EVENTS.boot_timing).toMatchObject({ severity: "info", category: "lifecycle", template: null });
  });

  it("reports every stage of a boot that starts the engine, in the message as well as meta", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence({ processMarks: COLD_START });

    const line = onlyTimingLine();
    expect(line.meta.outcome).toBe("started");
    expect(stagesReached(line)).toEqual(ALL_STAGES);
    expect(line.meta.registerEnteredMs).toBe(812);
    expect(line.meta.dbOpenMs).toBe(1041);
    expect(line.message).toMatch(
      /^boot: timing \(started\), ms since process start — register 812, database open 1041, lease acquired \d+, restart classified \d+, accounts fanned out \d+, hubs ready \d+, realtime check \d+, books reconciled \d+, engine started \d+$/,
    );
  });

  it("has no register or database stage on the wizard's pass, which has no process marks", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();

    expect(stagesReached(onlyTimingLine())).toEqual(ALL_STAGES.slice(2));
  });

  // Every exit, each with the stages it reached and none it did not.
  const EXITS: Array<{
    name: string;
    arrange(): void;
    opts?: { rethrowAllowlistFailure: boolean };
    outcome: string;
    lastStage: string;
  }> = [
    { name: "no deployments", arrange: () => {}, outcome: "no-deployments", lastStage: "booksReconciledMs" },
    {
      name: "every deployment withheld",
      arrange: () =>
        H.readManagedDeployments.mockReturnValue({
          deployments: [],
          withheldLiveAccounts: [{ id: DEPL_A, reason: "live account" }],
          skippedNotAllowed: [],
        }),
      outcome: "all-withheld",
      lastStage: "booksReconciledMs",
    },
    {
      name: "a staging allowlist refusal the wizard asked to see",
      arrange: () => H.isStagingEnv.mockReturnValue(true),
      opts: { rethrowAllowlistFailure: true },
      outcome: "staging-allowlist-empty",
      lastStage: "accountsFannedOutMs",
    },
    {
      name: "an unusable realtime slot",
      arrange: () => {
        healthy();
        H.realtime.mockImplementation(() => {
          throw new Error("provider lost liveBars");
        });
      },
      outcome: "error",
      lastStage: "hubsReadyMs",
    },
    {
      name: "every deployment orphaned out",
      arrange: () => {
        H.readManagedDeployments.mockReturnValue({
          deployments: [deployment(DEPL_A)],
          withheldLiveAccounts: [],
          skippedNotAllowed: [],
        });
        H.listManagedDeployments.mockReturnValue([]);
      },
      outcome: "no-enabled-after-orphan-check",
      lastStage: "booksReconciledMs",
    },
    {
      name: "an engine already running",
      arrange: () => {
        healthy();
        H.engine.isRunning.mockReturnValue(true);
      },
      outcome: "already-running",
      lastStage: "booksReconciledMs",
    },
  ];

  for (const exit of EXITS) {
    it(`is emitted once on ${exit.name}, with the stages reached and no later one`, async () => {
      exit.arrange();
      const { runBootSequence } = await freshBoot();
      const result = await runBootSequence({ ...exit.opts, processMarks: COLD_START });
      expect(result.kind).toBe(exit.outcome);

      const line = onlyTimingLine();
      expect(line.meta.outcome).toBe(exit.outcome);
      expect(stagesReached(line)).toEqual(ALL_STAGES.slice(0, ALL_STAGES.indexOf(exit.lastStage) + 1));
    });
  }

  it("is emitted on a pass that throws — the cold-start staging refusal", async () => {
    H.isStagingEnv.mockReturnValue(true);
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence({ processMarks: COLD_START })).rejects.toThrow("no PRAC accounts");

    const line = onlyTimingLine();
    expect(line.meta.outcome).toBe("threw");
    expect(stagesReached(line)).toEqual(ALL_STAGES.slice(0, ALL_STAGES.indexOf("accountsFannedOutMs") + 1));
  });

  it("carries the gap since the previous shutdown signal when this pass consumed a marker", async () => {
    healthy();
    const markerAt = Date.now() - 31_000;
    H.evaluateRestart.mockReturnValue(
      verdict({ flatten: false, alarm: false, clean: true, cleanShutdownAt: markerAt }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence({ processMarks: COLD_START });

    const line = onlyTimingLine();
    expect(line.meta.sincePreviousShutdownMs).toBeGreaterThanOrEqual(31_000);
    expect(line.meta.sincePreviousShutdownMs).toBeLessThan(41_000);
    expect(line.meta.shutdownToProcessStartMs).toBe(Math.round(performance.timeOrigin - markerAt));
    expect(line.message).toMatch(/; \d+ms since the previous process was told to stop, -?\d+ of them before this process started$/);
  });

  it("carries no gap when no marker was consumed — a crash, or a first boot", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await runBootSequence({ processMarks: COLD_START });

    const line = onlyTimingLine();
    expect("sincePreviousShutdownMs" in line.meta).toBe(false);
    expect(line.message).not.toContain("told to stop");
  });

  it("carries no gap on the second pass, whose memoised verdict holds a marker it did not consume", async () => {
    // Cold start, then the wizard's activation in the same process.
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ flatten: false, alarm: false, clean: true, cleanShutdownAt: Date.now() - 31_000 }),
    );
    const { runBootSequence } = await freshBoot();
    await runBootSequence({ processMarks: COLD_START });
    await runBootSequence();

    const [first, second] = timingLines();
    expect("sincePreviousShutdownMs" in first.meta).toBe(true);
    expect("sincePreviousShutdownMs" in second.meta).toBe(false);
  });
});

// ── One engine per database: the lease ─────────────────────────────────────

describe("the engine lease at boot", () => {
  const HELD_BY_OTHER = {
    acquired: false,
    holder: "old-container:1:deadbeef",
    generation: 4,
    renewedAt: 0,
  };

  function leaseEvents(event: string): string[] {
    return H.logEvent.mock.calls
      .filter((c: unknown[]) => c[0] === event)
      .map((c: unknown[]) => String(c[2]));
  }

  it("is taken before the classification, which consumes the marker and starts the heartbeat", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });

    expect(H.tryAcquireLease).toHaveBeenCalledWith("self", expect.any(Number));
    expect(H.tryAcquireLease.mock.invocationCallOrder[0]).toBeLessThan(
      H.evaluateRestart.mock.invocationCallOrder[0],
    );
    expect(H.startLeaseRenewal.mock.invocationCallOrder[0]).toBeLessThan(
      H.evaluateRestart.mock.invocationCallOrder[0],
    );
    expect(leaseEvents("engine_lease_acquired")).toEqual([
      expect.stringContaining("generation 1"),
    ]);
    expect(EVENTS.engine_lease_acquired).toMatchObject({ severity: "info", category: "lifecycle" });
  });

  it("waits for a crashed holder's lease to go stale, says so once, then boots", async () => {
    healthy();
    let attempts = 0;
    H.tryAcquireLease.mockImplementation(() => {
      attempts += 1;
      return attempts <= 3 ? HELD_BY_OTHER : { acquired: true, holder: "self", generation: 5, renewedAt: 0 };
    });
    const { runBootSequence, LEASE_ACQUIRE_RETRY_MS } = await freshBoot();
    vi.useFakeTimers();
    try {
      const boot = runBootSequence();
      await vi.advanceTimersByTimeAsync(3 * LEASE_ACQUIRE_RETRY_MS);
      await expect(boot).resolves.toEqual({ kind: "started", deploymentCount: 1 });
    } finally {
      vi.useRealTimers();
    }

    expect(attempts).toBe(4);
    const waiting = leaseEvents("engine_lease_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain("old-container:1:deadbeef");
    expect(EVENTS.engine_lease_waiting).toMatchObject({ severity: "warn", category: "lifecycle" });
    expect(leaseEvents("engine_lease_acquired")).toEqual([expect.stringContaining("generation 5")]);
    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
    expect(H.reportLeaseRefused).not.toHaveBeenCalled();
  });

  it("refuses loudly at the bound, before classifying, building or starting anything", async () => {
    healthy();
    H.tryAcquireLease.mockImplementation(() => HELD_BY_OTHER);
    const { runBootSequence, LEASE_ACQUIRE_BOUND_MS, LEASE_ACQUIRE_RETRY_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runBootSequence>>;
    try {
      const boot = runBootSequence();
      await vi.advanceTimersByTimeAsync(LEASE_ACQUIRE_BOUND_MS + LEASE_ACQUIRE_RETRY_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toMatchObject({ kind: "error" });
    // The two-engines case: reported the way a boot assertion failure is, so
    // `maybeAutoStart` answers 503 rather than starting the engine anyway.
    expect(H.markBootAssertionFailed).toHaveBeenCalledWith(
      expect.stringContaining("old-container:1:deadbeef"),
    );
    expect(H.reportLeaseRefused).toHaveBeenCalledWith("boot", expect.stringContaining("another engine"));
    expect(EVENTS.engine_lease_refused).toMatchObject({
      severity: "error",
      category: "safety",
      escalates: true,
    });
    expect(H.evaluateRestart).not.toHaveBeenCalled();
    expect(H.installCleanShutdownMarker).not.toHaveBeenCalled();
    expect(H.startProcessLiveness).not.toHaveBeenCalled();
    expect(H.startLeaseRenewal).not.toHaveBeenCalled();
    expect(H.getEngine).not.toHaveBeenCalled();
    expect(H.engine.start).not.toHaveBeenCalled();
    // The wait has its own stage, so it never folds into the classification's.
    const timing = H.logEvent.mock.calls.find((c: unknown[]) => c[0] === "boot_timing") as unknown[];
    expect(Object.keys((timing[3] as { meta: object }).meta)).not.toContain("leaseAcquiredMs");
  });

  it("stops the engine when the renew finds the lease taken", async () => {
    healthy();
    const stop = vi.fn();
    const { runBootSequence } = await freshBoot();
    await runBootSequence();
    const [{ onLost }] = H.startLeaseRenewal.mock.calls[0] as unknown as [{ onLost: () => void }];

    H.getEngineIfReady.mockReturnValue({ isRunning: () => true, stop });
    onLost();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("never runs in a web process, and touches neither the lease nor the marker on the way out", async () => {
    healthy();
    H.runsEngine.mockReturnValue(false);
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).rejects.toMatchObject({ name: "EngineNotInThisProcessError" });
    expect(H.tryAcquireLease).not.toHaveBeenCalled();
    expect(H.evaluateRestart).not.toHaveBeenCalled();
    expect(H.getEngine).not.toHaveBeenCalled();
  });
});

// ── The split: process boot, then activation ───────────────────────────────

describe("the ordinary boot after the split", () => {
  // Every role but a standby runs lease → classify → process boot →
  // activation, which is the order the boot had before the split.
  it("runs every step in the order it always has, and holds no token", async () => {
    healthy();
    const { runBootSequence } = await freshBoot();
    await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });

    const steps: Array<[string, { mock: { invocationCallOrder: number[] } }]> = [
      ["lease", H.tryAcquireLease],
      ["renew", H.startLeaseRenewal],
      ["marker hook", H.installCleanShutdownMarker],
      ["classify", H.evaluateRestart],
      ["liveness", H.startProcessLiveness],
      ["session migration", H.runPendingSessionMigrations],
      ["engine", H.getEngine],
      ["hubs", H.engine.ensureHubsReady],
      ["realtime check", H.realtime],
      ["books", H.runBookReconcile],
      ["retire", H.runRetireOffCellRows],
      ["deployment read", H.readManagedDeployments],
      ["orphan check", H.engine.refreshBrokerRegistry],
      ["managed set", H.listManagedDeployments],
      ["verdict", H.engine.applyRestartVerdict],
      ["start", H.engine.start],
    ];
    const order = [...steps]
      .sort(([, a], [, b]) => a.mock.invocationCallOrder[0] - b.mock.invocationCallOrder[0])
      .map(([name]) => name);
    expect(order).toEqual(steps.map(([name]) => name));
    expect(H.holdTokenRefresh).not.toHaveBeenCalled();
    expect(H.requestHandoff).not.toHaveBeenCalled();
  });
});

describe("a standby's boot — the hand-off", () => {
  const DRAINING_KEY = "__crossfireShutdownDraining";
  const ACTIVE = "active-container:1:aaaa";
  const HELD_BY_ACTIVE = { acquired: false, holder: ACTIVE, generation: 4, renewedAt: 0 };
  const TAKEN = { acquired: true, holder: "self", generation: 5, renewedAt: 0 };

  beforeEach(() => {
    H.requestHandoff.mockImplementation(() => ({ kind: "requested", holder: ACTIVE, generation: 4 }));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[DRAINING_KEY];
  });

  function events(event: string): string[] {
    return H.logEvent.mock.calls.filter((c: unknown[]) => c[0] === event).map((c: unknown[]) => String(c[2]));
  }

  /** The active holds the lease for `heldPolls` looks, then has released it. */
  function activeReleasesAfter(heldPolls: number): void {
    let looks = 0;
    H.tryAcquireLease.mockImplementation(() => (++looks <= heldPolls ? HELD_BY_ACTIVE : TAKEN));
  }

  it("boots its process half, says it is ready, and takes nothing of the engine while the active runs", async () => {
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    try {
      void runStandbyBoot();
      await vi.advanceTimersByTimeAsync(5 * HANDOFF_POLL_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(H.holdTokenRefresh).toHaveBeenCalledWith(true);
    expect(H.holdTokenRefresh).not.toHaveBeenCalledWith(false);
    expect(events("standby_ready")).toHaveLength(1);
    expect(events("handoff_requested")).toEqual([expect.stringContaining(ACTIVE)]);
    expect(H.requestHandoff).toHaveBeenCalledTimes(1);
    expect(H.refreshHandoffRequest).toHaveBeenCalled();
    // Not the lease, not the classification, not the liveness stamp, not the
    // marker hook, not the engine.
    expect(H.startLeaseRenewal).not.toHaveBeenCalled();
    expect(H.evaluateRestart).not.toHaveBeenCalled();
    expect(H.startProcessLiveness).not.toHaveBeenCalled();
    expect(H.installCleanShutdownMarker).not.toHaveBeenCalled();
    expect(H.getEngine).not.toHaveBeenCalled();
    expect(H.runPendingSessionMigrations).not.toHaveBeenCalled();
    expect(H.runBookReconcile).not.toHaveBeenCalled();
  });

  // Tradovate keeps two sessions per user and closes the oldest on a third.
  // Active engine + web make two, so a standby that logs in at its boot closes
  // the draining active's session and its exits 401. The standby asks
  // Tradovate only once it has taken the engine.
  describe("Tradovate waits for the takeover", () => {
    const TOPSTEP_PRAC = 11;
    const TRADOVATE_DEMO = 22;

    function account(id: number, broker: Account["broker"]): Account {
      return { id, name: `acct-${id}`, balance: 0, canTrade: true, isVisible: true, broker, practice: true };
    }

    function bothBrokersConfigured(): void {
      const topstep = {
        isConfigured: () => true,
        initialize: async () => {},
        getClient: () => ({ searchAccounts: H.topstepSearchAccounts }),
      };
      const tradovate = {
        isConfigured: () => true,
        initialize: H.tradovateInitialize,
        getClient: () => ({ searchAccounts: H.tradovateSearchAccounts }),
      };
      H.getPlugin.mockImplementation((id) => (id === "topstep" ? topstep : id === "tradovate" ? tradovate : null));
      H.topstepSearchAccounts.mockImplementation(async () => [account(TOPSTEP_PRAC, "topstep")]);
      H.tradovateSearchAccounts.mockImplementation(async () => [account(TRADOVATE_DEMO, "tradovate")]);
    }

    async function standbyFor(polls: number): Promise<Awaited<ReturnType<typeof import("./boot-engine")["runStandbyBoot"]>>> {
      const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
      vi.useFakeTimers();
      try {
        const boot = runStandbyBoot();
        // A staging refusal rejects while the timers advance; the caller
        // asserts it through the returned promise.
        boot.catch(() => {});
        await vi.advanceTimersByTimeAsync(polls * HANDOFF_POLL_MS);
        return await boot;
      } finally {
        vi.useRealTimers();
      }
    }

    it("a standby's boot asks Topstep and makes no Tradovate login while the active runs", async () => {
      healthy();
      bothBrokersConfigured();
      activeReleasesAfter(Number.POSITIVE_INFINITY);
      const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
      vi.useFakeTimers();
      try {
        void runStandbyBoot();
        await vi.advanceTimersByTimeAsync(5 * HANDOFF_POLL_MS);
      } finally {
        vi.useRealTimers();
      }

      expect(events("standby_ready")).toHaveLength(1);
      expect(H.topstepSearchAccounts).toHaveBeenCalledTimes(1);
      expect(H.tradovateInitialize).not.toHaveBeenCalled();
      expect(H.tradovateSearchAccounts).not.toHaveBeenCalled();
    });

    it("the takeover logs in to Tradovate once — after the take and the classification, before the engine and handoff_taken", async () => {
      healthy();
      bothBrokersConfigured();
      activeReleasesAfter(3);
      const result = await standbyFor(4);

      expect(result).toEqual({ kind: "started", deploymentCount: 1 });
      expect(H.tradovateInitialize).toHaveBeenCalledTimes(1);
      expect(H.tradovateSearchAccounts).toHaveBeenCalledTimes(1);
      const login = H.tradovateInitialize.mock.invocationCallOrder[0];
      const take = H.tryAcquireLease.mock.invocationCallOrder[3];
      expect(login).toBeGreaterThan(take);
      expect(login).toBeGreaterThan(H.evaluateRestart.mock.invocationCallOrder[0]);
      expect(login).toBeLessThan(H.getEngine.mock.invocationCallOrder[0]);
      const taken = H.logEvent.mock.calls.findIndex((c: unknown[]) => c[0] === "handoff_taken");
      expect(login).toBeLessThan(H.logEvent.mock.invocationCallOrder[taken]);
      // Topstep was asked at boot only.
      expect(H.topstepSearchAccounts).toHaveBeenCalledTimes(1);
    });

    it("the ordinary boot still asks Tradovate in its process boot, before the engine", async () => {
      healthy();
      bothBrokersConfigured();
      const { runBootSequence } = await freshBoot();
      await expect(runBootSequence()).resolves.toEqual({ kind: "started", deploymentCount: 1 });

      expect(H.tradovateInitialize).toHaveBeenCalledTimes(1);
      expect(H.tradovateInitialize.mock.invocationCallOrder[0]).toBeLessThan(H.getEngine.mock.invocationCallOrder[0]);
    });

    it("on staging, the allowlist is derived at takeover over both brokers, not at the standby's boot", async () => {
      healthy();
      bothBrokersConfigured();
      H.isStagingEnv.mockReturnValue(true);
      H.isPracticeAccount.mockImplementation(() => true);
      activeReleasesAfter(3);
      const result = await standbyFor(4);

      expect(result).toEqual({ kind: "started", deploymentCount: 1 });
      expect(H.markBootAssertionFailed).not.toHaveBeenCalled();
      expect(H.setStagingAllowlist).toHaveBeenCalledTimes(1);
      expect(H.setStagingAllowlist).toHaveBeenCalledWith([TOPSTEP_PRAC, TRADOVATE_DEMO]);
      expect(H.setStagingAllowlist.mock.invocationCallOrder[0]).toBeGreaterThan(
        H.tradovateInitialize.mock.invocationCallOrder[0],
      );
    });

    it("on staging, a Topstep-only fan-out with no practice account does not refuse while Tradovate is still to be asked", async () => {
      healthy();
      bothBrokersConfigured();
      H.isStagingEnv.mockReturnValue(true);
      H.isPracticeAccount.mockImplementation((a) => a.broker === "tradovate");
      activeReleasesAfter(3);
      const result = await standbyFor(4);

      expect(result).toEqual({ kind: "started", deploymentCount: 1 });
      expect(H.setStagingAllowlist).toHaveBeenCalledWith([TRADOVATE_DEMO]);
    });

    it("on staging, a Tradovate arm that fails at takeover refuses before handoff_taken and activates nothing", async () => {
      healthy();
      bothBrokersConfigured();
      H.isStagingEnv.mockReturnValue(true);
      H.isPracticeAccount.mockImplementation(() => true);
      H.tradovateSearchAccounts.mockImplementation(async () => {
        throw new Error("Tradovate is down");
      });
      activeReleasesAfter(3);

      await expect(standbyFor(4)).rejects.toThrow(/fan-out failed — tradovate: Tradovate is down/);
      expect(H.markBootAssertionFailed).toHaveBeenCalledWith(expect.stringContaining("tradovate"));
      // The line the deploy's poll greps for.
      expect(events("boot_refused")).toEqual([
        "boot: staging boot: broker account fan-out failed — tradovate: Tradovate is down — refusing to start",
      ]);
      expect(events("handoff_taken")).toEqual([]);
      expect(H.getEngine).not.toHaveBeenCalled();
      expect(H.engine.start).not.toHaveBeenCalled();
    });

    it("on staging, no practice account on either broker refuses at takeover — the empty count is judged there", async () => {
      healthy();
      bothBrokersConfigured();
      H.isStagingEnv.mockReturnValue(true);
      H.isPracticeAccount.mockImplementation(() => false);
      activeReleasesAfter(3);

      await expect(standbyFor(4)).rejects.toThrow("staging boot: no PRAC accounts found in /Account/search");
      expect(H.tradovateInitialize).toHaveBeenCalledTimes(1);
      expect(H.markBootAssertionFailed).toHaveBeenCalledTimes(1);
      expect(events("boot_refused")).toEqual([
        "boot: staging boot: no PRAC accounts found in /Account/search — refusing to start",
      ]);
      expect(H.setStagingAllowlist).not.toHaveBeenCalled();
      expect(events("handoff_taken")).toEqual([]);
      expect(H.getEngine).not.toHaveBeenCalled();
    });

    it("on prod, a Tradovate arm that fails at takeover is reported and the takeover goes on", async () => {
      healthy();
      bothBrokersConfigured();
      H.tradovateSearchAccounts.mockImplementation(async () => {
        throw new Error("Tradovate is down");
      });
      activeReleasesAfter(3);
      const result = await standbyFor(4);

      expect(result).toEqual({ kind: "started", deploymentCount: 1 });
      expect(events("boot_fanout_failed")).toEqual([expect.stringContaining("tradovate: Tradovate is down")]);
      expect(events("boot_refused")).toEqual([]);
      const failed = H.logEvent.mock.calls.findIndex((c: unknown[]) => c[0] === "boot_fanout_failed");
      const taken = H.logEvent.mock.calls.findIndex((c: unknown[]) => c[0] === "handoff_taken");
      expect(taken).toBeGreaterThan(failed);
      expect(H.engine.start).toHaveBeenCalledTimes(1);
    });

    it("on staging, a Tradovate-only standby asks nothing at boot, does not refuse there, and asks Tradovate at takeover", async () => {
      healthy();
      bothBrokersConfigured();
      const tradovateOnly = H.getPlugin.getMockImplementation();
      H.getPlugin.mockImplementation((id) => (id === "topstep" ? null : tradovateOnly?.(id) ?? null));
      H.isStagingEnv.mockReturnValue(true);
      H.isPracticeAccount.mockImplementation(() => true);
      activeReleasesAfter(3);
      const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof runStandbyBoot>>;
      try {
        const boot = runStandbyBoot();
        boot.catch(() => {});
        await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS);
        // Still waiting on the active: zero arms asked, and no refusal.
        expect(events("standby_ready")).toHaveLength(1);
        expect(H.markBootAssertionFailed).not.toHaveBeenCalled();
        expect(H.tradovateInitialize).not.toHaveBeenCalled();
        expect(H.topstepSearchAccounts).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3 * HANDOFF_POLL_MS);
        result = await boot;
      } finally {
        vi.useRealTimers();
      }

      expect(result).toEqual({ kind: "started", deploymentCount: 1 });
      expect(H.tradovateInitialize).toHaveBeenCalledTimes(1);
      expect(H.setStagingAllowlist).toHaveBeenCalledWith([TRADOVATE_DEMO]);
    });

    it("boot_timing gives the takeover's held-back ask its own stage", async () => {
      healthy();
      bothBrokersConfigured();
      activeReleasesAfter(3);
      await standbyFor(4);

      const timing = H.logEvent.mock.calls.filter((c: unknown[]) => c[0] === "boot_timing");
      expect(timing).toHaveLength(1);
      const meta = (timing[0][3] as { meta: Record<string, unknown> }).meta;
      expect(meta).toHaveProperty("heldBackArmsAskedMs");
      expect(String(timing[0][2])).toMatch(/accounts fanned out \d+, held-back arms asked \d+, hubs ready \d+/);
    });
  });

  it("takes the released lease, then classifies, stamps and activates — classify after the take", async () => {
    healthy();
    H.evaluateRestart.mockReturnValue(
      verdict({ gapMs: 3_000, clean: true, flatten: false, alarm: false, cleanShutdownAt: Date.now() - 4_000 }),
    );
    activeReleasesAfter(3);
    const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(4 * HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({ kind: "started", deploymentCount: 1 });
    const takeOrder = H.tryAcquireLease.mock.invocationCallOrder[3];
    expect(H.holdTokenRefresh.mock.invocationCallOrder[1]).toBeGreaterThan(takeOrder);
    expect(H.startLeaseRenewal.mock.invocationCallOrder[0]).toBeGreaterThan(takeOrder);
    expect(H.installCleanShutdownMarker.mock.invocationCallOrder[0]).toBeGreaterThan(takeOrder);
    expect(H.evaluateRestart.mock.invocationCallOrder[0]).toBeGreaterThan(takeOrder);
    expect(H.startProcessLiveness.mock.invocationCallOrder[0]).toBeGreaterThan(
      H.evaluateRestart.mock.invocationCallOrder[0],
    );
    expect(H.getEngine.mock.invocationCallOrder[0]).toBeGreaterThan(H.evaluateRestart.mock.invocationCallOrder[0]);
    // The heartbeat it read is the yielded engine's last stamp: the real gap.
    expect(events("handoff_taken")).toEqual([
      expect.stringMatching(/generation 5, .*3s since the previous engine's last heartbeat/),
    ]);
    expect(events("boot_gap_within_rule")).toEqual([expect.stringContaining("previous process stopped cleanly")]);
    expect(H.engine.start).toHaveBeenCalledTimes(1);
    expect(H.withdrawHandoff).not.toHaveBeenCalled();
  });

  it("classifies once per process: the wizard's pass after a takeover reads the memo", async () => {
    healthy();
    activeReleasesAfter(1);
    const { runStandbyBoot, runBootSequence, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(2 * HANDOFF_POLL_MS);
      await boot;
    } finally {
      vi.useRealTimers();
    }
    await runBootSequence();

    expect(H.evaluateRestart).toHaveBeenCalledTimes(1);
  });

  it("takes a free or stale lease at once, without asking — no active, or a crashed one", async () => {
    healthy();
    activeReleasesAfter(0);
    const { runStandbyBoot } = await freshBoot();
    await expect(runStandbyBoot()).resolves.toEqual({ kind: "started", deploymentCount: 1 });

    expect(H.requestHandoff).not.toHaveBeenCalled();
    expect(events("handoff_taken")).toHaveLength(1);
  });

  it("never takes a fresh lease: refuses at the bound, withdraws its request, and touches nothing", async () => {
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    const { runStandbyBoot, HANDOFF_WAIT_MS, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(HANDOFF_WAIT_MS + HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toMatchObject({ kind: "error" });
    expect(H.withdrawHandoff).toHaveBeenCalledWith("self");
    expect(events("handoff_refused")).toEqual([expect.stringContaining("still trading")]);
    expect(H.markBootAssertionFailed).toHaveBeenCalledWith(expect.stringContaining(ACTIVE));
    expect(H.tryAcquireLease.mock.results.every((r) => r.value.acquired === false)).toBe(true);
    expect(H.startLeaseRenewal).not.toHaveBeenCalled();
    expect(H.evaluateRestart).not.toHaveBeenCalled();
    expect(H.getEngine).not.toHaveBeenCalled();
    expect(H.engine.start).not.toHaveBeenCalled();
    // It stays a standby: the shared token stays held.
    expect(H.holdTokenRefresh).not.toHaveBeenCalledWith(false);
  });

  it("waits out an accepted hand-off past the bound — the active is draining", async () => {
    healthy();
    const { runStandbyBoot, HANDOFF_WAIT_MS, HANDOFF_POLL_MS } = await freshBoot();
    // Accepted five looks before the bound, released ten looks after it.
    const pollsToBound = HANDOFF_WAIT_MS / HANDOFF_POLL_MS;
    const heldPolls = pollsToBound + 10;
    activeReleasesAfter(heldPolls);
    let refreshes = 0;
    H.refreshHandoffRequest.mockImplementation(() => ++refreshes < pollsToBound - 5);
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync((heldPolls + 1) * HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({ kind: "started", deploymentCount: 1 });
    expect(H.withdrawHandoff).not.toHaveBeenCalled();
  });

  it("refuses when the active accepted and never released, past the yield's own bound", async () => {
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    H.refreshHandoffRequest.mockReturnValue(false);
    const { runStandbyBoot, HANDOFF_YIELD_BOUND_MS, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(HANDOFF_YIELD_BOUND_MS + 2 * HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toMatchObject({ kind: "error" });
    expect(events("handoff_refused")).toEqual([expect.stringContaining("accepted the hand-off")]);
    expect(H.engine.start).not.toHaveBeenCalled();
  });

  it("withdraws its request, once, when stopped while it waits", async () => {
    // The deploy's rollback stops it; the active must never yield to a
    // process that is leaving.
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    try {
      void runStandbyBoot();
      await vi.advanceTimersByTimeAsync(2 * HANDOFF_POLL_MS);
    } finally {
      vi.useRealTimers();
    }
    const hook = H.registerPreCloseHook.mock.calls.at(-1)?.[0];
    expect(hook).toBeTypeOf("function");

    hook?.("SIGTERM");
    expect(H.withdrawHandoff).toHaveBeenCalledWith("self");
    hook?.("SIGTERM");
    expect(H.withdrawHandoff).toHaveBeenCalledTimes(1);
  });

  it("raises the draining latch when stopped, so nothing it takes on its way out enters", async () => {
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
    const { isShutdownDraining } = await import("@/lib/shutdown-drain");
    vi.useFakeTimers();
    try {
      void runStandbyBoot();
      await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(isShutdownDraining()).toBe(false);
    H.registerPreCloseHook.mock.calls.at(-1)?.[0]("SIGTERM");
    expect(isShutdownDraining()).toBe(true);
  });

  it("stopped after the active accepted, it hands back a lease it takes on its way out and activates nothing", async () => {
    // The withdraw fails — already accepted — so the poll runs on through the
    // standby's own drain; the active exits and frees the lease, and the
    // next look takes it.
    healthy();
    H.refreshHandoffRequest.mockReturnValue(false);
    let stopped = false;
    H.isShutdownStarted.mockImplementation(() => stopped);
    let looks = 0;
    H.tryAcquireLease.mockImplementation(() => {
      if (++looks === 1) return HELD_BY_ACTIVE;
      // The stop began while this process slept between looks.
      stopped = true;
      return TAKEN;
    });
    const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(2 * HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toMatchObject({ kind: "error" });
    expect(H.tryAcquireLease.mock.results.some((r) => r.value.acquired === true)).toBe(true);
    expect(H.releaseLease).toHaveBeenCalledWith("self");
    expect(events("handoff_refused")).toEqual([expect.stringContaining("stopped while it waited")]);
    expect(H.startLeaseRenewal).not.toHaveBeenCalled();
    expect(H.evaluateRestart).not.toHaveBeenCalled();
    expect(H.installCleanShutdownMarker).not.toHaveBeenCalled();
    expect(H.engine.start).not.toHaveBeenCalled();
  });

  it("stops polling once stopped while it waits, and takes nothing", async () => {
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    H.isShutdownStarted.mockReturnValue(true);
    const { runStandbyBoot } = await freshBoot();
    await expect(runStandbyBoot()).resolves.toMatchObject({ kind: "error" });
    expect(H.tryAcquireLease).toHaveBeenCalledTimes(1);
    expect(H.releaseLease).not.toHaveBeenCalled();
    expect(H.requestHandoff).not.toHaveBeenCalled();
  });

  it("does not read a refresh that found its request gone as an acceptance unless the column is clear on the active's lease", async () => {
    // Another standby asked over a request this one let lapse: not accepted.
    healthy();
    activeReleasesAfter(Number.POSITIVE_INFINITY);
    H.refreshHandoffRequest.mockReturnValue(false);
    H.handoffAcceptedBy.mockReturnValue(false);
    H.withdrawHandoff.mockReturnValue(false);
    const { runStandbyBoot, HANDOFF_WAIT_MS, HANDOFF_POLL_MS } = await freshBoot();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runStandbyBoot>>;
    try {
      const boot = runStandbyBoot();
      await vi.advanceTimersByTimeAsync(HANDOFF_WAIT_MS + HANDOFF_POLL_MS);
      result = await boot;
    } finally {
      vi.useRealTimers();
    }

    // Refused at the ask's bound, not waited out as an accepted yield.
    expect(result).toMatchObject({ kind: "error" });
    expect(events("handoff_refused")).toEqual([expect.stringContaining("did not accept the hand-off")]);
    expect(H.handoffAcceptedBy).toHaveBeenCalledWith(ACTIVE);
  });

  describe("two standbys", () => {
    const FIRST = "first-standby:2:bbbb";
    const HELD_BY_FIRST = { acquired: false, holder: FIRST, generation: 5, renewedAt: 0 };

    it("the second queues behind the first's request, and never asks the first once it took the engine", async () => {
      // The second sees the first's live request on the active, waits for it
      // to clear, and — the active accepted the first and exited — finds the
      // first holding the lease. Asking it would hand the engine straight
      // back: the ping-pong.
      healthy();
      let looks = 0;
      H.tryAcquireLease.mockImplementation(() => (++looks <= 3 ? HELD_BY_ACTIVE : HELD_BY_FIRST));
      H.requestHandoff.mockImplementation(() => ({ kind: "queued", behind: FIRST, holder: ACTIVE }));
      const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof runStandbyBoot>>;
      try {
        const boot = runStandbyBoot();
        await vi.advanceTimersByTimeAsync(5 * HANDOFF_POLL_MS);
        result = await boot;
      } finally {
        vi.useRealTimers();
      }

      expect(events("handoff_queued")).toEqual([expect.stringContaining(FIRST)]);
      expect(events("handoff_requested")).toEqual([]);
      // Asked only while the active held the lease; never of the first.
      expect(H.requestHandoff).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ kind: "error" });
      expect(events("handoff_refused")).toEqual([expect.stringContaining("does not ask it back")]);
      expect(H.startLeaseRenewal).not.toHaveBeenCalled();
      expect(H.engine.start).not.toHaveBeenCalled();
    });

    it("an accepted standby whose lease another process took refuses rather than asking it back", async () => {
      healthy();
      let looks = 0;
      H.tryAcquireLease.mockImplementation(() => (++looks <= 2 ? HELD_BY_ACTIVE : HELD_BY_FIRST));
      H.refreshHandoffRequest.mockReturnValue(false);
      const { runStandbyBoot, HANDOFF_POLL_MS } = await freshBoot();
      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof runStandbyBoot>>;
      try {
        const boot = runStandbyBoot();
        await vi.advanceTimersByTimeAsync(3 * HANDOFF_POLL_MS);
        result = await boot;
      } finally {
        vi.useRealTimers();
      }

      expect(result).toMatchObject({ kind: "error" });
      expect(H.requestHandoff).toHaveBeenCalledTimes(1);
      expect(events("handoff_refused")).toEqual([expect.stringContaining(FIRST)]);
    });
  });

  it("registers its events: five lifecycle lines and one flagged refusal", () => {
    for (const event of ["standby_ready", "handoff_requested", "handoff_queued", "handoff_yielded", "handoff_taken"]) {
      expect(EVENTS[event], event).toMatchObject({ severity: "info", category: "lifecycle" });
    }
    expect(EVENTS.handoff_refused).toMatchObject({ severity: "error", category: "safety", escalates: true });
  });
});
