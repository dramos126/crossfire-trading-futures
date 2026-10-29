/**
 * The subscription reconciler and the diagnostic heartbeat.
 *
 * Both were private methods on `TradingEngine` before D5, reachable only as
 * `(engine as any)` with a SignalR client, a resolver and a strategy
 * registry stubbed underneath — which is why `engine.test.ts` covers
 * `syncContractSubs` by *replicating* its executionContractId merge
 * predicate instead of calling it. That replica asserts a copy and passes
 * whatever the shipped loop does; these call the shipped loop.
 *
 * What the extraction made reachable, and what is covered here:
 *  - ref-counting: subscribe fires once per contract however many
 *    aggregators bind to it, unsubscribe only when the last one drops
 *  - the exit-eval relaxation — a disabled leg holding a position keeps its
 *    aggregator and its trade stream
 *  - the executionContractId merge, against the real loop
 *  - a failing `subscribeTrades` is logged and does not abort the sweep
 *  - the heartbeat's window counter reset and its user-hub reconnect
 *    rate-limit, which is the only thing standing between a displaced
 *    session and a reconnect fired every heartbeat tick
 *  - the warn-before-watchdog ordering `HEARTBEAT_MS` is chosen to preserve
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md).
vi.mock("../strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
}));

vi.mock("../strategy-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../strategy-types")>()),
  resolveTimeframe: vi.fn(() => "1m"),
}));

// The hub reaches these three at connect / passive-entry time only; no test
// here connects, but the module-scope imports still have to resolve.
vi.mock("@/lib/brokers/topstep/auth", () => ({
  validateOrRefreshToken: vi.fn(async () => "tok"),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

// A kicked close sends a connection alert; its webhook lookup would reach the
// throwing `getDb` as an unhandled rejection.
vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/discord")>()),
  sendConnectionAlert: vi.fn(async () => {}),
}));

import type { Contract } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { TopstepSignalR } from "@/lib/brokers/topstep/signalr";
import { resolveTimeframe } from "../strategy-types";
import { validateOrRefreshToken } from "@/lib/brokers/topstep/auth";
import {
  MarketHubController,
  HEARTBEAT_TRADE_SILENCE_WARN_S,
  MARKET_HUB_STALL_MS,
  type MarketHubDeps,
} from "./engine-market-hub";
import { resolveLadder, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import { GATEWAY_LOGOUT_CLOSE_WINDOW_MS } from "@/lib/brokers/topstep/realtime-adapter";
import {
  OWN_LOGIN_ADVISORY_WINDOW_MS,
  TopstepClient,
  topstepSessionState,
} from "@/lib/brokers/topstep/client";
import { sendConnectionAlert } from "@/lib/notify/discord";
import {
  noteTopstepRequest,
  noteTopstepResponse,
  takeTopstepRequestWindow,
} from "@/lib/brokers/topstep/request-counter";

const ACCT = 4242;
const MNQ = "CON.F.US.MNQ.M26";
const MES = "CON.F.US.MES.M26";

function contract(id: string, over: Partial<Contract> = {}): Contract {
  return {
    id,
    name: id,
    tickSize: 0.25,
    tickValue: 0.5,
    ...over,
  } as Contract;
}

function deployment(id: string, over: Partial<Deployment> = {}): Deployment {
  return {
    id,
    accountId: ACCT,
    ticker: "MNQ" as TickerSymbol,
    strategyKey: "test",
    status: "Active",
    paramValues: {},
    ...over,
  } as Deployment;
}

type Signalr = {
  subscribeTrades: ReturnType<typeof vi.fn>;
  unsubscribeTrades: ReturnType<typeof vi.fn>;
  getMarketHubState: ReturnType<typeof vi.fn>;
  // The connect path. Only the token-rotation block below drives it — the
  // rest of this file never opens a hub — but `connect()` is the one place
  // that records which session the hubs are on, so a rotation test cannot
  // fake it without asserting a copy.
  buildMarketHub: ReturnType<typeof vi.fn>;
  startMarketHub: ReturnType<typeof vi.fn>;
  disconnectMarket: ReturnType<typeof vi.fn>;
  onTrade: ReturnType<typeof vi.fn>;
  onMarketReconnected: ReturnType<typeof vi.fn>;
  onMarketGatewayLogout: ReturnType<typeof vi.fn>;
  onMarketClose: ReturnType<typeof vi.fn>;
};

function makeSignalr(): Signalr {
  return {
    subscribeTrades: vi.fn(async () => {}),
    unsubscribeTrades: vi.fn(async () => {}),
    getMarketHubState: vi.fn(() => "Connected"),
    buildMarketHub: vi.fn(),
    startMarketHub: vi.fn(async () => {}),
    disconnectMarket: vi.fn(async () => {}),
    onTrade: vi.fn(),
    onMarketReconnected: vi.fn(),
    onMarketGatewayLogout: vi.fn(),
    onMarketClose: vi.fn(),
  };
}

/**
 * One captured line, whichever half of the seam emitted it. Named fields
 * rather than a tuple: the positional capture this replaces was written
 * against `log(deploymentId, level, message)`, kept compiling when the
 * signature became `severity × category`, and silently started asserting
 * `"connection"` where the test read `message`.
 */
type LogEntry = {
  deploymentId: string;
  severity: Severity;
  category: LogCategory;
  message: string;
  /** null for a `log()` line — it names no event, and that is legible. */
  event: string | null;
};

type Harness = {
  hub: MarketHubController;
  signalr: Signalr;
  deps: { [K in keyof MarketHubDeps]: ReturnType<typeof vi.fn> };
  logs: LogEntry[];
  contracts: Map<string, Contract>;
  setDeployments(next: Deployment[]): void;
};

