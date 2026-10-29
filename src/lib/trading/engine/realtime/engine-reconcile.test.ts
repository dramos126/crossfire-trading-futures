/**
 * D3 extracted the reconciliation cluster; these are the tests the
 * extraction made possible, per the rule in
 * docs/proposals/engine-decomposition.md.
 *
 * Four subjects, chosen because none of them was reachable before and
 * each one decides something a wrong answer corrupts silently rather than
 * loudly:
 *
 *  - `classifyByPriceDistance` picks the TP/SL chip when neither the fill's
 *    order id nor the surviving OCO leg can answer. A wrong answer writes a
 *    "Take Profit" label onto a stopped-out trade and nothing ever
 *    contradicts it.
 *  - `attributeBrackets` decides which broker orders belong to this trade.
 *    A wrong answer points breakeven at another deployment's stop.
 *  - `recoverFailedBrackets` is the one path that can fire a second flatten
 *    at a position already being flattened. `bracketRecoveryEligibility` is
 *    tested in engine-exit.test.ts; what is tested here is that the
 *    recovery path actually consults it and actually stops.
 *  - `reconcileGhostPositions` is P2's attribution consumer. The rule
 *    itself is tested in engine-position-attribution.test.ts; what is
 *    tested here is that the sweep feeds it both operands through the
 *    signed accessors, and that it still places nothing — P2 is read-only
 *    and an assertion on the absence is what keeps it that way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `db/deployments` and `trading/strategies` both reach the strategy
// loader's `require.context`, a bundler mechanism with no vitest
// equivalent (patterns.md). Enumerate rather than spread: spreading pulls
// the loader back in, which is the failure being avoided.
const { getDeploymentMock } = vi.hoisted(() => ({
  getDeploymentMock: vi.fn<(id: string) => unknown>(() => null),
}));
vi.mock("@/lib/db/deployments", () => ({
  getDeployment: getDeploymentMock,
}));

// Second path to the same loader: engine-exit imports `getStrategy`
// directly, and `bracketRecoveryEligibility` is deliberately imported for
// real so the shipped gate is what runs.
vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(() => undefined),
}));

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    backfillEntryFilledAt: vi.fn(),
    backfillExitFilledAt: vi.fn(),
    closeTrade: vi.fn(),
    getApproximatedClosedTrades: vi.fn<(accountId: number) => unknown[]>(() => []),
    getBracketManualClosedTrades: vi.fn(() => []),
    getReconcilableTrades: vi.fn<(accountId: number) => unknown[]>(() => []),
    getRecentlyClosedTrades: vi.fn(() => []),
    getTradeById: vi.fn<(id: number) => unknown>(() => null),
    getTradesNeedingTimestampHeal: vi.fn<(accountId: number) => unknown[]>(() => []),
    healApproximatedExit: vi.fn(),
    listAccountsNeedingTimestampHeal: vi.fn(() => []),
    listAccountsWithBracketManualClosedTrades: vi.fn(() => []),
    listAccountsWithReconcilableTrades: vi.fn<() => number[]>(() => []),
    listAllAccountsWithApproximatedTrades: vi.fn<() => number[]>(() => []),
    markEntryFailed: vi.fn(),
    markEntryFilled: vi.fn(),
    setBracketOrderIds: vi.fn(),
    setRestingBracketPrices: vi.fn(),
    setExitReason: vi.fn(),
    attachPendingExit: vi.fn(),
    getOpenTradeForDeployment: vi.fn(() => null),
  },
}));
vi.mock("@/lib/db/trades", () => dbMock);

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

// The orphan cross-check resolves each absent account's broker from the
// persisted catalog. Mocked because the real module opens the database, and
// because what these tests drive is the *answer* — a row, or no row at all.
const { getAccountBrokerOrNullMock } = vi.hoisted(() => ({
  getAccountBrokerOrNullMock: vi.fn<(accountId: number) => "topstep" | "tradovate" | null>(
    () => "topstep",
  ),
}));
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrNull: getAccountBrokerOrNullMock,
}));

import type { Order, Position, TradeFill } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { DeploymentState } from "../engine";
import type { Deployment } from "@/lib/trading/domain";
import type { RefreshResult } from "../../broker-access/broker-registry";
import type { OpenPosition } from "../../strategy-types";
import {
  bracketExitReason,
  EXIT_REASON_BRACKET_MANUAL,
  resolveExitReason as resolveReasonForTest,
} from "@/lib/logging/exit-reasons";
import {
  attributeBrackets,
  classifyBracketLeg,
  classifyByPriceDistance,
  handleEntryClosedNoPosition,
  healTradeTimestamps,
  mapPositionsByContract,
  PassPositionReads,
  recoverFailedBrackets,
  reconcileGhostPositions,
  reconcileOneTrade,
  reconcilePendingTrades,
  type ReconcileDeps,
} from "./engine-reconcile";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";
import {
  applyPositionEvent,
  freshOrders,
  freshPositions,
  recordPositions,
  resetAccountViewForTests,
} from "./account-view";
import { failedPreEntrySnapshot } from "../engine-order";

const DEPLOYMENT_ID = "depl-1";
const ACCOUNT_ID = 9001;
const CONTRACT_ID = "CON.F.US.MNQ.U26";

const ORDER_TYPE_LIMIT = 1;
const ORDER_TYPE_STOP = 4;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

function trade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    id: 1,
    deploymentId: DEPLOYMENT_ID,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    ticker: "MNQ",
    side: SIDE_BUY,
    size: 1,
    status: "open",
    tickSize: 0.25,
    tickValue: 0.5,
    entrySubmittedAt: "2026-08-20T14:00:00.000Z",
    ...over,
  } as StrategyTrade;
}

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return {
    activeTradeId: 1,
    position: null,
    preEntryOrderIds: null,
    slCurrentPrice: null,
    tpCurrentPrice: null,
    exitInFlight: false,
    ...over,
  } as DeploymentState;
}

function order(over: Partial<Order> & { id: number }): Order {
  return {
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-08-20T14:00:01.000Z",
    updateTimestamp: "2026-08-20T14:00:01.000Z",
    status: 1,
    type: ORDER_TYPE_LIMIT,
    side: SIDE_SELL,
    size: 1,
    limitPrice: null,
    stopPrice: null,
    filledPrice: null,
    ...over,
  } as Order;
}

/** A fan-out where every configured arm answered. */
function cleanRefresh(): RefreshResult {
  return {
    partial: false,
    errors: { topstep: null, tradovate: null },
    listed: { topstep: [], tradovate: [] },
    cannotTrade: { topstep: [], tradovate: [] },
    answeredAt: { topstep: "2026-10-14T21:00:00.000Z", tradovate: "2026-10-14T21:00:00.000Z" },
    balances: { topstep: new Map(), tradovate: null },
    size: 1,
    removed: [],
    kindChanges: [],
  };
}

/** A fan-out where one arm threw and the other answered. */
function armDown(kind: "topstep" | "tradovate", message: string): RefreshResult {
  const r = cleanRefresh();
  r.partial = true;
  r.errors[kind] = message;
  return r;
}

type Fakes = {
  deps: ReconcileDeps;
  log: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
  isAccountRegistered: ReturnType<typeof vi.fn>;
  handleOrphanedAccount: ReturnType<typeof vi.fn>;
  refreshBrokerRegistry: ReturnType<typeof vi.fn>;
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  modifyOrder: ReturnType<typeof vi.fn>;
  searchOpenPositions: ReturnType<typeof vi.fn>;
  searchOpenOrders: ReturnType<typeof vi.fn>;
  resolveContract: ReturnType<typeof vi.fn>;
  forceClose: ReturnType<typeof vi.fn>;
  resolveExitReasonMock: ReturnType<typeof vi.fn>;
  searchTrades: ReturnType<typeof vi.fn>;
  notifyEntry: ReturnType<typeof vi.fn>;
  noteTradeClosed: ReturnType<typeof vi.fn>;
  states: Map<string, DeploymentState>;
};

function fakes(
  over: {
    states?: Map<string, DeploymentState>;
    positions?: unknown[];
    openOrders?: Order[];
    searchTrades?: () => Promise<TradeFill[]>;
  } = {},
): Fakes {
  const log = vi.fn();
  const logEvent = vi.fn();
  const resolveExitReasonMock = vi.fn(() => bracketExitReason(EXIT_REASON_BRACKET_MANUAL));
  const placeOrder = vi.fn(async () => ({ orderId: 777 }));
  const cancelOrder = vi.fn(async () => undefined);
  const searchOpenPositions = vi.fn(async () => over.positions ?? []);
  const searchOpenOrders = vi.fn(async (): Promise<Order[]> => over.openOrders ?? []);
  const resolveContract = vi.fn(async () => ({
    id: CONTRACT_ID,
    name: "MNQU26",
    description: "Micro E-mini Nasdaq",
    tickSize: 0.25,
    tickValue: 0.5,
    activeContract: true,
    symbolId: "F.US.MNQ",
  }));
  const forceClose = vi.fn(async () => undefined);
  const states = over.states ?? new Map<string, DeploymentState>();
  const searchTrades = vi.fn(over.searchTrades ?? (async (): Promise<TradeFill[]> => []));
  const notifyEntry = vi.fn(async () => undefined);
  const noteTradeClosed = vi.fn();

  const modifyOrder = vi.fn(async () => undefined);
  const isAccountRegistered = vi.fn(() => true);
  const handleOrphanedAccount = vi.fn(async () => undefined);
  const refreshBrokerRegistry = vi.fn(async () => cleanRefresh());
  const broker = {
    placeOrder,
    cancelOrder,
    modifyOrder,
    searchOpenPositions,
    searchOpenOrders,
    searchTrades,
    getFillsForOrder: vi.fn(async () => []),
  };

  const deps = {
    log,
    logEvent,
    brokerForAccount: () => broker,
    maybeOrphanFromBrokerError: vi.fn(),
    noteBrokerOutcome: vi.fn(),
    stateFor: (id: string) => states.get(id),
    resolveExitReason: resolveExitReasonMock,
    brokerKindFor: vi.fn(() => "topstep"),
    capabilitiesFor: vi.fn(() => ({
      fillCarriesPnl: true,
      historicalFillsRequireOrderLookup: false,
      // The broker whose brackets need re-anchoring, so the default fake
      // exercises the path with the work in it.
      bracketAnchor: "fill",
    })),
    validationAttempts: new Map<number, number>(),
    lastHourlyValidationSweepAt: new Map<number, number>(),
    approximatedSweepPasses: new Map<number, number>(),
    entryNotifiedTradeIds: new Set<number>(),
    releaseContractLock: vi.fn(),
    settleIfFlat: vi.fn(),
    markEnteredThisSession: vi.fn(),
    isAccountRegistered,
    handleOrphanedAccount,
    realtimeSuppressesPolling: vi.fn(() => false),
    refreshBrokerRegistry,
    accountNamesSnapshot: vi.fn(() => new Map<number, string>()),
    accountNames: new Map<number, string>(),
    accountNamesRefreshedAt: vi.fn(() => 0),
    setAccountNamesRefreshedAt: vi.fn(),
    brokerRegistryLastAttemptAt: vi.fn(() => 0),
    setBrokerRegistryLastAttemptAt: vi.fn(),
    resolveContract,
    resolveExitFillPrice: vi.fn(async () => null),
    snapshotTradeBars: vi.fn(async () => ({ kind: "saved" as const })),
    noteTradeClosed,
    notifyEntry,
    notifyExit: vi.fn(async () => undefined),
    forceCloseAfterBracketFailure: forceClose,
    isClosingFill: vi.fn(() => true),
    bufferSlotKey: vi.fn(() => "slot"),
    bufferSlotFor: vi.fn(() => undefined),
    buildCustomTag: vi.fn(() => "e_depl-1"),
  } as unknown as ReconcileDeps;

  return {
    deps,
    log,
    logEvent,
    isAccountRegistered,
    handleOrphanedAccount,
    refreshBrokerRegistry,
    placeOrder,
    cancelOrder,
    modifyOrder,
    searchOpenPositions,
    searchOpenOrders,
    resolveContract,
    forceClose,
    resolveExitReasonMock,
    searchTrades,
    notifyEntry,
    noteTradeClosed,
    states,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDeploymentMock.mockReturnValue(null);
  dbMock.getTradeById.mockReturnValue(null);
  getAccountBrokerOrNullMock.mockReturnValue("topstep");
});

