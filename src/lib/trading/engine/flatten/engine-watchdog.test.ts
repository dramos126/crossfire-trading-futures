/**
 * The naked-position two-strike state machine.
 *
 * This is the last-resort path: it is what stands between a position whose
 * bracket never attached and an unbounded loss, and it is the one exit in
 * the engine that deliberately bypasses the `exitInFlight` latch. Its
 * correctness is entirely in *when* it fires — one tick early and it
 * flattens a position whose bracket was still posting, one tick late (or
 * never, because a strike was pruned) and the position rides naked.
 *
 * Before D2 the machine could only be reached as `(engine as any)` with a
 * broker registry stubbed underneath it, so `engine.test.ts` covers the
 * Tradovate coverage *lookup* in depth and the machine itself with two
 * cases. These are the machine's own transitions, against the plain
 * `open-orders` coverage arm, which the extraction made reachable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// The sweep reads both of these per tick. Enumerated rather than spread:
// `db/trades` is not a leaf, and the watchdog imports exactly these two.
vi.mock("@/lib/db/trades", () => ({
  getReconcilableTrades: vi.fn(() => []),
  listAccountsWithReconcilableTrades: vi.fn(() => []),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn(() => []),
  markTerminal: vi.fn(),
}));

// The gate's own rule — held passes, a loss is said once — is pinned in
// `db/lease.test.ts`; here it is a switch, held unless a test drops it.
const lease = vi.hoisted(() => ({ held: true, refusedAt: [] as string[] }));
vi.mock("@/lib/db/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/lease")>()),
  leaseGate: (door: string) => () => {
    if (lease.held) return true;
    lease.refusedAt.push(door);
    return false;
  },
}));

import type { Broker } from "../../broker-access/broker";
import type { BrokerCapabilities, BrokerErrorKind } from "@/lib/brokers/plugin";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import type { Contract, Order, OrderSide, OrderStatus, OrderType, PlaceOrderRequest, Position, PositionType } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import { EVENTS, type Severity } from "@/lib/logging/vocabulary";
import { getReconcilableTrades, listAccountsWithReconcilableTrades } from "@/lib/db/trades";
import { findActiveOrderMappingsByAccount, markTerminal, type OrderMapping } from "@/lib/db/tradovate-order-map";
import {
  NakedPositionWatchdog,
  NAKED_POSITION_WATCHDOG_INTERVAL_MS,
  type NakedWatchdogDeps,
} from "./engine-watchdog";
import { FlattenCooldown } from "../engine-flatten-cooldown";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";
import { freshOrders, freshPositions, resetAccountViewForTests } from "../realtime/account-view";
import { toOrder } from "@/lib/brokers/topstep/event-translation";
import type { GatewayUserOrder } from "@/lib/brokers/topstep/signalr";
// The shipped predicate and the real rejection envelope, standing in for what
// the engine wires: `pluginOwningError(err)?.rejectionProvesTerminal`, which
// the Tradovate plugin implements by delegating to this same function. A
// hand-rolled stub here would let the call site pass against a predicate that
// no longer ships. `errors.ts` is a leaf of plain classes and one predicate —
// nothing in its graph reaches the strategy loader.
import {
  TradovateOrderRejectionError,
  isAlreadyTerminalCancelRejection,
} from "@/lib/brokers/tradovate/errors";
// The real Topstep classification, for the one A37 test that must not lean on
// a stub: `ownsError` then `classifyError`, which is what the engine's
// `pluginOwningError(err)?.classifyError(err)` binding runs.
import { TopstepBrokerPlugin } from "@/lib/brokers/topstep";
import { TopstepOrderRejectionError } from "@/lib/brokers/topstep/client";

const ACCT = 4242;
const CONTRACT = "CON.F.US.MNQ.M26";
const DEPLOY = "deploy-aaa";

const LONG: PositionType = 1;
const SHORT: PositionType = 2;
const BUY: OrderSide = 0;
const SELL: OrderSide = 1;
const STOP_MARKET: OrderType = 4;
const LIMIT: OrderType = 1;
const WORKING: OrderStatus = 1;
const FILLED: OrderStatus = 2;

function position(over: Partial<Position> = {}): Position {
  return {
    id: 1,
    accountId: ACCT,
    contractId: CONTRACT,
    creationTimestamp: "2026-08-23T14:30:00.000Z",
    type: LONG,
    size: 2,
    averagePrice: 21000,
    ...over,
  };
}

function stopOrder(over: Partial<Order> = {}): Order {
  return {
    id: 900,
    accountId: ACCT,
    contractId: CONTRACT,
    creationTimestamp: "2026-08-23T14:30:00.000Z",
    updateTimestamp: "2026-08-23T14:30:00.000Z",
    status: WORKING,
    type: STOP_MARKET,
    side: SELL,
    size: 2,
    limitPrice: null,
    stopPrice: 20950,
    filledPrice: null,
    ...over,
  };
}

interface WatchdogOptions {
  flattenCooldown?: FlattenCooldown;
  coverageSource?: BrokerCapabilities["stopCoverageSource"];
  /** Deployments the sweep sees. Empty by default: under D-16 a deployment
   *  puts nothing in scope, so only the scope tests supply any. */
  deployments?: Deployment[];
  /** Reconcilable trade rows for `ACCT`. One open row on `CONTRACT` by
   *  default — that row is what makes the position engine-opened. */
  trades?: Array<{ contractId: string; deploymentId: string; ticker: string }> | null;
  /** The plugin seam the post-flatten cancel asks whether a rejection proves
   *  the leg terminal. Defaults to the shipped predicate, which is what the
   *  Tradovate plugin delegates to. */
  rejectionProvesTerminal?: (err: unknown) => boolean;
  /** The plugin seam that classifies a failed flatten. Defaults to null — no
   *  plugin claims the error — which is what a timeout or a Topstep plain
   *  `Error` answers. */
  brokerErrorKind?: (err: unknown) => BrokerErrorKind | null;
  /** The first coverage-source lookup throws, as a plugin-registry miss does. */
  coverageSourceThrowsOnce?: boolean;
}

