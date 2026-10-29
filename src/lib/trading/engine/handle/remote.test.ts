/**
 * The remote handle against a fake engine process: a real `http` server on a
 * loopback port speaking the internal endpoint's wire, so what is pinned is
 * the bytes a web process sends and what it makes of the answer. Backoff is
 * injected as zero, so no test waits on a real delay.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastEvent } from "@/lib/realtime/event-broadcaster";
import { formatSseEvent } from "@/lib/realtime/sse";
import type { EngineHandle } from "./index";
import {
  EngineRemoteError,
  EngineUnreachableError,
  defaultReconnectDelayMs,
  ENGINE_CALL_TIMEOUT_MS,
  remoteEngineHandle,
  UPSTREAM_IDLE_MS,
  type EngineCallMethod,
  type StreamClock,
} from "./remote";

const SECRET = "internal-secret-under-test";
const PATH = "/api/internal/engine/";

interface Received {
  method: string;
  authorization: string | undefined;
  body: unknown;
}

type Responder = (method: string, body: unknown, res: http.ServerResponse) => void;

/** A fake engine process: records each call, answers through `respond`, and
 *  holds every events request open until the test writes to or ends it. */
class FakeEngine {
  readonly calls: Received[] = [];
  readonly streams: http.ServerResponse[] = [];
  readonly streamAuth: Array<string | undefined> = [];
  closedStreams = 0;
  respond: Responder = (method, _body, res) => json(res, 200, { ok: true, result: { from: method } });
  eventsAnswer: ((res: http.ServerResponse) => boolean) | null = null;
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  url = "";

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  send(index: number, event: BroadcastEvent): void {
    this.streams[index].write(formatSseEvent(event));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = (req.url ?? "").slice(PATH.length);
    if (req.method === "GET" && method === "events") {
      if (this.eventsAnswer?.(res)) return;
      this.streamAuth.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      res.write(": opened\n\n");
      res.write(formatSseEvent({ kind: "status", connected: true }));
      res.on("close", () => (this.closedStreams += 1));
      this.streams.push(res);
      return;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const body: unknown = JSON.parse(raw);
      this.calls.push({ method, authorization: req.headers.authorization, body });
      this.respond(method, body, res);
    });
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let engine: FakeEngine;

beforeEach(async () => {
  engine = new FakeEngine();
  await engine.listen();
});

afterEach(async () => {
  await engine.close();
});

function remote(options: Parameters<typeof remoteEngineHandle>[2] = {}): EngineHandle {
  return remoteEngineHandle(`${engine.url}/`, SECRET, { reconnectDelayMs: () => 0, ...options });
}

const DEPLOYMENTS = [{ id: "d1" }];
const CLAIM = { accountId: 42, ticker: "/MNQ", strategyKey: "orb", paramValues: {} };

/** The local handle test's arguments, method for method. */
const ARGS: Record<EngineCallMethod, unknown[]> = {
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
  ensureRunning: [[42], ["CON.F.US.MNQ.Z26"]],
  retainContractTrades: [["CON.F.US.MNQ.Z26"]],
  readPositions: [42],
  readOrders: [42],
  resolveDatedSymbols: [["4799969"]],
};

const METHODS = Object.keys(ARGS) as EngineCallMethod[];

function call(handle: EngineHandle, method: EngineCallMethod): Promise<unknown> {
  return (handle[method] as (...a: unknown[]) => Promise<unknown>)(...ARGS[method]);
}

describe("remoteEngineHandle — calls", () => {
  it("covers every handle method", () => {
    expect(Object.keys(remote()).sort()).toEqual([...METHODS, "subscribeEvents"].sort());
  });

  it.each(METHODS)("%s posts its arguments to its own path with the secret and answers the result", async (method) => {
    const handle = remote();
    await expect(call(handle, method)).resolves.toEqual({ from: method });
    expect(engine.calls).toEqual([{ method, authorization: `Bearer ${SECRET}`, body: { args: ARGS[method] } }]);
  });

  it("answers null as null and an absent result as undefined", async () => {
    engine.respond = (method, _body, res) =>
      json(res, 200, method === "peekLegPosition" ? { ok: true, result: null } : { ok: true });
    const handle = remote();
    await expect(handle.peekLegPosition("d3")).resolves.toBeNull();
    await expect(handle.start([])).resolves.toBeUndefined();
  });

  it("rethrows an error the engine returned with its name, message and status — not as unreachable", async () => {
    engine.respond = (_method, _body, res) =>
      json(res, 503, { ok: false, error: { name: "EngineNotInThisProcessError", message: "getEngine(): no lease" } });
    const err = await remote().start([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRemoteError);
    expect(err).not.toBeInstanceOf(EngineUnreachableError);
    expect(err).toMatchObject({ name: "EngineNotInThisProcessError", message: "getEngine(): no lease", status: 503 });
  });

  it("is unreachable on a refused connection", async () => {
    const url = engine.url;
    await engine.close();
    const handle = remoteEngineHandle(url, SECRET);
    await expect(handle.isRunning()).rejects.toBeInstanceOf(EngineUnreachableError);
    // Reopened so afterEach has a server to close.
    engine = new FakeEngine();
    await engine.listen();
  });

  it("is unreachable when no answer comes within the call's bound", async () => {
    engine.respond = () => {};
    const err = await remote({ callTimeoutMs: 50 }).isRunning().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnreachableError);
    expect((err as Error).message).toContain("no answer within 50 ms");
  });

  it.each([
    ["an HTML page", (res: http.ServerResponse) => res.writeHead(404, { "content-type": "text/html" }).end("<html>")],
    ["JSON that is not an answer", (res: http.ServerResponse) => json(res, 200, { running: true })],
  ])("is unreachable on %s", async (_label, answer) => {
    engine.respond = (_method, _body, res) => answer(res);
    await expect(remote().isRunning()).rejects.toBeInstanceOf(EngineUnreachableError);
  });

  it("bounds a call at ten seconds by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await remote().isRunning();
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
  });

  it.each(["forceFlatDeployment", "start"] as const)(
    "bounds %s at sixty seconds, since its work is broker round-trips in series",
    async (method) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      await call(remote(), method);
      expect(timeout).toHaveBeenCalledWith(60_000);
      timeout.mockRestore();
    },
  );
});