describe("classifyBracketLeg", () => {
  it("pins take-profit when the matched order is the TP leg", () => {
    expect(classifyBracketLeg(11, { tpOrderId: 11, slOrderId: 22 })).toBe("tp");
  });

  it("pins stop-loss when the matched order is the SL leg", () => {
    expect(classifyBracketLeg(22, { tpOrderId: 11, slOrderId: 22 })).toBe("sl");
  });

  it("returns other when the fills spanned more than one order", () => {
    expect(classifyBracketLeg(null, { tpOrderId: 11, slOrderId: 22 })).toBe("other");
  });

  it("returns other for an order id belonging to neither leg", () => {
    expect(classifyBracketLeg(33, { tpOrderId: 11, slOrderId: 22 })).toBe("other");
  });

  it("does not match a null bracket id against a null matched id", () => {
    expect(classifyBracketLeg(null, { tpOrderId: null, slOrderId: null })).toBe("other");
  });
});

describe("classifyByPriceDistance", () => {
  // tickSize 1 throughout so a price delta reads directly as ticks.
  it("picks the leg that is both close and decisively closer", () => {
    expect(classifyByPriceDistance(100, 100, 130, 1)).toEqual({
      kind: "tp",
      tpDistTicks: 0,
      slDistTicks: 30,
    });
  });

  it("picks the stop when the stop is the near leg", () => {
    expect(classifyByPriceDistance(100, 130, 100, 1)?.kind).toBe("sl");
  });

  it("accepts a leg exactly at the distance cap", () => {
    expect(classifyByPriceDistance(105, 100, 200, 1)?.kind).toBe("tp");
  });

  it("refuses a leg one tick past the distance cap", () => {
    expect(classifyByPriceDistance(106, 100, 200, 1)).toBeNull();
  });

  it("accepts a leg exactly at the ratio boundary", () => {
    // TP 3 ticks away, SL 9 — exactly 3x.
    expect(classifyByPriceDistance(103, 100, 112, 1)?.kind).toBe("tp");
  });

  it("refuses a near leg that is not decisively closer than the other", () => {
    // TP 2 ticks, SL 5 — inside the cap but only 2.5x.
    expect(classifyByPriceDistance(102, 100, 107, 1)).toBeNull();
  });

  it("refuses an equidistant pair at any non-zero distance", () => {
    expect(classifyByPriceDistance(100, 98, 102, 1)).toBeNull();
  });

  it("breaks the zero-distance tie toward take-profit", () => {
    // Both legs on the exit price is the one tie the ratio test cannot
    // reject (0 * 3 <= 0), so the TP branch wins by evaluation order.
    // Reachable, though narrowly: `reconcileOneTrade` feeds this the live
    // `slCurrentPrice` / `tpCurrentPrice` mirrors, so a trailing stop that
    // walked up onto the TP price satisfies it. Impact is the label only —
    // the fill price is identical either way. Pinned so a future reorder
    // of the two branches is a visible change rather than a silent one.
    expect(classifyByPriceDistance(100, 100, 100, 1)?.kind).toBe("tp");
  });

  it("returns null rather than dividing by a zero tick size", () => {
    expect(classifyByPriceDistance(100, 100, 130, 0)).toBeNull();
  });

  it("returns null when a leg price was never recorded", () => {
    expect(classifyByPriceDistance(100, null, 130, 1)).toBeNull();
    expect(classifyByPriceDistance(100, 100, null, 1)).toBeNull();
  });

  it("measures in ticks, not points", () => {
    // 1.0 point away on a 0.25 tick is 4 ticks — inside the 5-tick cap.
    expect(classifyByPriceDistance(101, 100, 200, 0.25)?.kind).toBe("tp");
    // 1.5 points is 6 ticks — outside it.
    expect(classifyByPriceDistance(101.5, 100, 200, 0.25)).toBeNull();
  });
});

describe("attributeBrackets", () => {
  it("does nothing when no pre-entry snapshot was captured", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: null }));

    await attributeBrackets(f.deps, trade(), [], ACCOUNT_ID, 100);

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
  });

  it("attributes the two orders that appeared after the snapshot", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [500] });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(
      f.deps,
      trade(),
      [
        order({ id: 500, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 90 }),
        order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110 }),
        order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95 }),
      ],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
  });

  it("ignores orders on the entry side", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade({ side: SIDE_BUY }),
      [order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_BUY, limitPrice: 110 })],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
  });

  it("ignores orders on another contract", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade(),
      [order({ id: 601, contractId: "CON.F.US.MES.U26", type: ORDER_TYPE_LIMIT, limitPrice: 110 })],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
  });

  it("seeds slCurrentPrice from the attributed stop and releases the snapshot", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [] });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(
      f.deps,
      trade(),
      [order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95 })],
      ACCOUNT_ID,
      100,
    );

    expect(s.slCurrentPrice).toBe(95);
    expect(s.preEntryOrderIds).toBeNull();
  });

  it("releases the snapshot before falling into recovery", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [500] });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(
      f.deps,
      trade(),
      [order({ id: 500, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 90 })],
      ACCOUNT_ID,
      100,
    );

    expect(s.preEntryOrderIds).toBeNull();
    expect(f.searchOpenPositions).toHaveBeenCalled();
  });

  // A119: storing `null` for a failed read would return at the guard above and
  // skip recovery with it; the marked empty snapshot is diffed like any other.
  it("A119 — still attributes on a snapshot whose read failed", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: failedPreEntrySnapshot() });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(
      f.deps,
      trade(),
      [
        order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110 }),
        order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95 }),
      ],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
    expect(s.preEntryOrderIds).toBeNull();
  });
});

// A44: the REST pass's map was `{ size, avgPrice }`, so the main reconciler
// could not do signed math on positions that came with a side. Nothing reads
// `type` yet; this pins that it arrives.
describe("mapPositionsByContract", () => {
  it("keys each position by contract with its side", () => {
    const at = "2026-08-20T14:00:00.000Z";
    const map = mapPositionsByContract([
      { id: 1, accountId: ACCOUNT_ID, contractId: CONTRACT_ID, creationTimestamp: at, type: 2, size: 1, averagePrice: 100.5 },
      { id: 2, accountId: ACCOUNT_ID, contractId: "CON.F.US.MES.U26", creationTimestamp: at, type: 1, size: 3, averagePrice: 5100 },
    ]);

    expect([...map]).toEqual([
      [CONTRACT_ID, { size: 1, avgPrice: 100.5, type: 2 }],
      ["CON.F.US.MES.U26", { size: 3, avgPrice: 5100, type: 1 }],
    ]);
  });
});

// A10: Topstep's `Order` carries no link to the entry, so an operator's order
// placed on the contract between the snapshot and the diff was as good a match
// as the bracket. The trade was submitted at 14:00:00 and filled at 14:00:01.
describe("attributeBrackets — an operator's order in the snapshot-to-diff window (A10)", () => {
  const filled = { entryFilledAt: "2026-08-20T14:00:01.000Z" };

  it("attributes the bracket stop, not a manual stop placed after the fill and listed first", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade(filled),
      [
        order({ id: 700, type: ORDER_TYPE_STOP, stopPrice: 97, creationTimestamp: "2026-08-20T14:00:12.000Z" }),
        order({ id: 601, type: ORDER_TYPE_LIMIT, limitPrice: 110, creationTimestamp: "2026-08-20T14:00:01.000Z" }),
        order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "2026-08-20T14:00:01.000Z" }),
      ],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
  });

  it("attributes the bracket target, not a manual limit, when the bracket is stamped at submit", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade(filled),
      [
        order({ id: 701, type: ORDER_TYPE_LIMIT, limitPrice: 108, creationTimestamp: "2026-08-20T14:00:04.000Z" }),
        order({ id: 601, type: ORDER_TYPE_LIMIT, limitPrice: 110, creationTimestamp: "2026-08-20T14:00:00.200Z" }),
        order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "2026-08-20T14:00:00.200Z" }),
      ],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
  });

  it("measures from the fill the caller passes when the row has none yet", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    // The row says only that it was submitted at 14:00:00; the fill the
    // reconciler just read is 14:00:30, and the bracket was stamped with it.
    await attributeBrackets(
      f.deps,
      trade({ entryFilledAt: null }),
      [
        order({ id: 700, type: ORDER_TYPE_STOP, stopPrice: 97, creationTimestamp: "2026-08-20T14:01:00.000Z" }),
        order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "2026-08-20T14:00:30.000Z" }),
      ],
      ACCOUNT_ID,
      100,
      "2026-08-20T14:00:30.000Z",
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, null, 602);
  });

  // The `pending_entry` branch passes an explicit null on a fill-lookup miss;
  // a default parameter would not catch it, so the row's fill must.
  it("measures from the row's fill when the caller passes null", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade({ entryFilledAt: "2026-08-20T14:00:30.000Z" }),
      [
        // One second before submit: nearer than the bracket if the span were
        // the submit instant alone.
        order({ id: 700, type: ORDER_TYPE_STOP, stopPrice: 97, creationTimestamp: "2026-08-20T13:59:59.000Z" }),
        order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "2026-08-20T14:00:30.000Z" }),
      ],
      ACCOUNT_ID,
      100,
      null,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, null, 602);
  });

  it("keeps the broker's order when a candidate's stamp is unreadable, even beside a readable later manual stop", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade(filled),
      [
        order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "" }),
        order({ id: 700, type: ORDER_TYPE_STOP, stopPrice: 97, creationTimestamp: "2026-08-20T14:00:12.000Z" }),
      ],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, null, 602);
  });

  it("never drops a candidate: a lone new stop far from the entry is still attributed rather than sent to recovery", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      trade(filled),
      [order({ id: 602, type: ORDER_TYPE_STOP, stopPrice: 95, creationTimestamp: "2026-08-20T14:10:00.000Z" })],
      ACCOUNT_ID,
      100,
    );

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, null, 602);
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
  });
});

