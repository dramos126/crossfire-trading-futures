/**
 * The predicate that decides whether a cancel rejection is proof the leg is
 * already terminal — the one branch on the engine's post-flatten cancel whose
 * input is a broker *reason string* rather than a status code, and the one the
 * author flagged as inferred rather than read off a fixture.
 *
 * Both directions cost real money and they cost it differently. A rejection
 * misread as terminal stamps `terminal_at` on a row and swallows the only line
 * that says a stop may still be resting on the closing side — an armed reverse
 * nobody is told about. A terminal rejection misread as genuine re-cancels the
 * same dead order every flatten, forever, at `error`.
 *
 * **Provenance is asymmetric, and the asymmetry is the point.** The terminal
 * fragments are inferred; the *genuine* reasons are documented — `RiskExceeded`,
 * `MarketClosed`, `AccountNotActive`, `ExceedsLimit`, `InvalidPrice` are the
 * observed set in [tradovate.md](../../../../docs/modules/brokers/tradovate.md)
 * §"`TradovateOrderRejectionError` splits inside `classifyError`". So the loud
 * arm is what can be anchored to strings the broker actually issues, and it is
 * also the arm whose failure is silent.
 *
 * Since A46 the predicate reads `TradovateOrderRejectionError`'s **structured**
 * `failureReason` / `failureText`, never an assembled `Error.message`, so every
 * terminal fixture below is built through the real constructor and every
 * fixture that is *not* that class is refused by construction.
 *
 * It sits beside the envelope it reads rather than beside its caller: the
 * engine reaches it through `BrokerPlugin.rejectionProvesTerminal`, so a
 * watchdog-side test would be testing the seam's stub. The call site's own
 * arms are pinned in `trading/engine-watchdog.test.ts`.
 */

import { describe, it, expect } from "vitest";

import {
  TradovateAccountNotActiveError,
  TradovateCircuitOpenError,
  TradovateOrderRejectionError,
  TradovateUnauthorizedError,
  isAlreadyTerminalCancelRejection,
} from "./errors";

const ACCT = 4242;