function makeHub(over: Partial<Record<keyof MarketHubDeps, unknown>> = {}): Harness {
  const signalr = makeSignalr();
  const logs: LogEntry[] = [];
  const contracts = new Map<string, Contract>([["MNQ", contract(MNQ)]]);
  let deployments: Deployment[] = [];

  // `satisfies`, deliberately: the cast below is what the mock accessors
  // need, and it is also what hid `logEvent` from `tsc` when L3 added it to
  // `MarketHubDeps` — five heartbeat tests only found out at run time, with
  // `this.deps.logEvent is not a function`. A member added to the interface
  // now fails to compile here instead.
  const base = {
    log: vi.fn(
      (deploymentId: string, severity: Severity, category: LogCategory, message: string) => {
        logs.push({ deploymentId, severity, category, message, event: null });
      },
    ),
    // The registry decides severity and category for an event-naming line,
    // exactly as `TradingEngine.logEvent` lets it — resolved through the
    // shipped `resolveLadder` rather than restated here, so an assertion on
    // `severity` still asserts what the operator is owed.
    logEvent: vi.fn((event: string, deploymentId: string, message: string) => {
      const { severity, category } = resolveLadder({ event, deploymentId, message });
      logs.push({ deploymentId, severity, category, message, event });
    }),
    setBrokerToken: vi.fn(),
    onTrade: vi.fn(),
    swapTickHandler: vi.fn(),
    reconnectUserHub: vi.fn(async () => true),
    resetUserReconnectFailures: vi.fn(),
    realtimeDeployments: vi.fn(() => deployments),
    resolveContract: vi.fn(async (ticker: string) => {
      const c = contracts.get(ticker);
      if (!c) throw new Error(`no contract for ${ticker}`);
      return c;
    }),
    onBarClose: vi.fn(),
    pendingBarCloseCount: vi.fn(() => 0),
    userHubState: vi.fn(() => "Connected"),
    userHubLiveness: vi.fn(() => ({ lastEventAt: 0, windowCount: 0, hubStarted: true })),
    brokerToken: vi.fn(() => null),
  } satisfies MarketHubDeps;

  const deps = { ...base, ...over } as unknown as Harness["deps"];

  const hub = new MarketHubController(
    signalr as unknown as TopstepSignalR,
    deps as unknown as MarketHubDeps,
  );
  return {
    hub,
    signalr,
    deps,
    logs,
    contracts,
    setDeployments(next) {
      deployments = next;
    },
  };
}

function subsOf(hub: MarketHubController): string[] {
  return [...hub.subscribedContractIds()];
}

describe("syncContractSubs", () => {
  beforeEach(() => {
    vi.mocked(resolveTimeframe).mockReturnValue("1m");
  });

  it("subscribes once per contract however many deployments bind to it", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a"), deployment("b")]);
    expect(h.signalr.subscribeTrades).toHaveBeenCalledTimes(1);
    expect(h.signalr.subscribeTrades).toHaveBeenCalledWith(MNQ);
    expect(subsOf(h.hub)).toEqual([MNQ]);
    expect(h.hub.marketSubFor(MNQ)?.refCount).toBe(1);
  });

  it("gives two timeframes on one contract two aggregators and one subscription", async () => {
    const h = makeHub();
    vi.mocked(resolveTimeframe).mockImplementation(
      ((_cfg: unknown, params: Record<string, unknown>) =>
        params.tf ?? "1m") as unknown as typeof resolveTimeframe,
    );
    await h.hub.syncContractSubs([
      deployment("a", { paramValues: { tf: "1m" } }),
      deployment("b", { paramValues: { tf: "5m" } }),
    ]);
    expect(h.signalr.subscribeTrades).toHaveBeenCalledTimes(1);
    expect(h.hub.contractSubFor(MNQ, "1m")).toBeDefined();
    expect(h.hub.contractSubFor(MNQ, "5m")).toBeDefined();
    expect(h.hub.marketSubFor(MNQ)?.refCount).toBe(2);
  });

  it("re-points an existing aggregator's refs rather than rebuilding it", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a")]);
    const first = h.hub.contractSubFor(MNQ, "1m");
    await h.hub.syncContractSubs([deployment("a"), deployment("b")]);
    const second = h.hub.contractSubFor(MNQ, "1m");
    expect(second).toBe(first);
    expect([...(second?.refs ?? [])]).toEqual(["a", "b"]);
    expect(h.signalr.subscribeTrades).toHaveBeenCalledTimes(1);
  });

  it("drops the aggregator and unsubscribes when the last deployment goes", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a")]);
    const sub = h.hub.contractSubFor(MNQ, "1m");
    const dispose = vi.spyOn(sub!.aggregator, "dispose");
    await h.hub.syncContractSubs([]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.signalr.unsubscribeTrades).toHaveBeenCalledWith(MNQ);
    expect(subsOf(h.hub)).toEqual([]);
    expect(h.hub.contractSubFor(MNQ, "1m")).toBeUndefined();
  });

  it("keeps a Pausing leg subscribed — the engine still owes it a flatten", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a", { status: "Pausing" })]);
    expect(subsOf(h.hub)).toEqual([MNQ]);
    expect([...(h.hub.contractSubFor(MNQ, "1m")?.refs ?? [])]).toEqual(["a"]);
  });

  it("keeps a Destroying leg subscribed for the same reason", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a", { status: "Destroying" })]);
    expect(subsOf(h.hub)).toEqual([MNQ]);
  });

  it("drops a Paused leg — under D-4 it is flat by definition", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a", { status: "Paused" })]);
    expect(subsOf(h.hub)).toEqual([]);
    expect(h.signalr.subscribeTrades).not.toHaveBeenCalled();
  });

  it("prefers the contract carrying executionContractId when two legs share a Topstep id", async () => {
    const h = makeHub();
    h.contracts.set("MNQ", contract(MNQ));
    h.contracts.set("MNQ-TV", contract(MNQ, { executionContractId: "MNQM6" }));
    await h.hub.syncContractSubs([
      deployment("a", { ticker: "MNQ" as TickerSymbol }),
      deployment("b", { ticker: "MNQ-TV" as TickerSymbol }),
    ]);
    expect(h.hub.marketSubFor(MNQ)?.contract.executionContractId).toBe("MNQM6");
  });

  it("does not overwrite an executionContractId already merged in", async () => {
    const h = makeHub();
    h.contracts.set("MNQ-TV", contract(MNQ, { executionContractId: "MNQM6" }));
    h.contracts.set("MNQ", contract(MNQ));
    await h.hub.syncContractSubs([
      deployment("a", { ticker: "MNQ-TV" as TickerSymbol }),
      deployment("b", { ticker: "MNQ" as TickerSymbol }),
    ]);
    expect(h.hub.marketSubFor(MNQ)?.contract.executionContractId).toBe("MNQM6");
  });

  it("logs and keeps the sub when subscribeTrades throws", async () => {
    const h = makeHub();
    h.signalr.subscribeTrades.mockRejectedValueOnce(new Error("hub wedged"));
    await expect(h.hub.syncContractSubs([deployment("a")])).resolves.toBeUndefined();
    expect(subsOf(h.hub)).toEqual([MNQ]);
    expect(h.logs.some((l) => l.severity === "warn" && l.message.includes("hub wedged"))).toBe(
      true,
    );
  });

  it("skips a leg whose contract cannot be resolved and subscribes the rest", async () => {
    const h = makeHub();
    h.contracts.set("MES", contract(MES));
    await expect(
      h.hub.syncContractSubs([
        deployment("a", { ticker: "UNKNOWN" as TickerSymbol }),
        deployment("b", { ticker: "MES" as TickerSymbol }),
      ]),
    ).resolves.toBeUndefined();
    expect(subsOf(h.hub)).toEqual([MES]);
    const line = h.logs.find((l) => l.event === "deployment_contract_unresolved");
    expect(line?.deploymentId).toBe("a");
    expect(line?.severity).toBe("error");
    expect(line?.message).toContain("no contract for UNKNOWN");
  });

  it("keeps a subscribed leg's stream when its contract stops resolving", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a")]);
    h.contracts.delete("MNQ");
    await h.hub.syncContractSubs([deployment("a")]);
    expect(subsOf(h.hub)).toEqual([MNQ]);
    expect(h.signalr.unsubscribeTrades).not.toHaveBeenCalled();
    expect([...(h.hub.contractSubFor(MNQ, "1m")?.refs ?? [])]).toEqual(["a"]);
    // It still gets bars, so the line is the unflagged warn, not the page.
    const line = h.logs.find((l) => l.deploymentId === "a" && l.event !== null);
    expect(line?.event).toBe("deployment_contract_lookup_failed");
    expect(line?.severity).toBe("warn");
  });

  it("is a no-op without a SignalR client", async () => {
    const deps = makeHub().deps;
    const hub = new MarketHubController(null, deps as unknown as MarketHubDeps);
    await hub.syncContractSubs([deployment("a")]);
    expect(subsOf(hub)).toEqual([]);
  });
});