// A long entered on a 100.00 trigger with a 40-tick target and a 20-tick
// stop, filled 2 ticks worse at 100.50. The broker resolved its offsets
// against that fill and hung the legs at 110.50 / 95.50; the levels the
// signal named are 110.00 and 95.00.
describe("attributeBrackets — re-anchoring the bracket onto the trigger", () => {
  const anchored = () =>
    trade({
      desiredEntryPrice: 100,
      desiredTpTicks: 40,
      desiredSlTicks: 20,
      desiredTpPrice: 110,
      desiredSlPrice: 95,
    });
  const legs = () => [
    order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110.5 }),
    order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95.5 }),
  ];

  it("moves both legs onto the trigger and records where they rest", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [] });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(f.deps, anchored(), legs(), ACCOUNT_ID, 100.5);

    expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 601, { limitPrice: 110 });
    expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 602, { stopPrice: 95 });
    expect(dbMock.setRestingBracketPrices).toHaveBeenCalledWith(1, 110, 95);
    expect(s.slCurrentPrice).toBe(95);
  });

  it("costs no round trip on a broker that already anchored to the trigger", async () => {
    const f = fakes();
    vi.mocked(f.deps.capabilitiesFor).mockReturnValue({
      bracketAnchor: "trigger",
    } as unknown as ReturnType<typeof f.deps.capabilitiesFor>);
    const s = state({ preEntryOrderIds: [] });
    f.states.set(DEPLOYMENT_ID, s);

    await attributeBrackets(
      f.deps,
      anchored(),
      [order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95 })],
      ACCOUNT_ID,
      100.5,
    );

    expect(f.modifyOrder).not.toHaveBeenCalled();
    expect(dbMock.setRestingBracketPrices).not.toHaveBeenCalled();
    expect(s.slCurrentPrice).toBe(95);
  });

  it("leaves a leg alone when it is already on the trigger", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      anchored(),
      [
        order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110 }),
        order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95.5 }),
      ],
      ACCOUNT_ID,
      100.5,
    );

    expect(f.modifyOrder).toHaveBeenCalledTimes(1);
    expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 602, { stopPrice: 95 });
  });

  // The row is the only place the operator reads the bracket from, so a
  // refused move has to correct it rather than leave the trigger showing —
  // that was the display half of A69.
  it("records the fill-anchored price the leg kept when the broker refuses the move", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [] });
    f.states.set(DEPLOYMENT_ID, s);
    f.modifyOrder.mockRejectedValue(new Error("Invalid stop price"));

    await attributeBrackets(f.deps, anchored(), legs(), ACCOUNT_ID, 100.5);

    expect(dbMock.setRestingBracketPrices).toHaveBeenCalledWith(1, 110.5, 95.5);
    expect(s.slCurrentPrice).toBe(95.5);
    expect(f.logEvent).toHaveBeenCalledWith(
      "bracket_reanchor_failed",
      DEPLOYMENT_ID,
      expect.stringContaining("Invalid stop price"),
      expect.anything(),
    );
  });

  // Reachable only when slippage exceeds the bracket itself. Topstep's
  // behaviour on a modify through market is undocumented and one of the
  // three possibilities orphans the order, so the leg keeps its price.
  it("refuses a target the fill has already passed through", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [] }));

    await attributeBrackets(
      f.deps,
      anchored(),
      [order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 90 })],
      ACCOUNT_ID,
      // Filled 5 points below the 95.00 stop the trigger asks for.
      90.0,
    );

    expect(f.modifyOrder).not.toHaveBeenCalled();
    expect(dbMock.setRestingBracketPrices).toHaveBeenCalledWith(1, null, 90);
    expect(f.logEvent).toHaveBeenCalledWith(
      "bracket_reanchor_failed",
      DEPLOYMENT_ID,
      expect.stringContaining("already through"),
      expect.anything(),
    );
  });
});

// A98. On a Topstep account with a healthy user hub, the position frame's
// `markEntryFilled` promotes the row to `open` before any reconciler tick,
// so attribution has to be reachable from the `open` branch — keyed on a
// position being present and no ids on the row, not on `pending_entry`.
describe("reconcileOneTrade — attributes the brackets of a row the user hub already promoted", () => {
  const PRE_EXISTING_STOP_ID = 500;
  const hubPromoted = (over: Partial<StrategyTrade> = {}) =>
    trade({
      status: "open",
      tpOrderId: null,
      slOrderId: null,
      entryPrice: 100.5,
      entryFilledAt: "2026-08-20T14:00:00.500Z",
      desiredEntryPrice: 100,
      desiredTpTicks: 40,
      desiredSlTicks: 20,
      desiredTpPrice: 110,
      desiredSlPrice: 95,
      ...over,
    });
  // The broker resolved its offsets against the 100.50 fill, two ticks past
  // the 100.00 trigger, so the legs rest at 110.50 / 95.50.
  const openOrders = () => [
    order({ id: PRE_EXISTING_STOP_ID, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 90 }),
    order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110.5 }),
    order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95.5 }),
  ];
  const positionHeld = () =>
    new Map([[CONTRACT_ID, { size: 1, avgPrice: 100.5, type: 1 as const }]]);
  const reconcile = (f: Fakes, t: StrategyTrade, orders: Order[] = openOrders()) => {
    return reconcileOneTrade(
      f.deps,
      t,
      ACCOUNT_ID,
      orders,
      new Set(orders.map((o) => o.id)),
      positionHeld(),
    );
  };

  it("saves the ids, logs the attribution, releases the snapshot and re-anchors the legs on an open row", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] });
    f.states.set(DEPLOYMENT_ID, s);

    await reconcile(f, hubPromoted());

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
    expect(f.logEvent).toHaveBeenCalledWith(
      "bracket_ids_attributed",
      DEPLOYMENT_ID,
      expect.stringContaining("TP=601 SL=602"),
      expect.anything(),
    );
    expect(s.preEntryOrderIds).toBeNull();
    expect(f.modifyOrder).toHaveBeenCalledTimes(2);
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
  });

  it("moves fill-anchored legs onto the trigger through the open-row path", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] });
    f.states.set(DEPLOYMENT_ID, s);

    await reconcile(f, hubPromoted());

    expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 601, { limitPrice: 110 });
    expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 602, { stopPrice: 95 });
    expect(dbMock.setRestingBracketPrices).toHaveBeenCalledWith(1, 110, 95);
    expect(s.slCurrentPrice).toBe(95);
  });

  it("does not re-attribute or recover a row that already carries its bracket ids", async () => {
    const f = fakes();
    // A snapshot still on state is the worst case: the ids on the row are
    // what must stop the call, not the snapshot having been consumed.
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] }));

    await reconcile(f, hubPromoted({ tpOrderId: 601, slOrderId: 602 }));

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(f.modifyOrder).not.toHaveBeenCalled();
  });

  it("is a no-op with no pre-entry snapshot, as after a restart — no ids, no recovery, no cancels", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: null }));

    await reconcile(f, hubPromoted());

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(f.cancelOrder).not.toHaveBeenCalled();
    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).not.toHaveBeenCalled();
    expect(f.modifyOrder).not.toHaveBeenCalled();
  });

  it("never attributes a pending_exit row", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] });
    f.states.set(DEPLOYMENT_ID, s);

    await reconcile(f, hubPromoted({ status: "pending_exit", exitOrderId: 4242 }));

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(f.modifyOrder).not.toHaveBeenCalled();
    expect(s.preEntryOrderIds).toEqual([PRE_EXISTING_STOP_ID]);
  });

  it("does not attribute a half-attributed row — its snapshot was already consumed", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] });
    f.states.set(DEPLOYMENT_ID, s);

    await reconcile(f, hubPromoted({ tpOrderId: 601, slOrderId: null }));

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.modifyOrder).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(s.preEntryOrderIds).toEqual([PRE_EXISTING_STOP_ID]);
  });

  // The shape `handleUserPositionClose` hands over: a fresh REST read with
  // the position gone. The close branch runs; attribution does not.
  it("closes rather than attributes when the position is already gone", async () => {
    const f = fakes();
    const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] });
    f.states.set(DEPLOYMENT_ID, s);
    const t = hubPromoted();
    dbMock.getTradeById.mockReturnValue(t);
    const orders = openOrders();

    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, orders, new Set(orders.map((o) => o.id)), new Map(), {
      exitPrice: 110,
      pnlDollars: 4.5,
      pnlTicks: 38,
      feesDollars: 0.74,
      exitFilledAt: "2026-08-20T14:05:00.000Z",
      matchedOrderId: 601,
    });

    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.modifyOrder).not.toHaveBeenCalled();
    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(dbMock.closeTrade).toHaveBeenCalled();
  });

  const closeGone = async (f: Fakes) => {
    const t = hubPromoted();
    dbMock.getTradeById.mockReturnValue(t);
    const orders = openOrders();
    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, orders, new Set(orders.map((o) => o.id)), new Map(), {
      exitPrice: 110,
      pnlDollars: 4.5,
      pnlTicks: 38,
      feesDollars: 0.74,
      exitFilledAt: "2026-08-20T14:05:00.000Z",
      matchedOrderId: 601,
    });
  };

  it("tells the account-status job about a booked close, after the row is written", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state());

    await closeGone(f);

    // Asserted out here: an assertion inside the mock would throw into the
    // production catch around the call and be swallowed.
    expect(f.noteTradeClosed).toHaveBeenCalledTimes(1);
    expect(dbMock.closeTrade).toHaveBeenCalledTimes(1);
    expect(f.noteTradeClosed.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.closeTrade.mock.invocationCallOrder[0],
    );
  });

  it("books and announces the close even when the balance trigger throws", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state());
    f.noteTradeClosed.mockImplementation(() => {
      throw new Error("timer unavailable");
    });

    await expect(closeGone(f)).resolves.toBeUndefined();

    expect(dbMock.closeTrade).toHaveBeenCalledTimes(1);
    expect(f.logEvent).toHaveBeenCalledWith("exit_reconciled", DEPLOYMENT_ID, expect.any(String), expect.anything());
  });

  // The close-time snapshot is fire-and-forget, and a window with no bars yet
  // saves nothing, so the trade never enters the re-snapshot queue. One info
  // line names it so the gap is visible; the queue is unchanged.
  describe("the close-time bar snapshot", () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const snapshotLines = (f: Fakes) =>
      f.log.mock.calls.filter((c) => String(c[3]).includes("Bar snapshot at close"));

    it("says so once at info, naming the trade, when it saved nothing", async () => {
      const f = fakes();
      f.states.set(DEPLOYMENT_ID, state());
      f.deps.snapshotTradeBars = vi.fn(async () => ({
        kind: "retry" as const,
        reason: "the provider returned no bars for the window",
      }));

      await closeGone(f);
      await settle();

      const lines = snapshotLines(f);
      expect(lines).toHaveLength(1);
      expect(lines[0][1]).toBe("info");
      expect(lines[0][3]).toContain(`#${hubPromoted().id}`);
      expect(lines[0][4]).toMatchObject({ tradeId: hubPromoted().id });
    });

    it("says nothing when the bars were saved", async () => {
      const f = fakes();
      f.states.set(DEPLOYMENT_ID, state());
      f.deps.snapshotTradeBars = vi.fn(async () => ({ kind: "saved" as const }));

      await closeGone(f);
      await settle();

      expect(snapshotLines(f)).toEqual([]);
    });
  });

  describe("when the diff finds no new protective orders", () => {
    const livePosition = { contractId: CONTRACT_ID, size: 1, averagePrice: 100.5, type: 1 };
    const onlyPreExisting = () => [openOrders()[0]];

    it("starts recovery, which passes the eligibility gate and places a pair", async () => {
      const f = fakes({ positions: [livePosition] });
      f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] }));
      dbMock.getTradeById.mockReturnValue(hubPromoted());
      getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

      await reconcile(f, hubPromoted(), onlyPreExisting());

      expect(f.logEvent).toHaveBeenCalledWith(
        "bracket_recovery_started",
        DEPLOYMENT_ID,
        expect.anything(),
        expect.anything(),
      );
      expect(f.searchOpenPositions).toHaveBeenCalled();
      expect(dbMock.getTradeById).toHaveBeenCalledWith(1);
      expect(f.searchOpenOrders).toHaveBeenCalledWith(ACCOUNT_ID, { forceFresh: true });
      expect(f.placeOrder).toHaveBeenCalledTimes(2);
    });

    it("adopts protective orders already working instead of placing a second pair", async () => {
      // The fresh read shows the pair the stale diff missed.
      const f = fakes({
        positions: [livePosition],
        openOrders: [
          order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110.5 }),
          order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 95.5 }),
        ],
      });
      f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] }));
      dbMock.getTradeById.mockReturnValue(hubPromoted());
      getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

      await reconcile(f, hubPromoted(), onlyPreExisting());

      expect(f.searchOpenOrders).toHaveBeenCalledWith(ACCOUNT_ID, { forceFresh: true });
      expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
      expect(f.placeOrder).not.toHaveBeenCalled();
      expect(f.forceClose).not.toHaveBeenCalled();
    });

    it("places nothing when the fresh open-order read fails", async () => {
      const f = fakes({ positions: [livePosition] });
      f.searchOpenOrders.mockRejectedValueOnce(new Error("gateway down"));
      f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] }));
      dbMock.getTradeById.mockReturnValue(hubPromoted());
      getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

      await reconcile(f, hubPromoted(), onlyPreExisting());

      expect(f.placeOrder).not.toHaveBeenCalled();
      expect(f.forceClose).not.toHaveBeenCalled();
    });

    it("refuses recovery while an exit is mid-submission", async () => {
      const f = fakes({ positions: [livePosition] });
      f.states.set(
        DEPLOYMENT_ID,
        state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID], exitInFlight: true }),
      );
      dbMock.getTradeById.mockReturnValue(hubPromoted());
      getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

      await reconcile(f, hubPromoted(), onlyPreExisting());

      expect(f.placeOrder).not.toHaveBeenCalled();
      expect(f.forceClose).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledWith(
        DEPLOYMENT_ID,
        "info",
        "order",
        expect.stringContaining("an exit is mid-submission"),
        expect.anything(),
      );
    });
  });

  // The re-anchor has no exit-latch gate: it amends legs that already
  // protect the position and places nothing. Pinned so adding or dropping a
  // gate on either path is a visible change.
  it("still re-anchors found legs while an exit is mid-submission (pinned, not a gate)", async () => {
    const f = fakes();
    f.states.set(
      DEPLOYMENT_ID,
      state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID], exitInFlight: true }),
    );

    await reconcile(f, hubPromoted());

    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 601, 602);
    expect(f.modifyOrder).toHaveBeenCalledTimes(2);
  });

  describe("a stop break-even or the trail already moved is not re-anchored", () => {
    it("leaves the stop where break-even put it and still moves the target", async () => {
      const f = fakes();
      const s = state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID], slMovedToBe: true });
      f.states.set(DEPLOYMENT_ID, s);
      const orders = [
        openOrders()[0],
        order({ id: 601, type: ORDER_TYPE_LIMIT, side: SIDE_SELL, limitPrice: 110.5 }),
        // Moved to entry by break-even before attribution ran.
        order({ id: 602, type: ORDER_TYPE_STOP, side: SIDE_SELL, stopPrice: 100.5 }),
      ];

      await reconcile(f, hubPromoted(), orders);

      expect(f.modifyOrder).toHaveBeenCalledTimes(1);
      expect(f.modifyOrder).toHaveBeenCalledWith(ACCOUNT_ID, 601, { limitPrice: 110 });
      expect(dbMock.setRestingBracketPrices).toHaveBeenCalledWith(1, 110, 100.5);
      expect(s.slCurrentPrice).toBe(100.5);
    });

    it("reads the row's flags too, so a trailed stop is left alone", async () => {
      const f = fakes();
      f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID] }));

      await reconcile(f, hubPromoted({ slTrailEngaged: true }));

      expect(f.modifyOrder).not.toHaveBeenCalledWith(ACCOUNT_ID, 602, expect.anything());
    });

    it("reads the row's break-even flag, not only the state's", async () => {
      const f = fakes();
      f.states.set(DEPLOYMENT_ID, state({ preEntryOrderIds: [PRE_EXISTING_STOP_ID], slMovedToBe: false }));

      await reconcile(f, hubPromoted({ breakEvenMoved: true }));

      expect(f.modifyOrder).not.toHaveBeenCalledWith(ACCOUNT_ID, 602, expect.anything());
    });
  });
});

