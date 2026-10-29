import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));
vi.mock("@/lib/notify/discord", () => ({ sendDiscordAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db/tradovate-order-map", () => ({
  lookupByOrderId: vi.fn().mockReturnValue(null),
  markTerminal: vi.fn(),
}));

import { TradovateRealtime, type TradovateRealtimeOptions } from "./realtime";
import type { TradovatePosition } from "./types";
import { POSITION_TYPE_FLAT, signedSize, type Position } from "@/lib/brokers/types";

const ACCOUNT_ID = 90035646;
// One of the ids the 2026-08-26 boot logged as dropped.
const UNMAPPED_CONTRACT_ID = 4327115;
const DATED_SYMBOL = "MNQZ6";

interface Dispatcher {
  dispatchEntity(entityType: string, entity: unknown): void;
}

function openPosition(): TradovatePosition {
  return { id: 1, accountId: ACCOUNT_ID, contractId: UNMAPPED_CONTRACT_ID, netPos: 2, netPrice: 21000 };
}

function subscriber(opts: Partial<TradovateRealtimeOptions>): {
  rt: TradovateRealtime;
  seen: Position[];
} {
  const rt = new TradovateRealtime({
    getAccessToken: async () => "token",
    userId: 1,
    accountId: ACCOUNT_ID,
    ...opts,
  });
  const seen: Position[] = [];
  rt.onPosition((_acct, position) => seen.push(position));
  return { rt, seen };
}

describe("TradovateRealtime — a position on a contract the dated-symbol cache does not know", () => {
  let cache: Map<number, string>;
  beforeEach(() => {
    cache = new Map();
  });

  it("tradovate-positions-not-in-dated-symbol-cache: dispatches the position once the warm maps its contract, instead of dropping it", async () => {
    let finishWarm: () => void = () => {};
    const { rt, seen } = subscriber({
      getDatedSymbol: (id) => cache.get(id) ?? null,
      warmContractId: () =>
        new Promise<void>((resolve) => {
          finishWarm = () => {
            cache.set(UNMAPPED_CONTRACT_ID, DATED_SYMBOL);
            resolve();
          };
        }),
    });

    (rt as unknown as Dispatcher).dispatchEntity("position", openPosition());
    // Never dispatched under the numeric id — that would mis-attribute.
    expect(seen).toEqual([]);

    finishWarm();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ contractId: DATED_SYMBOL, size: 2 });
  });

  it("keeps a held position ahead of a newer frame that lands after another path warmed the cache", async () => {
    let finishWarm: () => void = () => {};
    const { rt, seen } = subscriber({
      getDatedSymbol: (id) => cache.get(id) ?? null,
      warmContractId: () =>
        new Promise<void>((resolve) => {
          finishWarm = resolve;
        }),
    });
    const dispatcher = rt as unknown as Dispatcher;

    // The sync snapshot's open misses the cold cache and is held.
    dispatcher.dispatchEntity("position", openPosition());
    // warmContractIdsForRoots names the contract while that warm is in flight,
    // and the close arrives on a cache hit.
    cache.set(UNMAPPED_CONTRACT_ID, DATED_SYMBOL);
    dispatcher.dispatchEntity("position", { ...openPosition(), netPos: 0 });
    expect(seen).toEqual([]);

    finishWarm();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    // Open then close: the engine must never be left reading an open on a
    // flat position.
    expect(seen.map((p) => p.size)).toEqual([2, 0]);
  });

  // bugs.md A41: the close frame is the one place the WS path emits netPos 0.
  it("emits a netPos:0 close as a flat position, never a short", () => {
    cache.set(UNMAPPED_CONTRACT_ID, DATED_SYMBOL);
    const { rt, seen } = subscriber({ getDatedSymbol: (id) => cache.get(id) ?? null });
    (rt as unknown as Dispatcher).dispatchEntity("position", { ...openPosition(), netPos: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ contractId: DATED_SYMBOL, type: POSITION_TYPE_FLAT, size: 0 });
    expect(Object.is(signedSize(seen[0]), 0)).toBe(true);
  });

  it("drops the position when the warm cannot name the contract", async () => {
    const warm = vi.fn(async () => {});
    const { rt, seen } = subscriber({
      getDatedSymbol: (id) => cache.get(id) ?? null,
      warmContractId: warm,
    });

    (rt as unknown as Dispatcher).dispatchEntity("position", openPosition());
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(seen).toEqual([]);
    // One warm per event: a failed warm does not loop.
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after dispose", async () => {
    let finishWarm: () => void = () => {};
    const { rt, seen } = subscriber({
      getDatedSymbol: (id) => cache.get(id) ?? null,
      warmContractId: () =>
        new Promise<void>((resolve) => {
          finishWarm = () => {
            cache.set(UNMAPPED_CONTRACT_ID, DATED_SYMBOL);
            resolve();
          };
        }),
    });

    (rt as unknown as Dispatcher).dispatchEntity("position", openPosition());
    rt.dispose();
    finishWarm();
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([]);
  });
});

