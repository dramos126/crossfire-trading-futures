/**
 * Tradovate REST shapes — Phase 1 surface area.
 *
 * Only auth-related shapes + the penalty-response envelope ship here in
 * Phase 1. Order/Account/Position/Fill/Contract/Maturity/OSO shapes land
 * with Phase 3's order-placement work; pre-defining them now would create
 * unreferenced types that drift before they're consumed.
 */

// ── Auth ──────────────────────────────────────────────────────────────

export interface TradovateAuthCredentials {
  name: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: string;
  sec: string;
  deviceId: string;
}

/**
 * Response from `POST /auth/accessTokenRequest` (and `/auth/renewAccessToken`,
 * which returns the same shape).
 *
 * `accessToken` is for REST + the Real-Time WebSocket. `mdAccessToken` is
 * for the Market Data WebSocket (separate host). Phase 1 captures both
 * even though only `accessToken` is consumed today — `mdAccessToken` is
 * required by the v1.5 Tradovate-bars-for-backtesting work and capturing
 * it now means that work doesn't need to relitigate the auth flow.
 *
 * Tradovate sends one of two expiry hints:
 *   - `expirationTime`: ISO timestamp (most common in observed responses)
 *   - `expiresIn`: seconds (sometimes present alongside or instead)
 * Both are optional in the response per the prior-art's defensive
 * fallback. The client coerces whichever is present (or applies a 75-min
 * conservative fallback) into an absolute epoch-ms value.
 */
export interface TradovateAuthResponse {
  accessToken?: string;
  mdAccessToken?: string;
  expirationTime?: string | number;
  expiresIn?: number;
  /** Tradovate's numeric user id. Required by the Real-Time WS subscriber
   *  (Phase 5) — `user/syncRequest` body is `{users: [<userId>]}`. The
   *  REST client captures it at auth time so the WS subscriber doesn't
   *  need a second `/user/list` round-trip. */
  userId?: number;
  // Tradovate sometimes returns user-facing error fields alongside a 200;
  // surface them so the client can throw cleanly without inventing shapes.
  errorText?: string;
  // Captcha-style lockouts on auth come back with these — captured here
  // so the type doesn't have to be cast to read them.
  "p-captcha"?: string;
  "p-time"?: number;
  "p-ticket"?: string;
}

// ── Penalty envelope ──────────────────────────────────────────────────

/**
 * Tradovate's variable-rate-limit response shape. Per the official FAQ
 * (https://github.com/tradovate/example-api-faq), any endpoint can return
 * a body with these three optional keys instead of (or alongside) the
 * normal payload:
 *
 *   - `p-time`: seconds the client must sleep before retrying
 *   - `p-ticket`: opaque token to include in the retry request body
 *   - `p-captcha`: kill-switch — third-party app is locked out from
 *     this endpoint for ~1 hour. Cannot be solved programmatically.
 *
 * Detection: any of these keys present in the response body means we
 * have a penalty envelope, not a real response. The penalty handler
 * branches on which keys are present.
 */
export interface TradovatePenaltyEnvelope {
  "p-time"?: number;
  "p-ticket"?: string;
  "p-captcha"?: string;
}