/**
 * docs/bugs-fixed.md. After a reconnect the server has dropped every trade
 * subscription while `marketSubs` still holds them, so the hub re-issues
 * them. It used to ask the engine to, which read the hub's own map back.
 */
describe("A30 — resubscribeAll bounces engine → hub → engine → hub", () => {
  beforeEach(() => {
    vi.mocked(resolveTimeframe).mockReturnValue("1m");
  });

  it("re-issues every tracked subscription on a manual reconnect itself", async () => {
    const h = makeHub();
    await h.hub.connect();
    await h.hub.syncContractSubs([deployment("a")]);
    h.setDeployments([deployment("a")]);
    h.signalr.subscribeTrades.mockClear();

    await h.hub.reconnectManually();
    h.hub.shutdown();

    expect(h.signalr.subscribeTrades).toHaveBeenCalledTimes(1);
    expect(h.signalr.subscribeTrades).toHaveBeenCalledWith(MNQ);
  });

  it("keeps going past a contract whose resubscribe throws, and says which", async () => {
    const h = makeHub();
    h.contracts.set("MES", contract(MES));
    const both = [deployment("a"), deployment("b", { ticker: "MES" as TickerSymbol })];
    await h.hub.connect();
    await h.hub.syncContractSubs(both);
    h.setDeployments(both);
    h.signalr.subscribeTrades.mockClear();
    h.signalr.subscribeTrades.mockImplementationOnce(async () => {
      throw new Error("hub refused");
    });

    await h.hub.reconnectManually();
    h.hub.shutdown();

    expect(h.signalr.subscribeTrades).toHaveBeenCalledTimes(2);
    expect(h.logs.some((l) => l.message.includes("resubscribeTrades") && l.message.includes("hub refused"))).toBe(true);
  });
});

describe("teardownSubscriptions", () => {
  it("disposes every aggregator, unsubscribes every contract and clears both maps", async () => {
    const h = makeHub();
    h.contracts.set("MES", contract(MES));
    await h.hub.syncContractSubs([
      deployment("a"),
      deployment("b", { ticker: "MES" as TickerSymbol }),
    ]);
    const disposes = [
      vi.spyOn(h.hub.contractSubFor(MNQ, "1m")!.aggregator, "dispose"),
      vi.spyOn(h.hub.contractSubFor(MES, "1m")!.aggregator, "dispose"),
    ];
    h.hub.teardownSubscriptions();
    for (const d of disposes) expect(d).toHaveBeenCalledTimes(1);
    expect(h.signalr.unsubscribeTrades).toHaveBeenCalledWith(MNQ);
    expect(h.signalr.unsubscribeTrades).toHaveBeenCalledWith(MES);
    expect(subsOf(h.hub)).toEqual([]);
    expect(h.hub.contractSubFor(MNQ, "1m")).toBeUndefined();
  });
});

