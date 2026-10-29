/**
 * The cooldown all four flatten actors share.
 *
 * Four actors submit a market order against a broker position without
 * re-reading it — the naked-position watchdog, D-2 enforcement, the
 * session-end clock guard and P6's restart downtime sweep — so the describes
 * below drive the *real* controllers against one shared instance rather than
 * asserting the map's shape; a cooldown that four classes hold but only two
 * consult would pass every unit test above them.
 *
 * **D-16 changed which pairings are reachable, and the first describe below is
 * now a contract test rather than a reproduction.** The watchdog's scope used
 * to be "any exit-loop deployment's resolved contract", which put a hand
 * position on a deployment's own front month inside the watchdog *and* inside
 * D-2's expected-flat arm at once — the live double-flatten this file was
 * written for. The watchdog now scopes to contracts carrying a reconcilable
 * trade row, and D-2 acts only where there is none, and both read the same
 * query: **the two scopes are complementary, so they can no longer contend on
 * one `(account, contract)` key in production.** The pairing is kept because
 * the property under test is per-actor — each one consults `active()` before
 * dispatch and stamps `note()` before the submit — and losing the D-2 half of
 * that would leave the only actor whose scope is disjoint from everyone
 * else's untested against the instance it shares. Whether to re-aim these
 * three at a reachable pairing is filed for review; do not read their presence
 * as a claim that the interleaving is still live.
 *
 * The watchdog↔session-guard and watchdog↔restart-sweep pairings *are* still
 * live — all three act on a deployment's own position — and they are why the
 * cooldown exists at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  getReconcilableTrades: vi.fn(() => []),
  listAccountsWithReconcilableTrades: vi.fn(() => []),
  getAllOpenTrades: vi.fn(() => []),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
}));

// Every actor here is this process's and holds the lease; a sweep without it
// is pinned in each sweep's own test.
vi.mock("@/lib/db/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/lease")>()),
  leaseGate: () => () => true,
}));

vi.mock("@/lib/db/engine-restart", () => ({
  readEngineRestartState: vi.fn(() => ({
    lastSeenAt: null,
    cleanShutdownAt: null,
    resumeCycles: [],
    pendingFlatten: { entries: [], gapMs: 0 },
  })),
  consumeCleanShutdownMarker: vi.fn(() => null),
  consumeHeartbeatDegradedMarker: vi.fn(() => null),
  markCleanShutdown: vi.fn(),
  recordUncleanResume: vi.fn(() => 0),
  setPendingFlatten: vi.fn(),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn(() => []),
  markTerminal: vi.fn(),
}));

vi.mock("../strategies", () => ({
  getStrategy: vi.fn(),
}));

import type { Broker } from "../broker-access/broker";
import type { Contract, Order, OrderSide, OrderStatus, PlaceOrderRequest, Position, PositionType } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment } from "@/lib/trading/domain";
import type { DeploymentState } from "./engine";
import type { StrategyModule } from "../strategy-types";
import { getReconcilableTrades, listAccountsWithReconcilableTrades } from "@/lib/db/trades";
import { getStrategy } from "../strategies";
import { FlattenCooldown, FLATTEN_COOLDOWN_MS } from "./engine-flatten-cooldown";
import { NakedPositionWatchdog, NAKED_POSITION_WATCHDOG_INTERVAL_MS, type NakedWatchdogDeps } from "./flatten/engine-watchdog";
import { ManualPositionGuard, type ManualPositionGuardDeps } from "./flatten/engine-manual-position";
import { SessionEndGuard, type SessionGuardDeps } from "./session-close/engine-session-guard";
import { RestartFlattenGuard, type RestartGuardDeps } from "./boot/engine-restart";

const ACCT = 4242;
/** The deployment's own front month — in the watchdog's managed set *and* the
 *  contract a hand position has to be on for all four actors to see it. */
const MGC_Z26 = "CON.F.US.MGC.Z26";
const DEPLOY = "deploy-mgc";
const LONG: PositionType = 1;
const WORKING: OrderStatus = 1;

/** 2026-08-24 is a Monday. 14:30 UTC = 10:30 ET, inside 09:30–16:00. */
const IN_WINDOW = new Date("2026-08-24T14:30:00.000Z");
/** 21:30 UTC = 17:30 ET, past the same window. D-2 claims nothing out of
 *  window by design, so the session-guard pairings run here and the D-2 ones
 *  run at `IN_WINDOW`. The watchdog has no session gate and fires at either. */