function deployment(over: Partial<Deployment> = {}): Deployment {
  return { id: DEPLOY, accountId: ACCT, ticker: "/MNQ", ...over } as unknown as Deployment;
}

/**
 * Messages the sweep logged at a given severity.
 *
 * Every watchdog line names a vocabulary event, so severity is the
 * registry's answer and not an argument — the lookup goes through `EVENTS`
 * rather than restating the mapping here, which is what makes an event
 * whose severity is changed by hand fail this file rather than pass it.
 */
function messagesAt(logEvent: ReturnType<typeof vi.fn>, severity: Severity): string[] {
  return logEvent.mock.calls
    .filter((c) => EVENTS[String(c[0])]?.severity === severity)
    .map((c) => String(c[2]));
}

function contract(id = CONTRACT): Contract {
  return {
    id,
    name: id,
    description: id,
    tickSize: 0.25,
    tickValue: 0.5,
    activeContract: true,
    symbolId: "F.US.MNQ",
  };
}

/**
 * A watchdog wired to the `open-orders` coverage arm with one managed
 * contract, supplied through the reconcilable-trades union so no deployment
 * or contract resolution is involved.
 */
function makeWatchdog(opts: WatchdogOptions = {}) {
  const flattenCooldown = opts.flattenCooldown ?? new FlattenCooldown();
  const searchOpenPositions = vi.fn<(accountId: number) => Promise<Position[]>>().mockResolvedValue([]);
  const searchOpenOrders = vi.fn<() => Promise<Order[]>>().mockResolvedValue([]);
  const placeOrder = vi.fn<(o: PlaceOrderRequest) => Promise<{ orderId: number }>>().mockResolvedValue({ orderId: 55 });
  const cancelOrder = vi.fn<(orderId: number, accountId: number) => Promise<void>>().mockResolvedValue(undefined);
  const getOrder = vi.fn<(orderId: number, accountId: number) => Promise<{ ordStatus: string } | null>>()
    .mockResolvedValue({ ordStatus: "Working" });
  const log = vi.fn();
  const logEvent = vi.fn();
  const maybeOrphanFromBrokerError = vi.fn();

  const broker = { searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder } as unknown as Broker;
  const deployments = opts.deployments ?? [];
  let coverageSourceThrows = opts.coverageSourceThrowsOnce ?? false;

  const deps: NakedWatchdogDeps = {
    log,
    logEvent,
    realtimeDeployments: () => deployments,
    isLegInExitLoop: () => true,
    isAccountRegistered: () => true,
    stopCoverageSourceFor: () => {
      if (coverageSourceThrows) {
        coverageSourceThrows = false;
        throw new Error("no plugin registry entry");
      }
      return opts.coverageSource ?? "open-orders";
    },
    brokerForAccount: () => broker,
    defaultTradovateClient: () => ({ getOrder } as unknown as TradovateClient),
    resolveContract: (ticker) => Promise.resolve(contract(ticker === "/MNQ" ? CONTRACT : `CON.F.US.${ticker.slice(1)}.M26`)),
    maybeOrphanFromBrokerError,
    rejectionProvesTerminal: opts.rejectionProvesTerminal ?? isAlreadyTerminalCancelRejection,
    brokerErrorKind: opts.brokerErrorKind ?? (() => null),
    buildCustomTag: (prefix, id) => `${prefix}_${id}`,
    flattenCooldown,
  };

  vi.mocked(listAccountsWithReconcilableTrades).mockReturnValue([ACCT]);
  vi.mocked(getReconcilableTrades).mockReturnValue(
    (opts.trades === undefined ? [{ contractId: CONTRACT, deploymentId: DEPLOY, ticker: "/MNQ" }] : opts.trades ?? []) as unknown as ReturnType<typeof getReconcilableTrades>,
  );

  return {
    watchdog: new NakedPositionWatchdog(deps),
    searchOpenPositions,
    searchOpenOrders,
    placeOrder,
    cancelOrder,
    getOrder,
    log,
    logEvent,
    maybeOrphanFromBrokerError,
    flattenCooldown,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountViewForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-23T14:30:00.000Z"));
  lease.held = true;
  lease.refusedAt = [];
});

afterEach(() => {
  vi.useRealTimers();
});