describe("marketSubEntries / noteMarketTrade", () => {
  it("exposes the (topstepId, sub) pairs the execution-alias lookup walks", async () => {
    const h = makeHub();
    h.contracts.set("MNQ", contract(MNQ, { executionContractId: "MNQM6" }));
    await h.hub.syncContractSubs([deployment("a")]);
    const pairs = [...h.hub.marketSubEntries()];
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0]).toBe(MNQ);
    expect(pairs[0][1].contract.executionContractId).toBe("MNQM6");
  });

  it("counts trades independently of the watchdog's liveness anchor", () => {
    const h = makeHub();
    const before = h.hub.lastActivityAt();
    h.hub.noteMarketTrade();
    h.hub.noteMarketTrade();
    expect(h.hub.lastActivityAt()).toBe(before);
  });
});

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // `useFakeTimers` seeds from the real wall clock, and every heartbeat
    // emission below is suppressed inside `isInMaintenanceWindow()` — the
    // nightly 17:00–18:00 ET break, Friday evening and the weekend. Pin the
    // clock so the suite does not go red for an hour a day: Wednesday
    // 14:00 ET, mid-session. `vi.useRealTimers()` restores it.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is idempotent — a second call does not arm a second interval", () => {
    const h = makeHub();
    h.hub.startHeartbeat();
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    expect(h.logs.filter((l) => l.category === "heartbeat")).toHaveLength(1);
    h.hub.stopHeartbeat();
  });

  it("reports the trade count for the window and zeroes it for the next one", () => {
    const h = makeHub();
    h.hub.noteMarketTrade();
    h.hub.noteMarketTrade();
    h.hub.noteMarketTrade();
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    expect(h.logs.at(-1)?.message).toContain("(3/win");
    vi.advanceTimersByTime(30_000);
    expect(h.logs.at(-1)?.message).toContain("(0/win");
    h.hub.stopHeartbeat();
  });

  it("reports the window's Topstep requests and zeroes them for the next one", () => {
    takeTopstepRequestWindow();
    const h = makeHub();
    noteTopstepRequest("/api/Position/searchOpen");
    noteTopstepResponse("/api/Position/searchOpen", 429);
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    expect(h.logs.at(-1)?.message).toContain("rest 1/win, 1 refused (Position/searchOpen 1 ×1)");
    vi.advanceTimersByTime(30_000);
    expect(h.logs.at(-1)?.message).toContain("rest 0/win");
    h.hub.stopHeartbeat();
  });

  it("drops the requests sent in the maintenance break instead of logging them after it", () => {
    takeTopstepRequestWindow();
    // 17:59:20 ET Wednesday: the first tick lands inside the nightly break,
    // the second just after it ends.
    vi.setSystemTime(new Date("2026-08-26T21:59:20Z"));
    const h = makeHub();
    noteTopstepRequest("/api/Position/searchOpen");
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    noteTopstepRequest("/api/Order/searchOpen");
    vi.advanceTimersByTime(30_000);
    const beats = h.logs.filter((l) => l.category === "heartbeat");
    expect(beats).toHaveLength(1);
    expect(beats[0].message).toContain("rest 1/win, 0 refused (Order/searchOpen 1)");
    h.hub.stopHeartbeat();
  });

  it("retries an unresolved contract every five minutes until it resolves", async () => {
    vi.mocked(resolveTimeframe).mockReturnValue("1m");
    const h = makeHub();
    const legs = [deployment("a", { ticker: "MES" as TickerSymbol })];
    h.setDeployments(legs);
    await h.hub.syncContractSubs(legs);
    expect(subsOf(h.hub)).toEqual([]);
    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(h.deps.resolveContract).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.resolveContract).toHaveBeenCalledTimes(2);
    expect(h.logs.filter((l) => l.event === "deployment_contract_unresolved")).toHaveLength(2);
    h.contracts.set("MES", contract(MES));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(subsOf(h.hub)).toEqual([MES]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.deps.resolveContract).toHaveBeenCalledTimes(3);
    h.hub.stopHeartbeat();
  });

  it("stops emitting after stopHeartbeat", () => {
    const h = makeHub();
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    const emitted = h.logs.length;
    expect(emitted).toBeGreaterThan(0);
    h.hub.stopHeartbeat();
    vi.advanceTimersByTime(90_000);
    expect(h.logs).toHaveLength(emitted);
  });

  it("fires one user-hub reconnect per rate-limit window, not one per tick", async () => {
    const h = makeHub({ userHubState: vi.fn(() => "Disconnected") });
    h.setDeployments([deployment("a")]);
    h.hub.startHeartbeat();
    // Two ticks inside the 60s window. Async advance so the `.then` that
    // stamps the rate-limit anchor runs between them, as it does in
    // production where the interval is orders of magnitude longer than the
    // reconnect promise.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(1);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledWith("heartbeat");
    h.hub.stopHeartbeat();
  });

  it("A29: holds the window while an attempt is still unsettled — the anchor is stamped at the call", () => {
    // The anchor used to be written in the attempt's `.then`, so the gate
    // held only once the attempt settled: a slow one (a rebuild awaiting the
    // gateway) left the next tick free to fire again. A never-settling
    // attempt is the limit of slow.
    const h = makeHub({
      userHubState: vi.fn(() => "Disconnected"),
      reconnectUserHub: vi.fn(() => new Promise<boolean>(() => {})),
    });
    h.setDeployments([deployment("a")]);
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(60_000);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(2);
    h.hub.stopHeartbeat();
  });

  it("does not burn the rate-limit window when no attempt actually ran", async () => {
    const h = makeHub({
      userHubState: vi.fn(() => "Disconnected"),
      reconnectUserHub: vi.fn(async () => false),
    });
    h.setDeployments([deployment("a")]);
    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(60_000);
    // A short-circuited attempt reports false, the anchor stays at 0, and
    // every subsequent tick is still eligible.
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(2);
    h.hub.stopHeartbeat();
  });

  it("does not touch the user hub when no deployment is active", () => {
    const h = makeHub({ userHubState: vi.fn(() => "Disconnected") });
    h.setDeployments([]);
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(120_000);
    expect(h.deps.reconnectUserHub).not.toHaveBeenCalled();
    h.hub.stopHeartbeat();
  });

  it("does not touch the user hub while it reports Connected", () => {
    const h = makeHub();
    h.setDeployments([deployment("a")]);
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(120_000);
    expect(h.deps.reconnectUserHub).not.toHaveBeenCalled();
    h.hub.stopHeartbeat();
  });

  it("escalates a wedged market hub to error only once contracts are subscribed", async () => {
    const h = makeHub();
    h.signalr.getMarketHubState.mockReturnValue("Disconnected");
    h.hub.startHeartbeat();
    vi.advanceTimersByTime(30_000);
    expect(h.logs.some((l) => l.severity === "error")).toBe(false);

    // One clock for the whole test. Swapping to real timers to await the
    // resolver would strand the interval started above, forcing a
    // stop/start that hides which heartbeat produced the error below.
    await h.hub.syncContractSubs([deployment("a")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      h.logs.some(
        (l) =>
          l.event === "hub_wedged" &&
          l.severity === "error" &&
          l.message.includes("state=Disconnected"),
      ),
    ).toBe(true);
    h.hub.stopHeartbeat();
  });

  // The property `HEARTBEAT_MS` is chosen for, asserted against the two
  // constants that bracket it rather than against the cadence itself — so a
  // future edit to either threshold fails here instead of silently losing
  // the ordering the warn site promises.
  it("warns about trade silence before the stall watchdog would trip on it", async () => {
    const h = makeHub();
    await h.hub.syncContractSubs([deployment("a")]);
    h.hub.noteTradeActivity();
    h.hub.startHeartbeat();

    await vi.advanceTimersByTimeAsync(MARKET_HUB_STALL_MS - 1);
    h.hub.stopHeartbeat();

    const warns = h.logs.filter(
      (l) =>
        l.event === "hub_trade_silence" &&
        l.severity === "warn" &&
        l.message.includes("No market trades for"),
    );
    expect(warns.length).toBeGreaterThan(0);

    // A check has to land strictly inside the (warn, stall) window. At a 60s
    // cadence none does: the t=60 check reads an age of exactly 60, `> 60` is
    // false, and the next one is the instant the watchdog acts.
    const match = /No market trades for (\d+)s/.exec(warns[0].message);
    expect(match).not.toBeNull();
    const ageS = Number(match?.[1]);
    expect(ageS).toBeGreaterThan(HEARTBEAT_TRADE_SILENCE_WARN_S);
    expect(ageS * 1000).toBeLessThan(MARKET_HUB_STALL_MS);
  });
});