const OUT_OF_WINDOW = new Date("2026-08-24T21:30:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(IN_WINDOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlattenCooldown", () => {
  it("suppresses a second flatten on the same contract for the full window", () => {
    const c = new FlattenCooldown();
    c.note(ACCT, MGC_Z26, "watchdog");
    expect(c.active(ACCT, MGC_Z26)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + FLATTEN_COOLDOWN_MS - 1));
    expect(c.active(ACCT, MGC_Z26)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + 2));
    expect(c.active(ACCT, MGC_Z26)).toBe(false);
  });

  it("is keyed per (account, contract), so an unrelated contract is unaffected", () => {
    const c = new FlattenCooldown();
    c.note(ACCT, MGC_Z26, "d2");
    expect(c.active(ACCT, "CON.F.US.MGC.G27")).toBe(false);
    expect(c.active(9999, MGC_Z26)).toBe(false);
  });

  it("release drops the actor's own stamp", () => {
    const c = new FlattenCooldown();
    c.note(ACCT, MGC_Z26, "d2");
    c.release(ACCT, MGC_Z26, "d2");
    expect(c.active(ACCT, MGC_Z26)).toBe(false);
  });

  it("release refuses to drop the other actor's stamp", () => {
    // The sequence this exists for: D-2 takes an EXIT_IN_FLIGHT and drops its
    // cooldown so the next pass reconsiders — which must say nothing about a
    // market order the watchdog put on the book two seconds earlier.
    const c = new FlattenCooldown();
    c.note(ACCT, MGC_Z26, "watchdog");
    c.release(ACCT, MGC_Z26, "d2");
    expect(c.active(ACCT, MGC_Z26)).toBe(true);
  });

  it("does not grow without bound as contracts are flattened and close", () => {
    const c = new FlattenCooldown();
    for (let i = 0; i < 50; i++) c.note(ACCT, `CON.F.US.MGC.${i}`, "watchdog");
    expect(c.size).toBe(50);

    vi.setSystemTime(new Date(Date.now() + FLATTEN_COOLDOWN_MS + 1));
    c.note(ACCT, "CON.F.US.MGC.NEW", "d2");
    expect(c.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The four real controllers, one shared instance.
// ---------------------------------------------------------------------------

function position(over: Partial<Position> = {}): Position {
  return {
    id: 1,
    accountId: ACCT,
    contractId: MGC_Z26,
    creationTimestamp: "2026-08-24T13:00:00.000Z",
    type: LONG,
    size: 2,
    averagePrice: 3100,
    ...over,
  };
}

function deployment(): Deployment {
  return {
    id: DEPLOY,
    accountId: ACCT,
    ticker: "/MGC",
    strategyKey: "test-strategy",
    status: "Active",
    groupId: null,
    paramValues: {},
  } as unknown as Deployment;
}

function contract(): Contract {
  return {
    id: MGC_Z26,
    name: MGC_Z26,
    description: "Micro Gold",
    tickSize: 0.1,
    tickValue: 1,
    activeContract: true,
    symbolId: "F.US.MGC",
  } as unknown as Contract;
}

/** The in-memory mirror the session guard and the restart sweep read before
 *  they dispatch. Neither actor is reachable without one. */
function deploymentState(): DeploymentState {
  return {
    lastBarTimestamp: null,
    cooldownAnchorAt: null,
    position: {
      side: 0,
      entryPrice: 3100,
      entryTimestamp: "2026-08-24T13:00:00.000Z",
      entryFilledAt: "2026-08-24T13:00:02.000Z",
      barsSinceEntry: 4,
      size: 2,
      slTicks: null,
    },
    activeTradeId: 91,
    breakEvenMoved: false,
    preEntryOrderIds: null,
    activeTpTicks: null,
    activeSlTicks: null,
    slMovedToBe: false,
    slCurrentPrice: null,
    tpCurrentPrice: null,
  } as unknown as DeploymentState;
}

/** When the restart sweep's obligation was taken on, and a trade-start
 *  instant on the correct side of it. */
const SEEDED_AT = Date.parse("2026-08-24T12:00:00.000Z");
const BEFORE_SEED = SEEDED_AT - 4 * 60 * 60_000;

/**
 * All four actors on one account, one contract, one cooldown.
 *
 * The watchdog's managed set is the reconcilable trade row on `MGC_Z26` —
 * D-16's rule, and what makes the position engine-opened. The session guard
 * and the restart sweep reach the same (account, contract) through the same
 * deployment's resolved contract and their own in-memory mirror, so those two
 * pairings are exactly what production looks like.
 *
 * **D-2's `reconcilableTrades` dep is deliberately left empty while the
 * watchdog's read returns a row**, which is the one place this fixture states
 * something the engine cannot: in production both seams reach the same query.
 * See the file header — D-16 made the two scopes complementary, and driving
 * each actor's own scope input is what keeps D-2 exercised against the shared
 * instance now that nothing else can stamp a key it will act on.
 */
function allFourActors() {
  const flattenCooldown = new FlattenCooldown();
  const positions: Position[] = [position()];
  const searchOpenPositions = vi.fn(async () => positions);
  const searchOpenOrders = vi.fn(async (): Promise<Order[]> => []);
  const placeOrder = vi.fn(async (_o: PlaceOrderRequest) => ({ orderId: 55 }));
  const placeExitOrder = vi.fn(async () => {});
  const sessionExit = vi.fn(async () => {});
  const restartExit = vi.fn(async () => {});
  const broker = { searchOpenPositions, searchOpenOrders, placeOrder } as unknown as Broker;
  const sessionState = deploymentState();
  const restartState = deploymentState();

  vi.mocked(listAccountsWithReconcilableTrades).mockReturnValue([]);
  // The ticker rides beside the contract: the watchdog reads its scope and
  // the symbol its Activity lines render out of the same trade row.
  vi.mocked(getReconcilableTrades).mockReturnValue([
    { contractId: MGC_Z26, deploymentId: DEPLOY, ticker: "/MGC" },
  ] as unknown as StrategyTrade[]);
  // The trading window is the playbook's `config.session` — a deployment
  // carries none, so the fixture module is where the fixture's window lives.
  vi.mocked(getStrategy).mockReturnValue({
    params: {},
    config: { session: { start: "09:30", end: "16:00", timezone: "America/New_York" } },
  } as unknown as StrategyModule);

  const watchdogDeps: NakedWatchdogDeps = {
    log: vi.fn(),
    logEvent: vi.fn(),
    realtimeDeployments: () => [deployment()],
    isLegInExitLoop: () => true,
    isAccountRegistered: () => true,
    stopCoverageSourceFor: () => "open-orders",
    brokerForAccount: () => broker,
    defaultTradovateClient: () => null,
    resolveContract: async () => contract(),
    maybeOrphanFromBrokerError: vi.fn(),
    rejectionProvesTerminal: () => false,
    brokerErrorKind: () => null,
    buildCustomTag: (prefix, id) => `${prefix}_${id}`,
    flattenCooldown,
  };

  const guardDeps: ManualPositionGuardDeps = {
    log: vi.fn(),
    logEvent: vi.fn(),
    realtimeDeployments: () => [deployment()],
    isLegEngineEnabled: () => true,
    isAccountRegistered: () => true,
    brokerForAccount: () => broker,
    resolveContract: async () => contract(),
    reconcilableTrades: () => [],
    isContractLocked: () => false,
    placeExitOrder,
    flattenCooldown,
  };

  const sessionLog = vi.fn();
  const sessionLogEvent = vi.fn();
  const sessionDeps: SessionGuardDeps = {
    log: sessionLog,
    logEvent: sessionLogEvent,
    realtimeDeployments: () => [deployment()],
    isLegInExitLoop: () => true,
    stateFor: () => sessionState,
    resolveContract: async () => contract(),
    placeExitOrder: sessionExit,
    flattenCooldown,
  };

  const restartLog = vi.fn();
  const restartLogEvent = vi.fn();
  const restartDeps: RestartGuardDeps = {
    log: restartLog,
    logEvent: restartLogEvent,
    getDeployment: () => deployment(),
    hasOpenTrade: () => true,
    openTradeStartedAt: () => BEFORE_SEED,
    stateFor: () => restartState,
    persistPending: vi.fn(),
    resolveContract: async () => contract(),
    placeExitOrder: restartExit,
    flattenCooldown,
  };

  const restart = new RestartFlattenGuard(restartDeps);
  restart.markUnmanaged([{ deploymentId: DEPLOY, seededAt: SEEDED_AT }], 4 * 60 * 60_000);

  return {
    watchdog: new NakedPositionWatchdog(watchdogDeps),
    guard: new ManualPositionGuard(guardDeps),
    session: new SessionEndGuard(sessionDeps),
    restart,
    placeOrder,
    placeExitOrder,
    sessionExit,
    restartExit,
    sessionLog,
    sessionLogEvent,
    restartLog,
    restartLogEvent,
    searchOpenOrders,
    flattenCooldown,
  };
}

describe("the watchdog and D-2 enforcement reach the same position", () => {
  it("both claim an unstopped hand position on the deployment's own front month", async () => {
    // The premise, asserted rather than assumed — if this stops being true
    // the two describes below are testing nothing.
    const a = allFourActors();
    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    const b = allFourActors();
    await b.guard.runManualPositionGuard();
    expect(b.placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("D-2 does not submit while a watchdog flatten is still unbooked", async () => {
    const a = allFourActors();
    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    await a.guard.runManualPositionGuard();
    expect(a.placeExitOrder).not.toHaveBeenCalled();
  });

  it("the watchdog does not submit while a D-2 close is still unbooked", async () => {
    const a = allFourActors();
    await a.guard.runManualPositionGuard();
    expect(a.placeExitOrder).toHaveBeenCalledTimes(1);

    // Two watchdog passes: the first banks a strike, the second would flatten.
    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS - 1));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).not.toHaveBeenCalled();
  });

  it("a D-2 submission that was refused by the latch does not free the watchdog's own stamp", async () => {
    // The reachable sequence the shared cooldown exists for, in full: the
    // watchdog flattens, D-2's pass is refused and drops *its* cooldown, and
    // the watchdog's next strike must still be suppressed.
    const a = allFourActors();
    a.placeExitOrder.mockRejectedValue(new Error("EXIT_IN_FLIGHT"));

    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    a.flattenCooldown.release(ACCT, MGC_Z26, "d2");
    // Two more passes, because the flatten deleted the strike: the first
    // would re-bank it and the second would fire. Both must be refused by the
    // stamp D-2 had no business dropping. One pass proves nothing here.
    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS / 2));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("the stamp lands before the submit, so a pass interleaving on the round-trip is suppressed", async () => {
    // The window the cooldown exists for is the round trip itself. Stamping
    // on the far side of the await leaves the other actor free for exactly
    // its duration, and nothing sequential can tell the two apart — this is
    // the only shape that can.
    const a = allFourActors();
    let bookIt: () => void = () => {};
    a.placeOrder.mockImplementation(
      () => new Promise<{ orderId: number }>((res) => { bookIt = () => res({ orderId: 55 }); }),
    );

    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    const sweep = a.watchdog.runNakedPositionWatchdog();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    await a.guard.runManualPositionGuard();
    expect(a.placeExitOrder).not.toHaveBeenCalled();

    bookIt();
    await sweep;
  });

  it("a covering stop still clears the watchdog's strike, so the cooldown is not doing that job", async () => {
    // Assert the property that matters is not being served by a weaker one:
    // the cooldown suppresses submissions, it does not stand in for coverage.
    const a = allFourActors();
    await a.watchdog.runNakedPositionWatchdog();
    a.searchOpenOrders.mockResolvedValue([
      {
        id: 900,
        accountId: ACCT,
        contractId: MGC_Z26,
        creationTimestamp: "2026-08-24T13:00:00.000Z",
        updateTimestamp: "2026-08-24T13:00:00.000Z",
        status: WORKING,
        type: 4,
        side: 1 as OrderSide,
        size: 2,
        limitPrice: null,
        stopPrice: 3050,
        filledPrice: null,
      },
    ]);
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).not.toHaveBeenCalled();
    expect(a.flattenCooldown.active(ACCT, MGC_Z26)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two actors P4 left out. Each pairing below is one of the three
// interlocks a review probe demonstrated broken on 2026-08-25 (bugs.md,
// "Four flatten actors, one cooldown between two of them").
// ---------------------------------------------------------------------------

describe("the session-end clock guard shares the cooldown", () => {
  it("reaches the same (account, contract) as the watchdog — the premise", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const a = allFourActors();

    await a.session.runSessionEndGuard();

    expect(a.sessionExit).toHaveBeenCalledTimes(1);
    expect(a.flattenCooldown.active(ACCT, MGC_Z26)).toBe(true);
  });

  it("does not submit while a watchdog flatten is still unbooked", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const a = allFourActors();

    // Two watchdog passes: the first banks a strike, the second flattens.
    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    await a.session.runSessionEndGuard();

    expect(a.sessionExit).not.toHaveBeenCalled();
  });

  it("the watchdog does not submit while a session-end exit is still unbooked", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const a = allFourActors();
    await a.session.runSessionEndGuard();
    expect(a.sessionExit).toHaveBeenCalledTimes(1);

    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS - 1));
    await a.watchdog.runNakedPositionWatchdog();

    expect(a.placeOrder).not.toHaveBeenCalled();
  });

  it("defers audibly rather than silently — a position deferred every pass is visible", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const a = allFourActors();
    a.flattenCooldown.note(ACCT, MGC_Z26, "watchdog");

    await a.session.runSessionEndGuard();

    expect(a.sessionExit).not.toHaveBeenCalled();
    expect(a.sessionLogEvent).toHaveBeenCalledWith(
      "flatten_deferred",
      DEPLOY,
      expect.stringContaining("deferring this pass"),
      expect.anything(),
    );
  });

  it("keeps the obligation across a cooldown skip — the next pass still flattens", async () => {
    // The guard is the last thing between an open position and a prop-firm
    // violation. A cooldown hit must cost it one pass, never the obligation.
    vi.setSystemTime(OUT_OF_WINDOW);
    const a = allFourActors();
    a.flattenCooldown.note(ACCT, MGC_Z26, "watchdog");

    await a.session.runSessionEndGuard();
    expect(a.sessionExit).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(Date.now() + FLATTEN_COOLDOWN_MS + 1));
    await a.session.runSessionEndGuard();

    expect(a.sessionExit).toHaveBeenCalledTimes(1);
  });
});

