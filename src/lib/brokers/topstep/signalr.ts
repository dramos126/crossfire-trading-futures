import * as signalR from "@microsoft/signalr";
import { log } from "@/lib/logger";

const HUB_URL = process.env.NEXT_PUBLIC_TOPSTEP_HUB_URL ?? "https://rtc.topstepx.com/hubs";

// ── Event payload types ─────────────────────────────────────────────

export interface GatewayTrade {
  price: number;
  timestamp: string;
  type: number;
  volume: number;
}

export interface GatewayUserOrder {
  id: number;
  accountId: number;
  contractId: string;
  symbolId: string;
  creationTimestamp: string;
  updateTimestamp: string;
  status: number;
  type: number;
  side: number;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  fillVolume: number;
  filledPrice: number | null;
  customTag: string | null;
}

export interface GatewayUserPosition {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: number;
  size: number;
  averagePrice: number;
}

export interface GatewayUserTrade {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  /** Null on an opening fill, non-null on a closing one — the only
   *  entry/exit discriminator Topstep's feed carries. */
  profitAndLoss: number | null;
  fees: number;
  side: number;
  size: number;
  voided: boolean;
  orderId: number;
}

// ── Handler types ───────────────────────────────────────────────────

export type TradeHandler = (contractId: string, trade: GatewayTrade) => void;
export type OrderHandler = (order: GatewayUserOrder) => void;
export type PositionHandler = (position: GatewayUserPosition) => void;
export type UserTradeHandler = (trade: GatewayUserTrade) => void;

/**
 * Topstep delivers every user-hub event (`GatewayUserOrder`,
 * `GatewayUserPosition`, `GatewayUserTrade`) as a single arg with shape
 * `{ action: number, data: <payload> }`. Strip the envelope when present
 * and return the inner payload; fall back to the raw arg if a future
 * gateway version drops the wrapper.
 */
