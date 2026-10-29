/**
 * Inbound translators: Tradovate REST list-endpoint shapes → engine
 * broker-neutral shapes.
 *
 * The engine speaks Topstep types end-to-end; the broker layer translates
 * at the boundary. Each function here is pure: input shape, output shape,
 * no I/O.
 *
 * `searchTrades` consumers expect Topstep `TradeFill` semantics. **Verify a
 * translator change against `engine-reconcile.ts` first** — its five call
 * sites (`healTradeTimestamps`, `validateClosedTradePrices`,
 * `resolveExitFromFills`, `lookupEntryFillTimestamp`,
 * `handleEntryClosedNoPosition`) are the ones that actually read the fields
 * below, gating on `side` and summing `profitAndLoss` into realized P&L. The
 * other two consumers are weaker tests of a change, not stronger: the
 * reconnect-gap replay in `engine-realtime.ts` forwards each fill to
 * `appendBufferedFill` opaquely, and `/api/trades/search` renders. The
 * semantics:
 *   - `side: 0|1` enum (0=Buy, 1=Sell)
 *   - `profitAndLoss` is null for non-closing fills, dollars for closing
 *   - `size` is always positive (engine reads quantity separately)
 *   - timestamps are ISO strings
 *
 * Tradovate has no `canTrade` field; map the `active` flag. Live vs demo
 * is host-level (driven by `isProductionEnv`), not a per-account field —
 * see types.ts for the full note.
 *
 * Tradovate `Position.id` is per-account-per-contract and reused across
 * long → flat → short, so it identifies a slot and not a position.
 * Passed through as-is, which is safe today because nothing in the engine
 * reads it: the open-position gate projects `contractId` only, and the
 * one consumer is the positions table's React list key. Anything that
 * needs to tell one position from the next one on the same contract must
 * not key on it.
 */

import type {
  Account,
  Order,
  OrderSide,
  OrderType,
  OrderStatus,
  Position,
  TradeFill,
} from "@/lib/brokers/types";
import { POSITION_TYPE_FLAT, positionTypeFromSigned } from "@/lib/brokers/types";
import type {
  TradovateAccount,
  TradovateAction,
  TradovateFill,
  TradovateOrder,
  TradovateOrderType,
  TradovatePosition,
} from "./types";
import { isStagingEnv } from "@/lib/env";

// ── Order ────────────────────────────────────────────────────────────

/** Cancellable Tradovate order statuses — mirrors prior-art at
 *  tradovateClient.ts:1071-1078. Engine `searchOpenOrders` calls
 *  `/order/list` and filters with this set client-side. */
export const TRADOVATE_CANCELABLE_STATUSES = new Set<string>([
  "Working",
  "PendingNew",
  "PendingReplace",
  "Suspended",
  "PendingCancel",
  "Unknown",
]);

/** Map Tradovate `ordStatus` string → Topstep numeric `OrderStatus`.
 *  Engine consumers use the numeric enum: 1=Working, 2=Filled, 3=Cancelled,
 *  4=Rejected, 5=Pending. */
function mapOrdStatus(ordStatus: string): OrderStatus {
  switch (ordStatus) {
    case "Working":
      return 1;
    case "Filled":
    case "Completed":
      return 2;
    case "Canceled":
    case "Cancelled":
    case "Expired":
      return 3;
    case "Rejected":
      return 4;
    case "PendingNew":
    case "PendingReplace":
    case "PendingCancel":
    case "Suspended":
    case "Unknown":
    default:
      return 5;
  }
}

function mapTradovateOrderType(orderType: TradovateOrderType | undefined): OrderType {
  switch (orderType) {
    case "Limit": return 1;
    case "Market": return 2;
    case "Stop": return 4;
    case "StopLimit":
      // No clean Topstep analog — bucket as Stop. Engine treats Stop +
      // StopLimit identically for cancel/orphan-sweep purposes.
      return 4;
    default:
      // Absent or unrecognised. `/order/list` carries no orderType — the
      // client joins the order version before translating, so this arm
      // fires only when that join could not supply one. Read it as Stop
      // (the SL side) so the orphan/cancel sweep treats an unknown resting
      // protective order as cover and never mistakes it for a TP: the same
      // fail-safe direction as StopLimit→Stop above, and never `undefined`,
      // which read as "no bracket" on a Tradovate account (bugs.md).
      return 4;
  }
}

