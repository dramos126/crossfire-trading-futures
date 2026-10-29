import type {
  AuthCredentials,
  AuthResponse,
  AccountSearchResponse,
  OrderSearchResponse,
  PositionSearchResponse,
  TradeSearchResponse,
  ContractSearchResponse,
  ContractByIdResponse,
  RetrieveBarsResponse,
  BarDataApi,
} from "./types";
import { isContract } from "./types";
import type {
  Account,
  Order,
  Position,
  TradeFill,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Contract,
  RetrieveBarsRequest,
} from "@/lib/brokers/types";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { log } from "@/lib/logger";
import { PRACTICE_PREFIX } from "./account-classification";
import { noteTopstepRequest, noteTopstepResponse } from "./request-counter";
import { orderCodes } from "./event-translation";

const BASE_URL = process.env.NEXT_PUBLIC_TOPSTEP_API_URL ?? "https://api.topstepx.com";

/** Raised for any 401 from the gateway so callers can distinguish "token
 * expired, retry after revalidate" from ordinary request failures. */
export class UnauthorizedError extends Error {
  constructor(path: string) {
    super(`Unauthorized on ${path} — token may be expired`);
    this.name = "UnauthorizedError";
  }
}

/**
 * Any other non-2xx answer. `status` is read structurally by the engine
 * (a 429 defers the re-snapshot queue without spending an attempt), so it
 * is a field, not only text. The message format is unchanged because
 * `isTransientGatewayError` and `auth.ts`'s mint-failure line match it.
 * Deliberately not in `ownsError`: a 429 or a 5xx is not the broker's
 * answer about the account.
 */
export class TopstepHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TopstepHttpError";
    this.status = status;
  }
}

/**
 * Thrown by placeOrder when Topstep returns errorCode AccountNotFound (1).
 * Caller (engine) catches this to auto-pause every deployment on the
 * accountId. The errorCode enum is ProjectX's `PlaceOrderErrorCode`
 * (gateway.docs.projectx.com, Order/place).
 */
export class AccountNotFoundError extends Error {
  readonly accountId: number;
  constructor(accountId: number) {
    super(`Topstep returned AccountNotFound for account ${accountId}`);
    this.name = "AccountNotFoundError";
    this.accountId = accountId;
  }
}

/**
 * The `PlaceOrderErrorCode` values that are the gateway refusing the order,
 * by name. AccountNotFound (1) has its own class. Left out on purpose:
 * OrderPending (6) — the order may yet exist — UnknownError (7), and any
 * undocumented code; those stay a plain `Error`, unowned, so nothing reads
 * them as the broker's answer about the account (bugs.md A120).
 */
const PLACE_REFUSAL_CODES: ReadonlyMap<number, string> = new Map([
  [2, "OrderRejected"],
  [3, "InsufficientFunds"],
  [4, "AccountViolation"],
  [5, "OutsideTradingHours"],
  [8, "ContractNotFound"],
  [9, "ContractNotActive"],
  [10, "AccountRejected"],
]);

/**
 * Thrown by placeOrder for a documented refusal code — a risk-rule lock
 * (daily loss, violation), funds, hours or contract. The plugin classifies
 * it `order_rejected`: the broker answered, the account is not dead.
 *
 * The code and its name trail the message because the engine prints
 * `err.message` and may not read a broker class's fields — this is how a
 * log line shows which code a Daily Loss Limit refusal arrives on.
 */
export class TopstepOrderRejectionError extends Error {
  readonly accountId: number;
  readonly errorCode: number;
  readonly codeName: string;
  constructor(accountId: number, errorCode: number, errorMessage: string | null) {
    const codeName = PLACE_REFUSAL_CODES.get(errorCode) ?? `code ${errorCode}`;
    super(`${errorMessage ?? "Failed to place order"} (errorCode ${errorCode} ${codeName})`);
    this.name = "TopstepOrderRejectionError";
    this.accountId = accountId;
    this.errorCode = errorCode;
    this.codeName = codeName;
  }
}

/** Referenced by both the place methods and the 401-retry exemption; a
 * future path-string drift would silently re-enable retry on order-place,
 * which can duplicate-submit. */
const PLACE_ORDER_PATH = "/api/Order/place";

/** The two calls that *are* the recovery. A 401 on either is the answer,
 *  never a reason to refresh or mint — that would recurse. */
