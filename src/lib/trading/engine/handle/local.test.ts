import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  singleton: {
    getEngine: vi.fn(),
    getEngineIfReady: vi.fn(),
    activateFromSettings: vi.fn(),
    getTopstepClientIfConfigured: vi.fn(),
    getLogsByLevel: vi.fn(),
    clearAllLogs: vi.fn(),
    getTradovateRealtimeAdapter: vi.fn(),
  },
  bootAssertion: {
    getBootAssertionState: vi.fn(),
    getBootAssertionFailureReason: vi.fn(),
  },
  allowlist: { getStagingAllowlist: vi.fn() },
  accountView: {
    readPositionsThrough: vi.fn(),
    readOrdersThrough: vi.fn(),
  },
  deployments: { listManagedDeployments: vi.fn() },
  peekBroadcaster: vi.fn(),
  getBroadcaster: vi.fn(),
  topstepBrowserToken: vi.fn(),
  topstepClients: [] as Array<{ setToken: ReturnType<typeof vi.fn>; token: string | null }>,
  searchOpenPositions: vi.fn(),
  searchOpenOrders: vi.fn(),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => h.singleton);
vi.mock("@/lib/trading/engine/boot/boot-assertion", () => h.bootAssertion);
vi.mock("@/lib/trading/broker-access/staging-allowlist", () => h.allowlist);
vi.mock("@/lib/trading/engine/realtime/account-view", () => h.accountView);
vi.mock("@/lib/db/deployments", () => h.deployments);
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: h.peekBroadcaster,
  getBroadcaster: h.getBroadcaster,
}));
vi.mock("@/lib/brokers/topstep/browser-token", () => ({ topstepBrowserToken: h.topstepBrowserToken }));
vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const client = { setToken: vi.fn(), token: null };
    h.topstepClients.push(client);
    this.setToken = client.setToken;
    this.searchOpenPositions = h.searchOpenPositions;
    this.searchOpenOrders = h.searchOpenOrders;
  }),
}));

import { localEngineHandle } from "./local";
import type { EngineHandle } from "./index";

const handle = localEngineHandle();
type Method = keyof EngineHandle;
type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.topstepClients.length = 0;
});

const ENGINE_SESSION_ID = "session-under-test";

/** An engine whose every method answers `{ from: <name> }`, and its session id. */
function fakeEngine(): Record<string, Mock> {
  const methods = [
    "start", "stop", "sync", "isRunning", "getMarketHubStatus", "getSeamHealth", "getSetupReadings",
    "reconnectMarketHubManually", "checkAccountStatuses", "refreshBrokerRegistry", "isAccountRegistered",
    "handleOrphanedAccount", "areHubsReady", "reloadTradovateClients", "invalidateAccountNames",
    "nudgeClosingGuard", "peekState", "forceFlatDeployment", "exitsInFlightForAccount",
    "previewManualPositionClaim", "marketDataContractId", "broadcasterDeps",
  ];
  const engine: Record<string, unknown> = Object.fromEntries(methods.map((m) => [m, vi.fn(() => ({ from: m }))]));
  engine.engineSessionId = ENGINE_SESSION_ID;
  return engine as Record<string, Mock>;
}

const DEPLOYMENTS = [{ id: "d1" }];
const CLAIM = { accountId: 42, ticker: "/MNQ", strategyKey: "orb", paramValues: {} };

/** Arguments every method is called with below. */
const ARGS: Record<Method, unknown[]> = {
  ensureEngine: [],
  start: [DEPLOYMENTS],
  stop: [],
  sync: [DEPLOYMENTS],
  isRunning: [],
  status: [],
  reconnectMarketHub: [],
  checkAccountStatuses: [],
  refreshBrokerRegistry: [],
  registeredAccountIds: [[1, 2]],
  handleOrphanedAccount: [42, "account_missing"],
  syncIfRunning: [],
  stopIfRunning: [],
  nudgeClosingGuard: [],
  peekLegPosition: ["d3"],
  forceFlatDeployment: ["d4"],
  exitsInFlightForAccount: [42],
  previewManualPositionClaim: [CLAIM],
  engineSessionId: [],
  marketDataContractId: ["MNQZ6"],
  areHubsReady: [],
  reloadTradovateClients: [],
  invalidateAccountNames: [],
  activateFromSettings: [],
  listTopstepAccounts: [],
  getLogsByLevel: [25],
  clearAllLogs: [],
  getBootAssertionState: [],
  getBootAssertionFailureReason: [],
  getStagingAllowlist: [],
  emitDeploymentsChanged: [],
  emitStrategyTradeClosedIfRunning: [[{ accountId: 42, deploymentId: "d5" }]],
  getConnectedState: [],
  subscribeEvents: ["sse-key", () => {}],
  ensureRunning: [[42], ["CON.F.US.MNQ.Z26"]],
  retainContractTrades: [["CON.F.US.MNQ.Z26"]],
  readPositions: [42],
  readOrders: [42],
  resolveDatedSymbols: [["4799969"]],
};

/**
 * Build or peek, per method — the property the interface states on each one.
 * `build` goes through the singleton's `getEngine()`; `peek` never does and
 * answers as below when nothing was built; `state` is process-wide state and
 * reaches no engine at all.
 */