describe("the restart downtime sweep shares the cooldown", () => {
  it("reaches the same (account, contract) as the watchdog — the premise", async () => {
    const a = allFourActors();

    await a.restart.runRestartFlatten();

    expect(a.restartExit).toHaveBeenCalledTimes(1);
    expect(a.flattenCooldown.active(ACCT, MGC_Z26)).toBe(true);
  });

  it("does not submit while a watchdog flatten is still unbooked", async () => {
    const a = allFourActors();

    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
    await a.watchdog.runNakedPositionWatchdog();
    expect(a.placeOrder).toHaveBeenCalledTimes(1);

    await a.restart.runRestartFlatten();

    expect(a.restartExit).not.toHaveBeenCalled();
  });

  it("the watchdog does not submit while a restart downtime flatten is still unbooked", async () => {
    const a = allFourActors();
    await a.restart.runRestartFlatten();
    expect(a.restartExit).toHaveBeenCalledTimes(1);

    await a.watchdog.runNakedPositionWatchdog();
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS - 1));
    await a.watchdog.runNakedPositionWatchdog();

    expect(a.placeOrder).not.toHaveBeenCalled();
  });

  it("keeps the pending obligation across a cooldown skip — the next pass still flattens", async () => {
    // The sweep owes a *durable* flatten. Draining the entry on a cooldown
    // skip would discard it, and the pending set is the only record.
    const a = allFourActors();
    a.flattenCooldown.note(ACCT, MGC_Z26, "watchdog");

    await a.restart.runRestartFlatten();
    expect(a.restartExit).not.toHaveBeenCalled();
    expect(a.restart.pendingCount()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + FLATTEN_COOLDOWN_MS + 1));
    await a.restart.runRestartFlatten();

    expect(a.restartExit).toHaveBeenCalledTimes(1);
  });

  it("defers audibly rather than silently", async () => {
    const a = allFourActors();
    a.flattenCooldown.note(ACCT, MGC_Z26, "watchdog");

    await a.restart.runRestartFlatten();

    expect(a.restartLogEvent).toHaveBeenCalledWith(
      "flatten_deferred",
      DEPLOY,
      expect.stringContaining("deferring this pass"),
      expect.anything(),
    );
  });
});
