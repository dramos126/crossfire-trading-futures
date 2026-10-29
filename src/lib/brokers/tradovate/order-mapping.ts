/**
 * Outbound order translator: engine `PlaceOrderRequest` → Tradovate
 * REST body shape.
 *
 * Routing:
 *   - No brackets   → `POST /order/placeOrder` with `TradovatePlaceOrderBody`
 *   - With brackets → `POST /order/placeOSO`   with `TradovateOSOBody`
 *
 * Bracket math
 * ------------
 * Engine `PlaceOrderRequest.{stopLoss,takeProfit}Bracket.ticks` is a
 * SIGNED tick offset from entry, set at engine.ts:3050-3051:
 *   long  (side 0) → TP +ticks above entry, SL -ticks below entry
 *   short (side 1) → TP -ticks below entry, SL +ticks above entry
 *
 * Tradovate's OSO `bracket1`/`bracket2` carry ABSOLUTE prices instead.
 * The translator multiplies tick offsets by `tickSize` and adds the
 * result to a reference price:
 *   - For Limit/Stop entries: `limitPrice` or `stopPrice` is the reference.
 *   - For Market entries: caller MUST populate `referencePrice` (last
 *     trade or mid). Translator throws if missing — Phase 4 wires this
 *     in via the resolver/quote feed.
 *
 * Conservative validation (pre-OSO-spike)
 * ---------------------------------------
 * The plan defers a small server-side bracket-validation spike until
 * after Phase 7. Until then the translator validates client-side
 * everything we'd rather catch before shipping a malformed body. Each
 * such check is tagged `TODO(post-spike)` so the cleanup commit is a
 * mechanical grep:
 *   - Wrong-side SL (SL must be < entry for long, > entry for short)
 *   - Wrong-side TP (TP must be > entry for long, < entry for short)
 *   - Zero-width bracket (SL price == TP price)
 *   - Sub-tick prices (must align to `tickSize`)
 *   - Both brackets on the same side (degenerate)
 *
 * Note: Tradovate's `failureReason` shape isn't exhaustively catalogued
 * in their docs; the spike will replace these guesses with measured
 * reality.
 */

import type {
  PlaceOrderRequest,
  OrderType,
} from "@/lib/brokers/types";
import type {
  TradovateAction,
  TradovateBracketLeg,
  TradovateOrderType,
  TradovateOSOBody,
  TradovatePlaceOrderBody,
  TradovateTimeInForce,
} from "./types";

/** Per-account static identity Tradovate requires on every order. The
 *  registry that owns these (Phase 4) hands them to the translator. */
export interface TradovateAccountContext {
  accountSpec: string;
  accountId: number;
  deviceId: string;
}

/** Resolved Tradovate-side contract identity for the order. Comes from
 *  `TradovateContractResolver.resolve(...)` upstream of the translator. */
export interface TradovateContractContext {
  /** Tradovate dated symbol string, e.g. "MESU2025". */
  symbol: string;
  /** Contract tick size (e.g. 0.25 for /ES). Required for bracket math. */
  tickSize: number;
}

export interface TranslateResult {
  endpoint: "/order/placeOrder" | "/order/placeOSO";
  body: TradovatePlaceOrderBody | TradovateOSOBody;
}

/**
 * Map Topstep numeric `OrderType` to Tradovate's string enum. v1 only
 * uses Market (2) and Limit (1) for entries. Stop (4) reaches Tradovate
 * via bracket SL legs only — the engine never submits a standalone Stop
 * entry order today. TrailingStop (5), JoinBid (6), JoinAsk (7) have no
 * Tradovate analog in the prior-art and aren't reachable from current
 * strategies; we throw rather than silently downgrade.
 */
function mapTopstepOrderType(type: OrderType): TradovateOrderType {
  switch (type) {
    case 1: return "Limit";
    case 2: return "Market";
    case 4: return "Stop";
    case 5:
    case 6:
    case 7:
    default:
      throw new Error(
        `Tradovate translator: unsupported Topstep OrderType ${type} (no entry-order analog)`,
      );
  }
}

/** Topstep `OrderSide` (0=Buy, 1=Sell) → Tradovate `action`. */
function mapEntryAction(side: 0 | 1): TradovateAction {
  return side === 0 ? "Buy" : "Sell";
}

/** Bracket exits trade in the OPPOSITE direction of the entry. */
function exitAction(entrySide: 0 | 1): TradovateAction {
  return entrySide === 0 ? "Sell" : "Buy";
}

/** Round to the nearest `tickSize` step. Decimal arithmetic is risky
 *  here — tickSize is a power of ten or a half/quarter step on every
 *  CME contract we trade, and the multiply-divide-round trick is the
 *  same one bracket math uses elsewhere. */
function roundToTick(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  return Math.round(ticks * tickSize * 1e8) / 1e8;
}

/** Compute the absolute reference price the bracket math anchors to. */
function resolveReferencePrice(req: PlaceOrderRequest): number {
  if (req.referencePrice !== undefined && Number.isFinite(req.referencePrice)) {
    return req.referencePrice;
  }
  // Limit / Stop entries carry their own reference; use it.
  if (req.type === 1 && typeof req.limitPrice === "number") {
    return req.limitPrice;
  }
  if (req.type === 4 && typeof req.stopPrice === "number") {
    return req.stopPrice;
  }
  throw new Error(
    `Tradovate translator: bracketed order requires referencePrice ` +
    `for Market entries (or limitPrice/stopPrice for Limit/Stop entries). ` +
    `None present on PlaceOrderRequest — Phase 4 must thread the entry-bar ` +
    `close (or a fresh quote) through PlaceOrderRequest.referencePrice.`,
  );
}

