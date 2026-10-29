import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBroadcaster, STATUS_PUSH_MIN_MS } from "./event-broadcaster";
import type {
  BroadcastEvent,
  BroadcasterDeps,
  MarketTradeSubscriber,
  UserEventSource,
} from "./event-broadcaster";
import type { Position, TradeFill } from "@/lib/brokers/types";
import type { WireLogRecord } from "@/lib/logging/pipe";
import type { EngineStatus } from "@/lib/trading/engine/handle";

/**
 * The broadcaster owns no connection any more: account events arrive from
 * a `UserEventSource` (the broker realtime adapter) and market-contract
 * subscriptions go out through a `MarketTradeSubscriber`. Both are faked
 * here. The user-hub lifecycle these tests used to cover moved with it —
 * see `realtime-adapter.test.ts`.
 */

class FakeUserEvents implements UserEventSource {
  retained: Array<[string, number[]]> = [];
  retainImpl: () => Promise<void> = async () => {};
  connected = true;
  positionHandlers: Array<(accountId: number, position: Position) => void> = [];
  fillHandlers: Array<(accountId: number, fill: TradeFill) => void> = [];
  statusHandlers: Array<(connected: boolean, reason?: string) => void> = [];

  async retain(key: string, accountIds: number[]): Promise<void> {
    this.retained.push([key, accountIds]);
    await this.retainImpl();
  }
  isConnected(): boolean {
    return this.connected;
  }
  onPosition(h: (accountId: number, position: Position) => void): void {
    this.positionHandlers.push(h);
  }
  onFill(h: (accountId: number, fill: TradeFill) => void): void {
    this.fillHandlers.push(h);
  }
  onStatus(h: (connected: boolean, reason?: string) => void): void {
    this.statusHandlers.push(h);
  }
  emitPosition(accountId: number, position: Position): void {
    for (const h of this.positionHandlers) h(accountId, position);
  }
  emitFill(accountId: number, fill: TradeFill): void {
    for (const h of this.fillHandlers) h(accountId, fill);
  }
  emitStatus(connected: boolean, reason?: string): void {
    for (const h of this.statusHandlers) h(connected, reason);
  }
}

class FakeMarketTrades implements MarketTradeSubscriber {
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  subscribeImpl: (contractId: string) => Promise<void> = async () => {};
  async subscribe(contractId: string): Promise<void> {
    this.subscribed.push(contractId);
    await this.subscribeImpl(contractId);
  }
  async unsubscribe(contractId: string): Promise<void> {
    this.unsubscribed.push(contractId);
  }
}

/** Stands in for the engine's `marketDataContractId`. A Topstep-shaped id
 *  answers itself; a dated symbol answers only once the engine could have
 *  resolved it, which `known` controls. */
class FakeSymbols {
  known = new Map<string, string>();
  calls: string[] = [];
  resolve = async (contractId: string): Promise<string | null> => {
    this.calls.push(contractId);
    if (contractId.includes(".")) return contractId;
    return this.known.get(contractId) ?? null;
  };
}

const MNQ_HUB_ID = "CON.F.US.MNQ.M26";
const MNQ_EXEC_ID = "MNQM6";

const POSITION: Position = {
  id: 1,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  type: 1,
  size: 2,
  averagePrice: 24680.25,
};

const FILL: TradeFill = {
  id: 3,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  price: 24680.25,
  profitAndLoss: null,
  fees: 0.56,
  side: 0,
  size: 2,
  voided: false,
  orderId: 2,
};

let userEvents: FakeUserEvents;
let marketTrades: FakeMarketTrades;
let symbols: FakeSymbols;
let broadcaster: EventBroadcaster;
let events: BroadcastEvent[];

function deps(): BroadcasterDeps {
  return {
    userEvents,
    marketTrades,
    marketDataContractId: symbols.resolve,
  } satisfies BroadcasterDeps;
}

beforeEach(() => {
  userEvents = new FakeUserEvents();
  marketTrades = new FakeMarketTrades();
  symbols = new FakeSymbols();
  broadcaster = new EventBroadcaster(deps());
  events = [];
  broadcaster.subscribe("test", (e) => events.push(e));
});