describe("recoverFailedBrackets — the exit-latch gap gate", () => {
  const livePosition = { contractId: CONTRACT_ID, size: 1, averagePrice: 100, type: 1 };

  it("refuses a pending_exit row instead of hanging fresh brackets on it", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    dbMock.getTradeById.mockReturnValue(trade({ status: "pending_exit", exitOrderId: 4242 }));

    await recoverFailedBrackets(f.deps, trade({ status: "pending_exit" }), ACCOUNT_ID, 100);

    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      "info",
      "order",
      expect.stringContaining("bracket recovery skipped"),
      expect.anything(),
    );
  });

  it("refuses while an exit is mid-submission", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state({ exitInFlight: true }));
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));

    await recoverFailedBrackets(f.deps, trade(), ACCOUNT_ID, 100);

    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).not.toHaveBeenCalled();
  });

  it("takes no action at all when the broker is already flat", async () => {
    const f = fakes({ positions: [] });
    f.states.set(DEPLOYMENT_ID, state());

    await recoverFailedBrackets(f.deps, trade(), ACCOUNT_ID, 100);

    expect(dbMock.getTradeById).not.toHaveBeenCalled();
    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).not.toHaveBeenCalled();
  });

  it("skips the retry rather than force-closing when the position lookup fails", async () => {
    const f = fakes();
    f.searchOpenPositions.mockRejectedValueOnce(new Error("gateway down"));
    f.states.set(DEPLOYMENT_ID, state());

    await recoverFailedBrackets(f.deps, trade(), ACCOUNT_ID, 100);

    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).not.toHaveBeenCalled();
  });

  it("retries both legs and persists them when the gate opens", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    f.placeOrder.mockResolvedValueOnce({ orderId: 701 }).mockResolvedValueOnce({ orderId: 702 });

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.placeOrder).toHaveBeenCalledTimes(2);
    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 701, 702);
    expect(f.forceClose).not.toHaveBeenCalled();
  });

  it("re-checks the gate before the force-close — an exit that lands mid-retry blocks the flatten", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    // Gate opens, then an exit is submitted while the two placeOrder
    // round-trips are in flight. The latch is released at submission, so
    // by the force-close it is free again and only the row's status shows
    // the exit — which is the whole point of re-reading it.
    dbMock.getTradeById
      .mockReturnValueOnce(trade({ status: "open" }))
      .mockReturnValue(trade({ status: "pending_exit", exitOrderId: 4242 }));
    f.placeOrder.mockRejectedValue(new Error("stop rejected: sub-spread"));

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.placeOrder).toHaveBeenCalledTimes(2);
    expect(f.forceClose).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      "warn",
      "safety",
      expect.stringContaining("force-close is skipped"),
      expect.anything(),
    );
  });

  it("re-checks the latch too — an exit mid-submission at the force-close blocks it", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    // The row has not reached pending_exit yet — this is the narrower
    // overlap the latch covers, arriving during the retry rather than
    // before it.
    f.placeOrder.mockImplementation(async () => {
      f.states.set(DEPLOYMENT_ID, state({ exitInFlight: true }));
      throw new Error("stop rejected: sub-spread");
    });

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.forceClose).not.toHaveBeenCalled();
  });

  it("still force-closes when nothing raced — the re-check is not a blanket refusal", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    f.placeOrder.mockRejectedValue(new Error("stop rejected: sub-spread"));

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.forceClose).toHaveBeenCalledTimes(1);
  });

  it("records brackets that placed even when an exit raced them, and warns", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    dbMock.getTradeById
      .mockReturnValueOnce(trade({ status: "open" }))
      .mockReturnValue(trade({ status: "pending_exit", exitOrderId: 4242 }));
    f.placeOrder.mockResolvedValueOnce({ orderId: 701 }).mockResolvedValueOnce({ orderId: 702 });

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    // Not stamping them would orphan two working orders —
    // cancelTrackedBrackets can only reach what this records.
    expect(dbMock.setBracketOrderIds).toHaveBeenCalledWith(1, 701, 702);
    expect(f.logEvent).toHaveBeenCalledWith(
      "bracket_retry_raced",
      DEPLOYMENT_ID,
      expect.stringContaining("an exit landed mid-retry"),
      expect.anything(),
    );
  });

  it("cancels the surviving leg and force-closes when only one leg places", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    f.placeOrder
      .mockResolvedValueOnce({ orderId: 701 })
      .mockRejectedValueOnce(new Error("stop rejected: sub-spread"));

    await recoverFailedBrackets(
      f.deps,
      trade({ desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.cancelOrder).toHaveBeenCalledWith(701, ACCOUNT_ID);
    expect(dbMock.setBracketOrderIds).not.toHaveBeenCalled();
    expect(f.forceClose).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      100,
      "unknown TP rejection",
      "stop rejected: sub-spread",
    );
  });

  it("force-closes rather than guessing when tick metadata is missing", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

    await recoverFailedBrackets(
      f.deps,
      trade({ tickSize: 0, desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.placeOrder).not.toHaveBeenCalled();
    expect(f.forceClose).toHaveBeenCalled();
  });

  it("places the retry legs at the intended distances, tick-aligned away from entry", async () => {
    const f = fakes({ positions: [livePosition] });
    f.states.set(DEPLOYMENT_ID, state());
    dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
    getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });

    await recoverFailedBrackets(
      f.deps,
      trade({ side: SIDE_BUY, tickSize: 0.25, desiredTpTicks: 40, desiredSlTicks: 20 }),
      ACCOUNT_ID,
      100,
    );

    expect(f.placeOrder.mock.calls[0][0]).toMatchObject({
      type: ORDER_TYPE_LIMIT,
      side: SIDE_SELL,
      limitPrice: 110,
    });
    expect(f.placeOrder.mock.calls[1][0]).toMatchObject({
      type: ORDER_TYPE_STOP,
      side: SIDE_SELL,
      stopPrice: 95,
    });
  });

  describe("a SIGTERM's exit waits for it", () => {
    // Cut between the TP and the SL, the position carries only a TP; cut in
    // the force-close, it carries nothing.
    beforeEach(() => {
      delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
      dbMock.getTradeById.mockReturnValue(trade({ status: "open" }));
      getDeploymentMock.mockReturnValue({ id: DEPLOYMENT_ID, accountId: ACCOUNT_ID });
    });

    it("is order work in flight with the TP placed and the SL on the wire", async () => {
      const f = fakes({ positions: [livePosition] });
      f.states.set(DEPLOYMENT_ID, state());
      let landSl!: (r: { orderId: number }) => void;
      f.placeOrder
        .mockResolvedValueOnce({ orderId: 701 })
        .mockImplementationOnce(() => new Promise((r) => (landSl = r)));

      const recovering = recoverFailedBrackets(f.deps, trade({ desiredTpTicks: 40, desiredSlTicks: 20 }), ACCOUNT_ID, 100);
      await vi.waitFor(() => expect(f.placeOrder).toHaveBeenCalledTimes(2));
      expect(orderRequestsInFlight()).toBe(1);

      landSl({ orderId: 702 });
      await recovering;
      expect(orderRequestsInFlight()).toBe(0);
    });

    it("is order work in flight through the force-close fallback", async () => {
      const f = fakes({ positions: [livePosition] });
      f.states.set(DEPLOYMENT_ID, state());
      f.placeOrder.mockRejectedValue(new Error("stop rejected: sub-spread"));
      let closed!: () => void;
      f.forceClose.mockImplementationOnce(() => new Promise<undefined>((r) => (closed = () => r(undefined))));

      const recovering = recoverFailedBrackets(f.deps, trade({ desiredTpTicks: 40, desiredSlTicks: 20 }), ACCOUNT_ID, 100);
      await vi.waitFor(() => expect(f.forceClose).toHaveBeenCalledTimes(1));
      expect(orderRequestsInFlight()).toBe(1);

      closed();
      await recovering;
      expect(orderRequestsInFlight()).toBe(0);
    });
  });
});

// ── reconcileGhostPositions — P2's read-only attribution consumer ─────────────

function deployment(): Deployment {
  return { id: DEPLOYMENT_ID, accountId: ACCOUNT_ID, ticker: "MNQ" } as unknown as Deployment;
}

function openPosition(side: 0 | 1, size: number): OpenPosition {
  return {
    side,
    entryPrice: 100,
    entryTimestamp: "2026-08-24T14:00:00.000Z",
    barsSinceEntry: 1,
    entryFilledAt: "2026-08-24T14:00:00.000Z",
    size,
    slTicks: 20,
  };
}

const POSITION_TYPE_LONG = 1;
const POSITION_TYPE_SHORT = 2;

function brokerPosition(type: 1 | 2, size: number, contractId: string = CONTRACT_ID) {
  return {
    id: 1,
    accountId: ACCOUNT_ID,
    contractId,
    creationTimestamp: "2026-08-24T14:00:00.000Z",
    type,
    size,
    averagePrice: 100,
  };
}

