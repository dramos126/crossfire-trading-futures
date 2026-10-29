import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetLogBursts, setLogSink, type LogRecord } from "@/lib/logging/pipe";
import { TopstepRealtimeAdapter } from "./realtime-adapter";
import { topstepSessionState } from "./client";
import type { TopstepUserHubTransport } from "./user-hub";
import type {
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
} from "./signalr";

/**
 * Fake user-hub transport. The socket itself is untestable here (see
 * docs/modules/testing/patterns.md); everything the adapter does *around*
 * it — ref-counting, subscribe deltas, handler fan-out, the reconnect
 * loop — is pure and exercised against this.
 */
class FakeUserHub implements TopstepUserHubTransport {
  builds = 0;
  starts = 0;
  stops = 0;
  hubState = "Connected";
  startImpl: () => Promise<void> = async () => {};
  subscribeImpl: (accountId: number) => Promise<void> = async () => {};
  subscribed: number[] = [];
  unsubscribed: number[] = [];
  /** Interleaved wire log — the ordering the hub actually saw. */
  wire: string[] = [];

  orderHandler: ((o: GatewayUserOrder) => void) | null = null;
  positionHandler: ((p: GatewayUserPosition) => void) | null = null;
  userTradeHandler: ((t: GatewayUserTrade) => void) | null = null;
  reconnectedHandler: (() => void) | null = null;
  reconnectingHandler: ((err?: Error) => void) | null = null;
  closeHandler: ((err?: Error) => void) | null = null;
  gatewayLogoutHandler: ((reason: string) => void) | null = null;
  /** SignalR's `stop()` fires `onclose` on the hub it stops. Opt-in, so the
   *  tests that predate it keep the silent stop they were written against. */
  closeOnStop = false;

  build(): void {
    this.builds++;
    // A fresh hub instance carries no handlers until they are re-attached.
    this.orderHandler = null;
    this.positionHandler = null;
    this.userTradeHandler = null;
    this.reconnectedHandler = null;
    this.reconnectingHandler = null;
    this.closeHandler = null;
    this.gatewayLogoutHandler = null;
  }
  async start(): Promise<void> {
    this.starts++;
    await this.startImpl();
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.closeOnStop) this.closeHandler?.();
  }
  state(): string {
    return this.hubState;
  }
  onOrder(h: (o: GatewayUserOrder) => void): void {
    this.orderHandler = h;
  }
  onPosition(h: (p: GatewayUserPosition) => void): void {
    this.positionHandler = h;
  }
  onUserTrade(h: (t: GatewayUserTrade) => void): void {
    this.userTradeHandler = h;
  }
  onReconnected(h: () => void): void {
    this.reconnectedHandler = h;
  }
  onReconnecting(h: (err?: Error) => void): void {
    this.reconnectingHandler = h;
  }
  onClose(h: (err?: Error) => void): void {
    this.closeHandler = h;
  }
  onGatewayLogout(h: (reason: string) => void): void {
    this.gatewayLogoutHandler = h;
  }
  async subscribeAccount(accountId: number): Promise<void> {
    this.subscribed.push(accountId);
    await this.subscribeImpl(accountId);
    this.wire.push(`sub:${accountId}`);
  }
  async unsubscribeAccount(accountId: number): Promise<void> {
    this.unsubscribed.push(accountId);
    this.wire.push(`unsub:${accountId}`);
  }
}

const ORDER: GatewayUserOrder = {
  id: 1,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  symbolId: "F.US.MNQ",
  creationTimestamp: "2026-08-22T13:31:02.117Z",
  updateTimestamp: "2026-08-22T13:31:02.480Z",
  status: 2,
  type: 2,
  side: 0,
  size: 1,
  limitPrice: null,
  stopPrice: null,
  fillVolume: 1,
  filledPrice: 24680.25,
  customTag: "e_a1b2c3d4_m1x9_9f2a",
};

const POSITION: GatewayUserPosition = {
  id: 2,
  accountId: 9002,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  type: 1,
  size: 2,
  averagePrice: 24680.25,
};

const FILL: GatewayUserTrade = {
  id: 3,
  accountId: 9003,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  price: 24680.25,
  profitAndLoss: null,
  fees: 0.56,
  side: 0,
  size: 1,
  voided: false,
  orderId: 1,
};

let hub: FakeUserHub;
let adapter: TopstepRealtimeAdapter;

