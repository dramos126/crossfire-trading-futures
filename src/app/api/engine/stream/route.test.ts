/**
 * `/api/engine/stream` on SIGTERM: the open SSE responses are what held every
 * deploy's stop to the full `docker stop` grace, so the shutdown ends them —
 * after the clean-shutdown marker, and without the engine doing anything.
 *
 * The shutdown path is the real one: `connection.ts` on an in-memory database
 * and the real `installCleanShutdownMarker`, so the order asserted is the order
 * the process runs, not a restatement of it. The route itself reaches no
 * database. The signal handler is invoked directly rather than by
 * `process.emit`, which would also reach vitest's own SIGTERM listener.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const order: string[] = [];
  /** Every engine method the route or the shutdown calls, by name. */
  const engineCalls: string[] = [];
  const engine = new Proxy(
    {},
    {
      // `then` stays undefined: `await getEngine()` would otherwise treat the
      // engine as a thenable and never settle.
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : (...args: unknown[]) => {
              engineCalls.push(String(prop));
              return prop === "broadcasterDeps" ? {} : args;
            },
    },
  );
  const broadcaster = {
    getConnectedState: vi.fn(() => true),
    subscribe: vi.fn(),
    unsubscribe: vi.fn((key: string) => {
      order.push(`stream ended ${key}`);
    }),
    ensureRunning: vi.fn(async () => {}),
  };
  return { order, engineCalls, engine, broadcaster };
});

vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(() => null) }));
vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngine: vi.fn(async () => h.engine),
}));
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  getBroadcaster: vi.fn(() => h.broadcaster),
}));
// `engine-restart` reaches the strategy loader, whose `require.context` has no
// vitest equivalent (patterns.md).
vi.mock("@/lib/trading/strategies", () => ({ getStrategy: vi.fn() }));
vi.mock("@/lib/db/engine-restart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/engine-restart")>();
  return {
    ...actual,
    markCleanShutdown: vi.fn((atMs: number) => {
      h.order.push("marker");
      actual.markCleanShutdown(atMs);
    }),
  };
});

const SHUTDOWN_GLOBAL_KEY = "__crossfireDbShutdown";
const OPEN_STREAMS_KEY = "__crossfireOpenSseStreams";
const originalPath = process.env.TRADING_DB_PATH;

/** The SIGTERM handler `connection.ts` registered, captured instead of bound. */
let sigterm: (() => void) | null = null;

beforeEach(() => {
  vi.resetModules();
  h.order.length = 0;
  h.engineCalls.length = 0;
  h.broadcaster.subscribe.mockClear();
  h.broadcaster.unsubscribe.mockClear();
  h.broadcaster.ensureRunning.mockClear();
  sigterm = null;
  delete (globalThis as Record<string, unknown>)[SHUTDOWN_GLOBAL_KEY];
  delete (globalThis as Record<string, unknown>)[OPEN_STREAMS_KEY];
  process.env.TRADING_DB_PATH = ":memory:";
  const record = ((event: string, fn: () => void) => {
    if (event === "SIGTERM") sigterm = fn;
    return process;
  }) as typeof process.prependOnceListener;
  vi.spyOn(process, "prependOnceListener").mockImplementation(record);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.TRADING_DB_PATH;
  else process.env.TRADING_DB_PATH = originalPath;
});

function streamRequest(): NextRequest {
  return new NextRequest("http://localhost/api/engine/stream", {
    method: "POST",
    body: JSON.stringify({ accountIds: [], contractIds: [] }),
  });
}

/** Read a response body to its end; resolves only once the server ended it. */
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

/** The shutdown as a booted process has it: the database open, the engine
 *  lease held (the marker hook writes nothing without it), the route loaded,
 *  and — through `installMarker` — the marker hook. */
async function bootedProcess() {
  const { getDb } = await import("@/lib/db/connection");
  const { leaseHolderId, tryAcquireLease } = await import("@/lib/db/lease");
  const { installCleanShutdownMarker } = await import(
    "@/lib/trading/engine/boot/engine-restart"
  );
  getDb();
  tryAcquireLease(leaseHolderId(), Date.now());
  const { POST } = await import("./route");
  return { POST, installMarker: installCleanShutdownMarker };
}

