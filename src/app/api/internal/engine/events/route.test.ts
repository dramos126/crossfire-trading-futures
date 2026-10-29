/**
 * `GET /api/internal/engine/events`: the engine process's one event stream
 * for a web process — the gate, the frames, and the SIGTERM shutdown set
 * ending it. The after-close hook is captured and invoked as `connection.ts`
 * would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { BroadcastEvent } from "@/lib/realtime/event-broadcaster";

const h = vi.hoisted(() => ({
  afterClose: [] as Array<(signal: string) => void>,
  listeners: new Map<string, (event: BroadcastEvent) => void>(),
  unsubscribed: [] as string[],
  handle: {
    getConnectedState: vi.fn(async (): Promise<boolean | null> => true),
    subscribeEvents: vi.fn(),
    ensureRunning: vi.fn(),
  },
}));

vi.mock("@/lib/trading/engine/handle/local", () => ({ localEngineHandle: () => h.handle }));
vi.mock("@/lib/db/connection", () => ({
  getDb: () => {
    throw new Error("no database in a route test");
  },
  registerAfterCloseHook: (fn: (signal: string) => void) => {
    h.afterClose.push(fn);
  },
}));

import { GET } from "./route";
import { parseSseEvents } from "@/lib/realtime/sse";

const SECRET = "internal-secret-under-test-32-chars-plus";
const OPEN_STREAMS_KEY = "__crossfireOpenSseStreams";
const env = { role: process.env.CROSSFIRE_ROLE, secret: process.env.CROSSFIRE_INTERNAL_SECRET };

beforeEach(() => {
  vi.clearAllMocks();
  h.afterClose.length = 0;
  h.listeners.clear();
  h.unsubscribed.length = 0;
  delete (globalThis as Record<string, unknown>)[OPEN_STREAMS_KEY];
  process.env.CROSSFIRE_ROLE = "engine";
  process.env.CROSSFIRE_INTERNAL_SECRET = SECRET;
  h.handle.getConnectedState.mockResolvedValue(true);
  h.handle.subscribeEvents.mockImplementation(async (key: string, listener: (e: BroadcastEvent) => void) => {
    h.listeners.set(key, listener);
    return () => {
      h.listeners.delete(key);
      h.unsubscribed.push(key);
    };
  });
});

afterEach(() => {
  for (const [key, value] of [
    ["CROSSFIRE_ROLE", env.role],
    ["CROSSFIRE_INTERNAL_SECRET", env.secret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(auth: string | null = `Bearer ${SECRET}`, signal?: AbortSignal): NextRequest {
  return new NextRequest("http://engine:3000/api/internal/engine/events", {
    headers: auth === null ? {} : { authorization: auth },
    signal,
  });
}

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

describe("the gate", () => {
  it("answers 404 in the all role and subscribes nothing", async () => {
    process.env.CROSSFIRE_ROLE = "all";
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(h.handle.getConnectedState).not.toHaveBeenCalled();
  });

  it.each([null, "Bearer wrong"])("answers 401 to authorization %s", async (auth) => {
    const res = await GET(request(auth));
    expect(res.status).toBe(401);
    expect(h.handle.subscribeEvents).not.toHaveBeenCalled();
  });

  it("answers 503 when the engine has no transport to relay from", async () => {
    h.handle.getConnectedState.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "RealtimeFeedDisabled" } });
  });
});

describe("the stream", () => {
  it("sends the connected state, then every event the relay delivers, in the browser stream's frame shape", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("connection")).toBe("close");
    await vi.waitFor(() => expect(h.listeners.size).toBe(1));
    expect(h.handle.ensureRunning).not.toHaveBeenCalled();

    const [key, listener] = [...h.listeners.entries()][0];
    expect(key).toMatch(/^internal-/);
    listener({ kind: "deploymentsChanged" });
    listener({ kind: "marketTrade", contractId: "CON.F.US.MNQ.Z26", lastPrice: 21000.25, timestamp: "t" });
    h.afterClose[0]("SIGTERM");

    const body = await drain(res);
    expect(body).toContain('event: deploymentsChanged\ndata: {"kind":"deploymentsChanged"}\n\n');
    expect(parseSseEvents(body).events).toEqual([
      { kind: "status", connected: true },
      { kind: "deploymentsChanged" },
      { kind: "marketTrade", contractId: "CON.F.US.MNQ.Z26", lastPrice: 21000.25, timestamp: "t" },
    ]);
  });

  it("is ended by the shutdown set, which releases its listener", async () => {
    const res = await GET(request());
    await vi.waitFor(() => expect(h.listeners.size).toBe(1));
    const streams = (globalThis as unknown as Record<string, { ends: Set<unknown> }>)[OPEN_STREAMS_KEY];
    expect(streams.ends.size).toBe(1);

    h.afterClose[0]("SIGTERM");

    await expect(drain(res)).resolves.toContain('"kind":"status"');
    expect(h.unsubscribed).toHaveLength(1);
    expect(streams.ends.size).toBe(0);
  });

  it("releases its listener when the web process disconnects", async () => {
    const controller = new AbortController();
    await GET(request(`Bearer ${SECRET}`, controller.signal));
    await vi.waitFor(() => expect(h.listeners.size).toBe(1));
    controller.abort();
    expect(h.unsubscribed).toHaveLength(1);
  });
});