interface Handshake {
  state: string;
  handleResponse(status: number, payload: unknown): void;
}

describe("TradovateRealtime — subscribe hooks", () => {
  function subscribe(rt: TradovateRealtime): void {
    const handshake = rt as unknown as Handshake;
    handshake.state = "authorizing";
    handshake.handleResponse(200, {});
  }

  it("fires onSubscribed on every subscribe and onReconnect only after the first", () => {
    const { rt } = subscriber({});
    const events: string[] = [];
    rt.onSubscribed((id) => events.push(`subscribed:${id}`));
    rt.onReconnect((id) => events.push(`reconnect:${id}`));

    subscribe(rt);
    expect(events).toEqual([`subscribed:${ACCOUNT_ID}`]);

    subscribe(rt);
    expect(events).toEqual([
      `subscribed:${ACCOUNT_ID}`,
      `subscribed:${ACCOUNT_ID}`,
      `reconnect:${ACCOUNT_ID}`,
    ]);
    rt.dispose();
  });

  it("still fires onReconnect when the onSubscribed handler throws", () => {
    const { rt } = subscriber({});
    const reconnects: number[] = [];
    rt.onSubscribed(() => {
      throw new Error("boom");
    });
    rt.onReconnect((id) => reconnects.push(id));

    subscribe(rt);
    subscribe(rt);

    expect(reconnects).toEqual([ACCOUNT_ID]);
    rt.dispose();
  });
});

/** Minimal stand-in for the browser/Node WebSocket the subscriber drives,
 *  so a drop-and-reconnect can be scripted frame by frame. `readyState`
 *  stays OPEN (1, matching the global `WebSocket.OPEN` the subscriber
 *  compares against) so `send` records rather than no-ops. */
class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const frame = (data: string): MessageEvent => ({ data }) as unknown as MessageEvent;
const AUTH_ACK = 'a[{"i":1,"s":200}]';