describe("reconcilePendingTrades — the account view", () => {
  function withPendingTrade(): void {
    dbMock.listAccountsWithReconcilableTrades.mockReturnValueOnce([ACCOUNT_ID]);
    dbMock.getReconcilableTrades.mockReturnValueOnce([trade()]);
  }

  it("writes the fan-out's positions and orders read into the view, and reads the broker live even when the view is fresh", async () => {
    resetAccountViewForTests();
    recordPositions(ACCOUNT_ID, [], "route");
    const live = [brokerPosition(POSITION_TYPE_LONG, 1)];
    const working = [order({ id: 31 })];
    const f = fakes({ positions: live, openOrders: working });
    withPendingTrade();

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(1);
    expect(freshPositions(ACCOUNT_ID)?.items).toEqual(live);
    expect(freshPositions(ACCOUNT_ID)?.source).toBe("sweep");
    expect(freshOrders(ACCOUNT_ID)?.items).toEqual(working);
    expect(freshOrders(ACCOUNT_ID)?.source).toBe("sweep");
  });

  it("stamps its write with the ask time, so a size-0 hub frame landing during the read stands", async () => {
    resetAccountViewForTests();
    vi.useFakeTimers();
    try {
      recordPositions(ACCOUNT_ID, [brokerPosition(POSITION_TYPE_LONG, 1)], "sweep");
      const f = fakes();
      let release!: (p: unknown[]) => void;
      f.searchOpenPositions.mockImplementationOnce(() => new Promise<unknown[]>((res) => (release = res)));
      withPendingTrade();

      const sweep = reconcilePendingTrades(f.deps, [deployment()]);
      await vi.advanceTimersByTimeAsync(1_000);
      applyPositionEvent(ACCOUNT_ID, { ...brokerPosition(POSITION_TYPE_LONG, 1), size: 0 } as Position);
      release([brokerPosition(POSITION_TYPE_LONG, 1)]);
      await sweep;

      expect(freshPositions(ACCOUNT_ID)?.items).toEqual([]);
      expect(freshPositions(ACCOUNT_ID)?.source).toBe("hub");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * docs/bugs-fixed.md, sized by A115: `Position/searchOpen` was 40/min of the
 * engine's Topstep budget, and the reconciler and the ghost sweep each asked
 * it per account in the same 15 s pass. The pass shares one live read — never
 * the account view, which nothing that acts reads.
 */
describe("A9 — one live position read per account per reconcile pass", () => {
  function passWithPositionOpen(): Fakes {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));
    dbMock.getTradeById.mockReturnValue(trade());
    dbMock.listAccountsWithReconcilableTrades.mockReturnValue([ACCOUNT_ID]);
    dbMock.getReconcilableTrades.mockReturnValue([trade()]);
    return f;
  }

  beforeEach(() => {
    resetAccountViewForTests();
  });

  it("gives the ghost sweep the reconciler's read of the same pass", async () => {
    const f = passWithPositionOpen();
    const reads = new PassPositionReads();

    await reconcilePendingTrades(f.deps, [deployment()], reads);
    await reconcileGhostPositions(f.deps, [deployment()], reads);

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(1);
  });

  it("reads the broker again on the next pass", async () => {
    const f = passWithPositionOpen();

    await reconcilePendingTrades(f.deps, [deployment()], new PassPositionReads());
    await reconcileGhostPositions(f.deps, [deployment()], new PassPositionReads());

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(2);
  });

  it("shares a read still in flight rather than starting a second", async () => {
    const f = passWithPositionOpen();
    const reads = new PassPositionReads();
    const broker = f.deps.brokerForAccount(ACCOUNT_ID);

    await Promise.all([reads.read(broker, ACCOUNT_ID), reads.read(broker, ACCOUNT_ID)]);

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(1);
  });

  // Fix pass. The shared read is asked at the start of the reconciler pass;
  // a position opened during that pass is absent from it, and clearing the
  // mirror then silences break-even, trailing and session-end on it (A71).
  describe("the ghost clear never acts on a read older than the row", () => {
    const ASKED = new Date("2026-10-23T14:00:00.000Z");

    async function sweepOverFlatReadThenRow(row: StrategyTrade): Promise<Fakes> {
      const f = fakes({ positions: [] });
      f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));
      const reads = new PassPositionReads();
      await reads.read(f.deps.brokerForAccount(ACCOUNT_ID), ACCOUNT_ID);
      vi.setSystemTime(new Date(ASKED.getTime() + 3_000));
      dbMock.getTradeById.mockReturnValue(row);
      await reconcileGhostPositions(f.deps, [deployment()], reads);
      return f;
    }

    function cleared(f: Fakes): boolean {
      return f.logEvent.mock.calls.some((c) => c[0] === "ghost_position_cleared");
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(ASKED);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the mirror when the row's entry was submitted after the read was asked", async () => {
      const f = await sweepOverFlatReadThenRow(
        trade({ entrySubmittedAt: "2026-10-23T14:00:01.000Z", updatedAt: "2026-10-23 13:59:00" }),
      );
      expect(cleared(f)).toBe(false);
      expect(f.states.get(DEPLOYMENT_ID)?.position).not.toBeNull();
    });

    it("keeps the mirror when the row's fill is later than the read", async () => {
      const f = await sweepOverFlatReadThenRow(
        trade({
          entrySubmittedAt: "2026-10-23T13:59:58.000Z",
          entryFilledAt: "2026-10-23T14:00:01.000Z",
          updatedAt: "2026-10-23 13:59:00",
        }),
      );
      expect(cleared(f)).toBe(false);
    });

    // SQLite's `datetime('now')`: UTC with no zone marker, whole seconds.
    // A write in the read's own second cannot be ordered, so it keeps.
    it("keeps the mirror when the row was written in or after the read's second", async () => {
      const f = await sweepOverFlatReadThenRow(
        trade({ entrySubmittedAt: "2026-10-23T13:59:58.000Z", updatedAt: "2026-10-23 14:00:00" }),
      );
      expect(cleared(f)).toBe(false);
    });

    it("clears a mirror whose row was last written before the read was asked", async () => {
      const f = await sweepOverFlatReadThenRow(
        trade({
          entrySubmittedAt: "2026-10-23T13:59:58.000Z",
          entryFilledAt: "2026-10-23T13:59:58.500Z",
          updatedAt: "2026-10-23 13:59:59",
        }),
      );
      expect(cleared(f)).toBe(true);
      expect(f.states.get(DEPLOYMENT_ID)?.position).toBeNull();
    });
  });

  afterEach(() => {
    dbMock.listAccountsWithReconcilableTrades.mockReturnValue([]);
    dbMock.getReconcilableTrades.mockReturnValue([]);
  });
});

describe("reconcileGhostPositions — D-6 attribution, read-only (P2)", () => {
  // The sweep asks the broker about the month the open trade row names, so
  // every case here needs one. `trade()` sits on CONTRACT_ID, which is what
  // the resolver fake answers — the pre-flip state, where the two agree.
  beforeEach(() => {
    dbMock.getTradeById.mockReturnValue(trade());
  });

  it("writes its read into the account view, and reads the broker live even when the view is fresh", async () => {
    // The sweep clears the mirror that gates exits, so a fresh view must
    // never stand in for its read (engine.md, post-entry reads are live).
    resetAccountViewForTests();
    recordPositions(ACCOUNT_ID, [], "route");
    const live = [brokerPosition(POSITION_TYPE_LONG, 1)];
    const f = fakes({ positions: live });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(1);
    expect(freshPositions(ACCOUNT_ID)?.items).toEqual(live);
    expect(freshPositions(ACCOUNT_ID)?.source).toBe("sweep");
  });

  it("logs nothing when the engine's tracked position and the broker's agree", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.log).not.toHaveBeenCalled();
    expect(f.logEvent).not.toHaveBeenCalled();
  });

  it("reports an excess when the operator adds to an engine long", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 2)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.logEvent).toHaveBeenCalledWith(
      "ghost_position_attribution",
      DEPLOYMENT_ID,
      expect.stringContaining("engine expects Long 1, broker reports Long 2 — manual +1 (excess)"),
      expect.anything(),
    );
  });

  it("reports an opposite-direction excess that a magnitude-only check would have called a match", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_SHORT, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    const line = f.logEvent.mock.calls[0][2] as string;
    expect(line).toContain("engine expects Long 1, broker reports Short 1 — manual -2");
    expect(line).toContain("opposite direction");
  });

  it("reports a shortfall as unattributable rather than as a manual reduction", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 2) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    const line = f.logEvent.mock.calls[0][2] as string;
    expect(line).toContain("shortfall");
    expect(line).toContain("not attributable");
  });

  // The whole phase is "compute it, log it, act on nothing". A consumer that
  // later grows an order call fails here, which is the point of asserting the
  // absence rather than only the log line.
  it("places, cancels and modifies nothing on any attribution", async () => {
    for (const brokerPos of [
      brokerPosition(POSITION_TYPE_LONG, 2),
      brokerPosition(POSITION_TYPE_SHORT, 1),
      brokerPosition(POSITION_TYPE_LONG, 1),
    ]) {
      const f = fakes({ positions: [brokerPos] });
      f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 2) }));
      const before = structuredClone(f.states.get(DEPLOYMENT_ID));

      await reconcileGhostPositions(f.deps, [deployment()]);

      expect(f.placeOrder).not.toHaveBeenCalled();
      expect(f.cancelOrder).not.toHaveBeenCalled();
      expect(f.forceClose).not.toHaveBeenCalled();
      // Read-only means the in-memory mirror too, and this is the assertion
      // that actually earns the test's name. Guarding only the broker calls
      // let `deplState.position = null` through green — which is the exact
      // shape P3's "Pausing must confirm flat" work will be tempted into.
      // The ghost-clear branch may write state; the attribution branch may not.
      expect(f.states.get(DEPLOYMENT_ID)).toEqual(before);
    }
  });

  it("does not attribute a broker-flat frame — the ghost-clear branch owns that and returns first", async () => {
    const f = fakes({ positions: [] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.logEvent).toHaveBeenCalledWith(
      "ghost_position_cleared",
      DEPLOYMENT_ID,
      expect.stringContaining("Ghost position cleared"),
      expect.anything(),
    );
    expect(f.logEvent).not.toHaveBeenCalledWith(
      "ghost_position_attribution",
      DEPLOYMENT_ID,
      expect.anything(),
      expect.anything(),
    );
    expect(f.states.get(DEPLOYMENT_ID)?.position).toBeNull();
  });

  it("never visits a deployment the engine does not think holds a position, so it never sees D-6's wholly-manual row", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 3)] });
    f.states.set(DEPLOYMENT_ID, state({ position: null }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
    expect(f.logEvent).not.toHaveBeenCalled();
  });

  // The seam, not the silence: the month asked about comes off the row the
  // state's `activeTradeId` names. Asserting only that nothing was logged
  // passes just as well against the resolver-only predicate this replaced.
  it("asks the row named by activeTradeId which month to look on", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ activeTradeId: 77, position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(dbMock.getTradeById).toHaveBeenCalledWith(77);
    expect(f.log).not.toHaveBeenCalled();
    expect(f.logEvent).not.toHaveBeenCalled();
  });
});

/**
 * A71. Topstep rotates `activeContract` to the next month while a position is
 * still open on the previous one. The sweep used to resolve the *front* month,
 * find the broker honestly holding nothing on it, and clear the mirror every
 * clock-driven guard reads — so the position rode on unmanaged while the log
 * asserted the deployment was flat.
 */
