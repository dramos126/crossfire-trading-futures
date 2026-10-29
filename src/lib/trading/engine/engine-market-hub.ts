// Market-hub lifecycle extracted from engine.ts: connect + handler
// registration, the silent-death watchdog, passive mode, the maintenance
// auto-heal, the manual reconnect the dashboard button fires, the
// subscription reconciler and the diagnostic heartbeat.
//
// This is not the `*Deps` pure-function extraction the other engine-*
// satellites use, and pretending otherwise would be dishonest: the cluster
// owns eighteen mutable fields, most of them written from more than one
// path. A pure extraction would have meant passing `this` or exposing the
// fields through getters. So the controller *owns* the state and the
// engine delegates to it — the fields moved, they were not copied.
// The test for what belongs here is the exclusive-ownership litmus in
// engine.md, not the write count on any single field.
// The `*Deps` interface is still how it reaches back into the engine, so no
// private engine method was made public to accommodate it.
//
// The user hub deliberately stays in engine.ts. The maintenance heal fires
// both hubs, so it reaches the user side through two dep callbacks rather
// than dragging a second connection's state in here.

import { validateOrRefreshToken } from "@/lib/brokers/topstep/auth";
import { advisoryFollowsOwnLogin } from "@/lib/brokers/topstep/client";
import { GATEWAY_LOGOUT_CLOSE_WINDOW_MS } from "@/lib/brokers/topstep/realtime-adapter";
import { takeTopstepRequestWindow } from "@/lib/brokers/topstep/request-counter";
import type { GatewayTrade, TopstepSignalR } from "@/lib/brokers/topstep/signalr";
import type { BarData, Contract } from "@/lib/brokers/types";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import {
  sendConnectionAlert,
  COLOR_CONNECTION_LOST,
  COLOR_CONNECTION_RESTORED,
} from "@/lib/notify/discord";
import type { Deployment, TickerSymbol, Timeframe } from "@/lib/trading/domain";
import { isEngineManagedStatus } from "@/lib/trading/domain";
import { BarAggregator } from "../bar-aggregator";
import { isInMaintenanceWindow, nextMaintenanceEnd } from "../session/session";
import { getStrategy } from "../strategies";
import { resolveTimeframe } from "../strategy-types";
import type { ContractSub, LogSubject, MarketSub, SubKey } from "./engine";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";

/** deploymentId value used for engine-internal (non-deployment) log entries.
 *  One definition, re-exported from the vocabulary rather than restated. */
const ENGINE_CTX = ENGINE_SCOPE;

/**
 * Watchdog stall threshold for the market hub. If no trade event arrives
 * for this long while the hub reports Connected + contracts are subscribed,
 * treat it as a silent hub death (observed when Topstep kicks a session
 * without sending gatewaylogout or closing the socket) and flip to passive
 * so the reconnect loop takes over.
 *
 * Sized to tolerate overnight / weekend low-liquidity gaps on MNQ/MES/MGC
 * without false-positiving — RTH ticks arrive multiple times per second.
 *
 * Exported for `engine-health.ts`, which reuses it as the point at which the
 * data slot stops waiting and reports `down`. One calibrated ladder, one
 * copy — a second constant that "matches" this is the failure `replayWindow`
 * was created to remove.
 */
export const MARKET_HUB_STALL_MS = 120_000;
const MARKET_HUB_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * Number of inline reconnect attempts the watchdog will make before falling
 * through to passive mode. Each attempt runs the same disconnect →
 * connect → resubscribeAll path the auto-retry loop uses, but stays inside
 * the watchdog tick so a transient stall heals without ever showing as
 * "Passive" in the UI. Skipped entirely during the daily maintenance break
 * — gateway is known down so retries are wasted.
 */
const WATCHDOG_INLINE_RECONNECT_MAX = 2;

const PASSIVE_TOKEN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Diagnostic heartbeat cadence. It is bracketed on both sides and cannot be
 * chosen in isolation: `HEARTBEAT_TRADE_SILENCE_WARN_S` (60s) below it and
 * `MARKET_HUB_STALL_MS` (120s) above it. The warn site promises to flag
 * trade silence *before* the watchdog acts on the same silence, and that
 * only holds while some check lands strictly inside the (60s, 120s) window.
 *
 * Do not "restore" this to 60_000 — the comment that used to ask for it was
 * wrong. At 60s there is no such check: trades stop at t=0, the t=60 check
 * reads an age of exactly 60 and `> 60` is false, and the next check is
 * t=120, which is the instant the watchdog trips. 30s lands one at t=90 with
 * 30s of margin either side. Move either bracketing constant and this value
 * has to be re-derived against the new window.
 *
 * Not lower either. The only action the heartbeat takes is the user-hub
 * anomaly reconnect, and `USER_RECONNECT_MIN_INTERVAL_MS` throttles that to
 * 60s, so the 10s diagnostic cadence checked six times to act once and paid
 * 6x the `[heartbeat]` lines for it. A hub zombied by token rotation still
 * surfaces here well before the watchdog.
 */
const HEARTBEAT_MS = 30_000;

/**
 * How often the heartbeat re-runs `syncContractSubs` while a leg's contract
 * lookup is failing. Each retry is one `/Contract/search` per failed leg and
 * re-emits its line, so this is also how often a standing failure re-pages
 * (the Discord sender throttles per deployment at the same five minutes).
 */
const UNRESOLVED_RETRY_MS = 5 * 60_000;

/**
 * Trade silence that makes the heartbeat warn, in seconds. Deliberately
 * well under `MARKET_HUB_STALL_MS` so the warn lands in the log *before*
 * the watchdog acts on the same silence — raise it past the stall
 * threshold and the only record of a hub death becomes the disconnect
 * itself, with nothing leading up to it.
 *
 * Exported for `engine-health.ts`, which reuses it as the silence at which
 * the data slot reports `stale`. The warn below stays the only log line for
 * that silence; health adds a readable status, not a second message.
 */
export const HEARTBEAT_TRADE_SILENCE_WARN_S = 60;

/** Trailing characters of the JWT the heartbeat prints. Enough to spot a
 *  rotation between two lines; short enough not to leak a usable token
 *  into the log ring. */
const TOKEN_FINGERPRINT_CHARS = 12;

/**
 * Heartbeat-driven user-hub anomaly recovery rate-limit. If the user hub
 * reports any state other than "Connected" while at least one deployment is
 * active, the heartbeat fires a single `attemptUserReconnect()`. We bound the
 * frequency to avoid fighting a real session displacement (the user logging
 * in on mobile / another browser tab) — repeated kicks would just ping-pong
 * the user's slot.
 */
const USER_RECONNECT_MIN_INTERVAL_MS = 60_000;

const makeSubKey = (contractId: string, tf: Timeframe): SubKey =>
  `${contractId}|${tf}` as SubKey;

/**
 * Engine-internal surface the market hub calls back into. Mirrors the
 * `PlaceEntryOrderDeps` / `ExitOrderDeps` pattern: bound callbacks rather
 * than flipped access modifiers.
 */