function isTradovateAction(v: unknown): v is TradovateAction {
  return v === "Buy" || v === "Sell";
}

function mapAction(action: TradovateAction): OrderSide {
  // Runtime guard: callers receive `action` from /order/list, /fill/list,
  // and other untrusted REST shapes cast at the response boundary. A
  // garbage value (`"BUY"`, `null`, an unexpected enum) would silently
  // emit `side: 1` and the engine would reconcile to the wrong side —
  // PnL attribution would be wrong at the worst possible time. Throw
  // loudly instead so the engine's catch arms surface it as an
  // attribution error rather than misattributing.
  if (!isTradovateAction(action)) {
    throw new Error(
      `Unknown Tradovate action enum: ${JSON.stringify(action)}. Expected "Buy" | "Sell".`,
    );
  }
  return action === "Buy" ? 0 : 1;
}

/** Pick the most useful timestamp Tradovate supplies. Some endpoints
 *  populate `executionProviderTimestamp`, others only `timestamp`. The
 *  engine reads creationTimestamp for ordering, not for ms-precise math. */
function pickTimestamp(t1: string | undefined, t2: string | undefined): string {
  return t1 ?? t2 ?? new Date().toISOString();
}

/** Optional translator hook: map a Tradovate numeric contractId to the
 *  engine-side string contractId (the Tradovate dated symbol, e.g.
 *  `MESU2025`, that the per-broker resolver returned at trade-store
 *  time). When provided and the cache has the mapping, the translator
 *  emits the dated symbol so `findTradeByAccountContract` resolves the
 *  stored trade row. On miss (or no lookup supplied) the translator
 *  falls back to the stringified numeric — preserving prior behavior
 *  for REST callers; the WS dispatch path handles the miss explicitly
 *  by warming + skipping so a future event reconciles. */
export type ContractIdLookup = (numericContractId: number) => string | null;

function resolveContractIdString(
  numericContractId: number,
  lookup: ContractIdLookup | undefined,
): string {
  if (lookup) {
    const hit = lookup(numericContractId);
    if (hit) return hit;
  }
  return String(numericContractId);
}

export function translateOrder(o: TradovateOrder, contractIdLookup?: ContractIdLookup): Order {
  const ts = pickTimestamp(o.timestamp, o.executionProviderTimestamp);
  return {
    id: o.id,
    accountId: o.accountId,
    contractId: resolveContractIdString(o.contractId, contractIdLookup),
    creationTimestamp: ts,
    updateTimestamp: ts,
    status: mapOrdStatus(o.ordStatus),
    type: mapTradovateOrderType(o.orderType),
    side: mapAction(o.action),
    // orderQty lives on the order version, joined by the client before
    // translation; 0 only if that join could not supply it.
    size: typeof o.orderQty === "number" ? o.orderQty : 0,
    limitPrice: typeof o.price === "number" ? o.price : null,
    stopPrice: typeof o.stopPrice === "number" ? o.stopPrice : null,
    filledPrice: typeof o.fillPrice === "number" ? o.fillPrice : null,
    // customTag50 auto-population on outbound bodies was dropped (Tradovate
    // rejects unregistered Tag50). The echo here will be null for engine-
    // placed orders — fill→deployment matching is moving to an orderId-based
    // lookup in a follow-up commit. Read kept as defensive no-op.
    customTag: o.customTag50 ?? null,
  };
}

// ── Position ─────────────────────────────────────────────────────────

export function translatePosition(
  p: TradovatePosition,
  contractIdLookup?: ContractIdLookup,
): Position {
  // Tradovate `netPos` is signed: +N long, -N short, 0 flat.
  // Engine `Position.size` is unsigned, paired with `type` enum.
  // The WS close frame is `netPos: 0`, so flat is reachable here; it is
  // labelled flat, Topstep's own sentinel, never a side (bugs.md A41).
  const type: Position["type"] = positionTypeFromSigned(p.netPos) ?? POSITION_TYPE_FLAT;
  const avg = typeof p.avgPrice === "number"
    ? p.avgPrice
    : typeof p.netPrice === "number"
      ? p.netPrice
      : 0;
  return {
    id: p.id,
    accountId: p.accountId,
    contractId: resolveContractIdString(p.contractId, contractIdLookup),
    creationTimestamp: p.timestamp ?? new Date().toISOString(),
    type,
    size: Math.abs(p.netPos),
    averagePrice: avg,
  };
}