describe("reconcileGhostPositions — a contract flip does not turn an open position into a ghost", () => {
  const ROW_CONTRACT_ID = CONTRACT_ID;
  const FRONT_CONTRACT_ID = "CON.F.US.MNQ.Z26";

  function afterTheFlip(over: { positions?: unknown[] } = {}): Fakes {
    const f = fakes(over);
    f.resolveContract.mockResolvedValue({
      id: FRONT_CONTRACT_ID,
      name: "MNQZ26",
      description: "Micro E-mini Nasdaq",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));
    return f;
  }

  it("keeps the mirror when the broker still holds the row's month, and names both months at warn", async () => {
    dbMock.getTradeById.mockReturnValue(trade({ contractId: ROW_CONTRACT_ID }));
    const f = afterTheFlip({ positions: [brokerPosition(POSITION_TYPE_LONG, 1, ROW_CONTRACT_ID)] });

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.states.get(DEPLOYMENT_ID)?.position).not.toBeNull();
    expect(f.logEvent).not.toHaveBeenCalled();
    const [deploymentId, severity, , line] = f.log.mock.calls[0] as [string, string, string, string];
    expect(deploymentId).toBe(DEPLOYMENT_ID);
    expect(severity).toBe("warn");
    expect(line).toContain(ROW_CONTRACT_ID);
    expect(line).toContain(FRONT_CONTRACT_ID);
  });

  it("clears a genuine ghost on the row's contract, not on the one the resolver answers", async () => {
    dbMock.getTradeById.mockReturnValue(trade({ contractId: ROW_CONTRACT_ID }));
    const f = afterTheFlip({ positions: [] });

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.states.get(DEPLOYMENT_ID)?.position).toBeNull();
    const [event, , line, subject] = f.logEvent.mock.calls[0] as [
      string,
      string,
      string,
      { contractId: string },
    ];
    expect(event).toBe("ghost_position_cleared");
    expect(line).toContain(ROW_CONTRACT_ID);
    expect(line).not.toContain(FRONT_CONTRACT_ID);
    expect(subject.contractId).toBe(ROW_CONTRACT_ID);
  });

  // The divergence line claims a live position on the row's month, so it may
  // only fire once the broker has confirmed one — a ghost after the flip gets
  // the clear and nothing that contradicts it.
  it("does not announce a divergence for a ghost, only the clear", async () => {
    dbMock.getTradeById.mockReturnValue(trade({ contractId: ROW_CONTRACT_ID }));
    const f = afterTheFlip({ positions: [] });

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.log.mock.calls.filter((c) => c[1] === "warn")).toHaveLength(0);
    expect(f.logEvent).toHaveBeenCalledTimes(1);
  });

  it("falls back to the resolved contract and logs why when no trade row names a month", async () => {
    dbMock.getTradeById.mockReturnValue(null);
    const f = afterTheFlip({
      positions: [brokerPosition(POSITION_TYPE_LONG, 1, FRONT_CONTRACT_ID)],
    });

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.states.get(DEPLOYMENT_ID)?.position).not.toBeNull();
    const [deploymentId, severity, , line] = f.log.mock.calls[0] as [string, string, string, string];
    expect(deploymentId).toBe(DEPLOYMENT_ID);
    expect(severity).toBe("warn");
    expect(line).toContain("no trade row");
    expect(line).toContain(FRONT_CONTRACT_ID);
  });

  // `warn` is never per-tick and this sweep runs every 15s against a condition
  // that stands for days — the position is held until the operator or the
  // strategy closes it.
  it("says the divergence once per row rather than once per sweep", async () => {
    dbMock.getTradeById.mockReturnValue(trade({ contractId: ROW_CONTRACT_ID }));
    const f = afterTheFlip({ positions: [brokerPosition(POSITION_TYPE_LONG, 1, ROW_CONTRACT_ID)] });

    await reconcileGhostPositions(f.deps, [deployment()]);
    await reconcileGhostPositions(f.deps, [deployment()]);
    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.log.mock.calls.filter((c) => c[1] === "warn")).toHaveLength(1);
  });

  it("re-announces for the next trade row on the same deployment", async () => {
    dbMock.getTradeById.mockReturnValue(trade({ id: 1, contractId: ROW_CONTRACT_ID }));
    const f = afterTheFlip({ positions: [brokerPosition(POSITION_TYPE_LONG, 1, ROW_CONTRACT_ID)] });

    await reconcileGhostPositions(f.deps, [deployment()]);
    dbMock.getTradeById.mockReturnValue(trade({ id: 2, contractId: ROW_CONTRACT_ID }));
    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.log.mock.calls.filter((c) => c[1] === "warn")).toHaveLength(2);
  });

  // `sameContractMonth` answers false for "cannot tell" as well as for
  // "different month", so the divergence line needs the identity check in
  // front of it — a Tradovate numeric id before its symbol cache warms parses
  // as neither month, and announcing one id against itself as a flip is a
  // false alarm on the sweep that exists to report a real one.
  it("says nothing when the row and the resolver name one unreadable id", async () => {
    const OPAQUE_ID = "4470324";
    dbMock.getTradeById.mockReturnValue(trade({ contractId: OPAQUE_ID }));
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1, OPAQUE_ID)] });
    f.resolveContract.mockResolvedValue({
      id: OPAQUE_ID,
      name: "",
      description: "Micro E-mini Nasdaq",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));

    await reconcileGhostPositions(f.deps, [deployment()]);

    expect(f.states.get(DEPLOYMENT_ID)?.position).not.toBeNull();
    expect(f.log).not.toHaveBeenCalled();
  });
});

/**
 * A52. Reproduced from the 2026-08-26 soak, which is why the fixture is the
 * shape it is: two legs of one group pause, closed by the same actor 600ms
 * apart, got different labels — and the mislabelled one had `tp=null
 * sl=null`, so `bracket/manual` named a bracket that did not exist.
 *
 * The cause is a race, not a rule: the Topstep leg's position frame landed
 * *before* its exit order was recorded (`size=0` at 14:22:53.959, `Exit
 * order placed` at .966), so the reconciler read a row still at `open` and
 * inferred an exogenous close. A fast fill is not evidence of who exited.
 */
describe("A52 — who closed the trade is the actor's answer, not the row status'", () => {
  const EXIT_PRICE = 29214.25;

  /** The Layer-1 buffer result, so the close branch makes no broker call. */
  const preResolved = {
    exitPrice: EXIT_PRICE,
    pnlDollars: 45.26,
    pnlTicks: 57,
    feesDollars: 1.24,
    exitFilledAt: "2026-08-26T14:22:53.959Z",
    matchedOrderId: null,
  };

  function closingTrade(over: Partial<StrategyTrade>): StrategyTrade {
    return trade({
      entryPrice: 29200,
      entryFilledAt: "2026-08-26T14:10:00.000Z",
      // The soak's mislabelled row: no brackets were ever attributed, so
      // the label it was given could not have been produced by one.
      tpOrderId: null,
      slOrderId: null,
      ...over,
    });
  }

  async function closeAndReadKindLine(t: StrategyTrade, f: Fakes): Promise<string> {
    dbMock.getTradeById.mockReturnValue(t);
    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, [], new Set<number>(), new Map(), preResolved);
    const line = f.logEvent.mock.calls.find(
      (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes(`Trade #${t.id} closed (`),
    );
    expect(line, "the close line was never emitted").toBeDefined();
    return line![2] as string;
  }

  it("gives two legs closed by the same actor the same label, whichever frame won the race", async () => {
    const f = fakes();
    f.resolveExitReasonMock.mockReturnValue(resolveReasonForTest("deployment_close"));

    // Topstep: the position frame beat the exit-order write, so the row is
    // still `open` at reconcile. This is the leg that was mislabelled.
    const topstep = closingTrade({ id: 391, status: "open", exitReasonCode: "deployment_close" });
    // Tradovate, 600ms later: the frames landed the other way round.
    const tradovate = closingTrade({
      id: 392,
      status: "pending_exit",
      exitReasonCode: "deployment_close",
      entrySubmittedAt: "2026-08-26T14:10:00.600Z",
    });

    const first = await closeAndReadKindLine(topstep, f);
    const second = await closeAndReadKindLine(tradovate, f);

    expect(first).toContain("closed (engine exit)");
    expect(second).toContain("closed (engine exit)");
  });

  it("does not name a bracket on a row that never had one", async () => {
    const f = fakes();
    f.resolveExitReasonMock.mockReturnValue(resolveReasonForTest("deployment_close"));
    const t = closingTrade({ id: 391, status: "open", exitReasonCode: "deployment_close" });

    expect(await closeAndReadKindLine(t, f)).not.toContain("bracket");
  });

  it("still calls an exogenous close bracket/manual, which is the case the wording was written for", async () => {
    // No actor recorded a reason, so nothing the engine did closed this —
    // a TP/SL fill or a flatten from the broker's own screen.
    const f = fakes();
    const t = closingTrade({ id: 400, status: "open", exitReasonCode: null });

    expect(await closeAndReadKindLine(t, f)).toContain("closed (bracket/manual)");
  });

  it("reads the code recorded before the close, not the one the close just wrote", async () => {
    // `setExitReason` stamps a code on *every* close, including an
    // exogenous one, so a reconciler that re-read the row after that write
    // would answer "engine exit" for everything and the fix would be
    // invisible. The row this returns changes the moment the write lands,
    // which is what the real store does.
    const f = fakes();
    f.resolveExitReasonMock.mockReturnValue(resolveReasonForTest(EXIT_REASON_BRACKET_MANUAL));
    const t = closingTrade({ id: 401, status: "open", exitReasonCode: null });
    let written = false;
    dbMock.getTradeById.mockImplementation(() =>
      written ? { ...t, exitReasonCode: EXIT_REASON_BRACKET_MANUAL } : { ...t },
    );
    dbMock.setExitReason.mockImplementation(() => {
      written = true;
    });

    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, [], new Set<number>(), new Map(), preResolved);
    const line = f.logEvent.mock.calls.find(
      (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes("Trade #401 closed ("),
    );
    expect(written, "the write the snapshot has to precede never happened").toBe(true);
    expect(line![2]).toContain("closed (bracket/manual)");
  });
});

describe("handleEntryClosedNoPosition — the size it reports is the one that filled", () => {
  // The third `{size}` site. It has no position to read, so it looked like
  // the caller `entryFillValues`' default was written for — but it sums the
  // entry fills to weight the price it reports, so the filled total is in
  // hand one statement earlier. A 2-lot entry that filled 1 and had its
  // bracket close it inside the same reconciler window said "Bought 2 MNQ"
  // in the lane, "2 contracts" in the embed, and doubled the risk dollars
  // underneath.
  const partialFill: TradeFill = {
    id: 1,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-08-20T14:00:02.000Z",
    price: 21000.5,
    profitAndLoss: null,
    fees: null,
    side: SIDE_BUY,
    size: 1,
    voided: false,
    orderId: 555,
  };

  function partiallyFilledEntry(size = 2): StrategyTrade {
    return trade({
      id: 500,
      status: "pending_entry",
      size,
      entryOrderId: 555,
      desiredSlTicks: 40,
      desiredTpTicks: 60,
    });
  }

  it("hands the Activity lane the filled quantity, not the row's", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([partialFill]);

    expect(await handleEntryClosedNoPosition(f.deps, partiallyFilledEntry(), ACCOUNT_ID)).toMatchObject({
      status: "open",
    });

    const [event, , , subject] = f.logEvent.mock.calls[0] as [
      string,
      string,
      string,
      { values: Record<string, unknown> },
    ];
    expect(event).toBe("entry_filled");
    expect(subject.values.size).toBe(1);
  });

  it("hands the entry embed the same number, so the two surfaces cannot disagree", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([partialFill]);

    await handleEntryClosedNoPosition(f.deps, partiallyFilledEntry(), ACCOUNT_ID);

    expect(f.notifyEntry).toHaveBeenCalledTimes(1);
    expect(f.notifyEntry.mock.calls[0][3]).toBe(1);
  });

  it("sums the fills when the entry filled across more than one of them", async () => {
    // Three submitted, two filled across two fills: the expected 2 differs
    // from the row's 3 *and* from `entryFills[0].size`, so neither of the
    // two wrong answers passes it.
    const f = fakes();
    f.searchTrades.mockResolvedValue([
      partialFill,
      { ...partialFill, id: 2, price: 21001.5, creationTimestamp: "2026-08-20T14:00:03.000Z" },
    ]);

    await handleEntryClosedNoPosition(f.deps, partiallyFilledEntry(3), ACCOUNT_ID);

    const [, , , subject] = f.logEvent.mock.calls[0] as [
      string,
      string,
      string,
      { values: Record<string, unknown> },
    ];
    expect(subject.values.size).toBe(2);
    expect(f.notifyEntry.mock.calls[0][3]).toBe(2);
  });
});