/** One watchdog interval of wall clock, the way the live interval spaces ticks. */
function advanceOneInterval(): void {
  vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS));
}

describe("without the engine lease", () => {
  // The sweep survives `stop()`, so a lost lease does not disarm it; another
  // process runs the engine and its own watchdog owns the position.
  it("flattens nothing on the second strike and asks at its own door", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    await watchdog.runNakedPositionWatchdog();
    lease.held = false;
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
    expect(lease.refusedAt).toEqual(["the naked-position watchdog"]);
  });
});

describe("two-strike threshold", () => {
  it("does not flatten on the first naked observation", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("flattens on the second consecutive naked observation", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0]).toMatchObject({
      accountId: ACCT,
      contractId: CONTRACT,
      type: 2,
      side: SELL,
      size: 2,
    });
  });

  it("closes a short with a Buy", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ type: SHORT, size: 3 })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder.mock.calls[0][0]).toMatchObject({ side: BUY, size: 3 });
  });

  it("a covering stop between the two ticks clears the strike, so the count restarts", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();

    searchOpenOrders.mockResolvedValue([stopOrder()]);
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    searchOpenOrders.mockResolvedValue([]);
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("a position that vanishes between ticks is pruned, so its reappearance restarts the count", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    await watchdog.runNakedPositionWatchdog();

    searchOpenPositions.mockResolvedValue([]);
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    searchOpenPositions.mockResolvedValue([position()]);
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("reset() drops the accumulated strike", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    watchdog.reset();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });
});

/**
 * "The watchdog sweep has no re-entrancy guard" (bugs.md). A pass that
 * outruns the interval — N accounts, or the order-map arm's serial
 * `/order/item` loop — must not start a second concurrently against the same
 * two-strike memory. Must not regress: a pass that has finished frees the
 * next one, which still flattens on its second strike (the two-strike tests
 * above).
 */
describe("re-entrancy", () => {
  it("a tick landing while a pass is still in flight joins it rather than starting a second sweep", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();

    let releasePlace!: (v: { orderId: number }) => void;
    placeOrder.mockImplementation(() => new Promise((r) => { releasePlace = r; }));
    const first = watchdog.runNakedPositionWatchdog();
    await vi.waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));

    const second = watchdog.runNakedPositionWatchdog();
    releasePlace({ orderId: 55 });
    await Promise.all([first, second]);

    expect(searchOpenPositions).toHaveBeenCalledTimes(2);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  // The coverage-source lookup runs outside the per-account guard, so a pass
  // can reject; the guard must not stay held after it.
  it("a pass that threw frees the next one", async () => {
    const { watchdog, searchOpenPositions } = makeWatchdog({ coverageSourceThrowsOnce: true });

    await expect(watchdog.runNakedPositionWatchdog()).rejects.toThrow("plugin registry");
    await watchdog.runNakedPositionWatchdog();

    expect(searchOpenPositions).toHaveBeenCalledTimes(1);
  });
});

