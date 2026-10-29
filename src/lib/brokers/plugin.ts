import type { Broker } from "@/lib/trading/broker-access/broker";
import type {
  Order,
  Position,
  RealtimeStatusSnapshot,
  TradeFill,
} from "@/lib/brokers/types";

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  envFallback?: string;
}

/**
 * The cross-broker failure taxonomy. Adding a member means updating
 * `messageFor()` in `/api/settings/test-connection`, not just this type
 * — see `docs/modules/brokers/README.md`.
 *
 * `auth` is deliberately *not* enough on its own to decide what the
 * engine does about it: on one broker an auth failure kills the session
 * the whole engine runs on, on another it means pause this account. That
 * second axis is `BrokerCapabilities.authFailureScope`.
 */
export type BrokerErrorKind =
  | "config_missing"
  | "auth"
  | "entitlement"
  | "rate_limited"
  | "network"
  /** The broker will not act for this account at all — Topstep's
   *  AccountNotFound, Tradovate's AccountNotActive. Distinct from `auth`
   *  because the credentials are fine and only this account is dead, and
   *  distinct from `order_rejected` because no later request on this
   *  account will fare better either. Orphan-pauses the account. */
  | "account_unavailable"
  /** The broker accepted the request and refused the order — risk limit,
   *  market closed, bad price. Not auth, not network, not config, and
   *  emphatically **not** account-fatal: forcing it into `auth` would
   *  orphan-pause a deployment for a one-off risk rejection. */
  | "order_rejected"
  | "captcha"
  | "circuit_open";

/**
 * Account attribution stamped on the account-scoped broker errors.
 *
 * Read structurally rather than by class so the engine never names a
 * concrete error type. Attribution of *kind* is the owning plugin's job;
 * this only recovers the id that plugin's client already stamped, and
 * `null` means the caller should fall back to the account it was talking
 * to.
 */
export function brokerErrorAccountId(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const value = (err as { accountId?: unknown }).accountId;
  return typeof value === "number" ? value : null;
}

/**
 * What a broker's protocol and transport require of the engine.
 *
 * Every flag here replaced an `plugin.id === "tradovate"` branch that
 * asked *which broker is this* when it meant *does this broker do X*.
 * The rule for adding one: it must be answerable by a broker author
 * reading their own gateway docs. A flag that can only be filled in by
 * knowing which of our two brokers is being described is the identity
 * branch again, wearing an interface member's clothes.
 *
 * Not everything Tradovate-shaped in the engine belongs here. Choosing
 * *which client to call* is routing (`brokerForAccount`), and choosing
 * *what to log* is observability policy — neither is a capability. See
 * `docs/modules/brokers/README.md`.
 */
export interface BrokerCapabilities {
  /**
   * Closing fills carry realized P&L, and opening fills leave it null —
   * so `profitAndLoss !== null` is a sound closing-fill discriminator.
   * False means the engine must fall back to matching the fill's
   * `orderId` against the trade's bracket/exit ids.
   */
  readonly fillCarriesPnl: boolean;

  /**
   * `searchTrades` only covers the current session, so fills belonging to
   * a trade that closed before a restart are invisible to it and have to
   * be recovered through `getFillsForOrder`. False when `searchTrades` is
   * a genuine time-range query over history.
   */
  readonly historicalFillsRequireOrderLookup: boolean;

  /**
   * Where bracket order ids come from after an entry is placed.
   *
   * - `"sync"` — the place response carries them (Tradovate's OSO), so
   *   the engine stamps them onto the trade row before the call returns.
   * - `"reconciler"` — the response carries none, and the REST
   *   reconciler attributes them by diffing open orders next tick.
   */
  readonly bracketAttribution: "sync" | "reconciler";

  /**
   * What the broker anchors a bracket leg to when the entry order carries
   * one.
   *
   * - `"trigger"` — the leg is priced off the reference price the engine
   *   supplied on the request (`referencePrice`), so it lands on the
   *   strategy's trigger and needs nothing after the fill.
   * - `"fill"` — the leg is a signed tick offset the broker resolves
   *   against its own fill, so the bracket lands `slippage` away from the
   *   trigger and the engine re-anchors it once the fill is known.
   *
   * Both brackets are trigger-anchored by policy — the signal names levels
   * and the fill is an accident of the moment ([bugs.md](../../../docs/bugs.md)
   * A69). This flag says which brokers get there without help.
   */
  readonly bracketAnchor: "trigger" | "fill";

  /**
   * How long to wait after a position-flat event before draining the
   * fill buffer, in milliseconds. Non-zero when the transport can deliver
   * the flat frame ahead of the closing fill frame. `0` means the two are
   * ordered and the engine must not yield at all — an unconditional
   * `setTimeout(…, 0)` is a macrotask on the exit path, not a no-op.
   */
  readonly positionCloseGraceMs: number;