/** `reconcile()` is serialised through a promise chain, so a run does not
 *  begin in the caller's turn. Flush before asserting on mid-run state. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  hub = new FakeUserHub();
  // Market open, whatever day the suite runs; the closed-market tests below
  // build their own.
  adapter = new TopstepRealtimeAdapter(hub, () => null);
  // The adapter logs through the pipe, whose burst window is process-wide
  // module state — see docs/modules/testing/patterns.md.
  resetLogBursts();
});

// ── Ref-counting: one process-wide hub, an account-keyed interface ─────────

describe("TopstepRealtimeAdapter — hub ref-counting", () => {
  it("starts the shared hub on the first account and only once for the second", async () => {
    await adapter.connect(1001);
    await adapter.connect(1002);

    expect(hub.builds).toBe(1);
    expect(hub.starts).toBe(1);
    expect(hub.subscribed).toEqual([1001, 1002]);
  });

  it("keeps the hub alive when one of two connected accounts disconnects", async () => {
    await adapter.connect(1001);
    await adapter.connect(1002);

    adapter.disconnect(1001);
    await vi.waitFor(() => expect(hub.unsubscribed).toEqual([1001]));

    expect(hub.stops).toBe(0);
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.status(1002)).not.toBeNull();
  });

  it("tears the hub down exactly once when the last account disconnects", async () => {
    await adapter.connect(1001);
    await adapter.connect(1002);

    adapter.disconnect(1001);
    adapter.disconnect(1002);
    await vi.waitFor(() => expect(hub.stops).toBe(1));

    // A repeat disconnect of an already-released account must not stop again.
    adapter.disconnect(1002);
    await Promise.resolve();
    expect(hub.stops).toBe(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it("is a no-op on an unknown account id", async () => {
    await adapter.connect(1001);
    const stopsBefore = hub.stops;
    const unsubsBefore = hub.unsubscribed.length;

    adapter.disconnect(4242);
    await Promise.resolve();

    expect(hub.stops).toBe(stopsBefore);
    expect(hub.unsubscribed.length).toBe(unsubsBefore);
    expect(adapter.isConnected()).toBe(true);
  });

  it("releases only the departed accounts when sync() shrinks the set", async () => {
    await adapter.sync(new Set([1001, 1002, 1003]));
    expect(hub.subscribed).toEqual([1001, 1002, 1003]);

    await adapter.sync(new Set([1002]));

    expect(hub.unsubscribed.sort()).toEqual([1001, 1003]);
    expect(hub.stops).toBe(0);
    expect(adapter.status(1002)).not.toBeNull();
    expect(adapter.status(1001)).toBeNull();
  });

  it("stops the hub when sync() empties the set and nobody else holds it", async () => {
    await adapter.sync(new Set([1001]));
    await adapter.sync(new Set());

    expect(hub.stops).toBe(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it("does not prune another holder's pins when the engine's sync shrinks", async () => {
    await adapter.sync(new Set([1001]));
    await adapter.connect(2002);

    await adapter.sync(new Set());

    expect(hub.stops).toBe(0);
    expect(hub.unsubscribed).toEqual([1001]);
    expect(adapter.status(2002)).not.toBeNull();
  });

  it("keeps the hub up for a keep-alive holder with no accounts at all", async () => {
    await adapter.retain("broadcaster", []);

    expect(hub.starts).toBe(1);
    expect(hub.subscribed).toEqual([]);

    await adapter.sync(new Set([1001]));
    await adapter.sync(new Set());

    expect(hub.stops).toBe(0);
  });

  it("stops the hub once the last keep-alive holder releases", async () => {
    await adapter.retain("broadcaster", [1001]);
    adapter.release("broadcaster", [1001]);
    await vi.waitFor(() => expect(hub.stops).toBe(1));
  });

  it("shutdown() drops every holder and tears the hub down", async () => {
    await adapter.retain("broadcaster", [1001]);
    await adapter.sync(new Set([1002]));

    adapter.shutdown();
    await vi.waitFor(() => expect(hub.stops).toBe(1));

    expect(adapter.status(1001)).toBeNull();
    expect(adapter.status(1002)).toBeNull();
  });

  it("stops a hub whose start was still in flight when shutdown() landed", async () => {
    // The sweep in `attachRealtimeAdapters` calling shutdown() on an
    // incumbent mid-`retain`. Called off the chain, stopHub() takes its
    // early return (`started` is still false), never sends
    // `transport.stop()`, and the in-flight start then resolves into a
    // live process-wide socket with zero holders — the orphan the sweep
    // exists to prevent, reached through the sweep.
    let release: () => void = () => {};
    hub.startImpl = () => new Promise<void>((r) => { release = () => r(); });

    const mount = adapter.retain("broadcaster", [1001]);
    await flush();
    expect(hub.stops).toBe(0);

    adapter.shutdown();
    release();
    await mount;
    await vi.waitFor(() => expect(hub.stops).toBe(1));
  });

  it("refuses to bring the hub back up after shutdown()", async () => {
    await adapter.retain("broadcaster", [1001]);
    adapter.shutdown();
    await vi.waitFor(() => expect(hub.stops).toBe(1));
    const startsAfterShutdown = hub.starts;

    await expect(adapter.retain("broadcaster", [1001])).rejects.toThrow("shut down");
    await expect(adapter.forceReconnect()).rejects.toThrow("shut down");

    expect(hub.starts).toBe(startsAfterShutdown);
    expect(adapter.isConnected()).toBe(false);
  });

  it("is idempotent — a second shutdown() does not re-stop the transport", async () => {
    await adapter.sync(new Set([1001]));

    adapter.shutdown();
    adapter.shutdown();
    await vi.waitFor(() => expect(hub.stops).toBe(1));
    await flush();

    expect(hub.stops).toBe(1);
  });

  it("serialises a sync that lands while the hub is still starting", async () => {
    let release: () => void = () => {};
    hub.startImpl = () => new Promise<void>((r) => { release = () => r(); });

    const first = adapter.sync(new Set([1001]));
    await flush();

    // Unserialised, this run sees `started === false` with an empty
    // `subscribed`, takes stopHub()'s early return, and the first run then
    // brings up a hub nobody wants — subscribed to 1001, with isHealthy()
    // and status() reporting a feed the engine has already released.
    const second = adapter.sync(new Set());
    release();
    await Promise.all([first, second]);

    expect(hub.stops).toBe(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it("keeps a subscribe and its later unsubscribe in order on the wire", async () => {
    await adapter.retain("broadcaster");
    hub.wire.length = 0;
    hub.subscribeImpl = () => new Promise<void>((r) => setTimeout(r, 5));

    // applySync() adds the account; the browser's mount drops it again
    // before the subscribe round-trip has returned.
    const add = adapter.sync(new Set([1001]));
    await flush();
    const remove = adapter.sync(new Set());
    await Promise.all([add, remove]);

    expect(hub.wire).toEqual(["sub:1001", "unsub:1001"]);
  });

  it("orders a reconnect resubscribe against a reconcile that drops the account", async () => {
    // `onReconnected` fires its re-issue on the chain, not with `void`.
    // Off-chain, `resubscribeAll` clears `subscribed` synchronously, so the
    // reconcile behind it computes an empty `leaving` and puts nothing on
    // the wire — then the in-flight subscribe lands and re-adds the id.
    // The hub is left streaming an account no holder wants, with
    // `subscribed` agreeing.
    await adapter.retain("broadcaster");
    await adapter.sync(new Set([1001]));
    hub.wire.length = 0;
    hub.subscribeImpl = () => new Promise<void>((r) => setTimeout(r, 5));

    hub.reconnectedHandler?.();
    await flush();
    await adapter.sync(new Set());

    expect(hub.wire).toEqual(["sub:1001", "unsub:1001"]);
    expect(adapter.status(1001)).toBeNull();
  });

  it("retries an account whose subscribe failed instead of leaving it wedged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hub.subscribeImpl = () => Promise.reject(new Error("hub mid-handshake"));

    await adapter.sync(new Set([1001]));
    // Rolled back out of `subscribed`, so the same reconcile's joining
    // pass retries it once the start's resubscribe has failed. Leaving it
    // in would take it out of `joining` for good — only a full hub
    // teardown recovers that, while isHealthy() keeps saying it is live.
    expect(hub.subscribed).toEqual([1001, 1001]);

    hub.subscribeImpl = async () => {};
    await adapter.sync(new Set([1001]));
    expect(hub.subscribed).toEqual([1001, 1001, 1001]);

    // And once it sticks, a further reconcile must not re-issue it.
    await adapter.sync(new Set([1001]));
    expect(hub.subscribed).toEqual([1001, 1001, 1001]);
    warn.mockRestore();
  });

  it("collapses two concurrent starts into one hub build", async () => {
    let release: () => void = () => {};
    hub.startImpl = () => new Promise<void>((r) => { release = () => r(); });

    const a = adapter.sync(new Set([1001]));
    await flush();
    const b = adapter.connect(1002);
    release();
    await Promise.all([a, b]);

    expect(hub.builds).toBe(1);
    expect(hub.starts).toBe(1);
  });
});

// ── Translation and fan-out at the boundary ───────────────────────────────

describe("TopstepRealtimeAdapter — event fan-out", () => {
  it("delivers neutral types with the accountId taken off the payload", async () => {
    const orders: Array<[number, unknown]> = [];
    const positions: Array<[number, unknown]> = [];
    const fills: Array<[number, unknown]> = [];
    adapter.onOrder((id, o) => orders.push([id, o]));
    adapter.onPosition((id, p) => positions.push([id, p]));
    adapter.onFill((id, f) => fills.push([id, f]));

    await adapter.sync(new Set([9001]));

    hub.orderHandler?.(ORDER);
    hub.positionHandler?.(POSITION);
    hub.userTradeHandler?.(FILL);

    // accountId comes off the event, not from which adapter fired — the
    // process-wide hub carries every account the credential can see.
    expect(orders[0][0]).toBe(9001);
    expect(positions[0][0]).toBe(9002);
    expect(fills[0][0]).toBe(9003);
    expect(orders[0][1]).not.toHaveProperty("symbolId");
    expect(positions[0][1]).toEqual({
      id: 2,
      accountId: 9002,
      contractId: "CON.F.US.MNQ.M26",
      creationTimestamp: "2026-08-22T13:31:02.480Z",
      type: 1,
      size: 2,
      averagePrice: 24680.25,
    });
  });

  it("fans out to every registered handler — the engine and the SSE relay both listen", async () => {
    const seen: string[] = [];
    adapter.onPosition(() => seen.push("engine"));
    adapter.onPosition(() => seen.push("relay"));

    await adapter.sync(new Set([9002]));
    hub.positionHandler?.(POSITION);

    expect(seen).toEqual(["engine", "relay"]);
  });

  it("does not let one throwing handler starve the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    adapter.onPosition(() => {
      throw new Error("listener blew up");
    });
    adapter.onPosition(() => seen.push("second"));

    await adapter.sync(new Set([9002]));
    hub.positionHandler?.(POSITION);

    expect(seen).toEqual(["second"]);
    warn.mockRestore();
  });

  it("counts every event kind toward liveness and consumes the window", async () => {
    await adapter.sync(new Set([9001]));
    hub.orderHandler?.(ORDER);
    hub.positionHandler?.(POSITION);
    hub.userTradeHandler?.(FILL);

    const first = adapter.liveness();
    expect(first.windowCount).toBe(3);
    expect(first.hubStarted).toBe(true);
    expect(adapter.liveness().windowCount).toBe(0);
  });

  it("fires onReconnect once per live account when the transport reconnects", async () => {
    const seen: number[] = [];
    adapter.onReconnect((id) => seen.push(id));

    await adapter.sync(new Set([1001, 1002]));
    hub.reconnectedHandler?.();

    expect(seen.sort()).toEqual([1001, 1002]);
  });

  it("re-issues every subscription after a reconnect — Topstep clears them server-side", async () => {
    await adapter.sync(new Set([1001, 1002]));
    hub.subscribed.length = 0;

    hub.reconnectedHandler?.();
    await vi.waitFor(() => expect(hub.subscribed.sort()).toEqual([1001, 1002]));
  });
});

// ── The reconnect signal on the hard-recovery paths ───────────────────────

/**
 * `onReconnected` is SignalR's *automatic* reconnect and was the only
 * caller of `fireReconnect`. The paths that recover a hub after a real
 * `onclose` — the 30s `attemptReconnect` loop and `forceReconnect` — all
 * land in `doStart`, so the outages long enough to need the engine's
 * reconnect-gap replay were exactly the ones that never asked for it.
 */
