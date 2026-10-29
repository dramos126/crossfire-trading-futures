/**
 * The neutral broker vocabulary — what `Broker` and `BrokerPlugin` speak.
 *
 * The encoding is Topstep-shaped (`OrderSide = 0 | 1`, `BarUnit` numerics)
 * because the engine stays Topstep-shaped and each broker translates at
 * its own boundary — see `docs/modules/brokers/topstep.md`. Topstep's
 * own wire envelopes live in `topstep/types.ts`, not here.
 */
import { BrokerOrderRole } from "@/lib/trading/orders/order-role";

// ── Accounts ─────────────────────────────────────────────────────────

export interface Account {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
  isVisible: boolean;
  /**
   * Which broker owns this account. Tagged at the broker-registry boundary
   * (src/lib/trading/broker-access/broker-registry.ts) when `searchAccounts` results from
   * each registered broker client are merged. Defaults to `'topstep'` for
   * any account whose discriminator hasn't been set yet — preserves
   * byte-identical behavior for pre-Phase-4 installs where every account
   * is implicitly Topstep.
   */
  broker: "topstep" | "tradovate";
  /**
   * Practice (non-live) flag. Stamped at the broker boundary using each
   * broker's own rule:
   *   - Topstep: `name.startsWith("PRAC-")` per Topstep's account-naming
   *     convention (the wire response carries no live/practice
   *     discriminator field).
   *   - Tradovate: `isStagingEnv()` — Tradovate's live/demo split is
   *     host-level, not per-account; staging targets the demo gateway.
   *
   * `isPracticeAccount(a)` reads this field and stays broker-agnostic;
   * never derive practice from `name` directly elsewhere.
   */
  practice: boolean;
}

// ── Positions ────────────────────────────────────────────────────────

/** Position side: 1 = Long, 2 = Short. A side only — flat is not one. */
export type PositionType = 1 | 2;

export const POSITION_TYPE_LONG: PositionType = 1;
export const POSITION_TYPE_SHORT: PositionType = 2;

/** `Position.type` on a flat position, with `size: 0`. `0` is the code
 *  Topstep's gateway already sends on every close; Tradovate's translator
 *  stamps it for `netPos === 0` (bugs.md A41). Kept out of `PositionType`
 *  so `positionTypeFromSigned` still answers `null` at flat. */
export const POSITION_TYPE_FLAT = 0;

export interface Position {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: PositionType | typeof POSITION_TYPE_FLAT;
  size: number;
  averagePrice: number;
}

/**
 * The signed reading of a position: `+N` long, `−N` short, `0` flat.
 *
 * `type` + `size` and a signed quantity are the same information in two
 * bases — Topstep reports the first, Tradovate the second (`netPos`), and
 * the translator converts. This is the one place that states the
 * convention, so no call site re-derives it.
 *
 * Read positions through this whenever two of them are compared. Comparing
 * `size` alone is not a weaker check, it is a wrong one: an engine long 1
 * against a broker-reported short 1 reads as "size 1, expected 1, matches"
 * while the engine's protective sell-stop is adding to a short. See D-6 in
 * docs/proposals/position-lifecycle.md.
 *
 * Takes only the two fields it reads, so a caller holding a `PositionType`
 * and a size can ask the question without fabricating a whole `Position`.
 * **This does not help a caller holding a trade row** — those carry
 * `OrderSide` (0 Buy, 1 Sell), which collides with `PositionType`
 * (1 Long, 2 Short) at the literal `1` with the opposite meaning. Use
 * `signedSizeForEntrySide` and never cast between the two enums.
 *
 * Total, and canonical at flat: `{ type: 0, size: 0 }`, and the older
 * `{ type: 2, size: 0 }` / `{ type: 1, size: 0 }`, all answer `0`, positive
 * zero.
 */
export function signedSize(p: Pick<Position, "type" | "size">): number {
  // `size` is unsigned by contract on both brokers — Topstep's is unsigned
  // on the wire, Tradovate's is `Math.abs(netPos)`. Normalise anyway: the
  // parameter is deliberately widened past `Position`, so a caller can
  // arrive holding an already-signed quantity, and double-negating a short
  // into a long is the exact inversion this function exists to prevent.
  const size = Math.abs(p.size);
  if (size === 0) return 0;
  return p.type === POSITION_TYPE_LONG ? size : -size;
}

/**
 * Signed reading of an *entry side* + size, for callers holding a trade row
 * rather than a broker `Position`.
 *
 * Exists because `OrderSide` and `PositionType` overlap at the literal `1`
 * with opposite meanings — `1` is Sell as a side and Long as a position
 * type. A cast between them compiles and reads every short as a long, which
 * is silent and is D-6's exact bug class. There is no safe cast; there is
 * this function.
 */
export function signedSizeForEntrySide(side: OrderSide, size: number): number {
  return signedSize({
    type: side === 0 ? POSITION_TYPE_LONG : POSITION_TYPE_SHORT,
    size,
  });
}