describe("EventBroadcaster — account event relay", () => {
  it("relays a position event as a neutral Position payload", () => {
    userEvents.emitPosition(9001, POSITION);
    expect(events).toEqual([{ kind: "position", payload: POSITION }]);
  });

  it("relays a fill as a userTrade carrying a neutral TradeFill", () => {
    userEvents.emitFill(9001, FILL);
    expect(events).toEqual([{ kind: "userTrade", payload: FILL }]);
  });

  it("relays connection status transitions", () => {
    userEvents.emitStatus(false, "connection closed");
    expect(events).toEqual([
      { kind: "status", connected: false, reason: "connection closed" },
    ]);
  });

  it("reads connected state from the account feed, not a local copy", () => {
    userEvents.connected = false;
    expect(broadcaster.getConnectedState()).toBe(false);
  });

  it("keeps fanning out when one listener throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    broadcaster.subscribe("bad", () => {
      throw new Error("listener blew up");
    });
    const seen: BroadcastEvent[] = [];
    broadcaster.subscribe("good", (e) => seen.push(e));

    userEvents.emitPosition(9001, POSITION);

    expect(seen).toHaveLength(1);
    warn.mockRestore();
  });

  it("stops delivering to an unsubscribed listener", () => {
    broadcaster.unsubscribe("test");
    userEvents.emitPosition(9001, POSITION);
    expect(events).toEqual([]);
  });
});