describe("TopstepRealtimeAdapter — reconnect signal on a restart", () => {
  it("fires nothing on a cold first start — there is no gap to replay", async () => {
    const seen: number[] = [];
    adapter.onReconnect((id) => seen.push(id));

    await adapter.sync(new Set([1001, 1002]));

    expect(seen).toEqual([]);
  });

  it("fires per live account when forceReconnect rebuilds the hub", async () => {
    const seen: number[] = [];
    await adapter.sync(new Set([1001, 1002]));
    adapter.onReconnect((id) => seen.push(id));

    await adapter.forceReconnect();

    expect(seen.sort()).toEqual([1001, 1002]);
  });

  it("fires when a reconcile restarts a hub that had closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: number[] = [];
    await adapter.retain("broadcaster", [1001]);
    adapter.onReconnect((id) => seen.push(id));

    hub.closeHandler?.(new Error("connection reset"));
    await adapter.sync(new Set([1002]));

    expect(seen.sort()).toEqual([1001, 1002]);
    warn.mockRestore();
  });

  it("fires nothing when the restart itself fails to start", async () => {
    const seen: number[] = [];
    await adapter.sync(new Set([1001]));
    adapter.onReconnect((id) => seen.push(id));
    hub.startImpl = () => Promise.reject(new Error("still displaced"));

    await expect(adapter.forceReconnect()).rejects.toThrow("still displaced");

    expect(seen).toEqual([]);
  });

  it("does not let one throwing reconnect handler starve the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    await adapter.sync(new Set([1001]));
    adapter.onReconnect(() => {
      throw new Error("replay blew up");
    });
    adapter.onReconnect(() => seen.push("second"));

    await adapter.forceReconnect();

    expect(seen).toEqual(["second"]);
    warn.mockRestore();
  });

  it("fires when the 30s reconnect loop brings the hub back", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const seen: number[] = [];
      await adapter.sync(new Set([1001, 1002]));
      adapter.onReconnect((id) => seen.push(id));

      hub.startImpl = () => Promise.reject(new Error("hub down"));
      hub.closeHandler?.(new Error("connection closed"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen).toEqual([]);

      hub.startImpl = async () => {};
      await vi.advanceTimersByTimeAsync(30_000);

      expect(seen.sort()).toEqual([1001, 1002]);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Status + gatewaylogout attribution ────────────────────────────────────

describe("TopstepRealtimeAdapter — connection status", () => {
  it("reports a plain close with the transport's own reason", async () => {
    const statuses: Array<[boolean, string | undefined]> = [];
    adapter.onStatus((connected, reason) => statuses.push([connected, reason]));

    await adapter.sync(new Set([1001]));
    hub.closeHandler?.(new Error("connection reset"));

    expect(statuses).toContainEqual([true, undefined]);
    expect(statuses.at(-1)).toEqual([false, "connection reset"]);
  });

  it("promotes a close inside the gatewaylogout window to a session displacement", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses: Array<[boolean, string | undefined]> = [];
    adapter.onStatus((connected, reason) => statuses.push([connected, reason]));

    await adapter.sync(new Set([1001]));
    hub.gatewayLogoutHandler?.("Multiple sessions detected.");
    hub.closeHandler?.();

    expect(statuses.at(-1)?.[1]).toContain("Session displaced by another login");
    // `warn` is a console stream and a chip, not just a label. This arm
    // names `ws_session_displaced` rather than `ws_disconnected` precisely
    // so it keeps both: the transient closes it used to share an event
    // with are `info`, and folding this one in with them put a
    // displacement on the routine CONNECTION lane.
    expect(warn.mock.calls.flat().join(" ")).toContain("treating as real disconnect");
    warn.mockRestore();
  });

  // A90: our own login (a recovery mint) sends the advisory to our own hubs;
  // a close after it is not another device taking the slot.
  it("A90: does not name a close after this process's own login a displacement", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[boolean, string | undefined]> = [];
      adapter.onStatus((connected, reason) => statuses.push([connected, reason]));

      await adapter.sync(new Set([1001]));
      vi.setSystemTime(Date.now() + 1_000);
      topstepSessionState().lastLoginAtMs = Date.now();
      hub.gatewayLogoutHandler?.("Multiple sessions detected.");
      hub.closeHandler?.();

      expect(statuses.at(-1)).toEqual([false, "connection closed"]);
    } finally {
      topstepSessionState().lastLoginAtMs = null;
      vi.useRealTimers();
    }
  });

  it("leaves a close outside the gatewaylogout window as a plain transient", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[boolean, string | undefined]> = [];
      adapter.onStatus((connected, reason) => statuses.push([connected, reason]));

      await adapter.sync(new Set([1001]));
      hub.gatewayLogoutHandler?.("Multiple sessions detected.");
      vi.setSystemTime(Date.now() + 5_000);
      hub.closeHandler?.();

      expect(statuses.at(-1)).toEqual([false, "connection closed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Reconnect loop: cap, cooldown, sustained reset ────────────────────────

describe("TopstepRealtimeAdapter — reconnect cap and cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the loop and enters cooldown after the attempt cap", async () => {
    const statuses: Array<[boolean, string | undefined]> = [];
    adapter.onStatus((connected, reason) => statuses.push([connected, reason]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));

    // The cap is checked before incrementing, so it takes cap+1 ticks.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(
      statuses.some(([connected, reason]) => !connected && reason?.includes("reconnect cap reached")),
    ).toBe(true);

    const startsBefore = hub.starts;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hub.starts).toBe(startsBefore);
    warn.mockRestore();
  });

  it("makes no more than the capped number of reconnect attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));
    const startsAfterConnect = hub.starts;
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));

    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(hub.starts - startsAfterConnect).toBeLessThanOrEqual(5);
    warn.mockRestore();
  });

  it("does not burn reconnects once nobody wants the hub", async () => {
    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));

    await adapter.sync(new Set());
    const startsBefore = hub.starts;
    await vi.advanceTimersByTimeAsync(30_000 * 3);

    expect(hub.starts).toBe(startsBefore);
  });

  it("resets the attempt count after a sustained connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));

    hub.startImpl = () => Promise.reject(new Error("down"));
    hub.closeHandler?.(new Error("closed"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectLoopAttempts).toBeGreaterThan(0);

    hub.startImpl = async () => {};
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectLoopAttempts).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectCooldownUntil).toBe(0);
    warn.mockRestore();
  });

  it("clears the sustained-reset timer on teardown, not just on close", async () => {
    await adapter.sync(new Set([1001]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectResetTimer).not.toBeNull();

    // A 1-hour timeout surviving teardown holds the event loop open.
    await adapter.sync(new Set());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectResetTimer).toBeNull();
  });

  it("cancels the sustained-reset timer when the hub closes before the window elapses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).reconnectLoopAttempts = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectResetTimer).not.toBeNull();

    // Release every holder so the reconnect loop self-clears on its first
    // tick instead of incrementing the count during the 1h advance.
    await adapter.sync(new Set());
    hub.closeHandler?.();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectResetTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectLoopAttempts).toBe(3);
    warn.mockRestore();
  });
});

