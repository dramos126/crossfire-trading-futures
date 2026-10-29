import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetLogBursts, setLogSink, type LogRecord } from "@/lib/logging/pipe";
import * as signalR from "@microsoft/signalr";
import { TopstepSignalR } from "./signalr";

const TOKEN = "eyJ.SECRET-BEARER.sig";
const ROTATED = "eyJ.ROTATED-BEARER.sig";

/**
 * Stands in for the socket constructor SignalR is handed. It records what it
 * was asked to open and then fails the connect, so `start()` rejects without
 * a network — the hub's lifecycle is not under test, only what reaches the
 * socket and what reaches a log or an error.
 */
class RecordingSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: string[] = [];
  binaryType = "blob";
  readyState = RecordingSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(url: string | URL) {
    RecordingSocket.opened.push(String(url));
    setTimeout(() => this.onclose?.({ code: 1006, wasClean: false }), 0);
  }
  send(): void {}
  close(): void {}
}

describe("TopstepSignalR — A4: the bearer never rides a URL SignalR holds, logs or throws", () => {
  const records: LogRecord[] = [];
  const consoleLines: string[] = [];

  beforeEach(() => {
    RecordingSocket.opened = [];
    records.length = 0;
    consoleLines.length = 0;
    resetLogBursts();
    setLogSink({ write: (r) => void records.push(r), bump: () => {} });
    vi.stubGlobal("WebSocket", RecordingSocket);
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(() => {
    setLogSink(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("A4: on Node the hub URL carries no token, and the token is in no log line or error", async () => {
    const signalR = new TopstepSignalR(() => TOKEN);
    const hub = signalR.buildMarketHub();

    expect(hub.baseUrl).not.toContain(TOKEN);
    expect(hub.baseUrl).not.toContain("access_token");

    const err = await signalR.startMarketHub().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).stack)).not.toContain(TOKEN);

    // The gateway reads the bearer off the upgrade's query and ignores the
    // Authorization header, so the socket request itself must carry it.
    expect(RecordingSocket.opened).toHaveLength(1);
    expect(new URL(RecordingSocket.opened[0]).searchParams.get("access_token")).toBe(TOKEN);

    for (const line of consoleLines) expect(line).not.toContain(TOKEN);
    for (const r of records) expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("A4: every connect reads the token fresh, so a rotation reaches a restart on the same hub", async () => {
    let current = TOKEN;
    const signalR = new TopstepSignalR(() => current);
    signalR.buildUserHub();

    await signalR.startUserHub().catch(() => {});
    current = ROTATED;
    await signalR.startUserHub().catch(() => {});

    expect(RecordingSocket.opened.map((u) => new URL(u).searchParams.get("access_token"))).toEqual([
      TOKEN,
      ROTATED,
    ]);
  });
});

/**
 * The hub-rebuild audit from the MaxListeners bug: the market hub's
 * `connect()` builds a fresh hub (which replays the stored trade handler)
 * and then registers its own new closure through `onTrade`. SignalR
 * lower-cases method names and de-duplicates only an identical function, so
 * the rebuilt hub carried both closures and every print reached the engine
 * twice — doubled volume in every bar after the first rebuild.
 */
describe("TopstepSignalR — trade handler across a market-hub rebuild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("MaxListeners audit: a rebuilt hub delivers each print to exactly one handler, the latest", () => {
    const registered = new Map<signalR.HubConnection, Map<string, ((...a: unknown[]) => void)[]>>();
    const realOn = signalR.HubConnection.prototype.on;
    vi.spyOn(signalR.HubConnection.prototype, "on").mockImplementation(function (
      this: signalR.HubConnection,
      method: string,
      fn: (...a: unknown[]) => void,
    ) {
      const byMethod = registered.get(this) ?? new Map<string, ((...a: unknown[]) => void)[]>();
      registered.set(this, byMethod);
      const key = method.toLowerCase();
      const list = byMethod.get(key) ?? [];
      if (!list.includes(fn)) list.push(fn);
      byMethod.set(key, list);
      realOn.call(this, method, fn);
    });

    const signalRClient = new TopstepSignalR(() => TOKEN);
    const first = vi.fn();
    const second = vi.fn();
    signalRClient.buildMarketHub();
    signalRClient.onTrade(first);
    const rebuilt = signalRClient.buildMarketHub();
    signalRClient.onTrade(second);

    const trade = { price: 1, timestamp: "2026-10-23T14:00:00Z", type: 0, volume: 1 };
    for (const fn of registered.get(rebuilt)?.get("gatewaytrade") ?? []) fn("CON.F.US.MNQ.Z26", trade);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