/**
 * A3: `/Auth/validate` rotates the bearer roughly daily, and the Topstep
 * session is bound to the token that opened the socket — so the hubs are
 * retired while both still report `Connected`. Neither existing check can
 * see that: the market hub's stall watchdog needs 120s of trade silence and
 * at least one subscription, and the user hub's anomaly trigger is
 * `userState !== "Connected"`, which never becomes true.
 *
 * The rotation is a REST-side event: `getEngineClient()` calls `getToken()`,
 * whose warm path re-stamps the shared client. The harness models exactly
 * that — `setBrokerToken` writes the token and `brokerToken` reads it, so a
 * "rotation" is a write nothing on the hub path made.
 */
describe("startHeartbeat — token rotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 14:00 ET, mid-session — outside every maintenance window, or
    // the heartbeat body returns before any of this runs.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A hub connected on `minted`, with the client token wired the way the
   *  engine wires it. `rotate()` is what a REST caller's refresh does.
   *
   *  `userHubState` is stated rather than inherited: a user hub reporting
   *  `Connected` is the precondition the whole block turns on, and leaving
   *  it to `makeHub`'s default would let a change there silently retire the
   *  case. */
  async function connectedHub(minted = "tok-a") {
    let clientToken: string | null = null;
    vi.mocked(validateOrRefreshToken).mockImplementation(async () => minted);
    const h = makeHub({
      setBrokerToken: vi.fn((t: string) => {
        clientToken = t;
      }),
      brokerToken: vi.fn(() => clientToken),
      userHubState: vi.fn(() => "Connected"),
    });
    await h.hub.connect();
    return {
      ...h,
      rotate: (t: string) => {
        clientToken = t;
      },
      mint: (t: string) => {
        minted = t;
      },
      currentToken: () => clientToken,
    };
  }

  it("leaves both hubs alone while the token is unchanged", async () => {
    const h = await connectedHub();
    h.signalr.disconnectMarket.mockClear();
    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(90_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.logs.some((l) => l.event === "hub_token_rotated")).toBe(false);
    expect(h.signalr.disconnectMarket).not.toHaveBeenCalled();
    expect(h.deps.reconnectUserHub).not.toHaveBeenCalled();
  });

  it("rebuilds the market hub when the token rotates underneath it", async () => {
    const h = await connectedHub();
    h.signalr.disconnectMarket.mockClear();
    h.signalr.buildMarketHub.mockClear();
    h.mint("tok-b");
    h.rotate("tok-b");

    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.message.startsWith("Re-subscribed market-hub trades"))).toHaveLength(1);
    const line = h.logs.find((l) => l.event === "hub_token_rotated");
    expect(line?.severity).toBe("warn");
    expect(line?.message).toContain("rotated");
  });

  it("reconnects the user hub even though it reports Connected", async () => {
    // The property nothing else in the engine can produce: every other
    // user-hub reconnect trigger is gated on a state that a retired session
    // never reports.
    const h = await connectedHub();
    h.mint("tok-b");
    h.rotate("tok-b");

    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.deps.reconnectUserHub).toHaveBeenCalledWith("token-rotation");
  });

  it("fires once per rotation, not once per heartbeat", async () => {
    // `warn` is never emitted per-tick, and the rebuild is a feed gap. The
    // throttle is the stamp: the new token becomes the hub's session before
    // the line is written.
    const h = await connectedHub();
    h.mint("tok-b");
    h.rotate("tok-b");

    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(150_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.logs.filter((l) => l.event === "hub_token_rotated")).toHaveLength(1);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire when the rebuild's own validate rotates again", async () => {
    // The loop this design has to avoid: the rebuild calls
    // `validateOrRefreshToken`, which can itself hand back a new token.
    // `connect()` stamps what it actually used, so the next tick compares
    // equal.
    const h = await connectedHub();
    h.mint("tok-c");
    h.rotate("tok-b");

    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(150_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.currentToken()).toBe("tok-c");
    expect(h.logs.filter((l) => l.event === "hub_token_rotated")).toHaveLength(1);
  });

  it("A79: rebuildOnTokenMove rebuilds both hubs at once, and the next heartbeat does not fire again", async () => {
    // The engine's entry for a rotation its own user-hub validate caused.
    const h = await connectedHub();
    h.signalr.disconnectMarket.mockClear();
    h.mint("tok-b");
    h.rotate("tok-b");
    expect(h.hub.tokenMovedUnderHubs()).toBe(true);

    await h.hub.rebuildOnTokenMove();
    expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledWith("token-rotation");
    expect(h.hub.tokenMovedUnderHubs()).toBe(false);

    h.hub.startHeartbeat();
    await vi.advanceTimersByTimeAsync(90_000);
    h.hub.stopHeartbeat();
    h.hub.shutdown();

    expect(h.logs.filter((l) => l.event === "hub_token_rotated")).toHaveLength(1);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledTimes(1);
  });

  it("A79: rebuildOnTokenMove does nothing while the token has not moved", async () => {
    const h = await connectedHub();
    h.signalr.disconnectMarket.mockClear();

    await h.hub.rebuildOnTokenMove();
    h.hub.shutdown();

    expect(h.signalr.disconnectMarket).not.toHaveBeenCalled();
    expect(h.deps.reconnectUserHub).not.toHaveBeenCalled();
  });

  it("stays quiet before the first connect, when no session is recorded yet", async () => {
    // The heartbeat is armed at boot and `connect()` can fail or be skipped
    // entirely (USE_REALTIME_BARS off). A token with nothing to compare it
    // against is not a rotation.
    let clientToken: string | null = "tok-a";
    const h = makeHub({ brokerToken: vi.fn(() => clientToken) });
    h.hub.startHeartbeat();
    clientToken = "tok-b";
    await vi.advanceTimersByTimeAsync(60_000);
    h.hub.stopHeartbeat();

    expect(h.logs.some((l) => l.event === "hub_token_rotated")).toBe(false);
    expect(h.deps.reconnectUserHub).not.toHaveBeenCalled();
  });
});