// ── Market closed: no retries until the reopen ────────────────────────────

describe("TopstepRealtimeAdapter — market closed", () => {
  let reopen: Date | null;
  let records: LogRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    reopen = null;
    adapter = new TopstepRealtimeAdapter(hub, (now) =>
      reopen && now < reopen ? reopen : null,
    );
    records = [];
    setLogSink({ write: (r) => void records.push(r), bump: () => {} });
  });

  afterEach(() => {
    setLogSink(null);
    vi.useRealTimers();
  });

  const closeFor = (ms: number) => {
    reopen = new Date(Date.now() + ms);
  };

  it("makes no attempts after a close while the market is shut, then reconnects at the reopen", async () => {
    await adapter.sync(new Set([1001]));
    const startsBefore = hub.starts;
    closeFor(16 * 60 * 60 * 1000);
    hub.closeHandler?.(new Error("connection closed"));

    // Past the reopen but inside the grace the engine's auto-heal goes first.
    await vi.advanceTimersByTimeAsync(16 * 60 * 60 * 1000 + 14_000);
    expect(hub.starts).toBe(startsBefore);
    expect(records.filter((r) => r.event === "ws_reconnect_suppressed")).toHaveLength(0);
    expect(records.filter((r) => r.event === "ws_reconnect_deferred")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(hub.starts).toBe(startsBefore + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).started).toBe(true);
  });

  it("gives the reopen a fresh attempt budget even if the cap was hit before the close", async () => {
    await adapter.sync(new Set([1001]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = adapter as any;
    priv.reconnectLoopAttempts = 5;
    priv.reconnectCooldownUntil = Date.now() + 2 * 60 * 60 * 1000;
    closeFor(60 * 60 * 1000);
    hub.closeHandler?.(new Error("connection closed"));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(priv.started).toBe(true);
    expect(priv.reconnectCooldownUntil).toBe(0);
  });

  it("stops a running loop when the market closes under it", async () => {
    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));
    await vi.advanceTimersByTimeAsync(30_000);
    const startsBefore = hub.starts;

    closeFor(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(30_000 * 10);
    expect(hub.starts).toBe(startsBefore);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectInterval).toBeNull();
  });

  it("does not start a down hub on a reconcile while shut, but keeps subscribing on a live one", async () => {
    closeFor(60 * 60 * 1000);
    await adapter.sync(new Set([1001]));
    expect(hub.starts).toBe(0);

    reopen = null;
    await adapter.sync(new Set([1001]));
    closeFor(60 * 60 * 1000);
    await adapter.sync(new Set([1001, 1002]));
    expect(hub.subscribed).toContain(1002);
  });

  it("falls back to the 30s loop when the reopen attempt fails", async () => {
    await adapter.sync(new Set([1001]));
    closeFor(60 * 60 * 1000);
    hub.startImpl = () => Promise.reject(new Error("gateway still down"));
    hub.closeHandler?.(new Error("connection closed"));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    const startsAtReopen = hub.starts;
    hub.startImpl = async () => {};
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hub.starts).toBe(startsAtReopen + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).started).toBe(true);
  });

  it("keeps the loop when a reconnect is accepted and then closed before its subscriptions land", async () => {
    await adapter.sync(new Set([1001]));
    hub.subscribeImpl = async () => {
      hub.closeHandler?.();
      throw new Error("Invocation canceled due to the underlying connection being closed.");
    };
    hub.closeHandler?.(new Error("connection closed"));
    await vi.advanceTimersByTimeAsync(30_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = adapter as any;
    expect(priv.started).toBe(false);
    expect(priv.reconnectInterval).not.toBeNull();

    hub.subscribeImpl = async () => {};
    await vi.advanceTimersByTimeAsync(30_000);
    expect(priv.started).toBe(true);
  });

  it("retries at the end of a cap's cooldown with no further close", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(30_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = adapter as any;
    expect(priv.reconnectCooldownUntil).toBeGreaterThan(Date.now());

    hub.startImpl = async () => {};
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(priv.started).toBe(true);
    warn.mockRestore();
  });

  it("clears the resume timer on shutdown", async () => {
    await adapter.sync(new Set([1001]));
    closeFor(60 * 60 * 1000);
    hub.closeHandler?.(new Error("connection closed"));
    adapter.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).resumeTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TopstepRealtimeAdapter — forceReconnect", () => {
  it("drops the hub and rebuilds it with handlers re-registered pre-start", async () => {
    await adapter.sync(new Set([1001]));
    hub.subscribed.length = 0;

    await adapter.forceReconnect();

    expect(hub.stops).toBe(1);
    expect(hub.builds).toBe(2);
    expect(hub.starts).toBe(2);
    expect(hub.positionHandler).not.toBeNull();
    expect(hub.subscribed).toEqual([1001]);
  });

  it("propagates a failure to start so the caller can alert", async () => {
    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("still displaced"));

    await expect(adapter.forceReconnect()).rejects.toThrow("still displaced");
  });
});

