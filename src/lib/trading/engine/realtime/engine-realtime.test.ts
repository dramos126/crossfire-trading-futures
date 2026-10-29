/**
 * D4 extracted the realtime event cluster; these are the tests the
 * extraction made possible. Everything here runs the shipped function
 * over a `RealtimeDeps` literal — no engine, no registry, no socket —
 * which is the whole point, because this is E4 code that has never been
 * driven against a real transport.
 *
 * Five subjects, each chosen because a wrong answer is silent:
 *
 *  - `replayWindow` was two identical copies of a cap-and-pad rule, one
 *    per broker, and nothing enforced that they matched.
 *  - `wireRealtimeAdapters` is where `realtimeEventsAllowed` is consulted.
 *    engine.test.ts covers the gate's per-broker semantics; what is
 *    covered here is that all four handlers actually ask, which is the
 *    half a new handler gets wrong.
 *  - The two reconnect replays decide how much fill history is fetched.
 *    Too narrow drops fills silently into the approximation path.
 *  - `appendBufferedFill`'s orderId-stamping arm writes to a closed trade
 *    row from a WS replay stream that includes prior round-trips.
 *  - `handleUserPositionClose`'s grace guard is an await on the exit
 *    path, which engine.md's exit hard rule is explicitly about.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    backfillExitOrderId: vi.fn(),
    findRecentApproximatedTradeByAccountContract: vi.fn<(a: number, c: string) => unknown>(
      () => null,
    ),
    findTradeByAccountContract: vi.fn<(a: number, c: string) => unknown>(() => null),
    getTradeById: vi.fn<(id: number) => unknown>(() => null),
    markEntryFilled: vi.fn(),
  },
}));
vi.mock("@/lib/db/trades", () => dbMock);

const { peekBroadcasterMock } = vi.hoisted(() => ({
  peekBroadcasterMock: vi.fn<() => unknown>(() => null),
}));
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: peekBroadcasterMock,
}));

import { BrokerKind } from "@/lib/db/account-brokers";
import type { BrokerCapabilities, BrokerRealtimeAdapter } from "@/lib/brokers/plugin";
import type { GatewayTrade } from "@/lib/brokers/topstep/signalr";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import { TradovateRealtimeAdapter, type TradovateSubscriber } from "@/lib/brokers/tradovate/realtime-adapter";
import type { BarData, Order, Position, RealtimeStatusSnapshot, TradeFill } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Timeframe } from "@/lib/trading/domain";
import { BarAggregator } from "../../bar-aggregator";
import type { Broker } from "../../broker-access/broker";
import type { BufferSlot, ContractSub, MarketSub } from "../engine";
import {
  appendBufferedFill,
  handleTrade,
  handleUserPositionClose,
  handleUserPositionEvent,
  replayTopstepFillsAfterReconnect,
  replayTradovateFillsAfterReconnect,
  replayWindow,
  wireRealtimeAdapters,
  type RealtimeDeps,
} from "./engine-realtime";
import {
  freshOrders,
  freshPositions,
  recordOrders,
  recordPositions,
  resetAccountViewForTests,
} from "./account-view";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAD_MS = 60_000;
const NOW = Date.parse("2026-06-01T15:00:00.000Z");

const BASE_CAPABILITIES: BrokerCapabilities = {
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

function makeSlot(accountId: number, contractId = "NQ-2026", tradeId = 1): BufferSlot {
  return { accountId, contractId, tradeId, openedAt: NOW, fills: [], dedup: new Set() };
}

function makeFill(overrides: Partial<TradeFill> = {}): TradeFill {
  return {
    id: 1,
    accountId: 1001,
    contractId: "NQ-2026",
    creationTimestamp: "2026-06-01T14:45:00.000Z",
    price: 20100,
    profitAndLoss: null,
    fees: 0,
    side: 1,
    size: 1,
    voided: false,
    orderId: 901,
    ...overrides,
  } as TradeFill;
}

type StubBroker = {
  searchTrades: ReturnType<typeof vi.fn>;
  searchOpenOrders: ReturnType<typeof vi.fn>;
  searchOpenPositions: ReturnType<typeof vi.fn>;
};

function makeBroker(
  searchTrades: ReturnType<typeof vi.fn> = vi.fn(async () => [] as TradeFill[]),
): StubBroker {
  return {
    searchTrades,
    searchOpenOrders: vi.fn(async () => [] as Order[]),
    searchOpenPositions: vi.fn(async () => [] as Position[]),
  };
}

const asBroker = (b: StubBroker): Broker => b as unknown as Broker;

type Deps = RealtimeDeps & { broker: StubBroker };

/** Every member a `vi.fn` so any test can assert on any seam, with the
 *  handful that must answer something answering the inert value. */
