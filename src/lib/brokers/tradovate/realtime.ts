import { log } from "@/lib/logger";
import { sendDiscordAlert } from "@/lib/notify/discord";
import { isProductionEnv } from "@/lib/env";
import {
  TRADOVATE_CANCELABLE_STATUSES,
  translateFill,
  translateOrder,
  translatePosition,
  type ContractIdLookup,
} from "./fill-mapping";
import type {
  TradovateFill,
  TradovateFillFee,
  TradovateOrder,
  TradovatePosition,
} from "./types";
import type {
  Order,
  Position,
  RealtimeConnectionState,
  RealtimeStatusSnapshot,
  TradeFill,
} from "@/lib/brokers/types";
import {
  lookupByOrderId,
  markTerminal,
  type OrderMapping,
} from "@/lib/db/tradovate-order-map";

/**
 * Tradovate Real-Time WebSocket subscriber (per-account user/syncRequest).
 *
 * Connects to `wss://{demo|live}.tradovateapi.com/v1/websocket`, authorizes
 * with the broker client's access token, subscribes via `user/syncRequest`,
 * and dispatches order/fill/position deltas to caller-provided handlers.
 *
 * Protocol shape — Tradovate uses a SockJS-ish framing:
 *   - Server opens with the literal byte `o`.
 *   - Client/server then exchange SockJS array frames: `a[<json>, ...]`.
 *   - Heartbeat is the literal frame `h`; client sends `[]` every 2.5s
 *     (server closes silent sockets after ~10s).
 *   - Each application frame is encoded as the string
 *       `name\nrequestId\nquery\nbody`
 *     where body is a JSON-stringified payload. Ack/data frames come back
 *     as `{"i": <id>, "s": 200, "d": <payload>}` for request/response and
 *     `{"e": "props", "d": <payload>}` for streaming events.
 *
 * The polling reconciler in the engine reads `lastEventAt()` and falls back
 * to broker REST search calls when the WS hasn't pushed an event in >30s.
 *
 * Token refresh: WS connections don't get HTTP 401s after the initial auth,
 * but the access token can expire mid-session. Tradovate doesn't document a
 * server-side expiry-signal frame on this socket; defensive reconnect runs
 * a fresh socket+auth before `tokenExpiresAtMs - REFRESH_MARGIN_MS`. The
 * broker client's `authenticate()` is the source of truth for the new token
 * (caller passes a `getAccessToken` thunk so a renewal taken by the REST
 * client is picked up on the next reconnect).
 */

// Tradovate WS hosts. Matches the REST env split — driven by the same
// `isProductionEnv()` decision as the REST `resolveBaseUrl` so a single
// deploy-env flip moves both sockets in lockstep.
const DEMO_WS_URL = "wss://demo.tradovateapi.com/v1/websocket";
const LIVE_WS_URL = "wss://live.tradovateapi.com/v1/websocket";

// Heartbeat cadence: server closes silent sockets after ~10s. Send every
// 2.5s for comfortable headroom and so a single dropped heartbeat doesn't
// race the timeout.
const HEARTBEAT_INTERVAL_MS = 2_500;

// Inbound-silence reconnect threshold. If we don't see any frame (heartbeat
// or data) for this long, assume the socket is wedged and rebuild it. The
// server's heartbeat (`h` frames) ticks at ~2.5s so 5s is two missed beats.
const INBOUND_SILENCE_RECONNECT_MS = 5_000;

// Exponential backoff schedule (caps at 30s per plan §A.7).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

// Defensive token refresh: Tradovate access tokens are ~75min. Force a
// fresh socket + re-auth this many ms before the known expiry so a stale
// token is never the reason for a reconnect mid-trade.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Authorize-frame ack timeout. The server should respond with a status-200
// frame within a couple of seconds; if it doesn't, treat the socket as
// broken and reconnect rather than waiting indefinitely.
const AUTH_ACK_TIMEOUT_MS = 8_000;

// Phase 7 WS auth-failure alert tuning.
//   - Grace window: don't alert until the subscriber has been
//     unsubscribed for this long. Below that, the reconnect loop is
//     normal recovery noise (cred prompt during boot, network blip,
//     token-refresh window). Above it, the operator needs to act.
//   - Re-alert interval: once we've alerted, suppress for an hour.
//     WS auth-failure is usually a credential issue (expired/revoked
//     access token) — one alert is enough cadence; spamming hourly
//     would flood the channel without adding signal.
const WS_AUTH_FAILURE_ALERT_AFTER_MS = 5 * 60 * 1000;
const WS_AUTH_FAILURE_REALERT_MS = 60 * 60 * 1000;
const COLOR_WS_AUTH_FAILURE = 0xf5a524; // amber — same warning palette as penalty pressure