export interface MarketHubDeps {
  log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ): void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** Stamp a freshly validated token on the engine's REST client. */
  setBrokerToken(token: string): void;
  /** Inbound market-hub trade handler — the engine's bar-aggregation entry point. */
  onTrade(contractId: string, trade: GatewayTrade | GatewayTrade[]): void;
  /** Swap the REST tick between reconciler-only and full strategy eval. */
  swapTickHandler(mode: "realtime" | "passive"): void;
  /** User-hub reconnect — the maintenance heal fires both hubs.
   *  `token-rotation` is the one trigger that reconnects a hub reporting
   *  `Connected`, because that is what a retired session reports. */
  reconnectUserHub(trigger: "auto-heal" | "heartbeat" | "token-rotation"): Promise<boolean>;
  /** Clear the user hub's bounded-retry counter for a fresh heal cycle. */
  resetUserReconnectFailures(): void;

  // ── subscription sync ───────────────────────────────────────────────
  /** Current realtime deployment set, read at call time — a reconnect that
   *  lands after a deployment edit must sync against the current set. */
  realtimeDeployments(): Deployment[];
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  /** Aggregator bar-close fan-out — the engine dispatches strategy eval.
   *  `previousPublishedAt` is the aggregator's own previous close (see
   *  `BarCloseHandler`). */
  onBarClose(key: SubKey, bar: BarData, previousPublishedAt: string | null): void;

  // ── heartbeat ───────────────────────────────────────────────────────
  /** Bar-close evals deferred while the reconciler holds `ticking`. */
  pendingBarCloseCount(): number;
  /** Topstep user-hub SignalR state, or undefined when there is no adapter. */
  userHubState(): string | undefined;
  /** Topstep user-hub event counters, or undefined when there is no adapter. */
  userHubLiveness(): { lastEventAt: number; windowCount: number; hubStarted: boolean } | undefined;
  /** The REST client's current JWT — the heartbeat fingerprints it to catch
   *  a rotation the hub's socket did not follow. */
  brokerToken(): string | null;
}

export interface MarketHubStatus {
  mode: "realtime" | "passive";
  autoRetry: boolean;
  lastDisconnectReason: string | null;
}

export class MarketHubController {
  private ready = false;
  /** Holds the most recent gatewaylogout reason so the subsequent onclose
   * can attribute the disconnect to "Multiple sessions detected" instead of
   * a generic close. Cleared on next reconnect. */
  private lastKickReason: string | null = null;
  /** When `lastKickReason` arrived. Only a close inside
   *  `GATEWAY_LOGOUT_CLOSE_WINDOW_MS` of it is a kick (A79). */
  private lastKickAt = 0;
  /**
   * "realtime" = market hub is up, strategies react on bar close.
   * "passive"  = market hub is dead (kicked, network drop, SignalR gave up
   *              after withAutomaticReconnect's bounded retries). Engine
   *              continues running on the 30s REST reconciler loop and
   *              attempts to restore the hub via `reconnectInterval`.
   *
   * The transition is one-way per cycle: realtime → passive on close,
   * passive → realtime on a successful reconnect. The 30s reconciler runs
   * regardless of mode, so trades-in-flight don't stall while passive.
   */
  private hubMode: "realtime" | "passive" = "realtime";
  /** 60s loop ref while in passive mode + auto-retry-eligible; null otherwise. */
  private reconnectInterval: ReturnType<typeof setInterval> | null = null;
  /** Backoff counter for reconnect attempt logging — resets on success. */
  private reconnectAttempt = 0;
  /** Timestamp (ms) of the last inbound market-hub event (trade or connect).
   *  Used by the watchdog to detect silent hub death — Topstep occasionally
   *  kicks a session without firing `gatewaylogout` or closing the socket,
   *  leaving SignalR in Connected state with zero traffic. */
  private lastActivity = 0;
  /** Watchdog interval ref. Active only while in realtime mode with at
   *  least one contract subscribed. Forces a disconnect+passive transition
   *  when inbound traffic stalls past MARKET_HUB_STALL_MS. */
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  /** Consecutive inline reconnect attempts the watchdog has made without
   *  recovering. Reset to 0 on any inbound trade event (proves the hub is
   *  alive). When this hits WATCHDOG_INLINE_RECONNECT_MAX, we stop trying
   *  and fall through to passive mode. */
  private inlineReconnectAttempt = 0;
  /** Pending one-shot timer that fires `attemptReconnect` at the next CME
   *  maintenance-end. Scheduled on every passive-mode entry so the engine
   *  self-heals when the gateway returns at 18:00 ET, even if the 60s
   *  auto-retry was suppressed (autoRetry=false after gatewaylogout).
   *  Cancelled in exitPassiveMode and shutdown. */
  private maintenanceHealTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the current passive-mode entry has auto-retry enabled. False
   *  for gatewaylogout (user opened the webapp; auto-retry would re-kick
   *  them); true for transient closes. Surfaced to the dashboard so the
   *  Reconnect button can be enabled only when manual action is needed. */
  private passiveAutoRetry = true;
  /** Persisted across `lastKickReason` getting cleared by onclose, so the
   *  dashboard can show "you got kicked because: ..." until the next
   *  successful reconnect clears it. */
  private lastDisconnectReason: string | null = null;
  /** Timestamp of the last passive-mode token validation. While passive
   *  (esp. with autoRetry=false after gatewaylogout) the reconcile loop is
   *  the only thing keeping the process active, and it only learns about a
   *  dead session via 401. Probe `/Auth/validate` every 5 min so a truly-
   *  dead session triggers a real loginKey instead of waiting for the next
   *  REST call's 401-retry path. */
  private lastPassiveTokenCheckAt = 0;
  /** Guard against parallel market-hub reconnect attempts. Both the manual
   *  dashboard trigger and the 60s auto-retry loop call disconnectMarket +
   *  connect; without this flag, two reconnects can interleave their
   *  disconnect/connect/sync steps and the second's syncContractSubs may
   *  run against a hub instance the first already replaced. Single-flight
   *  wins; the loser logs and returns. */
  private reconnecting = false;
  /** Diagnostic heartbeat interval (HEARTBEAT_MS). Survives across
   *  watchdog/passive cycles — if it ever stops logging that's a hard
   *  signal the engine itself is wedged (vs. just the market hub being
   *  silent). */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Realtime mode: aggregators keyed by `${contractId}|${timeframe}`. */
  private contractSubs = new Map<SubKey, ContractSub>();
  /** Realtime mode: per-contract market-data subscription state. The
   *  SignalR subscribeTrades call is ref-counted here so N aggregators on
   *  the same contract share one trade stream. */
  private marketSubs = new Map<string, MarketSub>();
  /** Legs whose contract lookup failed on the last sync; the heartbeat
   *  retries while any remain. */
  private unresolvedLegs = new Set<string>();
  private lastUnresolvedRetryAt = 0;
  private unresolvedRetryInFlight = false;
  /** Rolling count of market-hub trades since the last heartbeat — reset
   *  by the heartbeat itself. User-hub equivalent lives on the broadcaster
   *  (see getUserHubLiveness) since the broadcaster owns the user-hub
   *  event listeners. */
  private marketTradeWindowCount = 0;
  /** Timestamp of the last anomaly-driven user-hub reconnect attempt. The
   *  heartbeat rate-limits to no faster than once per
   *  USER_RECONNECT_MIN_INTERVAL_MS so a real displacement (user logged in
   *  on another device) doesn't get re-kicked every heartbeat. */
  private lastUserAnomalyReconnectAt = 0;
  /**
   * The bearer the currently-open hubs were built against, recorded by
   * `connect()` from the token it actually used.
   *
   * A Topstep session is bound to the token that opened the socket, so
   * `/Auth/validate` handing back a rotated one retires the session the
   * hubs are on — the WS stays open and the gateway stops streaming to it.
   * Nothing on the hub path rotates a token underneath itself (`connect()`
   * re-stamps this from its own `validateOrRefreshToken`), so a value that
   * has moved since means a **REST** caller refreshed the shared cache:
   * `getToken()`'s warm path is the one that does it, via `getEngineClient`,
   * roughly daily as the cached JWT nears expiry. See the heartbeat.
   */
  private hubSessionToken: string | null = null;
  /**
   * The barrier `shutdown()` raises: while set, nothing arms the watchdog or
   * enters passive mode, so a stopped engine gets no interval and no REST tick
   * swap back from a socket that closes later. Cleared by the two ways a
   * starting engine reaches this controller — the public `connect()`, and
   * `startHeartbeat()`, which `start()` calls in both arms even when the hub
   * stayed open across the stop and no connect follows.
   */
  private stopped = false;
  /**
   * How many times `shutdown()` has run. A reconnect path reads it at entry
   * and abandons the moment it moves, which is what makes the stop a barrier
   * rather than a sweep: a path suspended on an `await` when `shutdown()`
   * lands would otherwise resume and re-arm what the sweep just cleared. A
   * count rather than the latch, so a stop → start inside one await still
   * abandons the old pass, and a manual reconnect on an already-stopped
   * engine still runs.
   */
  private shutdowns = 0;