describe("TopstepRealtimeAdapter — A79 recovery", () => {
  let records: LogRecord[];

  beforeEach(() => {
    records = [];
    setLogSink({ write: (r) => void records.push(r), bump: () => {} });
  });

  afterEach(() => {
    setLogSink(null);
    adapter.shutdown();
    vi.useRealTimers();
  });

  const closeLines = () =>
    records.filter((r) => r.event === "ws_disconnected" || r.event === "ws_session_displaced");

  it("logs every close with its reason — the error's message, or no error given", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));

    hub.closeHandler?.(new Error("WebSocket closed with status code: 1006"));
    expect(closeLines()).toHaveLength(1);
    expect(closeLines()[0].message).toContain("WebSocket closed with status code: 1006");

    await adapter.sync(new Set([1001, 1002]));
    hub.closeHandler?.();
    expect(closeLines()).toHaveLength(2);
    expect(closeLines()[1].event).toBe("ws_disconnected");
    expect(closeLines()[1].message).toContain("no error given");
    vi.mocked(console.warn).mockRestore();
  });

  it("A79: logs a drop into Reconnecting once, with the error's message", async () => {
    await adapter.sync(new Set([1001]));

    hub.reconnectingHandler?.(new Error("WebSocket closed with status code: 1006"));

    expect(closeLines()).toHaveLength(1);
    expect(closeLines()[0].event).toBe("ws_disconnected");
    expect(closeLines()[0].message).toContain("WebSocket closed with status code: 1006");
  });

  it("A79: logs a drop into Reconnecting with no error as no error given", async () => {
    await adapter.sync(new Set([1001]));

    hub.reconnectingHandler?.();

    expect(closeLines()).toHaveLength(1);
    expect(closeLines()[0].message).toContain("no error given");
  });

  it("A79: a close caused by its own stop() in forceReconnect is not logged and does not arm the loop", async () => {
    vi.useFakeTimers();
    await adapter.sync(new Set([1001]));
    hub.closeOnStop = true;

    await adapter.forceReconnect();
    const startsAfter = hub.starts;
    await vi.advanceTimersByTimeAsync(90_000);

    expect(closeLines()).toHaveLength(0);
    expect(records.some((r) => r.event === "ws_reconnect_suppressed")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectInterval).toBeNull();
    expect(hub.starts).toBe(startsAfter);
  });

  it("A79: a close caused by its own stop() when the last holder leaves is not logged and does not arm the loop", async () => {
    await adapter.sync(new Set([1001]));
    hub.closeOnStop = true;

    await adapter.sync(new Set());

    expect(hub.stops).toBe(1);
    expect(closeLines()).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectInterval).toBeNull();
  });

  it("A79: a real close after its own stop is logged again", async () => {
    await adapter.sync(new Set([1001]));
    hub.closeOnStop = true;
    await adapter.forceReconnect();

    hub.closeHandler?.(new Error("connection lost"));

    expect(closeLines()).toHaveLength(1);
    expect(closeLines()[0].message).toContain("connection lost");
  });

  it("logs a displacement close once, carrying the close's own reason too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));

    hub.gatewayLogoutHandler?.("Multiple sessions detected.");
    hub.closeHandler?.(new Error("Server returned an error on close"));

    expect(closeLines()).toHaveLength(1);
    expect(closeLines()[0].event).toBe("ws_session_displaced");
    expect(closeLines()[0].message).toContain("Server returned an error on close");
    vi.mocked(console.warn).mockRestore();
  });

  it("rejects a forceReconnect whose start resolves and then closes before the subscribes land", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));
    hub.subscribeImpl = async () => {
      hub.closeHandler?.();
      throw new Error("Invocation canceled due to the underlying connection being closed.");
    };

    await expect(adapter.forceReconnect()).rejects.toThrow("closed right after start");
    vi.mocked(console.warn).mockRestore();
  });

  it("rejects a forceReconnect whose hub is up but whose subscribes did not land", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));
    hub.subscribeImpl = () => Promise.reject(new Error("invoke timed out"));

    await expect(adapter.forceReconnect()).rejects.toThrow("did not land: 1001");
    vi.mocked(console.warn).mockRestore();
  });

  it("gives the loop a fresh attempt budget once the cooldown has run out", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.sync(new Set([1001]));
    hub.startImpl = () => Promise.reject(new Error("hub down"));
    hub.closeHandler?.(new Error("connection closed"));

    // Five attempts, then the sixth tick trips the cap into cooldown.
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(30_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cooldownUntil = (adapter as any).reconnectCooldownUntil as number;
    expect(cooldownUntil).toBeGreaterThan(Date.now());

    // Past the cooldown, the next close restarts the loop. Before the fix the
    // count still sat at the cap and this tick re-entered a fresh cooldown
    // without a single attempt.
    vi.setSystemTime(cooldownUntil + 1);
    const startsBefore = hub.starts;
    hub.closeHandler?.(new Error("connection closed"));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(hub.starts).toBe(startsBefore + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).reconnectCooldownUntil).toBe(0);
    vi.mocked(console.warn).mockRestore();
  });
});

describe("TopstepRealtimeAdapter — health", () => {
  it("reports unhealthy for an account it is not streaming", async () => {
    await adapter.sync(new Set([1001]));
    expect(adapter.isHealthy(2002)).toBe(false);
    expect(adapter.status(2002)).toBeNull();
  });

  it("counts a fresh subscribe as healthy before the first inbound event", async () => {
    await adapter.sync(new Set([1001]));
    expect(adapter.isHealthy(1001)).toBe(true);
  });

  it("goes unhealthy once the feed is silent past the window", async () => {
    await adapter.sync(new Set([1001]));
    expect(adapter.isHealthy(1001, Date.now() + 60_000)).toBe(false);
  });

  it("goes unhealthy the moment the hub closes", async () => {
    await adapter.sync(new Set([1001]));
    hub.closeHandler?.(new Error("closed"));
    expect(adapter.isHealthy(1001)).toBe(false);
  });
});
