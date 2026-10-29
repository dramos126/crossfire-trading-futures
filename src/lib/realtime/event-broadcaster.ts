import type { Position, TradeFill } from "@/lib/brokers/types";
import type { WireLogRecord } from "@/lib/logging/pipe";
import { log } from "@/lib/logger";
import type { EngineStatus } from "@/lib/trading/engine/handle";

/** The shortest gap between two `engineStatus` frames, and how soon a change
 *  reaches a listener. The status is sampled at this cadence rather than
 *  emitted from each writer because half of it is a clock reading: the
 *  market-data slot goes `stale` and `down` with time and no event marks the
 *  crossing. */
export const STATUS_PUSH_MIN_MS = 1_000;

/**
 * In-process pub/sub for realtime app events.
 *
 * The engine owns the broker connections — Topstep enforces one SignalR
 * session per user, so the browser cannot open its own — and this
 * broadcaster fans those events out to any in-process listener (today,
 * the SSE route that streams to the browser). It also carries events the
 * engine emits itself (`strategyTrade`), which is why the envelope is
 * app-wide rather than a broker's.
 *
 * It owns **no connection**. Account events arrive from a
 * `UserEventSource` — the broker realtime adapter — and market-hub trade
 * subscriptions go out through a `MarketTradeSubscriber` port. Neither
 * names a broker. Do not reintroduce a `TopstepSignalR` here: the user
 * hub's lifecycle belongs to the adapter and the market hub's to
 * `MarketHubController`.
 *
 * Design notes:
 *   - Market-hub trade ticks are forwarded as `marketTrade` events and
 *     the browser uses `lastPrice` as the mark for live unrealized PnL.
 *   - Subscribers are identified by a short string key so we can
 *     add/remove without equality-comparing function references.
 */

/**
 * Account-event source. Implemented by `BrokerRealtimeAdapter`s that can
 * also be *held open* by a non-engine holder — the browser needs a live
 * feed for accounts it is watching whether or not the engine trades them.
 */
export interface UserEventSource {
  /** Hold the feed open on behalf of `key`, pinning `accountIds`. Rejects
   *  if the transport cannot be brought up. */
  retain(key: string, accountIds: number[]): Promise<void>;
  isConnected(): boolean;
  onPosition(handler: (accountId: number, position: Position) => void): void;
  onFill(handler: (accountId: number, fill: TradeFill) => void): void;
  onStatus(handler: (connected: boolean, reason?: string) => void): void;
}

/** Market-hub trade subscription port. The market hub itself stays with
 *  `MarketHubController`; this is only the per-contract subscribe the
 *  browser's unrealized-PnL mark needs. */
export interface MarketTradeSubscriber {
  subscribe(contractId: string): Promise<void>;
  unsubscribe(contractId: string): Promise<void>;
}

export interface BroadcasterDeps {
  userEvents: UserEventSource;
  marketTrades: MarketTradeSubscriber;
  /** Translate an id the browser named a contract by into the id its market
   *  data arrives under (`"MNQM6"` → `"CON.F.US.MNQ.M26"`; a market-data id
   *  answers itself). `null` is "cannot tell" — the caller subscribes the id
   *  as given and re-asks next time rather than guessing. */
  marketDataContractId(contractId: string): Promise<string | null>;
  /** What `/api/engine {action:"status"}` answers, read now. Absent, no
   *  `engineStatus` frame is sent. */
  engineStatus?(): EngineStatus;
}

