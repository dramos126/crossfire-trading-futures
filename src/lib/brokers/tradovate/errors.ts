/**
 * Typed error classes for the Tradovate broker client. The engine catches
 * these on Tradovate-routed paths the same way it catches the
 * Topstep-shaped equivalents on Topstep paths — see the integration plan
 * §3 "Error class hierarchy" for the full table.
 *
 * Errors are intentionally broker-distinct (separate classes from the
 * Topstep ones) per the proposal §"Keep error types broker-distinct."
 * Same engine reaction, different redaction/logging concerns.
 *
 * Phase 1 ships all four classes even though only `TradovateUnauthorizedError`
 * is reachable from the auth flow today — the rest are referenced by the
 * penalty handler (`TradovateCircuitOpenError`, `TradovateCaptchaLockoutError`)
 * and Phase 3's order-placement path (`TradovateAccountNotActiveError`).
 *
 * `isAlreadyTerminalCancelRejection` is the one non-class export and it is
 * here on purpose: it reads two fields off a rejection envelope, and this
 * module is a leaf with no imports of its own, so the plugin can expose it
 * across the `BrokerPlugin` seam without dragging the client's graph along.
 */

export class TradovateUnauthorizedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Tradovate unauthorized on ${path} — token may be expired`);
    this.name = "TradovateUnauthorizedError";
    this.path = path;
  }
}

export class TradovateAccountNotActiveError extends Error {
  readonly accountId: number | null;
  constructor(accountId: number | null) {
    super(
      accountId === null
        ? `Tradovate returned AccountNotActive`
        : `Tradovate returned AccountNotActive for account ${accountId}`,
    );
    this.name = "TradovateAccountNotActiveError";
    this.accountId = accountId;
  }
}

export class TradovateCircuitOpenError extends Error {
  readonly path: string;
  readonly accountId: number | null;
  readonly openedAt: number;
  readonly durationMs: number;
  constructor(
    path: string,
    accountId: number | null,
    openedAt: number,
    durationMs: number,
  ) {
    const remainMs = Math.max(0, openedAt + durationMs - Date.now());
    super(
      `Tradovate circuit open for ${path}` +
        (accountId === null ? "" : ` (account ${accountId})`) +
        ` — ${remainMs}ms remaining`,
    );
    this.name = "TradovateCircuitOpenError";
    this.path = path;
    this.accountId = accountId;
    this.openedAt = openedAt;
    this.durationMs = durationMs;
  }
}

/**
 * Generic order-rejection error from `/order/placeOrder`, `/order/placeOSO`,
 * `/order/cancelOrder`, or `/order/modifyOrder`. Tradovate returns
 * rejections as `{failureReason: "...", failureText?: "..."}` instead of
 * an HTTP error — the response is HTTP 200 with a body that lacks
 * `orderId`. Per the integration plan §H, we deliberately do NOT invent
 * a separate class per failure reason; engine catch arms can pattern-match
 * on `failureReason` directly.
 *
 * Common observed reasons: `RiskExceeded`, `MarketClosed`,
 * `AccountNotActive` (also surfaced by the typed `TradovateAccountNotActiveError`
 * when detected on `searchAccounts`), `ExceedsLimit`, `InvalidPrice`.
 */
export class TradovateOrderRejectionError extends Error {
  readonly failureReason: string;
  readonly failureText: string | null;
  readonly path: string;
  readonly accountId: number | null;
  constructor(
    path: string,
    accountId: number | null,
    failureReason: string,
    failureText: string | null,
  ) {
    super(
      `Tradovate ${path} rejected: ${failureReason}` +
        (failureText ? ` — ${failureText}` : "") +
        (accountId === null ? "" : ` (account ${accountId})`),
    );
    this.name = "TradovateOrderRejectionError";
    this.path = path;
    this.accountId = accountId;
    this.failureReason = failureReason;
    this.failureText = failureText;
  }
}

/**
 * Reason fragments that prove a cancel target is already terminal at the
 * broker, matched against the structured rejection fields with punctuation
 * and spacing stripped so `OrderNotFound`, `ORDER_NOT_FOUND` and
 * `order not found` all land here. Pattern-matching the reason string is the
 * documented shape for this broker — see brokers/tradovate.md, "do not invent
 * a class per reason".
 *
 * The list is deliberately short and the default is the loud arm: an
 * unrecognised rejection may well be a leg still resting on the closing side,
 * which is the armed-reverse state the engine's post-flatten cancel exists to
 * clear.
 */
const TERMINAL_CANCEL_FRAGMENTS: readonly string[] = [
  "notfound",
  "nosuchorder",
  "unknownorder",
  "alreadycancel",
  "alreadyfill",
  "notcancelable",
  "notcancellable",
];

function normalizeRejectionField(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * The account-scoped carve-out, which wins over every terminal fragment.
 *
 * Matched as a pattern rather than the literal `accountnotfound` because
 * normalising to `[a-z]` leaves word order intact and drops nothing else: any
 * word between the two halves — `"The account was not found"` →
 * `theaccountwasnotfound` — slipped past a substring check while leaving
 * `notfound` intact for the terminal match, which is precisely the outcome the
 * carve-out exists to prevent. Digits are already stripped, so
 * `"Account #4242 not found"` was never the gap.
 *
 * Deliberately unbounded between the halves: a field naming an account *and*
 * a missing order in one breath is ambiguous, and ambiguity on this path
 * resolves to "it may still be resting". The order matters and is the one
 * thing keeping it narrow — `"Order not found for account 4242"` puts
 * `account` after `notfound` and is correctly read as terminal.
 */
const ACCOUNT_SCOPED_REJECTION = /account[a-z]*notfound/;

/**
 * Is this cancel rejection proof the order is already terminal?
 *
 * **Only the structured rejection envelope can prove it.** Matching an
 * assembled `Error.message` cannot: both clients wrap a non-2xx by
 * interpolating the raw HTTP body (`Tradovate API error 404 on
 * /order/cancelOrder: Not Found`), and `Not Found` is the commonest reason
 * phrase on the wire — so a bad base URL, a proxy or a revoked route read as
 * "the order is gone", stamped `terminal_at` (which `findActiveOrderMappings-
 * ByAccount` filters for good, and nothing else heals a `tp` row) and traded
 * the `error` line about a leg resting on the closing side for a `warn`
 * saying the opposite. `failureReason` is set by the broker in a 200 body and
 * cannot collide with an HTTP reason phrase. Never reintroduce a message
 * fallback here.
 *
 * Everything else therefore takes the loud arm, which is the fail-safe
 * direction and costs nothing: a false `error` costs a look where a false
 * `warn` costs a hidden armed reverse.
 *
 * **It lives here rather than beside its caller** because it reads two fields
 * of a Tradovate wire envelope, and the engine may not value-import a broker
 * error class to ask the question — the engine asks the plugin what a broker
 * *does* (`BrokerPlugin.rejectionProvesTerminal`, which delegates straight to
 * this). Exported so the shipped predicate is what a test exercises, rather
 * than the seam's stub.
 *
 * An account-scoped failure is excluded by name, in either field: it wears the
 * same words, and reading it as "the order is gone" would stamp a resting leg
 * terminal and silence the one line that says to cancel it by hand. See
 * `ACCOUNT_SCOPED_REJECTION` for why that is a pattern and not a substring.
 */
export function isAlreadyTerminalCancelRejection(err: unknown): boolean {
  if (!(err instanceof TradovateOrderRejectionError)) return false;
  // Matched per field rather than on the concatenation, so a fragment cannot
  // be assembled across the seam between the two. The seam cuts both ways and
  // that is accepted, not overlooked: carve-out words straddling the fields
  // (`"Account"` / `"not found"`) lose the carve-out and take the terminal
  // match. No envelope on the wire splits the phrase, and closing it would
  // mean matching the concatenation — the assembly hole this split exists to
  // close.
  const fields = [normalizeRejectionField(err.failureReason), normalizeRejectionField(err.failureText ?? "")];
  if (fields.some((field) => ACCOUNT_SCOPED_REJECTION.test(field))) return false;
  return fields.some((field) => TERMINAL_CANCEL_FRAGMENTS.some((fragment) => field.includes(fragment)));
}

/**
 * Auth-path `p-time` penalty. Tradovate returns HTTP 200 with a
 * `{p-time: N}` envelope when an auth attempt is being throttled —
 * critically, the same response shape is used for bad credentials
 * AND for too-frequent retries on valid credentials. Operators
 * inspecting a single failure cannot tell which it is from the
 * response alone.
 */
export class TradovateAuthPenaltyError extends Error {
  readonly pTimeSec: number | null;
  constructor(pTimeSec: number | null, cause?: unknown) {
    super(`Tradovate rate-limited this auth attempt (p-time=${pTimeSec ?? "?"}s).`);
    this.name = "TradovateAuthPenaltyError";
    this.pTimeSec = pTimeSec;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * A `Broker` member Tradovate deliberately refuses rather than
 * approximates — `searchContracts` is the only one today.
 *
 * Typed rather than a plain `Error` so `TradovateBrokerPlugin.ownsError`
 * claims it. An unattributed throw off a broker path is exactly the
 * shape that made `order_rejected` necessary: nothing owns it, so
 * `classifyError` answers out of its `auth` catch-all and Tradovate's
 * `auth` orphan-pauses the account.
 *
 * Classified `entitlement` — the credentials are fine, this venue cannot
 * answer this question. Tradovate is an execution venue whose
 * market-data entitlement will never be bought, which is the whole
 * reason `Contract.id` has no honest Tradovate value.
 */
export class TradovateUnsupportedOperationError extends Error {
  readonly operation: string;
  constructor(operation: string, detail: string) {
    super(`Tradovate does not support ${operation} — ${detail}`);
    this.name = "TradovateUnsupportedOperationError";
    this.operation = operation;
  }
}

export class TradovateCaptchaLockoutError extends Error {
  readonly path: string;
  readonly accountId: number | null;
  constructor(path: string, accountId: number | null) {
    super(
      `Tradovate p-captcha lockout on ${path}` +
        (accountId === null ? "" : ` (account ${accountId})`) +
        ` — third-party access disabled for ~1h`,
    );
    this.name = "TradovateCaptchaLockoutError";
    this.path = path;
    this.accountId = accountId;
  }
}