/**
 * Inverse of `signedSize`: which side a signed quantity is, or `null` when
 * it is flat.
 *
 * `null` rather than a default side because `PositionType` cannot express
 * flat — there is no third member — so a total inverse would have to invent
 * one. A caller building a `Position.type` maps `null` to
 * `POSITION_TYPE_FLAT`, visibly.
 */
export function positionTypeFromSigned(signed: number): PositionType | null {
  if (signed > 0) return POSITION_TYPE_LONG;
  if (signed < 0) return POSITION_TYPE_SHORT;
  return null;
}

/**
 * The entry side a signed quantity corresponds to, or `null` when it is flat.
 *
 * The inverse of `signedSizeForEntrySide`, and the *only* way to go from a
 * broker `Position` to the `OrderSide` an `OpenPosition` wants: `1` is Long
 * as a `PositionType` and Sell as an `OrderSide`, so a cast reads every long
 * as a short. Compose it — `entrySideFromSigned(signedSize(pos))` — rather
 * than writing a `type === 1 ? 0 : 1` bridge at the call site, which is the
 * same hand-rolled mapping wearing a ternary.
 *
 * `null` at flat for the same reason `positionTypeFromSigned` answers null:
 * neither enum has a third member, and inventing a filler here would put the
 * choice somewhere a caller cannot see it.
 */
export function entrySideFromSigned(signed: number): OrderSide | null {
  if (signed > 0) return 0;
  if (signed < 0) return 1;
  return null;
}

/** Fill/trade record from /api/Trade/search. Side: 0 = Buy, 1 = Sell.
 *
 * `fees` is `number | null` to honor the Tradovate Phase 2 contract
 * (docs/proposals/userhub-trade-subscription.md §Per-broker PnL and fees
 * sourcing): on the WS fill feed, fees arrive as a separate `fillFee`
 * entity in the same SockJS frame and are merged into the staged
 * `TradeFill`. When no matching `fillFee` shows up before the frame
 * boundary (degraded transport path), the adapter dispatches with
 * `fees: null` and logs at warn. Topstep's `GatewayUserTrade` always
 * carries fees inline so the Topstep adapter never produces null.
 *
 * Engine consumers of `TradeFill.fees` are diagnostic only — Layer 1
 * and Layer 2 reconcile-time PnL math both use `feePerSideFor(ticker)
 * * 2 * size` (the published per-side rate) so the two layers stay
 * apples-to-apples on the soak disagreement metric. */
export interface TradeFill {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null;
  fees: number | null;
  side: 0 | 1;
  size: number;
  voided: boolean;
  orderId: number;
}

// ── Orders ───────────────────────────────────────────────────────────

/**
 * Order side: 0 = Bid (Buy), 1 = Ask (Sell)
 * Order type: 1 = Limit, 2 = Market, 4 = Stop, 5 = TrailingStop, 6 = JoinBid, 7 = JoinAsk
 * Order status: 1 = Working, 2 = Filled, 3 = Cancelled, 4 = Rejected, 5 = Pending
 */
export type OrderSide = 0 | 1;
export type OrderType = 1 | 2 | 4 | 5 | 6 | 7;
export type OrderStatus = 1 | 2 | 3 | 4 | 5;

export const ORDER_SIDE_LABELS: Record<OrderSide, string> = { 0: "Buy", 1: "Sell" };
export const ORDER_TYPE_LABELS: Record<OrderType, string> = { 1: "Limit", 2: "Market", 4: "Stop", 5: "TrailingStop", 6: "JoinBid", 7: "JoinAsk" };
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = { 1: "Working", 2: "Filled", 3: "Cancelled", 4: "Rejected", 5: "Pending" };
export const POSITION_TYPE_LABELS: Record<PositionType, string> = { 1: "Long", 2: "Short" };

export interface Order {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  updateTimestamp: string;
  status: OrderStatus;
  type: OrderType;
  side: OrderSide;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  filledPrice: number | null;
  customTag?: string | null;
}

export interface BracketConfig {
  ticks: number;
  type: OrderType;
}