export type BroadcastEvent =
  | { kind: "position"; payload: Position }
  | { kind: "userTrade"; payload: TradeFill }
  // Market trade tick keyed by contractId. The browser stores lastPrice
  // straight into state.quotes[contractId] and unrealizedForPosition picks
  // it up unchanged.
  | { kind: "marketTrade"; contractId: string; lastPrice: number; timestamp: string }
  // Engine-emitted, NOT a broker hub event. Fires when the engine writes
  // closeTrade(...) for a strategy_trades row, so the browser's per-row
  // PnL surfaces (Strategies PnL, deployment-trades) can refresh in
  // lockstep with the hero's Session PnL (which already updates from
  // userTrade in ~ms).
  | { kind: "strategyTrade"; accountId: number; deploymentId: string }
  // App-emitted, NOT a broker hub event, and deliberately payload-free.
  // Fires when a deployment is created, edited, paused, destroyed, settled
  // or orphaned — anywhere the deployment set changes. Same shape as
  // `strategyTrade`: an invalidation signal, not a row. The client refetches
  // through `/api/deployments`, which already owns the serialization, so the
  // wire carries no second copy of a row shape to keep in step. Without it a
  // second tab never learns — `useDeployments` hydrates once on mount and
  // nothing re-reads the list on a timer.
  | { kind: "deploymentsChanged" }
  // Engine-emitted and payload-free, on the same shape: a leg's setup reading
  // (the dashboard's ARMED chip) changed. The client re-reads the map from
  // `POST /api/engine {action:"status"}`, which owns its serialization. Fires
  // on change only, never per bar.
  | { kind: "setupsChanged" }
  // Engine-emitted, and payload-free on the same shape: a `strategy_trades`
  // row was written. The client refetches `/api/trades`. Unlike
  // `strategyTrade` it fires on every write — entry, fill, bracket, exit.
  | { kind: "tradesChanged" }
  // The engine status, whole — a payload rather than a signal, because the
  // sampler has already read it and a re-read would cost a round trip per
  // listener. Sent when it changes, at most once per STATUS_PUSH_MIN_MS —
  // which is every sample while a stale or down feed's reason counts seconds.
  | { kind: "engineStatus"; status: EngineStatus }
  // One `/logs` ring line, projected for the wire exactly as the logs read
  // projects it. A folded repeat re-sends its line with the climbed count.
  | { kind: "logLine"; record: WireLogRecord }
  | { kind: "status"; connected: boolean; reason?: string };

/**
 * What decides whether a sampled status is news. The last-tick clock moves on
 * every trade and nothing renders it, so it is left out; everything else —
 * including the bar clock and a failing read's reason — counts. That is rare
 * while the feed is healthy, but a stale or down feed's reason counts the
 * seconds, so then a frame goes out on every sample: one a second, bounded by
 * the sampler, while the feed is in that state.
 */
function statusChangeKey(status: EngineStatus): string {
  const realtime = status.health.marketData.realtime;
  return JSON.stringify({
    ...status,
    health: {
      ...status.health,
      marketData: { ...status.health.marketData, realtime: { ...realtime, lastFeedTickAt: null } },
    },
  });
}

export type EventListener = (event: BroadcastEvent) => void;

export class EventBroadcaster {
  private listeners: Map<string, EventListener> = new Map();
  /** Accounts a browser has asked for. Pinned on the user-event source so
   *  the feed covers them even when the engine has no deployment there. */
  private trackedAccounts: Set<number> = new Set();
  /** Contracts the engine is tracking for trade-tick forwarding — browsers
   *  set this so we re-subscribe trades on reconnect. Held as the browser
   *  named them, which for a Tradovate position is the execution symbol. */
  private trackedContracts: Set<string> = new Set();
  /** Market-data id per tracked contract, once resolved. Only successful
   *  resolutions land here, so an id that could not be told stays absent and
   *  is re-asked on the next `ensureRunning`. */
  private marketIds: Map<string, string> = new Map();
  /** Reverse of `marketIds`: every browser-facing id that wants the ticks
   *  arriving under one market-data id. */
  private aliases: Map<string, Set<string>> = new Map();
  /** Last `(price, timestamp)` emitted per contract id, so one tick reaching
   *  this class twice — once under the hub id and once under the execution
   *  alias the engine's own sub already knew — costs one frame, not two. */
  private lastTick: Map<string, string> = new Map();
  /** Runs only while something listens; nothing reads a status nobody hears. */
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusKey: string | null = null;
  private relayingLogLine = false;

