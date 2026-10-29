import { log } from "@/lib/logger";
import type { BrokerRealtimeAdapter } from "@/lib/brokers/plugin";
import { nextMaintenanceEnd } from "@/lib/trading/session/session";
import type {
  Order,
  Position,
  RealtimeConnectionState,
  RealtimeStatusSnapshot,
  TradeFill,
} from "@/lib/brokers/types";
import { advisoryFollowsOwnLogin } from "./client";
import { toOrder, toPosition, toTradeFill } from "./event-translation";
import type { TopstepUserHubTransport } from "./user-hub";

/**
 * Topstep's account-event adapter — the user hub, and nothing else.
 *
 * **The asymmetry this class exists to absorb.** Tradovate is genuinely
 * per-account: one socket each. Topstep's user hub is process-wide — one
 * connection carrying every account the credential can see — while
 * `BrokerRealtimeAdapter` is keyed by account, because that is the
 * engine's unit of interest. So this adapter ref-counts: the hub comes up
 * when the first holder wants an account (or pins it open), later holders
 * join a live set, and the hub is torn down only when the set empties.
 * It must never drop the hub while another holder still wants it, and
 * never leak one after the last holder leaves.
 *
 * **Two holders, deliberately.** `sync()` carries the *engine's* desired
 * set and prunes it wholesale. The browser's SSE relay is an independent
 * holder — it pins the accounts the operator is watching through
 * `retain()`, which `sync()` does not prune. Collapsing them would make
 * `engine.stop()` kill the dashboard's live panels, and would make an
 * operator watching an undeployed account lose their feed on the next
 * deployment edit.
 *
 * The user-hub reconnect loop moved here from `EventBroadcaster`, which
 * used to own the lifecycle. `docs/modules/trading/engine.md` already
 * named this move: *"if the user hub ever gets its own controller, that
 * is where those move"*.
 */

/** Maximum reconnect-loop attempts before entering cooldown. */
const USER_RECONNECT_LOOP_MAX = 5;
/** How long to wait after hitting the cap before resetting the count (ms). */
const USER_RECONNECT_COOLDOWN_MS = 60 * 60 * 1000;
/** If the hub stays connected for this long without closing, reset the attempt
 *  count so a brief nightly disruption doesn't permanently eat into the cap. */
const USER_RECONNECT_SUSTAINED_MS = 60 * 60 * 1000;
/** A `gatewaylogout` advisory followed by a close inside this window is a
 *  real session displacement, not a transient drop. Shared with the market
 *  hub's close handler: the inference is the same gateway following through
 *  on its own advisory, and the only escalation ever observed (the user hub,
 *  2026-05-06) closed within ~1s. Wider costs more: a stale advisory turns a
 *  later network drop into a kick, which parks the market hub for hours. */
export const GATEWAY_LOGOUT_CLOSE_WINDOW_MS = 1000;
/** The reopen retry waits this long past 18:00 ET. The engine's auto-heal
 *  fires on the minute and its `forceReconnect` tears down any start in
 *  flight, so landing together cost a failed attempt on the engine's count. */
const REOPEN_GRACE_MS = 15_000;

export type ConnectionStatusHandler = (connected: boolean, reason?: string) => void;

export class TopstepRealtimeAdapter implements BrokerRealtimeAdapter {
  /** The engine's desired set — replaced wholesale by `sync()`. */
  private engineAccounts = new Set<number>();
  /** Pins from holders other than the engine (today: the SSE relay).
   *  Additive; `sync()` never prunes these. */
  private pinnedAccounts = new Set<number>();
  /** Holders that want the hub up regardless of account interest. The
   *  dashboard needs a live hub on an install with zero deployments. */
  private keepAlive = new Set<string>();
  /** Accounts actually subscribed on the current hub instance. Cleared on
   *  every teardown so a rebuild re-subscribes from scratch. */
  private subscribed = new Set<number>();