export interface PlaceOrderRequest {
  accountId: number;
  contractId: string;
  type: OrderType;
  side: OrderSide;
  size: number;
  limitPrice?: number;
  stopPrice?: number;
  trailPrice?: number;
  customTag?: string;
  stopLossBracket?: BracketConfig;
  takeProfitBracket?: BracketConfig;
  /**
   * Tradovate-only translation context. Topstep ignores both fields; its
   * server resolves brackets from signed tick offsets directly. Tradovate's
   * OSO body needs absolute prices on `bracket1`/`bracket2`, so the broker
   * translator multiplies bracket ticks × `tickSize` and adds the result
   * to `referencePrice` (or to `limitPrice`/`stopPrice` when the entry
   * carries one). Phase 4 populates these on every Tradovate-routed order.
   *
   * Both optional so Topstep call sites compile unchanged in Phase 3.
   * The Tradovate translator throws a clear error if a bracketed order
   * arrives without sufficient context.
   */
  tickSize?: number;
  referencePrice?: number;
  /**
   * Tradovate-only attribution metadata. Topstep ignores this field —
   * its `customTag` round-trips through the order body and the engine
   * reads the deploymentId fragment off inbound `Order.customTag`.
   *
   * Tradovate rejects unregistered Tag50 values (auto-population was
   * dropped in `2502d71`), so we cannot use the customTag echo to
   * recover the originating deployment from a fill or order event.
   * Instead the broker client persists `(orderId → deploymentId, role)`
   * rows in `tradovate_order_map` after every successful placeOrder;
   * the WS dispatcher / order translator reads them back to attribute.
   *
   * Optional so non-engine callers (e.g. the safety-flatten path that
   * fires without a deployment) compile unchanged. When absent on a
   * Tradovate-routed order the mapping write is skipped — the order
   * still places, but the inbound fill won't resolve to a deployment.
   */
  deploymentId?: string;
  /**
   * Tradovate-only role tag for the mapping write. Defaults to `"entry"`
   * on bracketed entries (the SL/TP rows are derived from the OSO
   * response). Set to `"exit"` for engine-issued standalone market
   * exits / safety flatten orders so the inbound-fill attribution can
   * distinguish a strategy entry from a force-close.
   */
  brokerOrderRole?: BrokerOrderRole;
}

export interface PlaceOrderResponse {
  orderId: number;
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
  /**
   * Bracket leg ids returned synchronously on a Tradovate `/order/placeOSO`
   * success. Tradovate's response carries `oso1Id` (SL leg) and `oso2Id`
   * (TP leg); the adapter surfaces them here so the engine can stamp
   * `sl_order_id` / `tp_order_id` on the trade row immediately, without
   * waiting on the user-hub position event (which races the REST response
   * and only fires once per open position). Topstep does not return
   * bracket ids on `/Order/place` — these stay undefined for the
   * Topstep adapter; bracket attribution there continues via the REST
   * reconciler's `attributeBrackets`.
   */
  tpOrderId?: number;
  slOrderId?: number;
}

// ── Contracts ───────────────────────────────────────────────────────

export interface Contract {
  id: string;
  name: string;
  description: string;
  tickSize: number;
  tickValue: number;
  activeContract: boolean;
  symbolId: string;
  /**
   * Optional broker-side execution identifier — populated by the
   * broker-aware resolver router for Tradovate-routed deployments where
   * the order-body / position-feed identifier differs from the Topstep
   * `id` used for bars + market-data subs.
   *
   * When set, callers placing/cancelling/modifying orders or matching
   * against broker position/order feeds MUST use this; bars + SignalR
   * sub keys keep using `id` (Topstep market data is the bars carve-out
   * regardless of execution broker).
   *
   * Undefined for Topstep-routed deployments — `id` is authoritative
   * for both market data and execution.
   */
  executionContractId?: string;
}

// ── Historical Bars ─────────────────────────────────────────────────

/** Bar unit: 1=Second, 2=Minute, 3=Hour, 4=Day, 5=Week, 6=Month */
export type BarUnit = 1 | 2 | 3 | 4 | 5 | 6;

export interface RetrieveBarsRequest {
  contractId: string;
  live: boolean;
  startTime: string;
  endTime: string;
  unit: BarUnit;
  unitNumber: number;
  limit: number;
  includePartialBar: boolean;
}

// ── Market Data ──────────────────────────────────────────────────────

export interface BarData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Realtime account-event transports ────────────────────────────────

/**
 * Lifecycle state of one broker's account-event transport. The vocabulary
 * is Tradovate's original — it maps onto Topstep's user hub without loss
 * (`authorizing` covers the SignalR handshake, `subscribed` covers
 * Connected) and keeping one union means the engine's diagnostics read
 * the same for both brokers.
 */
export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "authorizing"
  | "subscribed"
  | "reconnecting"
  | "auth-failed"
  | "disposed";

export interface RealtimeStatusSnapshot {
  state: RealtimeConnectionState;
  /** Epoch-ms of the most recent inbound frame (heartbeat or data). 0 if
   *  no frame has arrived yet on the current process. */
  lastEventAt: number;
  /** Epoch-ms when the transport first reached the `subscribed` state on
   *  the current connection, or null if not yet subscribed. The engine's
   *  cold-start health gate reads `Math.max(lastEventAt, subscribedAt)`
   *  so the health window starts ticking at subscribe-time even before
   *  any inbound event has landed. Reset to null on cleanup so a
   *  reconnect re-establishes a fresh window. */
  subscribedAt: number | null;
  /** Total reconnect attempts since process start. */
  reconnectAttempts: number;
  /** Last error message observed during connect/auth, or null. */
  lastError: string | null;
}