describe("TradovateRealtime — reconnect-gap anchor", () => {
  // The defect this pins: the new socket's greeting and authorize ack bump
  // `lastEventAt` to ~now before the reconnect hook fires, so an anchor read
  // off live status begins the replay window at roughly now and a fill
  // inside a gap longer than the pad is never asked for. The pre-drop event
  // time must ride the signal instead.
  it("hands the reconnect hook the pre-drop event time, not the new socket's handshake", async () => {
    const sockets: FakeSocket[] = [];
    class TrackingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { rt } = subscriber({
      webSocketCtor: TrackingSocket as unknown as typeof WebSocket,
      getTokenExpiresAt: () => 1_000_000,
    });
    const anchors: Array<{ id: number; anchor: number }> = [];
    rt.onReconnect((id, anchor) => anchors.push({ id, anchor }));

    await rt.start();
    const first = sockets[0];
    first.onmessage?.(frame("o")); // greeting → authorize
    first.onmessage?.(frame(AUTH_ACK)); // ack → subscribed (first, not a reconnect)

    // A real data event lands, moving lastEventAt to the pre-drop time.
    const PRE_DROP = 5_000;
    vi.mocked(Date.now).mockReturnValue(PRE_DROP);
    first.onmessage?.(frame("a[]"));
    expect(anchors).toEqual([]);

    // The socket drops well past the 60s replay pad, then reconnects.
    vi.mocked(Date.now).mockReturnValue(PRE_DROP + 120_000);
    first.close(1006, "gap");
    await (rt as unknown as { openSocket(): Promise<void> }).openSocket();

    const second = sockets[1];
    const HANDSHAKE = PRE_DROP + 130_000;
    vi.mocked(Date.now).mockReturnValue(HANDSHAKE);
    second.onmessage?.(frame("o"));
    second.onmessage?.(frame(AUTH_ACK)); // resubscribe → reconnect

    expect(anchors).toEqual([{ id: ACCOUNT_ID, anchor: PRE_DROP }]);
    expect(anchors[0].anchor).toBeLessThan(HANDSHAKE);

    rt.dispose();
    vi.mocked(Date.now).mockRestore();
  });

  it("keeps the first drop's anchor when a reconnect attempt fails and re-drops", async () => {
    const sockets: FakeSocket[] = [];
    class TrackingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { rt } = subscriber({
      webSocketCtor: TrackingSocket as unknown as typeof WebSocket,
      getTokenExpiresAt: () => 1_000_000,
    });
    const anchors: Array<{ id: number; anchor: number }> = [];
    rt.onReconnect((id, anchor) => anchors.push({ id, anchor }));

    await rt.start();
    sockets[0].onmessage?.(frame("o"));
    sockets[0].onmessage?.(frame(AUTH_ACK));
    const PRE_DROP = 5_000;
    vi.mocked(Date.now).mockReturnValue(PRE_DROP);
    sockets[0].onmessage?.(frame("a[]"));

    // First drop records the anchor.
    vi.mocked(Date.now).mockReturnValue(PRE_DROP + 90_000);
    sockets[0].close(1006, "gap");
    // The reconnect attempt gets a greeting (bumping lastEventAt to ~now)
    // then its authorize is rejected, so it re-drops before subscribing.
    await (rt as unknown as { openSocket(): Promise<void> }).openSocket();
    vi.mocked(Date.now).mockReturnValue(PRE_DROP + 95_000);
    sockets[1].onmessage?.(frame("o"));
    sockets[1].onmessage?.(frame('a[{"i":1,"s":401,"d":"nope"}]')); // auth rejected → closeSocket

    // The next attempt finally subscribes; the anchor is still the first
    // drop's, not the failed attempt's handshake.
    await (rt as unknown as { openSocket(): Promise<void> }).openSocket();
    vi.mocked(Date.now).mockReturnValue(PRE_DROP + 100_000);
    sockets[2].onmessage?.(frame("o"));
    sockets[2].onmessage?.(frame(AUTH_ACK));

    expect(anchors).toEqual([{ id: ACCOUNT_ID, anchor: PRE_DROP }]);

    rt.dispose();
    vi.mocked(Date.now).mockRestore();
  });

  it("a non-200 auth ack with no payload does not throw out of the socket callback", async () => {
    const sockets: FakeSocket[] = [];
    class TrackingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { rt } = subscriber({
      webSocketCtor: TrackingSocket as unknown as typeof WebSocket,
      getTokenExpiresAt: () => 1_000_000,
    });

    await rt.start();
    sockets[0].onmessage?.(frame("o"));
    // A rejected ack carrying no `d` — JSON.stringify(undefined) is undefined,
    // so .slice would throw and escape the un-try/catch'd onmessage, pre-empting
    // the auth-rejected teardown. The guard makes it a clean close instead.
    expect(() => sockets[0].onmessage?.(frame('a[{"i":1,"s":401}]'))).not.toThrow();
    expect(sockets[0].readyState).toBe(3);

    rt.dispose();
  });
});