const MODE: Record<Method, "build" | "peek" | "state"> = {
  ensureEngine: "build",
  start: "build",
  stop: "build",
  sync: "build",
  isRunning: "build",
  status: "build",
  reconnectMarketHub: "build",
  checkAccountStatuses: "build",
  refreshBrokerRegistry: "build",
  registeredAccountIds: "build",
  handleOrphanedAccount: "build",
  getConnectedState: "build",
  subscribeEvents: "build",
  ensureRunning: "build",
  retainContractTrades: "build",
  syncIfRunning: "peek",
  stopIfRunning: "peek",
  nudgeClosingGuard: "peek",
  peekLegPosition: "peek",
  forceFlatDeployment: "peek",
  exitsInFlightForAccount: "peek",
  previewManualPositionClaim: "peek",
  engineSessionId: "peek",
  marketDataContractId: "peek",
  areHubsReady: "peek",
  reloadTradovateClients: "peek",
  invalidateAccountNames: "peek",
  emitDeploymentsChanged: "peek",
  emitStrategyTradeClosedIfRunning: "peek",
  resolveDatedSymbols: "peek",
  activateFromSettings: "state",
  listTopstepAccounts: "state",
  getLogsByLevel: "state",
  clearAllLogs: "state",
  getBootAssertionState: "state",
  getBootAssertionFailureReason: "state",
  getStagingAllowlist: "state",
  readPositions: "state",
  readOrders: "state",
};

/** What a peek answers when no engine (or broadcaster, or adapter) was built. */
const PEEK_WITH_NOTHING_BUILT: Partial<Record<Method, unknown>> = {
  peekLegPosition: null,
  forceFlatDeployment: null,
  exitsInFlightForAccount: null,
  previewManualPositionClaim: null,
  engineSessionId: null,
  marketDataContractId: null,
  areHubsReady: null,
  resolveDatedSymbols: null,
};

const METHODS = Object.keys(MODE) as Method[];

function call(method: Method): Promise<unknown> {
  return (handle[method] as (...a: unknown[]) => Promise<unknown>)(...ARGS[method]);
}

describe("localEngineHandle — build or peek", () => {
  it("covers every handle method", () => {
    expect(Object.keys(handle).sort()).toEqual([...METHODS].sort());
  });

  it.each(METHODS.filter((m) => MODE[m] === "build"))("%s builds the engine and never peeks", async (method) => {
    const engine = fakeEngine();
    h.singleton.getEngine.mockResolvedValue(engine);
    h.getBroadcaster.mockReturnValue(null);
    await call(method);
    expect(h.singleton.getEngine).toHaveBeenCalledTimes(1);
    expect(h.singleton.getEngineIfReady).not.toHaveBeenCalled();
  });

  it.each(METHODS.filter((m) => MODE[m] === "peek"))(
    "%s peeks: with nothing built it never builds and answers as the route short-circuited",
    async (method) => {
      h.singleton.getEngineIfReady.mockReturnValue(null);
      h.peekBroadcaster.mockReturnValue(null);
      h.singleton.getTradovateRealtimeAdapter.mockReturnValue(null);
      await expect(call(method)).resolves.toBe(PEEK_WITH_NOTHING_BUILT[method]);
      expect(h.singleton.getEngine).not.toHaveBeenCalled();
      expect(h.getBroadcaster).not.toHaveBeenCalled();
      expect(h.deployments.listManagedDeployments).not.toHaveBeenCalled();
    },
  );

  it.each(METHODS.filter((m) => MODE[m] === "state"))("%s reaches no engine", async (method) => {
    h.singleton.getTopstepClientIfConfigured.mockResolvedValue(null);
    h.accountView.readPositionsThrough.mockResolvedValue({ items: [], asOf: 1, source: "sweep", readAt: 1 });
    h.accountView.readOrdersThrough.mockResolvedValue({ items: [], asOf: 1, source: "sweep", readAt: 1 });
    await call(method);
    expect(h.singleton.getEngine).not.toHaveBeenCalled();
    expect(h.singleton.getEngineIfReady).not.toHaveBeenCalled();
  });

  it("a build method rejects with the engine's build error", async () => {
    const err = new Error("engine build failed");
    h.singleton.getEngine.mockRejectedValue(err);
    await expect(handle.getConnectedState()).rejects.toBe(err);
    expect(h.getBroadcaster).not.toHaveBeenCalled();
  });
});

/** Handle method → the engine method it stands for, when it is one call through. */
const ENGINE_DELEGATIONS: { method: Method; engineMethod: string; returns: boolean }[] = [
  { method: "start", engineMethod: "start", returns: false },
  { method: "stop", engineMethod: "stop", returns: false },
  { method: "sync", engineMethod: "sync", returns: false },
  { method: "isRunning", engineMethod: "isRunning", returns: true },
  { method: "reconnectMarketHub", engineMethod: "reconnectMarketHubManually", returns: true },
  { method: "checkAccountStatuses", engineMethod: "checkAccountStatuses", returns: true },
  { method: "refreshBrokerRegistry", engineMethod: "refreshBrokerRegistry", returns: false },
  { method: "handleOrphanedAccount", engineMethod: "handleOrphanedAccount", returns: true },
  { method: "stopIfRunning", engineMethod: "stop", returns: false },
  { method: "nudgeClosingGuard", engineMethod: "nudgeClosingGuard", returns: false },
  { method: "forceFlatDeployment", engineMethod: "forceFlatDeployment", returns: true },
  { method: "exitsInFlightForAccount", engineMethod: "exitsInFlightForAccount", returns: true },
  { method: "previewManualPositionClaim", engineMethod: "previewManualPositionClaim", returns: true },
  { method: "marketDataContractId", engineMethod: "marketDataContractId", returns: true },
  { method: "areHubsReady", engineMethod: "areHubsReady", returns: true },
  { method: "reloadTradovateClients", engineMethod: "reloadTradovateClients", returns: false },
  { method: "invalidateAccountNames", engineMethod: "invalidateAccountNames", returns: false },
];