function unwrapUserHubPayload(args: unknown[]): unknown {
  if (args.length !== 1) return null;
  const a = args[0];
  if (a == null || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  if ("data" in rec && rec.data != null && typeof rec.data === "object") {
    return rec.data;
  }
  return rec;
}

// ── SignalR Manager ─────────────────────────────────────────────────

export class TopstepSignalR {
  private userHub: signalR.HubConnection | null = null;
  private marketHub: signalR.HubConnection | null = null;
  // Trade handler intent stored at registration so buildMarketHub can
  // re-attach to a fresh hub instance — covers both the rebuild case
  // (kick → reconnect) and the race where a caller registers before
  // buildMarketHub has run.
  private tradeHandler: TradeHandler | null = null;
  // The one function every market hub registers for trades. Replaying
  // `tradeHandler` itself put the previous closure on the rebuilt hub beside
  // the one `onTrade` then added — SignalR de-duplicates only an identical
  // function — so every print after a rebuild reached the engine twice.
  private readonly dispatchTrade: TradeHandler = (contractId, trade) =>
    this.tradeHandler?.(contractId, trade);

  constructor(private getToken: () => string | null) {}

  /** Diagnostics — read the underlying SignalR connection state for the
   *  engine's heartbeat. Returns "Disconnected" when the hub hasn't been
   *  built yet (vs. signalR's "Disconnected" after a tear-down — same
   *  string, ambiguous, but the engine's mode field disambiguates). */
  getMarketHubState(): string {
    return this.marketHub?.state ?? "NotBuilt";
  }
  getUserHubState(): string {
    return this.userHub?.state ?? "NotBuilt";
  }

  // ── Connection management ─────────────────────────────────────────

  /**
   * Build the user hub WITHOUT starting it. Caller must register every
   * handler (`.on(...)`, `.onclose(...)`, etc.) before calling
   * `startUserHub()`. Handlers attached after `start()` resolves miss
   * messages that arrived during the gap — including server-sent kick
   * notices like `gatewaylogout`. Standalone repro proved this matters:
   * registering handlers pre-start kept the connection alive; post-start
   * registration looked like a "clean close with no reason" because the
   * gatewaylogout message arrived before our `.on()` ran.
   */
  buildUserHub(): signalR.HubConnection {
    this.userHub = this.buildHub("/user");
    return this.userHub;
  }

  async startUserHub(): Promise<void> {
    if (!this.userHub) throw new Error("buildUserHub must be called first");
    await this.userHub.start();
    log.debug("signalr", "User hub connected");
  }

  /** Convenience: build + start in one shot. Only safe when the caller
   *  doesn't need to register handlers (rare; almost always use
   *  buildUserHub + register handlers + startUserHub). */
  async connectUserHub(): Promise<void> {
    this.buildUserHub();
    await this.startUserHub();
  }

  buildMarketHub(): signalR.HubConnection {
    this.marketHub = this.buildHub("/market");
    // Re-attach any handler the caller had registered against a previous
    // (now-discarded) marketHub instance. Without this, callers had to
    // remember to re-call onTrade after every rebuild — and the race
    // where a caller registered *before* the first buildMarketHub
    // (broadcaster constructed during initRealtime's await on
    // validateOrRefreshToken) silently dropped the handler entirely. We
    // store the handler intent on the SignalR instance and replay it on
    // every build so timing no longer matters.
    this.marketHub.on("GatewayTrade", this.dispatchTrade);
    return this.marketHub;
  }

  async startMarketHub(): Promise<void> {
    if (!this.marketHub) throw new Error("buildMarketHub must be called first");
    await this.marketHub.start();
    log.debug("signalr", "Market hub connected");
  }

  async connectMarketHub(): Promise<void> {
    this.buildMarketHub();
    await this.startMarketHub();
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.userHub?.stop(),
      this.marketHub?.stop(),
    ]);
    log.debug("signalr", "Disconnected");
  }

  /**
   * Tear down only the market hub. Used by the engine's passive-mode
   * reconnect loop: when a clean close has wedged the existing hub instance
   * (state=Disconnected, withAutomaticReconnect already gave up), we need
   * to drop it and build a fresh one. Stop is best-effort — if the hub is
   * already torn down on the server side, the local stop() can throw and
   * we don't care.
   */
  async disconnectMarket(): Promise<void> {
    try {
      await this.marketHub?.stop();
    } catch {
      // ignore
    }
    this.marketHub = null;
  }

  /**
   * Tear down only the user hub. Mirrors `disconnectMarket()` for the engine's
   * user-hub auto-heal path: when the hub is wedged (Disconnected state, no
   * traffic, automatic reconnect exhausted), drop it so the broadcaster's
   * `connectUserHub()` can build a fresh instance with handlers re-registered
   * pre-`start()`. Best-effort stop — already-torn-down hubs throw locally and
   * we don't care.
   */
  async disconnectUser(): Promise<void> {
    try {
      await this.userHub?.stop();
    } catch {
      // ignore
    }
    this.userHub = null;
  }

  /**
   * Fires after either hub finishes a successful reconnect. Use this to
   * re-invoke Subscribe* (they are cleared on the server when the connection
   * drops) and to re-fetch REST snapshot data so we can't be left holding
   * stale state for events that fired while disconnected.
   */
  onUserReconnected(handler: () => void): void {
    this.userHub?.onreconnected(() => handler());
  }

  onMarketReconnected(handler: () => void): void {
    this.marketHub?.onreconnected(() => handler());
  }

  /**
   * Fires when the user hub's socket drops and `withAutomaticReconnect`
   * takes over. `onclose` stays silent through that — it fires only once the
   * retries run out — so this is the only place a drop's error is visible.
   */
  onUserReconnecting(handler: (err?: Error) => void): void {
    this.userHub?.onreconnecting((err) => handler(err));
  }

  /**
   * Fires when either hub closes — clean shutdown, network drop, or a
   * server-initiated disconnect. SignalR's `onclose` doesn't tell us *why*
   * the server kicked us; that comes via `onGatewayLogout` (Topstep sends a
   * `gatewaylogout` server method right before closing in the
   * "Multiple sessions detected" case). Register both for a complete picture.
   */
  onUserClose(handler: (err?: Error) => void): void {
    this.userHub?.onclose((err) => handler(err));
  }

  onMarketClose(handler: (err?: Error) => void): void {
    this.marketHub?.onclose((err) => handler(err));
  }

  /**
   * Topstep's "you've been kicked because another session opened" notice.
   * Fires *before* the connection actually closes; the message is the human
   * reason ("Multiple sessions detected. Exchange regulations permit only
   * one active device session..."). Confirmed via standalone repro script.
   */
  onUserGatewayLogout(handler: (reason: string) => void): void {
    this.userHub?.on("gatewaylogout", (msg: string) => handler(String(msg)));
  }

  onMarketGatewayLogout(handler: (reason: string) => void): void {
    this.marketHub?.on("gatewaylogout", (msg: string) => handler(String(msg)));
  }

  // ── Market data subscriptions ─────────────────────────────────────

  /** Replaces the trade handler; the hub's dispatcher reads it per print.
   *  SignalR lower-cases method names, so one registration covers either
   *  casing the gateway sends. */
  onTrade(handler: TradeHandler): void {
    this.tradeHandler = handler;
  }

  async subscribeTrades(contractId: string): Promise<void> {
    await this.invokeWhenReady(this.marketHub, "SubscribeContractTrades", contractId);
  }

  async unsubscribeTrades(contractId: string): Promise<void> {
    await this.invokeWhenReady(this.marketHub, "UnsubscribeContractTrades", contractId);
  }

  // ── User data subscriptions ───────────────────────────────────────

  onOrderUpdate(handler: OrderHandler): void {
    // Topstep wraps every user-hub event as a single arg with shape
    // `{ action: number, data: GatewayUser{Order,Position,Trade} }`. Unwrap
    // the envelope first, then validate the inner payload structurally so
    // we still reject a stray malformed event without silently no-oping.
    // Register both casings: SignalR event matching is case-sensitive.
    const wrap = (...args: unknown[]) => {
      const payload = unwrapUserHubPayload(args);
      if (
        payload != null &&
        typeof payload === "object" &&
        "id" in payload &&
        "accountId" in payload &&
        "customTag" in payload
      ) {
        handler(payload as GatewayUserOrder);
        return;
      }
      log.event(
        "frame_unparseable",
        "topstep",
        `GatewayUserOrder: no recognizable payload (length=${args.length})`,
      );
    };
    this.userHub?.on("GatewayUserOrder", wrap);
    this.userHub?.on("gatewayuserorder", wrap);
  }

  onPositionUpdate(handler: PositionHandler): void {
    const wrap = (...args: unknown[]) => {
      const payload = unwrapUserHubPayload(args);
      if (
        payload != null &&
        typeof payload === "object" &&
        "contractId" in payload &&
        "size" in payload &&
        typeof (payload as Record<string, unknown>).size === "number"
      ) {
        handler(payload as GatewayUserPosition);
        return;
      }
      log.event(
        "frame_unparseable",
        "topstep",
        `GatewayUserPosition: no recognizable payload (length=${args.length})`,
      );
    };
    this.userHub?.on("GatewayUserPosition", wrap);
    this.userHub?.on("gatewayuserposition", wrap);
  }

  onUserTrade(handler: UserTradeHandler): void {
    const wrap = (...args: unknown[]) => {
      const payload = unwrapUserHubPayload(args);
      if (
        payload != null &&
        typeof payload === "object" &&
        "price" in payload &&
        "orderId" in payload
      ) {
        handler(payload as GatewayUserTrade);
        return;
      }
      log.event(
        "frame_unparseable",
        "topstep",
        `GatewayUserTrade: no recognizable payload (length=${args.length})`,
      );
    };
    this.userHub?.on("GatewayUserTrade", wrap);
    this.userHub?.on("gatewayusertrade", wrap);
  }

  async subscribeOrders(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "SubscribeOrders", accountId);
  }

  async subscribePositions(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "SubscribePositions", accountId);
  }

  async subscribeUserTrades(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "SubscribeTrades", accountId);
  }

  async unsubscribeOrders(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "UnsubscribeOrders", accountId);
  }

  async unsubscribePositions(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "UnsubscribePositions", accountId);
  }

  async unsubscribeUserTrades(accountId: number): Promise<void> {
    await this.invokeWhenReady(this.userHub, "UnsubscribeTrades", accountId);
  }

  async subscribeAccounts(): Promise<void> {
    await this.invokeWhenReady(this.userHub, "SubscribeAccounts");
  }

  /**
   * Wait for `hub` to reach the Connected state, then invoke `method`.
   * Topstep's gateway will accept the WS handshake (so `start()` resolves)
   * but briefly leave the hub in Reconnecting state immediately after,
   * causing every Subscribe* invoke to fail with "not in 'Connected'
   * state". Polling the hub.state cheaply absorbs that race without
   * forcing every caller to know about it.
   *
   * Bounded retry: gives up after ~3s and surfaces the original error so a
   * truly-dead hub still reports loudly. SignalR's withAutomaticReconnect
   * keeps trying in the background, and the open-contracts effect re-runs
   * once the connection is restored.
   */
  private async invokeWhenReady(
    hub: signalR.HubConnection | null,
    method: string,
    ...args: unknown[]
  ): Promise<void> {
    if (!hub) return;
    const POLL_MS = 100;
    const MAX_WAIT_MS = 3000;
    const deadline = Date.now() + MAX_WAIT_MS;
    while (
      hub.state !== signalR.HubConnectionState.Connected &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await hub.invoke(method, ...args);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private buildHub(path: string): signalR.HubConnection {
    if (!this.getToken()) {
      throw new Error(
        "SignalR hub build attempted with no auth token — caller must mint/validate via validateOrRefreshToken() before connecting",
      );
    }
    const requireToken = (): string => {
      const t = this.getToken();
      if (!t) {
        throw new Error("SignalR accessTokenFactory called with no token — session is unauthenticated");
      }
      return t;
    };
    const isNode = typeof window === "undefined";
    const options: signalR.IHttpConnectionOptions & { WebSocket?: SocketConstructor } = {
      accessTokenFactory: requireToken,
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
      // Per Topstep / ProjectX realtime docs example. Sets the
      // handshake timeout — without it we use the SignalR client
      // default, and the docs explicitly include 10000ms here.
      timeout: 10000,
    };
    if (isNode) options.WebSocket = bearerInQuerySocket(requireToken);
    return new signalR.HubConnectionBuilder()
      .withUrl(`${HUB_URL}${path}`, options)
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();
  }
}

type SocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

const ACCESS_TOKEN_QUERY_PARAM = "access_token";

/**
 * Topstep authenticates the WS upgrade off `?access_token=` and ignores the
 * Authorization header — which is where @microsoft/signalr puts the bearer on
 * Node, so the socket opens and is dropped mid-handshake. The token used to be
 * baked into the hub URL instead, where SignalR holds it, logs it (`WebSocket
 * connected to <url>`) and replays it unchanged on every automatic reconnect
 * (bugs.md A4). Appending it here, at the one call that opens the socket, keeps
 * it out of every URL SignalR sees and reads it fresh on each connect.
 *
 * `WebSocket` is SignalR's `@internal` constructor option; on Node it
 * otherwise loads `ws`. Node's global WebSocket is what the Tradovate realtime
 * feed already runs on. The third constructor argument SignalR passes (the
 * Authorization and User-Agent headers) is dropped on purpose.
 */
function bearerInQuerySocket(requireToken: () => string): SocketConstructor {
  return class BearerInQuerySocket extends globalThis.WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      const withToken = new URL(url);
      withToken.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, requireToken());
      super(withToken, protocols);
    }
  };
}
