import { log } from "@/lib/logger";
import type {
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  TradeFill,
} from "@/lib/brokers/types";
import type {
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
} from "./signalr";

/**
 * User-hub wire shape → the neutral broker vocabulary.
 *
 * `OrderSide` / `OrderType` / `PositionType` came from Topstep's gateway,
 * so those are narrowings — the value flows through and only an unknown
 * code warns. **`OrderStatus` is the exception and is a mapping**
 * (`wireOrderStatus`): the neutral codes and ProjectX's agree only on 1–3.
 * An out-of-range code means Topstep added one: we warn (so the drift is
 * visible) and pass it through rather than dropping the event, because a
 * dropped order or position event on a live trade is worse than an
 * unlabelled one.
 *
 * `symbolId` and `fillVolume` are dropped: neither the engine nor the
 * dashboard reads them.
 */

/**
 * ProjectX `OrderStatus` (gateway.docs.projectx.com/docs/realtime) → neutral.
 *
 * | wire | ProjectX  | neutral | neutral meaning |
 * |------|-----------|---------|-----------------|
 * | 0    | None      | —       | unidentified on an order: warns, passes through |
 * | 1    | Open      | 1       | Working   |
 * | 2    | Filled    | 2       | Filled    |
 * | 3    | Cancelled | 3       | Cancelled |
 * | 4    | Expired   | 3       | Cancelled — as Tradovate maps Expired |
 * | 5    | Rejected  | 4       | Rejected  |
 * | 6    | Pending   | 5       | Pending   |
 * | 8    | (absent)  | —       | warns, passes through |
 *
 * Passed through raw, wire 5 read as Pending and counted as stop coverage
 * in the watchdog, and wire 6 was outside the live set, so a still-pending
 * stop read as naked. **`8` must keep warning**: seen twice on a hand
 * position's brackets on 2026-08-26 and in no ProjectX enum. Passed through
 * it is outside every live set; mapping it on a guess would make it
 * coverage or not on no evidence.
 */
const WIRE_ORDER_STATUS: ReadonlyMap<number, OrderStatus> = new Map<number, OrderStatus>([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 3],
  [5, 4],
  [6, 5],
]);

export function wireOrderStatus(wire: number, context: string): OrderStatus {
  const neutral = WIRE_ORDER_STATUS.get(wire);
  if (neutral !== undefined) return neutral;
  warnUnknown("status", wire, context);
  return wire as OrderStatus;
}

const ORDER_TYPES = new Set<number>([1, 2, 4, 5, 6, 7]);
const ORDER_SIDES = new Set<number>([0, 1]);
/**
 * `0` is the **flat sentinel** — the gateway's ordinary third member, sent
 * on every position close beside `size=0`. It was missing here, so each
 * close emitted a drift warning blaming the gateway for adding a code it
 * has always sent, and a real drift warning would have arrived in a stream
 * of false ones.
 *
 * Adding it is inert: `narrow` only decides whether to warn, so `type=0`
 * already flowed through unchanged. It is `POSITION_TYPE_FLAT` on
 * `Position.type`; `PositionType` stays `1 | 2` — see [types.ts](../types.ts),
 * where the absence of a flat side is load-bearing for
 * `positionTypeFromSigned`.
 */
const POSITION_TYPES = new Set<number>([0, 1, 2]);

function warnUnknown(field: string, value: number, context: string): void {
  log.event(
    "broker_code_unknown",
    "topstep",
    `${context}: unknown ${field}=${value} — passing through unmapped (gateway added a code?)`,
  );
}

function narrow<T extends number>(
  value: number,
  known: Set<number>,
  field: string,
  context: string,
): T {
  if (!known.has(value)) warnUnknown(field, value, context);
  return value as T;
}

/** An order's three coded fields, as both order paths — the hub frame and
 *  `/Order/searchOpen` — must read them: status mapped, type and side
 *  narrowed. */
export function orderCodes(
  wire: { status: number; type: number; side: number },
  context: string,
): Pick<Order, "status" | "type" | "side"> {
  return {
    status: wireOrderStatus(wire.status, context),
    type: narrow<OrderType>(wire.type, ORDER_TYPES, "type", context),
    side: narrow<OrderSide>(wire.side, ORDER_SIDES, "side", context),
  };
}

export function toOrder(e: GatewayUserOrder): Order {
  return {
    id: e.id,
    accountId: e.accountId,
    contractId: e.contractId,
    creationTimestamp: e.creationTimestamp,
    updateTimestamp: e.updateTimestamp,
    ...orderCodes(e, `GatewayUserOrder id=${e.id}`),
    size: e.size,
    limitPrice: e.limitPrice,
    stopPrice: e.stopPrice,
    filledPrice: e.filledPrice,
    customTag: e.customTag,
  };
}

export function toPosition(e: GatewayUserPosition): Position {
  return {
    id: e.id,
    accountId: e.accountId,
    contractId: e.contractId,
    creationTimestamp: e.creationTimestamp,
    type: narrow<Position["type"]>(
      e.type,
      POSITION_TYPES,
      "type",
      `GatewayUserPosition id=${e.id}`,
    ),
    size: e.size,
    averagePrice: e.averagePrice,
  };
}

/**
 * `profitAndLoss` is structurally null on an opening fill and non-null on
 * a closing one — that distinction is the only entry/exit discriminator
 * Topstep gives us (see `engine-fill.ts`), so it must survive translation
 * verbatim. `fees` always arrives inline, which is why the Topstep side
 * never produces the `fees: null` that Tradovate's split fee entity can.
 */
export function toTradeFill(e: GatewayUserTrade): TradeFill {
  return {
    id: e.id,
    accountId: e.accountId,
    contractId: e.contractId,
    creationTimestamp: e.creationTimestamp,
    price: e.price,
    profitAndLoss: e.profitAndLoss,
    fees: e.fees,
    side: narrow<OrderSide>(
      e.side,
      ORDER_SIDES,
      "side",
      `GatewayUserTrade id=${e.id}`,
    ),
    size: e.size,
    voided: e.voided,
    orderId: e.orderId,
  };
}
