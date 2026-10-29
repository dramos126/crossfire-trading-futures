// The engine's one order gate: every `placeOrder`, `cancelOrder` and
// `modifyOrder` the engine makes goes through `brokerForAccount`, which hands
// back the broker wrapped here (engine-boot.md, *Hard rules*).
//
// A process that has lost the lease can still be mid-way through an exit:
// paused past `LEASE_FRESH_MS`, it resumes with pending I/O callbacks run
// before its overdue renew timer, so a chain that awaited a position read
// sends its market order before the renew notices — a second exit on a
// position the new engine is managing. The check sits on the wire call
// itself, after every await of the chain, so no order call leaves a process
// that does not hold the lease. A draining process still holds it, so the
// drain's exits are untouched.

import type { Broker } from "@/lib/trading/broker-access/broker";

const ORDER_CALLS = new Set<PropertyKey>(["placeOrder", "cancelOrder", "modifyOrder"]);

/** An order call refused because this process no longer holds the engine
 *  lease. Nothing was sent to the broker. */
export class LeaseLostError extends Error {
  constructor(call: string, accountId: number) {
    super(
      `${call} on account ${accountId} refused: this process no longer holds the engine lease, ` +
        "so nothing was sent to the broker — the engine holding it manages this account",
    );
    this.name = "LeaseLostError";
  }
}

/**
 * `broker` with its three order calls asking `mayOrder` first — `holdsLease()`
 * through a `leaseGate`, so the refusal is said once per loss. Every other
 * member is the broker's own, bound to it, so a read is untouched and the
 * client's state stays on the client. The refusal is a rejected promise, as
 * a broker's own failure is, so every caller's catch sees it the same way.
 */
export function leaseGatedBroker(broker: Broker, accountId: number, mayOrder: () => boolean): Broker {
  return new Proxy(broker, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (!ORDER_CALLS.has(prop)) return value.bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        if (!mayOrder()) throw new LeaseLostError(String(prop), accountId);
        return value.apply(target, args);
      };
    },
  });
}