/**
 * Translate a `PlaceOrderRequest` into the Tradovate REST body + endpoint.
 * Pure function — no I/O. The client owns the actual POST.
 */
export function translatePlaceOrder(
  req: PlaceOrderRequest,
  account: TradovateAccountContext,
  contract: TradovateContractContext,
): TranslateResult {
  const orderType = mapTopstepOrderType(req.type);
  const action = mapEntryAction(req.side);

  const baseBody: TradovatePlaceOrderBody = {
    accountSpec: account.accountSpec,
    accountId: account.accountId,
    action,
    orderType,
    timeInForce: "Day",
    orderQty: req.size,
    isAutomated: true,
    deviceId: account.deviceId,
    symbol: contract.symbol,
  };
  if (typeof req.limitPrice === "number") baseBody.price = req.limitPrice;
  if (typeof req.stopPrice === "number") baseBody.stopPrice = req.stopPrice;

  const hasBrackets = req.stopLossBracket || req.takeProfitBracket;
  if (!hasBrackets) {
    return { endpoint: "/order/placeOrder", body: baseBody };
  }

  // Bracket path. tickSize is required regardless of where the reference
  // comes from — it's the unit of the signed offsets.
  if (typeof contract.tickSize !== "number" || contract.tickSize <= 0) {
    throw new Error(
      `Tradovate translator: bracketed order requires positive tickSize on contract context (got ${contract.tickSize})`,
    );
  }
  const refPrice = resolveReferencePrice(req);

  let bracket1: TradovateBracketLeg | undefined; // SL
  let bracket2: TradovateBracketLeg | undefined; // TP

  if (req.stopLossBracket) {
    const slAbsoluteTicks = req.stopLossBracket.ticks;
    const slPrice = roundToTick(refPrice + slAbsoluteTicks * contract.tickSize, contract.tickSize);
    // TODO(post-spike): server may reject wrong-side SL; redundant if so.
    //   Spike (deferred to post-Phase-7) will confirm.
    if (req.side === 0 && slPrice >= refPrice) {
      throw new Error(
        `Tradovate translator: long SL (${slPrice}) must be below entry (${refPrice})`,
      );
    }
    if (req.side === 1 && slPrice <= refPrice) {
      throw new Error(
        `Tradovate translator: short SL (${slPrice}) must be above entry (${refPrice})`,
      );
    }
    bracket1 = {
      action: exitAction(req.side),
      orderType: "Stop",
      stopPrice: slPrice,
      timeInForce: "GTC",
      isAutomated: true,
    };
  }

  if (req.takeProfitBracket) {
    const tpAbsoluteTicks = req.takeProfitBracket.ticks;
    const tpPrice = roundToTick(refPrice + tpAbsoluteTicks * contract.tickSize, contract.tickSize);
    // TODO(post-spike): server may reject wrong-side TP; redundant if so.
    //   Spike (deferred to post-Phase-7) will confirm.
    if (req.side === 0 && tpPrice <= refPrice) {
      throw new Error(
        `Tradovate translator: long TP (${tpPrice}) must be above entry (${refPrice})`,
      );
    }
    if (req.side === 1 && tpPrice >= refPrice) {
      throw new Error(
        `Tradovate translator: short TP (${tpPrice}) must be below entry (${refPrice})`,
      );
    }
    bracket2 = {
      action: exitAction(req.side),
      orderType: "Limit",
      price: tpPrice,
      timeInForce: "GTC",
      isAutomated: true,
    };
  }

  // TODO(post-spike): server may reject zero-width or same-side brackets;
  //   redundant if so. Spike (deferred to post-Phase-7) will confirm.
  if (bracket1?.stopPrice !== undefined && bracket2?.price !== undefined) {
    if (bracket1.stopPrice === bracket2.price) {
      throw new Error(
        `Tradovate translator: zero-width bracket (SL price == TP price == ${bracket1.stopPrice})`,
      );
    }
    // Same-side check: for a long, SL must be < TP; for a short, SL > TP.
    if (req.side === 0 && bracket1.stopPrice >= bracket2.price) {
      throw new Error(
        `Tradovate translator: degenerate long brackets (SL ${bracket1.stopPrice} >= TP ${bracket2.price})`,
      );
    }
    if (req.side === 1 && bracket1.stopPrice <= bracket2.price) {
      throw new Error(
        `Tradovate translator: degenerate short brackets (SL ${bracket1.stopPrice} <= TP ${bracket2.price})`,
      );
    }
  }

  const osoBody: TradovateOSOBody = { ...baseBody };
  if (bracket1) osoBody.bracket1 = bracket1;
  if (bracket2) osoBody.bracket2 = bracket2;

  return { endpoint: "/order/placeOSO", body: osoBody };
}

/**
 * Coerce a Tradovate place-order response to the engine's
 * `PlaceOrderResponse` shape. Tradovate returns the order id at one of
 * `orderId` (top level) or `order.id` (nested) per the prior-art at
 * tradovateClient.ts:1272 — accept either. On a `failureReason` body,
 * we throw `TradovateOrderRejectionError` from the client wrapper rather
 * than fabricating a `success: false` Topstep envelope.
 */
export function unwrapOrderId(
  res: { orderId?: number; order?: { id?: number } },
): number | null {
  const top = typeof res.orderId === "number" ? res.orderId : null;
  if (top !== null && Number.isFinite(top)) return top;
  const nested = typeof res.order?.id === "number" ? res.order.id : null;
  if (nested !== null && Number.isFinite(nested)) return nested;
  return null;
}
