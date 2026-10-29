import type {
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
  TopstepSignalR,
} from "./signalr";

/**
 * The **user half** of `TopstepSignalR`, behind an interface.
 *
 * `TopstepSignalR` carries two independent connections. The user hub is
 * account events — orders, positions, fills — and is what
 * `BrokerRealtimeAdapter` covers. The market hub is the tape, owned by
 * `MarketHubController` and the `MarketDataProvider` seam, and **none of
 * its methods appear here**: no `subscribeTrades`, no `onTrade`, no
 * `buildMarketHub`. Adding one would re-couple market data to broker
 * identity.
 *
 * The interface exists so `TopstepRealtimeAdapter`'s ref-counting,
 * handler fan-out and reconnect bookkeeping are unit-testable against a
 * fake — the socket itself is not testable here (see
 * `docs/modules/testing/patterns.md`).
 */
export interface TopstepUserHubTransport {
  /** Build the hub WITHOUT starting it. Handlers must be registered
   *  between this and `start()` — SignalR drops anything that arrives
   *  before an `.on()` exists, including Topstep's `gatewaylogout`. */
  build(): void;
  start(): Promise<void>;
  /** Best-effort teardown; drops the hub instance so the next `build()`
   *  produces a fresh one with handlers re-registered pre-`start()`. */
  stop(): Promise<void>;
  /** Raw SignalR connection state, or `"NotBuilt"`. */
  state(): string;

  onOrder(handler: (order: GatewayUserOrder) => void): void;
  onPosition(handler: (position: GatewayUserPosition) => void): void;
  onUserTrade(handler: (trade: GatewayUserTrade) => void): void;
  onReconnected(handler: () => void): void;
  /** The socket dropped and SignalR's automatic reconnect is retrying. */
  onReconnecting(handler: (err?: Error) => void): void;
  onClose(handler: (err?: Error) => void): void;
  onGatewayLogout(handler: (reason: string) => void): void;

  /** Subscribe orders + positions + trades for one account. */
  subscribeAccount(accountId: number): Promise<void>;
  unsubscribeAccount(accountId: number): Promise<void>;
}

export class SignalRUserHubTransport implements TopstepUserHubTransport {
  constructor(private readonly signalr: TopstepSignalR) {}

  build(): void {
    this.signalr.buildUserHub();
  }

  async start(): Promise<void> {
    await this.signalr.startUserHub();
  }

  async stop(): Promise<void> {
    await this.signalr.disconnectUser();
  }

  state(): string {
    return this.signalr.getUserHubState();
  }

  onOrder(handler: (order: GatewayUserOrder) => void): void {
    this.signalr.onOrderUpdate(handler);
  }

  onPosition(handler: (position: GatewayUserPosition) => void): void {
    this.signalr.onPositionUpdate(handler);
  }

  onUserTrade(handler: (trade: GatewayUserTrade) => void): void {
    this.signalr.onUserTrade(handler);
  }

  onReconnected(handler: () => void): void {
    this.signalr.onUserReconnected(handler);
  }

  onReconnecting(handler: (err?: Error) => void): void {
    this.signalr.onUserReconnecting(handler);
  }

  onClose(handler: (err?: Error) => void): void {
    this.signalr.onUserClose(handler);
  }

  onGatewayLogout(handler: (reason: string) => void): void {
    this.signalr.onUserGatewayLogout(handler);
  }

  async subscribeAccount(accountId: number): Promise<void> {
    await Promise.all([
      this.signalr.subscribeOrders(accountId),
      this.signalr.subscribePositions(accountId),
      this.signalr.subscribeUserTrades(accountId),
    ]);
  }

  async unsubscribeAccount(accountId: number): Promise<void> {
    await Promise.all([
      this.signalr.unsubscribeOrders(accountId),
      this.signalr.unsubscribePositions(accountId),
      this.signalr.unsubscribeUserTrades(accountId),
    ]);
  }
}