  constructor(private readonly deps: BroadcasterDeps) {
    this.deps.userEvents.onPosition((_accountId, position) => {
      this.emit({ kind: "position", payload: position });
    });
    this.deps.userEvents.onFill((_accountId, fill) => {
      this.emit({ kind: "userTrade", payload: fill });
    });
    this.deps.userEvents.onStatus((connected, reason) => {
      this.emit({ kind: "status", connected, reason });
    });
  }

  // ── Listener management ────────────────────────────────────────────

  subscribe(key: string, listener: EventListener): void {
    this.listeners.set(key, listener);
    this.armStatusPush();
  }

  unsubscribe(key: string): void {
    this.listeners.delete(key);
    if (this.listeners.size === 0) this.disarmStatusPush();
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  getConnectedState(): boolean {
    return this.deps.userEvents.isConnected();
  }

  /** Snapshot of tracked accounts so the SSE route can request the browser's
   *  current accounts be added without needing to inspect engine state. */
  getTrackedAccounts(): number[] {
    return Array.from(this.trackedAccounts);
  }

  /**
   * Engine-emitted: forward a market trade tick to every SSE listener.
   * Called from the engine's `handleTrade` after bar aggregation so the
   * browser gets the same tick stream the engine uses for bar building.
   * `lastPrice` becomes the mark for unrealized-PnL calc.
   *
   * **Also fans the tick out under every alias the browser asked for**, so
   * a position the engine holds no market sub for — a manual Tradovate
   * position, or one stranded on a paused deployment — still gets a mark
   * keyed the way its position is keyed. The engine's own alias emit is
   * scoped to a live sub and covers only the deployment case; this is what
   * makes the browser's own subscription the thing that decides.
   */
  emitMarketTrade(contractId: string, lastPrice: number, timestamp: string): void {
    this.emitTick(contractId, lastPrice, timestamp);
    const aliases = this.aliases.get(contractId);
    if (!aliases) return;
    for (const alias of aliases) this.emitTick(alias, lastPrice, timestamp);
  }

  private emitTick(contractId: string, lastPrice: number, timestamp: string): void {
    const tick = `${lastPrice}@${timestamp}`;
    if (this.lastTick.get(contractId) === tick) return;
    this.lastTick.set(contractId, tick);
    this.emit({ kind: "marketTrade", contractId, lastPrice, timestamp });
  }

  /** Engine-only emitter for the synthetic `strategyTrade` event. Called
   *  by the engine after closeTrade(...) writes a row, so the browser's
   *  per-row PnL surfaces refresh in lockstep with the hero's session
   *  PnL instead of waiting on the 5s /api/trades poll. */
  emitStrategyTradeClosed(accountId: number, deploymentId: string): void {
    this.emit({ kind: "strategyTrade", accountId, deploymentId });
  }

  /** App-emitted invalidation for the deployment set. Called from every
   *  lifecycle mutation — the routes that already re-sync the engine, plus
   *  the two engine-side writers (settle/reap and the orphan sweep) whose
   *  status change no request is waiting on. Carries nothing: the client
   *  refetches the list rather than patching a row off the wire. */
  emitDeploymentsChanged(): void {
    this.emit({ kind: "deploymentsChanged" });
  }

  /** Engine-only invalidation for the per-leg setup readings. Carries nothing:
   *  the client re-reads them off the engine status route. */
  emitSetupsChanged(): void {
    this.emit({ kind: "setupsChanged" });
  }

  /** Invalidation for the strategy trade rows, sent on every row write. */
  emitTradesChanged(): void {
    this.emit({ kind: "tradesChanged" });
  }

  /**
   * One `/logs` ring line, already projected for the wire. `debug` lines stay
   * off the stream: they are the per-frame firehose a non-prod build opts
   * into, and every listener would pay for them; the logs read still has them.
   */
  emitLogLine(record: WireLogRecord): void {
    if (record.severity === "debug") return;
    // A listener that throws is logged, and that line lands back here. Its
    // own frame is dropped rather than recursing through the same listener.
    if (this.relayingLogLine) return;
    this.relayingLogLine = true;
    try {
      this.emit({ kind: "logLine", record });
    } finally {
      this.relayingLogLine = false;
    }
  }

  private armStatusPush(): void {
    const read = this.deps.engineStatus;
    if (this.statusTimer || !read) return;
    this.statusTimer = setInterval(() => this.pushEngineStatus(read), STATUS_PUSH_MIN_MS);
  }

  private disarmStatusPush(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    // A listener that joins later gets the status on the first sample.
    this.lastStatusKey = null;
  }

  private pushEngineStatus(read: () => EngineStatus): void {
    let status: EngineStatus;
    try {
      status = read();
    } catch {
      // A throw out of a timer ends the process; the next sample asks again.
      return;
    }
    const key = statusChangeKey(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit({ kind: "engineStatus", status });
  }

  // ── Market-hub contract tracking ───────────────────────────────────

  /** Re-issue the trade subscription for every tracked contract. Called
   *  by the engine after a market-hub reconnect so the broadcaster's
   *  view of the world (which contracts the browser is watching) survives
   *  a hub kick + rebuild. Idempotent on the server side. */
  async resubscribeMarketContracts(): Promise<void> {
    const contracts = Array.from(this.trackedContracts);
    if (contracts.length === 0) return;
    await Promise.all(contracts.map((id) => this.subscribeTracked(id).catch(() => {})));
  }

  async trackContractTrades(contractId: string): Promise<void> {
    this.trackedContracts.add(contractId);
    try {
      log.debug("broadcaster", `subscribeTrades ${contractId}`);
      await this.subscribeTracked(contractId);
    } catch (err) {
      // Market hub might not be up — trade forwarding will lose ticks;
      // reconnect handler re-subscribes.
      log.event("ws_subscribe_failed", "broadcaster", `subscribeTrades ${contractId} failed`, {
        contractId,
        meta: err,
      });
    }
  }

  /**
   * Stop tracking one browser-facing contract id, and drop the market-hub
   * subscription behind it **only when nothing else still wants it**.
   *
   * The hub subscription is shared and not ref-counted at the wire, so the
   * id being unsubscribed here is live for anyone else holding it. Two
   * tracked contracts routinely resolve to one market-data id — a Topstep
   * position on `CON.F.US.MNQ.M26` and a manual Tradovate position on
   * `MNQM6` — and unsubscribing on the first close would kill the second
   * one's mark. All three per-contract maps are cleared on the way out.
   *
   * Known limit: an id whose translation failed once was subscribed verbatim
   * and recorded nothing in `marketIds`, so if a later track resolves it the
   * verbatim subscription is left behind. Harmless — the hub never heard of
   * that id, and the next reconnect's resubscribe walks `trackedContracts`,
   * which no longer holds it.
   */
  async untrackContractTrades(contractId: string): Promise<void> {
    this.trackedContracts.delete(contractId);
    const marketId = this.marketIds.get(contractId) ?? contractId;
    this.marketIds.delete(contractId);
    this.lastTick.delete(contractId);
    const aliases = this.aliases.get(marketId);
    if (aliases) {
      aliases.delete(contractId);
      if (aliases.size === 0) this.aliases.delete(marketId);
    }
    if (this.trackedContracts.has(marketId)) return;
    if ((this.aliases.get(marketId)?.size ?? 0) > 0) return;
    this.lastTick.delete(marketId);
    try {
      await this.deps.marketTrades.unsubscribe(marketId);
    } catch {
      // ignore
    }
  }

  /**
   * Untrack every contract outside `open`. The relay's analogue of the
   * browser's own `createContractMetaRetry().retain(...)`, and it exists for
   * the same reason: without it `trackedContracts` only grows, and on a 24/7
   * process each stale id keeps a market-hub subscription that every
   * reconnect re-issues, plus its `marketIds` / `aliases` / `lastTick`
   * entries. After a contract roll the hub streams an expired contract
   * nobody reads.
   *
   * **Drive this from `/api/engine/subscriptions`, which carries the
   * browser's real open set** — never from `ensureRunning`, which the engine
   * calls with an empty contract list and would prune everything.
   *
   * Not serialised against any path that adds to `trackedContracts` and then
   * awaits `subscribeTracked` — today only `ensureRunning`, since
   * `trackContractTrades` has the same split and no production caller. The
   * await is a translation, so a contract another tab added can be dropped
   * between its `trackedContracts.add` and its wire subscribe, leaving the
   * hub subscribed with nothing tracking it. Same two-tab shape as the known
   * limit above, and the same backstop covers it — `/api/quotes` reads bars
   * with no relay subscription at all.
   */
  async retainContractTrades(open: readonly string[]): Promise<void> {
    const keep = new Set(open);
    const drop = Array.from(this.trackedContracts).filter((id) => !keep.has(id));
    await Promise.all(drop.map((id) => this.untrackContractTrades(id)));
  }

  /**
   * Subscribe the market-data id behind a tracked contract, and remember
   * the browser's own name for it so ticks can be fanned out under both.
   *
   * The subscription itself is the half that used to be silently wrong: a
   * Tradovate dated symbol went to the market hub verbatim, which knows no
   * such contract, so the browser was subscribed to nothing at all. An id
   * that cannot be translated is still passed through unchanged — that is
   * what a Topstep id needs, and it leaves the resolution to be re-asked
   * rather than cached as a failure.
   */
  private async subscribeTracked(contractId: string): Promise<void> {
    const known = this.marketIds.get(contractId);
    const marketId =
      known ?? (await this.deps.marketDataContractId(contractId).catch(() => null));
    if (marketId && marketId !== contractId) {
      this.marketIds.set(contractId, marketId);
      const aliases = this.aliases.get(marketId) ?? new Set<string>();
      aliases.add(contractId);
      this.aliases.set(marketId, aliases);
    }
    await this.deps.marketTrades.subscribe(marketId ?? contractId);
  }

  /** Fan an event out to every listener. Best-effort — a throwing listener
   *  shouldn't block other listeners. */
  private emit(event: BroadcastEvent): void {
    for (const listener of this.listeners.values()) {
      try {
        listener(event);
      } catch (err) {
        // A bad listener shouldn't poison the whole broadcast. Log and
        // continue; the SSE route should tear itself down on errors anyway.
        log.event("frame_dispatch_failed", "broadcaster", "listener threw", { meta: err });
      }
    }
  }

  /**
   * Ensure the account feed is up and the requested accounts + contracts
   * are subscribed. Called on every SSE mount and on engine sync. The
   * account feed's own idempotency makes repeat calls cheap; a failure to
   * bring the feed up propagates so the caller can surface it.
   */
  async ensureRunning(accounts: number[], contracts: string[]): Promise<void> {
    for (const id of accounts) this.trackedAccounts.add(id);
    for (const id of contracts) this.trackedContracts.add(id);
    await this.deps.userEvents.retain("broadcaster", Array.from(this.trackedAccounts));
    await Promise.all(contracts.map((id) => this.subscribeTracked(id).catch(() => {})));
  }

  async shutdown(): Promise<void> {
    this.listeners.clear();
    this.disarmStatusPush();
    this.trackedAccounts.clear();
    this.trackedContracts.clear();
    this.marketIds.clear();
    this.aliases.clear();
    this.lastTick.clear();
    // Don't release the account feed — the engine shares it. Shutting the
    // broadcaster down should just stop fanning events out.
  }
}