const AUTH_PATHS: ReadonlySet<string> = new Set(["/api/Auth/validate", "/api/Auth/loginKey"]);

/**
 * What a client does about a bearer the gateway refuses and
 * `/Auth/validate` will not revive, while the shared cache still holds it.
 *
 * Registered by `auth.ts` at import time rather than imported here:
 * `auth.ts` constructs this class, so a static import the other way is a
 * cycle, and the cache and everything that bounds a mint are its business.
 * Every token a client is handed comes out of `auth.ts`, so the hook is
 * always installed by the time one can go dead.
 */
export interface DeadTokenRecovery {
  /** Drop the dead token and cold-mint. Resolves the replacement, or null
   *  when this failure episode has already had its one mint. */
  remint(deadToken: string, path: string): Promise<string | null>;
  /** Drop the dead token and stop — for the one path that may not retry. */
  discard(deadToken: string, path: string): void;
}

/**
 * Everything about the Topstep session that must be one-per-process, on
 * `globalThis` for the reason `engine-singleton.ts` gives for the engine:
 * the instrumentation hook and the route handlers can load this directory
 * in separate module graphs. Module-level `let`s would then be one in-flight
 * mint and one cooldown *per graph* over the single `auth_token` row — two
 * `loginKey`s for one dead token, which is what they exist to prevent.
 *
 * Declared here only because `auth.ts` cannot be imported from this file.
 * `auth.ts` owns every field but `recovery`, which it writes and this file
 * reads; nothing else has a reason to touch any of them.
 */
export interface TopstepSessionState {
  recovery: DeadTokenRecovery | null;
  inFlightTokenMint: Promise<string> | null;
  lastDeadTokenDropAtMs: number | null;
  mintAttemptedSinceDrop: boolean;
  lastFailedMint: { atMs: number; credentials: string; error: unknown } | null;
  /** When this process last sent `loginKey` — stamped in `authenticate`. */
  lastLoginAtMs: number | null;
  /** A standby engine process: it reads the shared token and never mints,
   *  validates or drops it (`holdTokenRefresh` in `auth.ts`). */
  refreshHeld: boolean;
}

/**
 * How long after our own `loginKey` a `gatewaylogout` on our hubs is read as
 * the echo of that login rather than another device's. Every login sends the
 * advisory to the user's other sessions — ours included — and a recovery mint
 * read as a kick parks the market hub with auto-retry off (bugs.md A90).
 * Generous on purpose: an echo read as a kick parks the tape for hours, while
 * a real kick read as our echo costs a 60s retry loop that re-displaces the
 * other device.
 */
export const OWN_LOGIN_ADVISORY_WINDOW_MS = 10_000;

/** Whether a `gatewaylogout` received at `advisoryAtMs` on a hub built at
 *  `hubBuiltAtMs` followed our own login closely enough to be its echo.
 *  Stamped at send, not at response, because the advisory can reach the hub
 *  before the login's response does. Only a login *after* the hub was built
 *  counts: the one its own connect made displaced another device, so an
 *  advisory after it is that device logging back in — a kick, which must
 *  park the hub or the two ping-pong every 60 s. */
export function advisoryFollowsOwnLogin(advisoryAtMs: number, hubBuiltAtMs: number): boolean {
  const loginAt = topstepSessionState().lastLoginAtMs;
  if (loginAt === null || loginAt <= hubBuiltAtMs) return false;
  const since = advisoryAtMs - loginAt;
  return since >= 0 && since <= OWN_LOGIN_ADVISORY_WINDOW_MS;
}

export const TOPSTEP_SESSION_STATE_KEY = "__topstepSessionState__" as const;
type GlobalWithSession = typeof globalThis & { [TOPSTEP_SESSION_STATE_KEY]?: TopstepSessionState };

export function topstepSessionState(): TopstepSessionState {
  const g = globalThis as GlobalWithSession;
  if (!g[TOPSTEP_SESSION_STATE_KEY]) {
    g[TOPSTEP_SESSION_STATE_KEY] = {
      recovery: null,
      inFlightTokenMint: null,
      lastDeadTokenDropAtMs: null,
      mintAttemptedSinceDrop: false,
      lastFailedMint: null,
      lastLoginAtMs: null,
      refreshHeld: false,
    };
  }
  return g[TOPSTEP_SESSION_STATE_KEY];
}