function makeDeps(over: Partial<RealtimeDeps> = {}): Deps {
  const broker = makeBroker();
  const deps: RealtimeDeps = {
    log: vi.fn(),
    logEvent: vi.fn(),
    brokerForAccount: vi.fn(() => asBroker(broker)),
    brokerKindFor: vi.fn(() => BrokerKind.Topstep),
    pluginIdFor: vi.fn((k) => k as string),
    capabilitiesFor: vi.fn(() => BASE_CAPABILITIES),
    realtimeAdapters: vi.fn(() => []),
    realtimeEventsAllowed: vi.fn(() => true),
    noteRealtimeEvent: vi.fn(),
    replayFillsAfterReconnect: vi.fn(async () => {}),
    handleUserPositionEvent: vi.fn(async () => {}),
    handleUserPositionClose: vi.fn(async () => {}),
    appendBufferedFill: vi.fn(),
    stateFor: vi.fn(() => undefined),
    markEnteredThisSession: vi.fn(),
    entryNotifiedTradeIds: new Set<number>(),
    notifyEntry: vi.fn(async () => {}),
    bufferSlotKey: vi.fn((a, c, t) => `${a}:${c}:${t}`),
    bufferContractKey: vi.fn((a, c) => `${a}:${c}`),
    openBufferSlot: vi.fn(),
    discardBufferSlot: vi.fn(),
    bufferSlotFor: vi.fn(() => undefined),
    bufferSlots: vi.fn(() => [][Symbol.iterator]() as IterableIterator<BufferSlot>),
    slotKeyForContract: vi.fn(() => undefined),
    recentDedupFor: vi.fn(() => undefined),
    reconcileExitFromBuffer: vi.fn(() => null),
    reconcileOneTrade: vi.fn(async () => {}),
    healApproximatedExitFromFills: vi.fn(async () => true),
    validateClosedTradePrices: vi.fn(async () => {}),
    lastTopstepEventAt: vi.fn(() => undefined),
    noteTradeActivity: vi.fn(),
    noteMarketTrade: vi.fn(),
    marketSubFor: vi.fn(() => undefined),
    contractSubFor: vi.fn(() => undefined),
    evaluateRealtimeExits: vi.fn(async () => {}),
    ...over,
  };
  return Object.assign(deps, { broker }) as Deps;
}

/** Captures the four handlers the wiring registers, the way an adapter
 *  would, so a test can fire them. */
class CapturingAdapter {
  position: Array<(a: number, p: Position) => void> = [];
  fill: Array<(a: number, f: TradeFill) => void> = [];
  order: Array<(a: number, o: Order) => void> = [];
  reconnect: Array<(a: number) => void> = [];

  onPosition(h: (a: number, p: Position) => void) {
    this.position.push(h);
  }
  onFill(h: (a: number, f: TradeFill) => void) {
    this.fill.push(h);
  }
  onOrder(h: (a: number, o: Order) => void) {
    this.order.push(h);
  }
  onReconnect(h: (a: number) => void) {
    this.reconnect.push(h);
  }

  fireAll(accountId: number): void {
    for (const h of this.position) h(accountId, { contractId: "NQ-2026", size: 0 } as Position);
    for (const h of this.fill) h(accountId, makeFill());
    for (const h of this.order) h(accountId, { id: 5, status: 2, size: 1 } as Order);
    for (const h of this.reconnect) h(accountId);
  }

  asAdapter(): BrokerRealtimeAdapter {
    return this as unknown as BrokerRealtimeAdapter;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.findTradeByAccountContract.mockReturnValue(null);
  dbMock.findRecentApproximatedTradeByAccountContract.mockReturnValue(null);
  dbMock.getTradeById.mockReturnValue(null);
  peekBroadcasterMock.mockReturnValue(null);
});

describe("replayWindow", () => {
  it("anchors the lower bound on the account's last event when it is inside the cap", () => {
    const lastEvent = NOW - 5 * 60_000;
    expect(replayWindow(lastEvent, NOW).startMs).toBe(lastEvent);
  });

  it("floors the lower bound at the 24h cap when the anchor is older", () => {
    expect(replayWindow(NOW - 3 * DAY_MS, NOW).startMs).toBe(NOW - DAY_MS);
  });

  it("uses the whole cap when the account has delivered no event this process", () => {
    expect(replayWindow(0, NOW).startMs).toBe(NOW - DAY_MS);
  });

  it("pads the upper bound past now so a fill indexed after the reconnect is still in range", () => {
    expect(replayWindow(NOW, NOW).endMs).toBe(NOW + PAD_MS);
  });
});

