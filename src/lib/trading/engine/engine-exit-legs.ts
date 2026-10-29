// What counts as a live protective leg on the book. A leaf, so the watchdog
// can share the exit path's predicate without importing the exit cluster
// (which loads the strategy registry).

import type { Order, OrderSide, OrderStatus, OrderType, Position } from "@/lib/brokers/types";
import { POSITION_TYPE_LONG } from "@/lib/brokers/types";

/** Working and Pending. Pending means a different thing per broker:
 *  Tradovate maps PendingNew/PendingReplace/Suspended/PendingCancel/Unknown
 *  to it, so a stop caught mid-replace (a ratchet in flight) still rests on
 *  the book; Topstep maps its wire Pending (6), an order the gateway has
 *  accepted and not yet made Open (A89). The watchdog's coverage sum bounds
 *  how long a Pending stop counts as cover; the cancel side does not. */
export const LIVE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([1, 5]);

// TrailingStop (5) is excluded: the engine's legs are a Limit TP and a Stop
// SL, and its trail moves that Stop rather than placing a type 5.
const BRACKET_LEG_TYPES: ReadonlySet<OrderType> = new Set<OrderType>([1, 4]);

/** A live TP/SL-shaped order resting on the side that closes the position. */
export function isLiveProtectiveLeg(o: Order, exId: string, protectiveSide: OrderSide): boolean {
  return o.contractId === exId
    && LIVE_ORDER_STATUSES.has(o.status)
    && o.side === protectiveSide
    && BRACKET_LEG_TYPES.has(o.type);
}

/** The side that closes a broker position: a long sells, a short buys. */
export function closingSideOfPosition(p: Pick<Position, "type">): OrderSide {
  return p.type === POSITION_TYPE_LONG ? 1 : 0;
}