/**
 * A79: a `gatewaylogout` advisory had no expiry, so one that arrived at
 * maintenance-end (the session carried on) turned a network drop 2h41m later
 * into a deliberate kick — auto-retry off, hub parked for 13 hours. Only a
 * close landing inside the window the user hub already uses is a kick.
 */
describe("onMarketClose — the gatewaylogout close window (A79)", () => {
  const ADVISORY = "Multiple sessions detected. You have been disconnected from this session.";

  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 14:00 ET, mid-session — no maintenance window in play.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectedHub() {
    const h = makeHub();
    await h.hub.connect();
    const onLogout = h.signalr.onMarketGatewayLogout.mock.calls[0][0] as (r: string) => void;
    const onClose = h.signalr.onMarketClose.mock.calls[0][0] as (err?: Error) => void;
    return { ...h, onLogout, onClose };
  }

  it("treats a close inside the window as a kick — passive with auto-retry off", async () => {
    const h = await connectedHub();
    h.onLogout(ADVISORY);
    vi.advanceTimersByTime(GATEWAY_LOGOUT_CLOSE_WINDOW_MS);
    h.onClose();

    expect(h.hub.status()).toEqual({
      mode: "passive",
      autoRetry: false,
      lastDisconnectReason: ADVISORY,
    });
    h.hub.shutdown();
  });

  it("treats the same close after the window as ordinary — auto-retry on, and the close's own reason", async () => {
    const h = await connectedHub();
    h.onLogout(ADVISORY);
    vi.advanceTimersByTime(GATEWAY_LOGOUT_CLOSE_WINDOW_MS + 1);
    h.onClose(new Error("WebSocket closed with status code: 1006"));

    expect(h.hub.status()).toEqual({
      mode: "passive",
      autoRetry: true,
      lastDisconnectReason: "WebSocket closed with status code: 1006",
    });
    const line = h.logs.find((l) => l.event === "hub_disconnected");
    expect(line?.message).not.toContain("Multiple sessions");
    h.hub.shutdown();
  });

  it("reports a clean close after a stale advisory as a generic close, not the advisory", async () => {
    const h = await connectedHub();
    h.onLogout(ADVISORY);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    h.onClose();

    expect(h.hub.status().autoRetry).toBe(true);
    expect(h.hub.status().lastDisconnectReason).toBe("Connection closed");
    h.hub.shutdown();
  });
});

/**
 * A90: a dead-token recovery mints with `loginKey`, and the gateway answers
 * every login with `gatewaylogout` to the user's other sessions — our own
 * hubs. A close inside the window after that advisory parked the hub as
 * kicked (auto-retry off) while REST had recovered; nothing but an operator
 * or the next maintenance-end brought the tape back, because the rotation
 * rebuild skips a passive hub. The login is driven through the real
 * `TopstepClient.authenticate`, the one site every login in the process
 * passes through.
 */