describe("wireRealtimeAdapters — every handler consults the gate", () => {
  it("dispatches nothing on any of the four events when the gate refuses", () => {
    const adapter = new CapturingAdapter();
    const deps = makeDeps({
      realtimeAdapters: () => [adapter.asAdapter()],
      realtimeEventsAllowed: vi.fn(() => false),
    });

    wireRealtimeAdapters(deps);
    adapter.fireAll(1001);

    expect(deps.realtimeEventsAllowed).toHaveBeenCalledTimes(4);
    expect(deps.handleUserPositionEvent).not.toHaveBeenCalled();
    expect(deps.appendBufferedFill).not.toHaveBeenCalled();
    expect(deps.replayFillsAfterReconnect).not.toHaveBeenCalled();
    expect(deps.noteRealtimeEvent).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("dispatches all four when the gate allows", () => {
    const adapter = new CapturingAdapter();
    const deps = makeDeps({
      realtimeAdapters: () => [adapter.asAdapter()],
      pluginIdFor: vi.fn(() => "tradovate"),
    });

    wireRealtimeAdapters(deps);
    adapter.fireAll(1001);

    expect(deps.handleUserPositionEvent).toHaveBeenCalledTimes(1);
    expect(deps.appendBufferedFill).toHaveBeenCalledTimes(1);
    expect(deps.replayFillsAfterReconnect).toHaveBeenCalledTimes(1);
  });

  it("patches the account view from position and order frames between sweeps", () => {
    resetAccountViewForTests();
    recordPositions(1001, [{ contractId: "NQ-2026", size: 1 } as Position], "sweep");
    recordOrders(1001, [{ id: 5, status: 1, size: 1 } as Order], "sweep");
    const adapter = new CapturingAdapter();
    const deps = makeDeps({ realtimeAdapters: () => [adapter.asAdapter()] });

    wireRealtimeAdapters(deps);
    adapter.fireAll(1001); // size-0 position frame, Filled order frame

    expect(freshPositions(1001)?.items).toEqual([]);
    expect(freshPositions(1001)?.source).toBe("hub");
    expect(freshOrders(1001)?.items).toEqual([]);
    expect(freshOrders(1001)?.source).toBe("hub");
  });

  it("hands a position frame to the money handler before the display write, so a throw in the view cannot skip it", () => {
    resetAccountViewForTests();
    // A null row makes the view's patch throw — the stand-in for any defect in
    // the display write.
    recordPositions(1001, [null as unknown as Position], "sweep");
    const adapter = new CapturingAdapter();
    const deps = makeDeps({ realtimeAdapters: () => [adapter.asAdapter()] });
    wireRealtimeAdapters(deps);

    expect(() => adapter.position[0](1001, { contractId: "NQ-2026", size: 0 } as Position)).toThrow();
    expect(deps.handleUserPositionEvent).toHaveBeenCalledTimes(1);
  });

  it("leaves the account view alone when the gate refuses", () => {
    resetAccountViewForTests();
    recordPositions(1001, [{ contractId: "NQ-2026", size: 1 } as Position], "sweep");
    const adapter = new CapturingAdapter();
    const deps = makeDeps({
      realtimeAdapters: () => [adapter.asAdapter()],
      realtimeEventsAllowed: vi.fn(() => false),
    });

    wireRealtimeAdapters(deps);
    adapter.fireAll(1001);

    expect(freshPositions(1001)?.source).toBe("sweep");
    expect(freshPositions(1001)?.items).toHaveLength(1);
  });

  it("maps a position event onto the payload the close/entry fast paths read", () => {
    const adapter = new CapturingAdapter();
    const deps = makeDeps({ realtimeAdapters: () => [adapter.asAdapter()] });

    wireRealtimeAdapters(deps);
    for (const h of adapter.position) {
      h(1001, {
        contractId: "NQ-2026",
        size: 2,
        averagePrice: 20100,
        creationTimestamp: "2026-06-01T15:00:00.000Z",
      } as Position);
    }

    expect(deps.handleUserPositionEvent).toHaveBeenCalledWith({
      accountId: 1001,
      contractId: "NQ-2026",
      size: 2,
      averagePrice: 20100,
      creationTimestamp: "2026-06-01T15:00:00.000Z",
    });
  });

  it("anchors the event clock on position, fill and order — but not on a reconnect", () => {
    const adapter = new CapturingAdapter();
    const deps = makeDeps({ realtimeAdapters: () => [adapter.asAdapter()] });

    wireRealtimeAdapters(deps);
    adapter.fireAll(1001);

    // A reconnect is the absence of events, not evidence of one: stamping
    // it would collapse the replay window it exists to open.
    expect(deps.noteRealtimeEvent).toHaveBeenCalledTimes(3);
  });

  it("logs order events for Tradovate only", () => {
    const topstep = new CapturingAdapter();
    const topstepDeps = makeDeps({
      realtimeAdapters: () => [topstep.asAdapter()],
      pluginIdFor: vi.fn(() => "topstep"),
    });
    wireRealtimeAdapters(topstepDeps);
    for (const h of topstep.order) h(1001, { id: 5, status: 2, size: 1 } as Order);
    expect(topstepDeps.logEvent).not.toHaveBeenCalled();

    const tradovate = new CapturingAdapter();
    const tradovateDeps = makeDeps({
      realtimeAdapters: () => [tradovate.asAdapter()],
      pluginIdFor: vi.fn(() => "tradovate"),
    });
    wireRealtimeAdapters(tradovateDeps);
    for (const h of tradovate.order) h(1001, { id: 5, status: 2, size: 1 } as Order);
    expect(tradovateDeps.logEvent).toHaveBeenCalledTimes(1);
  });

  it("names the raw order and fill frames as debug events, not as info lines", () => {
    // Gate decision 2: the frames are `debug` so prod drops them at the
    // pipe. The event is what carries the severity — a `deps.log` here
    // would put them back at `info` however the message is worded.
    const adapter = new CapturingAdapter();
    const deps = makeDeps({
      realtimeAdapters: () => [adapter.asAdapter()],
      pluginIdFor: vi.fn(() => "tradovate"),
    });
    wireRealtimeAdapters(deps);
    for (const h of adapter.order) h(1001, { id: 5, status: 2, size: 1, contractId: "NQ-2026" } as Order);
    for (const h of adapter.fill) h(1001, makeFill({ id: 7, contractId: "NQ-2026" }));

    expect(deps.log).not.toHaveBeenCalled();
    expect(vi.mocked(deps.logEvent).mock.calls.map((c) => c[0])).toEqual([
      "order_frame",
      "fill_frame",
    ]);
    expect(vi.mocked(deps.logEvent).mock.calls[0][3]).toEqual({
      accountId: 1001,
      contractId: "NQ-2026",
    });
  });

  it("names the user-hub position frame as a debug event for both brokers", async () => {
    const deps = makeDeps();
    await handleUserPositionEvent(deps, {
      accountId: 1001,
      contractId: "NQ-2026",
      size: 0,
      averagePrice: 0,
      creationTimestamp: "2026-06-01T15:00:00.000Z",
    });
    expect(vi.mocked(deps.logEvent).mock.calls[0][0]).toBe("position_frame");
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("logs a rejected reconnect replay instead of leaving the promise unhandled", async () => {
    const adapter = new CapturingAdapter();
    const deps = makeDeps({
      realtimeAdapters: () => [adapter.asAdapter()],
      replayFillsAfterReconnect: vi.fn(async () => {
        throw new Error("hub still down");
      }),
    });

    wireRealtimeAdapters(deps);
    for (const h of adapter.reconnect) h(1001);
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.logEvent).toHaveBeenCalledWith(
      "replay_failed",
      "engine",
      expect.stringContaining("hub still down"),
      expect.anything(),
    );
  });

  it("registers on every adapter the registry reports", () => {
    const a = new CapturingAdapter();
    const b = new CapturingAdapter();
    const deps = makeDeps({ realtimeAdapters: () => [a.asAdapter(), b.asAdapter()] });

    wireRealtimeAdapters(deps);

    expect(a.position).toHaveLength(1);
    expect(b.position).toHaveLength(1);
  });
});

describe("replayTopstepFillsAfterReconnect", () => {
  it("collapses several slots on one account into a single broker call", async () => {
    const deps = makeDeps({
      bufferSlots: () =>
        [makeSlot(1001, "NQ-2026", 1), makeSlot(1001, "ES-2026", 2)][
          Symbol.iterator
        ]() as IterableIterator<BufferSlot>,
    });

    await replayTopstepFillsAfterReconnect(deps);

    expect(deps.broker.searchTrades).toHaveBeenCalledTimes(1);
  });

  it("skips slots belonging to another broker entirely", async () => {
    const deps = makeDeps({
      bufferSlots: () =>
        [makeSlot(2001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      pluginIdFor: vi.fn(() => "tradovate"),
    });

    await replayTopstepFillsAfterReconnect(deps);

    expect(deps.broker.searchTrades).not.toHaveBeenCalled();
  });

  it("asks for the window replayWindow computes from the account's anchor", async () => {
    const anchor = NOW - 90_000;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = makeDeps({
      bufferSlots: () => [makeSlot(1001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      lastTopstepEventAt: vi.fn(() => anchor),
    });

    await replayTopstepFillsAfterReconnect(deps);

    expect(deps.broker.searchTrades).toHaveBeenCalledWith(
      1001,
      new Date(anchor).toISOString(),
      new Date(NOW + PAD_MS).toISOString(),
    );
    vi.mocked(Date.now).mockRestore();
  });

  it("feeds every fetched fill back through the buffer under the Topstep kind", async () => {
    const fills = [makeFill({ id: 7 }), makeFill({ id: 8 })];
    const broker = makeBroker(vi.fn(async () => fills));
    const deps = makeDeps({
      bufferSlots: () => [makeSlot(1001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      brokerForAccount: vi.fn(() => asBroker(broker)),
    });

    await replayTopstepFillsAfterReconnect(deps);

    expect(deps.appendBufferedFill).toHaveBeenCalledTimes(2);
    expect(deps.appendBufferedFill).toHaveBeenCalledWith(BrokerKind.Topstep, 1001, fills[0]);
  });

  it("warns and moves to the next account when one account's fetch throws", async () => {
    const broker = makeBroker(
      vi.fn(async (accountId: number) => {
        if (accountId === 1001) throw new Error("rate limited");
        return [] as TradeFill[];
      }),
    );
    const deps = makeDeps({
      bufferSlots: () =>
        [makeSlot(1001), makeSlot(1002)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      brokerForAccount: vi.fn(() => asBroker(broker)),
    });

    await replayTopstepFillsAfterReconnect(deps);

    expect(broker.searchTrades).toHaveBeenCalledTimes(2);
    expect(deps.logEvent).toHaveBeenCalledWith(
      "replay_failed",
      "engine",
      expect.stringContaining("rate limited"),
      expect.anything(),
    );
  });
});

describe("replayTradovateFillsAfterReconnect", () => {
  it("does not call the broker when no slot on this account is open", async () => {
    const deps = makeDeps({ pluginIdFor: vi.fn(() => "tradovate") });

    await replayTradovateFillsAfterReconnect(deps, 2001, NOW - 30_000);

    expect(deps.broker.searchTrades).not.toHaveBeenCalled();
  });

  it("does nothing for a non-Tradovate account even with a slot and an anchor", async () => {
    const deps = makeDeps({
      pluginIdFor: vi.fn(() => "topstep"),
      bufferSlots: () => [makeSlot(1001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
    });

    await replayTradovateFillsAfterReconnect(deps, 1001, NOW - 30_000);

    expect(deps.broker.searchTrades).not.toHaveBeenCalled();
  });

  // This is the window the ordinary-reconnect bug was about: the anchor is
  // the pre-drop event time the signal carries, never the new socket's
  // handshake, so a gap longer than the pad still replays from before it.
  it("takes its window anchor from the signal, so a fill inside a gap is in range", async () => {
    const anchor = NOW - 90_000; // gap longer than the 60s pad
    const fillInGap = NOW - 45_000;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = makeDeps({
      pluginIdFor: vi.fn(() => "tradovate"),
      bufferSlots: () => [makeSlot(2001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
    });

    await replayTradovateFillsAfterReconnect(deps, 2001, anchor);

    expect(deps.broker.searchTrades).toHaveBeenCalledWith(
      2001,
      new Date(anchor).toISOString(),
      new Date(NOW + PAD_MS).toISOString(),
    );
    const [, startIso, endIso] = vi.mocked(deps.broker.searchTrades).mock.calls[0];
    expect(new Date(startIso as string).getTime()).toBeLessThanOrEqual(fillInGap);
    expect(new Date(endIso as string).getTime()).toBeGreaterThanOrEqual(fillInGap);
    vi.mocked(Date.now).mockRestore();
  });

  // A reconnect with no real gap — the last event was moments ago — windows
  // within the pad, not the full 24h lookback the now-anchored bug produced.
  it("windows within the pad when the pre-drop anchor is recent", async () => {
    const anchor = NOW - 500;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = makeDeps({
      pluginIdFor: vi.fn(() => "tradovate"),
      bufferSlots: () => [makeSlot(2001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
    });

    await replayTradovateFillsAfterReconnect(deps, 2001, anchor);

    expect(deps.broker.searchTrades).toHaveBeenCalledWith(
      2001,
      new Date(anchor).toISOString(),
      new Date(NOW + PAD_MS).toISOString(),
    );
    vi.mocked(Date.now).mockRestore();
  });

  // The Topstep twin asserts this; the Tradovate arm did not, and the
  // consequence of a regression here is a money bug rather than a cosmetic
  // one. `appendBufferedFill` dedups on `${brokerKind}:${accountId}:${id}`
  // against the slot's own set — so a replayed fill fed back under the wrong
  // kind misses the dedup, is pushed a second time, and
  // `reconcileExitFromBuffer` sums a duplicated closing fill: doubled exit
  // size, doubled fees, wrong PnL, written to the row as authoritative
  // `exit_resolution_source = 'buffer'`. Silent, and only on a Tradovate
  // account that reconnects mid-trade.
  it("feeds fills back under the Tradovate kind so slot dedup matches the WS copy", async () => {
    const fills = [makeFill({ id: 7 })];
    const broker = makeBroker(vi.fn(async () => fills));
    const deps = makeDeps({
      pluginIdFor: vi.fn(() => "tradovate"),
      bufferSlots: () => [makeSlot(2001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      brokerForAccount: vi.fn(() => asBroker(broker)),
    });

    await replayTradovateFillsAfterReconnect(deps, 2001, NOW - 30_000);

    expect(deps.appendBufferedFill).toHaveBeenCalledWith(
      BrokerKind.Tradovate,
      2001,
      fills[0],
    );
  });
});

/** The subscriber seam the real adapter drives, with no socket behind it. */
class SilentSubscriber implements TradovateSubscriber {
  snapshot: RealtimeStatusSnapshot = {
    state: "connecting",
    lastEventAt: 0,
    subscribedAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };
  private subscribedHandler: ((accountId: number) => void) | null = null;
  constructor(readonly accountId: number) {}
  async start(): Promise<void> {}
  dispose(): void {}
  status(): RealtimeStatusSnapshot {
    return this.snapshot;
  }
  onPosition(): void {}
  onOrder(): void {}
  onFill(): void {}
  onReconnect(): void {}
  onSubscribed(h: (accountId: number) => void): void {
    this.subscribedHandler = h;
  }
  /** The authorize ack, which has already moved `lastEventAt` to `at`. */
  subscribe(at: number): void {
    this.snapshot = { ...this.snapshot, state: "subscribed", lastEventAt: at, subscribedAt: at };
    this.subscribedHandler?.(this.accountId);
  }
}

function tradovateClientDouble(): TradovateClient {
  return {
    getUserId: () => 4242,
    getToken: () => "tok",
    needsRefresh: () => false,
    validateSession: async () => {},
    getTokenExpiresAt: () => NOW + DAY_MS,
    getDatedSymbolForContractId: () => null,
    warmContractId: async () => {},
    warmContractIdsForRoots: async () => {},
  } as unknown as TradovateClient;
}

// The adapter remembers the old feed's last event across the rotation and
// hands it to the engine's replay on the reconnect signal — the same channel
// an ordinary reconnect uses for its pre-drop anchor. This drives the shipped
// replay through the shipped adapter end to end, with no `status()` read in
// the path.
describe("replayTradovateFillsAfterReconnect — a credential rotation, through the real adapter", () => {
  it("windows from the old feed's last event, not the new socket's handshake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const OLD_FEED_LAST_EVENT = NOW - 2_500;
    const subs = new Map<number, SilentSubscriber>();
    let client = tradovateClientDouble();
    const adapter = new TradovateRealtimeAdapter({
      getClient: () => client,
      resolverSymbolLookup: () => null,
      enumerateWarmRoots: () => [],
      log: vi.fn(),
      createSubscriber: (opts) => {
        const sub = new SilentSubscriber(opts.accountId);
        subs.set(opts.accountId, sub);
        return sub;
      },
    });
    const deps: Deps = makeDeps({
      brokerKindFor: vi.fn(() => BrokerKind.Tradovate),
      pluginIdFor: vi.fn(() => "tradovate"),
      realtimeAdapters: () => [adapter],
      bufferSlots: () => [makeSlot(2001)][Symbol.iterator]() as IterableIterator<BufferSlot>,
      replayFillsAfterReconnect: (accountId, lastEventAt) =>
        replayTradovateFillsAfterReconnect(deps, accountId, lastEventAt),
    });
    wireRealtimeAdapters(deps);

    await adapter.sync(new Set([2001]));
    subs.get(2001)!.subscribe(OLD_FEED_LAST_EVENT);
    client = tradovateClientDouble();
    await adapter.sync(new Set([2001]));
    subs.get(2001)!.subscribe(NOW);

    await vi.waitFor(() => expect(deps.broker.searchTrades).toHaveBeenCalled());
    expect(deps.broker.searchTrades).toHaveBeenCalledWith(
      2001,
      new Date(OLD_FEED_LAST_EVENT).toISOString(),
      new Date(NOW + PAD_MS).toISOString(),
    );
    vi.mocked(Date.now).mockRestore();
  });
});

describe("appendBufferedFill — stamping an exit orderId onto a stuck row", () => {
  const stuck = {
    id: 42,
    deploymentId: "d1",
    side: 0,
    entryOrderId: 900,
    entryFilledAt: "2026-06-01T14:30:00.000Z",
    entrySubmittedAt: "2026-06-01T14:29:00.000Z",
  } as StrategyTrade;

  function depsForStuckRow(historicalFillsRequireOrderLookup: boolean): Deps {
    dbMock.findRecentApproximatedTradeByAccountContract.mockReturnValue(stuck);
    return makeDeps({
      capabilitiesFor: vi.fn(() => ({
        ...BASE_CAPABILITIES,
        historicalFillsRequireOrderLookup,
      })),
    });
  }

  it("does not look for a stuck row at all when the broker's fill history is time-rangeable", () => {
    const deps = depsForStuckRow(false);

    appendBufferedFill(deps, BrokerKind.Topstep, 1001, makeFill());

    expect(dbMock.findRecentApproximatedTradeByAccountContract).not.toHaveBeenCalled();
    expect(dbMock.backfillExitOrderId).not.toHaveBeenCalled();
  });

  it("stamps and triggers an immediate heal for a post-entry closing-side fill", () => {
    const deps = depsForStuckRow(true);

    appendBufferedFill(deps, BrokerKind.Tradovate, 1001, makeFill({ side: 1, orderId: 901 }));

    expect(dbMock.backfillExitOrderId).toHaveBeenCalledWith(42, 901);
    expect(deps.healApproximatedExitFromFills).toHaveBeenCalledWith(stuck, 1001);
  });

  it("ignores a fill on the entry side", () => {
    const deps = depsForStuckRow(true);

    appendBufferedFill(deps, BrokerKind.Tradovate, 1001, makeFill({ side: 0, orderId: 901 }));

    expect(dbMock.backfillExitOrderId).not.toHaveBeenCalled();
  });

  it("ignores the entry order's own fill", () => {
    const deps = depsForStuckRow(true);

    appendBufferedFill(deps, BrokerKind.Tradovate, 1001, makeFill({ side: 1, orderId: 900 }));

    expect(dbMock.backfillExitOrderId).not.toHaveBeenCalled();
  });

  it("ignores a fill that predates the entry — the WS replay carries prior round-trips", () => {
    const deps = depsForStuckRow(true);

    appendBufferedFill(
      deps,
      BrokerKind.Tradovate,
      1001,
      makeFill({ side: 1, orderId: 901, creationTimestamp: "2026-06-01T13:00:00.000Z" }),
    );

    expect(dbMock.backfillExitOrderId).not.toHaveBeenCalled();
  });

  it("drops a cross-slot redelivery before any slot-creation side effect", () => {
    const deps = makeDeps({
      recentDedupFor: vi.fn(() => new Set(["topstep:1001:1"])),
    });

    appendBufferedFill(deps, BrokerKind.Topstep, 1001, makeFill({ id: 1 }));

    expect(deps.openBufferSlot).not.toHaveBeenCalled();
    expect(deps.slotKeyForContract).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "engine",
      "warn",
      "trade",
      expect.stringContaining("cross-slot redelivery"),
      expect.anything(),
    );
  });
});

describe("handleUserPositionClose", () => {
  const trade = { id: 42, deploymentId: "d1" } as StrategyTrade;

  // The arm Layer 1 exists for, and the only one none of the four original
  // tests reached. If the pre-resolve stops being forwarded, nothing throws
  // and nothing logs an error — `reconcileOneTrade` quietly falls through to
  // Layer 2/3 and `exit_resolution_source` degrades from 'buffer' to 'rest'
  // or 'approximated' on every close, which per engine.md is the difference
  // between authoritative and estimated PnL on every trade.
  it("forwards a buffer-resolved exit to the reconciler as the pre-resolve", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const pre = {
      exitPrice: 20150,
      pnlDollars: 100,
      pnlTicks: 20,
      feesDollars: 2,
      exitFilledAt: "2026-06-01T15:00:00.000Z",
      matchedOrderId: 901,
    };
    const deps = makeDeps({ reconcileExitFromBuffer: vi.fn(() => pre) });

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    expect(deps.reconcileOneTrade).toHaveBeenCalledWith(
      trade,
      1001,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      pre,
    );
  });

  it("passes a null pre-resolve through when the buffer had nothing", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const deps = makeDeps({ reconcileExitFromBuffer: vi.fn(() => null) });

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    const call = vi.mocked(deps.reconcileOneTrade).mock.calls[0];
    expect(call[5]).toBeNull();
  });

  it("does not yield to a timer when the broker's close grace is zero", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const deps = makeDeps();

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    expect(timer).not.toHaveBeenCalled();
    expect(deps.reconcileExitFromBuffer).toHaveBeenCalledTimes(1);
    timer.mockRestore();
  });

  it("waits the declared grace before draining when the transport needs one", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const deps = makeDeps({
      capabilitiesFor: vi.fn(() => ({ ...BASE_CAPABILITIES, positionCloseGraceMs: 250 })),
    });

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    expect(timer).toHaveBeenCalledWith(expect.any(Function), 250);
    timer.mockRestore();
  });

  it("discards the buffer slot even when the drain throws", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const deps = makeDeps({
      reconcileExitFromBuffer: vi.fn(() => {
        throw new Error("slot assertion failed");
      }),
    });

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    expect(deps.discardBufferSlot).toHaveBeenCalledWith("1001:NQ-2026:42");
    // A throwing drain must still reach Layer 2 with a null pre-resolve.
    expect(deps.reconcileOneTrade).toHaveBeenCalledWith(
      trade,
      1001,
      [],
      new Set(),
      new Map(),
      null,
    );
  });

  // A44: the map used to be `{ size, avgPrice }`, so no reader of it could do
  // signed math. Nothing reads `type` yet; this pins that it arrives.
  it("hands the reconciler each position with its side", async () => {
    dbMock.findTradeByAccountContract.mockReturnValue(trade);
    const broker = makeBroker();
    const positions: Position[] = [
      { id: 1, accountId: 1001, contractId: "NQ-2026", creationTimestamp: "2026-06-01T14:30:00.000Z", type: 2, size: 1, averagePrice: 20100 },
      { id: 2, accountId: 1001, contractId: "ES-2026", creationTimestamp: "2026-06-01T14:30:00.000Z", type: 1, size: 2, averagePrice: 5100 },
    ];
    const deps = makeDeps({
      brokerForAccount: vi.fn(() =>
        asBroker({ ...broker, searchOpenPositions: vi.fn(async () => positions) }),
      ),
    });

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    const map = vi.mocked(deps.reconcileOneTrade).mock.calls[0][4];
    expect([...map]).toEqual([
      ["NQ-2026", { size: 1, avgPrice: 20100, type: 2 }],
      ["ES-2026", { size: 2, avgPrice: 5100, type: 1 }],
    ]);
  });

  it("heals and then validates a stuck closed row when no trade is in flight", async () => {
    const stuck = { id: 43, deploymentId: "d1" } as StrategyTrade;
    const healed = { id: 43, deploymentId: "d1" } as StrategyTrade;
    dbMock.findRecentApproximatedTradeByAccountContract.mockReturnValue(stuck);
    dbMock.getTradeById.mockReturnValue(healed);
    const deps = makeDeps();

    await handleUserPositionClose(deps, 1001, "NQ-2026");

    expect(deps.healApproximatedExitFromFills).toHaveBeenCalledWith(stuck, 1001);
    expect(deps.validateClosedTradePrices).toHaveBeenCalledWith(healed, 1001);
  });
});

describe("handleTrade", () => {
  function marketSub(over: Partial<MarketSub> = {}): MarketSub {
    return {
      contract: { executionContractId: "NQM6" },
      refCount: 1,
      timeframes: new Set(),
      lastTickPrice: null,
      ...over,
    } as MarketSub;
  }

  const tick: GatewayTrade = {
    price: 20100,
    volume: 3,
    type: 0,
    timestamp: "2026-06-01T15:00:00.000Z",
  };

  it("evaluates exits once per price change, not once per tick", () => {
    const sub = marketSub();
    const deps = makeDeps({ marketSubFor: vi.fn(() => sub) });

    handleTrade(deps, "CON.F.US.NQ.M26", tick);
    handleTrade(deps, "CON.F.US.NQ.M26", tick);

    expect(deps.evaluateRealtimeExits).toHaveBeenCalledTimes(1);

    handleTrade(deps, "CON.F.US.NQ.M26", { ...tick, price: 20101 });
    expect(deps.evaluateRealtimeExits).toHaveBeenCalledTimes(2);
  });

  it("emits the mark under the execution alias as well as the hub id", () => {
    const emitMarketTrade = vi.fn();
    peekBroadcasterMock.mockReturnValue({ emitMarketTrade });
    const deps = makeDeps({ marketSubFor: vi.fn(() => marketSub()) });

    handleTrade(deps, "CON.F.US.NQ.M26", tick);

    expect(emitMarketTrade).toHaveBeenCalledWith("CON.F.US.NQ.M26", 20100, tick.timestamp);
    expect(emitMarketTrade).toHaveBeenCalledWith("NQM6", 20100, tick.timestamp);
  });

  it("forwards a browser-only contract to the relay but never evaluates exits on it", () => {
    const emitMarketTrade = vi.fn();
    peekBroadcasterMock.mockReturnValue({ emitMarketTrade });
    const deps = makeDeps();

    handleTrade(deps, "CON.F.US.UNKNOWN", tick);

    expect(emitMarketTrade).toHaveBeenCalledTimes(1);
    expect(deps.evaluateRealtimeExits).not.toHaveBeenCalled();
  });

  it("emits no execution alias for a contract the engine holds no sub for — that alias is the relay's to add", () => {
    const emitMarketTrade = vi.fn();
    peekBroadcasterMock.mockReturnValue({ emitMarketTrade });
    // A manual Tradovate position, or one stranded on a paused deployment:
    // the browser tracks the contract and the hub ticks it, but no
    // deployment holds a sub, so nothing here knows the execution symbol.
    const deps = makeDeps();

    handleTrade(deps, "CON.F.US.NQ.M26", tick);

    expect(emitMarketTrade).toHaveBeenCalledTimes(1);
    expect(emitMarketTrade).toHaveBeenCalledWith("CON.F.US.NQ.M26", 20100, tick.timestamp);
  });

  it("emits no execution alias when the shared sub carries a Topstep contract", () => {
    const emitMarketTrade = vi.fn();
    peekBroadcasterMock.mockReturnValue({ emitMarketTrade });
    const deps = makeDeps({
      marketSubFor: vi.fn(() => marketSub({ contract: {} as MarketSub["contract"] })),
    });

    handleTrade(deps, "CON.F.US.NQ.M26", tick);

    expect(emitMarketTrade).toHaveBeenCalledTimes(1);
  });

  it("never takes its mark from a tick whose timestamp does not parse", () => {
    const sub = marketSub();
    const deps = makeDeps({ marketSubFor: vi.fn(() => sub) });

    // Unparseable tick last: without the isNaN guard its price becomes the
    // mark, and a bad frame moves every stop in the deployment.
    handleTrade(deps, "CON.F.US.NQ.M26", [
      tick,
      { price: 1, volume: 1, type: 0, timestamp: "not-a-date" },
    ]);

    expect(deps.evaluateRealtimeExits).toHaveBeenCalledWith("CON.F.US.NQ.M26", 20100);
  });

  it("A97: folds an out-of-order batch across a bar boundary in trade-time order, so the closed bar keeps its last trades", () => {
    // Fake timers only so the aggregator's grace timer is not a real one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T15:01:00.200Z"));
    try {
      const aggregator = new BarAggregator("1m");
      const published: BarData[] = [];
      aggregator.onBarClose((b) => published.push(b));
      const sub = marketSub({ timeframes: new Set<Timeframe>(["1m"]) });
      const contractSub = { aggregator } as ContractSub;
      const deps = makeDeps({ marketSubFor: vi.fn(() => sub), contractSubFor: vi.fn(() => contractSub) });
      const at = (timestamp: string, price: number): GatewayTrade => ({ price, volume: 1, type: 0, timestamp });

      // The 15:01 trade arrives first in the frame; the 15:00 bucket's high,
      // low and last trade arrive after it.
      handleTrade(deps, "CON.F.US.NQ.M26", [
        at("2026-06-01T15:00:10.000Z", 20100),
        at("2026-06-01T15:01:00.100Z", 20105),
        at("2026-06-01T15:00:40.000Z", 20120),
        at("2026-06-01T15:00:50.000Z", 20090),
        at("2026-06-01T15:00:59.900Z", 20110),
      ]);

      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        timestamp: "2026-06-01T15:00:00.000Z",
        open: 20100,
        high: 20120,
        low: 20090,
        close: 20110,
        volume: 4,
      });
      // The mark is the newest trade by time, not by arrival.
      expect(deps.evaluateRealtimeExits).toHaveBeenCalledWith("CON.F.US.NQ.M26", 20105);
      aggregator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notes hub activity and the market-trade count on every call", () => {
    const deps = makeDeps();

    handleTrade(deps, "CON.F.US.NQ.M26", tick);

    expect(deps.noteTradeActivity).toHaveBeenCalledTimes(1);
    expect(deps.noteMarketTrade).toHaveBeenCalledTimes(1);
  });
});