  /**
   * Where the naked-position watchdog finds live stop coverage.
   *
   * - `"open-orders"` — scan the account's working orders for stop-market
   *   legs on the closing side.
   * - `"order-map"` — the open-order list cannot be matched to positions
   *   reliably, so read the engine's own persisted order map and verify
   *   each stop id against the broker one at a time. The map itself is
   *   still per-broker storage; a third broker declaring this needs its
   *   own reader, exactly like `isClosingFill`.
   */
  readonly stopCoverageSource: "open-orders" | "order-map";

  /**
   * Which accounts this broker's realtime adapter should stream.
   *
   * - `"registered"` — one connection per account, so streaming every
   *   account the registry knows costs nothing the engine does not
   *   already pay.
   * - `"traded"` — one shared connection carrying every account the
   *   credential can see, so the engine subscribes only the accounts it
   *   actually trades. Widening this floods the engine with events for
   *   accounts no deployment touches.
   */
  readonly realtimeAccountScope: "registered" | "traded";

  /**
   * The account feed can deliver an entry's fill event **before** the
   * `placeOrder` call that caused it resolves.
   *
   * True on a process-wide connection that is already up when the order
   * goes out (Topstep's user hub races the REST round-trip). The event
   * lands while `activeTradeId` is still null, writes `entry_filled_at`
   * to the row, and returns without promoting onto in-memory position
   * state — so the engine re-reads the row after `placeEntryOrder`.
   *
   * False when the fill event provably follows the place response, which
   * makes that re-read a wasted query on the entry path.
   */
  readonly entryFillMayRacePlaceResponse: boolean;

  /**
   * The account feed drives exit reconciliation on its own, so a healthy
   * feed makes the reconciler's per-account REST fan-out redundant.
   *
   * **This is not transport health.** `realtime.isHealthy()` says the
   * socket is alive; this says REST reconciliation is safe to skip when
   * it is. Topstep's reconciliation has always been unconditional, and
   * wiring the skip to health alone would start dropping a safety path.
   */
  readonly realtimeDrivesReconciliation: boolean;

  /**
   * The transport keeps delivering account events after `engine.stop()`,
   * because holders other than the engine (the browser's SSE relay) keep
   * it up. Those events must not act on engine state while the engine is
   * stopped, so the engine additionally gates on `isRunning()`.
   *
   * False for a per-account transport that `sync(new Set())` disposes —
   * nothing arrives to gate.
   */
  readonly realtimeFeedOutlivesEngineStop: boolean;

  /**
   * What an `auth` failure from this broker costs.
   *
   * - `"engine"` — the credential is the session the engine's whole tick
   *   loop runs on. There is no recovery without operator action, so the
   *   engine stops rather than spamming errors for hours.
   * - `"account"` — the failure is scoped to the accounts this broker
   *   routes, so the deployments on them are orphan-paused and the rest
   *   of the engine keeps running.
   *
   * This is the second axis `BrokerErrorKind` cannot carry: both brokers
   * report the same `auth` kind and the two reactions are opposite.
   */
  readonly authFailureScope: "engine" | "account";
}

/**
 * One broker's **account-event** transport: orders, positions, fills and
 * the reconnect signal. Market data is not here and never will be — that
 * is `MarketDataProvider`'s seam (see `docs/modules/market-data/providers.md`).
 * An adapter that grows a `subscribeTrades` re-couples the two.
 *
 * `sync()` is the primary API. The engine runs a desired-state loop, not
 * an event-driven one, so an increment/decrement pair would let the
 * engine's idea of the live set drift from the adapter's — which for
 * Topstep, whose adapter ref-counts one process-wide hub, is how you
 * leak a hub or drop a live one.
 *
 * Every handler carries `accountId` explicitly. Tradovate knows it from
 * the socket binding; Topstep reads it off the event payload. Putting it
 * in the signature stops the engine inferring it from which adapter
 * fired.
 *
 * Events are translated into the neutral `Order` / `Position` /
 * `TradeFill` **at the adapter boundary**. `GatewayUserOrder` and
 * Tradovate's raw entity shapes do not cross this line.
 */
export interface BrokerRealtimeAdapter {
  /**
   * Desired-state sync of the accounts this adapter streams **on the
   * engine's behalf**. Replaces the engine's previous set wholesale:
   * accounts that left are released, accounts that arrived are joined.
   *
   * Holders other than the engine express interest through
   * `connect`/`disconnect`, which are additive and are *not* pruned by
   * `sync` — Topstep's user hub is shared with the browser's SSE relay,
   * which pins the accounts the operator is watching. The live set is
   * the union of the two.
   */
  sync(accountIds: Set<number>): Promise<void>;
  /** Pin one account outside the engine's desired set. Idempotent. */
  connect(accountId: number): Promise<void>;
  /** Release a pin. Idempotent; safe on unknown ids. */
  disconnect(accountId: number): void;
  /** Tear down every connection this adapter owns, engine set and pins
   *  alike. Process shutdown / test teardown; `engine.stop()` releases
   *  its own interest with `sync(new Set())` instead. */
  shutdown(): void;