function withEngine(method: Method) {
  const engine = fakeEngine();
  if (MODE[method] === "build") h.singleton.getEngine.mockResolvedValue(engine);
  else h.singleton.getEngineIfReady.mockReturnValue(engine);
  return engine;
}

describe("localEngineHandle — delegation to the engine", () => {
  it.each(ENGINE_DELEGATIONS)(
    "$method calls the engine's $engineMethod with the same arguments, as the engine",
    async ({ method, engineMethod, returns }) => {
      const engine = withEngine(method);
      const result = await call(method);
      expect(engine[engineMethod]).toHaveBeenCalledTimes(1);
      expect(engine[engineMethod]).toHaveBeenCalledWith(...ARGS[method]);
      expect(engine[engineMethod].mock.contexts[0]).toBe(engine);
      if (returns) expect(result).toEqual({ from: engineMethod });
    },
  );

  it("status reads the four readings off one built engine", async () => {
    const engine = withEngine("status");
    await expect(handle.status()).resolves.toEqual({
      running: { from: "isRunning" },
      marketHub: { from: "getMarketHubStatus" },
      health: { from: "getSeamHealth" },
      setups: { from: "getSetupReadings" },
    });
    expect(h.singleton.getEngine).toHaveBeenCalledTimes(1);
    expect(engine.isRunning).toHaveBeenCalledTimes(1);
  });

  it("registeredAccountIds keeps exactly the ids the engine's registry holds", async () => {
    const engine = withEngine("registeredAccountIds");
    engine.isAccountRegistered.mockImplementation((id: number) => id === 2);
    await expect(handle.registeredAccountIds([1, 2, 3])).resolves.toEqual([2]);
    expect(engine.isAccountRegistered.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("refreshBrokerRegistry answers the arms' answers and leaves the balance map behind", async () => {
    const engine = withEngine("refreshBrokerRegistry");
    const answer = {
      partial: true,
      errors: { topstep: null, tradovate: "down" },
      listed: { topstep: [1, 2], tradovate: null },
      balances: { topstep: new Map([[1, 50_000]]), tradovate: null },
      size: 2,
    };
    engine.refreshBrokerRegistry.mockResolvedValue(answer);
    await expect(handle.refreshBrokerRegistry()).resolves.toStrictEqual({
      partial: true,
      errors: answer.errors,
      listed: answer.listed,
    });
  });

  it("syncIfRunning syncs the running engine to the managed set it reads then", async () => {
    const engine = withEngine("syncIfRunning");
    h.deployments.listManagedDeployments.mockReturnValue(DEPLOYMENTS);
    await handle.syncIfRunning();
    expect(engine.sync).toHaveBeenCalledWith(DEPLOYMENTS);
  });

  it("engineSessionId is the running engine's own", async () => {
    withEngine("engineSessionId");
    await expect(handle.engineSessionId()).resolves.toBe(ENGINE_SESSION_ID);
  });

  it("peekLegPosition hands back a copy, never the engine's mirror", async () => {
    const engine = withEngine("peekLegPosition");
    const position = { side: 0, entryPrice: 21000, entryTimestamp: "t", barsSinceEntry: 1, entryFilledAt: null, size: 1, slTicks: 40 };
    engine.peekState.mockReturnValue({ position });
    const view = await handle.peekLegPosition("d3");
    expect(view).toEqual({ position });
    expect(view?.position).not.toBe(position);
    engine.peekState.mockReturnValue({ position: null });
    await expect(handle.peekLegPosition("d3")).resolves.toEqual({ position: null });
    engine.peekState.mockReturnValue(undefined);
    await expect(handle.peekLegPosition("d3")).resolves.toBeNull();
  });

  it("reloadTradovateClients rejects with the reload's own failure", async () => {
    const engine = withEngine("reloadTradovateClients");
    const err = new Error("reload failed");
    engine.reloadTradovateClients.mockRejectedValue(err);
    await expect(handle.reloadTradovateClients()).rejects.toBe(err);
  });
});

describe("localEngineHandle — process-wide state", () => {
  it.each([
    { method: "activateFromSettings", target: () => h.singleton.activateFromSettings },
    { method: "getLogsByLevel", target: () => h.singleton.getLogsByLevel },
    { method: "clearAllLogs", target: () => h.singleton.clearAllLogs },
    { method: "getBootAssertionState", target: () => h.bootAssertion.getBootAssertionState },
    { method: "getBootAssertionFailureReason", target: () => h.bootAssertion.getBootAssertionFailureReason },
  ] as { method: Method; target: () => Mock }[])(
    "$method calls the same-named function with the same arguments and answers its result",
    async ({ method, target }) => {
      target().mockReturnValue({ from: method });
      await expect(call(method)).resolves.toEqual({ from: method });
      expect(target()).toHaveBeenCalledTimes(1);
      expect(target()).toHaveBeenCalledWith(...ARGS[method]);
    },
  );

  it("getStagingAllowlist answers the set as an array, and null as null", async () => {
    h.allowlist.getStagingAllowlist.mockReturnValue(new Set([7, 9]));
    await expect(handle.getStagingAllowlist()).resolves.toEqual([7, 9]);
    h.allowlist.getStagingAllowlist.mockReturnValue(null);
    await expect(handle.getStagingAllowlist()).resolves.toBeNull();
  });

  it("listTopstepAccounts is the roster through the engine's client, and empty with no client", async () => {
    const accounts = [{ id: 1, name: "PRAC-1", practice: true }];
    const searchAccounts = vi.fn().mockResolvedValue(accounts);
    h.singleton.getTopstepClientIfConfigured.mockResolvedValue({ searchAccounts });
    await expect(handle.listTopstepAccounts()).resolves.toBe(accounts);
    expect(searchAccounts).toHaveBeenCalledWith();
    h.singleton.getTopstepClientIfConfigured.mockResolvedValue(null);
    await expect(handle.listTopstepAccounts()).resolves.toEqual([]);
  });

  it("listTopstepAccounts rejects with a Topstep throw", async () => {
    const err = new Error("Topstep down");
    h.singleton.getTopstepClientIfConfigured.mockResolvedValue({ searchAccounts: vi.fn().mockRejectedValue(err) });
    await expect(handle.listTopstepAccounts()).rejects.toBe(err);
  });
});

describe("localEngineHandle — the broadcaster", () => {
  const deps = { from: "broadcasterDeps" };

  function withRelay() {
    const engine = fakeEngine();
    engine.broadcasterDeps.mockReturnValue(deps);
    h.singleton.getEngine.mockResolvedValue(engine);
    const relay = {
      getConnectedState: vi.fn(() => true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      ensureRunning: vi.fn(async () => {}),
      retainContractTrades: vi.fn(async () => {}),
    };
    h.getBroadcaster.mockReturnValue(relay);
    return relay;
  }

  it("builds the broadcaster over the built engine's own deps", async () => {
    const relay = withRelay();
    await expect(handle.getConnectedState()).resolves.toBe(true);
    expect(h.getBroadcaster).toHaveBeenCalledWith(deps);
    expect(relay.getConnectedState).toHaveBeenCalledTimes(1);
  });

  it("answers null when the engine has no transport to relay from, and the rest do nothing", async () => {
    h.singleton.getEngine.mockResolvedValue(fakeEngine());
    h.getBroadcaster.mockReturnValue(null);
    await expect(handle.getConnectedState()).resolves.toBeNull();
    const off = await handle.subscribeEvents("k", () => {});
    expect(() => off()).not.toThrow();
    await expect(handle.ensureRunning([1], [])).resolves.toBeUndefined();
    await expect(handle.retainContractTrades([])).resolves.toBeUndefined();
  });

  it("subscribes the caller's own listener under its key, and the unsubscribe it returns releases that key", async () => {
    const relay = withRelay();
    const listener = vi.fn();
    const off = await handle.subscribeEvents("sse-1", listener);
    expect(relay.subscribe).toHaveBeenCalledWith("sse-1", listener);
    expect(relay.unsubscribe).not.toHaveBeenCalled();
    off();
    expect(relay.unsubscribe).toHaveBeenCalledWith("sse-1");
  });

  it("ensureRunning and retainContractTrades pass their arguments through and wait for the relay", async () => {
    const relay = withRelay();
    await handle.ensureRunning([42], ["c1"]);
    await handle.retainContractTrades(["c1"]);
    expect(relay.ensureRunning).toHaveBeenCalledWith([42], ["c1"]);
    expect(relay.retainContractTrades).toHaveBeenCalledWith(["c1"]);
  });

  it("emits on the broadcaster that was built, with one peek for a whole list", async () => {
    const built = { emitDeploymentsChanged: vi.fn(), emitStrategyTradeClosed: vi.fn() };
    h.peekBroadcaster.mockReturnValue(built);
    await handle.emitDeploymentsChanged();
    await handle.emitStrategyTradeClosedIfRunning([
      { accountId: 1, deploymentId: "a" },
      { accountId: 2, deploymentId: "b" },
    ]);
    expect(built.emitDeploymentsChanged).toHaveBeenCalledWith();
    expect(built.emitStrategyTradeClosed.mock.calls).toEqual([[1, "a"], [2, "b"]]);
    expect(h.peekBroadcaster).toHaveBeenCalledTimes(2);
  });
});

describe("localEngineHandle — the account view", () => {
  const slice = { items: [{ id: 5 }], asOf: 1_000, source: "route", readAt: 900 };

  it.each([
    { method: "readPositions" as const, through: () => h.accountView.readPositionsThrough, search: () => h.searchOpenPositions },
    { method: "readOrders" as const, through: () => h.accountView.readOrdersThrough, search: () => h.searchOpenOrders },
  ])("$method answers the view's slice as data, read through as the route", async ({ method, through, search }) => {
    through().mockResolvedValue(slice);
    await expect(handle[method](42)).resolves.toEqual({ kind: "slice", items: slice.items, asOf: 1_000, source: "route" });
    expect(through()).toHaveBeenCalledWith(42, expect.any(Function), "route");

    // The live read the view runs when it has nothing fresh: the install's
    // Topstep JWT on a fresh client, asked for this account.
    h.topstepBrowserToken.mockResolvedValue("jwt");
    search().mockResolvedValue([{ id: 6 }]);
    const live = through().mock.calls[0][1] as () => Promise<unknown>;
    await expect(live()).resolves.toEqual([{ id: 6 }]);
    expect(h.topstepClients[0].setToken).toHaveBeenCalledWith("jwt");
    expect(search()).toHaveBeenCalledWith(42);
  });

  it.each([
    { method: "readPositions" as const, through: () => h.accountView.readPositionsThrough },
    { method: "readOrders" as const, through: () => h.accountView.readOrdersThrough },
  ])("$method says Topstep is not configured when the live read finds no JWT", async ({ method, through }) => {
    h.topstepBrowserToken.mockResolvedValue(null);
    through().mockImplementation((_id: number, fetch: () => Promise<unknown>) => fetch());
    await expect(handle[method](42)).resolves.toEqual({ kind: "topstep-not-configured" });
    expect(h.topstepClients).toHaveLength(0);
  });

  it("rejects with any other failure of the read", async () => {
    const err = new Error("upstream 503");
    h.accountView.readPositionsThrough.mockRejectedValue(err);
    await expect(handle.readPositions(42)).rejects.toBe(err);
  });

  it("resolveDatedSymbols maps through the adapter, in order", async () => {
    const resolveDatedSymbol = vi.fn((id: string) => (id === "1" ? "MNQZ6" : id));
    h.singleton.getTradovateRealtimeAdapter.mockReturnValue({ resolveDatedSymbol });
    await expect(handle.resolveDatedSymbols(["1", "MESZ6"])).resolves.toEqual(["MNQZ6", "MESZ6"]);
  });
});

// ── No live object crosses the handle ──────────────────────────────────

type Primitive = string | number | boolean | null | undefined | void;
/** True when a value of `T` survives `JSON.stringify` → `JSON.parse` as itself. */
type JsonSafe<T> = T extends Primitive
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends Date | Map<unknown, unknown> | Set<unknown> | Promise<unknown> | RegExp
      ? false
      : T extends readonly (infer U)[]
        ? JsonSafe<U>
        : T extends object
          ? false extends { [K in keyof T]-?: JsonSafe<T[K]> }[keyof T]
            ? false
            : true
          : false;
/** The keys of `T` whose value is not JSON-safe. */
type NotJsonSafe<T> = { [K in keyof T]: [JsonSafe<T[K]>] extends [true] ? never : K }[keyof T];

/** The SSE listener and the unsubscribe are the one deliberate exception. */
type DataMethod = Exclude<Method, "subscribeEvents">;

describe("localEngineHandle — plain data only", () => {
  it("every result and every argument is JSON-safe, but the SSE listener", () => {
    // The methods whose result, or whose arguments, would not survive a JSON
    // round trip — named, so a failure says which.
    expectTypeOf<NotJsonSafe<{ [K in DataMethod]: Awaited<ReturnType<EngineHandle[K]>> }>>().toEqualTypeOf<never>();
    expectTypeOf<NotJsonSafe<{ [K in DataMethod]: Parameters<EngineHandle[K]> }>>().toEqualTypeOf<never>();
    expectTypeOf<NotJsonSafe<{ key: Parameters<EngineHandle["subscribeEvents"]>[0] }>>().toEqualTypeOf<never>();
  });

  it("the check refuses what it is there to refuse", () => {
    expectTypeOf<NotJsonSafe<{ client: { client: { search(): void } } }>>().toEqualTypeOf<"client">();
    expectTypeOf<NotJsonSafe<{ allowlist: ReadonlySet<number> }>>().toEqualTypeOf<"allowlist">();
    expectTypeOf<NotJsonSafe<{ either: { a: number } | (() => void) }>>().toEqualTypeOf<"either">();
    expectTypeOf<NotJsonSafe<{ map: { nested: ReadonlyMap<number, number> | null } }>>().toEqualTypeOf<"map">();
    expectTypeOf<NotJsonSafe<{ fine: { a: readonly number[]; b: string | null } }>>().toEqualTypeOf<never>();
  });
});

// ── Static imports ─────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, "../../../..");
const API = path.join(SRC, "app/api");
const LIB = path.join(SRC, "lib");
const ENGINE_DIR = path.join(LIB, "trading/engine");

/** Module specifiers a file imports at evaluation: `import`/`export … from`
 *  and bare `import "x"`, without type-only ones; `import()` is lazy. */
function staticSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    const named = /^\{([^}]*)\}$/.exec(m[3].trim());
    if (named && named[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[4]);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

function resolveSpecifier(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

const ENGINE_SINGLETON_FILE = path.join(ENGINE_DIR, "engine-singleton.ts");

describe("the handle loads the engine lazily", () => {
  it("the walker sees through type-only imports and follows value ones", () => {
    expect(staticSpecifiers('import type { A } from "x";\nimport { type B } from "y";\nimport { C } from "z";\nimport "w";')).toEqual(["z", "w"]);
    expect(staticGraph(path.join(API, "engine/route.ts")).has(path.join(ENGINE_DIR, "handle/local.ts"))).toBe(true);
    // A route that imports a broker client from it does reach it.
    expect(staticGraph(path.join(API, "accounts/route.ts")).has(ENGINE_SINGLETON_FILE)).toBe(true);
  });

  // The `all` and `engine` roles get this handle from the chooser, so this is
  // why no route there can meet `EngineUnreachableError`: only the remote
  // handle throws it, and the local one never loads it, statically or lazily.
  it("handle/local never reaches the remote handle", () => {
    const local = path.join(ENGINE_DIR, "handle/local.ts");
    expect(staticGraph(local).has(path.join(ENGINE_DIR, "handle/remote.ts"))).toBe(false);
    expect(readFileSync(local, "utf8")).not.toMatch(/(?:handle|\.)\/remote|EngineUnreachableError/);
  });

  it("handle/local imports no engine-singleton at evaluation", () => {
    expect(staticGraph(path.join(ENGINE_DIR, "handle/local.ts")).has(ENGINE_SINGLETON_FILE)).toBe(false);
  });

  // These three emit on the broadcaster and nothing else, so they keep the
  // engine graph out of their imports.
  it.each(["deployments/route.ts", "groups/route.ts", "dev/clear-trades/route.ts"])(
    "%s does not reach engine-singleton statically",
    (file) => {
      expect(staticGraph(path.join(API, file)).has(ENGINE_SINGLETON_FILE)).toBe(false);
    },
  );
});

// ── Who may reach the engine's modules ─────────────────────────────────

// The handle methods each file calls. Build or peek follows from MODE, so a
// route that switched a peek for a build would have to change this list.
// `handleFrom` is the factory the file takes its handle from: the role's
// chooser everywhere, but the engine process's own internal endpoint, which
// is the far end of the remote handle and must never call through it again.
type HandleFactory = "engineHandle" | "localEngineHandle";
const HANDLE_MODULE: Record<HandleFactory, string> = {
  engineHandle: "handle/select",
  localEngineHandle: "handle/local",
};

const ROUTES: {
  file: string;
  methods: Method[];
  brokerClientImports?: string[];
  handleName?: string;
  handleFrom?: HandleFactory;
}[] = [
  {
    file: "app/api/engine/route.ts",
    methods: [
      "getBootAssertionState", "getBootAssertionFailureReason", "isRunning", "start", "listTopstepAccounts",
      "getStagingAllowlist", "ensureEngine", "stop", "sync", "status", "reconnectMarketHub", "clearAllLogs",
      "getLogsByLevel",
    ],
  },
  { file: "app/api/accounts/status/route.ts", methods: ["checkAccountStatuses"] },
  {
    file: "app/api/deployments/check-orphans/route.ts",
    methods: ["refreshBrokerRegistry", "registeredAccountIds", "handleOrphanedAccount"],
  },
  { file: "app/api/auth/route.ts", methods: ["areHubsReady"] },
  { file: "app/api/settings/route.ts", methods: ["invalidateAccountNames", "reloadTradovateClients"] },
  { file: "app/api/settings/reset/route.ts", methods: ["emitDeploymentsChanged", "stopIfRunning", "invalidateAccountNames"] },
  { file: "app/api/settings/setup/route.ts", methods: ["activateFromSettings"] },
  {
    file: "app/api/deployments/[id]/route.ts",
    methods: ["nudgeClosingGuard", "emitDeploymentsChanged", "syncIfRunning", "peekLegPosition"],
  },
  { file: "app/api/deployments/[id]/flatten/route.ts", methods: ["forceFlatDeployment"] },
  { file: "app/api/deployments/[id]/clear-orphan/route.ts", methods: ["emitDeploymentsChanged", "syncIfRunning"] },
  { file: "app/api/deployments/[id]/analytics-context/route.ts", methods: ["engineSessionId"] },
  // The Tradovate client is a broker-plugin reach, not engine state; it
  // stays on the singleton module until the broker registry gets its seam.
  {
    file: "app/api/deployments/flatten-all/route.ts",
    methods: ["exitsInFlightForAccount"],
    brokerClientImports: ["getTradovateClientIfConfigured"],
    handleName: "engine",
  },
  { file: "app/api/deployments/manual-position-preflight/route.ts", methods: ["previewManualPositionClaim"] },
  { file: "app/api/deployments/move-account/route.ts", methods: ["syncIfRunning", "emitDeploymentsChanged"] },
  { file: "app/api/deployments/route.ts", methods: ["emitDeploymentsChanged"] },
  { file: "app/api/groups/route.ts", methods: ["emitDeploymentsChanged"] },
  {
    file: "app/api/groups/[id]/route.ts",
    methods: ["emitDeploymentsChanged", "syncIfRunning", "peekLegPosition", "nudgeClosingGuard"],
  },
  { file: "app/api/groups/[id]/add-legs/route.ts", methods: ["emitDeploymentsChanged", "syncIfRunning"] },
  {
    file: "app/api/groups/[id]/remove-leg/[legId]/route.ts",
    methods: ["peekLegPosition", "emitDeploymentsChanged", "syncIfRunning"],
  },
  { file: "app/api/dev/clear-trades/route.ts", methods: ["emitStrategyTradeClosedIfRunning"] },
  { file: "app/api/engine/stream/route.ts", methods: ["getConnectedState", "subscribeEvents", "ensureRunning"] },
  {
    file: "app/api/engine/subscriptions/route.ts",
    methods: ["getConnectedState", "ensureRunning", "retainContractTrades"],
  },
  {
    file: "app/api/positions/route.ts",
    methods: ["resolveDatedSymbols", "readPositions"],
    brokerClientImports: ["getTradovateClientIfConfigured"],
  },
  { file: "app/api/quotes/route.ts", methods: ["marketDataContractId"] },
  {
    file: "app/api/contracts/by-id/route.ts",
    methods: ["marketDataContractId"],
    brokerClientImports: ["getTradovateClientIfConfigured", "tradovateAuthError"],
  },
  { file: "app/api/trades/[id]/chart/route.ts", methods: ["marketDataContractId"] },
  // The engine process's internal endpoint: the call route dispatches every
  // listed method by name, so it names only the staging allowlist its screen
  // on a deployment list reads; the events stream is the relay.
  { file: "app/api/internal/engine/[method]/route.ts", methods: ["getStagingAllowlist"], handleFrom: "localEngineHandle" },
  {
    file: "app/api/internal/engine/events/route.ts",
    methods: ["getConnectedState", "subscribeEvents"],
    handleFrom: "localEngineHandle",
  },
  // Not a route: the reach every books route makes, through the reconciler.
  { file: "lib/trading/books/reconcile.ts", methods: ["syncIfRunning", "emitDeploymentsChanged", "nudgeClosingGuard"] },
];

// Files whose only reach is a broker client from the singleton module, or —
// for the deployments table — the staging allowlist it filters by. A live
// client cannot cross to another process, and the allowlist is to become a
// table; the remote half has to answer each of these some other way.
const DIRECT_REACH_ALLOWED: { file: string; brokerClientImports?: string[]; reaches?: RegExp }[] = [
  { file: "app/api/accounts/route.ts", brokerClientImports: ["getTradovateClientIfConfigured", "tradovateAuthError"] },
  { file: "app/api/backtest/route.ts", brokerClientImports: ["getTopstepClientIfConfigured"] },
  { file: "app/api/backtest/bars/route.ts", brokerClientImports: ["getTopstepClientIfConfigured"] },
  { file: "app/api/backtest/export/route.ts", brokerClientImports: ["getTopstepClientIfConfigured"] },
  { file: "app/api/contracts/route.ts", brokerClientImports: ["getTopstepClientIfConfigured"] },
  { file: "app/api/dev/contract-search/route.ts", brokerClientImports: ["getTopstepClientIfConfigured"] },
  { file: "app/api/trades/search/route.ts", brokerClientImports: ["getTradovateClientIfConfigured"] },
  { file: "lib/trading/broker-access/open-position-lookup.ts", brokerClientImports: ["getTradovateClientIfConfigured"] },
  { file: "lib/db/deployments.ts", reaches: /\/staging-allowlist$/ },
];

/** Any quoted path ending in one of the modules behind the handle. */
const DIRECT_REACH = /["'`]([^"'`\n]*\/(?:engine-singleton(?:\.ts)?|broadcaster-singleton|boot-assertion|staging-allowlist|account-view))["'`]/g;
const ENGINE_SINGLETON_PATH = /\/engine-singleton(?:\.ts)?$/;

function directReaches(src: string): string[] {
  return [...src.matchAll(DIRECT_REACH)].map((m) => m[1]);
}

/** No direct reach but the allowed one, and from the singleton module exactly these names. */
function expectOnlyAllowedReach(src: string, brokerClientImports?: string[], reaches?: RegExp): void {
  for (const spec of directReaches(src)) {
    const allowed = (brokerClientImports && ENGINE_SINGLETON_PATH.test(spec)) || (reaches?.test(spec) ?? false);
    expect(allowed, `direct reach of ${spec}`).toBe(true);
  }
  if (!brokerClientImports) return;
  const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*\/engine-singleton(?:\.ts)?)["']/g)];
  expect(imports).toHaveLength(1);
  const names = imports[0][1].split(",").map((n) => n.trim()).filter(Boolean);
  expect(names.sort()).toEqual([...brokerClientImports].sort());
  expect(directReaches(src).filter((s) => ENGINE_SINGLETON_PATH.test(s))).toHaveLength(1);
}

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === ENGINE_DIR ? [] : sourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function allSourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allSourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every module a file loads — static, lazy, bare, `require`, `export … from`
 *  — in any quote form. A `vi.mock` names a module without loading it. */
function importSpecifiers(src: string): string[] {
  const forms = [
    /\bfrom\s*(["'`])([^"'`\n]+)\1/g,
    /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1/g,
    /\bimport\s*(["'`])([^"'`\n]+)\1/g,
    /\brequire\s*\(\s*(["'`])([^"'`\n]+)\1/g,
  ];
  return forms.flatMap((form) => [...src.matchAll(form)].map((m) => m[2]));
}

/** An `export` statement that names the local handle's factory. */
function reExportsLocalHandle(src: string): boolean {
  return /^\s*export\b[^;]*\blocalEngineHandle\b(?!\s*\()/m.test(src);
}

function handleCalls(src: string, handleName: string): Method[] {
  return [...new Set([...src.matchAll(new RegExp(`\\b${handleName}\\.(\\w+)\\(`, "g"))].map((m) => m[1] as Method))];
}

describe("routes on the handle", () => {
  it.each(ROUTES)("$file reaches the engine only through the handle", ({ file, brokerClientImports, handleFrom = "engineHandle" }) => {
    const src = readFileSync(path.join(SRC, file), "utf8");
    expect(src).toMatch(new RegExp(`["']@/lib/trading/engine/${HANDLE_MODULE[handleFrom]}["']`));
    expectOnlyAllowedReach(src, brokerClientImports);
  });

  it.each(ROUTES)(
    "$file takes its handle from the role's chooser, the internal endpoint alone from the local one",
    ({ file, handleFrom = "engineHandle" }) => {
      const src = readFileSync(path.join(SRC, file), "utf8");
      const other: HandleFactory = handleFrom === "engineHandle" ? "localEngineHandle" : "engineHandle";
      expect(src).toMatch(new RegExp(`=\\s*${handleFrom}\\(\\);`));
      expect(src).not.toMatch(new RegExp(`\\b${other}\\b`));
    },
  );

  it("the internal endpoint's two routes are the only ones on the local handle", () => {
    expect(ROUTES.filter((r) => r.handleFrom === "localEngineHandle").map((r) => r.file).sort()).toEqual([
      "app/api/internal/engine/[method]/route.ts",
      "app/api/internal/engine/events/route.ts",
    ]);
  });

  it.each(ROUTES)("$file calls exactly its pinned handle methods", ({ file, methods, handleName = "handle" }) => {
    const src = readFileSync(path.join(SRC, file), "utf8");
    expect(handleCalls(src, handleName).sort()).toEqual([...methods].sort());
  });

  it.each(ROUTES)("$file never destructures the handle", ({ file }) => {
    const src = readFileSync(path.join(SRC, file), "utf8");
    expect(src).not.toMatch(/\{[^}]*\}\s*=\s*(?:handle|engine|engineHandle\(\)|localEngineHandle\(\))\s*[;\n]/);
  });

  it.each(DIRECT_REACH_ALLOWED)("$file reaches only what it is allowed to", ({ file, brokerClientImports, reaches }) => {
    expectOnlyAllowedReach(readFileSync(path.join(SRC, file), "utf8"), brokerClientImports, reaches);
  });

  it("every file under src/app/api and src/lib that names a module behind the handle, or the handle, is listed above", () => {
    const listed = new Set([...ROUTES, ...DIRECT_REACH_ALLOWED].map(({ file }) => path.join(SRC, file)));
    const reaching = [...sourceFilesUnder(API), ...sourceFilesUnder(LIB)].filter((full) => {
      const src = readFileSync(full, "utf8");
      return directReaches(src).length > 0 || /engine\/handle\/(?:local|select)["']/.test(src);
    });
    expect(reaching.filter((full) => !listed.has(full)).map((full) => path.relative(SRC, full))).toEqual([]);
  });

  // The scans above skip trading/engine/ and read only the files they list; this
  // one reads every file under src, tests included, so a satellite or a helper
  // that hands the local handle on cannot carry a web process past the chooser.
  it("only the chooser, the internal endpoint's two routes and this test import handle/local, and nothing re-exports it", () => {
    const local = path.join(ENGINE_DIR, "handle/local.ts");
    const allowed = [
      path.join(ENGINE_DIR, "handle/select.ts"),
      path.join(API, "internal/engine/[method]/route.ts"),
      path.join(API, "internal/engine/events/route.ts"),
      path.join(ENGINE_DIR, "handle/local.test.ts"),
    ];
    const files = allSourceFilesUnder(SRC);
    const importers = files.filter((full) => importSpecifiers(readFileSync(full, "utf8")).some((spec) => resolveSpecifier(full, spec) === local));
    expect(importers.sort()).toEqual([...allowed].sort());
    const reExporters = files.filter((full) => full !== local && reExportsLocalHandle(readFileSync(full, "utf8")));
    expect(reExporters.map((full) => path.relative(SRC, full))).toEqual([]);
  });

  it("the importer and re-export patterns see every quote form, lazy imports and re-exports", () => {
    expect(importSpecifiers('import { a } from "./local";')).toEqual(["./local"]);
    expect(importSpecifiers("import { a } from '@/lib/trading/engine/handle/local';")).toEqual(["@/lib/trading/engine/handle/local"]);
    expect(importSpecifiers("const m = await import(`@/lib/trading/engine/handle/local`);")).toEqual(["@/lib/trading/engine/handle/local"]);
    expect(importSpecifiers('export * from "../handle/local.ts";')).toEqual(["../handle/local.ts"]);
    expect(importSpecifiers('const m = require("./local");')).toEqual(["./local"]);
    expect(importSpecifiers('vi.mock("@/lib/trading/engine/handle/local", () => ({}));')).toEqual([]);
    expect(resolveSpecifier(path.join(ENGINE_DIR, "handle/x.ts"), "./local.ts")).toBe(path.join(ENGINE_DIR, "handle/local.ts"));
    expect(reExportsLocalHandle("export { localEngineHandle } from './local';")).toBe(true);
    expect(reExportsLocalHandle("export { localEngineHandle as h };")).toBe(true);
    expect(reExportsLocalHandle("export const h = localEngineHandle;")).toBe(true);
    expect(reExportsLocalHandle("const handle = localEngineHandle();")).toBe(false);
  });

  it("the direct-reach pattern matches any quote and the bare module path", () => {
    expect(directReaches(`import x from '../engine/engine-singleton';`)).toEqual(["../engine/engine-singleton"]);
    expect(directReaches("await import(`@/lib/realtime/broadcaster-singleton`)")).toEqual(["@/lib/realtime/broadcaster-singleton"]);
    expect(directReaches(`from "./realtime/account-view.ts"`)).toEqual([]);
    expect(directReaches(`from "./engine-singleton.ts"`)).toEqual(["./engine-singleton.ts"]);
  });
});

// ── The log sinks ──────────────────────────────────────────────────────

// The pipe keeps its sinks per module graph. A route graph that has not
// loaded engine-singleton yet gets the ring, store and escalation sinks only
// through this module, so a handle route's own lines reach /logs and Discord.
const LOG_SINKS_FILE = path.join(ENGINE_DIR, "engine-log-sinks.ts");

describe("the handle installs the log sinks", () => {
  it("the sink module reaches all three sinks and no engine", () => {
    const graph = staticGraph(LOG_SINKS_FILE);
    expect(graph.has(path.join(LIB, "db/engine-logs.ts"))).toBe(true);
    expect(graph.has(path.join(LIB, "notify/log-escalation.ts"))).toBe(true);
    expect(graph.has(ENGINE_SINGLETON_FILE)).toBe(false);
    expect(graph.has(path.join(ENGINE_DIR, "engine.ts"))).toBe(false);
  });

  it("engine-singleton reaches it, so the boot graph keeps its sinks", () => {
    expect(staticGraph(ENGINE_SINGLETON_FILE).has(LOG_SINKS_FILE)).toBe(true);
  });

  it.each(ROUTES.map(({ file }) => file))("%s reaches the sink module statically", (file) => {
    expect(staticGraph(path.join(SRC, file)).has(LOG_SINKS_FILE)).toBe(true);
  });

  it.each(["books/[id]/route.ts", "books/[id]/playbooks/route.ts", "books/[id]/move/route.ts"])(
    "%s reaches the sink module statically, through the reconciler",
    (file) => {
      expect(staticGraph(path.join(API, file)).has(LOG_SINKS_FILE)).toBe(true);
    },
  );
});