describe("remoteEngineHandle — the event stream", () => {
  it("fans one upstream out to every listener, each under its own key", async () => {
    const handle = remote();
    const a: BroadcastEvent[] = [];
    const b: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => a.push(e));
    await handle.subscribeEvents("b", (e) => b.push(e));
    expect(engine.streams).toHaveLength(1);
    expect(engine.streamAuth).toEqual([`Bearer ${SECRET}`]);

    engine.send(0, { kind: "deploymentsChanged" });
    await vi.waitFor(() => expect(b).toContainEqual({ kind: "deploymentsChanged" }));
    expect(a).toEqual(b);
    expect(a).toEqual([{ kind: "status", connected: true }, { kind: "deploymentsChanged" }]);
  });

  it("stops delivering to a listener that unsubscribed, and closes the upstream with the last", async () => {
    const handle = remote();
    const a: BroadcastEvent[] = [];
    const b: BroadcastEvent[] = [];
    const offA = await handle.subscribeEvents("a", (e) => a.push(e));
    const offB = await handle.subscribeEvents("b", (e) => b.push(e));
    offA();
    engine.send(0, { kind: "setupsChanged" });
    await vi.waitFor(() => expect(b).toContainEqual({ kind: "setupsChanged" }));
    expect(a).not.toContainEqual({ kind: "setupsChanged" });

    offB();
    await vi.waitFor(() => expect(engine.closedStreams).toBe(1));
  });

  it("says connected: false when the upstream drops, reconnects, and delivers from the new one", async () => {
    const delays: number[] = [];
    const handle = remote({
      reconnectDelayMs: (attempt) => {
        delays.push(attempt);
        return 0;
      },
    });
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));

    engine.streams[0].end();
    await vi.waitFor(() => expect(engine.streams).toHaveLength(2));
    engine.send(1, { kind: "deploymentsChanged" });
    await vi.waitFor(() => expect(seen).toHaveLength(6));

    expect(seen.map((e) => (e.kind === "status" ? `status ${e.connected}` : e.kind))).toEqual([
      "status true",
      "status false",
      "status true",
      // The refetch for whatever the gap swallowed.
      "deploymentsChanged",
      "setupsChanged",
      "deploymentsChanged",
    ]);
    expect(delays).toEqual([0]);
  });

  it("refreshes nothing on the first open", async () => {
    const handle = remote();
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));
    engine.send(0, { kind: "strategyTrade", accountId: 42, deploymentId: "d1" });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((e) => e.kind)).toEqual(["status", "strategyTrade"]);
  });

  it("replays every account and contract this process asked for to the new engine before anyone hears it is back", async () => {
    const handle = remote();
    const seen: string[] = [];
    await handle.subscribeEvents("a", (e) => {
      // What the engine had heard at the moment each frame reached a listener.
      seen.push(`${e.kind === "status" ? `status ${e.connected}` : e.kind} after ${engine.calls.length} calls`);
    });
    await handle.ensureRunning([42], ["CON.F.US.MNQ.Z26"]);
    await handle.ensureRunning([42, 43], []);
    await handle.retainContractTrades(["CON.F.US.MES.Z26"]);
    engine.calls.length = 0;

    engine.streams[0].end();
    await vi.waitFor(() => expect(seen).toContain("setupsChanged after 2 calls"));

    expect(engine.calls.map((c) => [c.method, c.body])).toEqual([
      ["ensureRunning", { args: [[42, 43], ["CON.F.US.MNQ.Z26"]] }],
      ["retainContractTrades", { args: [["CON.F.US.MES.Z26"]] }],
    ]);
    expect(seen).toEqual([
      "status true after 0 calls",
      "status false after 0 calls",
      "status true after 2 calls",
      "deploymentsChanged after 2 calls",
      "setupsChanged after 2 calls",
    ]);
  });

  it("treats a replay the new engine refuses as a failed reconnect, and tries again", async () => {
    const handle = remote();
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));
    await handle.ensureRunning([42], []);
    let refusals = 1;
    engine.respond = (method, _body, res) => {
      if (refusals > 0) {
        refusals -= 1;
        json(res, 503, { ok: false, error: { name: "EngineNotInThisProcessError", message: "no lease" } });
        return;
      }
      json(res, 200, { ok: true, result: { from: method } });
    };

    engine.streams[0].end();
    await vi.waitFor(() => expect(engine.streams).toHaveLength(3));
    await vi.waitFor(() => expect(seen.filter((e) => e.kind === "status" && e.connected)).toHaveLength(2));
    expect(seen.filter((e) => e.kind === "status" && !e.connected)).toHaveLength(1);
  });

  it("drops and reconnects a stream that goes silent past two and a half heartbeats", async () => {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const clock: StreamClock = {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { live: boolean }).live = false;
      },
    };
    const handle = remote({ clock });
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const live = timers.filter((t) => t.live);
    expect(live).toHaveLength(1);
    expect(live[0].ms).toBe(UPSTREAM_IDLE_MS);
    expect(UPSTREAM_IDLE_MS).toBe(62_500);
    live[0].fn();

    await vi.waitFor(() => expect(engine.streams).toHaveLength(2));
    expect(seen[1]).toEqual({
      kind: "status",
      connected: false,
      reason: "engine event stream stalled: no bytes in 62500 ms",
    });
    await vi.waitFor(() => expect(engine.closedStreams).toBe(1));
  });

  it("re-arms the watchdog on every byte, so a heartbeat keeps the stream", async () => {
    const timers: Array<{ live: boolean }> = [];
    const clock: StreamClock = {
      setTimeout: () => {
        const timer = { live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { live: boolean }).live = false;
      },
    };
    const handle = remote({ clock });
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const before = timers.length;
    engine.streams[0].write(": heartbeat\n\n");
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(before));
    expect(timers.filter((t) => t.live)).toHaveLength(1);
  });

  it("keeps trying while the engine is down, says so once, and resets the backoff once back", async () => {
    const delays: number[] = [];
    const handle = remote({
      reconnectDelayMs: (attempt) => {
        delays.push(attempt);
        return 0;
      },
    });
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => seen.push(e));
    let refusals = 2;
    engine.eventsAnswer = (res) => {
      if (refusals === 0) return false;
      refusals -= 1;
      json(res, 503, { ok: false, error: { name: "RealtimeFeedDisabled", message: "down" } });
      return true;
    };

    engine.streams[0].end();
    await vi.waitFor(() => expect(engine.streams).toHaveLength(2));
    expect(delays).toEqual([0, 1, 2]);
    expect(seen.filter((e) => e.kind === "status" && !e.connected)).toHaveLength(1);

    engine.streams[1].end();
    await vi.waitFor(() => expect(engine.streams).toHaveLength(3));
    expect(delays).toEqual([0, 1, 2, 0]);
  });

  it("tells a listener that joins while the upstream is down", async () => {
    const handle = remote({ reconnectDelayMs: () => 60_000 });
    const first: BroadcastEvent[] = [];
    await handle.subscribeEvents("a", (e) => first.push(e));
    engine.streams[0].end();
    // Down, with the retry parked on the long delay.
    await vi.waitFor(() => expect(first).toContainEqual(expect.objectContaining({ kind: "status", connected: false })));
    const late: BroadcastEvent[] = [];
    const off = await handle.subscribeEvents("late", (e) => late.push(e));
    expect(late).toEqual([{ kind: "status", connected: false, reason: "engine event stream reconnecting" }]);
    off();
  });

  it("rejects the first subscribe with the engine's own refusal, and holds no listener", async () => {
    engine.eventsAnswer = (res) => {
      json(res, 401, { ok: false, error: { name: "EngineEndpointUnauthorized", message: "wrong secret" } });
      return true;
    };
    const handle = remote();
    const err = await handle.subscribeEvents("a", () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "EngineEndpointUnauthorized", status: 401 });

    // A later subscribe opens a fresh upstream rather than inheriting the failure.
    engine.eventsAnswer = null;
    await handle.subscribeEvents("b", () => {});
    expect(engine.streams).toHaveLength(1);
  });

  it("rejects the first subscribe as unreachable when the engine refuses the connection", async () => {
    const url = engine.url;
    await engine.close();
    const handle = remoteEngineHandle(url, SECRET);
    await expect(handle.subscribeEvents("a", () => {})).rejects.toBeInstanceOf(EngineUnreachableError);
    engine = new FakeEngine();
    await engine.listen();
  });

  it("gives up on a connect whose headers never arrive, at the call bound", async () => {
    // The request is held open and never answered.
    engine.eventsAnswer = () => true;
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const clock: StreamClock = {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { live: boolean }).live = false;
      },
    };
    const handle = remote({ clock });
    const subscribed = handle.subscribeEvents("a", () => {}).catch((e: unknown) => e);
    await vi.waitFor(() => expect(timers.filter((t) => t.live)).toHaveLength(1));
    const [connectTimer] = timers.filter((t) => t.live);
    expect(connectTimer.ms).toBe(ENGINE_CALL_TIMEOUT_MS.status);

    connectTimer.fn();

    const err = await subscribed;
    expect(err).toBeInstanceOf(EngineUnreachableError);
    expect((err as Error).message).toMatch(/no answer within 10000 ms/);
  });

  it("clears the connect bound once the headers arrive, leaving only the idle watchdog", async () => {
    const timers: Array<{ ms: number; live: boolean }> = [];
    const clock: StreamClock = {
      setTimeout: (_fn, ms) => {
        const timer = { ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { live: boolean }).live = false;
      },
    };
    const handle = remote({ clock });
    await handle.subscribeEvents("a", () => {});

    expect(timers.filter((t) => t.live).map((t) => t.ms)).toEqual([UPSTREAM_IDLE_MS]);
  });

  it("one listener that throws costs the others nothing", async () => {
    const handle = remote();
    const seen: BroadcastEvent[] = [];
    await handle.subscribeEvents("bad", () => {
      throw new Error("listener bug");
    });
    await handle.subscribeEvents("good", (e) => seen.push(e));
    engine.send(0, { kind: "setupsChanged" });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: "setupsChanged" }));
  });
});

describe("the reconnect backoff", () => {
  it("doubles from one second and caps at thirty", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(defaultReconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});
