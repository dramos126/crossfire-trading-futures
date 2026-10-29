import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TradovateRealtimeAdapter,
  type TradovateRealtimeAdapterDeps,
  type TradovateSubscriber,
} from "./realtime-adapter";
import type { TradovateClient } from "./client";
import type { TradovateRealtimeOptions } from "./realtime";
import type {
  Order,
  Position,
  RealtimeStatusSnapshot,
  TradeFill,
} from "@/lib/brokers/types";

/**
 * Fake per-account subscriber. Tradovate's socket is untestable here (see
 * docs/modules/testing/patterns.md); the adapter's spawn/dispose
 * bookkeeping, the pre-warm ordering, the health gate and the
 * dated-symbol bridge are not, and they run against this.
 */
class FakeSubscriber implements TradovateSubscriber {
  started = 0;
  disposed = 0;
  startImpl: () => Promise<void> = async () => {};
  snapshot: RealtimeStatusSnapshot = {
    state: "subscribed",
    lastEventAt: 0,
    subscribedAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };
  positionHandler: ((accountId: number, position: Position) => void) | null = null;
  orderHandler: ((accountId: number, order: Order) => void) | null = null;
  fillHandler: ((accountId: number, fill: TradeFill) => void) | null = null;
  reconnectHandler: ((accountId: number, lastEventAtBeforeReconnect: number) => void) | null = null;
  subscribedHandler: ((accountId: number) => void) | null = null;

  constructor(
    readonly accountId: number,
    readonly opts: TradovateRealtimeOptions,
  ) {}

  async start(): Promise<void> {
    this.started++;
    await this.startImpl();
  }
  dispose(): void {
    this.disposed++;
  }
  status(): RealtimeStatusSnapshot {
    return this.snapshot;
  }
  onPosition(h: (accountId: number, position: Position) => void): void {
    this.positionHandler = h;
  }
  onOrder(h: (accountId: number, order: Order) => void): void {
    this.orderHandler = h;
  }
  onFill(h: (accountId: number, fill: TradeFill) => void): void {
    this.fillHandler = h;
  }
  onReconnect(h: (accountId: number, lastEventAtBeforeReconnect: number) => void): void {
    this.reconnectHandler = h;
  }
  onSubscribed(h: (accountId: number) => void): void {
    this.subscribedHandler = h;
  }

  /** The authorize ack: every inbound frame has already bumped
   *  `lastEventAt` by the time the subscribe hooks run. */
  subscribe(at: number): void {
    this.snapshot = { ...this.snapshot, state: "subscribed", lastEventAt: at, subscribedAt: at };
    this.subscribedHandler?.(this.accountId);
  }
}

interface ClientDouble {
  getUserId: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
  needsRefresh: ReturnType<typeof vi.fn>;
  validateSession: ReturnType<typeof vi.fn>;
  getTokenExpiresAt: ReturnType<typeof vi.fn>;
  getDatedSymbolForContractId: ReturnType<typeof vi.fn>;
  warmContractId: ReturnType<typeof vi.fn>;
  warmContractIdsForRoots: ReturnType<typeof vi.fn>;
}

interface Harness {
  adapter: TradovateRealtimeAdapter;
  subs: Map<number, FakeSubscriber>;
  /** The client the harness starts on. */
  client: ClientDouble;
  logs: Array<[string, string]>;
  order: string[];
  setClient: (present: boolean) => void;
  /** A credential save: the plugin's `invalidate()` + `initialize()` hand
   *  the engine a new `TradovateClient` instance. Returns it. */
  rotateClient: (token: string) => ClientDouble;
  roots: string[];
  resolverLookup: ReturnType<typeof vi.fn>;
  failStartFor: Set<number>;
}