describe("EventBroadcaster — engine-emitted events", () => {
  it("emits marketTrade ticks", () => {
    broadcaster.emitMarketTrade("CON.F.US.MNQ.M26", 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toEqual([
      {
        kind: "marketTrade",
        contractId: "CON.F.US.MNQ.M26",
        lastPrice: 24681,
        timestamp: "2026-08-22T13:31:03.000Z",
      },
    ]);
  });

  it("emits strategyTrade, which is app-level and reaches no broker", () => {
    broadcaster.emitStrategyTradeClosed(9001, "dep-1");
    expect(events).toEqual([
      { kind: "strategyTrade", accountId: 9001, deploymentId: "dep-1" },
    ]);
  });

  it("emits deploymentsChanged as a bare signal, carrying no row", () => {
    // The payload-free shape is the decision, not an oversight: the client
    // refetches through `/api/deployments`, so a row on the wire would be a
    // second serialization to keep in step with the endpoint's.
    broadcaster.emitDeploymentsChanged();
    expect(events).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("emits setupsChanged as a bare signal too — the map is read off the engine status route", () => {
    broadcaster.emitSetupsChanged();
    expect(events).toEqual([{ kind: "setupsChanged" }]);
  });

  it("emits tradesChanged as a bare signal — the rows are read off /api/trades", () => {
    broadcaster.emitTradesChanged();
    expect(events).toEqual([{ kind: "tradesChanged" }]);
  });
});

function wireLine(overrides: Partial<WireLogRecord> = {}): WireLogRecord {
  return {
    timestamp: "2026-10-27T14:30:00.000Z",
    deploymentId: "dep-1",
    level: "trade",
    message: "Entry filled",
    severity: "info",
    category: "trade",
    event: null,
    display: "…4469-ema-x.MNQ",
    ticker: "MNQ",
    tradeId: 7,
    values: null,
    burstCount: 1,
    seq: 3,
    ...overrides,
  };
}

describe("EventBroadcaster — logLine", () => {
  it("relays one projected ring line per frame, unchanged", () => {
    const line = wireLine();
    broadcaster.emitLogLine(line);
    expect(events).toEqual([{ kind: "logLine", record: line }]);
  });

  it("keeps debug lines off the stream", () => {
    broadcaster.emitLogLine(wireLine({ severity: "debug" }));
    expect(events).toEqual([]);
  });

  it("does not recurse when relaying a line provokes another", () => {
    // The shape that would: a listener throws, the throw is logged, and the
    // logged line comes straight back to be relayed through that listener.
    const seen: BroadcastEvent[] = [];
    broadcaster.subscribe("echo", (e) => {
      seen.push(e);
      broadcaster.emitLogLine(wireLine({ message: "the failure, logged" }));
    });
    broadcaster.emitLogLine(wireLine());
    expect(seen).toEqual([{ kind: "logLine", record: wireLine() }]);
  });
});

function engineStatus(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    running: true,
    marketHub: { mode: "realtime", autoRetry: true, lastDisconnectReason: null },
    health: {
      marketData: {
        realtime: {
          state: "healthy",
          lastBarAt: 1_761_575_400_000,
          lastFeedTickAt: 1_761_575_401_000,
          downSince: null,
          resumeFromBarOpenMs: null,
          reason: null,
        },
      },
      brokers: {},
      degraded: false,
      frozen: [],
      entriesHeld: null,
    },
    setups: { "dep-1": "pullback to the 21" },
    ...overrides,
  };
}

describe("EventBroadcaster — engineStatus", () => {
  let current: EngineStatus;
  let reads: number;
  let statusRelay: EventBroadcaster;
  let frames: BroadcastEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    current = engineStatus();
    reads = 0;
    statusRelay = new EventBroadcaster({
      ...deps(),
      engineStatus: () => {
        reads++;
        return current;
      },
    } satisfies BroadcasterDeps);
    frames = [];
  });

  afterEach(async () => {
    await statusRelay.shutdown();
    vi.useRealTimers();
  });

  const statusFrames = () => frames.filter((e) => e.kind === "engineStatus");

  it("sends the status whole on the first sample after a listener joins", async () => {
    statusRelay.subscribe("browser", (e) => frames.push(e));
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS);
    expect(statusFrames()).toEqual([{ kind: "engineStatus", status: current }]);
  });

  it("sends nothing while nothing changed, and does not count the last-tick clock as a change", async () => {
    statusRelay.subscribe("browser", (e) => frames.push(e));
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS);
    const realtime = current.health.marketData.realtime;
    current = engineStatus({
      health: {
        ...current.health,
        marketData: { realtime: { ...realtime, lastFeedTickAt: (realtime.lastFeedTickAt ?? 0) + 500 } },
      },
    });
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 30);
    expect(statusFrames()).toHaveLength(1);
  });

  it("sends a change — the engine stopping", async () => {
    statusRelay.subscribe("browser", (e) => frames.push(e));
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS);
    current = engineStatus({ running: false });
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS);
    expect(statusFrames().at(-1)).toEqual({ kind: "engineStatus", status: current });
    expect(statusFrames()).toHaveLength(2);
  });

  it("sends at most one frame per STATUS_PUSH_MIN_MS however often it changes", async () => {
    statusRelay.subscribe("browser", (e) => frames.push(e));
    // A failing bar read rewrites its reason every few hundred ms.
    for (let ms = 0; ms < STATUS_PUSH_MIN_MS * 5; ms += STATUS_PUSH_MIN_MS / 10) {
      current = engineStatus({ setups: { "dep-1": `reading at ${ms}` } });
      await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS / 10);
    }
    expect(statusFrames()).toHaveLength(5);
    // And each frame carries what was current at its sample, not a stale copy.
    expect(statusFrames().at(-1)).toEqual({ kind: "engineStatus", status: current });
  });

  it("reads nothing while nobody listens", async () => {
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 10);
    expect(reads).toBe(0);

    statusRelay.subscribe("browser", (e) => frames.push(e));
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 2);
    expect(reads).toBe(2);

    statusRelay.unsubscribe("browser");
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 10);
    expect(reads).toBe(2);
  });

  it("stops sampling on shutdown", async () => {
    statusRelay.subscribe("browser", (e) => frames.push(e));
    await statusRelay.shutdown();
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 10);
    expect(reads).toBe(0);
  });

  it("survives a reader that throws, and sends once it answers again", async () => {
    // A throw escaping the timer would end a 24/7 process.
    let failing = true;
    const flaky = new EventBroadcaster({
      ...deps(),
      engineStatus: () => {
        if (failing) throw new Error("status read failed");
        return current;
      },
    } satisfies BroadcasterDeps);
    flaky.subscribe("browser", (e) => frames.push(e));
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 3);
    expect(statusFrames()).toEqual([]);

    failing = false;
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS);
    expect(statusFrames()).toEqual([{ kind: "engineStatus", status: current }]);
    await flaky.shutdown();
  });

  it("sends no status frame from a relay built without a status reader", async () => {
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_MIN_MS * 5);
    expect(events.filter((e) => e.kind === "engineStatus")).toEqual([]);
  });
});