// ── Fill / Trade ─────────────────────────────────────────────────────

export function translateFill(
  f: TradovateFill,
  contractIdLookup?: ContractIdLookup,
  /** Override for the output `accountId` when the wire shape lacks it.
   *  Tradovate's WS `fill` entity has no `accountId` field — it's
   *  implicit from the per-account socket binding. WS callers MUST pass
   *  this. REST `/fill/list` carries `accountId` inline; REST callers
   *  may omit and the function falls back to `f.accountId`. */
  accountIdOverride?: number,
): TradeFill {
  // Tradovate fees come back under either `commission` or `fees` depending
  // on endpoint. Pick whichever is present; default null when neither is
  // populated. WS `fill` entities never carry fees inline — fees arrive
  // as a separate `fillFee` entity in the same SockJS frame and are
  // merged in by the dispatcher's per-frame staging slot before the
  // engine's fillHandler sees the TradeFill. /fill/list (Layer 2) was
  // also observed to omit fees in the Gate B probe; if the REST shape
  // ever begins inlining them, this conditional surfaces them
  // automatically.
  const fees = typeof f.commission === "number"
    ? f.commission
    : typeof f.fees === "number"
      ? f.fees
      : null;
  // PnL: Tradovate `fill` entities never carry `pnl` per the Gate B
  // probe (docs/proposals/tradovate-fill-feed-probe.md). The conditional
  // below preserves a future case where the REST/WS shape begins
  // including it; in steady state it returns null. Layer 1's
  // `reconcileExitFromBuffer` computes Tradovate PnL from price math at
  // write-through (`(closingPrice - entryPrice) × side × pointValue`),
  // matching what `validateClosedTradePrices` already does for Topstep
  // when broker-PnL is delayed.
  const pnl = typeof f.pnl === "number" ? f.pnl : null;
  const accountId =
    accountIdOverride ?? (typeof f.accountId === "number" ? f.accountId : 0);
  return {
    id: f.id,
    accountId,
    contractId: resolveContractIdString(f.contractId, contractIdLookup),
    creationTimestamp: f.timestamp ?? new Date().toISOString(),
    price: f.price,
    profitAndLoss: pnl,
    fees,
    side: mapAction(f.action),
    size: f.qty,
    voided: false,
    orderId: f.orderId,
  };
}

// ── Account ──────────────────────────────────────────────────────────

export function translateAccount(a: TradovateAccount): Account {
  // Tradovate `active` ≈ Topstep `canTrade`. Default true if Tradovate
  // omits the field (defensive — better to surface as tradeable and let
  // the place-order rejection arm catch a non-tradeable account than to
  // silently hide it from the catalog).
  const canTrade = a.active !== false;
  // `isVisible` reads Tradovate's `archived` flag. Absent means visible,
  // for the same reason: an omitted field must not hide the account from
  // the catalog.
  return {
    id: a.id,
    name: a.name,
    // Tradovate doesn't carry balance on /account/list — separate
    // /cashBalance/list endpoint owns it (field on the wire is `amount`,
    // not `cashBalance`). Engine `searchAccounts` callers don't read
    // balance, so 0 is the safe default here. The /api/accounts route
    // stamps the per-account balance from `TradovateClient.getCashBalances()`
    // after the catalog fetch — UI consumers of that endpoint see the
    // real number; engine-side consumers see 0 and don't care.
    balance: 0,
    canTrade,
    isVisible: a.archived !== true,
    broker: "tradovate",
    // Practice = staging-env install per Tradovate's host-level split
    // (no per-account flag exists). Staging targets the demo gateway,
    // prod targets live. Stamped here so the broker-agnostic
    // `isPracticeAccount` predicate works across both brokers.
    practice: isStagingEnv(),
  };
}