export interface TradovateRealtimeOptions {
  /** Async accessor for the current Tradovate access token. Called both at
   *  initial connect and on every reconnect — broker-client renewals are
   *  picked up automatically when the REST side refreshes. */
  getAccessToken: () => Promise<string | null>;
  /** Async accessor for the access token's epoch-ms expiry. Used to
   *  schedule a defensive reconnect before the token would silently
   *  expire mid-session. Optional: when absent, only inbound-silence and
   *  socket-close events drive reconnects. */
  getTokenExpiresAt?: () => number;
  /** Tradovate user id whose entities we subscribe to. The
   *  `user/syncRequest` body shape requires a `users: [<id>]` array. */
  userId: number;
  /** Account id this subscriber tracks. Stored for handler dispatch (the
   *  WS frame carries `accountId` per entity) and for log lines. */
  accountId: number;
  /** Demo vs live host override. Production code leaves this undefined
   *  and the deploy-env helper picks (prod → live, otherwise demo).
   *  Tests pass `"live"` or `"demo"` explicitly to exercise both URLs. */
  apiEnv?: "demo" | "live";
  /** Sync read of the contractId↔dated-symbol cache. The dispatcher uses
   *  this to map Tradovate's numeric `contractId` on each entity back to
   *  the engine-side string contractId stored on the trade row, so
   *  `findTradeByAccountContract` resolves the trade. On miss the
   *  dispatcher fires `warmContractId` and drops the event — the next
   *  event for the same contract reconciles. */
  getDatedSymbol?: ContractIdLookup;
  /** Lazy-warm hook invoked when the dispatcher hits a contractId miss
   *  on the lookup above. Fires once per id (single-flighted inside the
   *  client). The missed event is never dispatched under the numeric id —
   *  it would translate to the wrong contractId string and silently fail
   *  to reconcile. A position event is re-dispatched once the returned
   *  promise settles with the id mapped; every other entity is dropped. */
  warmContractId?: (numericContractId: number) => Promise<void> | void;
  /** WebSocket constructor override — tests pass a stub here. Production
   *  code leaves this undefined and the global `WebSocket` is used. */
  webSocketCtor?: typeof WebSocket;
}

type PositionHandler = (accountId: number, position: Position, raw: TradovatePosition) => void;
type OrderHandler = (accountId: number, order: Order, raw: TradovateOrder) => void;
type FillHandler = (accountId: number, fill: TradeFill, raw: TradovateFill) => void;
type ReconnectHandler = (accountId: number, lastEventAtBeforeReconnect: number) => void;
type SubscribedHandler = (accountId: number) => void;

/**
 * Per-frame staging slot for the WS `fill` + `fillFee` merge. Tradovate
 * splits fees off from the fill entity but emits them in the same SockJS
 * `a[...]` data frame, immediately following the fill, keyed by `fill.id`.
 * Per the Gate B probe (docs/proposals/tradovate-fill-feed-probe.md
 * §Additional findings #1 + #5).
 *
 * The dispatcher stages fills as they arrive within a frame, merges the
 * matching `fillFee` into `TradeFill.fees`, and dispatches via
 * `fillHandler` only after the merge (or at frame-end if the fillFee is
 * missing — degraded path: dispatch with `fees: null` and warn). The
 * staging slot is local to one `handleFrame` invocation; it must NOT
 * persist across frames or `fillFee` events from a later frame would
 * silently re-attach to a fill that was already dispatched.
 */
interface PendingFill {
  fill: TradeFill;
  raw: TradovateFill;
}

/**
 * Wrap the DB lookup in a try/catch so a transient sqlite error doesn't
 * cascade into the WS dispatcher. The caller treats `null` as "no
 * mapping" — matches the pre-existing-order miss path.
 */