describe("EventBroadcaster — ensureRunning", () => {
  it("retains the account feed under one holder key with every tracked account", async () => {
    await broadcaster.ensureRunning([1001], ["CON.A"]);
    await broadcaster.ensureRunning([1002], []);

    expect(userEvents.retained[0]).toEqual(["broadcaster", [1001]]);
    expect(userEvents.retained[1][0]).toBe("broadcaster");
    expect(userEvents.retained[1][1].sort()).toEqual([1001, 1002]);
    expect(broadcaster.getTrackedAccounts().sort()).toEqual([1001, 1002]);
  });

  it("subscribes the requested contracts on the market-trade port", async () => {
    await broadcaster.ensureRunning([], ["CON.A", "CON.B"]);
    expect(marketTrades.subscribed.sort()).toEqual(["CON.A", "CON.B"]);
  });

  it("propagates a failure to bring the account feed up", async () => {
    userEvents.retainImpl = () => Promise.reject(new Error("hub down"));
    await expect(broadcaster.ensureRunning([1001], [])).rejects.toThrow("hub down");
  });

  it("does not fail the mount when one contract subscribe rejects", async () => {
    marketTrades.subscribeImpl = () => Promise.reject(new Error("market hub down"));
    await expect(broadcaster.ensureRunning([], ["CON.A"])).resolves.toBeUndefined();
  });
});

describe("EventBroadcaster — market contract tracking", () => {
  it("re-issues every tracked contract on resubscribeMarketContracts", async () => {
    await broadcaster.trackContractTrades("CON.A");
    await broadcaster.trackContractTrades("CON.B");
    marketTrades.subscribed.length = 0;

    await broadcaster.resubscribeMarketContracts();

    expect(marketTrades.subscribed.sort()).toEqual(["CON.A", "CON.B"]);
  });

  it("drops an untracked contract from the resubscribe set", async () => {
    await broadcaster.trackContractTrades("CON.A");
    await broadcaster.untrackContractTrades("CON.A");
    marketTrades.subscribed.length = 0;

    await broadcaster.resubscribeMarketContracts();

    expect(marketTrades.unsubscribed).toEqual(["CON.A"]);
    expect(marketTrades.subscribed).toEqual([]);
  });

  it("swallows a failed subscribe — the reconnect handler re-subscribes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    marketTrades.subscribeImpl = () => Promise.reject(new Error("market hub down"));

    await expect(broadcaster.trackContractTrades("CON.A")).resolves.toBeUndefined();

    warn.mockRestore();
  });
});

describe("EventBroadcaster — execution aliases", () => {
  // A manual Tradovate position, or one stranded on a paused deployment:
  // the browser names the contract by its execution symbol and the engine
  // holds no market sub for it, so nothing upstream can supply the alias.
  beforeEach(() => {
    symbols.known.set(MNQ_EXEC_ID, MNQ_HUB_ID);
  });

  it("subscribes the market-data id behind an execution symbol, not the symbol itself", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    expect(marketTrades.subscribed).toEqual([MNQ_HUB_ID]);
  });

  it("fans a tick out under the id the browser asked for as well as the hub id", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");

    expect(events.map((e) => (e.kind === "marketTrade" ? e.contractId : e.kind))).toEqual([
      MNQ_HUB_ID,
      MNQ_EXEC_ID,
    ]);
  });

  it("collapses the engine's own alias emit onto the fan-out rather than sending it twice", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    // What `handleTrade` does when a deployment *does* hold the sub: emits
    // once under the hub id and again under the alias it read off it. The
    // fan-out has already delivered that alias, so the second call is a
    // repeat — asserting the count only at the end would pass just as well
    // with no fan-out at all.
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toHaveLength(2);

    broadcaster.emitMarketTrade(MNQ_EXEC_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toHaveLength(2);
  });

  it("still forwards the next tick on the same contract", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:04.000Z");

    expect(events.filter((e) => e.kind === "marketTrade" && e.contractId === MNQ_EXEC_ID))
      .toHaveLength(2);
  });

  it("sends no alias frame for a contract nobody asked to alias", async () => {
    await broadcaster.ensureRunning([], ["CON.F.US.EP.U26"]);

    broadcaster.emitMarketTrade("CON.F.US.EP.U26", 6789, "2026-08-22T13:31:03.000Z");

    expect(events).toHaveLength(1);
  });

  it("subscribes an id it cannot translate unchanged, and re-asks on the next mount", async () => {
    symbols.known.clear();
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    expect(marketTrades.subscribed).toEqual([MNQ_EXEC_ID]);

    // The engine warmed up in between — a failed translation must not be
    // cached as an answer, or a contract resolved a second late never gets
    // a mark for the life of the position.
    symbols.known.set(MNQ_EXEC_ID, MNQ_HUB_ID);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    expect(marketTrades.subscribed).toEqual([MNQ_EXEC_ID, MNQ_HUB_ID]);
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toHaveLength(2);
  });

  it("translates once and holds the answer across re-subscribes", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    await broadcaster.resubscribeMarketContracts();

    expect(symbols.calls).toEqual([MNQ_EXEC_ID]);
    expect(marketTrades.subscribed).toEqual([MNQ_HUB_ID, MNQ_HUB_ID, MNQ_HUB_ID]);
  });

  it("unsubscribes the market-data id and stops fanning out when the position closes", async () => {
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    await broadcaster.untrackContractTrades(MNQ_EXEC_ID);

    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");

    expect(marketTrades.unsubscribed).toEqual([MNQ_HUB_ID]);
    expect(events).toHaveLength(1);
  });

  // The hub subscription is shared and not ref-counted at the wire, so the
  // resolved id an untrack sends is live for every other holder of it.
  it("keeps the hub subscription while the market-data id is tracked in its own right", async () => {
    await broadcaster.ensureRunning([], [MNQ_HUB_ID, MNQ_EXEC_ID]);

    await broadcaster.untrackContractTrades(MNQ_EXEC_ID);

    expect(marketTrades.unsubscribed).toEqual([]);
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toHaveLength(1);
  });

  it("keeps the hub subscription while another alias still resolves to it", async () => {
    symbols.known.set("MNQM26", MNQ_HUB_ID);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID, "MNQM26"]);

    await broadcaster.untrackContractTrades(MNQ_EXEC_ID);

    expect(marketTrades.unsubscribed).toEqual([]);
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events.map((e) => (e.kind === "marketTrade" ? e.contractId : e.kind))).toEqual([
      MNQ_HUB_ID,
      "MNQM26",
    ]);
  });

  it("unsubscribes once the last holder of the market-data id goes", async () => {
    await broadcaster.ensureRunning([], [MNQ_HUB_ID, MNQ_EXEC_ID]);

    await broadcaster.untrackContractTrades(MNQ_EXEC_ID);
    await broadcaster.untrackContractTrades(MNQ_HUB_ID);

    expect(marketTrades.unsubscribed).toEqual([MNQ_HUB_ID]);
  });
});