/** Build a logging-safe payload preview. Topstep API errors flow into
 *  engine logs, the SSE stream, and Discord alerts — full payloads leak
 *  customTag, prices, and raw account ids. Keep just enough to debug
 *  routing/sizing without exposing the rest. */
function redactPayload(path: string, body: unknown): string {
  if (typeof body !== "object" || body === null) return String(body);
  const b = body as Record<string, unknown>;
  if (path === PLACE_ORDER_PATH) {
    return JSON.stringify({
      accountId: b.accountId,
      contractId: b.contractId,
      side: b.side,
      size: b.size,
      type: b.type,
    });
  }
  if (path === "/api/Order/modify") {
    return JSON.stringify({
      accountId: b.accountId,
      orderId: b.orderId,
    });
  }
  // For other endpoints, scrub anything that smells like a price or tag.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (/(price|tag|token|key|password)/i.test(k)) continue;
    safe[k] = v;
  }
  return JSON.stringify(safe);
}

/** Match transient gateway failures that should be retried: 5xx bad-gateway
 *  family, fetch network errors, and AbortError from request timeouts. The
 *  502 message format is set by `post()` below ("Topstep API error 502 on
 *  ..."), so a string match is sufficient. */
function isTransientGatewayError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (/Topstep API error 50[234] /.test(err.message)) return true;
    // Node fetch surfaces network failures as TypeError "fetch failed" with
    // a `cause` chain; treat any of those as retry-worthy too.
    if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return true;
  }
  return false;
}

/** Per-account 1s TTL cache for `searchOpenOrders`. The engine often calls
 *  this 3+ times per trade lifecycle (entry pre-snapshot, exit cancel,
 *  reconciler) within the same tick window — without dedup, a single 5m
 *  bar close on two deployments hits Topstep 6 times in <100ms for a value
 *  that doesn't move that fast. 1s is short enough that breakeven / exit
 *  paths still see fresh data. */
const OPEN_ORDERS_TTL_MS = 1_000;

export class TopstepClient implements Broker {
  private token: string | null = null;
  private openOrdersCache = new Map<number, { orders: Order[]; expiresAt: number }>();
  private openOrdersInFlight = new Map<number, Promise<Order[]>>();

  constructor(private baseUrl: string = BASE_URL) {}

  // ── Auth ──────────────────────────────────────────────────────────

  async authenticate(credentials: AuthCredentials): Promise<string> {
    log.debug("auth", "loginKey() cold mint");
    topstepSessionState().lastLoginAtMs = Date.now();
    const res = await this.post<AuthResponse>("/api/Auth/loginKey", credentials);
    if (!res.success) {
      throw new Error(res.errorMessage ?? "Authentication failed");
    }
    this.token = res.token;
    return res.token;
  }

  async validateSession(): Promise<string | null> {
    log.debug("auth", "validateSession()");
    const res = await this.post<{ success: boolean; newToken?: string }>("/api/Auth/validate", {});
    if (res.success && res.newToken) {
      const oldToken = this.token;
      const tokenChanged = oldToken !== res.newToken;
      if (tokenChanged) {
        // CRITICAL: token rotation invalidates the SignalR session bound
        // to the old token. The hub is now a zombie — WS stays connected
        // but Topstep's gateway no longer streams to it. Watchdog will
        // catch this 120s later via trade silence.
        log.debug(
          "auth",
          `!! TOKEN ROTATED via /Auth/validate — old hub may be zombied. Caller should rebuild SignalR hubs.`,
        );
      } else {
        log.debug("auth", `validateSession() success, newToken === oldToken (no rotation)`);
      }
      this.token = res.newToken;
      return res.newToken;
    }
    log.debug("auth", `validateSession() returned no newToken (success=${res.success})`);
    return null;
  }

  setToken(token: string) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  // ── Accounts ──────────────────────────────────────────────────────

  async searchAccounts(onlyActive = true): Promise<Account[]> {
    const res = await this.post<AccountSearchResponse>("/api/Account/search", {
      onlyActiveAccounts: onlyActive,
    });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to fetch accounts");
    // Tag every Topstep-sourced account with its broker + practice flag.
    // The ProjectX API carries neither field on the wire; both are set at
    // the boundary where we know the source. Topstep's practice signal is
    // the `PRAC-` name prefix per Topstep convention (no live/practice
    // discriminator field exists on the response). This line is the whole
    // production derivation of `practice` for Topstep — `isPracticeAccount`
    // and `classifyAccount` only read what it stamps.
    return res.accounts.map((a) => ({
      ...a,
      broker: "topstep" as const,
      // Trimmed to match `classifyAccount`, which trims before testing the
      // eval prefixes. Without it the two halves of one classification
      // normalise differently: " PRAC-V2-1" would stamp practice:false and
      // land on LIVE while " 50KTC-1" lands on COMBINE. Fail-closed either
      // way, but a predicate whose halves disagree about whitespace is the
      // kind of seam that grows a real bug later.
      practice: a.name.trim().startsWith(PRACTICE_PREFIX),
    }));
  }