function lookupOrderMapping(orderId: number): OrderMapping | null {
  try {
    return lookupByOrderId(orderId);
  } catch (err) {
    log.event(
      "order_map_unreadable",
      "tradovate.realtime",
      `tradovate_order_map lookup failed for orderId=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Mark-terminal wrapper that swallows DB errors — same rationale as
 *  lookup: a TTL-cleanup miss is recoverable, blocking the WS frame is
 *  not. */
function markOrderTerminal(orderId: number): void {
  try {
    markTerminal(orderId);
  } catch (err) {
    log.event(
      "order_map_unreadable",
      "tradovate.realtime",
      `tradovate_order_map markTerminal failed for orderId=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Re-create the customTag fragment shape that engine `buildCustomTag`
 * emits for Topstep: `<rolePrefix>_<8charShortId>_<ts>_<rand>`. Tradovate
 * doesn't echo the original customTag, so we synthesize one from the
 * stored mapping that matches what `verifyExitClean`'s secondary
 * customTag-fragment match expects. The fragment is `_<8charShortId>_`
 * (engine.ts:3960) so any tag carrying that substring resolves.
 *
 * The role prefix mirrors the engine's own conventions:
 *   - entry → "e"
 *   - sl/tp/exit → "x" (treated as exit-side cleanup at verifyExitClean)
 */
function synthesizeCustomTag(mapping: OrderMapping): string {
  const shortId = mapping.deploymentId.replace(/-/g, "").slice(0, 8);
  const prefix = mapping.role === "entry" ? "e" : "x";
  const placedAt = mapping.placedAt.toString(36);
  return `${prefix}_${shortId}_${placedAt}_tv`;
}

export class TradovateRealtime {
  private socket: WebSocket | null = null;
  private state: RealtimeConnectionState = "idle";
  private lastEventAtMs = 0;
  // The last event time seen on the feed before the socket dropped, handed
  // to the reconnect hook so the engine's missed-fills replay windows from
  // before the gap. `lastEventAtMs` cannot serve: the new socket's greeting
  // and authorize ack bump it to ~now before `onReconnect` fires, so a
  // disconnect longer than the replay pad would never be replayed. Set on
  // the first drop of a live session (a failed reconnect attempt's own drop
  // must not overwrite the good anchor with the handshake it just received)
  // and cleared once the hook has run.
  private reconnectAnchorMs: number | null = null;
  private subscribedAtMs: number | null = null;
  private lastErrorMsg: string | null = null;
  private reconnectAttempts = 0;
  private nextRequestId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inboundWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private authAckTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private positionHandler: PositionHandler | null = null;
  private orderHandler: OrderHandler | null = null;
  private fillHandler: FillHandler | null = null;
  private reconnectHandler: ReconnectHandler | null = null;
  private subscribedHandler: SubscribedHandler | null = null;

  /**
   * Per-frame fill staging map. Set at the top of `handleFrame` and
   * cleared at the bottom; never persists across frames. Keyed by
   * `fill.id` so the matching `fillFee` (same id) merges in O(1).
   * `null` outside a frame so accidental dispatches outside the frame
   * loop fall through (and would warn — but the dispatcher only runs
   * inside `handleFrame` anyway).
   */
  private pendingFillsThisFrame: Map<number, PendingFill> | null = null;

  /**
   * Tracks whether the subscriber has reached `subscribed` at least
   * once. The reconnect handler should fire on subscriber transitions
   * back to `subscribed` AFTER the initial subscribe — the first
   * subscribe is the cold-start path, not a reconnect. Mirrors
   * Topstep's broadcaster `status: reconnected` semantics.
   */
  private hasSubscribedOnce = false;

  // Rate-limit "contractId not in cache" warnings: at sync-time Tradovate
  // dumps a backlog of recent activity (often 30+ events for a handful
  // of contracts), which floods the log if every dropped event warns.
  // Track which numeric contractIds we've already warned about per
  // session; the warm fires on first miss and subsequent misses for
  // the same id are silent until the cache fills (or we reconnect, at
  // which point this set resets via clearWarnedMissingContracts).
  private warnedMissingContracts = new Set<number>();

  // Position frames held back per numeric contractId while its warm is in
  // flight, in arrival order. A frame for a contract with a queue joins it
  // even on a cache hit — another path (warmContractIdsForRoots) can fill
  // the cache first, and dispatching that newer frame before the held one
  // would leave the engine reading an open on a flat position.
  private heldPositions = new Map<number, Array<() => void>>();

  // Rate-limit "fill orderId not in tradovate_order_map" warnings: at
  // sync-time Tradovate replays recent activity, often including ~30
  // fills against bracket orders the engine didn't place (operator
  // orders, safety flattens, pre-existing orders from a prior session).
  // True orphans stay unmapped permanently — there's no clear-on-success
  // path the way `warnedMissingContracts` clears on cache fill — so the
  // first warn per orderId is the only one we ever fire.
  private warnedOrphanFillOrderIds = new Set<number>();

  // Phase 7 WS auth-failure tracking. `unhealthySinceMs` is set when the
  // subscriber first observes an auth-rejection or unrecoverable
  // connect-failure, and cleared on successful subscribe. `lastAuthAlertAtMs`
  // throttles the Discord alert to one per hour per subscriber.
  private unhealthySinceMs: number | null = null;
  private lastAuthAlertAtMs = 0;

  private readonly url: string;

  constructor(private opts: TradovateRealtimeOptions) {
    const useLive = opts.apiEnv != null ? opts.apiEnv === "live" : isProductionEnv();
    this.url = useLive ? LIVE_WS_URL : DEMO_WS_URL;
  }

  // ── Public API ────────────────────────────────────────────────────

  onPosition(handler: PositionHandler): void {
    this.positionHandler = handler;
  }
  onOrder(handler: OrderHandler): void {
    this.orderHandler = handler;
  }
  onFill(handler: FillHandler): void {
    this.fillHandler = handler;
  }
  /**
   * Fires when the subscriber transitions back to `subscribed` AFTER a
   * prior successful subscribe (i.e. on a real reconnect, not on the
   * initial connect). The Layer 1 buffer-backfill flow uses this to
   * scope a `searchTrades(...)` over the disconnect window per
   * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation.
   * Topstep's analog is the broadcaster's `status: reconnected` event.
   *
   * The handler is handed the last event time seen before the socket
   * dropped — the lower bound of the gap — because the live `lastEventAt`
   * has already been bumped to ~now by the new socket's handshake frames.
   */
  onReconnect(handler: ReconnectHandler): void {
    this.reconnectHandler = handler;
  }
  /**
   * Fires on every transition to `subscribed`, the first included. The
   * adapter needs the first one: a subscriber respawned on a rotated
   * client is a new instance, so its gap is never a reconnect here.
   */
  onSubscribed(handler: SubscribedHandler): void {
    this.subscribedHandler = handler;
  }

  /**
   * Open the socket and start the auth/subscribe flow. Idempotent —
   * concurrent or post-connect calls are no-ops; the engine's lifecycle
   * code calls `start()` once at boot per Tradovate-broker account.
   */
  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error("TradovateRealtime: start() called after dispose()");
    }
    if (this.state !== "idle" && this.state !== "auth-failed") return;
    await this.openSocket();
  }

  /**
   * Tear down the connection and stop all timers. Safe to call from
   * engine shutdown or sync() when a Tradovate-broker account is removed.
   * Idempotent.
   */
  dispose(): void {
    this.disposed = true;
    this.state = "disposed";
    this.heldPositions.clear();
    this.clearTimers();
    this.closeSocket("disposed");
  }

  /** Snapshot of the current connection state — engine reconciler reads
   *  `lastEventAt` to decide whether to skip its own per-account fan-out. */
  status(): RealtimeStatusSnapshot {
    return {
      state: this.state,
      lastEventAt: this.lastEventAtMs,
      subscribedAt: this.subscribedAtMs,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastErrorMsg,
    };
  }

  /** True iff the most recent inbound frame is fresh enough that the
   *  reconciler tick can defer per-account REST polling for this account. */
  isHealthy(now: number = Date.now()): boolean {
    if (this.state !== "subscribed") return false;
    if (this.lastEventAtMs === 0) return false;
    return now - this.lastEventAtMs <= INBOUND_SILENCE_RECONNECT_MS * 6;
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  private async openSocket(): Promise<void> {
    this.clearTimers();
    let token: string | null;
    try {
      token = await this.opts.getAccessToken();
    } catch (err) {
      this.lastErrorMsg = err instanceof Error ? err.message : String(err);
      this.state = "auth-failed";
      this.markUnhealthy();
      log.event(
        "ws_token_unavailable",
        "tradovate.realtime",
        `accessToken fetch failed for account ${this.opts.accountId}: ${this.lastErrorMsg}`,
        { accountId: this.opts.accountId },
      );
      this.scheduleReconnect();
      return;
    }
    if (!token) {
      this.lastErrorMsg = "no access token available";
      this.state = "auth-failed";
      this.markUnhealthy();
      log.event(
        "ws_token_unavailable",
        "tradovate.realtime",
        `no Tradovate access token for account ${this.opts.accountId} — deferring connect`,
        { accountId: this.opts.accountId },
      );
      this.scheduleReconnect();
      return;
    }
    this.state = "connecting";
    log.event(
      "ws_connecting",
      "tradovate.realtime",
      `account ${this.opts.accountId}: opening socket ${this.url} (attempt ${this.reconnectAttempts + 1})`,
      { accountId: this.opts.accountId },
    );
    let socket: WebSocket;
    try {
      const Ctor = this.opts.webSocketCtor ?? WebSocket;
      socket = new Ctor(this.url);
    } catch (err) {
      this.lastErrorMsg = err instanceof Error ? err.message : String(err);
      this.state = "auth-failed";
      this.markUnhealthy();
      log.event(
        "ws_socket_failed",
        "tradovate.realtime",
        `socket construct failed for account ${this.opts.accountId}: ${this.lastErrorMsg}`,
        { accountId: this.opts.accountId },
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      log.debug(
        "tradovate.realtime",
        `account ${this.opts.accountId}: socket open, awaiting server greeting`,
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      // Mark lastEventAt on every inbound frame — heartbeat 'h' frames
      // count too. The reconciler-tick health check only needs to know
      // the socket is alive, not whether the most recent frame was a
      // data event.
      this.lastEventAtMs = Date.now();
      const data = typeof event.data === "string" ? event.data : "";
      if (!data.length) return;
      this.handleFrame(data, token!);
    };
    socket.onerror = () => {
      // The browser/Node WS API doesn't surface error details on the
      // event itself; treat as a transport hint and let onclose drive
      // the reconnect.
      log.event(
        "ws_socket_failed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: socket error`,
        { accountId: this.opts.accountId },
      );
    };
    socket.onclose = (event: CloseEvent) => {
      const reason = event.reason || `code=${event.code}`;
      this.lastErrorMsg = reason;
      // Capture the pre-drop event time for the reconnect hook. Only the
      // first drop of a live session records it: a reconnect attempt that
      // itself fails and re-drops would otherwise overwrite the real anchor
      // with the handshake `lastEventAtMs` the failed attempt just bumped to
      // ~now. A drop before the first subscribe opened no gap worth
      // replaying, so `hasSubscribedOnce` gates it.
      if (this.hasSubscribedOnce && this.reconnectAnchorMs === null) {
        this.reconnectAnchorMs = this.lastEventAtMs;
      }
      log.event(
        "ws_disconnected",
        "tradovate.realtime",
        `account ${this.opts.accountId}: socket closed (${reason})`,
        { accountId: this.opts.accountId },
      );
      this.cleanupSocket();
      if (this.disposed) return;
      this.state = "reconnecting";
      this.scheduleReconnect();
    };
  }

  private handleFrame(data: string, token: string): void {
    const head = data[0];
    if (head === "o") {
      // Server greeting — send the authorize frame. Tradovate echoes the
      // requestId in its ack as the `i` field; sending an empty string makes
      // the server respond with `[{"s":200,"i":}]` (malformed JSON, fails
      // our parser) and the auth-ack timer fires, looping forever. Use the
      // request-id allocator so the ack is `[{"s":200,"i":1,...}]`.
      this.state = "authorizing";
      this.sendFrame("authorize", String(this.nextRequestId++), "", token);
      // Arm the auth-ack timer so a silent server doesn't strand us.
      this.authAckTimer = setTimeout(() => {
        log.event(
          "ws_socket_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: authorize ack timed out — reconnecting`,
          { accountId: this.opts.accountId },
        );
        this.closeSocket("auth-ack-timeout");
      }, AUTH_ACK_TIMEOUT_MS);
      return;
    }
    if (head === "h") {
      // Server heartbeat. lastEventAt was already bumped above.
      return;
    }
    if (head === "c") {
      // Close frame: `c[code, "reason"]`. Onclose will fire next.
      return;
    }
    if (head !== "a") {
      // Unknown frame type — log at debug to surface protocol drift
      // without flooding production logs.
      log.debug(
        "tradovate.realtime",
        `account ${this.opts.accountId}: unrecognized frame head '${head}'`,
      );
      return;
    }
    // SockJS data frame: `a[<json>, <json>, ...]`
    const body = data.slice(1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      log.event(
        "ws_socket_failed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: malformed data frame: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: this.opts.accountId },
      );
      return;
    }
    if (!Array.isArray(parsed)) return;
    // Per-frame fill+fillFee staging. Initialized for the duration of
    // this frame's iteration; flushed in `finally` so any staged fill
    // without a matching fillFee in this same frame dispatches via the
    // documented degraded path (fees: null, warn) instead of leaking
    // into a later frame's staging slot.
    this.pendingFillsThisFrame = new Map();
    try {
      for (const item of parsed) {
        this.handleMessage(item);
      }
    } finally {
      this.flushPendingFillsAtFrameEnd();
      this.pendingFillsThisFrame = null;
    }
  }

  /**
   * End-of-frame flush for the per-frame fill+fillFee staging slot.
   * Anything still in the map didn't get a matching `fillFee` in this
   * frame — dispatch via the degraded path (`fees: null` + warn) so
   * the engine sees the fill rather than dropping it. Layer 2's
   * `/fill/list` REST query heals later if needed.
   */
  private flushPendingFillsAtFrameEnd(): void {
    if (!this.pendingFillsThisFrame) return;
    if (this.pendingFillsThisFrame.size === 0) return;
    for (const { fill, raw } of this.pendingFillsThisFrame.values()) {
      log.event(
        "fill_fee_missing",
        "tradovate.realtime",
        `account ${this.opts.accountId}: fill received without same-frame fillFee — appending with fees=null (fillId=${fill.id} orderId=${fill.orderId})`,
        { accountId: this.opts.accountId, contractId: fill.contractId },
      );
      const degraded: TradeFill = { ...fill, fees: null };
      try {
        this.fillHandler?.(this.opts.accountId, degraded, raw);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: degraded fill dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId, contractId: fill.contractId },
        );
      }
    }
    this.pendingFillsThisFrame.clear();
  }

  private handleMessage(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    // Request/response: `{i: <id>, s: <status>, d: <payload>}`
    if (typeof m.s === "number" && typeof m.i === "number") {
      this.handleResponse(m.s, m.d);
      return;
    }
    // Streaming event: `{e: "props", d: <payload>}`
    if (typeof m.e === "string" && m.e === "props") {
      this.handlePropsEvent(m.d);
      return;
    }
    // Ignore other event types (md, shutdown, etc.) — we only consume
    // user-property props on this subscriber.
  }

  private callLifecycleHandler(
    handler: ((accountId: number) => void) | null,
    kind: string,
  ): void {
    try {
      handler?.(this.opts.accountId);
    } catch (err) {
      log.event(
        "frame_dispatch_failed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: ${kind} handler threw: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: this.opts.accountId },
      );
    }
  }

  private fireReconnectHandler(lastEventAtBeforeReconnect: number): void {
    try {
      this.reconnectHandler?.(this.opts.accountId, lastEventAtBeforeReconnect);
    } catch (err) {
      log.event(
        "frame_dispatch_failed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: reconnect handler threw: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: this.opts.accountId },
      );
    }
  }

  private handleResponse(status: number, payload: unknown): void {
    if (this.state === "authorizing") {
      if (this.authAckTimer) {
        clearTimeout(this.authAckTimer);
        this.authAckTimer = null;
      }
      if (status !== 200) {
        this.lastErrorMsg = `authorize failed status=${status} payload=${JSON.stringify(payload ?? null).slice(0, 200)}`;
        log.event(
          "ws_socket_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: ${this.lastErrorMsg}`,
          { accountId: this.opts.accountId },
        );
        this.markUnhealthy();
        this.closeSocket("auth-rejected");
        return;
      }
      log.event(
        "ws_subscribed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: authorized, sending user/syncRequest`,
        { accountId: this.opts.accountId },
      );
      // Authorized. Subscribe to user/syncRequest for this user id.
      this.sendFrame(
        "user/syncRequest",
        String(this.nextRequestId++),
        "",
        JSON.stringify({ users: [this.opts.userId] }),
      );
      this.state = "subscribed";
      this.subscribedAtMs = Date.now();
      this.reconnectAttempts = 0;
      this.lastErrorMsg = null;
      // Successful subscribe — clear the unhealthy marker so a future
      // failure starts a fresh 5-min grace window before alerting again.
      this.unhealthySinceMs = null;
      this.startHeartbeat();
      this.startInboundWatchdog();
      this.scheduleTokenRefresh();
      // Fire the reconnect hook once per resubscribe AFTER the cold-
      // start subscribe. Gate B's flow plus the Layer 1 reconnect-gap
      // mitigation per docs/proposals/userhub-trade-subscription.md.
      // The initial subscribe is the cold-start path (no buffer slots
      // to backfill); subsequent subscribes are real reconnects and
      // need the REST replay over the disconnect window.
      const isReconnect = this.hasSubscribedOnce;
      this.hasSubscribedOnce = true;
      // The pre-drop anchor rides the reconnect signal. A reconnect with no
      // recorded drop (only the synthetic test path reaches `subscribed`
      // without an `onclose`) falls back to the live stamp.
      const reconnectAnchor = this.reconnectAnchorMs ?? this.lastEventAtMs;
      this.reconnectAnchorMs = null;
      this.callLifecycleHandler(this.subscribedHandler, "subscribed");
      if (isReconnect) this.fireReconnectHandler(reconnectAnchor);
      return;
    }
    if (status !== 200 && status !== 304) {
      log.event(
        "ws_response_error",
        "tradovate.realtime",
        `account ${this.opts.accountId}: response status=${status} payload=${JSON.stringify(payload ?? null).slice(0, 200)}`,
        { accountId: this.opts.accountId },
      );
    }
    // user/syncRequest's initial snapshot lands here too — Tradovate
    // wraps it as `{users: [...], orders: [...], positions: [...], fills: [...]}`
    // (per the FAQ). Treat the snapshot the same as a streaming props
    // event so the engine sees both pre-existing state and post-snapshot
    // deltas through the same handler path.
    this.handlePropsPayload(payload);
  }

  private handlePropsEvent(payload: unknown): void {
    this.handlePropsPayload(payload);
  }

  /**
   * Translate any user-property payload into typed dispatch. Tradovate's
   * shape is loose — the snapshot returns named arrays, and streaming
   * deltas come as either `{entityType, entity}` pairs or as named
   * arrays of single-item updates. Defend both.
   */
  private handlePropsPayload(payload: unknown): void {
    if (payload === null || payload === undefined) return;
    if (Array.isArray(payload)) {
      for (const item of payload) this.handlePropsPayload(item);
      return;
    }
    if (typeof payload !== "object") return;
    const o = payload as Record<string, unknown>;

    // Entity-tagged shape: `{entityType: "fill", entity: {...}}` or
    // `{entityType: "position", eventType: "Updated", entity: {...}}`.
    if (typeof o.entityType === "string" && o.entity !== undefined) {
      this.dispatchEntity(o.entityType, o.entity);
      return;
    }

    // Snapshot/array shape: `{orders: [...], positions: [...], fills: [...]}`.
    for (const [key, value] of Object.entries(o)) {
      if (!Array.isArray(value)) continue;
      const singular = key.endsWith("s") ? key.slice(0, -1) : key;
      for (const item of value) {
        this.dispatchEntity(singular, item);
      }
    }
  }

  private dispatchEntity(entityType: string, entity: unknown): void {
    if (entity === null || typeof entity !== "object") return;
    const lower = entityType.toLowerCase();
    if (lower === "position") {
      const raw = entity as TradovatePosition;
      if (typeof raw.id !== "number" || typeof raw.accountId !== "number") return;
      if (raw.accountId !== this.opts.accountId) return;
      if (typeof raw.contractId !== "number") return;
      // A position is the one entity that is not sent again: Tradovate emits
      // one frame on open and one on close (tradovate.md), so a dropped open
      // — the sync snapshot after every boot, before the cache is warm — is
      // a position the engine never sees until it closes.
      const redispatch = () => this.dispatchEntity(entityType, entity);
      if (!this.ensureContractIdMapped(raw.contractId, "position", redispatch)) return;
      try {
        const translated = translatePosition(raw, this.opts.getDatedSymbol);
        this.positionHandler?.(this.opts.accountId, translated, raw);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: position dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId },
        );
      }
      return;
    }
    if (lower === "order") {
      const raw = entity as TradovateOrder;
      if (typeof raw.id !== "number" || typeof raw.accountId !== "number") return;
      if (raw.accountId !== this.opts.accountId) return;
      if (typeof raw.contractId !== "number") return;
      if (!this.ensureContractIdMapped(raw.contractId, "order")) return;
      try {
        // Look up the (orderId → deployment) mapping persisted at
        // placeOrder time so the engine's order-attribution path
        // (verifyExitClean's customTag fragment match) keeps working
        // for Tradovate even though Tradovate rejects unregistered
        // Tag50 echoes. On miss, fall through with a null mapping —
        // pre-Phase-X orders, operator-placed orders, and the
        // safety-flatten path won't have a row.
        const mapping = lookupOrderMapping(raw.id);
        const translated = translateOrder(raw, this.opts.getDatedSymbol);
        if (mapping) {
          translated.customTag = synthesizeCustomTag(mapping);
        }
        // Mark terminal once the order leaves the cancellable set —
        // filled, rejected, expired, etc. The TTL cleanup eventually
        // drops the row; until then it's available for late-arriving
        // fill lookups (Tradovate sometimes pushes the fill frame
        // before the order's terminal status update).
        if (
          mapping &&
          typeof raw.ordStatus === "string" &&
          !TRADOVATE_CANCELABLE_STATUSES.has(raw.ordStatus)
        ) {
          markOrderTerminal(raw.id);
        }
        this.orderHandler?.(this.opts.accountId, translated, raw);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: order dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId },
        );
      }
      return;
    }
    if (lower === "fill") {
      const raw = entity as TradovateFill;
      // Tradovate's WS `fill` entity has no `accountId` field —
      // accountId is implicit from the per-account socket binding (Gate B
      // probe finding). Don't gate on `raw.accountId` (always undefined)
      // and don't compare it against `this.opts.accountId`. The
      // translator stamps accountId from the socket binding below.
      if (typeof raw.id !== "number") {
        return;
      }
      if (typeof raw.contractId !== "number") {
        return;
      }
      if (!this.ensureContractIdMapped(raw.contractId, "fill")) {
        return;
      }
      // Resolve the order-id → deployment mapping. On miss (cold-boot
      // fill for a pre-existing order, operator-placed order, or
      // safety-flatten without a deployment) drop the event with a
      // logged warning — same defensive behavior as the contract-id
      // miss path above. We can't safely attribute it without a
      // mapping row.
      const mapping =
        typeof raw.orderId === "number" ? lookupOrderMapping(raw.orderId) : null;
      if (typeof raw.orderId === "number" && !mapping) {
        if (!this.warnedOrphanFillOrderIds.has(raw.orderId)) {
          this.warnedOrphanFillOrderIds.add(raw.orderId);
          // The one line the collapser was built for: a cold boot drops
          // ~23 of these in a single frame, every one carrying a different
          // order id. `burstKey` is what lets the pipe normalise those ids
          // out of the key — without it each id is its own row, which is
          // the correct default everywhere else.
          log.event(
            "orphan_fill_dropped",
            "tradovate.realtime",
            `account ${this.opts.accountId}: fill orderId=${raw.orderId} not in tradovate_order_map — dropping (pre-existing/operator order or safety flatten; subsequent fills for this orderId silent)`,
            {
              accountId: this.opts.accountId,
              contractId: String(raw.contractId),
              burstKey: "orphan_fill",
            },
          );
        }
        return;
      }
      try {
        const translated = translateFill(
          raw,
          this.opts.getDatedSymbol,
          this.opts.accountId,
        );
        // A fill frame is terminal evidence for the order — Tradovate
        // OSO is fill-or-kill at our usage so cumQty == orderQty
        // collapses to the same point. Mark terminal so the TTL
        // cleanup eventually drops the row.
        if (mapping) {
          markOrderTerminal(raw.orderId);
        }
        // Stage in the per-frame slot rather than dispatching now.
        // The matching `fillFee` arrives later in this same frame
        // (Gate B finding) and gets merged into `fees` before the
        // staged fill is dispatched. If frame-end runs before the
        // fillFee shows up, `flushPendingFillsAtFrameEnd` dispatches
        // via the degraded path. The map is always present here
        // because dispatch only runs from inside `handleFrame`.
        if (this.pendingFillsThisFrame) {
          this.pendingFillsThisFrame.set(translated.id, { fill: translated, raw });
        } else {
          // Defensive: if a future code path invokes dispatchEntity
          // outside `handleFrame`, fall back to direct dispatch with
          // the translator's null-fees default rather than swallow
          // the event.
          this.fillHandler?.(this.opts.accountId, translated, raw);
        }
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: fill dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId, contractId: String(raw.contractId) },
        );
      }
      return;
    }
    if (lower === "fillfee") {
      // Same-frame fee merge — Tradovate splits fees off from `fill`
      // and emits them as a sibling entity keyed by fill.id (Gate B
      // probe finding #1). Locate the staged fill, sum the four cost
      // components, and dispatch via fillHandler. If no staged fill
      // matches (shouldn't happen — fillFee always trails its fill in
      // the same frame per probe), drop with a debug log.
      const fee = entity as TradovateFillFee;
      if (typeof fee.id !== "number") return;
      const pending = this.pendingFillsThisFrame?.get(fee.id);
      if (!pending) {
        log.debug(
          "tradovate.realtime",
          `account ${this.opts.accountId}: fillFee id=${fee.id} no matching staged fill — dropping`,
        );
        return;
      }
      const total =
        (typeof fee.clearingFee === "number" ? fee.clearingFee : 0) +
        (typeof fee.exchangeFee === "number" ? fee.exchangeFee : 0) +
        (typeof fee.nfaFee === "number" ? fee.nfaFee : 0) +
        (typeof fee.commission === "number" ? fee.commission : 0);
      const merged: TradeFill = { ...pending.fill, fees: total };
      this.pendingFillsThisFrame?.delete(fee.id);
      try {
        this.fillHandler?.(this.opts.accountId, merged, pending.raw);
      } catch (err) {
        log.event(
          "frame_dispatch_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: merged fill dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId, contractId: pending.fill.contractId },
        );
      }
      return;
    }
    // Other entity types (cashBalance, account, etc.) ignored — engine
    // doesn't consume them today.
  }

  /**
   * Cache-or-warm the dated-symbol mapping for a numeric contractId.
   * Returns true when the mapping is in cache (dispatch may proceed) or
   * when no lookup was wired (translator falls back to stringified
   * numeric — preserves prior behavior). Returns false when a lookup is
   * wired but missed, after firing a single-flight warm — the dispatcher
   * holds this event back so the engine doesn't reconcile against a wrong
   * contractId. With `onMapped`, the event joins the contract's held queue
   * and is handed back, in arrival order, once the warm has mapped the id;
   * while that queue exists a cache hit joins it too. Without `onMapped`, or
   * when the warm cannot name the contract, the event is dropped.
   */
  private ensureContractIdMapped(
    numericContractId: number,
    entityKind: string,
    onMapped?: () => void,
  ): boolean {
    if (!this.opts.getDatedSymbol) return true;
    const held = onMapped ? this.heldPositions.get(numericContractId) : undefined;
    if (onMapped && held) {
      held.push(onMapped);
      return false;
    }
    if (this.opts.getDatedSymbol(numericContractId) !== null) {
      // Cache hit — clear any prior warning so a future miss on the
      // same id (after eviction) warns again.
      this.warnedMissingContracts.delete(numericContractId);
      return true;
    }
    if (!this.warnedMissingContracts.has(numericContractId)) {
      this.warnedMissingContracts.add(numericContractId);
      log.event(
        "contract_unmapped",
        "tradovate.realtime",
        `account ${this.opts.accountId}: ${entityKind} contractId ${numericContractId} not in dated-symbol cache — warming + ${onMapped ? "holding until mapped" : "dropping"} (subsequent events for this id silent until cache fills)`,
        { accountId: this.opts.accountId, contractId: String(numericContractId) },
      );
    }
    const warm = this.opts.warmContractId?.(numericContractId);
    if (onMapped && warm) {
      const queue = [onMapped];
      this.heldPositions.set(numericContractId, queue);
      // Settles either way: the client's warm swallows its own errors, and
      // an id still unmapped afterwards is dropped here rather than warmed
      // again, so a contract `/contract/item` cannot name never loops.
      const afterWarm = () => {
        if (this.heldPositions.get(numericContractId) !== queue) return;
        this.heldPositions.delete(numericContractId);
        if (this.disposed) return;
        if (this.opts.getDatedSymbol?.(numericContractId) == null) {
          log.event(
            "contract_unmapped",
            "tradovate.realtime",
            `account ${this.opts.accountId}: ${entityKind} contractId ${numericContractId} still unmapped after warm — ${queue.length} held frame(s) dropped`,
            { accountId: this.opts.accountId, contractId: String(numericContractId) },
          );
          return;
        }
        for (const redispatch of queue) redispatch();
      };
      void warm.then(afterWarm, afterWarm);
    }
    return false;
  }

  // ── Frame I/O ─────────────────────────────────────────────────────

  private sendFrame(name: string, requestId: string, query: string, body: string): void {
    if (!this.socket) return;
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const frame = `${name}\n${requestId}\n${query}\n${body}`;
    try {
      this.socket.send(frame);
    } catch (err) {
      log.event(
        "ws_send_failed",
        "tradovate.realtime",
        `account ${this.opts.accountId}: send '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: this.opts.accountId },
      );
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) return;
      if (this.socket.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send("[]");
      } catch (err) {
        log.event(
          "ws_send_failed",
          "tradovate.realtime",
          `account ${this.opts.accountId}: heartbeat send failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: this.opts.accountId },
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private startInboundWatchdog(): void {
    if (this.inboundWatchdogTimer) return;
    this.inboundWatchdogTimer = setInterval(() => {
      if (this.lastEventAtMs === 0) return;
      const silentMs = Date.now() - this.lastEventAtMs;
      if (silentMs > INBOUND_SILENCE_RECONNECT_MS) {
        log.event(
          "ws_inbound_silence",
          "tradovate.realtime",
          `account ${this.opts.accountId}: ${silentMs}ms inbound silence — forcing reconnect`,
          { accountId: this.opts.accountId },
        );
        this.closeSocket("inbound-silence");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleTokenRefresh(): void {
    if (!this.opts.getTokenExpiresAt) return;
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    const expiresAt = this.opts.getTokenExpiresAt();
    if (!expiresAt) return;
    const delay = expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS;
    // Already stale — getAccessToken() drives re-auth on next openSocket(); no 1s storm.
    if (delay <= 0) return;
    this.tokenRefreshTimer = setTimeout(() => {
      log.event(
        "ws_token_refresh",
        "tradovate.realtime",
        `account ${this.opts.accountId}: defensive token-refresh reconnect`,
        { accountId: this.opts.accountId },
      );
      this.closeSocket("token-refresh");
    }, delay);
  }

  // ── Reconnect ─────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    // Phase 7: every reconnect tick is a chance to fire the WS-auth-failure
    // Discord alert if the subscriber has been unhealthy for the grace
    // window AND the per-account hourly throttle has elapsed.
    this.maybeFireAuthFailureAlert();
    const delayIdx = Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[delayIdx];
    this.reconnectAttempts += 1;
    // First few attempts are operator-actionable (we're trying to recover);
    // after that the loop is steady-state noise and logs are demoted to
    // debug so an indefinitely auth-failed subscriber doesn't flood the
    // info channel with one line per backoff tick.
    const logFn = this.reconnectAttempts <= 3 ? log.info : log.debug;
    logFn(
      "tradovate.realtime",
      `account ${this.opts.accountId}: reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  // ── Cleanup helpers ───────────────────────────────────────────────

  private closeSocket(reason: string): void {
    if (!this.socket) return;
    try {
      this.socket.close(1000, reason);
    } catch {
      // ignore — onclose will still fire (or already fired)
    }
  }

  private cleanupSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.inboundWatchdogTimer) {
      clearInterval(this.inboundWatchdogTimer);
      this.inboundWatchdogTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    if (this.authAckTimer) {
      clearTimeout(this.authAckTimer);
      this.authAckTimer = null;
    }
    // Reset subscribed-at marker so the cold-start health window is
    // re-armed on the next subscribe rather than carrying stale credit.
    this.subscribedAtMs = null;
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }

  // ── Phase 7 auth-failure alert ────────────────────────────────────

  /**
   * Set the unhealthy-since timestamp on the first auth-failure of the
   * current cycle. Idempotent — repeated calls inside the same cycle
   * keep the original timestamp so the grace-window check uses the
   * actual unhealthy duration rather than resetting on every retry.
   */
  private markUnhealthy(): void {
    if (this.unhealthySinceMs === null) {
      this.unhealthySinceMs = Date.now();
    }
  }

  /**
   * Fire the WS auth-failure Discord alert if both:
   *  1. The subscriber has been unhealthy for >= the grace window.
   *  2. The last alert fired more than the re-alert interval ago (or
   *     no prior alert).
   * Called from `scheduleReconnect()` so every retry is a check
   * opportunity. Best-effort delivery; alert failure must not throw.
   */
  private maybeFireAuthFailureAlert(): void {
    if (this.unhealthySinceMs === null) return;
    const now = Date.now();
    const unhealthyMs = now - this.unhealthySinceMs;
    if (unhealthyMs < WS_AUTH_FAILURE_ALERT_AFTER_MS) return;
    if (now - this.lastAuthAlertAtMs < WS_AUTH_FAILURE_REALERT_MS) return;
    this.lastAuthAlertAtMs = now;
    const lastSubscribed =
      this.subscribedAtMs === null ? "never" : new Date(this.subscribedAtMs).toISOString();
    const lastEvent =
      this.lastEventAtMs === 0 ? "never" : new Date(this.lastEventAtMs).toISOString();
    void sendDiscordAlert({
      title: `Tradovate WS subscription auth failed for account ${this.opts.accountId}`,
      color: COLOR_WS_AUTH_FAILURE,
      timestamp: new Date(now).toISOString(),
      fields: [
        { name: "Account", value: String(this.opts.accountId), inline: true },
        { name: "State", value: this.state, inline: true },
        { name: "Reconnect attempts", value: String(this.reconnectAttempts), inline: true },
        {
          name: "Unhealthy duration",
          value: `${Math.round(unhealthyMs / 1000)}s`,
          inline: true,
        },
        { name: "Last subscribed at", value: lastSubscribed, inline: true },
        { name: "Last inbound event", value: lastEvent, inline: true },
        { name: "Last error", value: (this.lastErrorMsg ?? "—").slice(0, 1000) },
        {
          name: "Impact",
          value:
            "Reconciliation falls back to REST polling; live order/fill events for this account are blind until the WS recovers.",
        },
        {
          name: "Suggested action",
          value:
            "Verify Tradovate credentials in Settings — auth-failure mid-session usually means an expired or revoked access token.",
        },
      ],
    }).catch(() => {
      // Alert delivery is best-effort; failure must not throw out of
      // the reconnect path or break the subscriber's recovery loop.
    });
  }
}