function makeHarness(): Harness {
  const subs = new Map<number, FakeSubscriber>();
  const logs: Array<[string, string]> = [];
  const order: string[] = [];
  const roots: string[] = [];
  const failStartFor = new Set<number>();
  let clientPresent = true;

  const makeClient = (token: string): ClientDouble => ({
    getUserId: vi.fn(() => 4242),
    getToken: vi.fn(() => token),
    needsRefresh: vi.fn(() => false),
    validateSession: vi.fn(async () => {}),
    getTokenExpiresAt: vi.fn(() => Date.now() + 60_000),
    getDatedSymbolForContractId: vi.fn(() => null),
    warmContractId: vi.fn(async () => {}),
    warmContractIdsForRoots: vi.fn(async () => {
      order.push(`warm:${token}`);
    }),
  });
  const client = makeClient("tok");
  let current = client;

  const resolverLookup = vi.fn(() => null);

  const deps: TradovateRealtimeAdapterDeps = {
    getClient: () => (clientPresent ? (current as unknown as TradovateClient) : null),
    resolverSymbolLookup: resolverLookup,
    enumerateWarmRoots: () => [...roots],
    log: (level, message) => logs.push([level, message]),
    createSubscriber: (opts) => {
      const sub = new FakeSubscriber(opts.accountId, opts);
      if (failStartFor.has(opts.accountId)) {
        sub.startImpl = () => Promise.reject(new Error("socket refused"));
      }
      order.push(`spawn:${opts.accountId}`);
      subs.set(opts.accountId, sub);
      return sub;
    },
  };

  return {
    adapter: new TradovateRealtimeAdapter(deps),
    subs,
    client,
    logs,
    order,
    roots,
    resolverLookup,
    failStartFor,
    setClient: (present: boolean) => {
      clientPresent = present;
    },
    rotateClient: (token: string) => {
      current = makeClient(token);
      return current;
    },
  };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

describe("TradovateRealtimeAdapter — subscriber lifecycle", () => {
  it("spawns one subscriber per account in the desired set and starts each", async () => {
    await h.adapter.sync(new Set([2001, 2002]));

    expect([...h.subs.keys()].sort()).toEqual([2001, 2002]);
    expect(h.subs.get(2001)!.started).toBe(1);
    expect(h.subs.get(2002)!.started).toBe(1);
  });

  it("is idempotent — a repeat sync does not respawn", async () => {
    await h.adapter.sync(new Set([2001]));
    const first = h.subs.get(2001)!;
    await h.adapter.sync(new Set([2001]));

    expect(h.subs.get(2001)).toBe(first);
    expect(first.started).toBe(1);
    expect(first.disposed).toBe(0);
  });

  it("disposes only the accounts that left the set", async () => {
    await h.adapter.sync(new Set([2001, 2002]));
    const leaving = h.subs.get(2001)!;
    const staying = h.subs.get(2002)!;

    await h.adapter.sync(new Set([2002]));

    expect(leaving.disposed).toBe(1);
    expect(staying.disposed).toBe(0);
    expect(h.adapter.status(2001)).toBeNull();
    expect(h.adapter.status(2002)).not.toBeNull();
  });

  it("disposes everything when the client is removed, without waiting for a smaller set", async () => {
    await h.adapter.sync(new Set([2001, 2002]));
    const subs = [h.subs.get(2001)!, h.subs.get(2002)!];

    h.setClient(false);
    await h.adapter.sync(new Set([2001, 2002]));

    expect(subs.every((s) => s.disposed === 1)).toBe(true);
    expect(h.adapter.status(2001)).toBeNull();
  });

  it("spawns nothing before the client has a userId", async () => {
    h.client.getUserId.mockReturnValue(null);
    await h.adapter.sync(new Set([2001]));
    expect(h.subs.size).toBe(0);
  });

  it("still prunes departed subscribers when the client has lost its userId", async () => {
    // `engine.stop()` → `sync(new Set())` at an instant where auth has
    // been invalidated. Disposal needs no userId — only spawn does — so a
    // return above the prune leaves every socket open with its heartbeat
    // and reconnect timers in a process that runs 24/7.
    await h.adapter.sync(new Set([2001, 2002]));
    h.client.getUserId.mockReturnValue(null);

    await h.adapter.sync(new Set());

    expect(h.subs.get(2001)!.disposed).toBe(1);
    expect(h.subs.get(2002)!.disposed).toBe(1);
    expect(h.adapter.status(2001)).toBeNull();
  });

  it("prunes without spawning when the userId goes away mid-set", async () => {
    await h.adapter.sync(new Set([2001]));
    h.client.getUserId.mockReturnValue(null);

    await h.adapter.sync(new Set([2002]));

    expect(h.subs.get(2001)!.disposed).toBe(1);
    expect(h.subs.has(2002)).toBe(false);
  });

  it("warms the contract cache before the first spawn", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001]));
    expect(h.order).toEqual(["warm:tok", "spawn:2001"]);
  });

  it("skips a re-warm when the root set has not changed", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001]));
    await h.adapter.sync(new Set([2001, 2002]));
    expect(h.client.warmContractIdsForRoots).toHaveBeenCalledTimes(1);
  });

  it("re-warms when a new root appears", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001]));
    h.roots.push("MES");
    await h.adapter.sync(new Set([2001, 2002]));
    expect(h.client.warmContractIdsForRoots).toHaveBeenCalledTimes(2);
  });

  it("spawns anyway when the warm throws", async () => {
    h.roots.push("MNQ");
    h.client.warmContractIdsForRoots.mockRejectedValue(new Error("suggest failed"));
    await h.adapter.sync(new Set([2001]));
    expect(h.subs.has(2001)).toBe(true);
  });

  it("isolates a failed start: the other account still comes up, and it warns", async () => {
    h.failStartFor.add(2001);

    await expect(h.adapter.sync(new Set([2001, 2002]))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.subs.get(2002)!.started).toBe(1);
    expect(
      h.logs.some(
        ([level, message]) =>
          level === "warn" && message.includes("start failed for account 2001"),
      ),
    ).toBe(true);
  });

  it("does not prune another holder's pin when the engine's sync shrinks", async () => {
    await h.adapter.sync(new Set([2001]));
    await h.adapter.connect(2002);

    await h.adapter.sync(new Set());

    expect(h.subs.get(2001)!.disposed).toBe(1);
    expect(h.subs.get(2002)!.disposed).toBe(0);
  });

  it("serialises an interleaved sync so a spawn and its dispose keep set order", async () => {
    // The pre-warm is the await two overlapping reconciles cross. Without
    // the mutex the second run computes `want` and disposes before the
    // first has spawned, so the spawn lands after the dispose and the
    // subscriber survives with nobody wanting it.
    h.roots.push("MNQ");
    let releaseWarm: () => void = () => {};
    h.client.warmContractIdsForRoots.mockImplementation(
      () => new Promise<void>((r) => { releaseWarm = () => r(); }),
    );

    const add = h.adapter.sync(new Set([2001]));
    await new Promise((r) => setTimeout(r, 0));
    const remove = h.adapter.sync(new Set());
    releaseWarm();
    await Promise.all([add, remove]);

    expect(h.subs.get(2001)?.disposed ?? 0).toBe(1);
    expect(h.adapter.status(2001)).toBeNull();
  });

  it("is a no-op when disconnecting an unknown account", async () => {
    await h.adapter.sync(new Set([2001]));
    h.adapter.disconnect(9999);
    await Promise.resolve();
    expect(h.subs.get(2001)!.disposed).toBe(0);
  });

  it("shutdown disposes every subscriber exactly once", async () => {
    await h.adapter.sync(new Set([2001]));
    await h.adapter.connect(2002);

    h.adapter.shutdown();
    h.adapter.shutdown();

    expect(h.subs.get(2001)!.disposed).toBe(1);
    expect(h.subs.get(2002)!.disposed).toBe(1);
  });
});