  onOrder(handler: (accountId: number, order: Order) => void): void;
  onPosition(handler: (accountId: number, position: Position) => void): void;
  onFill(handler: (accountId: number, fill: TradeFill) => void): void;
  /** Fired after a transport reconnect, so the engine can replay what it
   *  missed. The adapter signals; the replay policy stays on the engine.
   *
   *  `lastEventAtBeforeReconnect` is the lower bound of the gap — the last
   *  event time seen before the feed dropped — carried on the signal
   *  rather than read back off `status()`, because the new socket's
   *  handshake has already bumped the live `lastEventAt` to ~now by the
   *  time this fires. A broker whose replay sources its own lower bound
   *  (Topstep coalesces a whole-engine sweep off `lastTopstepEventAt`) does
   *  not supply it, which is why it is optional. */
  onReconnect(handler: (accountId: number, lastEventAtBeforeReconnect?: number) => void): void;

  /** Per-account transport health, for the engine's watchdog and
   *  polling-fallback logic. */
  isHealthy(accountId: number, now?: number): boolean;
  status(accountId: number): RealtimeStatusSnapshot | null;
}

export interface BrokerPlugin extends Broker {
  readonly id: string;
  readonly displayName: string;

  /** What this broker's protocol requires of the engine. Static — read
   *  it wherever the code used to ask `plugin.id === "…"`. */
  readonly capabilities: BrokerCapabilities;

  isConfigured(): boolean;
  isExpected(): boolean;
  initialize(): Promise<void>;
  invalidate(): void;

  /** Concrete broker client owned by this plugin. Returned as `unknown`
   *  at the interface boundary; callers cast to the per-broker concrete
   *  type. May be `null` before `initialize()` has been called or after
   *  `invalidate()` (Tradovate-only — Topstep returns the client even
   *  pre-init for the routes that own their own token lifecycle). */
  getClient(): unknown;

  getBrowserToken(): Promise<string | null>;

  credentialSchema(): CredentialField[];
  /**
   * Persist credential edits. Field-value semantics:
   *  - `string` (non-empty) — set/overwrite this field
   *  - `null` — explicitly clear this field
   *  - absent key — leave this field alone (masked-input untouched)
   *
   * The interface widens the value type to allow `null` so the route loop
   * can pass through "explicit clear" without per-broker special-casing.
   * Plugin implementations decide how a `null` maps to their backing
   * setter (typically: call the setter with `null` to delete the row).
   */
  applyCredentials(fields: Record<string, string | null>): Promise<void>;
  /**
   * Authenticate against the broker gateway with `overrideFields` (test
   * what the operator typed without persisting) or stored DB creds (test
   * what's already saved). Returns broker-specific metadata callers cast
   * — Topstep returns `undefined`, Tradovate returns
   * `{ expiresAt: number; hasMdAccessToken: boolean }`. Throws on failure.
   */
  testConnection(overrideFields?: Record<string, string>): Promise<unknown>;
  classifyError(err: unknown): BrokerErrorKind;
  /**
   * Whether this error came out of *this* plugin's client.
   *
   * `classifyError` is total — it has to be, because its caller
   * (`/api/settings/test-connection`) already knows which member it
   * asked and needs an answer for anything that came back. Both brokers
   * therefore end in a `return "auth"` catch-all, which makes
   * `classifyError` useless for attribution: ask the wrong plugin about
   * the other's error and it confidently says `auth`.
   *
   * The engine's control flow needs attribution, not just classification
   * — an `auth` it must stop the engine for and an `auth` it must
   * orphan-pause one account for look identical otherwise. This is the
   * predicate that tells them apart, and it is `instanceof` over the
   * plugin's own error classes, which is the one place that belongs.
   */
  ownsError(err: unknown): boolean;
  /**
   * Does this cancel rejection prove the order is already terminal at the
   * broker? Only a structured rejection envelope may answer `true`; an
   * assembled `Error.message` never can, because a transport wrapper
   * interpolates the raw HTTP body and `Not Found` is the commonest reason
   * phrase on the wire.
   *
   * Behavioural, in the same category as `capabilities`: the engine's
   * post-flatten bracket cancel asks what this broker's rejection *means*,
   * not which broker raised it. A `false` — including from a broker that does
   * not implement it — is the fail-safe answer, so the caller takes the loud
   * arm and leaves the row unstamped. Undefined on a broker whose gateway has
   * no such envelope.
   */
  readonly rejectionProvesTerminal?: (err: unknown) => boolean;
  /**
   * Compute the cred-validation signature for a candidate field set
   * without persisting anything. Used by Save handlers to verify the
   * operator clicked Test Connection against these exact values. Throws
   * if any required field is missing from the input map.
   */
  computeCredsSignature(fields: Record<string, string>): string;

  /** Account-event transport. Attached by the engine at construction —
   *  both adapters need engine-owned collaborators (Topstep the shared
   *  `TopstepSignalR`, Tradovate the contract resolver) that the plugin
   *  cannot build for itself. Undefined until then, and on a broker with
   *  no realtime feed. */
  realtime?: BrokerRealtimeAdapter;
}