describe("onMarketClose — an advisory our own login caused is not a kick (A90)", () => {
  const ADVISORY = "Multiple sessions detected. You have been disconnected from this session.";

  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 14:00 ET, mid-session — no maintenance window in play.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
    vi.mocked(sendConnectionAlert).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, token: "minted", errorCode: 0, errorMessage: null }), {
            status: 200,
          }),
      ),
    );
  });
  afterEach(() => {
    // Process-global: left set, a later test at the same fake time would
    // read its advisory as our own login.
    topstepSessionState().lastLoginAtMs = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connectedHub() {
    const h = makeHub();
    await h.hub.connect();
    const onLogout = h.signalr.onMarketGatewayLogout.mock.calls[0][0] as (r: string) => void;
    const onClose = h.signalr.onMarketClose.mock.calls[0][0] as (err?: Error) => void;
    return { ...h, onLogout, onClose };
  }

  it("A90: a close right after the advisory our own login sent keeps auto-retry on and sends no kick alert", async () => {
    const h = await connectedHub();
    vi.advanceTimersByTime(1);
    await new TopstepClient().authenticate({ userName: "u", apiKey: "k" });
    h.onLogout(ADVISORY);
    h.onClose();

    expect(h.hub.status()).toEqual({
      mode: "passive",
      autoRetry: true,
      lastDisconnectReason: "Connection closed",
    });
    expect(sendConnectionAlert).not.toHaveBeenCalled();
    h.hub.shutdown();
  });

  // The login connect() made displaced another device's session, not this
  // hub's. That device logging back in within the window is a real kick;
  // swallowed, the hub retried every 60 s and re-displaced it, never parking.
  it("A90: an advisory after the login this hub's own connect() made is still a kick", async () => {
    vi.mocked(validateOrRefreshToken).mockImplementationOnce(async () =>
      new TopstepClient().authenticate({ userName: "u", apiKey: "k" }),
    );
    const h = await connectedHub();
    vi.advanceTimersByTime(2_000);
    h.onLogout(ADVISORY);
    h.onClose();

    expect(h.hub.status().autoRetry).toBe(false);
    expect(sendConnectionAlert).toHaveBeenCalledTimes(1);
    h.hub.shutdown();
  });

  it("A90: an advisory arriving well after our last login is still a kick", async () => {
    const h = await connectedHub();
    vi.advanceTimersByTime(1);
    await new TopstepClient().authenticate({ userName: "u", apiKey: "k" });
    vi.advanceTimersByTime(OWN_LOGIN_ADVISORY_WINDOW_MS + 1);
    h.onLogout(ADVISORY);
    h.onClose();

    expect(h.hub.status().autoRetry).toBe(false);
    expect(sendConnectionAlert).toHaveBeenCalledTimes(1);
    h.hub.shutdown();
  });
});

/**
 * `shutdown()` is a barrier, not a sweep. The punchlist's sequence: the hub is
 * passive, the 60s loop's `attemptReconnect()` suspends on an await, Stop
 * lands, the reconnect resumes — and before the barrier it connected, armed a
 * fresh watchdog on the stopped engine, and the next close of that socket
 * swapped the REST tick back on and re-armed the heal. Each test parks the
 * awaited call itself, so the interleaving is the real one rather than a
 * replay of it.
 */