describe("the account view", () => {
  it("writes its positions and orders read into the view, and still reads the broker live on every pass", async () => {
    // The flatten decision acts, so a fresh view must never stand in for the
    // two-strike read (engine.md, post-entry money paths read live).
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    expect(freshPositions(ACCT)?.items).toEqual([position()]);
    expect(freshPositions(ACCT)?.source).toBe("sweep");
    expect(freshOrders(ACCT)?.items).toEqual([]);

    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(searchOpenPositions).toHaveBeenCalledTimes(2);
    // One per pass, plus the post-flatten cancel's own fresh read.
    expect(searchOpenOrders).toHaveBeenCalledTimes(3);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
});

describe("what counts as coverage", () => {
  it("a full-size Stop Market on the closing side is coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    searchOpenOrders.mockResolvedValue([stopOrder()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("partial coverage still counts as naked", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue([stopOrder({ size: 1 })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].size).toBe(2);
  });

  it("two partial stops sum to full coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue([stopOrder({ id: 1, size: 1 }), stopOrder({ id: 2, size: 1 })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("a stop on the entry side is not coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    searchOpenOrders.mockResolvedValue([stopOrder({ side: BUY })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("a take-profit limit is not coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    searchOpenOrders.mockResolvedValue([stopOrder({ type: LIMIT, limitPrice: 21100, stopPrice: null })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("a filled stop is not coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    searchOpenOrders.mockResolvedValue([stopOrder({ status: FILLED })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  /**
   * "The naked-position watchdog can flatten a stop-protected Tradovate
   * position" (bugs.md). Tradovate documents `Unknown` as a live,
   * cancellable status; the watchdog's own copy of the set omitted it, so a
   * transient `Unknown` stamped the SL terminal, hid it from every later
   * coverage read, and the position was flattened with its stop still live.
   * Must not regress: a genuinely terminal status (`Filled`) is still stamped
   * and still reads as no coverage — pinned below.
   */
  it("an order-map SL reporting ordStatus Unknown is still coverage and is not stamped terminal", async () => {
    const { watchdog, searchOpenPositions, getOrder, placeOrder } = makeWatchdog({ coverageSource: "order-map" });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 77, deploymentId: DEPLOY, role: "sl", accountId: ACCT, placedAt: Date.now(), terminalAt: null, qty: 2 },
    ]);
    getOrder.mockResolvedValue({ ordStatus: "Unknown" });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
  });

  /**
   * Review of the fix above, finding 4: `Unknown` counted as coverage with
   * no limit, so a stop Tradovate leaves in `Unknown` (lost at the gateway)
   * kept a naked position open forever. It counts for two consecutive passes,
   * then the position is naked — still without stamping the stop terminal.
   */
  it("an SL stuck in Unknown stops counting as coverage after two passes, and is never stamped terminal", async () => {
    const { watchdog, searchOpenPositions, getOrder, placeOrder, logEvent } = makeWatchdog({ coverageSource: "order-map" });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    vi.mocked(findActiveOrderMappingsByAccount).mockImplementation((_a, role) =>
      Array.isArray(role) ? [] : [{ orderId: 77, deploymentId: DEPLOY, role: "sl", accountId: ACCT, placedAt: Date.now(), terminalAt: null, qty: 2 }],
    );
    getOrder.mockResolvedValue({ ordStatus: "Unknown" });

    for (let pass = 0; pass < 3; pass++) {
      await watchdog.runNakedPositionWatchdog();
      advanceOneInterval();
    }
    // Passes 1–2 covered; pass 3 is the first strike.
    expect(placeOrder).not.toHaveBeenCalled();
    expect(messagesAt(logEvent, "warn").filter((m) => m.includes("stop #77") && m.includes("Unknown"))).toHaveLength(1);

    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
    expect(messagesAt(logEvent, "warn").filter((m) => m.includes("stop #77") && m.includes("Unknown"))).toHaveLength(1);
  });

  it("a live read between Unknowns restarts the count", async () => {
    const { watchdog, searchOpenPositions, getOrder, placeOrder } = makeWatchdog({ coverageSource: "order-map" });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    vi.mocked(findActiveOrderMappingsByAccount).mockReturnValue([
      { orderId: 77, deploymentId: DEPLOY, role: "sl", accountId: ACCT, placedAt: Date.now(), terminalAt: null, qty: 2 },
    ]);
    for (const status of ["Unknown", "Unknown", "Working", "Unknown", "Unknown"]) {
      getOrder.mockResolvedValueOnce({ ordStatus: status });
      await watchdog.runNakedPositionWatchdog();
      advanceOneInterval();
    }

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("an order-map SL reporting a terminal ordStatus is stamped terminal and is not coverage", async () => {
    const { watchdog, searchOpenPositions, getOrder, placeOrder } = makeWatchdog({ coverageSource: "order-map" });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    vi.mocked(findActiveOrderMappingsByAccount).mockImplementation((_a, role) =>
      Array.isArray(role) ? [] : [{ orderId: 77, deploymentId: DEPLOY, role: "sl", accountId: ACCT, placedAt: Date.now(), terminalAt: null, qty: 2 }],
    );
    getOrder.mockResolvedValue({ ordStatus: "Filled" });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(vi.mocked(markTerminal)).toHaveBeenCalledWith(77);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("a stop on another contract is not coverage", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    searchOpenOrders.mockResolvedValue([stopOrder({ contractId: "CON.F.US.MGC.Z26" })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
});

/**
 * A89. Topstep's wire statuses reach the `open-orders` arm through the
 * translator, so these feed the sweep `toOrder`'s output rather than a
 * neutral literal: a mapping regression fails here, at the decision it moves.
 * ProjectX: Open 1, Expired 4, Rejected 5, Pending 6.
 */
describe("Topstep wire statuses on the open-orders arm", () => {
  const STOP_ID = 900;

  function wireStop(status: number): Order {
    const frame: GatewayUserOrder = {
      id: STOP_ID,
      accountId: ACCT,
      contractId: CONTRACT,
      symbolId: "F.US.MNQ",
      creationTimestamp: "2026-08-23T14:30:00.000Z",
      updateTimestamp: "2026-08-23T14:30:00.000Z",
      status,
      type: STOP_MARKET,
      side: SELL,
      size: 2,
      limitPrice: null,
      stopPrice: 20950,
      fillVolume: 0,
      filledPrice: null,
      customTag: null,
    };
    return toOrder(frame);
  }

  function pendingMessages(logEvent: ReturnType<typeof vi.fn>): string[] {
    return messagesAt(logEvent, "warn").filter((m) => m.includes(`stop #${STOP_ID}`) && m.includes("Pending"));
  }

  it.each([
    [5, "Rejected"],
    [4, "Expired"],
  ])("a wire %d (%s) stop is not cover: the position is flattened on the second strike", async (wire) => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue([wireStop(wire)]);

    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).not.toHaveBeenCalled();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("a wire Open (1) stop is cover with no bound", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, logEvent } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue([wireStop(1)]);

    for (let pass = 0; pass < 6; pass++) {
      await watchdog.runNakedPositionWatchdog();
      advanceOneInterval();
    }

    expect(placeOrder).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a wire Pending (6) stop is cover for two passes, then the position is flattened, said once", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder, logEvent } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue([wireStop(6)]);

    for (let pass = 0; pass < 3; pass++) {
      await watchdog.runNakedPositionWatchdog();
      advanceOneInterval();
    }
    // Passes 1–2 covered; pass 3 is the first strike.
    expect(placeOrder).not.toHaveBeenCalled();
    expect(pendingMessages(logEvent)).toHaveLength(1);

    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    // The stuck leg rests on the closing side, so the post-flatten cancel
    // takes it — Pending is live on the cancel side, unbounded.
    expect(cancelOrder).toHaveBeenCalledWith(STOP_ID, ACCT);
    expect(pendingMessages(logEvent)).toHaveLength(1);
  });

  // The cancel side reads `isLiveProtectiveLeg`, a separate predicate from
  // the coverage sum above: Open and Pending legs go, Rejected and Expired
  // ones are not resting and are left alone.
  it("the post-flatten cancel takes wire Open and Pending legs, never Rejected or Expired", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    placeOrder.mockImplementation(async () => {
      searchOpenOrders.mockResolvedValue([1, 4, 5, 6].map((wire) => ({ ...wireStop(wire), id: 2000 + wire })));
      return { orderId: 55 };
    });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(cancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([2001, 2006]);
  });

  it("a Working read between Pendings restarts the count", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    for (const wire of [6, 6, 1, 6, 6]) {
      searchOpenOrders.mockResolvedValueOnce([wireStop(wire)]);
      await watchdog.runNakedPositionWatchdog();
      advanceOneInterval();
    }

    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("scope", () => {
  it("ignores a naked position on a contract the engine does not manage", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ contractId: "CON.F.US.MGC.Z26" })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  /**
   * D-16. A deployment existing is not a claim over a position. The scope
   * union used to carry every exit-loop deployment's resolved contract, so a
   * hand-opened position on a deployed instrument was inspected, read as
   * naked, and force-closed — three times on the soak, including once with a
   * correctly bracketed Tradovate leg. `isLegInExitLoop` carries no
   * session-window check, so out-of-hours made no difference. A hand position
   * has exactly one engine actor and it is D-2.
   */
  it("a hand-opened position on a deployed contract is out of scope — no trade row, no sweep (D-16)", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog({
      deployments: [deployment()],
      trades: [],
    });
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("an engine-opened position on that same deployed contract is still in scope", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog({
      deployments: [deployment()],
      trades: [{ contractId: CONTRACT, deploymentId: DEPLOY, ticker: "/MNQ" }],
    });
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("a broker lookup failure skips the account without accumulating a strike", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockRejectedValue(new Error("504 from gateway"));

    await watchdog.runNakedPositionWatchdog();

    searchOpenPositions.mockResolvedValue([position()]);
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("post-flatten cooldown", () => {
  it("does not re-flatten while the cooldown is open", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);

    // A tick landing inside the interval — the market order may still be
    // in flight, so the position still reads naked.
    vi.setSystemTime(new Date(Date.now() + NAKED_POSITION_WATCHDOG_INTERVAL_MS - 1));
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the cooldown, and needs two fresh strikes to fire again", async () => {
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);

    // The flatten cleared the strike, so the first tick past the cooldown
    // only re-observes.
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);

    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  /**
   * A timeout may be an order the broker accepted and never answered for, so
   * a second market order now could double it. The stamp holds and the strike
   * clears exactly as on an accepted flatten: recovery takes the cooldown
   * plus two strikes (A37).
   */
  it("A37 — an unconfirmed flatten (a timeout) holds the cooldown and clears the strike", async () => {
    const { watchdog, searchOpenPositions, placeOrder, maybeOrphanFromBrokerError } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    placeOrder.mockRejectedValue(new Error("request timed out"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(maybeOrphanFromBrokerError).toHaveBeenCalledTimes(1);

    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);

    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  it("A37 — the unconfirmed line states the real retry delay, not the next tick", async () => {
    const { watchdog, searchOpenPositions, placeOrder, logEvent } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    placeOrder.mockRejectedValue(new Error("request timed out"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const line = logEvent.mock.calls.find((c) => c[0] === "naked_position_flatten_rejected")?.[2] as string;
    expect(line).toContain("POSITION REMAINS UNPROTECTED");
    expect(line).not.toContain("next watchdog tick");
    expect(line).toContain("60–90s");
  });

  /**
   * A refusal is the broker's own answer: no order is on the book, so the
   * stamp guards nothing. Released, with the strike kept, the next tick
   * flattens again instead of waiting 60–90 s with the position naked (A37).
   */
  it("A37 — a broker refusal releases the stamp and keeps the strike, so the next tick retries", async () => {
    const refusal = new TradovateOrderRejectionError("order/placeorder", ACCT, "RiskExceeded", null);
    const { watchdog, searchOpenPositions, placeOrder, cancelOrder, logEvent, flattenCooldown } = makeWatchdog({
      brokerErrorKind: (err) => (err === refusal ? "order_rejected" : null),
    });
    searchOpenPositions.mockResolvedValue([position()]);
    placeOrder.mockRejectedValue(refusal);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(flattenCooldown.active(ACCT, CONTRACT)).toBe(false);
    const line = logEvent.mock.calls.find((c) => c[0] === "naked_position_flatten_rejected")?.[2] as string;
    expect(line).toContain("retries in 30s");

    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  /**
   * Through the shipped classification rather than a stub (A37, A120): a
   * Topstep code-5 refusal is owned and classified `order_rejected`, so the
   * stamp is released; a plain timeout `Error` is owned by no plugin, so it
   * holds.
   */
  it("A37 — through the Topstep plugin: a code-5 refusal releases the stamp, a timeout holds it", async () => {
    const topstep = new TopstepBrokerPlugin();
    const brokerErrorKind = (err: unknown): BrokerErrorKind | null =>
      topstep.ownsError(err) ? topstep.classifyError(err) : null;

    const refused = makeWatchdog({ brokerErrorKind });
    refused.searchOpenPositions.mockResolvedValue([position()]);
    refused.placeOrder.mockRejectedValue(new TopstepOrderRejectionError(ACCT, 5, "Outside of trading hours"));
    await refused.watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await refused.watchdog.runNakedPositionWatchdog();
    expect(refused.placeOrder).toHaveBeenCalledTimes(1);
    expect(refused.flattenCooldown.active(ACCT, CONTRACT)).toBe(false);

    const timedOut = makeWatchdog({ brokerErrorKind });
    timedOut.searchOpenPositions.mockResolvedValue([position()]);
    timedOut.placeOrder.mockRejectedValue(new Error("request timed out"));
    await timedOut.watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await timedOut.watchdog.runNakedPositionWatchdog();
    expect(timedOut.placeOrder).toHaveBeenCalledTimes(1);
    expect(timedOut.flattenCooldown.active(ACCT, CONTRACT)).toBe(true);
  });

  it("A37 — a refusal does not release a stamp another flatten actor holds", async () => {
    const refusal = new TradovateOrderRejectionError("order/placeorder", ACCT, "RiskExceeded", null);
    const { watchdog, searchOpenPositions, placeOrder, flattenCooldown } = makeWatchdog({
      brokerErrorKind: () => "order_rejected",
    });
    searchOpenPositions.mockResolvedValue([position()]);
    // Another actor's stamp on the contract by the time the refusal lands.
    // The release is the watchdog's own, so it must leave this one alone.
    placeOrder.mockImplementation(async () => {
      flattenCooldown.note(ACCT, CONTRACT, "d2");
      throw refusal;
    });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(flattenCooldown.stampedBy(ACCT, CONTRACT)?.by).toBe("d2");
  });
});

/**
 * The flatten submits a closing market order and used to leave the OSO's SL
 * and TP resting. Both legs sit on the *closing* side, so against a flat
 * account either one filling **opens** an unbracketed reverse position —
 * observed 2026-05-14 and reproduced 2026-08-26 (two buy orders, five lots
 * each, no position behind them).
 */
describe("orphaned brackets after the flatten", () => {
  const SL_ID = 1291;
  const TP_ID = 1293;

  function mapping(over: Partial<OrderMapping> = {}): OrderMapping {
    return {
      orderId: SL_ID,
      deploymentId: DEPLOY,
      role: "sl",
      accountId: ACCT,
      placedAt: Date.now(),
      terminalAt: null,
      qty: 1,
      ...over,
    };
  }

  /** The case the watchdog exists for and D-16 does not remove: an engine
   *  position whose bracket placement partially failed. The SL covers 1 of
   *  2 lots, so the position reads naked; the TP is fully live. */
  function makeOrderMapWatchdog(opts: Omit<WatchdogOptions, "coverageSource"> = {}) {
    const wired = makeWatchdog({ ...opts, coverageSource: "order-map" });
    vi.mocked(findActiveOrderMappingsByAccount).mockImplementation((_accountId, role) =>
      Array.isArray(role) ? [mapping(), mapping({ orderId: TP_ID, role: "tp", qty: 2 })] : [mapping()],
    );
    return wired;
  }

  it("cancels the mapped SL and TP and marks them terminal", async () => {
    const { watchdog, searchOpenPositions, placeOrder, cancelOrder } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([SL_ID, TP_ID]);
    expect(vi.mocked(markTerminal).mock.calls.map((c) => c[0]).sort()).toEqual([SL_ID, TP_ID]);
  });

  /**
   * The rendered symbol, on every line this sweep emits that has a
   * `{ticker}` template. These are engine-scoped — no deployment, so no
   * `display` for the Activity lane to read a ticker out of — and without
   * the column every one of them falls back to its `[SAFETY]` diagnostics
   * prose. The symbol comes off the trade row that scopes the sweep, not
   * off the contract id.
   */
  it("names the rendered symbol on every line whose template asks for one", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(new Error("gateway said no"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const tickerLines = logEvent.mock.calls.filter((c) =>
      EVENTS[String(c[0])]?.template?.includes("{ticker}"),
    );
    // The sweep observed, flattened, submitted, and failed to cancel two
    // orphaned legs — five templated lines, none of which could render
    // before this.
    expect(tickerLines.length).toBeGreaterThanOrEqual(4);
    for (const call of tickerLines) {
      expect((call[3] as { ticker?: unknown }).ticker, String(call[0])).toBe("MNQ");
    }
  });

  /** The ordering decision, pinned. D-2's equivalent path cancels first; this
   *  one does not, because the flatten is the urgent safety action and a
   *  cancel round-trip in front of it both delays it and can strip the
   *  partial stop off a position whose flatten then fails. */
  it("cancels after the close, never before it", async () => {
    const { watchdog, searchOpenPositions, placeOrder, cancelOrder } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    const seq: string[] = [];
    placeOrder.mockImplementation(async () => {
      seq.push("flatten");
      return { orderId: 55 };
    });
    cancelOrder.mockImplementation(async (orderId) => {
      seq.push(`cancel:${orderId}`);
    });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(seq[0]).toBe("flatten");
    expect(seq).toHaveLength(3);
  });

  it("a rejected flatten leaves the brackets alone — the position is still open and they are its only cover", async () => {
    const { watchdog, searchOpenPositions, placeOrder, cancelOrder } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    placeOrder.mockRejectedValue(new Error("account is locked"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
  });

  /**
   * A `tp` row whose terminal frame was missed stays `terminal_at IS NULL`
   * forever — `sumAliveTradovateSlCoverage` reads role `"sl"` only, so nothing
   * heals it. Before the terminal arm, every future flatten on this deployment
   * re-cancelled it, got the same rejection, and logged "it may still be
   * resting … Cancel it by hand" at `error`. An already-terminal rejection is
   * *proof* the armed-reverse state does not exist.
   */
  it("stamps an already-terminal leg terminal and reports it at warn, not error", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent, maybeOrphanFromBrokerError } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(
      new TradovateOrderRejectionError("/order/cancelOrder", ACCT, "OrderNotFound", null),
    );

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes("Cancel it by hand"))).toBe(false);
    const warns = messagesAt(logEvent, "warn");
    expect(warns.some((m) => m.includes(`#${SL_ID}`))).toBe(true);
    expect(warns.some((m) => m.includes(`#${TP_ID}`))).toBe(true);
    expect(vi.mocked(markTerminal).mock.calls.map((c) => c[0]).sort()).toEqual([SL_ID, TP_ID]);
    expect(maybeOrphanFromBrokerError).not.toHaveBeenCalled();
  });

  /**
   * The question is *what this broker's rejection means*, and it is asked
   * through the plugin, never by `instanceof` on a broker class the engine
   * imported — see brokers/README.md, "The engine asks the plugin what a
   * broker does". Driven with an error the shipped predicate would refuse, so
   * a call site that quietly went back to matching the envelope itself fails
   * here rather than passing on the fixture's coincidence.
   */
  it("takes the quiet arm on whatever the plugin says is terminal, not on a class it recognises", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent } = makeOrderMapWatchdog({
      rejectionProvesTerminal: () => true,
    });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(new Error("some other broker says the leg is gone"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes("Cancel it by hand"))).toBe(false);
    expect(vi.mocked(markTerminal).mock.calls.map((c) => c[0]).sort()).toEqual([SL_ID, TP_ID]);
  });

  // A broker that declares nothing answers false, and false is the loud arm.
  it("stays loud when no plugin claims the rejection", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent } = makeOrderMapWatchdog({
      rejectionProvesTerminal: () => false,
    });
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(
      new TradovateOrderRejectionError("/order/cancelOrder", ACCT, "OrderNotFound", null),
    );

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes("Cancel it by hand"))).toBe(true);
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
  });

  // The unknown case has to stay loud, and "account not found" must not be
  // read as "the order is gone" — the leg may very much still be resting.
  it("keeps an account-scoped failure on the loud arm", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(new Error("Account not found"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes("Cancel it by hand"))).toBe(true);
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
  });

  it("a failed cancel is reported at error and the row is not marked terminal", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent, maybeOrphanFromBrokerError } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(new Error("Tradovate /order/cancelOrder: gateway timeout"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await expect(watchdog.runNakedPositionWatchdog()).resolves.toBeUndefined();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes(`#${SL_ID}`) && m.includes("gateway timeout"))).toBe(true);
    expect(errors.some((m) => m.includes(`#${TP_ID}`) && m.includes("gateway timeout"))).toBe(true);
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
    expect(maybeOrphanFromBrokerError).toHaveBeenCalled();
  });

  /**
   * A46, at the call site rather than on the predicate. A transport 404 carries
   * `Not Found` — the commonest HTTP reason phrase on the wire — and the stamp
   * it used to earn is permanent: `findActiveOrderMappingsByAccount` filters
   * `terminal_at`, and nothing else heals a `tp` row. So the cost of reading
   * this one wrong is a stop resting on the closing side that the engine can
   * never see again, announced as "nothing is resting".
   */
  it("keeps a transport 404 on the loud arm and leaves the rows alive", async () => {
    const { watchdog, searchOpenPositions, cancelOrder, logEvent, maybeOrphanFromBrokerError } = makeOrderMapWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    cancelOrder.mockRejectedValue(new Error("Tradovate API error 404 on /order/cancelOrder: Not Found"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    const errors = messagesAt(logEvent, "error");
    expect(errors.some((m) => m.includes(`#${SL_ID}`) && m.includes("Cancel it by hand"))).toBe(true);
    expect(errors.some((m) => m.includes(`#${TP_ID}`) && m.includes("Cancel it by hand"))).toBe(true);
    expect(vi.mocked(markTerminal)).not.toHaveBeenCalled();
    expect(maybeOrphanFromBrokerError).toHaveBeenCalled();
  });
});

/**
 * "The same watchdog flatten orphans brackets on Topstep too" (bugs.md). The
 * `open-orders` arm cancelled nothing after its flatten, and Topstep's legs do
 * not cancel when the position goes flat: a TP left live on the closing side
 * opens an unbracketed reverse when touched. The rule: after an accepted
 * flatten, re-read the book and cancel every live (Working or Pending) stop or
 * limit on the closing side of that contract, except the flatten itself.
 */
describe("orphaned legs after the flatten, open-orders arm", () => {
  const FLATTEN_ID = 55;
  const TP_ID = 1401;
  const PARTIAL_SL_ID = 1402;

  /** Long 2, a 1-lot SL (naked) and a live 2-lot TP — the partial attach. */
  function partialBracket(): Order[] {
    return [
      stopOrder({ id: PARTIAL_SL_ID, size: 1 }),
      stopOrder({ id: TP_ID, type: LIMIT, size: 2, stopPrice: null, limitPrice: 21100 }),
    ];
  }

  it("cancels the closing-side legs from a fresh read after the close, and leaves the rest", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue(partialBracket());
    const seq: string[] = [];
    placeOrder.mockImplementation(async () => {
      seq.push("flatten");
      // A leg that went on after the sweep's own read, and the flatten
      // itself, both on the book by the time the cancel looks.
      searchOpenOrders.mockImplementation(async () => {
        seq.push("read");
        return [
          ...partialBracket(),
          stopOrder({ id: 1403, size: 1, status: 5 }),
          stopOrder({ id: FLATTEN_ID, type: 2, size: 2, stopPrice: null }),
          stopOrder({ id: 1404, side: BUY, type: LIMIT, stopPrice: null, limitPrice: 20900 }),
          stopOrder({ id: 1405, contractId: "CON.F.US.MGC.Z26" }),
          stopOrder({ id: 1406, status: FILLED }),
        ];
      });
      return { orderId: FLATTEN_ID };
    });
    cancelOrder.mockImplementation(async () => {
      seq.push("cancel");
    });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([TP_ID, PARTIAL_SL_ID, 1403]);
    expect(seq.slice(0, 2)).toEqual(["flatten", "read"]);
  });

  it("takes the side from the flattened position: a short's legs are buys", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, cancelOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ type: SHORT, size: 1 })]);
    searchOpenOrders.mockResolvedValue([
      stopOrder({ id: 1501, side: BUY, type: LIMIT, size: 1, stopPrice: null, limitPrice: 20900 }),
      stopOrder({ id: 1502, side: SELL, type: LIMIT, size: 1, stopPrice: null, limitPrice: 21100 }),
    ]);

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(cancelOrder.mock.calls.map((c) => c[0])).toEqual([1501]);
  });

  it("cancels nothing when the flatten is rejected", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue(partialBracket());
    placeOrder.mockRejectedValue(new Error("rejected"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("a failed read after the close is reported at error", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, placeOrder, cancelOrder, logEvent } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue(partialBracket());
    placeOrder.mockImplementation(async () => {
      searchOpenOrders.mockRejectedValue(new Error("gateway timeout"));
      return { orderId: FLATTEN_ID };
    });

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(messagesAt(logEvent, "error").some((m) => m.includes("order lookup failed"))).toBe(true);
  });

  it("a failed cancel is reported at error", async () => {
    const { watchdog, searchOpenPositions, searchOpenOrders, cancelOrder, logEvent, maybeOrphanFromBrokerError } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position({ size: 2 })]);
    searchOpenOrders.mockResolvedValue(partialBracket());
    cancelOrder.mockRejectedValue(new Error("gateway said no"));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    await watchdog.runNakedPositionWatchdog();

    expect(messagesAt(logEvent, "error").filter((m) => m.includes("FAILED"))).toHaveLength(2);
    expect(maybeOrphanFromBrokerError).toHaveBeenCalled();
  });
});


describe("a SIGTERM's exit waits for the naked-position close", () => {
  // The position is unprotected by definition; a cut with the close on the
  // wire leaves it to the next process's two strikes.
  it("counts as order work in flight while the market close is outstanding", async () => {
    delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
    const { watchdog, searchOpenPositions, placeOrder } = makeWatchdog();
    searchOpenPositions.mockResolvedValue([position()]);
    let land!: (r: { orderId: number }) => void;
    placeOrder.mockImplementation(() => new Promise((r) => (land = r)));

    await watchdog.runNakedPositionWatchdog();
    advanceOneInterval();
    const sweeping = watchdog.runNakedPositionWatchdog();
    await vi.waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    expect(orderRequestsInFlight()).toBe(1);

    land({ orderId: 55 });
    await sweeping;
    expect(orderRequestsInFlight()).toBe(0);
  });
});