  private started = false;
  private connected = false;
  private startPromise: Promise<void> | null = null;
  /** Whether `doStart()` has ever completed. Distinguishes a cold first
   *  start (nothing to replay) from a restart (an outage window the
   *  engine has to query). See the reconnect signal in `doStart`. */
  private hasStartedOnce = false;
  /**
   * `shutdown()` is terminal, the way `TradovateRealtime.dispose()` is.
   * The plugins are process-global and `attachRealtimeAdapters` replaces
   * this object on every engine construction, so a shut-down instance is
   * only reachable through a stale reference — and letting one bring the
   * hub back up orphans a live process-wide socket with no holder that
   * will ever stop it.
   */
  private disposed = false;

  private orderHandlers: Array<(accountId: number, order: Order) => void> = [];
  private positionHandlers: Array<(accountId: number, position: Position) => void> = [];
  private fillHandlers: Array<(accountId: number, fill: TradeFill) => void> = [];
  private reconnectHandlers: Array<(accountId: number) => void> = [];
  private statusHandlers: ConnectionStatusHandler[] = [];

  private reconnectInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectLoopAttempts = 0;
  private reconnectCooldownUntil = 0;
  private forceReconnectInFlight = false;
  /** One-shot retry at the market reopen, armed instead of the 30s loop
   *  while the market is closed, or at the end of a cap's cooldown. */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set around our own `transport.stop()`, whose `onclose` is not a drop. */
  private stoppingTransport = false;

  /**
   * Serialises the paths that mutate `subscribed`, so an add and a remove
   * of the same id can never reach the wire in the opposite order to the
   * set mutations that decided them.
   *
   * **On the chain:** every holder entry point — `sync`, `connect`,
   * `retain`, `release`, `disconnect` — the transport's `onReconnected`
   * resubscribe, and `shutdown()`'s terminal teardown.
   *
   * **Off it, and they cannot be on it:** the two `ensureStarted` callers
   * that exist to recover a hub that is already down — `forceReconnect()`
   * (the engine's auto-heal) and `attemptReconnect()` (the 30s loop and the
   * `armResume` timer). Both
   * reach `doStart` → `resubscribeAll`, and `forceReconnect` also clears
   * `subscribed` before awaiting `transport.stop()`. Queueing them would
   * park the recovery path behind the `doReconcile` that is blocked on the
   * hung `transport.start()` it exists to recover from. They run only with
   * the hub down or being torn down, and the next `doReconcile` re-issues
   * from `liveAccounts()` either way. Do not add a third off-chain mutation
   * of `subscribed` without settling these two first — `shutdown()` was
   * one, and it is on the chain now.
   */
  private reconcileChain: Promise<void> = Promise.resolve();

  private lastEventAt = 0;
  private eventWindowCount = 0;
  private subscribedAt: number | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private lastGatewayLogoutAt = 0;

  /** `marketReopensAt` answers the next CME reopen while the market is
   *  closed, null while it is open. Injected so tests do not depend on the
   *  day they run. */
  constructor(
    private readonly transport: TopstepUserHubTransport,
    private readonly marketReopensAt: (now: Date) => Date | null = nextMaintenanceEnd,
  ) {}

  // ── Handler registration (additive — engine and SSE relay both listen) ──

  onOrder(handler: (accountId: number, order: Order) => void): void {
    this.orderHandlers.push(handler);
  }
  onPosition(handler: (accountId: number, position: Position) => void): void {
    this.positionHandlers.push(handler);
  }
  onFill(handler: (accountId: number, fill: TradeFill) => void): void {
    this.fillHandlers.push(handler);
  }
  onReconnect(handler: (accountId: number) => void): void {
    this.reconnectHandlers.push(handler);
  }
  /** Connection transitions, for the SSE relay's `status` frame. */
  onStatus(handler: ConnectionStatusHandler): void {
    this.statusHandlers.push(handler);
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
    this.reconcileInBackground(`disconnect(${accountId})`);
  }

  /**
   * Hold the hub open, optionally pinning accounts, on behalf of a named
   * holder. One call per holder rather than one per account so the SSE
   * route's mount does a single reconcile — and so a failure to bring the
   * hub up propagates to the caller the way `connectUserHub()` used to.
   */
  async retain(key: string, accountIds: number[] = []): Promise<void> {
    this.keepAlive.add(key);
    for (const id of accountIds) this.pinnedAccounts.add(id);
    await this.reconcile();
  }