describe("shutdown() is a barrier — a reconnect in flight arms nothing afterwards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 14:00 ET, mid-session — no maintenance window, so the close
    // arms the 60s loop rather than deferring to the heal.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
    vi.mocked(validateOrRefreshToken).mockImplementation(async () => "tok");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A promise the test resolves by hand: the suspension point. */
  function parked(): { promise: Promise<void>; release(): void } {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /** Connected, then dropped by an ordinary close: passive, 60s loop armed. */
  async function passiveHub() {
    const h = makeHub();
    await h.hub.connect();
    const close = h.signalr.onMarketClose.mock.calls[0][0] as (err?: Error) => void;
    close(new Error("WebSocket closed with status code: 1006"));
    expect(h.hub.mode()).toBe("passive");
    expect(h.deps.swapTickHandler).toHaveBeenCalledWith("passive");
    return h;
  }

  /** The close handler the most recent hub build registered. */
  function latestClose(h: Harness): (err?: Error) => void {
    const calls = h.signalr.onMarketClose.mock.calls;
    return calls[calls.length - 1][0] as (err?: Error) => void;
  }

  it("a reconnect suspended on disconnectMarket across shutdown() opens no hub and arms no timer", async () => {
    const h = await passiveHub();
    const disconnect = parked();
    h.signalr.disconnectMarket.mockImplementationOnce(() => disconnect.promise);

    // Step 1: the loop fires and the attempt suspends on the disconnect.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.logs.some((l) => l.event === "hub_reconnecting")).toBe(true);

    // Step 2: Stop.
    h.hub.shutdown();
    expect(vi.getTimerCount()).toBe(0);

    // Step 3: the suspended attempt resumes.
    disconnect.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
    expect(h.signalr.startMarketHub).toHaveBeenCalledTimes(1);
    // The watchdog is a 30s interval: armed, it would be counted here.
    expect(vi.getTimerCount()).toBe(0);
    expect(h.logs.some((l) => l.event === "hub_reconnected")).toBe(false);
    expect(h.logs.some((l) => l.message.includes("abandoned — the engine stopped"))).toBe(true);

    // Step 4: the socket closes later. No tick swap, no heal, no loop.
    h.deps.swapTickHandler.mockClear();
    latestClose(h)(new Error("WebSocket closed with status code: 1006"));
    expect(h.deps.swapTickHandler).not.toHaveBeenCalled();
    expect(h.hub.mode()).toBe("realtime");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
  });

  it("a reconnect suspended inside connect() across shutdown() builds no hub", async () => {
    // The user hub's fix needed the same half: the attempt can be mid-connect,
    // past the disconnect, when the stop lands.
    const h = await passiveHub();
    const validate = parked();
    vi.mocked(validateOrRefreshToken).mockImplementationOnce(async () => {
      await validate.promise;
      return "tok";
    });

    await vi.advanceTimersByTimeAsync(60_000);
    h.hub.shutdown();
    validate.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.deps.swapTickHandler.mockClear();
    latestClose(h)();
    expect(h.deps.swapTickHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hub connected when shutdown() lands mid-resubscribe keeps no watchdog", async () => {
    const h = await passiveHub();
    h.setDeployments([deployment("d1")]);
    await h.hub.syncContractSubs([deployment("d1")]);
    const resubscribe = parked();
    h.signalr.subscribeTrades.mockImplementationOnce(() => resubscribe.promise);

    await vi.advanceTimersByTimeAsync(60_000);
    // Connected and its watchdog armed before the stop; the stop clears it.
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(2);
    h.hub.shutdown();
    resubscribe.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(h.logs.some((l) => l.event === "hub_reconnected")).toBe(false);
  });

  it("a close on a stopped engine marks the hub down, so the next start reconnects", async () => {
    const h = makeHub();
    await h.hub.connect();
    h.hub.shutdown();
    latestClose(h)();
    expect(h.hub.isReady()).toBe(false);
    expect(h.deps.swapTickHandler).not.toHaveBeenCalled();
  });

  it("a connect() after shutdown() works as it always has: watchdog armed, a close goes passive", async () => {
    const h = await passiveHub();
    h.hub.shutdown();

    await h.hub.connect();
    expect(h.hub.isReady()).toBe(true);
    // The watchdog, and nothing else.
    expect(vi.getTimerCount()).toBe(1);

    h.deps.swapTickHandler.mockClear();
    latestClose(h)(new Error("WebSocket closed with status code: 1006"));
    expect(h.hub.mode()).toBe("passive");
    expect(h.deps.swapTickHandler).toHaveBeenCalledWith("passive");
    h.hub.shutdown();
  });

  it("a start over a hub that stayed open lifts the barrier through startHeartbeat", async () => {
    // `start()` calls `connect()` only when the hub is down; over an open one
    // its only call into the controller is `startHeartbeat()`.
    const h = makeHub();
    await h.hub.connect();
    h.hub.shutdown();
    h.hub.stopHeartbeat();

    h.hub.startHeartbeat();
    latestClose(h)(new Error("WebSocket closed with status code: 1006"));
    expect(h.hub.mode()).toBe("passive");
    expect(h.deps.swapTickHandler).toHaveBeenCalledWith("passive");
    h.hub.stopHeartbeat();
    h.hub.shutdown();
  });

  /** The punchlist's step 3, literally: the reconnect is parked in
   *  `startMarketHub` when the stop lands, so the hub it opens is ready on a
   *  stopped engine. */
  async function hubRacedOpenAcrossStop() {
    const h = await passiveHub();
    const start = parked();
    h.signalr.startMarketHub.mockImplementationOnce(() => start.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(2);

    h.hub.shutdown();
    h.hub.stopHeartbeat();
    start.release();
    await vi.advanceTimersByTimeAsync(0);
    return h;
  }

  it("a reconnect parked in startMarketHub when shutdown() lands arms no watchdog, and a later close re-arms nothing", async () => {
    const h = await hubRacedOpenAcrossStop();

    // The socket did open: the next `start()` must not build a second hub.
    expect(h.hub.isReady()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.logs.some((l) => l.event === "hub_reconnected")).toBe(false);

    h.deps.swapTickHandler.mockClear();
    latestClose(h)(new Error("WebSocket closed with status code: 1006"));
    expect(h.deps.swapTickHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a start over the hub that reconnect raced open re-arms the silent-death watchdog", async () => {
    const h = await hubRacedOpenAcrossStop();
    h.setDeployments([deployment("d1")]);
    await h.hub.syncContractSubs([deployment("d1")]);
    h.signalr.disconnectMarket.mockClear();

    // `start()` sees `isReady()` and makes no `connect()`; this is its call.
    h.hub.startHeartbeat();
    // The heartbeat and the watchdog.
    expect(vi.getTimerCount()).toBe(2);

    // Armed, it acts on a stall: the inline retry tears the silent hub down.
    await vi.advanceTimersByTimeAsync(MARKET_HUB_STALL_MS + 60_000);
    expect(h.signalr.disconnectMarket).toHaveBeenCalled();
    h.hub.stopHeartbeat();
    h.hub.shutdown();
  });

  it("a rotation rebuild abandoned by a stop still reconnects the user hub", async () => {
    // A retired session is the one state nothing else reconnects, and the user
    // hub is the dashboard's feed as well as the engine's.
    vi.mocked(validateOrRefreshToken).mockImplementation(async () => "tok-a");
    let clientToken: string | null = null;
    const h = makeHub({
      setBrokerToken: vi.fn((t: string) => {
        clientToken = t;
      }),
      brokerToken: vi.fn(() => clientToken),
    });
    await h.hub.connect();
    clientToken = "tok-b";
    const disconnect = parked();
    h.signalr.disconnectMarket.mockImplementationOnce(() => disconnect.promise);

    const rebuild = h.hub.rebuildOnTokenMove();
    h.hub.shutdown();
    disconnect.release();
    await rebuild;

    expect(h.logs.some((l) => l.message.startsWith("Market hub rebuild after token rotation abandoned"))).toBe(true);
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
    expect(h.deps.reconnectUserHub).toHaveBeenCalledWith("token-rotation");
  });

  it("a manual reconnect on an already-stopped engine still reconnects, and arms no watchdog", async () => {
    const h = makeHub();
    await h.hub.connect();
    h.hub.shutdown();

    await expect(h.hub.reconnectManually()).resolves.toEqual({ ok: true });
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