// A credential save hands the engine a new `TradovateClient` instance. Each
// subscriber closes over the client it was spawned with for its token and its
// numeric-to-dated lookup, so the feed has to be rebuilt on the new one.
describe("TradovateRealtimeAdapter — client replaced", () => {
  it("attaches once on the first reconcile, disposing nothing", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001]));

    expect(h.order).toEqual(["warm:tok", "spawn:2001"]);
    expect(h.subs.get(2001)!.disposed).toBe(0);
    expect(h.subs.get(2001)!.started).toBe(1);
  });

  it("keeps every subscriber and skips the pre-warm when the client is the same instance", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001, 2002]));
    const before = [h.subs.get(2001)!, h.subs.get(2002)!];

    await h.adapter.sync(new Set([2001, 2002]));

    expect([h.subs.get(2001), h.subs.get(2002)]).toEqual(before);
    expect(before.every((s) => s.disposed === 0)).toBe(true);
    expect(h.client.warmContractIdsForRoots).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["warm:tok", "spawn:2001", "spawn:2002"]);
  });

  it("disposes the old subscribers, pre-warms the new client and attaches on it", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001, 2002]));
    const old = [h.subs.get(2001)!, h.subs.get(2002)!];

    const rotated = h.rotateClient("tok2");
    rotated.getDatedSymbolForContractId.mockReturnValue("MNQZ6");
    await h.adapter.sync(new Set([2001, 2002]));

    expect(old.every((s) => s.disposed === 1)).toBe(true);
    const fresh = h.subs.get(2001)!;
    expect(old).not.toContain(fresh);
    expect(fresh.started).toBe(1);
    // The roots did not change; the warm runs because the client did.
    expect(rotated.warmContractIdsForRoots).toHaveBeenCalledWith(["MNQ"]);
    expect(h.order.slice(3)).toEqual(["warm:tok2", "spawn:2001", "spawn:2002"]);
    await expect(fresh.opts.getAccessToken()).resolves.toBe("tok2");
    expect(fresh.opts.getDatedSymbol?.(4799969)).toBe("MNQZ6");
    expect(h.client.getDatedSymbolForContractId).not.toHaveBeenCalled();
  });

  it("drops the old feed even when the new client has no userId yet", async () => {
    await h.adapter.sync(new Set([2001]));
    const old = h.subs.get(2001)!;

    h.rotateClient("tok2").getUserId.mockReturnValue(null);
    await h.adapter.sync(new Set([2001]));

    expect(old.disposed).toBe(1);
    expect(h.adapter.status(2001)).toBeNull();
  });

  it("settles after a rotation: the next reconcile on the new client is a no-op", async () => {
    h.roots.push("MNQ");
    await h.adapter.sync(new Set([2001]));
    const rotated = h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    const fresh = h.subs.get(2001)!;

    await h.adapter.sync(new Set([2001]));

    expect(h.subs.get(2001)).toBe(fresh);
    expect(fresh.disposed).toBe(0);
    expect(rotated.warmContractIdsForRoots).toHaveBeenCalledTimes(1);
  });
});