  /** Drop a holder's keep-alive. Its account pins are dropped with it. */
  release(key: string, accountIds: number[] = []): void {
    if (!this.keepAlive.delete(key) && accountIds.length === 0) return;
    for (const id of accountIds) this.pinnedAccounts.delete(id);
    this.reconcileInBackground(`release(${key})`);
  }

  /** `reconcile()` rejects when `transport.start()` throws. The
   *  fire-and-forget callers are public interface members and a transport
   *  callback, and an unhandled rejection terminates a process that runs
   *  24/7. */
  private enqueueInBackground(label: string, op: () => Promise<void>): void {
    this.enqueue(op).catch((err) => {
      log.warn("topstep.realtime", `${label}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private reconcileInBackground(context: string): void {
    this.enqueueInBackground(`${context}: reconcile failed`, () => this.doReconcile());
  }

  /**
   * Terminal teardown, on the chain. `stopHub()` is not called directly:
   * an in-flight `doStart()` — a `retain()` whose `transport.start()` has
   * not resolved — would make a direct call take `stopHub`'s early return
   * (`started` is still false), leave `transport.stop()` unsent, and then
   * let the start resolve into a live hub with every holder already
   * cleared. Queued behind that start, the teardown sees `started` and
   * stops it; and `disposed` is what stops anything re-starting it after.
   */
  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engineAccounts.clear();
    this.pinnedAccounts.clear();
    this.keepAlive.clear();
    this.clearReconnectLoop();
    this.clearResumeTimer();
    if (this.reconnectResetTimer) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = null;
    }
    this.enqueueInBackground("shutdown: stopping the hub failed", () => this.stopHub());
  }

  /** Union of every holder's interest — the accounts the hub subscribes. */
  private liveAccounts(): Set<number> {
    const out = new Set(this.engineAccounts);
    for (const id of this.pinnedAccounts) out.add(id);
    return out;
  }

  private wantsHub(): boolean {
    return this.keepAlive.size > 0 || this.liveAccounts().size > 0;
  }

  /**
   * Serialised entry point. Every holder-mutating method funnels through
   * here, because `doReconcile` mutates `subscribed` **before** awaiting
   * the transport: two overlapping runs can otherwise put a subscribe and
   * an unsubscribe of the same id on the wire in the opposite order to
   * the set mutations that decided them, leaving the hub unsubscribed
   * while `subscribed` says otherwise. `isHealthy()` and `status()` then
   * both report a live feed that is not there, and nothing re-issues
   * until the next hub restart. Reachable from `applySync()` dropping an
   * account while the browser mounts SSE and re-pins it.
   *
   * The chain itself never rejects; the returned promise does, so
   * `retain()` still propagates a failed hub start to its caller.
   */
  private reconcile(): Promise<void> {
    return this.enqueue(() => this.doReconcile());
  }

  /** Append an operation that mutates `subscribed` to the chain. The chain
   *  itself never rejects; the returned promise does. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.reconcileChain.then(op, op);
    this.reconcileChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async doReconcile(): Promise<void> {
    if (!this.wantsHub()) {
      await this.stopHub();
      return;
    }
    // A hub that is down stays down until the reopen; one that is up keeps
    // taking subscription changes.
    if (!this.started && this.deferUntilOpen()) return;
    await this.ensureStarted();
    if (!this.started) return;
    const want = this.liveAccounts();
    const joining = [...want].filter((id) => !this.subscribed.has(id));
    const leaving = [...this.subscribed].filter((id) => !want.has(id));
    await Promise.all([
      ...joining.map((id) => this.subscribeAccount(id)),
      ...leaving.map((id) => this.unsubscribeAccount(id)),
    ]);
  }

  private async subscribeAccount(accountId: number): Promise<void> {
    // Optimistic add so a concurrent reconcile does not double-subscribe.
    this.subscribed.add(accountId);
    try {
      await this.transport.subscribeAccount(accountId);
    } catch (err) {
      // Roll it back. Leaving a failed id in `subscribed` means it is
      // never in `joining` again, so only a full hub teardown recovers
      // it — reachable whenever `invokeWhenReady` gives up during a
      // mid-handshake subscribe.
      this.subscribed.delete(accountId);
      log.event(
        "ws_subscribe_failed",
        "topstep.realtime",
        `subscribeAccount(${accountId}) failed: ${err instanceof Error ? err.message : String(err)} — will retry on the next reconcile`,
        { accountId },
      );
    }
  }

  private async unsubscribeAccount(accountId: number): Promise<void> {
    this.subscribed.delete(accountId);
    try {
      await this.transport.unsubscribeAccount(accountId);
    } catch {
      // Best-effort — if the hub is dying, swallow.
    }
  }

  // ── Hub lifecycle ──────────────────────────────────────────────────

  /**
   * Single-flight build + start. A boolean guard is not single-flight:
   * two callers entering with `started === false` would both build a hub
   * and double-register handlers on the second instance.
   */
  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("TopstepRealtimeAdapter: the user hub is shut down");
    }
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // Handlers go on BEFORE start(): SignalR drops messages that arrive
    // between `start()` resolving and a later `.on()`, and Topstep's
    // `gatewaylogout` lands inside the handshake round-trip.
    this.transport.build();
    const hubBuiltAt = Date.now();
    this.transport.onOrder((raw) => {
      this.noteEvent();
      const order = toOrder(raw);
      this.fanOut(this.orderHandlers, raw.accountId, order, "order");
    });
    this.transport.onPosition((raw) => {
      this.noteEvent();
      const position = toPosition(raw);
      this.fanOut(this.positionHandlers, raw.accountId, position, "position");
    });
    this.transport.onUserTrade((raw) => {
      this.noteEvent();
      const fill = toTradeFill(raw);
      this.fanOut(this.fillHandlers, raw.accountId, fill, "fill");
    });
    this.transport.onReconnected(() => {
      this.connected = true;
      this.subscribedAt = Date.now();
      this.reconnectAttempts += 1;
      this.emitStatus(true, "reconnected");
      // On the chain, not `void`: this clears and re-adds `subscribed`
      // through `subscribeAccount`, which deletes on failure, so
      // interleaving it with a `doReconcile` whose subscribe rejects leaves
      // the set disagreeing with the wire. It stays `resubscribeAll` rather
      // than a chained `reconcile()` because the re-issue is deliberately
      // unconditional — a SignalR auto-reconnect does not clear `subscribed`
      // here, so `doReconcile` would compute an empty `joining` and re-issue
      // nothing while Topstep has dropped every subscription server-side.
      this.enqueueInBackground("onReconnected: resubscribe failed", () =>
        this.resubscribeAll(),
      );
      // Signal per live account. The engine owns what replay means; this
      // only says the transport came back.
      for (const accountId of this.liveAccounts()) {
        this.fireReconnect(accountId);
      }
    });
    // Under `withAutomaticReconnect` a drop lands here, not in `onClose` —
    // which fires only once the retries run out — so this is the one place
    // the drop's own error is ever seen (A79).
    this.transport.onReconnecting((err) => {
      log.event(
        "ws_disconnected",
        "topstep.realtime",
        `user hub dropped, SignalR retrying (${err ? err.message : "no error given"})`,
      );
    });
    this.transport.onClose((err) => {
      this.connected = false;
      this.started = false;
      this.subscribed.clear();
      this.subscribedAt = null;
      if (this.reconnectResetTimer) {
        clearTimeout(this.reconnectResetTimer);
        this.reconnectResetTimer = null;
      }
      // A gatewaylogout advisory followed by a close inside the window is
      // Topstep escalating from advisory to teardown — a real session
      // displacement. Outside it, a plain transient close.
      const sinceAdvisory = Date.now() - this.lastGatewayLogoutAt;
      const wasKick =
        this.lastGatewayLogoutAt > 0 && sinceAdvisory <= GATEWAY_LOGOUT_CLOSE_WINDOW_MS;
      const reason = wasKick
        ? "Session displaced by another login (gatewaylogout followed by socket close)"
        : err
          ? err.message
          : "connection closed";
      const closeReason = err ? err.message : "no error given";
      // Our own `stop()` fires this too. It is not a drop: logging it read as
      // a close on every forced reconnect, and re-arming the loop for it
      // could log a suppression nobody caused.
      const selfInflicted = this.stoppingTransport;
      if (selfInflicted) {
        // Neither logged nor retried; the state above still resets.
      } else if (wasKick) {
        log.event(
          "ws_session_displaced",
          "topstep.realtime",
          `user hub closed within ${sinceAdvisory}ms of gatewaylogout — treating as real disconnect (close: ${closeReason})`,
        );
      } else {
        log.event("ws_disconnected", "topstep.realtime", `user hub closed (${closeReason})`);
      }
      this.lastGatewayLogoutAt = 0;
      this.lastError = reason;
      this.emitStatus(false, reason);
      if (!selfInflicted) this.scheduleReconnect();
    });
    this.transport.onGatewayLogout((reason) => {
      const now = Date.now();
      // Our own login's echo is not another device taking the slot (A90),
      // so a close after it is not named a displacement.
      if (advisoryFollowsOwnLogin(now, hubBuiltAt)) {
        log.debug("topstep.realtime", `user gatewaylogout after this process's own login (not a kick): ${reason}`);
        return;
      }
      // Advisory by default — Topstep usually keeps streaming after this.
      // Stamp the time so a close inside the window can promote it.
      this.lastGatewayLogoutAt = now;
      log.debug(
        "topstep.realtime",
        `user gatewaylogout (advisory pending close-window check): ${reason}`,
      );
    });

    await this.transport.start();
    this.started = true;
    this.connected = true;
    this.subscribedAt = Date.now();
    this.lastError = null;
    this.emitStatus(true);
    await this.resubscribeAll();

    // Every `doStart` after the first recovers a hub that was down — the
    // 30s `attemptReconnect` loop, `forceReconnect`'s auto-heal, or a
    // `doReconcile` finding `started === false` after an `onClose`. None
    // of them run `transport.onReconnected`, which was the sole caller of
    // `fireReconnect`, so the outages long enough to need the engine's
    // reconnect-gap replay were the only ones that never triggered it.
    // Gated the way Tradovate gates on `hasSubscribedOnce`: a cold first
    // start has no gap to query. Fired after `resubscribeAll` so the
    // replay window closes against a hub that is already re-subscribed.
    const isRestart = this.hasStartedOnce;
    this.hasStartedOnce = true;
    if (isRestart) {
      for (const accountId of this.liveAccounts()) {
        this.fireReconnect(accountId);
      }
    }

    // Sustained-connection reset: an hour up without a close clears the
    // attempt count so an earlier blip doesn't permanently eat the cap.
    if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer);
    this.reconnectResetTimer = setTimeout(() => {
      if (this.reconnectLoopAttempts > 0) {
        log.debug(
          "topstep.realtime",
          `user hub sustained ${USER_RECONNECT_SUSTAINED_MS / 60_000}min — resetting reconnect attempt count`,
        );
        this.reconnectLoopAttempts = 0;
        this.reconnectCooldownUntil = 0;
      }
      this.reconnectResetTimer = null;
    }, USER_RECONNECT_SUSTAINED_MS);
  }

  private async stopHub(): Promise<void> {
    // The sustained-reset timer is a 1-hour timeout; leaving it armed
    // holds the event loop open past teardown. The resume timer likewise.
    this.clearResumeTimer();
    if (this.reconnectResetTimer) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = null;
    }
    if (this.disposed && this.startPromise) {
      // `shutdown()` is ordered by the chain against the reconciles, but
      // the two `ensureStarted` callers that recover a dead hub are not,
      // so a start can still be in flight here. Let it settle first, or
      // `transport.stop()` runs against a hub that has not opened yet and
      // the start resolves behind it into an orphan. `ensureStarted`
      // refuses once `disposed`, so this is the last one there can be.
      await this.startPromise.catch(() => {});
    }
    // The early return is an optimisation for a *live* adapter — nothing
    // to stop. It is wrong for a terminal one, whose whole purpose is to
    // guarantee the transport is closed.
    if (!this.disposed && !this.started && this.subscribed.size === 0) {
      this.clearReconnectLoop();
      return;
    }
    this.clearReconnectLoop();
    this.started = false;
    this.connected = false;
    this.subscribed.clear();
    this.subscribedAt = null;
    await this.stopTransport();
  }

  private async stopTransport(): Promise<void> {
    this.stoppingTransport = true;
    try {
      await this.transport.stop();
    } finally {
      this.stoppingTransport = false;
    }
  }

  /** Re-issue every account subscription. Topstep clears them server-side
   *  on reconnect, so this runs on every (re)start. Goes through
   *  `subscribeAccount` for its rollback: this is the path a first
   *  `reconcile()` actually takes, so a failure here has to leave the id
   *  out of `subscribed` too, or the retry never comes. */
  private async resubscribeAll(): Promise<void> {
    const want = this.liveAccounts();
    this.subscribed.clear();
    await Promise.all([...want].map((id) => this.subscribeAccount(id)));
  }

  /**
   * Force a teardown + rebuild. The engine's auto-heal path drives this
   * when the hub is wedged Disconnected and the passive 30s loop hasn't
   * recovered. Throws if the rebuilt hub fails to start, or if it started
   * and then closed before every account subscription landed; the caller
   * decides retry/alert.
   */
  async forceReconnect(): Promise<void> {
    this.forceReconnectInFlight = true;
    try {
      this.clearReconnectLoop();
      this.started = false;
      this.connected = false;
      this.subscribed.clear();
      await this.stopTransport();
      await this.ensureStarted();
      this.assertStillUp();
    } finally {
      this.forceReconnectInFlight = false;
    }
  }

  /**
   * `start()` resolving is not a recovery. A gateway that refuses the
   * session accepts the handshake and closes milliseconds later, cancelling
   * every in-flight subscribe (A79) — so a resolved start alone let the
   * engine log a reconnect that never happened and never count the failure.
   */
  private assertStillUp(): void {
    if (!this.started || !this.connected) {
      throw new Error(`user hub closed right after start (${this.lastError ?? "no reason"})`);
    }
    const missing = [...this.liveAccounts()].filter((id) => !this.subscribed.has(id));
    if (missing.length > 0) {
      throw new Error(`user hub started but account subscriptions did not land: ${missing.join(", ")}`);
    }
  }

  // ── Reconnect loop ─────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;
    if (this.deferUntilOpen()) return;
    if (Date.now() < this.reconnectCooldownUntil) {
      const remainS = Math.round((this.reconnectCooldownUntil - Date.now()) / 1000);
      log.event(
        "ws_reconnect_suppressed",
        "topstep.realtime",
        `user hub reconnect suppressed — cap reached, cooldown active (${remainS}s remaining)`,
      );
      return;
    }
    this.reconnectInterval = setInterval(() => {
      void this.attemptReconnect();
    }, 30_000);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.forceReconnectInFlight) return;
    if (this.started) {
      this.clearReconnectLoop();
      return;
    }
    if (!this.wantsHub()) {
      // Nobody wants the hub any more — stop burning reconnects.
      this.clearReconnectLoop();
      return;
    }
    // The market closed while the loop was running.
    if (this.deferUntilOpen()) return;
    if (Date.now() < this.reconnectCooldownUntil) {
      this.clearReconnectLoop();
      return;
    }
    // A cooldown that has run out buys a fresh budget. Without this the
    // count stays at the cap — only an hour of sustained connection cleared
    // it — so the first attempt after every cooldown re-entered the next.
    if (this.reconnectCooldownUntil > 0) {
      this.reconnectLoopAttempts = 0;
      this.reconnectCooldownUntil = 0;
    }
    if (this.reconnectLoopAttempts >= USER_RECONNECT_LOOP_MAX) {
      this.reconnectCooldownUntil = Date.now() + USER_RECONNECT_COOLDOWN_MS;
      log.event(
        "ws_reconnect_suppressed",
        "topstep.realtime",
        `user hub reconnect loop reached cap (${USER_RECONNECT_LOOP_MAX} attempts) — backing off for ${USER_RECONNECT_COOLDOWN_MS / 60_000} min`,
      );
      this.emitStatus(
        false,
        `reconnect cap reached after ${USER_RECONNECT_LOOP_MAX} attempts — backing off`,
      );
      this.clearReconnectLoop();
      // Without this a hub already down got no further `onclose`, so nothing
      // retried after the cooldown and the hub waited on the engine.
      this.armResume(this.reconnectCooldownUntil);
      return;
    }
    this.reconnectLoopAttempts++;
    this.reconnectAttempts++;
    try {
      await this.ensureStarted();
      // An accept-then-close (A79) resolves here with the hub already down;
      // its `onclose` found this loop armed and returned, so keep it.
      if (this.started) this.clearReconnectLoop();
    } catch {
      // Leave the loop running; next tick tries again.
    }
  }

  private clearReconnectLoop(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  /**
   * While the market is closed the gateway refuses the user hub, so every
   * attempt is a close and the cap's hour-long cooldowns end up deciding
   * when it comes back (2026-10-25: 16 h of closes, cap hit twice). Instead,
   * no retries until the reopen, then one with a fresh budget, the 30s loop
   * behind it. Returns whether the market is closed.
   */
  private deferUntilOpen(): boolean {
    const reopen = this.marketReopensAt(new Date());
    if (!reopen) return false;
    this.clearReconnectLoop();
    if (this.resumeTimer) return true;
    log.event(
      "ws_reconnect_deferred",
      "topstep.realtime",
      `user hub reconnect waits for the market to open at ${reopen.toISOString()}`,
    );
    this.armResume(reopen.getTime() + REOPEN_GRACE_MS);
    return true;
  }

  /** One retry at `at` with a fresh budget, the 30s loop behind it. A market
   *  still closed then re-defers through `scheduleReconnect`. */
  private armResume(at: number): void {
    if (this.resumeTimer) return;
    this.resumeTimer = setTimeout(
      () => {
        this.resumeTimer = null;
        this.reconnectLoopAttempts = 0;
        this.reconnectCooldownUntil = 0;
        if (this.disposed || this.started || !this.wantsHub()) return;
        this.scheduleReconnect();
        if (this.reconnectInterval) void this.attemptReconnect();
      },
      Math.max(0, at - Date.now()),
    );
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  /** Raw SignalR state for the engine heartbeat + auto-heal gate. */
  hubState(): string {
    return this.transport.state();
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Event-arrival counters for the engine heartbeat. The window count is
   *  consumed-and-reset, so the value is events since the last read. */
  liveness(): { lastEventAt: number; windowCount: number; hubStarted: boolean } {
    const out = {
      lastEventAt: this.lastEventAt,
      windowCount: this.eventWindowCount,
      hubStarted: this.started,
    };
    this.eventWindowCount = 0;
    return out;
  }

  /**
   * Transport health for this account. Honest about the hub, and
   * deliberately *not* a claim that REST reconciliation can be skipped —
   * Topstep's polling fallback is unconditional (see
   * `docs/modules/trading/engine.md`).
   */
  isHealthy(accountId: number, now: number = Date.now()): boolean {
    if (!this.liveAccounts().has(accountId)) return false;
    if (!this.connected) return false;
    const marker = Math.max(this.lastEventAt, this.subscribedAt ?? 0);
    if (marker === 0) return false;
    return now - marker <= 30_000;
  }

  status(accountId: number): RealtimeStatusSnapshot | null {
    if (!this.liveAccounts().has(accountId)) return null;
    return {
      state: this.connectionState(),
      lastEventAt: this.lastEventAt,
      subscribedAt: this.subscribedAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  private connectionState(): RealtimeConnectionState {
    if (this.connected) return "subscribed";
    if (this.startPromise) return "connecting";
    if (this.reconnectInterval) return "reconnecting";
    return "idle";
  }

  // ── Internals ──────────────────────────────────────────────────────

  private noteEvent(): void {
    this.lastEventAt = Date.now();
    this.eventWindowCount++;
  }

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
        log.event(
          "frame_dispatch_failed",
          "topstep.realtime",
          `${kind} handler threw for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId },
        );
      }
    }
  }

  private fireReconnect(accountId: number): void {
    for (const handler of this.reconnectHandlers) {
      try {
        handler(accountId);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "topstep.realtime",
          `reconnect handler threw for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId },
        );
      }
    }
  }

  private emitStatus(connected: boolean, reason?: string): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(connected, reason);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "topstep.realtime",
          `status handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