  // ── Orders ────────────────────────────────────────────────────────

  /**
   * A caller that finds a read for the account already in flight shares it,
   * `forceFresh` included: that request left after the caller's last look,
   * so it is as fresh as a new one would be (bugs.md A21). One that arrives
   * after it settled sends its own. `invalidateOpenOrders` drops the shared
   * read as well as the cache, so a read that left before one of our own
   * mutations is never handed to a caller after it, nor cached.
   */
  searchOpenOrders(accountId: number, opts: { forceFresh?: boolean } = {}): Promise<Order[]> {
    if (!opts.forceFresh) {
      const cached = this.openOrdersCache.get(accountId);
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.orders);
    }
    const shared = this.openOrdersInFlight.get(accountId);
    if (shared) return shared;
    const read = this.fetchOpenOrders(accountId).then((orders) => {
      if (this.openOrdersInFlight.get(accountId) === read) {
        this.openOrdersCache.set(accountId, { orders, expiresAt: Date.now() + OPEN_ORDERS_TTL_MS });
      }
      return orders;
    }).finally(() => {
      if (this.openOrdersInFlight.get(accountId) === read) this.openOrdersInFlight.delete(accountId);
    });
    this.openOrdersInFlight.set(accountId, read);
    return read;
  }

  private async fetchOpenOrders(accountId: number): Promise<Order[]> {
    const res = await this.post<OrderSearchResponse>("/api/Order/searchOpen", { accountId });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to fetch orders");
    return res.orders.map((o) => ({
      ...o,
      ...orderCodes(o, `Order/searchOpen id=${o.id}`),
    }));
  }

  /** Drop the cached open-orders snapshot for an account, and any read in
   *  flight from being shared or cached. Each mutation we make ourselves
   *  (placeOrder, placeOrderRaw, cancelOrder, modifyOrder) calls it in a `finally`: one that
   *  throws may still have reached the gateway with only the answer lost. */
  invalidateOpenOrders(accountId: number): void {
    this.openOrdersCache.delete(accountId);
    this.openOrdersInFlight.delete(accountId);
  }

  async placeOrder(order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    // Topstep silently returns HTTP 500 with an empty body when customTag
    // exceeds ~64 chars (confirmed 2026-04-20, see docs/api-notes.md). Reject
    // at the boundary so a future caller bypassing buildCustomTag can't ship
    // unplaceable orders. Cap at 60 to leave headroom for any server-side
    // prefixing we don't see.
    if (order.customTag && order.customTag.length > 60) {
      throw new Error(
        `customTag exceeds 60-char safety cap (${order.customTag.length} chars): ${order.customTag}`,
      );
    }
    try {
      const res = await this.post<PlaceOrderResponse>(PLACE_ORDER_PATH, order);
      if (!res.success) {
        // AccountNotFound auto-pauses every deployment on the account; a
        // refusal code is the broker's answer and starts a status check.
        if (res.errorCode === 1) {
          throw new AccountNotFoundError(order.accountId);
        }
        if (PLACE_REFUSAL_CODES.has(res.errorCode)) {
          throw new TopstepOrderRejectionError(order.accountId, res.errorCode, res.errorMessage);
        }
        throw new Error(res.errorMessage ?? `Failed to place order (errorCode ${res.errorCode})`);
      }
      return res;
    } finally {
      this.invalidateOpenOrders(order.accountId);
    }
  }

  /** Dev/test variant: accepts arbitrary payload shape so we can probe gateway behavior.
   *  Invalidates the open-orders cache for any accountId on the payload. */
  async placeOrderRaw(payload: unknown): Promise<PlaceOrderResponse> {
    try {
      return await this.post<PlaceOrderResponse>(PLACE_ORDER_PATH, payload);
    } finally {
      const accountId = (payload as { accountId?: unknown })?.accountId;
      if (typeof accountId === "number") this.invalidateOpenOrders(accountId);
    }
  }

  async cancelOrder(orderId: number, accountId: number): Promise<void> {
    try {
      const res = await this.post<{ success: boolean; errorMessage: string | null }>(
        "/api/Order/cancel",
        { orderId, accountId },
      );
      if (!res.success) throw new Error(res.errorMessage ?? "Failed to cancel order");
    } finally {
      this.invalidateOpenOrders(accountId);
    }
  }

  // ── Positions ─────────────────────────────────────────────────────

  async searchOpenPositions(accountId: number): Promise<Position[]> {
    const res = await this.post<PositionSearchResponse>("/api/Position/searchOpen", { accountId });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to fetch positions");
    return res.positions;
  }

  // ── Trade fills ───────────────────────────────────────────────────

  /** /api/Trade/search — returns individual fills within a time window. */
  async searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeFill[]> {
    const res = await this.post<TradeSearchResponse>("/api/Trade/search", {
      accountId,
      startTimestamp,
      endTimestamp: endTimestamp ?? null,
    });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to fetch trades");
    return res.trades;
  }

  // Topstep's /Trade/search is already historical (not session-scoped), so
  // post-restart reconciliation never needs an order-id-scoped fallback here.
  // Exists to satisfy the Broker interface; Tradovate is the only consumer.
  async getFillsForOrder(_orderId: number, _accountId: number): Promise<TradeFill[]> {
    return [];
  }

  // ── Contracts ─────────────────────────────────────────────────────

  async searchContracts(searchText: string, live = false): Promise<Contract[]> {
    const res = await this.post<ContractSearchResponse>("/api/Contract/search", {
      searchText,
      live,
    });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to search contracts");
    // The envelope is a cast, and every caller of this `Broker` member
    // reads `c.id.split(".")[3]` inside a `.filter()`. Unguarded, a
    // malformed element surfaces as a TypeError from inside a route's
    // try — a 500 that names neither the broker nor the field.
    if (!Array.isArray(res.contracts)) {
      throw new Error("Topstep /Contract/search returned no contract list");
    }
    // Drop malformed elements rather than refusing the list. The search is
    // fuzzy — "NQ" returns products no caller wants — and the engine's
    // ContractResolver runs through here on every tick, so throwing over an
    // unrelated element would stop a deployment resolving the product it
    // does want, with no recovery until Topstep stopped sending it. A search
    // that yields nothing usable still fails loudly one frame later, at the
    // caller's `activeContract` find, which names the ticker.
    const valid = res.contracts.filter(isContract);
    if (valid.length !== res.contracts.length) {
      log.event(
        "broker_response_malformed",
        "client.searchContracts",
        `dropped ${res.contracts.length - valid.length}/${res.contracts.length} malformed contracts from Topstep response (searchText=${searchText})`,
      );
    }
    return valid;
  }

  async getContractById(contractId: string): Promise<Contract> {
    const res = await this.post<ContractByIdResponse>("/api/Contract/searchById", { contractId });
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to fetch contract");
    return res.contract;
  }

  // ── Historical Bars ───────────────────────────────────────────────

  async retrieveBars(request: RetrieveBarsRequest): Promise<BarDataApi[]> {
    // Topstep's daily maintenance window (~17:00–18:00 ET) and ad-hoc gateway
    // hiccups surface here as 502/503/504 from /retrieveBars. The engine's
    // warmup, snapshot, and exit-fill paths all funnel through this method,
    // so a transient gateway blip during maintenance otherwise turns into a
    // hard error in engine logs. Retry twice with backoff before giving up.
    const RETRY_DELAYS_MS = [2_000, 5_000];
    let lastErr: unknown;
    let res: RetrieveBarsResponse | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        res = await this.post<RetrieveBarsResponse>("/api/History/retrieveBars", request);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === RETRY_DELAYS_MS.length || !isTransientGatewayError(err)) throw err;
        const delay = RETRY_DELAYS_MS[attempt];
        log.event(
          "broker_retry",
          "client.retrieveBars",
          `transient error on attempt ${attempt + 1}, retrying in ${delay}ms (contract=${request.contractId}): ${err instanceof Error ? err.message : String(err)}`,
          { contractId: request.contractId },
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (res === null) throw lastErr instanceof Error ? lastErr : new Error("retrieveBars failed");
    if (!res.success) throw new Error(res.errorMessage ?? "Failed to retrieve bars");
    // Runtime guard: TypeScript types evaporate at the network boundary, so
    // a malformed bar (null OHLC, string prices, missing fields) would flow
    // straight into strategy/backtest math as NaN with no surface warning.
    // Drop bad bars and log loudly — partial data is recoverable; silent
    // NaN-poisoned equity curves and entry signals are not.
    const validBars: BarDataApi[] = [];
    let dropped = 0;
    for (const b of res.bars ?? []) {
      if (
        b != null &&
        typeof b.t === "string" &&
        Number.isFinite(b.o) &&
        Number.isFinite(b.h) &&
        Number.isFinite(b.l) &&
        Number.isFinite(b.c) &&
        Number.isFinite(b.v)
      ) {
        validBars.push(b);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      log.event(
        "broker_response_malformed",
        "client.retrieveBars",
        `dropped ${dropped}/${res.bars?.length ?? 0} malformed bars from Topstep response (contract=${request.contractId}, unit=${request.unit}/${request.unitNumber})`,
        { contractId: request.contractId },
      );
    }
    return validBars;
  }

  // ── Order Modification ────────────────────────────────────────────

  async modifyOrder(accountId: number, orderId: number, updates: {
    size?: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
  }): Promise<void> {
    try {
      const res = await this.post<{ success: boolean; errorMessage: string | null }>(
        "/api/Order/modify",
        { accountId, orderId, ...updates },
      );
      if (!res.success) throw new Error(res.errorMessage ?? "Failed to modify order");
    } finally {
      this.invalidateOpenOrders(accountId);
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    // Per-path timeout: a hung TCP connection (gateway accepted SYN but never
    // responds) would otherwise block forever, freezing the engine's tick
    // loop via `ticking`. Order placement gets a longer window since the
    // broker may legitimately take a few seconds; everything else 15s.
    const timeoutMs = path === PLACE_ORDER_PATH ? 20_000 : 15_000;

    // Single attempt that throws UnauthorizedError on 401 so the outer
    // postWithRetry wrapper can retry after re-validating the session.
    const attempt = async (): Promise<T> => {
      noteTopstepRequest(path);
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      noteTopstepResponse(path, res.status);

      if (res.status === 401) {
        throw new UnauthorizedError(path);
      }

      if (!res.ok) {
        const text = await res.text();
        const bodyPreview = redactPayload(path, body);
        throw new TopstepHttpError(
          res.status,
          `Topstep API error ${res.status} on ${path}: ${text || "(empty body)"} | payload=${bodyPreview}`,
        );
      }

      return res.json() as Promise<T>;
    };

    // Read before the await, not in the catch: the engine's client is shared,
    // and a sibling call's recovery can have put a fresh token on it by the
    // time this call's 401 lands. Reporting `this.token` then would hand the
    // live replacement over to be dropped.
    const refusedToken = this.token;
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      if (AUTH_PATHS.has(path)) throw err;
      // /api/Order/place is exempt from every retry: a 401 that arrived
      // after the gateway actually queued the order would produce a
      // duplicate live order on retry. customTag uniqueness is a secondary
      // safety net but not a hard contract — so we bail here and let the
      // engine's next tick decide whether to resubmit, with full knowledge
      // of current position/order state. The refused token is still dropped
      // from the shared cache, so that next tick is not handed it again.
      const deadTokenRecovery = topstepSessionState().recovery;
      if (path === PLACE_ORDER_PATH) {
        if (refusedToken) deadTokenRecovery?.discard(refusedToken, path);
        throw err;
      }
      // A standby process touches nothing of the session the running engine
      // holds; the 401 is its answer (`holdTokenRefresh`).
      if (topstepSessionState().refreshHeld) throw err;
      log.debug("auth", `401 on ${path} — triggering validateSession() refresh`);
      const refreshed = await this.validateSession().catch(() => null);
      if (refreshed) return attempt();
      // Validate refused it too, so the token is dead rather than stale.
      // Left in the cache it is served to every caller until it nears
      // `exp`, up to ~23h away. A 401 on the replacement propagates: this
      // call gets one retry, and the recovery bounds mints across calls.
      if (!refusedToken || !deadTokenRecovery) throw err;
      const replacement = await deadTokenRecovery.remint(refusedToken, path).catch(() => null);
      if (!replacement) throw err;
      this.token = replacement;
      return attempt();
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/plain",
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }
}