// The replacement subscriber is a new instance, so its first subscribe is a
// first connection and never a reconnect; the adapter fires the hook itself so
// the engine's missed-fills replay covers the old socket's close to the new
// one's subscribe.
describe("TradovateRealtimeAdapter — rotation replay", () => {
  const T0 = 1_800_000_000_000;
  const GAP_MS = 2_500;

  /** The gap's lower bound rides the reconnect signal — the engine's replay
   *  windows `[lastEventAtBeforeReconnect, now + pad]` off it, no `status()`
   *  read. */
  function recordReplayAnchors(): Array<{ accountId: number; anchor: number | undefined }> {
    const anchors: Array<{ accountId: number; anchor: number | undefined }> = [];
    h.adapter.onReconnect((accountId, lastEventAtBeforeReconnect) => {
      anchors.push({ accountId, anchor: lastEventAtBeforeReconnect });
    });
    return anchors;
  }

  it("fires the hook once per replaced account, only after its new subscriber connects", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001, 2002]));
    h.subs.get(2001)!.subscribe(T0);
    h.subs.get(2002)!.subscribe(T0);

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001, 2002]));
    expect(anchors).toEqual([]);

    h.subs.get(2001)!.subscribe(T0 + GAP_MS);
    expect(anchors.map((a) => a.accountId)).toEqual([2001]);
    h.subs.get(2002)!.subscribe(T0 + GAP_MS);
    expect(anchors.map((a) => a.accountId)).toEqual([2001, 2002]);

    // A later resubscribe on the same instance is not this rotation's.
    h.subs.get(2001)!.subscribe(T0 + 2 * GAP_MS);
    expect(anchors).toHaveLength(2);
  });

  it("anchors the replay at the old feed's last event, so a fill inside the gap is in the window", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);
    const fillAt = T0 + GAP_MS / 2;

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    const fresh = h.subs.get(2001)!;
    fresh.subscribe(T0 + GAP_MS);

    expect(anchors).toEqual([{ accountId: 2001, anchor: T0 }]);
    expect(anchors[0].anchor!).toBeLessThanOrEqual(fillAt);
    // The signal carries the anchor; `status()` is the subscriber's own,
    // already bumped to the new socket's handshake.
    expect(h.adapter.status(2001)?.lastEventAt).toBe(T0 + GAP_MS);
  });

  it("fires nothing on a first boot", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);

    expect(anchors).toEqual([]);
  });

  it("fires nothing for an account that left the set before the respawn", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001, 2002]));
    h.subs.get(2001)!.subscribe(T0);
    h.subs.get(2002)!.subscribe(T0);

    const rotated = h.rotateClient("tok2");
    rotated.getUserId.mockReturnValue(null);
    await h.adapter.sync(new Set([2001, 2002]));
    await h.adapter.sync(new Set([2002]));
    rotated.getUserId.mockReturnValue(4242);
    // 2001 comes back as a plain addition, not as the rotation's.
    await h.adapter.sync(new Set([2001, 2002]));
    h.subs.get(2001)!.subscribe(T0 + GAP_MS);
    h.subs.get(2002)!.subscribe(T0 + GAP_MS);

    expect(anchors.map((a) => a.accountId)).toEqual([2002]);
  });

  it("still fires when a respawn held back by a null userId finally happens", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);

    const rotated = h.rotateClient("tok2");
    rotated.getUserId.mockReturnValue(null);
    await h.adapter.sync(new Set([2001]));
    expect(h.adapter.status(2001)).toBeNull();

    rotated.getUserId.mockReturnValue(4242);
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0 + GAP_MS);

    expect(anchors).toEqual([{ accountId: 2001, anchor: T0 }]);
  });

  it("keeps the first anchor when a second rotation lands before the first respawn subscribed", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    // The first respawn has had a frame but has not subscribed yet.
    h.subs.get(2001)!.snapshot = { ...h.subs.get(2001)!.snapshot, state: "authorizing", lastEventAt: T0 + GAP_MS };
    h.rotateClient("tok3");
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0 + 2 * GAP_MS);

    expect(anchors).toEqual([{ accountId: 2001, anchor: T0 }]);
  });

  it("forgets the rotation when the client is removed before the respawn subscribed", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    h.setClient(false);
    await h.adapter.sync(new Set([2001]));
    h.setClient(true);
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0 + GAP_MS);

    expect(anchors).toEqual([]);
  });

  it("forgets the rotation on shutdown", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0);

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    h.adapter.shutdown();
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0 + GAP_MS);

    expect(anchors).toEqual([]);
  });

  it("fires nothing when the old feed never received a frame", async () => {
    const anchors = recordReplayAnchors();
    await h.adapter.sync(new Set([2001]));

    h.rotateClient("tok2");
    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.subscribe(T0 + GAP_MS);

    expect(anchors).toEqual([]);
  });
});