describe("isAlreadyTerminalCancelRejection", () => {
  /** As `cancelOrder` raises it: HTTP 200 carrying a `failureReason`
   *  envelope, promoted at [client.ts:960](./client.ts). */
  function cancelRejection(failureReason: string, failureText: string | null = null): Error {
    return new TradovateOrderRejectionError("/order/cancelOrder", ACCT, failureReason, failureText);
  }

  describe("proof the order is already terminal", () => {
    it("reads a Tradovate cancel rejection naming a missing order as terminal", () => {
      expect(isAlreadyTerminalCancelRejection(cancelRejection("OrderNotFound"))).toBe(true);
    });

    it.each([
      "NoSuchOrder",
      "UnknownOrder",
      "AlreadyCancelled",
      "AlreadyFilled",
      "NotCancelable",
      "NotCancellable",
    ])("reads %s as terminal", (reason) => {
      expect(isAlreadyTerminalCancelRejection(cancelRejection(reason))).toBe(true);
    });

    // Brokers do not agree on separator or case for the same condition, which
    // is the whole reason this normalises before matching.
    it.each(["ORDER_NOT_FOUND", "order-not-found", "Order Not Found", "order.not.found"])(
      "is insensitive to the case and punctuation in %s",
      (reason) => {
        expect(isAlreadyTerminalCancelRejection(cancelRejection(reason))).toBe(true);
      },
    );

    it("still answers terminal when the reason arrives in failureText rather than the reason", () => {
      expect(
        isAlreadyTerminalCancelRejection(cancelRejection("Rejected", "The order was already filled")),
      ).toBe(true);
    });

    // Word order is what keeps the account carve-out from swallowing this: an
    // account named *after* the missing order is a terminal rejection that
    // happens to say which account it came from.
    it("reads a terminal reason that names the account after the order", () => {
      expect(
        isAlreadyTerminalCancelRejection(cancelRejection("OrderNotFound", "for account 4242")),
      ).toBe(true);
    });
  });

  describe("a genuine failure stays loud", () => {
    // The observed reason set, per tradovate.md §"`TradovateOrderRejectionError`
    // splits inside `classifyError`". None of these says anything about whether
    // the leg is still resting.
    it.each(["RiskExceeded", "MarketClosed", "AccountNotActive", "ExceedsLimit", "InvalidPrice"])(
      "does not read %s as proof the order is gone",
      (reason) => {
        expect(isAlreadyTerminalCancelRejection(cancelRejection(reason))).toBe(false);
      },
    );

    it("does not read an auth failure as proof the order is gone", () => {
      expect(isAlreadyTerminalCancelRejection(new TradovateUnauthorizedError("/order/cancelOrder"))).toBe(
        false,
      );
    });

    it("does not read an open circuit as proof the order is gone", () => {
      expect(
        isAlreadyTerminalCancelRejection(
          new TradovateCircuitOpenError("/order/cancelOrder", ACCT, Date.now(), 30_000),
        ),
      ).toBe(false);
    });

    it("does not read an inactive account as proof the order is gone", () => {
      expect(isAlreadyTerminalCancelRejection(new TradovateAccountNotActiveError(ACCT))).toBe(false);
    });

    // The HTTP wrapper `request()` raises on a non-2xx with an empty body
    // (client.ts:1134) — the shape a gateway timeout arrives in.
    it("does not read a gateway timeout as proof the order is gone", () => {
      expect(
        isAlreadyTerminalCancelRejection(
          new Error("Tradovate API error 504 on /order/cancelOrder: (empty body)"),
        ),
      ).toBe(false);
    });

    // `resolveAccountSpec`'s throw, verbatim from client.ts:1035. It carries
    // "not found" and is *not* about the order at all — the credential is
    // wrong or the account was revoked, and the SL is very much still resting.
    it("refuses the account-scoped lookup failure that carries the same words", () => {
      expect(
        isAlreadyTerminalCancelRejection(
          new Error(
            `Tradovate: account ${ACCT} not found in /account/list — credential mismatch or recently revoked`,
          ),
        ),
      ).toBe(false);
    });

    // `AccountNotFoundError`'s message, verbatim from topstep/client.ts:48.
    // Quoted rather than imported: the Topstep client drags its whole graph in.
    it("refuses Topstep's AccountNotFound the same way", () => {
      expect(
        isAlreadyTerminalCancelRejection(new Error(`Topstep returned AccountNotFound for account ${ACCT}`)),
      ).toBe(false);
    });

    // Fail-closed precedence *inside* the envelope. Both fields are structured,
    // and a rejection naming both conditions is ambiguous — on this path
    // ambiguity has to resolve to "it may still be resting".
    it("keeps the account carve-out ahead of a terminal reason in the same envelope", () => {
      expect(
        isAlreadyTerminalCancelRejection(cancelRejection("OrderNotFound", "account not found in session")),
      ).toBe(false);
    });

    /**
     * The carve-out is a pattern, not a substring, and this is why. Normalising
     * to `[a-z]` keeps word order but drops nothing else, so a word *between*
     * the two halves used to break the carve-out while leaving `notfound`
     * intact for the terminal match — a resting leg stamped terminal and the
     * `error` downgraded to `warn`, which is the exact outcome the carve-out
     * exists to prevent. Digits were never the gap; they are already stripped.
     */
    it.each([
      "The account was not found",
      "Account not found in session",
      "Account #4242 not found",
      "account for this order was not found",
    ])("refuses %s however the phrase is spaced out", (failureText) => {
      expect(isAlreadyTerminalCancelRejection(cancelRejection("Rejected", failureText))).toBe(false);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an empty string", ""],
      ["a bare object", {}],
      ["a number", 500],
    ])("refuses %s — an unreadable rejection is not proof of anything", (_label, value) => {
      expect(isAlreadyTerminalCancelRejection(value)).toBe(false);
    });

    // The right class, an empty envelope. A predicate that answered on the
    // absence of a genuine reason rather than the presence of a terminal one
    // would land here, and it is the shape a translator bug produces.
    it("refuses a rejection whose envelope says nothing", () => {
      expect(isAlreadyTerminalCancelRejection(cancelRejection("", null))).toBe(false);
      expect(isAlreadyTerminalCancelRejection(cancelRejection("", ""))).toBe(false);
    });
  });

  /**
   * A46's fix, stated as the rule it is: **only the structured rejection
   * envelope can prove a leg is terminal.** An `Error.message` is assembled
   * from whatever the wire said — a transport wrapper interpolates the raw
   * HTTP body, and `Not Found` is the commonest reason phrase there is — so
   * matching it cannot distinguish "the broker says this order is gone" from
   * "this route is gone". A field the broker sets in a 200 body can.
   *
   * The consequence is that anything not carrying the envelope takes the loud
   * arm, which is the fail-safe direction: a false `error` costs the operator
   * a look, a false `warn` plus a permanent `terminal_at` costs a hidden armed
   * reverse. Nothing is lost by it — the call-site gate admits only a broker
   * that declares `stopCoverageSource: "order-map"`, which is Tradovate alone,
   * so the cancel that consults this predicate is a Tradovate cancel.
   */
  describe("only the structured rejection envelope is proof", () => {
    it.each([
      ["Tradovate", "Tradovate API error 404 on /order/cancelOrder: Not Found"],
      ["Topstep", "Topstep API error 404 on /api/Order/cancel: Not Found | payload=[redacted]"],
    ])("refuses %s's transport 404 even though it says Not Found", (_broker, message) => {
      expect(isAlreadyTerminalCancelRejection(new Error(message))).toBe(false);
    });

    // Topstep's `cancelOrder` rethrows the broker's raw `errorMessage`
    // verbatim (topstep/client.ts:254) — an untyped `Error` indistinguishable
    // from the transport wrapper above, which is exactly why it is refused.
    it("refuses an untyped rejection carrying the words, whatever produced it", () => {
      expect(isAlreadyTerminalCancelRejection(new Error("order not found"))).toBe(false);
    });

    it("refuses a bare string carrying the words", () => {
      expect(isAlreadyTerminalCancelRejection("OrderNotFound")).toBe(false);
    });
  });
});