describe("SIGTERM ends every open stream, after the marker, and the engine does nothing", () => {
  it("writes the marker, then ends every tracked stream, with no engine call", async () => {
    const { POST, installMarker } = await bootedProcess();
    const first = await POST(streamRequest());
    const second = await POST(streamRequest());
    // Both streams are open: the start body has run past its awaits.
    await vi.waitFor(() => expect(h.broadcaster.ensureRunning).toHaveBeenCalledTimes(2));
    expect(h.broadcaster.subscribe).toHaveBeenCalledTimes(2);
    // Installed after the streams registered their shutdown step, so the
    // marker coming first is the phase's doing, not registration order.
    installMarker();
    const callsBeforeStop = [...h.engineCalls];

    sigterm!();

    expect(h.order[0]).toBe("marker");
    expect(h.order.slice(1).sort()).toEqual(
      h.broadcaster.subscribe.mock.calls.map((c) => `stream ended ${String(c[0])}`).sort(),
    );
    // Both bodies end — the server closed them, the client did not.
    await expect(drain(first)).resolves.toContain(": connected");
    await expect(drain(second)).resolves.toContain(": connected");
    // The route's only engine reach is the relay lookup at connect — once per
    // handle call, each of which builds; the stop places no order, reads no
    // position, stops nothing.
    expect(callsBeforeStop.length).toBeGreaterThan(0);
    expect(new Set(callsBeforeStop)).toEqual(new Set(["broadcasterDeps"]));
    expect(h.engineCalls).toEqual(callsBeforeStop);
  });

  it("asks the socket to close with the stream, so server.close() is not held by it", async () => {
    const { POST } = await bootedProcess();
    const res = await POST(streamRequest());

    expect(res.headers.get("connection")).toBe("close");
    sigterm!();
  });

  it("forgets a stream the client closed, so the stop does not end it twice", async () => {
    const { POST, installMarker } = await bootedProcess();
    installMarker();
    const controller = new AbortController();
    const req = new NextRequest("http://localhost/api/engine/stream", {
      method: "POST",
      body: JSON.stringify({ accountIds: [], contractIds: [] }),
      signal: controller.signal,
    });
    await POST(req);
    await vi.waitFor(() => expect(h.broadcaster.ensureRunning).toHaveBeenCalled());
    controller.abort();
    expect(h.broadcaster.unsubscribe).toHaveBeenCalledTimes(1);

    sigterm!();

    expect(h.broadcaster.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["stream ended " + String(h.broadcaster.subscribe.mock.calls[0][0]), "marker"]);
  });

  it("releases the listener of a client that left while its subscribe was in flight", async () => {
    const { POST } = await bootedProcess();
    const { getEngine } = await import("@/lib/trading/engine/engine-singleton");
    let releaseEngine!: () => void;
    vi.mocked(getEngine).mockClear();
    vi.mocked(getEngine)
      .mockImplementationOnce(async () => h.engine as never)
      .mockImplementationOnce(() => new Promise((resolve) => (releaseEngine = () => resolve(h.engine as never))));
    const controller = new AbortController();
    const req = new NextRequest("http://localhost/api/engine/stream", {
      method: "POST",
      body: JSON.stringify({ accountIds: [], contractIds: [] }),
      signal: controller.signal,
    });
    await POST(req);
    await vi.waitFor(() => expect(getEngine).toHaveBeenCalledTimes(2));

    controller.abort();
    releaseEngine();

    await vi.waitFor(() => expect(h.broadcaster.unsubscribe).toHaveBeenCalledTimes(1));
    expect(h.broadcaster.subscribe).toHaveBeenCalledTimes(1);
    expect(h.broadcaster.ensureRunning).not.toHaveBeenCalled();
  });

  it("cleans up a client that left while the user hub was still coming up", async () => {
    const { POST } = await bootedProcess();
    let releaseHub!: () => void;
    h.broadcaster.ensureRunning.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseHub = resolve)),
    );
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const controller = new AbortController();
    const req = new NextRequest("http://localhost/api/engine/stream", {
      method: "POST",
      body: JSON.stringify({ accountIds: [], contractIds: [] }),
      signal: controller.signal,
    });
    await POST(req);
    await vi.waitFor(() => expect(h.broadcaster.ensureRunning).toHaveBeenCalled());

    controller.abort();
    releaseHub();
    await Promise.resolve();

    expect(h.broadcaster.unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalled();
    const streams = (globalThis as unknown as Record<string, { ends: Set<unknown> } | undefined>)[
      OPEN_STREAMS_KEY
    ];
    expect(streams?.ends.size).toBe(0);
  });
});

describe("a stream that cannot go on releases what it armed", () => {
  function openStreamCount(): number | undefined {
    return (globalThis as unknown as Record<string, { ends: Set<unknown> } | undefined>)[OPEN_STREAMS_KEY]?.ends
      .size;
  }

  // A settings reset that cleared the credentials, or a failed token refresh,
  // rejects the subscribe after the heartbeat is armed.
  it("says it is disconnected, with the reason, and ends when the subscribe rejects", async () => {
    const { POST } = await bootedProcess();
    const { getEngine } = await import("@/lib/trading/engine/engine-singleton");
    vi.mocked(getEngine).mockClear();
    vi.mocked(getEngine)
      .mockImplementationOnce(async () => h.engine as never)
      .mockImplementationOnce(async () => {
        throw new Error("Topstep credentials missing");
      });
    const clearInterval = vi.spyOn(globalThis, "clearInterval");

    const body = await drain(await POST(streamRequest()));

    expect(body).toContain('"kind":"status","connected":false,"reason":"Topstep credentials missing"');
    expect(clearInterval).toHaveBeenCalled();
    expect(h.broadcaster.subscribe).not.toHaveBeenCalled();
    expect(h.broadcaster.ensureRunning).not.toHaveBeenCalled();
    expect(openStreamCount()).toBe(0);
  });

  it("releases the heartbeat and the listener on abort after an enqueue already failed", async () => {
    const { POST } = await bootedProcess();
    const controller = new AbortController();
    const req = new NextRequest("http://localhost/api/engine/stream", {
      method: "POST",
      body: JSON.stringify({ accountIds: [], contractIds: [] }),
      signal: controller.signal,
    });
    const res = await POST(req);
    await vi.waitFor(() => expect(h.broadcaster.ensureRunning).toHaveBeenCalled());
    // The reader goes away; the next frame's enqueue throws and marks the
    // stream closed before any cleanup has run.
    await res.body!.cancel();
    const listener = h.broadcaster.subscribe.mock.calls[0][1] as (e: { kind: string }) => void;
    listener({ kind: "deploymentsChanged" });
    const clearInterval = vi.spyOn(globalThis, "clearInterval");

    controller.abort();

    expect(clearInterval).toHaveBeenCalled();
    expect(h.broadcaster.unsubscribe).toHaveBeenCalledTimes(1);
    expect(openStreamCount()).toBe(0);
  });
});