  constructor(
    private readonly signalr: TopstepSignalR | null,
    private readonly deps: MarketHubDeps,
  ) {}

  // ── Read surface for the engine ─────────────────────────────────────

  isReady(): boolean {
    return this.ready;
  }

  mode(): "realtime" | "passive" {
    return this.hubMode;
  }

  lastActivityAt(): number {
    return this.lastActivity;
  }

  /** Snapshot of market-hub state for the dashboard's connection UI. */
  status(): MarketHubStatus {
    return {
      mode: this.hubMode,
      autoRetry: this.passiveAutoRetry,
      lastDisconnectReason: this.lastDisconnectReason,
    };
  }

  /** Contract ids with a live market-data subscription. */
  subscribedContractIds(): IterableIterator<string> {
    return this.marketSubs.keys();
  }

  /** Re-invoke every tracked subscribe after a reconnect. The server drops
   *  subscriptions with the connection while `marketSubs` keeps them, so
   *  without this trades stop after the first blip and `syncContractSubs`
   *  no-ops on the keys it already holds. One contract's failure is said
   *  and the rest still go. */
  private async resubscribeAll(): Promise<void> {
    if (!this.signalr) return;
    for (const contractId of this.marketSubs.keys()) {
      try {
        await this.signalr.subscribeTrades(contractId);
      } catch (err) {
        this.deps.log(
          ENGINE_CTX,
          "warn",
          "connection",
          `resubscribeTrades(${contractId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          { contractId },
        );
      }
    }
    this.deps.log(ENGINE_CTX, "info", "connection", "Re-subscribed market-hub trades after reconnect");
  }

  /** Every (Topstep contractId, sub) pair — the engine's execution-alias
   *  reverse lookup walks it. */
  marketSubEntries(): IterableIterator<[string, MarketSub]> {
    return this.marketSubs.entries();
  }

  /** How many contracts have a live market-data subscription. Feed health
   *  reads it to answer "is *anything* supposed to be ticking" — the
   *  global-versus-per-contract discriminator that stops a quiet contract
   *  reading as a dead feed. Separate from `subscribedContractIds()` so the
   *  caller does not have to drain an iterator to count. */
  marketSubCount(): number {
    return this.marketSubs.size;
  }

  /** Whether an aggregator still holds this contract's trade subscription.
   *  The SSE relay asks before unsubscribing — one SignalR client, no wire
   *  ref count. */
  hasMarketSub(contractId: string): boolean {
    return this.marketSubs.has(contractId);
  }

  marketSubFor(contractId: string): MarketSub | undefined {
    return this.marketSubs.get(contractId);
  }

  contractSubFor(contractId: string, tf: Timeframe): ContractSub | undefined {
    return this.contractSubs.get(makeSubKey(contractId, tf));
  }

  contractSubForKey(key: SubKey): ContractSub | undefined {
    return this.contractSubs.get(key);
  }

  /** True when some aggregator carries this deployment — the one place a
   *  leg's bar closes come from. */
  hasDeploymentSub(deploymentId: string): boolean {
    for (const sub of this.contractSubs.values()) {
      if (sub.refs.has(deploymentId)) return true;
    }
    return false;
  }

  /** Any inbound trade proves the hub is alive — refresh the watchdog
   *  anchor and clear its inline-retry counter so a future stall starts
   *  fresh. Called from the engine's trade handler. */
  noteTradeActivity(): void {
    this.lastActivity = Date.now();
    if (this.inlineReconnectAttempt !== 0) {
      this.inlineReconnectAttempt = 0;
    }
  }

  /** Bump the rolling per-window trade count the heartbeat reads and
   *  resets. Called from the engine's trade handler alongside
   *  `noteTradeActivity` — the two answer different questions (liveness
   *  anchor vs. volume in the window). */
  noteMarketTrade(): void {
    this.marketTradeWindowCount++;
  }

  // ── Connect ─────────────────────────────────────────────────────────

  /**
   * Connect the market hub and wire every state-change handler. Shared by
   * `initRealtime`, the passive-mode reconnect loop, the watchdog's inline
   * retry and the manual reconnect — registering handlers fresh on each new
   * hub instance is required because the SignalR client doesn't carry
   * handlers across `disconnectMarket()` + new `connectMarketHub()`.
   *
   * On entry: caller has already torn down any prior hub (or there was
   * none). On success: ready=true, mode="realtime", reconnect loop stopped
   * if it was running.
   *
   * The engine's entry point, so it lifts the `shutdown()` barrier; the
   * controller's own reconnect paths call `openHub()` and never lift it.
   */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.openHub();
  }

  private async openHub(): Promise<void> {
    if (!this.signalr) return;
    const at = this.shutdowns;
    // Validate / refresh the token before opening any hub. Caching the
    // JWT works fine for REST, but the hub requires a *live session*.
    // A cached token can survive across container restarts / redeploys
    // while the session it represents has been superseded server-side
    // (e.g. user opened the Topstep webapp in between, or a previous
    // container minted a fresh session that displaced ours). Without
    // this check the hub opens, gets a clean close from the gateway,
    // and our retry loop keeps banging on the dead token.
    const liveToken = await validateOrRefreshToken();
    this.deps.setBrokerToken(liveToken);
    if (this.abandoned(at, "Market hub connect")) return;
    // Record what these hubs are bound to *before* they are built, from the
    // token this call resolved. Everything the rotation check compares
    // against is stamped here, which is what stops a rebuild that rotates
    // again from re-triggering itself.
    this.hubSessionToken = liveToken;
    // After the validate: a login it made is not one this hub can echo (A90).
    const hubBuiltAt = Date.now();

    // Build the hub first (no network), register every handler, THEN start.
    // SignalR drops messages that arrive between `start()` resolving and a
    // later `.on(...)` call. Topstep sends `gatewaylogout` immediately on
    // any session conflict; pre-registering keeps it alive, post-registering
    // misses the kick (shows up as a generic clean close).
    this.signalr.buildMarketHub();
    this.signalr.onTrade((contractId, t) => this.deps.onTrade(contractId, t));
    this.signalr.onMarketReconnected(() => {
      this.lastKickReason = null;
      this.deps.logEvent(
        "hub_reconnected",
        ENGINE_CTX,
        "SIGNALR RECONNECTED — market hub back online, resubscribing",
      );
      this.exitPassiveMode();
      void this.resubscribeAll();
      // The broadcaster's tracked-contract list survives the kick but
      // its server-side subscriptions don't. Re-issue them so quote
      // forwarding to the browser resumes.
      void peekBroadcaster()?.resubscribeMarketContracts();
    });
    // gatewaylogout is ADVISORY ONLY. Topstep sends "Multiple sessions
    // detected..." when another client (e.g. the user signing into the
    // webapp) opens a session on the same username, but the actual
    // WebSocket stays open and trades keep flowing — see scripts/README.md
    // §4 for the empirical evidence (5+ min of order placement and trade
    // reception after the message fires). Tearing down the hub
    // here threw away a perfectly good session and triggered a self-
    // inflicted ping-pong: passive → manual reconnect → loginKey cold
    // mint → boots the webapp → webapp auto-reconnects → another
    // advisory kick → repeat. We just cache the reason so onMarketClose
    // can attribute the disconnect IF the socket actually closes later;
    // the watchdog handles real session death via trade silence.
    this.signalr.onMarketGatewayLogout((reason) => {
      const now = Date.now();
      // Our own login sends this advisory to our own hubs, and a close it is
      // then followed by is not another device taking the slot (A90).
      if (advisoryFollowsOwnLogin(now, hubBuiltAt)) {
        this.deps.log(
          ENGINE_CTX,
          "info",
          "connection",
          `Gateway notice after this process's own login (not a kick): ${reason}`,
        );
        return;
      }
      this.lastKickReason = reason;
      this.lastKickAt = now;
      this.deps.log(
        ENGINE_CTX,
        "info",
        "connection",
        `Gateway notice (advisory, session continues): ${reason}`,
      );
    });
    this.signalr.onMarketClose((err) => {
      // If the socket actually closes shortly after a gatewaylogout
      // advisory, treat that as a real session retire (Topstep finally
      // followed through). Skip auto-retry in that case so we don't
      // spin and re-displace the webapp every minute. Otherwise (network
      // blip, server hiccup) auto-retry every 60s. An advisory outside the
      // window is stale: the session carried on past it, so it says nothing
      // about this close — unbounded, one from maintenance-end parked the
      // hub for 13h after a network drop (A79).
      const kickReason =
        Date.now() - this.lastKickAt <= GATEWAY_LOGOUT_CLOSE_WINDOW_MS ? this.lastKickReason : null;
      const wasKick = kickReason !== null;
      const reason = kickReason ?? (err ? err.message : "Connection closed");
      this.lastKickReason = null;
      this.lastKickAt = 0;
      this.lastDisconnectReason = reason;
      this.deps.logEvent(
        "hub_disconnected",
        ENGINE_CTX,
        `SIGNALR DISCONNECTED — ${wasKick ? reason : `market hub closed${err ? `: ${err.message}` : " (clean)"}`}`,
      );
      this.enterPassiveMode({ autoRetry: !wasKick, reason });
    });
    // Now start. Any message the server sends post-handshake (including
    // an immediate gatewaylogout) will hit a registered handler.
    await this.signalr.startMarketHub();
    this.ready = true;
    this.lastDisconnectReason = null;
    this.exitPassiveMode(); // no-op unless we were already in passive mode
    this.startWatchdog();
    this.deps.logEvent("hub_connected", ENGINE_CTX, "SIGNALR CONNECTED — market hub online");
  }

  // ── Watchdog ────────────────────────────────────────────────────────

  /** Start (or restart) the silent-death watchdog. Safe to call on every
   *  successful (re)connect — idempotent. The watchdog forces a disconnect
   *  if inbound traffic stalls while the hub still reports Connected; this
   *  is the only signal we have for kicks that don't fire gatewaylogout or
   *  onclose. */
  /** True, with one line saying so, when `shutdown()` ran since the path
   *  read `at`. The caller returns on it; the `finally` that releases
   *  `reconnecting` still runs. */
  private abandoned(at: number, what: string): boolean {
    if (at === this.shutdowns) return false;
    this.deps.log(
      ENGINE_CTX,
      "info",
      "connection",
      `${what} abandoned — the engine stopped while it was in flight`,
    );
    return true;
  }

  private startWatchdog(): void {
    if (this.stopped) return;
    this.lastActivity = Date.now();
    if (this.watchdogInterval) return;
    this.watchdogInterval = setInterval(() => {
      void this.checkLiveness();
    }, MARKET_HUB_WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /** One tick of the watchdog. If we're in realtime mode with contracts
   *  subscribed and no trade has arrived within MARKET_HUB_STALL_MS, first
   *  try an inline reconnect (up to WATCHDOG_INLINE_RECONNECT_MAX) — most
   *  silent stalls are transient and heal by rebuilding the socket without
   *  ever showing as Passive. Only after exhausting inline retries (or
   *  during the 17:00–18:00 ET maintenance break, when the gateway is
   *  guaranteed down) do we flip to passive and let the 60s loop take over. */
  private async checkLiveness(): Promise<void> {
    if (this.hubMode !== "realtime") return;
    if (this.marketSubs.size === 0) return;
    const gap = Date.now() - this.lastActivity;
    if (gap < MARKET_HUB_STALL_MS) return;
    if (this.reconnecting) return; // a manual or prior inline reconnect is in flight

    // Maintenance break: gateway down by design — go straight to passive,
    // the auto-heal timer will fire at 18:00 ET.
    if (isInMaintenanceWindow()) {
      this.deps.logEvent(
        "hub_disconnected",
        ENGINE_CTX,
        `SIGNALR DISCONNECTED — market hub silent for ${Math.round(gap / 1000)}s during CME maintenance break; flipping to passive`,
      );
      this.lastDisconnectReason = "Market hub stalled during maintenance break";
      try {
        await this.signalr?.disconnectMarket();
      } catch {
        // hub was wedged anyway
      }
      this.enterPassiveMode({ autoRetry: true, reason: "Market hub stalled (maintenance break)" });
      return;
    }

    if (this.inlineReconnectAttempt < WATCHDOG_INLINE_RECONNECT_MAX) {
      this.inlineReconnectAttempt++;
      const attemptNumber = this.inlineReconnectAttempt;
      this.deps.logEvent(
        "hub_reconnecting",
        ENGINE_CTX,
        `Market hub silent for ${Math.round(gap / 1000)}s — inline reconnect attempt #${attemptNumber}/${WATCHDOG_INLINE_RECONNECT_MAX}`,
      );
      this.reconnecting = true;
      const at = this.shutdowns;
      const what = `Inline reconnect #${attemptNumber}`;
      try {
        await this.signalr?.disconnectMarket();
        if (this.abandoned(at, what)) return;
        await this.openHub();
        if (this.abandoned(at, what)) return;
        await this.resubscribeAll();
        if (this.abandoned(at, what)) return;
        await this.syncContractSubs(this.deps.realtimeDeployments());
        if (this.abandoned(at, what)) return;
        void peekBroadcaster()?.resubscribeMarketContracts();
        // Don't reset inlineReconnectAttempt here — noteTradeActivity
        // resets it when real traffic actually flows. If the hub reconnects
        // but stays silent, the next watchdog tick consumes the next slot.
        this.lastActivity = Date.now();
        this.deps.logEvent(
          "hub_reconnected",
          ENGINE_CTX,
          `Inline reconnect #${attemptNumber} succeeded — awaiting trade flow to confirm`,
        );
      } catch (err) {
        this.deps.logEvent(
          "hub_reconnect_failed",
          ENGINE_CTX,
          `Inline reconnect #${attemptNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.reconnecting = false;
      }
      return;
    }

    this.deps.logEvent(
      "hub_disconnected",
      ENGINE_CTX,
      `SIGNALR DISCONNECTED — market hub silent for ${Math.round(gap / 1000)}s after ${WATCHDOG_INLINE_RECONNECT_MAX} inline retries; flipping to passive`,
    );
    this.lastDisconnectReason = "Market hub stalled (no inbound trades)";
    try {
      await this.signalr?.disconnectMarket();
    } catch {
      // hub was wedged anyway
    }
    this.enterPassiveMode({ autoRetry: true, reason: "Market hub stalled" });
  }

  // ── Passive mode ────────────────────────────────────────────────────

  /**
   * Flip into passive mode. The REST tick loop is repurposed:
   *  - Realtime mode runs `runReconcileOnly` (strategy eval is bar-driven
   *    by SignalR, REST tick just keeps trades reconciled).
   *  - Passive mode runs the *full* `runTick` so strategies still evaluate
   *    on REST-fetched bars while the hub is dead. Without this swap, no
   *    new entries fire while the user has the webapp open.
   *
   * `autoRetry` controls whether we keep retrying the hub every 60s.
   *  - false (gatewaylogout): user opened the Topstep webapp on purpose;
   *    auto-retry would just re-kick them. They click Reconnect when done.
   *  - true (network blip, generic close): retry every 60s, since the
   *    cause is transient and we want the engine back to realtime asap.
   *
   * Idempotent — safe to call from both onclose and a stillborn reconnect.
   */
  private enterPassiveMode(
    opts: { autoRetry: boolean; reason: string | null } = { autoRetry: true, reason: null },
  ): void {
    // The one gate for every passive-mode arm — the tick swap, the heal and
    // the 60s loop are reached only through here. A socket closing on a
    // stopped engine still marks the hub down, so the next `start()` connects
    // rather than trusting a dead hub.
    if (this.stopped) {
      this.ready = false;
      return;
    }
    if (this.hubMode === "passive") return;
    this.hubMode = "passive";
    this.ready = false;
    this.passiveAutoRetry = opts.autoRetry;
    this.lastPassiveTokenCheckAt = Date.now();

    // Watchdog is a realtime-mode concern — reconnect loop handles retries
    // while passive.
    this.stopWatchdog();
    this.inlineReconnectAttempt = 0;

    // Swap the REST tick from reconciler-only to full tick so strategies
    // evaluate on REST bars while passive.
    this.deps.swapTickHandler("passive");

    // One-shot self-heal: schedule a reconnect at the next CME
    // maintenance-end. Fires regardless of `autoRetry` — even after a
    // gatewaylogout, if the engine is still passive when the gateway comes
    // back at 18:00 ET we want it back online without the user clicking
    // Reconnect. The webapp re-kick risk is acceptable: any reconnect
    // displaces the webapp anyway, so deferring this until 18:00 ET is no
    // worse than the user clicking the button at the same moment.
    this.scheduleMaintenanceHeal();

    if (opts.autoRetry) {
      if (isInMaintenanceWindow()) {
        // Inside a known-down window: scheduleMaintenanceHeal above already
        // armed a one-shot reconnect for window end. A 60s retry loop here
        // would just churn RECONNECTING/CONNECTED/silence cycles against a
        // gateway that is intentionally offline. Defer the loop until the
        // heal fires (or the watchdog/manual path re-enters passive after).
        this.deps.logEvent(
          "hub_passive_mode",
          ENGINE_CTX,
          "Entering passive mode — inside CME maintenance window, deferring auto-retry until maintenance-end",
        );
      } else {
        this.deps.logEvent(
          "hub_passive_mode",
          ENGINE_CTX,
          "Entering passive mode — REST tick evaluating strategies, retrying market hub every 60s",
        );
        this.startPassiveAutoRetry();
      }
    } else {
      this.deps.logEvent(
        "hub_passive_mode",
        ENGINE_CTX,
        "Entering passive mode — REST tick evaluating strategies. Auto-retry suppressed (kick was intentional); use the dashboard's Reconnect button when ready.",
      );
      // Discord alert so the user notices even if they're not on the logs page.
      void sendConnectionAlert({
        title: "Engine market hub kicked",
        color: COLOR_CONNECTION_LOST,
        fields: [
          {
            name: "Reason",
            value: opts.reason ?? "Unknown",
          },
          {
            name: "Status",
            value:
              "Engine continues evaluating strategies on REST polling (15s). Click **Reconnect Market Hub** in the sidebar to restore realtime — this will kick whoever else is logged in.",
          },
        ],
      });
    }
  }

  /** Start the 60s passive-mode reconnect loop. Idempotent — no-op if
   *  already running. Extracted so the auto-heal failure path can reattach
   *  the loop when a maintenance-end reconnect doesn't take. */
  private startPassiveAutoRetry(): void {
    if (this.reconnectInterval) return;
    this.reconnectAttempt = 0;
    this.reconnectInterval = setInterval(() => {
      void this.attemptReconnect();
    }, 60_000);
  }

  /** Flip out of passive mode. Tears down the reconnect loop, swaps the
   *  REST tick back to reconciler-only (SignalR drives strategy eval).
   *  Called both from a successful reconnect (manual or auto) and from
   *  `onreconnected` if SignalR's own reconnect happened to win. */
  private exitPassiveMode(): void {
    const wasPassive = this.hubMode === "passive";
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.cancelMaintenanceHeal();
    this.reconnectAttempt = 0;
    this.hubMode = "realtime";
    if (wasPassive) {
      this.deps.swapTickHandler("realtime");
    }
  }

  /** Schedule a one-shot reconnect at the next CME maintenance-end (18:00
   *  ET). No-op if we're not currently in a maintenance window — there's
   *  no upcoming maintenance-end to align with. Idempotent: if a heal is
   *  already scheduled, leave it. */
  private scheduleMaintenanceHeal(): void {
    if (this.maintenanceHealTimer) return;
    const target = nextMaintenanceEnd();
    if (!target) return;
    const delay = target.getTime() - Date.now();
    if (delay <= 0) return;
    this.deps.log(
      ENGINE_CTX,
      "info",
      "connection",
      `Auto-heal scheduled for ${target.toISOString()} (${Math.round(delay / 60_000)} min) — engine will attempt reconnect at next maintenance-end`,
    );
    this.maintenanceHealTimer = setTimeout(() => {
      this.maintenanceHealTimer = null;
      this.deps.log(
        ENGINE_CTX,
        "info",
        "connection",
        "Auto-heal firing — maintenance window ended, attempting market + user hub reconnect",
      );
      // Reset the bounded-retry counter for this auto-heal cycle so a prior
      // window's accumulated failures don't immediately trip the cap.
      this.deps.resetUserReconnectFailures();
      // Run market and user reconnects in parallel — a market-hub failure
      // must not block user-hub recovery (and vice versa). allSettled so a
      // throw from one branch doesn't cancel the other.
      void Promise.allSettled([
        this.hubMode === "passive" ? this.attemptReconnect() : Promise.resolve(),
        this.deps.reconnectUserHub("auto-heal"),
      ]).then((results) => {
        const [marketResult, userResult] = results;
        if (marketResult.status === "rejected") {
          this.deps.logEvent(
            "hub_reconnect_failed",
            ENGINE_CTX,
            `Auto-heal market reconnect threw: ${marketResult.reason instanceof Error ? marketResult.reason.message : String(marketResult.reason)}`,
          );
        }
        if (userResult.status === "rejected") {
          this.deps.logEvent(
            "hub_reconnect_failed",
            ENGINE_CTX,
            `Auto-heal user reconnect threw: ${userResult.reason instanceof Error ? userResult.reason.message : String(userResult.reason)}`,
          );
        }
      });
    }, delay);
  }

  private cancelMaintenanceHeal(): void {
    if (this.maintenanceHealTimer) {
      clearTimeout(this.maintenanceHealTimer);
      this.maintenanceHealTimer = null;
    }
    // Reset the bounded-retry counter when a heal is cancelled — otherwise
    // a prior cycle's accumulated failures leak into the next heartbeat
    // path (which would silently no-op once the cap is reached).
    this.deps.resetUserReconnectFailures();
  }

  /** Probe token health while in passive mode. Runs at most once per
   *  5 minutes from the reconcile tick. Calls validateOrRefreshToken,
   *  which hits /Auth/validate and falls through to loginKey on a dead
   *  session. On a successful refresh we update the REST client's token
   *  so the next reconcile call carries the new bearer. Errors are logged
   *  but not thrown — we want the reconcile tick to keep running even if
   *  validate hiccups; the next tick will retry. */
  async maybeValidatePassiveToken(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPassiveTokenCheckAt < PASSIVE_TOKEN_CHECK_INTERVAL_MS) return;
    this.lastPassiveTokenCheckAt = now;
    try {
      const token = await validateOrRefreshToken();
      this.deps.setBrokerToken(token);
    } catch (err) {
      this.deps.log(
        ENGINE_CTX,
        "info",
        "connection",
        `Passive-mode token validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Reconnect ───────────────────────────────────────────────────────

  /** One pass of the reconnect loop. Tears down any wedged hub instance,
   *  reconnects fresh, and on success re-subscribes every contract from
   *  the current deployment set. Failures are logged and the loop keeps
   *  trying — there's no max attempts, since the user might leave the
   *  Topstep webapp open for hours. */
  private async attemptReconnect(): Promise<void> {
    if (!this.signalr || this.hubMode !== "passive") return;
    if (this.reconnecting) {
      // Manual reconnect already in flight — let it complete rather than
      // racing it. We'll catch the next 60s tick if it didn't recover.
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempt++;
    // Snapshot the count before connect() resets it via exitPassiveMode —
    // otherwise the success log reads 0.
    const attemptNumber = this.reconnectAttempt;
    this.deps.logEvent(
      "hub_reconnecting",
      ENGINE_CTX,
      `SIGNALR RECONNECTING — attempt #${attemptNumber}`,
    );
    const at = this.shutdowns;
    const what = `Reconnect attempt #${attemptNumber}`;
    try {
      // Drop the wedged hub so connectMarketHub builds a fresh one.
      await this.signalr.disconnectMarket();
      if (this.abandoned(at, what)) return;
      await this.openHub();
      if (this.abandoned(at, what)) return;
      // Server dropped subs on disconnect but contractSubs is still
      // populated locally, so syncContractSubs would no-op. Resubscribe
      // every tracked contract first; sync handles deployment churn.
      await this.resubscribeAll();
      if (this.abandoned(at, what)) return;
      await this.syncContractSubs(this.deps.realtimeDeployments());
      if (this.abandoned(at, what)) return;
      // Broadcaster tracks contracts independently for browser quote
      // forwarding — its subs got dropped too.
      void peekBroadcaster()?.resubscribeMarketContracts();
      this.deps.logEvent(
        "hub_reconnected",
        ENGINE_CTX,
        `SIGNALR RECONNECTED — recovered after ${attemptNumber} attempt(s)`,
      );
    } catch (err) {
      // Stay in passive mode; loop will try again in 60s. Don't log every
      // failure as ERROR — it's expected while another session holds the
      // single CME slot.
      this.deps.logEvent(
        "hub_reconnect_failed",
        ENGINE_CTX,
        `Reconnect attempt #${attemptNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // If the auto-heal timer fired this attempt (no 60s loop was running
      // because we entered passive mid-maintenance) and the reconnect
      // failed, kick the loop on now that we're out of the window. Without
      // this, a stalled gateway extending past 18:00 ET leaves us passive
      // with no further retries scheduled.
      if (
        this.hubMode === "passive" &&
        this.passiveAutoRetry &&
        !this.reconnectInterval &&
        !isInMaintenanceWindow()
      ) {
        this.deps.log(
          ENGINE_CTX,
          "info",
          "connection",
          "Auto-heal reconnect failed past maintenance-end — resuming 60s retry loop",
        );
        this.startPassiveAutoRetry();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Rebuild both hubs onto a token that rotated underneath them.
   *
   * Fired by the heartbeat, at most once per rotation: the new token is
   * stamped as this controller's session **before** anything is attempted,
   * so a rebuild that fails falls back to today's behaviour (the stall
   * watchdog for the market hub) rather than re-firing every 30s against a
   * broker that is refusing.
   *
   * The market-hub sequence is the same five statements as the inline
   * watchdog retry, `attemptReconnect` and `reconnectManually` — a fourth
   * copy, deliberately not extracted here because three of the four are
   * pre-existing and a lift touching them belongs in its own commit. Filed
   * in the punchlist's Dev queue.
   */
  /** Whether the REST client's token has moved off the one these hubs were
   *  opened on. False before the first `connect()` records one. */
  tokenMovedUnderHubs(): boolean {
    const token = this.deps.brokerToken();
    return token != null && this.hubSessionToken != null && token !== this.hubSessionToken;
  }

  /**
   * The rotation rebuild, entered by the engine rather than the heartbeat —
   * for a rotation its own user-hub validate caused (A79). Waiting for the
   * heartbeat left the market hub on the retired session for up to 30s.
   * The stamp in `rebuildAfterTokenRotation` is synchronous, so a heartbeat
   * landing later sees no rotation and does not fire a second rebuild.
   */
  async rebuildOnTokenMove(): Promise<void> {
    const token = this.deps.brokerToken();
    const bound = this.hubSessionToken;
    if (token == null || bound == null || token === bound) return;
    await this.rebuildAfterTokenRotation(bound, token);
  }

  private async rebuildAfterTokenRotation(oldToken: string, newToken: string): Promise<void> {
    const fp = (t: string) => t.slice(-TOKEN_FINGERPRINT_CHARS);
    this.hubSessionToken = newToken;
    this.deps.logEvent(
      "hub_token_rotated",
      ENGINE_CTX,
      `Session token rotated under the open hubs (…${fp(oldToken)} → …${fp(newToken)}) — rebuilding both before the gateway stops streaming`,
    );

    await this.rebuildMarketHubOnRotatedToken();

    // Unconditional, and it does not consult the user hub's reported state:
    // `attemptUserReconnect` normally treats `Connected` as "healed itself",
    // which is the one inference a rotated session makes false. It runs when
    // a stop abandoned the market leg too: the user hub is the dashboard's
    // feed as well as the engine's, and a retired session is the one state
    // nothing else reconnects.
    await this.deps.reconnectUserHub("token-rotation");
  }

  private async rebuildMarketHubOnRotatedToken(): Promise<void> {
    if (!this.signalr || this.hubMode !== "realtime" || this.reconnecting) return;
    this.reconnecting = true;
    const at = this.shutdowns;
    const what = "Market hub rebuild after token rotation";
    try {
      await this.signalr.disconnectMarket();
      if (this.abandoned(at, what)) return;
      await this.openHub();
      if (this.abandoned(at, what)) return;
      await this.resubscribeAll();
      if (this.abandoned(at, what)) return;
      await this.syncContractSubs(this.deps.realtimeDeployments());
      if (this.abandoned(at, what)) return;
      void peekBroadcaster()?.resubscribeMarketContracts();
      this.lastActivity = Date.now();
      this.deps.logEvent(
        "hub_reconnected",
        ENGINE_CTX,
        "SIGNALR RECONNECTED — market hub rebuilt on the rotated token",
      );
    } catch (err) {
      this.deps.logEvent(
        "hub_reconnect_failed",
        ENGINE_CTX,
        `Market hub rebuild after token rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Manual reconnect from the dashboard button. Wipes the cached token via
   * clearCachedToken (called inside validateOrRefreshToken's loginKey path
   * when validate fails) so the mint produces a fresh session that will
   * displace whoever else has the user's slot.
   */
  async reconnectManually(): Promise<{ ok: boolean; error?: string }> {
    if (!this.signalr) {
      return { ok: false, error: "SignalR not configured (USE_REALTIME_BARS off)" };
    }
    if (this.reconnecting) {
      return { ok: false, error: "Reconnect already in progress" };
    }
    this.reconnecting = true;
    this.deps.logEvent(
      "hub_reconnecting",
      ENGINE_CTX,
      "SIGNALR RECONNECTING — manual trigger from dashboard",
    );
    const at = this.shutdowns;
    const what = "Manual reconnect";
    const stoppedMidway = { ok: false, error: "The engine stopped while the reconnect was in flight" };
    try {
      await this.signalr.disconnectMarket();
      if (this.abandoned(at, what)) return stoppedMidway;
      await this.openHub();
      if (this.abandoned(at, what)) return stoppedMidway;
      // Server dropped subs on disconnect; marketSubs is still populated
      // locally so syncContractSubs would no-op on existing keys. Resubscribe
      // every tracked contract first, then sync handles deployment churn.
      // Mirrors attemptReconnect — without this, manual reconnects rebuild
      // the hub but no trades flow until a deployment edit churns
      // syncContractSubs.
      await this.resubscribeAll();
      if (this.abandoned(at, what)) return stoppedMidway;
      await this.syncContractSubs(this.deps.realtimeDeployments());
      if (this.abandoned(at, what)) return stoppedMidway;
      // Broadcaster's tracked contracts survived the kick but its server-side
      // subscriptions didn't — re-issue so browser quote forwarding resumes.
      void peekBroadcaster()?.resubscribeMarketContracts();
      this.deps.logEvent(
        "hub_reconnected",
        ENGINE_CTX,
        "SIGNALR RECONNECTED — manual reconnect succeeded",
      );
      void sendConnectionAlert({
        title: "Engine market hub restored",
        color: COLOR_CONNECTION_RESTORED,
        fields: [{ name: "Trigger", value: "Manual reconnect from dashboard" }],
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logEvent("hub_reconnect_failed", ENGINE_CTX, `Manual reconnect failed: ${message}`);
      return { ok: false, error: message };
    } finally {
      this.reconnecting = false;
    }
  }

  // ── Subscription sync ───────────────────────────────────────────────

  /** Reconcile aggregator + market-data subscriptions to exactly the set
   *  needed by the given enabled deployments. Aggregators are keyed by
   *  (contractId, timeframe) so multiple cadences on one contract coexist;
   *  the underlying SignalR subscribeTrades is ref-counted at the contract
   *  level via `marketSubs`. */
  async syncContractSubs(deployments: Deployment[]): Promise<void> {
    if (!this.signalr) return;

    interface NeededEntry {
      contractId: string;
      contract: Contract;
      timeframe: Timeframe;
      deploymentIds: Set<string>;
    }
    const needed = new Map<SubKey, NeededEntry>();
    const neededContracts = new Map<string, { contract: Contract; timeframes: Set<Timeframe> }>();

    // Exit-eval site (subscription scope): a `Pausing` / `Destroying` leg
    // still needs its contract+timeframe aggregator + market trades
    // flowing — both the bar-close exit pass and the per-tick realtime exit
    // evaluator key off these subs. This used to read
    // `x.enabled || legHasOpenPosition(x.id)`; the status now says it
    // directly, so the position probe came out with the widening.
    const need = (id: string, contract: Contract, tf: Timeframe): void => {
      const key = makeSubKey(contract.id, tf);
      const entry = needed.get(key) ?? {
        contractId: contract.id,
        contract,
        timeframe: tf,
        deploymentIds: new Set<string>(),
      };
      entry.deploymentIds.add(id);
      needed.set(key, entry);

      const ce = neededContracts.get(contract.id) ?? { contract, timeframes: new Set<Timeframe>() };
      ce.timeframes.add(tf);
      // Prefer the contract with executionContractId set (Tradovate broker) so
      // the marketSub carries the execution alias needed for the double-emit.
      if (!ce.contract.executionContractId && contract.executionContractId) {
        ce.contract = contract;
      }
      neededContracts.set(contract.id, ce);
    };

    const unresolved = new Map<string, { d: Deployment; reason: string }>();
    for (const d of deployments.filter((x) => isEngineManagedStatus(x.status))) {
      const strategy = getStrategy(d.strategyKey);
      if (!strategy) continue;
      // One leg the broker cannot resolve must not take the others' feed
      // with it: a throw here used to abort the whole sync.
      let contract: Contract;
      try {
        contract = await this.deps.resolveContract(d.ticker, d.accountId);
      } catch (err) {
        unresolved.set(d.id, { d, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      need(d.id, contract, resolveTimeframe(strategy.config, d.paramValues) as Timeframe);
    }

    // A leg that resolved before keeps the subscription it already has: a
    // transient resolver failure must not cut the stream an open position's
    // exits run on.
    const carried = new Set<string>();
    for (const sub of this.contractSubs.values()) {
      for (const id of sub.refs) {
        if (unresolved.has(id)) {
          need(id, sub.contract, sub.timeframe);
          carried.add(id);
        }
      }
    }
    // Only a leg with no stream at all is a page; a carried one still gets bars.
    for (const [id, { d, reason }] of unresolved) {
      const isCarried = carried.has(id);
      this.deps.logEvent(
        isCarried ? "deployment_contract_lookup_failed" : "deployment_contract_unresolved",
        id,
        `Contract lookup for ${d.ticker} failed: ${reason} — ${isCarried ? "kept its existing subscription" : "leg left out of realtime subscriptions"}; retried every ${UNRESOLVED_RETRY_MS / 60_000} min`,
        { accountId: d.accountId },
      );
    }
    this.unresolvedLegs = new Set(unresolved.keys());
    // Any sync is an attempt; the retry clock runs from the last one.
    if (unresolved.size > 0) this.lastUnresolvedRetryAt = Date.now();

    for (const [key, entry] of needed) {
      const existing = this.contractSubs.get(key);
      if (existing) {
        existing.refs = entry.deploymentIds;
        existing.contract = entry.contract;
        continue;
      }
      const aggregator = new BarAggregator(entry.timeframe);
      aggregator.onBarClose((bar, previousPublishedAt) =>
        this.deps.onBarClose(key, bar, previousPublishedAt),
      );
      this.contractSubs.set(key, {
        contractId: entry.contractId,
        contract: entry.contract,
        aggregator,
        timeframe: entry.timeframe,
        refs: entry.deploymentIds,
      });
    }

    // Reconcile per-contract market-data subscriptions. Subscribe fires
    // only when a contract first appears (refCount 0 → 1); unsubscribe
    // fires only when its last aggregator drops.
    const newlySubscribed: string[] = [];
    for (const [contractId, ce] of neededContracts) {
      const existing = this.marketSubs.get(contractId);
      const refCount = Array.from(needed.values()).filter((e) => e.contractId === contractId).length;
      if (existing) {
        existing.refCount = refCount;
        existing.contract = ce.contract;
        existing.timeframes = ce.timeframes;
        continue;
      }
      this.marketSubs.set(contractId, {
        contract: ce.contract,
        refCount,
        timeframes: ce.timeframes,
        lastTickPrice: null,
      });
      newlySubscribed.push(contractId);
    }

    for (const contractId of newlySubscribed) {
      try {
        await this.signalr.subscribeTrades(contractId);
        this.deps.log(ENGINE_CTX, "info", "connection", `Subscribed to trades for ${contractId}`, {
          contractId,
        });
      } catch (err) {
        this.deps.log(
          ENGINE_CTX,
          "warn",
          "connection",
          `subscribeTrades(${contractId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          { contractId },
        );
      }
    }

    // Drop aggregators no deployment still wants.
    for (const [key, sub] of this.contractSubs) {
      if (!needed.has(key)) {
        sub.aggregator.dispose();
        this.contractSubs.delete(key);
      }
    }

    // Drop market subs for contracts no aggregator still references. The
    // event-broadcaster also calls subscribeTrades/unsubscribeTrades on this
    // hub for browser-tracked contracts; the engine and broadcaster share a
    // single SignalR client, so unsubscribing here while the broadcaster is
    // still tracking the same contract will yank its stream too. Pre-existing
    // collision; not addressed in this change.
    for (const [contractId] of this.marketSubs) {
      if (!neededContracts.has(contractId)) {
        try {
          await this.signalr.unsubscribeTrades(contractId);
        } catch {
          // Non-fatal; hub may have already dropped it.
        }
        this.marketSubs.delete(contractId);
      }
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  /** Periodic diagnostic heartbeat. Always-on so its absence is itself a
   *  signal (Node event loop blocked, not just the market hub). Anomalies
   *  detected here are logged twice — once as `heartbeat` for the steady
   *  cadence and once as `warn`/`error` so users on those filters see them
   *  too. */
  startHeartbeat(): void {
    // `start()` reaches the controller here in both of its arms — the mirror
    // of `stop()` → `shutdown()` — so this is what lifts the barrier when the
    // hub stayed open across the stop and no `connect()` follows.
    this.stopped = false;
    // Over a hub that stayed open no `connect()` follows, so nothing else
    // re-arms the watchdog `shutdown()` cleared — including a hub a reconnect
    // raced open across the stop, whose own arm the latch refused.
    if (this.ready && this.hubMode === "realtime" && !this.watchdogInterval) this.startWatchdog();
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      // Maintenance break / weekend gap: gateway is down by design. The
      // heartbeat's whole purpose is to surface unexpected silence — during
      // a known-down window every tick would be a false positive. Skip the
      // emission entirely; auto-heal is already scheduled for window end.
      if (isInMaintenanceWindow()) {
        // Zeroed unlogged, or the first line after the break would carry the
        // whole break's requests as one 30s window.
        takeTopstepRequestWindow();
        return;
      }
      const lastMarketActivityAt = this.lastActivity;
      const lastTradeAgeS = lastMarketActivityAt > 0
        ? Math.round((Date.now() - lastMarketActivityAt) / 1000)
        : -1;
      const contracts = this.marketSubs.size;
      const aggs = this.contractSubs.size;
      // Entry-eval scope: heartbeat reports the count of legs accepting
      // new entries. `Pausing` / `Destroying` legs are still managed but
      // cannot enter, so they don't count as active here.
      const activeDeployments = this.deps
        .realtimeDeployments()
        .filter((d) => d.status === "Active").length;
      const queued = this.deps.pendingBarCloseCount();
      const mTrades = this.marketTradeWindowCount;
      this.marketTradeWindowCount = 0;
      // Hub states read directly from the SignalR connection. "NotBuilt"
      // = hub never opened (engine boot still in progress). Anything other
      // than "Connected" while marketHub.mode() === "realtime" is an anomaly.
      const marketState = this.signalr?.getMarketHubState() ?? "NotBuilt";
      const userState = this.deps.userHubState() ?? "NotBuilt";
      // User-hub event activity — the realtime adapter owns the counters
      // because it owns the on(...) handlers. Every consumer (engine fill
      // reconciliation, SSE relay) shares the same hub instance.
      const userLive = this.deps.userHubLiveness();
      const uEvents = userLive?.windowCount ?? 0;
      const uAgeS = userLive && userLive.lastEventAt > 0
        ? Math.round((Date.now() - userLive.lastEventAt) / 1000)
        : -1;
      // JWT fingerprint — last 12 chars of the signature segment. Changes
      // here mid-realtime mean /Auth/validate rotated the token and the
      // SignalR hub is bound to the (now-stale) old token. Acted on below;
      // for years this was a line an operator had to notice.
      const token = this.deps.brokerToken();
      const tokFp = token ? token.slice(-TOKEN_FINGERPRINT_CHARS) : "—";

      const fmtAge = (s: number) => (s < 0 ? "never" : `${s}s ago`);
      const human =
        `${this.hubMode} · ${activeDeployments} deps / ${contracts} contracts / ${aggs} aggregators · ` +
        `market ${marketState} (${mTrades}/win, last trade ${fmtAge(lastTradeAgeS)}) · ` +
        `user ${userState} (${uEvents}/win, last event ${fmtAge(uAgeS)}) · ` +
        `${queued} queued · token …${tokFp} · ${takeTopstepRequestWindow()}`;
      this.deps.log(ENGINE_CTX, "info", "heartbeat", human);

      // ── Token rotation ───────────────────────────────────────────
      // Checked before the anomaly block, because a rotated session is a
      // hub that answers `Connected` and streams nothing — so neither of
      // the checks below can see it. The market half is merely *late* to
      // it (the stall watchdog trips on trade silence 120s in, and not at
      // all on a quiet contract or with nothing subscribed); the user half
      // is never reached, because its trigger is `userState !== "Connected"`
      // and a retired session does not change the reported state. Fill
      // detection would stay dead until something restarted the engine.
      if (token != null && this.hubSessionToken != null && token !== this.hubSessionToken) {
        void this.rebuildAfterTokenRotation(this.hubSessionToken, token);
      }

      // ── Unresolved contracts ─────────────────────────────────────
      // A failed lookup at boot would otherwise stay failed until an edit or
      // a hub rebuild, with one page and then silence.
      if (this.unresolvedLegs.size > 0) void this.retryUnresolved();

      // ── Anomaly detection ────────────────────────────────────────
      // Only fires when the engine *should* be receiving market data —
      // realtime mode with at least one subscription and the hub claiming
      // to be Connected. We don't double-log when we're in passive mode
      // intentionally (passive's whole point is no realtime traffic).
      if (this.hubMode === "realtime" && contracts > 0) {
        if (marketState !== "Connected") {
          this.deps.logEvent(
            "hub_wedged",
            ENGINE_CTX,
            `Market hub reports state=${marketState} while engine in realtime mode — hub is wedged.`,
          );
        } else if (lastTradeAgeS > HEARTBEAT_TRADE_SILENCE_WARN_S) {
          // Trade silence on an active hub is suspicious for any contract
          // we'd actually subscribe to. Flag before the watchdog trips on
          // MARKET_HUB_STALL_MS so the warn appears in the log first.
          this.deps.logEvent(
            "hub_trade_silence",
            ENGINE_CTX,
            `No market trades for ${lastTradeAgeS}s on ${contracts} subscribed contract(s) — hub may be silently retired.`,
          );
        }
      }

      // User-hub anomaly: same idea as the market-hub check above. The user
      // hub powers fill detection (entry/exit reconciliation) and the
      // dashboard's live position/order panels. If it's not Connected while
      // any deployment is active, kick a single reconnect — rate-limited so
      // a real session displacement isn't fought every tick.
      if (activeDeployments > 0 && userState !== "Connected") {
        this.deps.logEvent(
          "user_hub_degraded",
          ENGINE_CTX,
          `User hub reports state=${userState} with ${activeDeployments} active deployment(s) — fill detection degraded.`,
        );
        const sinceLast = Date.now() - this.lastUserAnomalyReconnectAt;
        if (sinceLast >= USER_RECONNECT_MIN_INTERVAL_MS) {
          // Stamped at the call, so the window holds while a slow attempt is
          // still running (A29); handed back if no attempt actually ran (e.g.
          // `userReconnecting=true`), so a short-circuit does not burn it.
          const previousAnchor = this.lastUserAnomalyReconnectAt;
          this.lastUserAnomalyReconnectAt = Date.now();
          void this.deps
            .reconnectUserHub("heartbeat")
            .then((attempted) => {
              if (!attempted) this.lastUserAnomalyReconnectAt = previousAnchor;
            })
            .catch((err) => {
              this.deps.logEvent(
                "hub_reconnect_failed",
                ENGINE_CTX,
                `Heartbeat user-hub reconnect threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }
    }, HEARTBEAT_MS);
  }

  private async retryUnresolved(): Promise<void> {
    if (this.unresolvedRetryInFlight || this.hubMode !== "realtime") return;
    if (Date.now() - this.lastUnresolvedRetryAt < UNRESOLVED_RETRY_MS) return;
    this.unresolvedRetryInFlight = true;
    this.lastUnresolvedRetryAt = Date.now();
    try {
      await this.syncContractSubs(this.deps.realtimeDeployments());
    } catch (err) {
      this.deps.logEvent(
        "hub_init_failed",
        ENGINE_CTX,
        `Contract-lookup retry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.unresolvedRetryInFlight = false;
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ── Teardown ────────────────────────────────────────────────────────

  /** Drop every aggregator and market-data subscription this controller
   *  holds. Called from the engine's `stop()` at the point the inline
   *  teardown used to sit. */
  teardownSubscriptions(): void {
    // Tear down realtime subscriptions if active. Unsubscribe drives off
    // marketSubs so each contract gets exactly one unsubscribeTrades call,
    // even when N aggregators were sharing it.
    if (this.signalr) {
      for (const contractId of this.marketSubs.keys()) {
        void this.signalr.unsubscribeTrades(contractId).catch(() => {});
      }
    }
    for (const sub of this.contractSubs.values()) {
      sub.aggregator.dispose();
    }
    this.contractSubs.clear();
    this.marketSubs.clear();
    this.unresolvedLegs.clear();
  }

  /** Tear down every timer this controller owns and reset to a clean
   *  realtime-mode baseline. Called from the engine's `stop()`; without it
   *  a stopped engine keeps trying to bring the market hub back up.
   *
   *  A barrier, not only a sweep: it raises `stopped` and moves `shutdowns`,
   *  so a reconnect suspended on an `await` abandons when it resumes and
   *  nothing re-arms afterwards. `ready` is deliberately left alone — the
   *  socket stays open across a stop, and reporting it down would make the
   *  next `start()` build a second hub over it; a close that lands while
   *  stopped marks it down instead (`enterPassiveMode`). */
  shutdown(): void {
    this.stopped = true;
    this.shutdowns++;
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.cancelMaintenanceHeal();
    this.stopWatchdog();
    this.inlineReconnectAttempt = 0;
    this.hubMode = "realtime";
    this.reconnectAttempt = 0;
  }
}
