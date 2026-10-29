import type { BrokerRealtimeAdapter } from "@/lib/brokers/plugin";
import type {
  Order,
  Position,
  RealtimeStatusSnapshot,
  TradeFill,
} from "@/lib/brokers/types";
import type { TradovateClient } from "./client";
import { TradovateRealtime, type TradovateRealtimeOptions } from "./realtime";

/**
 * Tradovate's account-event adapter.
 *
 * Tradovate is genuinely per-account — one WebSocket each — so the
 * account-keyed `BrokerRealtimeAdapter` maps onto it directly, with none
 * of the ref-counting Topstep's shared hub needs. What this class does
 * carry is everything the engine used to: the `Map<accountId,
 * TradovateRealtime>`, the spawn path and its options bag, the
 * contract-cache pre-warm, the health gate, and the numeric→dated-symbol
 * bridge.
 *
 * Account events only. Tradovate can technically serve market data but
 * its entitlement will never be bought (operator decision, 2026-08-22 —
 * dearer than Databento Pro), so there is no `TradovateMarketDataProvider`
 * and nothing here subscribes to a tape.
 */

/** Health window for the engine's polling-fallback gate. */
const TRADOVATE_WS_HEALTHY_MS = 30_000;

/** The subset of `TradovateRealtime` the adapter drives. Injectable so
 *  the adapter's lifecycle, health and fan-out are testable without a
 *  socket. */
export interface TradovateSubscriber {
  start(): Promise<void>;
  dispose(): void;
  status(): RealtimeStatusSnapshot;
  onPosition(handler: (accountId: number, position: Position) => void): void;
  onOrder(handler: (accountId: number, order: Order) => void): void;
  onFill(handler: (accountId: number, fill: TradeFill) => void): void;
  onReconnect(handler: (accountId: number, lastEventAtBeforeReconnect: number) => void): void;
  onSubscribed(handler: (accountId: number) => void): void;
}

export interface TradovateRealtimeAdapterDeps {
  /** Current REST client, or null when Tradovate is unconfigured. Read
   *  at call time — `reloadTradovateClients()` hot-swaps it, and a
   *  freshly-nulled client must dispose every live subscriber. */
  getClient: () => TradovateClient | null;
  /** Resolver-side half of the numeric→dated-symbol bridge, consulted
   *  after the client's own cache. */
  resolverSymbolLookup: (numericId: number) => string | null;
  /** Contract roots to pre-warm before spawning. Supplied by the caller
   *  because enumerating deployments is app state, not broker state. */
  enumerateWarmRoots: () => string[];
  log: (level: "info" | "warn", message: string) => void;
  /** Test seam for the subscriber constructor. */
  createSubscriber?: (opts: TradovateRealtimeOptions) => TradovateSubscriber;
}

export class TradovateRealtimeAdapter implements BrokerRealtimeAdapter {
  /**
   * One subscriber per Tradovate account. Presence means "we have an
   * active subscriber instance", not "it is currently connected" — a
   * reconnecting subscriber stays in the map.
   */
  private subscribers = new Map<number, TradovateSubscriber>();

  /** The engine's desired set — replaced wholesale by `sync()`. */
  private engineAccounts = new Set<number>();
  /** Pins from other holders. Nothing pins Tradovate today; the pair
   *  exists so the interface means the same thing on both brokers. */
  private pinnedAccounts = new Set<number>();

  private orderHandlers: Array<(accountId: number, order: Order) => void> = [];
  private positionHandlers: Array<(accountId: number, position: Position) => void> = [];
  private fillHandlers: Array<(accountId: number, fill: TradeFill) => void> = [];
  private reconnectHandlers: Array<(accountId: number, lastEventAtBeforeReconnect?: number) => void> =
    [];

  /** Single-flight guard for the contract pre-warm — overlapping syncs
   *  share one `/contract/suggest` round-trip. */
  private warmInflight: Promise<void> | null = null;
  /** Sorted comma-joined root string from the last completed warm. Skip
   *  the re-warm when the deployment set hasn't changed. */
  private warmLastRoots: string | null = null;
  /** The client every live subscriber was spawned over and the last warm
   *  ran on. A different instance from `getClient()` is a credential save:
   *  the subscribers close over this one for their token and symbol lookup. */
  private reconciledClient: TradovateClient | null = null;
  /** Accounts whose subscriber a client replacement disposed and whose
   *  replacement has not subscribed yet, each with the old feed's last
   *  `lastEventAt` — the lower bound of the gap the rotation opened. Kept
   *  across a respawn held back by a null `userId`; dropped when the
   *  account leaves the wanted set, the client is removed, or on shutdown.
   *  The replacement subscriber is a new instance, so its first subscribe
   *  is a cold start, not a reconnect — this is how the adapter still hands
   *  the engine's replay the gap's lower bound. */
  private rotationGapSince = new Map<number, number>();