/**
 * docs/bugs-fixed.md.
 * `reconcilePendingTrades` reads its rows before the broker read, so a fill
 * that opened and closed inside that await reaches the no-position branch as
 * a stale `pending_entry`, and Trade/search had not indexed the fill yet: the
 * row was written `entry_failed` and the -$305 dropped out of the deployment.
 */
describe("entry did not fill misclassification — a real fill is never written off", () => {
  const ENTRY_ORDER_ID = 555;
  const entryFill: TradeFill = {
    id: 71,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-08-20T14:00:00.000Z",
    price: 27253.25,
    profitAndLoss: null,
    fees: null,
    side: SIDE_BUY,
    size: 1,
    voided: false,
    orderId: ENTRY_ORDER_ID,
  };

  function pendingEntry(): StrategyTrade {
    return trade({ id: 318, status: "pending_entry", entryOrderId: ENTRY_ORDER_ID });
  }

  function slotHolding(fills: TradeFill[]) {
    return {
      accountId: ACCOUNT_ID,
      contractId: CONTRACT_ID,
      tradeId: 318,
      openedAt: Date.parse("2026-08-20T13:59:59.000Z"),
      fills,
      dedup: new Set<string>(),
    };
  }

  it("does not fail a row the user hub promoted while the reconciler was reading the broker", async () => {
    const f = fakes();
    const t = pendingEntry();
    dbMock.getTradeById.mockReturnValue({
      ...t,
      status: "open",
      entryPrice: 27253.25,
      entryFilledAt: "2026-08-20T14:00:00.000Z",
    });

    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(dbMock.markEntryFailed).not.toHaveBeenCalled();
    expect(f.logEvent.mock.calls.some((c) => c[0] === "entry_not_filled")).toBe(false);
    expect(f.deps.releaseContractLock).not.toHaveBeenCalled();
  });

  it("does not re-open a row another path closed while Trade/search was answering", async () => {
    const f = fakes();
    const t = pendingEntry();
    f.searchTrades.mockResolvedValue([entryFill]);
    dbMock.getTradeById.mockReturnValue({ ...t, status: "closed" });

    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(dbMock.markEntryFilled).not.toHaveBeenCalled();
    expect(dbMock.markEntryFailed).not.toHaveBeenCalled();
    expect(dbMock.closeTrade).not.toHaveBeenCalled();
  });

  it("books an entry fill the Layer 1 buffer holds when Trade/search has not indexed it", async () => {
    const f = fakes();
    f.deps.bufferSlotFor = () => slotHolding([entryFill]);
    f.deps.resolveExitFillPrice = async () => 27238;

    await reconcileOneTrade(f.deps, pendingEntry(), ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(dbMock.markEntryFailed).not.toHaveBeenCalled();
    expect(dbMock.markEntryFilled).toHaveBeenCalledWith(318, 27253.25, "2026-08-20T14:00:00.000Z");
    expect(dbMock.closeTrade).toHaveBeenCalledTimes(1);
    expect(dbMock.closeTrade.mock.calls[0][0]).toMatchObject({ tradeId: 318, exitPrice: 27238 });
  });

  it("counts a fill Trade/search and the buffer both hold once", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([entryFill]);
    f.deps.bufferSlotFor = () => slotHolding([entryFill]);

    expect(await handleEntryClosedNoPosition(f.deps, pendingEntry(), ACCOUNT_ID)).not.toBeNull();

    expect(f.notifyEntry.mock.calls[0][3]).toBe(1);
  });

  it("still fails an entry no source saw fill", async () => {
    const f = fakes();

    await reconcileOneTrade(f.deps, pendingEntry(), ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(dbMock.markEntryFailed).toHaveBeenCalledWith(318, expect.any(String));
  });

  function submittedAgo(ms: number): StrategyTrade {
    return { ...pendingEntry(), entrySubmittedAt: new Date(Date.now() - ms).toISOString() };
  }

  function expectNothingWritten(f: Fakes): void {
    expect(dbMock.markEntryFailed).not.toHaveBeenCalled();
    expect(dbMock.markEntryFilled).not.toHaveBeenCalled();
    expect(dbMock.closeTrade).not.toHaveBeenCalled();
    expect(f.deps.releaseContractLock).not.toHaveBeenCalled();
    expect(f.logEvent.mock.calls.some((c) => c[0] === "entry_not_filled")).toBe(false);
  }

  // Fix pass: with the user hub down and the buffer empty, a failed
  // Trade/search is no evidence the entry did not fill.
  it("writes nothing and retries next tick when Trade/search failed", async () => {
    const f = fakes();
    f.searchTrades.mockRejectedValue(new Error("Topstep API error 503"));

    await reconcileOneTrade(f.deps, submittedAgo(5 * 60_000), ACCOUNT_ID, [], new Set<number>(), new Map());

    expectNothingWritten(f);
  });

  // Trade/search indexes seconds late; inside the pad an empty answer is
  // not yet an answer.
  it("writes nothing while the entry is younger than the late-arrival pad", async () => {
    const f = fakes();

    await reconcileOneTrade(f.deps, submittedAgo(10_000), ACCOUNT_ID, [], new Set<number>(), new Map());

    expectNothingWritten(f);
  });

  // The stale-entry sweep only takes an order still working, so this path
  // bounds itself: a row is not held pending (and the contract locked) by a
  // Trade/search that never recovers.
  it("stops deferring on a failing Trade/search once the entry is past the stale-entry age", async () => {
    const f = fakes();
    f.searchTrades.mockRejectedValue(new Error("Topstep API error 503"));

    await reconcileOneTrade(f.deps, submittedAgo(11 * 60_000), ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(dbMock.markEntryFailed).toHaveBeenCalledWith(318, expect.any(String));
  });

  // Fix pass: the Tradovate translator hardcodes `voided: false`, so a
  // per-copy check let the buffer's copy promote a fill Trade/search voided.
  it("does not let a buffered copy bring back a fill Trade/search reports voided", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([{ ...entryFill, voided: true }]);
    f.deps.bufferSlotFor = () => slotHolding([entryFill]);

    expect(await handleEntryClosedNoPosition(f.deps, pendingEntry(), ACCOUNT_ID)).toBeNull();

    expect(dbMock.markEntryFilled).not.toHaveBeenCalled();
  });

  it("drops a voided fill whichever source reports it voided", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([entryFill]);
    f.deps.bufferSlotFor = () => slotHolding([{ ...entryFill, voided: true }]);

    expect(await handleEntryClosedNoPosition(f.deps, pendingEntry(), ACCOUNT_ID)).toBeNull();

    expect(dbMock.markEntryFilled).not.toHaveBeenCalled();
  });

  // Fix pass: the sibling branch (order closed, position held) awaited the
  // fill-timestamp read and wrote `open` over whatever the hub wrote inside it.
  it("does not re-open a row the hub promoted and closed while the fill timestamp was being read", async () => {
    const f = fakes();
    const t = pendingEntry();
    f.searchTrades.mockResolvedValue([entryFill]);
    dbMock.getTradeById.mockReturnValue({ ...t, status: "closed" });

    await reconcileOneTrade(
      f.deps,
      t,
      ACCOUNT_ID,
      [],
      new Set<number>(),
      new Map([[CONTRACT_ID, { size: 1, avgPrice: 27253.25, type: 1 as const }]]),
    );

    expect(dbMock.markEntryFilled).not.toHaveBeenCalled();
    expect(f.logEvent.mock.calls.some((c) => c[0] === "entry_filled")).toBe(false);
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });

  it("still promotes in that branch when the row is still pending_entry after the read", async () => {
    const f = fakes();
    const t = pendingEntry();
    f.searchTrades.mockResolvedValue([entryFill]);
    dbMock.getTradeById.mockReturnValue(t);

    await reconcileOneTrade(
      f.deps,
      t,
      ACCOUNT_ID,
      [],
      new Set<number>(),
      new Map([[CONTRACT_ID, { size: 1, avgPrice: 27253.25, type: 1 as const }]]),
    );

    expect(dbMock.markEntryFilled).toHaveBeenCalledWith(318, 27253.25, "2026-08-20T14:00:00.000Z");
  });
});

/**
 * docs/bugs-fixed.md. The belated promotion used to rewrite the caller's row
 * object in place so the close branch below it saw `open`; it re-dispatches
 * a promoted copy instead, and the input is left as the caller passed it.
 */
describe("A12 — handleEntryClosedNoPosition does not mutate the trade it was handed", () => {
  it("closes the round trip without rewriting the input row", async () => {
    const f = fakes();
    f.searchTrades.mockResolvedValue([
      {
        id: 81,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        creationTimestamp: "2026-08-20T14:00:00.000Z",
        price: 21000,
        profitAndLoss: null,
        fees: null,
        side: SIDE_BUY,
        size: 1,
        voided: false,
        orderId: 556,
      },
    ]);
    f.deps.resolveExitFillPrice = async () => 21010;
    const t = trade({ id: 319, status: "pending_entry", entryOrderId: 556 });

    await reconcileOneTrade(f.deps, t, ACCOUNT_ID, [], new Set<number>(), new Map());

    expect(t.status).toBe("pending_entry");
    expect(t.entryPrice).toBeUndefined();
    expect(dbMock.closeTrade).toHaveBeenCalledTimes(1);
  });
});

// ── The 30-minute poll's orphan cross-check (A74) ───────────────────────────

/**
 * The reconciler's half of A74. It discarded the `RefreshResult` exactly as
 * boot did, so a `searchAccounts` throw on a registry that never warmed — or a
 * carried-forward arm that contributed nothing new — read as the broker saying
 * the account is gone, and every deployment on it was paused one-way.
 *
 * The same four rules as boot, driven through `reconcilePendingTrades` because
 * the cross-check only exists inside its refresh gate. The gate opens here on
 * the default fakes: no cached names and no prior attempt.
 */