export function hasPenaltyEnvelope(
  body: unknown,
): body is TradovatePenaltyEnvelope & Record<string, unknown> {
  if (typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  const has = Object.prototype.hasOwnProperty;
  return has.call(o, "p-time") || has.call(o, "p-ticket") || has.call(o, "p-captcha");
}

// ── Contract / Maturity ───────────────────────────────────────────────

/**
 * Item shape returned by `GET /contract/suggest?t=<ROOT>`. Tradovate's
 * entity-system endpoints return loosely-typed objects with many fields;
 * the resolver only consumes the four below. Anything else stays
 * unmodelled to avoid drifting types we don't actually read.
 *
 * Per the prior-art (symbolMapper.ts:226-289), the response is an array
 * with the front contract first by observation. `name` is the dated
 * symbol (e.g. `MESU2025`), `id` is the numeric Tradovate contractId,
 * `contractMaturityId` joins to the maturity item below.
 */
export interface TradovateContractSuggestion {
  id: number;
  name: string;
  /** Some Tradovate responses populate `symbol` instead of (or alongside)
   *  `name`. The defensive root-prefix filter checks both — mirrors the
   *  prior-art at symbolMapper.ts:178-183. */
  symbol?: string;
  contractMaturityId?: number;
}

/**
 * Response shape from `GET /contractMaturity/item?id=<id>`. Returns the
 * expiration date (ISO string) for a given maturity.
 *
 * Tradovate also sends an `isFront` hint on this item. It is deliberately
 * not modelled: this platform's front month is whichever month Topstep's
 * market data is on, so a Tradovate-side front-month opinion has no
 * consumer and having one invites a second roll policy.
 */
export interface TradovateContractMaturity {
  id: number;
  expirationDate?: string;
}

/**
 * Resolved Tradovate contract for a root symbol on a given month. Returned
 * by `TradovateContractResolver.resolveForMonth(...)`. Mirrors the
 * prior-art's `ActiveContract` shape (symbolMapper.ts:121-127) minus its
 * roll-timing flags, which described a roll policy this resolver no longer
 * has — the month comes from the Topstep anchor.
 */
export interface TradovateActiveContract {
  /** Root symbol (e.g. `MES`, `ES`, `MNQ`). */
  root: string;
  /** Dated contract symbol (e.g. `MESU2025`). The Tradovate `name` field. */
  symbol: string;
  /** Tradovate numeric contract id. */
  contractId: number;
  /** ISO-formatted expiration date, or null if maturity lookup failed. */
  maturityIso: string | null;
  /** Epoch-ms expiry, or null if maturity lookup failed. */
  expiryTs: number | null;
  /** Epoch-ms when the resolver decided this contract — used by the
   *  cache TTL. */
  decidedAt: number;
}

// ── Order placement (REST request shapes) ─────────────────────────────

/** Tradovate `action` enum for order side. Always uppercase first letter. */
export type TradovateAction = "Buy" | "Sell";

/** Tradovate `orderType` enum. Mirrors the prior-art at
 *  tradovateClient.ts:1260 — Topstep maps onto these per `mapTopstepOrderType`
 *  in order-mapping.ts. */
export type TradovateOrderType = "Market" | "Limit" | "Stop" | "StopLimit";

/** Tradovate `timeInForce` enum. v1 only emits Day for entries and GTC
 *  for brackets, matching the prior-art's exit/bracket conventions. */
export type TradovateTimeInForce = "Day" | "GTC" | "IOC" | "FOK";

/**
 * `bracket1` / `bracket2` sub-objects on an OSO body. Both carry their
 * own `action` (the *exit* side, opposite of the entry) and absolute
 * prices. The prior-art convention (tradovateClient.ts:1346-1362) uses:
 *   - bracket1 = stop-loss (orderType `Stop`, populated `stopPrice`)
 *   - bracket2 = take-profit (orderType `Limit`, populated `price`)
 * The order-mapping translator preserves this convention so engine
 * exit semantics line up with prior-art expectations.
 */
export interface TradovateBracketLeg {
  action: TradovateAction;
  orderType: TradovateOrderType;
  timeInForce: TradovateTimeInForce;
  isAutomated: true;
  /** Absolute price for Limit-style legs (TP). */
  price?: number;
  /** Absolute trigger price for Stop-style legs (SL). */
  stopPrice?: number;
}

/**
 * Body for `POST /order/placeOrder` — the simple, no-bracket path.
 * Field shapes lifted from the prior-art (tradovateClient.ts:1256-1268).
 *
 * `accountSpec` is the human-readable account tag (e.g. "DEMO12345"),
 * `accountId` is the numeric id. Tradovate requires both on every
 * order; the broker registry (Phase 4) carries both per account.
 *
 * `customTag50` is Tradovate's analog of Topstep's `customTag`. Auto-
 * population from `PlaceOrderRequest.customTag` was removed because
 * Tradovate rejects unregistered values with `Unregisted Tag50` — CME
 * Tag50 is broker-registered metadata, not a customer-set field. The
 * field is reserved for a future operator-configured registered Tag50
 * (Settings UI, per-account, opt-in only); leave it on the type so that
 * plumbing path doesn't have to re-add it.
 */
export interface TradovatePlaceOrderBody {
  accountSpec: string;
  accountId: number;
  action: TradovateAction;
  orderType: TradovateOrderType;
  timeInForce: TradovateTimeInForce;
  orderQty: number;
  isAutomated: true;
  deviceId: string;
  symbol: string;
  price?: number;
  stopPrice?: number;
  customTag50?: string;
}

/** Body for `POST /order/placeOSO` — adds `bracket1` (SL) and
 *  `bracket2` (TP). Otherwise identical to the simple body. */
export interface TradovateOSOBody extends TradovatePlaceOrderBody {
  bracket1?: TradovateBracketLeg;
  bracket2?: TradovateBracketLeg;
}

/**
 * Response shape from `POST /order/placeOrder` and `POST /order/placeOSO`.
 *
 * Tradovate's docs are inconsistent about whether the order id surfaces
 * at the top level (`orderId`) or nested under `order.id` — the prior-art
 * checks both (tradovateClient.ts:1272). The translator's response coercion
 * normalises this; the type captures both so the unwrap is type-safe.
 *
 * On a Tradovate-side rejection, the body comes back with `failureReason`
 * (and sometimes `failureText`) instead of an order id. The order-mapping
 * translator promotes this into a typed `TradovateOrderRejectionError`.
 */
export interface TradovatePlaceOrderResponse {
  orderId?: number;
  order?: { id?: number; contractId?: number };
  /** OSO bracket leg ids — present only on `/order/placeOSO` success.
   *  Probed against demo: `oso1Id` is the SL leg (matches `bracket1` in
   *  the request body), `oso2Id` is the TP leg (matches `bracket2`). The
   *  fill→deployment mapping persists these so an inbound fill on either
   *  leg attributes back to the originating deployment with the correct
   *  role. Absent on plain `/order/placeOrder` responses. */
  oso1Id?: number;
  oso2Id?: number;
  failureReason?: string;
  failureText?: string;
}

/** Body for `POST /order/cancelOrder`. Lifted from prior-art at
 *  tradovateClient.ts:1627-1630. */
export interface TradovateCancelOrderBody {
  orderId: number;
  isAutomated: true;
}

/**
 * Runtime guard for `POST /order/placeOrder` and `POST /order/placeOSO`
 * response bodies. The client casts `await res.json()` at the wire
 * boundary; without a runtime check, a malformed body (empty object,
 * `{failureReason: null}`, typo'd field, array) would let the typed-error
 * promotion silently miss and the order failure would surface as a
 * generic exception. We require either an `orderId` (success) or a
 * `failureReason` (rejection) to be present and well-typed before
 * trusting the body. Mirrors the defensive pattern of `hasPenaltyEnvelope`
 * above.
 */
export function hasPlaceOrderResponseShape(
  o: unknown,
): o is TradovatePlaceOrderResponse {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  const has = Object.prototype.hasOwnProperty;
  if (has.call(r, "orderId") && typeof r.orderId !== "number") return false;
  if (has.call(r, "oso1Id") && typeof r.oso1Id !== "number") return false;
  if (has.call(r, "oso2Id") && typeof r.oso2Id !== "number") return false;
  if (has.call(r, "failureReason") && typeof r.failureReason !== "string") return false;
  if (has.call(r, "failureText") && typeof r.failureText !== "string") return false;
  // Some Tradovate variants nest the id under `order.id` instead of the
  // top-level `orderId` (the prior-art handles both — see
  // TradovatePlaceOrderResponse comment). Treat a well-shaped nested
  // `order.id` as equivalent to top-level `orderId` for guard purposes.
  let hasNestedOrderId = false;
  if (has.call(r, "order")) {
    const nested = r.order;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return false;
    const n = nested as Record<string, unknown>;
    if (has.call(n, "id") && typeof n.id !== "number") return false;
    if (has.call(n, "id")) hasNestedOrderId = true;
  }
  return has.call(r, "orderId") || has.call(r, "failureReason") || hasNestedOrderId;
}

/**
 * Runtime guard for `POST /order/cancelOrder` responses. Tradovate emits
 * either an empty success body or a `failureReason` envelope; both are
 * acceptable. The guard rejects only obviously broken shapes (array,
 * non-object, mistyped `failureReason`).
 */
export function hasCancelOrderResponseShape(
  o: unknown,
): o is TradovatePlaceOrderResponse {
  if (o === null || o === undefined) return true;
  if (typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  const has = Object.prototype.hasOwnProperty;
  if (has.call(r, "failureReason") && typeof r.failureReason !== "string") return false;
  if (has.call(r, "failureText") && typeof r.failureText !== "string") return false;
  return true;
}

/**
 * Body for `POST /order/modifyOrder`. Not exercised in the prior-art
 * (TradingView bridge never modified orders); shape per Tradovate's
 * REST docs. All numeric fields are optional — caller sets only the
 * legs being modified. The engine's only modify call site moves the SL
 * to break-even (engine.ts:5354), which sends a `stopPrice` update.
 */
export interface TradovateModifyOrderBody {
  orderId: number;
  isAutomated: true;
  orderType?: TradovateOrderType;
  orderQty?: number;
  price?: number;
  stopPrice?: number;
}

// ── Order / Position / Fill (REST list-endpoint shapes) ───────────────

/**
 * Item shape from `/order/list`, `/order/items?ids=...` and `/order/item`.
 * Field set is deliberately the *minimum* the engine reads via
 * `searchOpenOrders` after fill-mapping translates to the engine `Order`
 * shape:
 *   - id, accountId, contractId for routing/filtering
 *   - ordStatus to drive the cancellable-orders filter (mirror of
 *     prior-art's `cancelableOrderStatuses` set, tradovateClient.ts:1071)
 *   - action for translation back to Topstep `side`
 *   - orderType, orderQty, price, stopPrice for the Order fields
 *   - fillPrice, customTag50 — the latter propagates customTag back to the
 *     engine's orphan-sweep branch (engine.ts:3399) which matches by
 *     `_shortId_` fragment
 *
 * **`orderType`, `orderQty`, `price` and `stopPrice` are absent on the
 * `/order/list` and `/order/item` payloads** — confirmed on the demo host
 * 2026-10-24 (bugs.md): all four live on the *order version*, not the
 * order. They are optional here because the list item never carries them;
 * `searchOpenOrders` joins the current version (`TradovateOrderVersion`
 * below) onto each order before `translateOrder` runs, so a resting stop
 * answers a real `type`/`stopPrice` as it does on Topstep.
 *
 * Anything else Tradovate returns stays unmodelled — adding it without a
 * consumer would just create drift surface.
 */
export interface TradovateOrder {
  id: number;
  accountId: number;
  contractId: number;
  /** Tradovate ordStatus enum string. The cancellable set is
   *  `{Working, PendingNew, PendingReplace, Suspended, PendingCancel, Unknown}`.
   *  Other values: `Completed`, `Filled`, `Canceled`, `Rejected`, `Expired`. */
  ordStatus: string;
  action: TradovateAction;
  /** Absent on `/order/list` and `/order/item`; the client joins it from
   *  the order version before translation. See the interface note. */
  orderType?: TradovateOrderType;
  /** Absent on `/order/list` and `/order/item`; joined from the version. */
  orderQty?: number;
  /** Absent on `/order/list` and `/order/item`; joined from the version. */
  price?: number;
  /** Absent on `/order/list` and `/order/item`; joined from the version. */
  stopPrice?: number;
  fillPrice?: number;
  customTag50?: string;
  /** ISO timestamp; the prior-art reads it as `timestamp` on fills, but
   *  on orders Tradovate uses both `timestamp` and `executionProviderTimestamp`.
   *  The engine consumes one canonical ISO via the fill-mapping translator. */
  timestamp?: string;
  executionProviderTimestamp?: string;
}

/**
 * Item shape from `/orderVersion/deps?masterid=<orderId>` and
 * `/orderVersion/ldeps?masterids=<ids>`. Confirmed on the demo host
 * 2026-10-24 (bugs.md): the version is where `orderType`, `orderQty`,
 * `price` and `stopPrice` actually live — `/order/list` and `/order/item`
 * carry none of them.
 *
 * `orderId` is the parent-order join key. `id` is the version id: a modify
 * mints a new version with a higher id, so the highest is current.
 * `searchOpenOrders` joins the latest version (highest `id`) per order.
 */
export interface TradovateOrderVersion {
  id: number;
  orderId: number;
  orderType?: TradovateOrderType;
  orderQty?: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TradovateTimeInForce;
}

/**
 * Item shape from `/position/list`. The prior-art (tradovateClient.ts:917-922)
 * filters on `accountId === current && netPos !== 0`; we mirror that.
 *
 * `netPos` is signed: positive = long, negative = short. The fill-mapping
 * translator maps this to Topstep's `PositionType` (1=Long, 2=Short) +
 * `size` (always positive, Topstep convention).
 *
 * `id` is per-account-per-contract and reused across long → flat → short
 * flips, so it names a slot rather than a position. The translator passes
 * it through untouched — fill-mapping's header note has the current list
 * of what reads it and why that is safe today.
 */
export interface TradovatePosition {
  id: number;
  accountId: number;
  contractId: number;
  netPos: number;
  /** Average price of the open position. Tradovate uses different field
   *  names across endpoints (`avgPrice`, `netPrice`); accept either. */
  avgPrice?: number;
  netPrice?: number;
  /** ISO timestamp. */
  timestamp?: string;
}

/**
 * Item shape from `/fill/list` and `/fill/deps?masterid=...`. The
 * `searchTrades` consumers — five reconciliation passes in
 * `engine-reconcile.ts`, the reconnect-gap replay in `engine-realtime.ts`,
 * and `/api/trades/search` — read:
 *   - id, accountId, contractId for routing
 *   - price, qty for fill semantics
 *   - timestamp for the engine-side ISO
 *   - orderId for parent attribution
 *   - action for buy/sell side
 *
 * The fill-mapping translator must compute `profitAndLoss` to match
 * Topstep semantics (null for non-closing fills, dollar PnL for closing
 * fills). Tradovate's fill body sometimes carries a `pnl` field, sometimes
 * not — when absent the translator returns null per Topstep's contract.
 *
 * Tradovate returns dollars and the engine's `profitAndLoss` is already
 * dollars, so there is no points→dollars conversion here. The translator
 * only defends the field shape.
 */
export interface TradovateFill {
  id: number;
  /** REST `/fill/list` carries `accountId` inline. The WS user/syncRequest
   *  `fill` entity does NOT — accountId is implicit from the per-account
   *  socket binding (Gate B probe finding). WS callers must stamp from
   *  the subscriber's bound account; REST callers read it directly. */
  accountId?: number;
  contractId: number;
  /** Tradovate uses `qty` here, not `size`. Always positive. */
  qty: number;
  price: number;
  action: TradovateAction;
  /** Parent order id. Tradovate calls it `orderId` on /fill/deps and
   *  /fill/list — match the prior-art (tradovateClient.ts:890). */
  orderId: number;
  /** ISO timestamp of the fill. */
  timestamp?: string;
  /** Tradovate doesn't always populate this; fill-mapping returns null
   *  when absent to match Topstep's "non-closing fill" semantics. */
  pnl?: number;
  /** Commissions/fees on the fill. Tradovate field name varies
   *  (`commission`, `fees`); accept either. */
  commission?: number;
  fees?: number;
}

/**
 * Streaming-only `fillFee` entity. Tradovate's `/fill/list` REST shape
 * carries fees inline on the `fill`, but the WS user/syncRequest stream
 * splits them out: each `fill` entity is followed in the same SockJS
 * `a[...]` data frame by a `fillFee` entity whose `id` matches the
 * fill's id and whose body carries the four cost components. Per the
 * Gate B probe (docs/proposals/tradovate-fill-feed-probe.md §Additional
 * findings #1 and #5).
 *
 * The Tradovate dispatcher merges the `fillFee` into `TradeFill.fees`
 * before invoking the engine's `fillHandler`, so the engine never sees
 * a partial `TradeFill` — see `realtime.ts` per-frame staging.
 */
export interface TradovateFillFee {
  /** Same as the matching `fill.id` — this is the join key. */
  id: number;
  clearingFee?: number;
  exchangeFee?: number;
  nfaFee?: number;
  commission?: number;
  // currencyId fields exist on the wire but the engine doesn't consume them.
}

/**
 * Item shape from `/account/list`. The engine consumes the broker-neutral
 * `Account` in `@/lib/brokers/types`, so the fill-mapping translator
 * collapses Tradovate's larger shape onto it.
 *
 * Tradovate has no `canTrade` field. The closest is `active: boolean`.
 * Translator maps `active` → `canTrade`.
 *
 * Live vs demo discrimination on Tradovate is host-level, not a per-
 * account field — `isProductionEnv()` (driven by `NEXT_PUBLIC_APP_ENV`)
 * selects the base URL (see `client.ts` DEMO_BASE_URL / LIVE_BASE_URL).
 * Every account returned by `/account/list` belongs to whichever host
 * the client is configured against, which is why `practice` is stamped
 * from the env and not read off a field.
 *
 * The live-account auto-trade block does **not** refuse Tradovate on the
 * prod host: `autoTradeVerdict` permits every Tradovate account, live
 * included, because these are the operator's own cash accounts and no
 * prop firm's TOS governs them. That refusal applies to Topstep only —
 * do not infer one here from the host split. See
 * docs/modules/brokers/README.md for what would falsify it.
 */
export interface TradovateAccount {
  id: number;
  name: string;
  /** Account state per Tradovate. `active: true` ≈ canTrade. */
  active?: boolean;
  /** Tradovate carries balance under `cashBalance` on `/cashBalance/list`,
   *  not on `/account/list`. We populate `balance: 0` in the translator
   *  and document the gap; the engine doesn't read balance via
   *  `searchAccounts` so this is a downstream-display concern only. */
  archived?: boolean;
  /** Tradovate `accountType`: `Customer`, `House`, etc. Unused today;
   *  surfaced here so a future filter (e.g. only-customer) is one
   *  predicate change. */
  accountType?: string;
}