describe("TradovateRealtimeAdapter — event fan-out", () => {
  it("passes the subscriber's accountId through to every handler", async () => {
    const positions: Array<[number, Position]> = [];
    const orders: Array<[number, Order]> = [];
    const fills: Array<[number, TradeFill]> = [];
    const reconnects: number[] = [];
    h.adapter.onPosition((id, p) => positions.push([id, p]));
    h.adapter.onOrder((id, o) => orders.push([id, o]));
    h.adapter.onFill((id, f) => fills.push([id, f]));
    h.adapter.onReconnect((id) => reconnects.push(id));

    await h.adapter.sync(new Set([2001]));
    const sub = h.subs.get(2001)!;
    const position = { contractId: "MNQM6", size: 2 } as Position;
    const order = { id: 7 } as Order;
    const fill = { id: 8 } as TradeFill;

    sub.positionHandler?.(2001, position);
    sub.orderHandler?.(2001, order);
    sub.fillHandler?.(2001, fill);
    sub.reconnectHandler?.(2001, 0);

    expect(positions).toEqual([[2001, position]]);
    expect(orders).toEqual([[2001, order]]);
    expect(fills).toEqual([[2001, fill]]);
    expect(reconnects).toEqual([2001]);
  });

  it("does not let one throwing handler starve the others", async () => {
    const seen: string[] = [];
    h.adapter.onPosition(() => {
      throw new Error("listener blew up");
    });
    h.adapter.onPosition(() => seen.push("second"));

    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.positionHandler?.(2001, { contractId: "MNQM6" } as Position);

    expect(seen).toEqual(["second"]);
    expect(
      h.logs.some(
        ([level, message]) =>
          level === "warn" && message.includes("position handler threw for account 2001"),
      ),
    ).toBe(true);
  });

  it("isolates a throwing handler on every event kind, reconnect included", async () => {
    const seen: string[] = [];
    for (const register of [
      h.adapter.onOrder.bind(h.adapter),
      h.adapter.onFill.bind(h.adapter),
    ]) {
      register(() => {
        throw new Error("boom");
      });
    }
    h.adapter.onOrder(() => seen.push("order"));
    h.adapter.onFill(() => seen.push("fill"));
    h.adapter.onReconnect(() => {
      throw new Error("boom");
    });
    h.adapter.onReconnect(() => seen.push("reconnect"));

    await h.adapter.sync(new Set([2001]));
    const sub = h.subs.get(2001)!;
    sub.orderHandler?.(2001, { id: 7 } as Order);
    sub.fillHandler?.(2001, { id: 8 } as TradeFill);
    sub.reconnectHandler?.(2001, 0);

    expect(seen).toEqual(["order", "fill", "reconnect"]);
  });

  it("fans out to handlers registered before the subscriber existed", async () => {
    const seen: number[] = [];
    h.adapter.onPosition((id) => seen.push(id));

    await h.adapter.sync(new Set([2001]));
    h.subs.get(2001)!.positionHandler?.(2001, { contractId: "MNQM6" } as Position);

    expect(seen).toEqual([2001]);
  });
});