describe("EventBroadcaster — retainContractTrades", () => {
  it("untracks every contract outside the browser's current set", async () => {
    await broadcaster.ensureRunning([], ["CON.A", "CON.B", "CON.C"]);
    marketTrades.subscribed.length = 0;

    await broadcaster.retainContractTrades(["CON.B"]);

    expect(marketTrades.unsubscribed.sort()).toEqual(["CON.A", "CON.C"]);
    await broadcaster.resubscribeMarketContracts();
    expect(marketTrades.subscribed).toEqual(["CON.B"]);
  });

  it("drops the resolved id, the alias and the de-dup stamp together", async () => {
    symbols.known.set(MNQ_EXEC_ID, MNQ_HUB_ID);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    events.length = 0;

    await broadcaster.retainContractTrades([]);

    expect(marketTrades.unsubscribed).toEqual([MNQ_HUB_ID]);
    // Nothing fans out any more, and the identical tick is not swallowed by
    // a `lastTick` entry that outlived the contract.
    broadcaster.emitMarketTrade(MNQ_HUB_ID, 24681, "2026-08-22T13:31:03.000Z");
    expect(events).toEqual([
      {
        kind: "marketTrade",
        contractId: MNQ_HUB_ID,
        lastPrice: 24681,
        timestamp: "2026-08-22T13:31:03.000Z",
      },
    ]);
  });

  it("re-resolves a contract that comes back rather than answering from a stale map", async () => {
    symbols.known.set(MNQ_EXEC_ID, MNQ_HUB_ID);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);
    await broadcaster.retainContractTrades([]);
    await broadcaster.ensureRunning([], [MNQ_EXEC_ID]);

    expect(symbols.calls).toEqual([MNQ_EXEC_ID, MNQ_EXEC_ID]);
    expect(marketTrades.subscribed).toEqual([MNQ_HUB_ID, MNQ_HUB_ID]);
  });
});

describe("EventBroadcaster — shutdown", () => {
  it("clears listeners and tracking without releasing the shared account feed", async () => {
    await broadcaster.ensureRunning([1001], ["CON.A"]);
    await broadcaster.shutdown();

    expect(broadcaster.hasListeners()).toBe(false);
    expect(broadcaster.getTrackedAccounts()).toEqual([]);
    userEvents.emitPosition(9001, POSITION);
    expect(events).toEqual([]);
  });
});