  /** Serialises `reconcile()`. Same rule as Topstep's adapter: every
   *  entry point lands on this chain so overlapping runs cannot spawn and
   *  dispose the same account out of order across the `warmContractCache`
   *  await. */
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TradovateRealtimeAdapterDeps) {}

  // ── Handler registration ───────────────────────────────────────────

  onOrder(handler: (accountId: number, order: Order) => void): void {
    this.orderHandlers.push(handler);
  }
  onPosition(handler: (accountId: number, position: Position) => void): void {
    this.positionHandlers.push(handler);
  }
  onFill(handler: (accountId: number, fill: TradeFill) => void): void {
    this.fillHandlers.push(handler);
  }
  onReconnect(handler: (accountId: number, lastEventAtBeforeReconnect?: number) => void): void {
    this.reconnectHandlers.push(handler);
  }

  // ── Desired state ──────────────────────────────────────────────────

  async sync(accountIds: Set<number>): Promise<void> {
    this.engineAccounts = new Set(accountIds);
    await this.reconcile();
  }

  async connect(accountId: number): Promise<void> {
    this.pinnedAccounts.add(accountId);
    await this.reconcile();
  }

  disconnect(accountId: number): void {
    if (!this.pinnedAccounts.delete(accountId)) return;
    // `reconcile()` rejects if the pre-warm path throws; `disconnect` is a
    // public interface member and an unhandled rejection terminates a
    // process that runs 24/7.
    this.reconcile().catch((err) => {
      this.deps.log(
        "warn",
        `Tradovate disconnect(${accountId}): reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  shutdown(): void {
    this.engineAccounts.clear();
    this.pinnedAccounts.clear();
    this.rotationGapSince.clear();
    for (const accountId of [...this.subscribers.keys()]) {
      this.disposeSubscriber(accountId, "shutdown");
    }
  }

  private wanted(): Set<number> {
    const out = new Set(this.engineAccounts);
    for (const id of this.pinnedAccounts) out.add(id);
    return out;
  }

  /**
   * Serialised entry point — see `reconcileChain`. The chain never
   * rejects; the returned promise does, so `sync()`'s caller still sees a
   * failure.
   */
  private reconcile(): Promise<void> {
    const next = this.reconcileChain.then(
      () => this.doReconcile(),
      () => this.doReconcile(),
    );
    this.reconcileChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * Spawn / dispose subscribers so the live set matches the desired one.
   * Idempotent. Failures are isolated per account: one subscriber failing
   * to start does not affect the others, and the engine keeps running on
   * the polling fallback for that account.
   */
  private async doReconcile(): Promise<void> {
    const client = this.deps.getClient();
    if (!client) {
      // Dispose anything left from a previous credential bundle — the
      // hot-reload path may have just nulled the client, and a live
      // subscriber would keep authorizing against a stale token.
      for (const accountId of [...this.subscribers.keys()]) {
        this.disposeSubscriber(accountId, "client removed");
      }
      // Removed credentials are not a rotation: whatever attaches next is a
      // first connection, with no feed of ours to have a gap in.
      this.rotationGapSince.clear();
      this.reconciledClient = null;
      return;
    }
    // A new instance: dispose everything spawned over the old one and let
    // the warm and the spawn loop below rebuild on this one. The roots have
    // not changed, so without the reset the new client's cache stays cold.
    if (client !== this.reconciledClient) {
      for (const [accountId, sub] of [...this.subscribers]) {
        // A second rotation before the first one's respawn subscribed keeps
        // the first anchor: the gap still starts there. An old feed that
        // never received a frame records nothing: it delivered nothing, so
        // the rotation opened no gap in it, and a 0 anchor would buy the
        // replay's whole 24h lookback.
        const lastEventAt = sub.status().lastEventAt;
        if (!this.rotationGapSince.has(accountId) && lastEventAt > 0) {
          this.rotationGapSince.set(accountId, lastEventAt);
        }
        this.disposeSubscriber(accountId, "client replaced");
      }
      this.warmLastRoots = null;
      this.reconciledClient = client;
    }
    // Prune before the `userId` gate. Disposal needs no userId — only
    // `spawn` does — and an unauthenticated instant is exactly when
    // `engine.stop()`'s `sync(new Set())` is likeliest to land, so a
    // return above this leaves every socket open with its heartbeat and
    // reconnect timers in a process that runs 24/7.
    const want = this.wanted();
    for (const accountId of [...this.subscribers.keys()]) {
      if (!want.has(accountId)) this.disposeSubscriber(accountId, "account left the set");
    }
    for (const accountId of [...this.rotationGapSince.keys()]) {
      if (!want.has(accountId)) this.rotationGapSince.delete(accountId);
    }

    const userId = client.getUserId();
    // No authenticated session yet (or the auth response carried no
    // userId). `user/syncRequest` requires `users: [<userId>]`; without
    // it, polling is the only path until the next successful auth.
    if (userId == null) return;

    // Pre-populate the contractId↔dated-symbol cache BEFORE spawning.
    // The authorize-then-flush handshake delivers a burst of order and
    // position events within ~100ms of socket open; on a cold cache the
    // dispatcher drops every frame in that burst, and the lazy warm
    // cannot recover them for that boot cycle.
    await this.warmContractCache(client);

    for (const accountId of want) {
      if (this.subscribers.has(accountId)) continue;
      this.spawn(accountId, userId, client);
    }
  }

  private spawn(accountId: number, userId: number, client: TradovateClient): void {
    const options: TradovateRealtimeOptions = {
      accountId,
      userId,
      getAccessToken: async () => {
        // Drive any renewal through validateSession() — the same path the
        // REST client's 401 recovery uses, so renewals stay funnelled
        // through one place.
        if (client.needsRefresh()) {
          try {
            await client.validateSession();
          } catch {
            // fall through — getToken() may still return a viable cached
            // value; the WS auth-rejection path surfaces a real error
          }
        }
        return client.getToken();
      },
      getTokenExpiresAt: () => client.getTokenExpiresAt(),
      // Contract-id translator bridge: WS events carry numeric Tradovate
      // contractIds; engine trade rows carry the dated symbol the
      // resolver returned at trade-store time. Without this bridge
      // `findTradeByAccountContract` never matches and reconciliation is
      // a silent no-op.
      getDatedSymbol: (id) => client.getDatedSymbolForContractId(id),
      warmContractId: (id) => client.warmContractId(id),
    };
    const sub = this.deps.createSubscriber
      ? this.deps.createSubscriber(options)
      : new TradovateRealtime(options);

    sub.onPosition((acctId, position) => {
      this.fanOut(this.positionHandlers, acctId, position, "position");
    });
    sub.onOrder((acctId, order) => {
      this.fanOut(this.orderHandlers, acctId, order, "order");
    });
    sub.onFill((acctId, fill) => {
      this.fanOut(this.fillHandlers, acctId, fill, "fill");
    });
    sub.onReconnect((acctId, lastEventAtBeforeReconnect) => {
      this.fireReconnect(acctId, lastEventAtBeforeReconnect);
    });
    sub.onSubscribed((acctId) => {
      this.fireRotationReplay(acctId);
    });

    this.subscribers.set(accountId, sub);
    void sub.start().catch((err) => {
      this.deps.log(
        "warn",
        `Tradovate WS start failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)} — polling fallback only`,
      );
    });
    this.deps.log("info", `Tradovate WS subscriber spawned for account ${accountId}`);
  }

  /**
   * Per-handler isolation, mirroring Topstep's adapter. `TradovateRealtime`
   * does catch a throw one level down, but that `try` wraps the whole
   * dispatch loop — so without this the first throwing handler starves
   * every handler registered after it. Both the engine and the SSE relay
   * register here.
   */
  private fanOut<T>(
    handlers: Array<(accountId: number, payload: T) => void>,
    accountId: number,
    payload: T,
    kind: string,
  ): void {
    for (const handler of handlers) {
      try {
        handler(accountId, payload);
      } catch (err) {
        this.deps.log(
          "warn",
          `Tradovate ${kind} handler threw for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private fireReconnect(accountId: number, lastEventAtBeforeReconnect: number): void {
    for (const handler of this.reconnectHandlers) {
      try {
        handler(accountId, lastEventAtBeforeReconnect);
      } catch (err) {
        this.deps.log(
          "warn",
          `Tradovate reconnect handler threw for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * The rotation's reconnect, fired when the replacement subscriber first
   * subscribes. The gap's lower bound is the old feed's last event, which
   * this adapter remembered across the disposal in `rotationGapSince`; it
   * travels to the engine's replay on the reconnect signal, the same way an
   * ordinary reconnect carries its own pre-drop anchor. No lent `status()`
   * anchor, so nothing depends on the replay reading status before its
   * first await.
   */
  private fireRotationReplay(accountId: number): void {
    const lastEventAt = this.rotationGapSince.get(accountId);
    if (lastEventAt === undefined) return;
    this.rotationGapSince.delete(accountId);
    this.fireReconnect(accountId, lastEventAt);
  }

  private disposeSubscriber(accountId: number, reason: string): void {
    const sub = this.subscribers.get(accountId);
    if (!sub) return;
    try {
      sub.dispose();
    } catch (err) {
      this.deps.log(
        "warn",
        `Tradovate WS dispose for account ${accountId} failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.subscribers.delete(accountId);
  }

  /**
   * Pre-populate the client's contractId↔dated-symbol cache for the
   * roots the caller nominates. Best-effort; per-root failures warn but
   * don't throw. Single-flighted so overlapping callers share one
   * round-trip. No TTL: `reconcile()` fires on session reconnect and
   * registry refresh, which is the right cadence, and the dispatcher's
   * lazy warm covers anything that slips through between syncs.
   */
  private async warmContractCache(client: TradovateClient): Promise<void> {
    if (this.warmInflight) return this.warmInflight;
    const promise = (async () => {
      let roots: string[];
      try {
        roots = this.deps.enumerateWarmRoots();
      } catch (err) {
        this.deps.log(
          "warn",
          `Tradovate contract pre-warm: enumerate deployments failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (roots.length === 0) {
        this.deps.log("info", `Tradovate contract pre-warm: no roots to warm`);
        return;
      }
      const rootKey = [...roots].sort().join(",");
      if (rootKey === this.warmLastRoots) return;
      this.deps.log("info", `Tradovate contract pre-warm: warming roots ${roots.join(", ")}`);
      try {
        await client.warmContractIdsForRoots(roots);
        this.warmLastRoots = rootKey;
        this.deps.log("info", `Tradovate contract pre-warm: complete`);
      } catch (err) {
        this.deps.log(
          "warn",
          `Tradovate contract pre-warm: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    this.warmInflight = promise.finally(() => {
      this.warmInflight = null;
    });
    return this.warmInflight;
  }

  // ── Health and diagnostics ─────────────────────────────────────────

  /**
   * True when this account's subscriber is subscribed and has pushed —
   * or been armed by a fresh subscribe — inside the health window.
   *
   * The cold-start window matters: a freshly-subscribed socket may be
   * quiet for a few seconds before its first inbound frame, so the anchor
   * is `max(subscribedAt, lastEventAt)` and the first reconciler tick
   * after subscribe doesn't redundantly poll a live socket. Once events
   * flow, `lastEventAt` outpaces `subscribedAt` and the check transitions
   * seamlessly to event time.
   */
  isHealthy(accountId: number, now: number = Date.now()): boolean {
    const status = this.status(accountId);
    if (!status) return false;
    if (status.state !== "subscribed") return false;
    const marker = Math.max(status.lastEventAt, status.subscribedAt ?? 0);
    if (marker === 0) return false;
    return now - marker <= TRADOVATE_WS_HEALTHY_MS;
  }

  status(accountId: number): RealtimeStatusSnapshot | null {
    return this.subscribers.get(accountId)?.status() ?? null;
  }

  /**
   * Normalize a Tradovate contractId string to its dated-symbol form
   * (`"4799969"` → `"MNQM6"`, `"MNQM6"` → `"MNQM6"`). Returns the input
   * unchanged when it is not a pure numeric string or no mapping is
   * found.
   *
   * Lives here because it bridges the numeric ids *this transport*
   * produces to the dated symbols the store holds — same bridge the WS
   * dispatcher uses, one owner. Lookup order: the client's own cache →
   * the resolver's cache → fire `warmContractId` so the next poll
   * resolves it.
   */
  resolveDatedSymbol(contractId: string): string {
    if (!/^\d+$/.test(contractId)) return contractId;
    const numericId = Number(contractId);
    const client = this.deps.getClient();
    if (!client) return contractId;
    const fromClient = client.getDatedSymbolForContractId(numericId);
    if (fromClient) return fromClient;
    const fromResolver = this.deps.resolverSymbolLookup(numericId);
    if (fromResolver) return fromResolver;
    void client.warmContractId(numericId);
    return contractId;
  }
}