describe("TradovateRealtimeAdapter — health gate", () => {
  function armSubscriber(sub: FakeSubscriber, snapshot: Partial<RealtimeStatusSnapshot>): void {
    sub.snapshot = { ...sub.snapshot, ...snapshot };
  }

  it("is unhealthy for an account with no subscriber", () => {
    expect(h.adapter.isHealthy(2001)).toBe(false);
  });

  it("is unhealthy while the subscriber is not subscribed", async () => {
    await h.adapter.sync(new Set([2001]));
    armSubscriber(h.subs.get(2001)!, { state: "reconnecting", lastEventAt: Date.now() });
    expect(h.adapter.isHealthy(2001)).toBe(false);
  });

  it("is unhealthy before any anchor exists", async () => {
    await h.adapter.sync(new Set([2001]));
    armSubscriber(h.subs.get(2001)!, { lastEventAt: 0, subscribedAt: null });
    expect(h.adapter.isHealthy(2001)).toBe(false);
  });

  it("counts a fresh subscribe as healthy before the first inbound frame", async () => {
    const now = Date.now();
    await h.adapter.sync(new Set([2001]));
    armSubscriber(h.subs.get(2001)!, { lastEventAt: 0, subscribedAt: now });
    expect(h.adapter.isHealthy(2001, now + 1_000)).toBe(true);
  });

  it("goes unhealthy once the anchor is past the 30s window", async () => {
    const now = Date.now();
    await h.adapter.sync(new Set([2001]));
    armSubscriber(h.subs.get(2001)!, { lastEventAt: now, subscribedAt: now });
    expect(h.adapter.isHealthy(2001, now + 30_001)).toBe(false);
    expect(h.adapter.isHealthy(2001, now + 30_000)).toBe(true);
  });
});

describe("TradovateRealtimeAdapter — resolveDatedSymbol", () => {
  it("returns a non-numeric string unchanged without touching the client", () => {
    expect(h.adapter.resolveDatedSymbol("MNQM6")).toBe("MNQM6");
    expect(h.client.getDatedSymbolForContractId).not.toHaveBeenCalled();
  });

  it("returns the client's cache hit", () => {
    h.client.getDatedSymbolForContractId.mockReturnValue("MNQM6");
    expect(h.adapter.resolveDatedSymbol("4799969")).toBe("MNQM6");
  });

  it("falls through to the resolver cache on a client miss", () => {
    h.client.getDatedSymbolForContractId.mockReturnValue(null);
    h.resolverLookup.mockReturnValue("MESM6");
    expect(h.adapter.resolveDatedSymbol("4799969")).toBe("MESM6");
  });

  it("warms and returns the numeric string on a total miss", () => {
    h.client.getDatedSymbolForContractId.mockReturnValue(null);
    h.resolverLookup.mockReturnValue(null);
    expect(h.adapter.resolveDatedSymbol("4799969")).toBe("4799969");
    expect(h.client.warmContractId).toHaveBeenCalledWith(4799969);
  });

  it("returns the input unchanged when Tradovate is not configured", () => {
    h.setClient(false);
    expect(h.adapter.resolveDatedSymbol("4799969")).toBe("4799969");
  });
});