describe("the periodic orphan cross-check attributes an absent account to a broker arm", () => {
  function absentAccount(): Fakes {
    const f = fakes();
    f.isAccountRegistered.mockReturnValue(false);
    return f;
  }

  it("does not orphan a Topstep account when the Topstep arm threw", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue("topstep");
    f.refreshBrokerRegistry.mockResolvedValue(armDown("topstep", "504 from /Account/search"));

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).not.toHaveBeenCalled();
  });

  it("names the account, the arm and the broker's error on every skip", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue("topstep");
    f.refreshBrokerRegistry.mockResolvedValue(armDown("topstep", "504 from /Account/search"));

    await reconcilePendingTrades(f.deps, [deployment()]);

    const call = f.logEvent.mock.calls.find((c) => c[0] === "orphan_check_skipped");
    expect(call).toBeDefined();
    const line = String(call?.[2]);
    expect(line).toContain(String(ACCOUNT_ID));
    expect(line).toContain("topstep");
    expect(line).toContain("504 from /Account/search");
    expect(call?.[3]).toMatchObject({ accountId: ACCOUNT_ID });
  });

  it("still orphans an account genuinely absent from a clean fan-out", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue("topstep");
    f.refreshBrokerRegistry.mockResolvedValue(cleanRefresh());

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).toHaveBeenCalledWith(ACCOUNT_ID, "periodic_account_check");
  });

  it("still orphans a Topstep account when it is the Tradovate arm that threw", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue("topstep");
    f.refreshBrokerRegistry.mockResolvedValue(armDown("tradovate", "ws handshake failed"));

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).toHaveBeenCalledWith(ACCOUNT_ID, "periodic_account_check");
  });

  it("skips an account with no persisted broker row when the refresh was partial", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue(null);
    f.refreshBrokerRegistry.mockResolvedValue(armDown("topstep", "504"));

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).not.toHaveBeenCalled();
    expect(f.logEvent.mock.calls.some((c) => c[0] === "orphan_check_skipped")).toBe(true);
  });

  it("orphans an account with no persisted broker row when every arm answered", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockReturnValue(null);
    f.refreshBrokerRegistry.mockResolvedValue(cleanRefresh());

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).toHaveBeenCalledWith(ACCOUNT_ID, "periodic_account_check");
  });

  it("reads the persisted row through the OrNull form, so unknown is not confirmed Topstep", async () => {
    const f = absentAccount();
    f.refreshBrokerRegistry.mockResolvedValue(armDown("topstep", "504"));

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(getAccountBrokerOrNullMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  /**
   * The log line the catch arm owes, and the bound on it. Only the success
   * path stamps `accountNamesRefreshedAt`, so a refresh that throws leaves the
   * names stale forever — and a gate reading `namesEmpty && retryAllowed ||
   * stale` re-entered on every 15s tick, fanning `searchAccounts` out across
   * every broker and logging a skip 240 times an hour.
   */
  function withEngineCursors(f: Fakes): { attemptAt: number } {
    // The engine's own two cursors, modelled: the getters read what the
    // setters wrote, which is the whole property the gate depends on. The
    // fixed `() => 0` fakes cannot express it — under them no attempt is ever
    // recorded, so `retryAllowed` is permanently true.
    const store = { attemptAt: 0, namesAt: 0 };
    f.deps.brokerRegistryLastAttemptAt = () => store.attemptAt;
    f.deps.setBrokerRegistryLastAttemptAt = (t: number) => {
      store.attemptAt = t;
    };
    f.deps.accountNamesRefreshedAt = () => store.namesAt;
    f.deps.setAccountNamesRefreshedAt = (t: number) => {
      store.namesAt = t;
    };
    // Names cached but stale, which is the arm that had no bound: `namesEmpty`
    // is false, so only `stale` can open the gate.
    f.deps.accountNames.set(ACCOUNT_ID, "50KTC-V2-100200-90020038");
    return store;
  }

  function skipEverythingLines(f: Fakes): string[] {
    return f.logEvent.mock.calls
      .filter((c) => c[0] === "orphan_check_skipped" && String(c[2]).includes("every account"))
      .map((c) => String(c[2]));
  }

  it("does not re-run a refresh that threw on the very next tick, stale names and all", async () => {
    const f = absentAccount();
    withEngineCursors(f);
    f.refreshBrokerRegistry.mockRejectedValue(new Error("504 from /Account/search"));

    await reconcilePendingTrades(f.deps, [deployment()]);
    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.refreshBrokerRegistry).toHaveBeenCalledTimes(1);
    expect(skipEverythingLines(f)).toHaveLength(1);
  });

  it("retries once the registry retry interval has passed", async () => {
    // The bound is a rate limit, not a latch: the cross-check still has to run
    // again, or a transient outage would stop orphan detection for good.
    const f = absentAccount();
    const store = withEngineCursors(f);
    f.refreshBrokerRegistry.mockRejectedValue(new Error("504 from /Account/search"));

    await reconcilePendingTrades(f.deps, [deployment()]);
    store.attemptAt = Date.now() - 61_000;
    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.refreshBrokerRegistry).toHaveBeenCalledTimes(2);
    expect(skipEverythingLines(f)[0]).toContain("504 from /Account/search");
  });

  // Fail-open stays; silent does not. A DB error reading the broker row used
  // to drop the whole cross-check inside a bare `catch {}`.
  it("logs a cross-check that threw instead of dropping it silently", async () => {
    const f = absentAccount();
    getAccountBrokerOrNullMock.mockImplementation(() => {
      throw new Error("database is locked");
    });

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.handleOrphanedAccount).not.toHaveBeenCalled();
    const call = f.logEvent.mock.calls.find((c) => c[0] === "orphan_check_skipped");
    expect(String(call?.[2])).toContain("database is locked");
  });
});

/**
 * Watchlist-2: which accounts a reconcile pass reads at all. The reconciler
 * reads an account only when it holds a reconcilable row, and the ghost sweep
 * only when the mirror holds a position, so a flat account with neither costs
 * no broker call. The gate must not be the mirror alone: an entry filled while
 * the user hub was down leaves the mirror flat over a live position, and the
 * row is what still gets that account read.
 */
describe("watchlist-2 — a reconcile pass reads only accounts with a row or a mirrored position", () => {
  async function pass(f: Fakes): Promise<void> {
    const reads = new PassPositionReads();
    await reconcilePendingTrades(f.deps, [deployment()], reads);
    await reconcileGhostPositions(f.deps, [deployment()], reads);
  }

  beforeEach(() => {
    resetAccountViewForTests();
  });

  it("skips a flat account with no open or reconcilable rows", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ position: null }));

    await pass(f);

    expect(f.searchOpenPositions).not.toHaveBeenCalled();
    expect(f.searchOpenOrders).not.toHaveBeenCalled();
  });

  it("still reads an account whose mirror is flat when it holds an open row", async () => {
    const f = fakes();
    f.states.set(DEPLOYMENT_ID, state({ position: null }));
    dbMock.listAccountsWithReconcilableTrades.mockReturnValueOnce([ACCOUNT_ID]);
    dbMock.getReconcilableTrades.mockReturnValueOnce([trade({ status: "open" })]);

    await pass(f);

    expect(f.searchOpenPositions).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(f.searchOpenOrders).toHaveBeenCalledWith(ACCOUNT_ID, { forceFresh: true });
  });

  it("reads an account whose mirror holds a position, with or without a row", async () => {
    const f = fakes({ positions: [brokerPosition(POSITION_TYPE_LONG, 1)] });
    f.states.set(DEPLOYMENT_ID, state({ position: openPosition(SIDE_BUY, 1) }));
    dbMock.getTradeById.mockReturnValueOnce(trade());

    await pass(f);

    expect(f.searchOpenPositions).toHaveBeenCalledTimes(1);
    expect(f.searchOpenPositions).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

/**
 * Watchlist-3: an approximated row whose fill Trade/search no longer returns
 * was asked about on every hourly pass for the 7 days the query keeps it. The
 * hourly sweep counts its passes; past the cap neither approximated sweep asks
 * again until restart, and the row says so once. And the hourly sweep runs for
 * every account with an approximated row, whatever else the pass has to do —
 * behind the pending-row and realtime-feed gates it never reached an account
 * whose only work was that row (bugs-fixed.md).
 */
describe("watchlist-3 — the approximated sweeps stop asking about a row past the cap", () => {
  const CAP = 24;
  const stuck = trade({
    id: 77,
    status: "closed",
    exitApproximated: true,
    exitResolutionSource: "approximated",
    entryOrderId: 10,
    exitOrderId: 11,
    entryFilledAt: "2026-08-20T14:00:01.000Z",
    exitFilledAt: "2026-08-20T14:20:00.000Z",
  });
  // The heal's read and the validation's: what one hourly pass asks per row.
  const READS_PER_ROW_PASS = 2;

  beforeEach(() => {
    dbMock.listAllAccountsWithApproximatedTrades.mockReturnValue([ACCOUNT_ID]);
    dbMock.getApproximatedClosedTrades.mockReturnValue([stuck]);
  });

  afterEach(() => {
    dbMock.listAllAccountsWithApproximatedTrades.mockReturnValue([]);
    dbMock.getApproximatedClosedTrades.mockReturnValue([]);
    dbMock.getTradesNeedingTimestampHeal.mockReturnValue([]);
    dbMock.getReconcilableTrades.mockReturnValue([]);
  });

  /** One reconciler pass over an account whose only work is the approximated
   *  row; `due` rewinds the hourly cursor first. Answers the Trade/search
   *  reads the pass made. */
  async function reconcilerPass(f: Fakes, due = true): Promise<number> {
    if (due) f.deps.lastHourlyValidationSweepAt.delete(ACCOUNT_ID);
    const before = f.searchTrades.mock.calls.length;
    await reconcilePendingTrades(f.deps, []);
    return f.searchTrades.mock.calls.length - before;
  }

  const capWarnings = (f: Fakes) =>
    f.log.mock.calls.filter((c) => c[1] === "warn" && String(c[3]).includes("Trade #77 exit is still approximated"));

  it("sweeps an account whose only work is approximated closed rows", async () => {
    const f = fakes();

    expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
    // No reconcilable row, so no order or position read.
    expect(f.searchOpenOrders).not.toHaveBeenCalled();
    expect(f.deps.approximatedSweepPasses.get(stuck.id)).toBe(1);
  });

  it("sweeps while the realtime feed suppresses polling", async () => {
    const f = fakes();
    vi.mocked(f.deps.realtimeSuppressesPolling).mockReturnValue(true);
    dbMock.getReconcilableTrades.mockReturnValue([trade({ id: 79, status: "open" })]);

    expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
    expect(f.searchOpenOrders).not.toHaveBeenCalled();
  });

  it("sweeps on a pass whose orders/positions read failed for the account's pending row", async () => {
    const f = fakes();
    dbMock.getReconcilableTrades.mockReturnValue([trade({ id: 79, status: "open" })]);
    f.searchOpenOrders.mockRejectedValue(new Error("Topstep API error 503 on /api/Order/searchOpen"));

    expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
    expect(f.searchOpenOrders).toHaveBeenCalledTimes(1);
    expect(f.deps.approximatedSweepPasses.get(stuck.id)).toBe(1);
  });

  it("warns once an hour, not every tick, when the approximated-row query throws", async () => {
    const f = fakes();
    dbMock.getApproximatedClosedTrades.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const sweepFailures = () =>
      f.log.mock.calls.filter((c) => c[1] === "warn" && String(c[3]).includes("Approximated sweep for account"));

    await reconcilerPass(f);
    await reconcilerPass(f, false);

    expect(sweepFailures()).toHaveLength(1);
  });

  it("does not ask again on a second pass inside the hour", async () => {
    const f = fakes();
    await reconcilerPass(f);

    expect(await reconcilerPass(f, false)).toBe(0);
    expect(f.deps.approximatedSweepPasses.get(stuck.id)).toBe(1);
  });

  it("costs no Trade/search call on an account with no approximated rows", async () => {
    const f = fakes();
    dbMock.listAllAccountsWithApproximatedTrades.mockReturnValue([]);
    dbMock.getApproximatedClosedTrades.mockReturnValue([]);

    await reconcilePendingTrades(f.deps, [deployment()]);

    expect(f.searchTrades).not.toHaveBeenCalled();
  });

  it(`asks Trade/search about the row on each of the first ${CAP} hourly passes`, async () => {
    const f = fakes();
    for (let i = 0; i < CAP; i++) {
      expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
    }
    expect(capWarnings(f)).toHaveLength(0);
  });

  it("skips the row on the next pass and every one after, and says so once", async () => {
    const f = fakes();
    for (let i = 0; i < CAP; i++) await reconcilerPass(f);

    expect(await reconcilerPass(f)).toBe(0);
    expect(await reconcilerPass(f)).toBe(0);
    expect(capWarnings(f)).toHaveLength(1);
  });

  it("does not spend the cap on the timestamp heal's every-tick heal loop", async () => {
    const f = fakes();
    // A row with nothing left to heal, so `healTradeTimestamps` runs past its
    // early return and reaches its heal loop.
    dbMock.getTradesNeedingTimestampHeal.mockReturnValue([
      trade({ id: 78, status: "open", entryFilledAt: "2026-08-20T14:00:01.000Z" }),
    ]);
    for (let i = 0; i < CAP + 1; i++) await healTradeTimestamps(f.deps, ACCOUNT_ID);

    expect(f.deps.approximatedSweepPasses.get(stuck.id) ?? 0).toBe(0);
    expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
  });

  it("does not spend the cap on a pass whose Trade/search read failed", async () => {
    const f = fakes({
      searchTrades: async () => {
        throw new Error("Topstep API error 503 on /api/Trade/search");
      },
    });

    for (let i = 0; i < CAP + 1; i++) await reconcilerPass(f);

    expect(f.deps.approximatedSweepPasses.get(stuck.id) ?? 0).toBe(0);
    expect(capWarnings(f)).toHaveLength(0);
    // Uncounted, so the row is still asked about.
    expect(await reconcilerPass(f)).toBe(READS_PER_ROW_PASS);
  });
});
