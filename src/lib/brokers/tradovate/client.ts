import { log } from "@/lib/logger";
import { isProductionEnv } from "@/lib/env";
import {
  getTradovateApiCid,
  getTradovateApiSecret,
  getTradovateAppId,
  getTradovateAppVersion,
  getTradovateDeviceId,
  getTradovatePassword,
  getTradovateUsername,
} from "@/lib/db/settings";
import type {
  Account,
  Contract,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Position,
  TradeFill,
} from "@/lib/brokers/types";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { BrokerOrderRole } from "@/lib/trading/orders/order-role";
import {
  TradovateAccountNotActiveError,
  TradovateAuthPenaltyError,
  TradovateOrderRejectionError,
  TradovateUnauthorizedError,
  TradovateUnsupportedOperationError,
} from "./errors";
import {
  TRADOVATE_CANCELABLE_STATUSES,
  translateAccount,
  translateFill,
  translateOrder,
  translatePosition,
} from "./fill-mapping";
import {
  recordOrderMapping,
  recordOrderMappings,
  type TradovateOrderRole,
} from "@/lib/db/tradovate-order-map";
import {
  translatePlaceOrder,
  unwrapOrderId,
  type TradovateAccountContext,
  type TradovateContractContext,
} from "./order-mapping";
import { PenaltyResponseHandler } from "./penalty";
import {
  hasCancelOrderResponseShape,
  hasPenaltyEnvelope,
  hasPlaceOrderResponseShape,
  type TradovateAccount,
  type TradovateAuthCredentials,
  type TradovateAuthResponse,
  type TradovateCancelOrderBody,
  type TradovateContractMaturity,
  type TradovateContractSuggestion,
  type TradovateFill,
  type TradovateModifyOrderBody,
  type TradovateOrder,
  type TradovateOrderVersion,
  type TradovatePlaceOrderResponse,
  type TradovatePosition,
} from "./types";

/**
 * Tradovate REST client.
 *
 * Phase 1 shipped auth + penalty/circuit-breaker. Phase 3 adds the order
 * placement / cancel / modify methods plus the search-* lookups, and
 * declares `implements Broker` — TypeScript compilation is the type
 * gate proving Phase 0 + Phase 3 are compatible without engine edits.
 *
 * Engine wiring is Phase 4 territory. Nothing in src/lib/trading/
 * references this class until then; the only reachable call sites today
 * are the Settings test-connection route and the probe scripts.
 *
 * Credentials come from the in-app `app_settings` rows (wizard +
 * Settings page), NOT from env. The standalone probe scripts at
 * scripts/probe-tradovate-*.mjs are the only env-reading paths and use
 * env strictly as a dev shortcut.
 *
 * Mirrors `TopstepClient`'s shape for consistency:
 *   - per-path timeout
 *   - 401 → refresh token → retry once
 *   - 1s open-orders TTL cache + invalidate-on-mutation (load-bearing
 *     per proposal §"Open-orders cache TTL")
 *   - typed errors at the boundary
 *   - structured logging via @/lib/logger (auto-redacts tokens)
 */

// Demo vs live host. Driven by the deploy-env helper (NEXT_PUBLIC_APP_ENV
// inlined at build): prod targets the live gateway, anything else
// (staging, undefined, typo) targets demo. Tradovate's live/demo split
// is host-level, not per-account — so this single decision drives both
// the REST base URL here and the WS host in realtime.ts, and the
// translator stamps `practice` on every Tradovate Account accordingly.
const DEMO_BASE_URL = "https://demo.tradovateapi.com/v1";
const LIVE_BASE_URL = "https://live.tradovateapi.com/v1";

function resolveBaseUrl(): string {
  return isProductionEnv() ? LIVE_BASE_URL : DEMO_BASE_URL;
}

// Refresh window: re-auth ≥ this many ms before token expiry. Gives the
// renewal call a comfortable buffer if the gateway is slow to respond.
const TOKEN_REFRESH_MARGIN_MS = 30_000;

/** Renew this long before expiry, as Tradovate advises. A renewal is refused
 *  once the token has expired, so a renewal left to the 30 s margin above
 *  mostly found it expired and logged in with the password instead (A123). */
export const RENEW_AHEAD_MS = 15 * 60 * 1000;

/** When a token already has under `RENEW_AHEAD_MS` left, renew this soon:
 *  Tradovate's documented renewal back-off, so it is never refused for being
 *  too close to the mint or renewal that issued the token. */
export const RENEW_AHEAD_SOON_MS = 15_000;

/** Retry spacing after a renew-ahead whose mint fallback also failed, and
 *  after a renewal that left the token still inside the lead (a server clock
 *  far ahead of ours). Tradovate allows 15 renewals an hour, one per 4 min;
 *  5 min stays under that, and still gives three tries inside the 15 min lead
 *  before the token expires and the lazy path takes over. */
export const RENEW_AHEAD_RETRY_MS = 5 * 60 * 1000;

/** setTimeout's ceiling. A longer delay fires at once, so a far-off expiry
 *  is armed at the ceiling and re-armed when it fires early. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The auth path's captcha answer. A plain `Error`, not
 *  `TradovateCaptchaLockoutError`, because the plugin classifies a login
 *  failure by class and retyping it changes what Test Connection and the
 *  orphan path say; the renew-ahead timer recognises it by this message. */
const AUTH_CAPTCHA_LOCKOUT_MESSAGE =
  "Tradovate auth p-captcha lockout — third-party app disabled for ~1h";

function isAuthCaptchaLockout(err: unknown): boolean {
  return err instanceof Error && err.message === AUTH_CAPTCHA_LOCKOUT_MESSAGE;
}

// Per-account 1s TTL cache for `searchOpenOrders`. Mirrors the Topstep
// client (src/lib/topstep/client.ts:108) — the engine calls this 3+ times
// per trade lifecycle in the same tick window. Without dedup the
// reconciler tick alone fires 2 calls back-to-back. 1s is short enough
// that breakeven / exit paths still see fresh data after our own
// invalidate-on-mutation calls.
const OPEN_ORDERS_TTL_MS = 1_000;

// Account-spec cache TTL — `accountSpec` comes from `/account/list` and
// only changes when the operator renames or adds an account. 5min is the
// same shape Topstep uses for the account-name cache (engine.ts:3483
// refreshes every 30min; we go shorter here since adding a Tradovate
// account is more user-driven and a fresh placeOrder shouldn't wait on
// 30min stale data).
const ACCOUNT_SPEC_TTL_MS = 5 * 60 * 1000;

/** How long a contract id `/contract/item` failed to name is left unasked.
 *  Without it a gateway whose contract endpoint is down while `/position/list`
 *  works makes every safety-path read pay a fresh request timeout. */
export const CONTRACT_WARM_FAILURE_TTL_MS = 5 * 60 * 1000;

/** The most `searchOpenPositions` waits on warms before translating with
 *  what is cached. Its callers are the watchdog, force-flat and the
 *  flattens, which must not stall for the 15 s request timeout. */
export const POSITION_WARM_WAIT_MS = 2_000;

/** The place-order `failureReason` that is not a failure. */
const PLACE_SUCCESS_REASON = "Success";

/**
 * The place-order `failureReason` values that are the broker refusing the
 * order on risk or account grounds, so nothing is booked — from Tradovate's
 * documented enum (NinjaTrader REST reference, orders/place-order). Only
 * these become `TradovateOrderRejectionError`, which the plugin classifies
 * `order_rejected` and the watchdog reads as "refused, retry now" (A37).
 * Everything else — RiskCheckTimeout, UnknownReason, OtherExecutionRelated,
 * ExecutionProviderUnavailable, AnotherCommandPending, the order-validation
 * values, anything undocumented — is a plain Error: it does not say the
 * order is not on the book. AccountNotActive has its own class.
 */
const PLACE_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  // Account
  "AccountClosed",
  "TradingLocked",
  "LiquidationOnly",
  "LiquidationOnlyBeforeExpiration",
  "MultipleAccountPlanRequired",
  "KeyInformationDocumentRequired",
  "SSFNFAComplianceRequired",
  "SSFNFAComplianceRequiredJointOnly",
  "SSFRiskDisclosureAcknowledgmentRequired",
  "Unauthorized",
  // Risk
  "BackMonthProhibited",
  "MaxOrderQtyIsNotSpecified",
  "MaxOrderQtyLimitReached",
  "MaxPosLimitMisconfigured",
  "MaxPosLimitReached",
  "MaxTotalPosLimitReached",
]);

// 75 minutes — the conservative fallback the prior-art repo uses when
// Tradovate's response includes neither `expirationTime` nor `expiresIn`.
const FALLBACK_EXPIRY_MS = 75 * 60 * 1000;

const AUTH_PATH = "/auth/accessTokenRequest";
const RENEW_PATH = "/auth/renewAccessToken";

interface AuthState {
  accessToken: string;
  mdAccessToken: string | null;
  expiresAt: number;
  /** Tradovate's numeric user id from the auth response. Phase 5's WS
   *  subscriber needs it for the `user/syncRequest` body. May be null if
   *  the response somehow omits it (defensive — older Tradovate gateway
   *  builds reportedly didn't always include it). */
  userId: number | null;
}

/**
 * Read credentials from the DB. Returns null if any required field is
 * missing — the caller surfaces this as a setup-incomplete error rather
 * than throwing on partial state.
 */
export interface TradovateCredentialBundle {
  username: string;
  password: string;
  apiCid: string;
  apiSecret: string;
  appId: string;
  appVersion: string;
  deviceId: string;
}

export function readTradovateCredentialsFromDb(): TradovateCredentialBundle | null {
  const username = getTradovateUsername();
  const password = getTradovatePassword();
  const apiCid = getTradovateApiCid();
  const apiSecret = getTradovateApiSecret();
  const appId = getTradovateAppId();
  const appVersion = getTradovateAppVersion();
  const deviceId = getTradovateDeviceId();
  if (
    !username ||
    !password ||
    !apiCid ||
    !apiSecret ||
    !appId ||
    !appVersion ||
    !deviceId
  ) {
    return null;
  }
  return { username, password, apiCid, apiSecret, appId, appVersion, deviceId };
}

export class TradovateClient implements Broker {
  private auth: AuthState | null = null;
  private penalty = new PenaltyResponseHandler();
  private openOrdersCache = new Map<number, { orders: Order[]; expiresAt: number }>();
  private openOrdersInFlight = new Map<number, Promise<Order[]>>();
  private accountSpecCache: { entries: Map<number, string>; expiresAt: number } | null = null;
  /** Tradovate numeric contractId → engine-side contract string (the
   *  dated symbol the per-broker resolver returned at trade-store time,
   *  e.g. `MESU2025`). Populated whenever the client fetches contract
   *  metadata: `suggestContracts` writes every returned item, and
   *  `warmContractId` fills in misses observed by the WS dispatcher.
   *  Read by `getDatedSymbolForContractId` (sync) which the WS + REST
   *  translators consume so reconciliation lookups
   *  (`findTradeByAccountContract`) match the stored row's contractId. */
  private contractIdToSymbol = new Map<number, string>();
  /** Single-flight guard for `warmContractId` so concurrent WS misses on
   *  the same numeric id collapse to one `/contract/item` round-trip. */
  private warmingContractIds = new Map<number, Promise<void>>();
  /** When a warm last failed to name each id. `warmContractId` answers at
   *  once inside `CONTRACT_WARM_FAILURE_TTL_MS` of it, so a `/contract/item`
   *  that is down is not asked again by every safety-path read. */
  private warmFailedAt = new Map<number, number>();
  /** Single-flight guard for `validateSession` so concurrent 401-recovery
   *  paths (REST + WS reconnect) don't both hit `/auth/renewAccessToken`
   *  and race to persist a stale token. The promise is cleared in a
   *  `finally` so a failure doesn't latch the guard. */
  private validatingSession: Promise<AuthState> | null = null;
  private renewAheadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `dispose()`; the renew-ahead timer is never armed again. */
  private disposed = false;
  private readonly renewsAhead: boolean;

  constructor(
    private baseUrl: string = resolveBaseUrl(),
    /**
     * Optional credential override. Used by the probe script (which may
     * pull from env for dev convenience). Production code paths leave
     * this undefined and the client reads from `app_settings` on every
     * `authenticate()` call so a wizard re-save takes effect without a
     * client rebuild.
     */
    private credentialOverride: TradovateCredentialBundle | null = null,
    /**
     * `renewAhead`: arm the renew-ahead timer on every successful auth. Off
     * unless asked for, because a renewing client holds one of the user's two
     * Tradovate sessions open for good; the plugin asks only in a process
     * that runs the engine (tradovate.md, *Auth*).
     */
    options: { renewAhead?: boolean } = {},
  ) {
    this.renewsAhead = options.renewAhead === true;
  }

  // ── Auth ──────────────────────────────────────────────────────────

  /**
   * Mint a fresh access token via `/auth/accessTokenRequest`. Captures
   * both `accessToken` (REST + Real-Time WS) and `mdAccessToken`
   * (Market Data WS) — the latter is unused in v1 but required for the
   * v1.5 Tradovate-bars work, and capturing it now costs nothing.
   *
   * Throws if credentials are not configured (the caller shows the
   * "open the wizard" error to the operator).
   */
  async authenticate(): Promise<AuthState> {
    const creds = this.credentialOverride ?? readTradovateCredentialsFromDb();
    if (!creds) {
      throw new Error(
        "Tradovate credentials not configured — visit /settings to add them",
      );
    }
    const body: TradovateAuthCredentials = {
      name: creds.username,
      password: creds.password,
      appId: creds.appId,
      appVersion: creds.appVersion,
      cid: creds.apiCid,
      sec: creds.apiSecret,
      deviceId: creds.deviceId,
    };
    const res = await this.requestRaw<TradovateAuthResponse>(
      "POST",
      AUTH_PATH,
      { ...body },
      null,
    );
    return this.consumeAuthResponse(res);
  }

  /**
   * Renew the existing access token via `GET /auth/renewAccessToken`. If
   * renewal fails — Tradovate refuses an expired token — fall back to a
   * fresh `accessTokenRequest` mint. Throws if there's no current token to renew
   * AND no credentials to mint a fresh one with.
   */
  async validateSession(): Promise<AuthState> {
    // Single-flight: concurrent callers (REST 401 retry + WS reconnect's
    // token-refresh) collapse to one in-flight renewAccessToken so we
    // don't burn the request budget or persist an older token over a
    // newer one in a race.
    if (this.validatingSession) return this.validatingSession;
    const run = (async (): Promise<AuthState> => {
      if (!this.auth) {
        // No token to renew — fall straight through to a fresh mint.
        return this.authenticate();
      }
      try {
        // GET with the token as Bearer and no body. A POST here is an unknown
        // route: it 404s with an empty body, so no renewal ever succeeded.
        const res = await this.requestRaw<TradovateAuthResponse>(
          "GET",
          RENEW_PATH,
          undefined,
          this.auth.accessToken,
        );
        return this.consumeAuthResponse(res, "renewal");
      } catch (err) {
        // p-time is a hard backoff: a login inside the window escalates
        // toward the captcha lockout.
        if (err instanceof TradovateAuthPenaltyError) throw err;
        log.event(
          "broker_retry",
          "tradovate.auth",
          `renewAccessToken failed, falling back to fresh authenticate(): ${err instanceof Error ? err.message : String(err)}`,
        );
        return this.authenticate();
      }
    })();
    this.validatingSession = run;
    try {
      return await run;
    } finally {
      this.validatingSession = null;
    }
  }

  /**
   * Externally-provided token (for callers that hold their own auth
   * lifecycle, e.g. tests). Mirrors TopstepClient.setToken — if you
   * pass it just an access token, mdAccessToken is unset and the
   * fallback expiry is applied.
   */
  setToken(accessToken: string, mdAccessToken: string | null = null): void {
    this.auth = {
      accessToken,
      mdAccessToken,
      expiresAt: Date.now() + FALLBACK_EXPIRY_MS,
      userId: null,
    };
  }

  /** Current access token, or null if never authenticated. */
  getToken(): string | null {
    return this.auth?.accessToken ?? null;
  }

  /** Current market-data access token, or null. v1 doesn't use it but
   *  it's captured at auth time for v1.5. */
  getMdAccessToken(): string | null {
    return this.auth?.mdAccessToken ?? null;
  }

  /** Absolute epoch-ms expiry of the current access token, or 0 if
   *  never authenticated. */
  getTokenExpiresAt(): number {
    return this.auth?.expiresAt ?? 0;
  }

  /** Tradovate numeric user id captured at auth time. Null when the auth
   *  response didn't include it (treat as "WS subscriber unavailable"). */
  getUserId(): number | null {
    return this.auth?.userId ?? null;
  }

  /** True if the current token is missing or within the refresh margin. */
  needsRefresh(): boolean {
    if (!this.auth) return true;
    return this.auth.expiresAt - TOKEN_REFRESH_MARGIN_MS <= Date.now();
  }

  /**
   * Stop renewing ahead, for good. Call it when the client is dropped: the
   * timer would otherwise keep renewing a token nothing uses, holding one of
   * the user's two Tradovate sessions open. Requests still work afterwards,
   * renewing lazily.
   */
  dispose(): void {
    this.disposed = true;
    this.clearRenewAhead();
  }

  private clearRenewAhead(): void {
    if (this.renewAheadTimer === null) return;
    clearTimeout(this.renewAheadTimer);
    this.renewAheadTimer = null;
  }

  /** Arm for `RENEW_AHEAD_MS` before the current token's expiry, or for
   *  `RENEW_AHEAD_SOON_MS` from now when that has passed. */
  private armRenewAheadForToken(): void {
    if (!this.auth) return;
    const due = this.auth.expiresAt - RENEW_AHEAD_MS;
    const now = Date.now();
    this.armRenewAhead(due > now ? due : now + RENEW_AHEAD_SOON_MS);
  }

  /** Replace the timer with one firing at `at` — or none when the token will
   *  have expired by then: a renewal is refused after expiry, and the next
   *  REST call or WS connect mints instead. */
  private armRenewAhead(at: number): void {
    this.clearRenewAhead();
    if (!this.renewsAhead || this.disposed || !this.auth || at >= this.auth.expiresAt) return;
    const delay = Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => void this.renewAhead(), delay);
    // Not order work: the shutdown drain exits through process.exit and owes
    // this nothing, and a script that authenticated must not hang on it.
    timer.unref();
    this.renewAheadTimer = timer;
  }

  private async renewAhead(): Promise<void> {
    this.renewAheadTimer = null;
    if (!this.auth) return;
    if (this.auth.expiresAt - RENEW_AHEAD_MS > Date.now()) {
      this.armRenewAheadForToken();
      return;
    }
    try {
      // Success arms for the new token through consumeAuthResponse.
      const state = await this.validateSession();
      if (state.expiresAt - RENEW_AHEAD_MS <= Date.now()) {
        this.armRenewAhead(Date.now() + RENEW_AHEAD_RETRY_MS);
      }
    } catch (err) {
      if (err instanceof TradovateAuthPenaltyError) {
        const waitMs =
          err.pTimeSec === null ? RENEW_AHEAD_RETRY_MS : err.pTimeSec * 1000;
        log.event(
          "broker_penalty",
          "tradovate.auth",
          `Tradovate asked us to wait ${Math.round(waitMs / 1000)} s before renewing the access token; renewing again then.`,
        );
        this.armRenewAhead(Date.now() + waitMs);
        return;
      }
      if (isAuthCaptchaLockout(err)) {
        // Never retried: every login inside the lockout extends it. The next
        // REST call or WS connect is the retry, as for any lapsed token.
        log.event(
          "broker_auth_failed",
          "tradovate.auth",
          "Tradovate locked the app out with a captcha while renewing the access token; no more renewals ahead of expiry for this login.",
        );
        return;
      }
      log.event(
        "broker_auth_failed",
        "tradovate.auth",
        `Could not renew the Tradovate access token ahead of its expiry, and the fresh login failed too: ${err instanceof Error ? err.message : String(err)}. Trying again in ${RENEW_AHEAD_RETRY_MS / 60_000} min.`,
      );
      this.armRenewAhead(Date.now() + RENEW_AHEAD_RETRY_MS);
    }
  }

  // ── Contract resolution endpoints ─────────────────────────────────

  /**
   * `GET /contract/suggest?t=<root>` — returns dated contracts for a
   * root, front-first by observation. Used by the contract resolver;
   * not part of the Phase 4 `Broker` interface (resolver is per-broker).
   *
   * Defensive filter: `/contract/suggest` is fuzzy and may include items
   * whose name doesn't actually start with the requested root (the
   * prior-art repo applies the same filter — symbolMapper.ts:178-183).
   */
  async suggestContracts(root: string): Promise<TradovateContractSuggestion[]> {
    const upper = root.toUpperCase();
    const path = `/contract/suggest?t=${encodeURIComponent(upper)}`;
    const res = await this.request<unknown>("GET", path, undefined, null);
    const arr = Array.isArray(res) ? res : res ? [res] : [];
    const items: TradovateContractSuggestion[] = [];
    for (const raw of arr) {
      if (typeof raw !== "object" || raw === null) continue;
      const o = raw as Record<string, unknown>;
      const id = typeof o.id === "number" ? o.id : NaN;
      const name = typeof o.name === "string" ? o.name : "";
      const symbol = typeof o.symbol === "string" ? o.symbol : "";
      if (!Number.isFinite(id) || (!name && !symbol)) continue;
      // Match prior-art (symbolMapper.ts:178-183): check name OR symbol
      // for the root prefix — defensive against responses where one is
      // empty and the other is populated.
      if (!(name || symbol).toUpperCase().startsWith(upper)) continue;
      const contractMaturityId =
        typeof o.contractMaturityId === "number" ? o.contractMaturityId : undefined;
      items.push({
        id,
        name,
        ...(symbol ? { symbol } : {}),
        contractMaturityId,
      });
      // Side-effect: feed the contractId↔dated-symbol cache so the WS
      // and REST translators can map numeric contractIds back to the
      // string the engine stored at trade time. Prefer `name` (always
      // the dated symbol on /contract/suggest); fall back to `symbol`
      // when name is empty.
      const datedSymbol = name || symbol;
      if (datedSymbol) {
        this.contractIdToSymbol.set(id, datedSymbol);
      }
    }
    return items;
  }

  /**
   * `GET /contract/item?id=<id>` — direct lookup for a single Tradovate
   * contract by numeric id. Used by the lazy-warm path when the WS
   * dispatch hits a contractId that isn't in the cache (e.g. an entity
   * arrives for a contract no enabled deployment pre-populated). Caches
   * the dated symbol on success so subsequent events for the same id
   * resolve. Returns null on a malformed body.
   */
  async getContract(id: number): Promise<{ id: number; name: string } | null> {
    const path = `/contract/item?id=${encodeURIComponent(String(id))}`;
    const res = await this.request<unknown>("GET", path, undefined, null);
    if (typeof res !== "object" || res === null) return null;
    const o = res as Record<string, unknown>;
    const respId = typeof o.id === "number" ? o.id : id;
    const name = typeof o.name === "string" ? o.name : "";
    if (!name) return null;
    this.contractIdToSymbol.set(respId, name);
    return { id: respId, name };
  }

  /** Sync read of the contractId↔dated-symbol cache. Returns null when
   *  no mapping has been observed yet for this numeric id. Translators
   *  fall back to the stringified numeric on miss; the WS dispatch path
   *  separately fires `warmContractId` so the next event resolves. */
  getDatedSymbolForContractId(numericContractId: number): string | null {
    return this.contractIdToSymbol.get(numericContractId) ?? null;
  }

  /**
   * Lazy-warm a single numeric contractId. Single-flighted per id so a
   * burst of WS events on an unknown contract doesn't trigger N parallel
   * `/contract/item` calls. Errors are swallowed at warn level. A warm
   * that fails to name the id is not retried for
   * `CONTRACT_WARM_FAILURE_TTL_MS`: the call resolves at once, unmapped.
   */
  warmContractId(numericContractId: number): Promise<void> {
    if (this.contractIdToSymbol.has(numericContractId)) return Promise.resolve();
    const failedAt = this.warmFailedAt.get(numericContractId);
    if (failedAt !== undefined && Date.now() - failedAt < CONTRACT_WARM_FAILURE_TTL_MS) {
      return Promise.resolve();
    }
    const inflight = this.warmingContractIds.get(numericContractId);
    if (inflight) return inflight;
    const run = (async () => {
      try {
        await this.getContract(numericContractId);
      } catch (err) {
        log.event(
          "contract_warm_failed",
          "tradovate.client",
          `warmContractId(${numericContractId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          { contractId: String(numericContractId) },
        );
      } finally {
        this.warmingContractIds.delete(numericContractId);
        if (this.contractIdToSymbol.has(numericContractId)) this.warmFailedAt.delete(numericContractId);
        else this.warmFailedAt.set(numericContractId, Date.now());
      }
    })();
    this.warmingContractIds.set(numericContractId, run);
    return run;
  }

  /**
   * Pre-populate the contractId↔dated-symbol cache for a set of root
   * symbols (e.g. `MES`, `ES`). Engine boot calls this for each enabled
   * Tradovate-broker deployment ticker so the WS dispatcher's first
   * event already has its contractId mapping cached and reconciliation
   * works on the very first frame. Per-root failures are isolated;
   * errors warn but don't throw — polling fallback covers any root that
   * fails to warm.
   */
  async warmContractIdsForRoots(roots: string[]): Promise<void> {
    for (const root of roots) {
      try {
        await this.suggestContracts(root);
      } catch (err) {
        log.event(
          "contract_warm_failed",
          "tradovate.client",
          `warmContractIdsForRoots: suggest(${root}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * `GET /contract/item?id=<id>` then `GET /contractGroup/item?id=<groupId>` —
   * resolve tickSize + tickValue for a Tradovate numeric contractId. Used by
   * the dashboard's /api/contracts/by-id fan-out so unrealized P&L can be
   * computed for Tradovate-broker positions (the formula needs tickSize and
   * tickValue per the use-trading state reducer).
   *
   * Tradovate's wire field for dollars-per-point is `valuePerPoint`; the
   * engine's broker-neutral term is `tickValue` (dollars per tick). The
   * conversion is `tickValue = valuePerPoint * tickSize`. Returns null on
   * any unparseable response so the route can fall back gracefully.
   */
  async getContractSpec(
    numericContractId: number,
  ): Promise<{ tickSize: number; tickValue: number } | null> {
    const contractPath = `/contract/item?id=${encodeURIComponent(String(numericContractId))}`;
    const contractRes = await this.request<unknown>("GET", contractPath, undefined, null);
    if (typeof contractRes !== "object" || contractRes === null) return null;
    const c = contractRes as Record<string, unknown>;
    const groupId = typeof c.contractGroupId === "number" ? c.contractGroupId : NaN;
    if (!Number.isFinite(groupId)) return null;
    const groupPath = `/contractGroup/item?id=${encodeURIComponent(String(groupId))}`;
    const groupRes = await this.request<unknown>("GET", groupPath, undefined, null);
    if (typeof groupRes !== "object" || groupRes === null) return null;
    const g = groupRes as Record<string, unknown>;
    const tickSize = typeof g.tickSize === "number" ? g.tickSize : NaN;
    const valuePerPoint = typeof g.valuePerPoint === "number" ? g.valuePerPoint : NaN;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
    if (!Number.isFinite(valuePerPoint) || valuePerPoint <= 0) return null;
    return { tickSize, tickValue: valuePerPoint * tickSize };
  }

  /**
   * `GET /contractMaturity/item?id=<id>` — returns the expiration date for
   * a maturity. The resolver calls it once, on the suggestion it matched to
   * the Topstep month, to populate the expiry the pairing error prints.
   *
   * Returns null if the response body is unusable (defensive — keeps
   * the resolver's fallback path simple instead of bubbling a partial
   * shape it would have to re-validate).
   */
  async getContractMaturity(id: number): Promise<TradovateContractMaturity | null> {
    const path = `/contractMaturity/item?id=${encodeURIComponent(String(id))}`;
    const res = await this.request<unknown>("GET", path, undefined, null);
    if (typeof res !== "object" || res === null) return null;
    const o = res as Record<string, unknown>;
    const respId = typeof o.id === "number" ? o.id : id;
    const expirationDate =
      typeof o.expirationDate === "string" ? o.expirationDate : undefined;
    return { id: respId, expirationDate };
  }

  /**
   * `Broker.searchContracts` — **unsupported on Tradovate, deliberately.**
   *
   * `/contract/suggest` is the closest endpoint and it returns
   * `{ id, name, symbol, contractMaturityId }`. Building a `Contract`
   * out of that means inventing four of its seven fields:
   *
   *  - `tickSize` / `tickValue` live on the *contract group*, two extra
   *    round trips per result through a rate-limited, circuit-broken
   *    gateway — and a fabricated tick size silently corrupts every
   *    unrealized-P&L figure computed from it.
   *  - `activeContract` needs a third call (`/contractMaturity/item`).
   *  - `description` and `symbolId` have no Tradovate analog at all.
   *  - `id` is the worst of them: `Contract.id` is the bars and
   *    market-data subscription key, and Tradovate is an execution venue
   *    whose data entitlement will never be bought. Its numeric id is an
   *    execution identifier — that is what `executionContractId` is for.
   *
   * Execution-side contract resolution is `TradovateContractResolver`'s
   * job and it pairs against Topstep for exactly the fields above. A
   * throw here is the same rule the broker-aware resolver already
   * enforces: answering with the other broker's contract, or with a
   * plausible-looking number, is worse than not answering.
   *
   * The refusal is typed so the plugin owns it. A plain `Error` off a
   * broker path is unattributed, and an unattributed throw classifies
   * out of the `auth` catch-all — which orphan-pauses on Tradovate.
   */
  async searchContracts(_searchText: string, _live?: boolean): Promise<Contract[]> {
    throw new TradovateUnsupportedOperationError(
      "contract search",
      "its suggest endpoint carries no tick size, description or market-data id. Use the broker-aware contract resolver for an account-scoped lookup.",
    );
  }

  // ── Broker: accounts ──────────────────────────────────────────────

  /**
   * `GET /account/list` — fetches all accounts the credentialed user has
   * access to. The `onlyActive` flag mirrors Topstep's filter; Tradovate
   * doesn't have a server-side equivalent so we filter client-side via
   * the translated `canTrade` field (Tradovate `active` → engine
   * `canTrade`, in fill-mapping's `translateAccount`).
   *
   * Refreshes the internal accountSpec cache as a side effect — every
   * place/cancel/modify needs the spec, so piggybacking on the catalog
   * refresh keeps a separate cache fetch off the place-order hot path.
   *
   * **A body that is not a list throws.** Every fan-out reads a resolved arm
   * as the broker's answer — the status check marks every account it omits
   * inactive — so a null or an error-shaped 200 read as `[]` would say every
   * account is closed. Thrown, the arm counts as failed and writes nothing.
   */
  async searchAccounts(onlyActive = true): Promise<Account[]> {
    const raw = await this.request<unknown>("GET", "/account/list", undefined, null);
    if (!Array.isArray(raw)) {
      throw new Error(
        `Tradovate /account/list answered ${raw === null ? "null" : typeof raw}, not a list of accounts`,
      );
    }
    const arr: unknown[] = raw;
    const accounts: Account[] = [];
    const specMap = new Map<number, string>();
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as TradovateAccount;
      if (typeof o.id !== "number" || typeof o.name !== "string") continue;
      const account = translateAccount(o);
      if (onlyActive && !account.canTrade) continue;
      accounts.push(account);
      specMap.set(account.id, account.name);
    }
    this.accountSpecCache = {
      entries: specMap,
      expiresAt: Date.now() + ACCOUNT_SPEC_TTL_MS,
    };
    return accounts;
  }

  /**
   * `GET /cashBalance/list` — per-account cash snapshot. Wire shape: array
   * of rows with `accountId: number` and `amount: number` (NOT
   * `cashBalance` — the Tradovate type names mislead). Returns a map of
   * accountId → amount for the first non-archived row per account; later
   * rows for the same id are ignored (multi-currency case is out of
   * scope, USD `currencyId === 1` is the only one we handle today).
   *
   * Used by /api/accounts to stamp `Account.balance` after the catalog
   * fetch. Live updates via the WS dispatcher are deferred (punchlist).
   */
  async getCashBalances(): Promise<Map<number, number>> {
    const raw = await this.request<unknown>(
      "GET",
      "/cashBalance/list",
      undefined,
      null,
    );
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const balances = new Map<number, number>();
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (o.archived === true) continue;
      const accountId = typeof o.accountId === "number" ? o.accountId : NaN;
      const amount = typeof o.amount === "number" ? o.amount : NaN;
      if (!Number.isFinite(accountId) || !Number.isFinite(amount)) continue;
      if (balances.has(accountId)) continue;
      balances.set(accountId, amount);
    }
    return balances;
  }

  // ── Broker: open orders ───────────────────────────────────────────

  /**
   * `GET /order/list` filtered to the requested account + cancellable
   * statuses. 1s TTL cache + invalidate-on-mutation matches Topstep
   * (load-bearing per proposal §"Open-orders cache TTL").
   *
   * Tradovate has `/order/items?ids=...` for batch lookup when ids are
   * known; the Phase 5 WS path will populate that cache and this list
   * call becomes a fallback. v1 polls.
   *
   * A caller that finds a read for the account already in flight shares it,
   * `forceFresh` included: that request left after the caller's last look.
   * One that arrives after it settled sends its own. `invalidateOpenOrders`
   * drops the shared read as well as the cache, so a read that left before
   * one of our own mutations is never handed to a caller after it, nor cached.
   */
  searchOpenOrders(
    accountId: number,
    opts: { forceFresh?: boolean } = {},
  ): Promise<Order[]> {
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
    const raw = await this.request<unknown>("GET", "/order/list", undefined, accountId);
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const open: TradovateOrder[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as TradovateOrder;
      if (typeof o.id !== "number" || typeof o.accountId !== "number") continue;
      if (o.accountId !== accountId) continue;
      // Engine-side searchOpenOrders consumers expect cancellable orders
      // only — match prior-art's `cancelableOrderStatuses` filter.
      if (typeof o.ordStatus !== "string") continue;
      if (!TRADOVATE_CANCELABLE_STATUSES.has(o.ordStatus)) continue;
      open.push(o);
    }
    // `/order/list` carries no orderType, orderQty, price or stopPrice —
    // all four live on the order version (bugs.md, demo-confirmed
    // 2026-10-24). Join the current version onto each order before
    // translating so a resting stop answers `type === 4` and a numeric
    // `stopPrice` as it does on Topstep; without it the reconciler and the
    // exit sweep see no bracket on a Tradovate account. One batch read,
    // sitting behind the 1s cache.
    await this.joinLatestOrderVersions(open, accountId);
    return open.map((o) =>
      translateOrder(o, (id) => this.getDatedSymbolForContractId(id)),
    );
  }

  /** Drop the cached open-orders snapshot for an account, and any read in
   *  flight from being shared or cached. placeOrder, cancelOrder and
   *  modifyOrder call it in a `finally` on every outcome once `request()` is
   *  entered: one that throws may still have reached the gateway with only
   *  the answer lost. A refusal inside `request()` before anything is sent
   *  (circuit open, failed session check) clears it too, costing a re-read. */
  invalidateOpenOrders(accountId: number): void {
    this.openOrdersCache.delete(accountId);
    this.openOrdersInFlight.delete(accountId);
  }

  /**
   * Fill `orderType`, `orderQty`, `price` and `stopPrice` on each order in
   * place from its current order version. `/order/list` carries none of
   * them (bugs.md). One `/orderVersion/ldeps?masterids=` read per
   * `searchOpenOrders` call, keyed by the open-order ids — batched, so the
   * join adds at most one request per account per second behind the open-
   * orders cache. By-masterid is cross-session like `/fill/deps`: a resting
   * stop placed before a restart still resolves, where the session-scoped
   * `/orderVersion/list` would not carry it — and the rebuilt-mirror leg is
   * exactly the case this fix exists for. The latest version per order
   * (highest version `id`) wins. A failed read leaves the orders as the
   * list gave them — `translateOrder` degrades a missing type to Stop and a
   * missing size to 0 — and polling retries next tick.
   */
  private async joinLatestOrderVersions(
    orders: TradovateOrder[],
    accountId: number,
  ): Promise<void> {
    if (orders.length === 0) return;
    // Encode each id, then join with a literal comma: Tradovate's `ldeps`
    // takes a comma-separated `masterids` list, and encoding the whole string
    // would percent-encode the separator. Ids are numeric, so the per-id
    // encode is a no-op that keeps the comma a comma.
    const masterids = orders.map((o) => encodeURIComponent(String(o.id))).join(",");
    const path = `/orderVersion/ldeps?masterids=${masterids}`;
    let raw: unknown;
    try {
      raw = await this.request<unknown>("GET", path, undefined, accountId);
    } catch (err) {
      log.event(
        "order_version_join_failed",
        "tradovate.client",
        `searchOpenOrders: /orderVersion/ldeps failed for account ${accountId} (${orders.length} order(s)): ${err instanceof Error ? err.message : String(err)} — orders keep their list fields`,
        { accountId },
      );
      return;
    }
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const latest = new Map<number, TradovateOrderVersion>();
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const v = item as TradovateOrderVersion;
      if (typeof v.id !== "number" || typeof v.orderId !== "number") continue;
      const prev = latest.get(v.orderId);
      if (!prev || v.id > prev.id) latest.set(v.orderId, v);
    }
    for (const o of orders) {
      const v = latest.get(o.id);
      if (!v) continue;
      if (v.orderType !== undefined) o.orderType = v.orderType;
      if (typeof v.orderQty === "number") o.orderQty = v.orderQty;
      if (typeof v.price === "number") o.price = v.price;
      if (typeof v.stopPrice === "number") o.stopPrice = v.stopPrice;
    }
  }

  /**
   * `GET /order/item?id=<id>` — single-order status lookup. Used by the
   * naked-position watchdog's Tradovate path to verify a known
   * bracket-SL orderId is still alive without round-tripping
   * `/order/list` (which is timeout-prone under load and depends on
   * the contractId-cache for engine-side filtering). Returns null on
   * miss or unparseable response. No caching — the watchdog cadence
   * (~30s) on a handful of orderIds per tick doesn't warrant it.
   *
   * No order-version join here (unlike `searchOpenOrders`): the sole
   * caller — the naked-position watchdog's coverage sum — reads only
   * `ordStatus` and uses the place-time `m.qty`, never the order's type,
   * size or price, so the extra `/orderVersion` read would be dead weight.
   */
  async getOrder(orderId: number, accountId: number): Promise<TradovateOrder | null> {
    const path = `/order/item?id=${encodeURIComponent(String(orderId))}`;
    const res = await this.request<unknown>("GET", path, undefined, accountId);
    if (typeof res !== "object" || res === null) return null;
    const o = res as Record<string, unknown>;
    if (typeof o.id !== "number" || typeof o.accountId !== "number") return null;
    if (typeof o.ordStatus !== "string") return null;
    return res as TradovateOrder;
  }

  // ── Broker: positions ─────────────────────────────────────────────

  /**
   * `GET /position/list` filtered to the requested account + non-zero
   * net positions. Mirrors prior-art at tradovateClient.ts:911-922.
   *
   * Warms the dated-symbol cache for any position's contract it does not
   * know before translating. Every consumer — the ghost sweep, the
   * pre-entry conflict check, `/api/positions` — matches on the dated
   * symbol the trade row holds, so a position on its stringified numeric id
   * reads as a ghost over a live position (bugs.md A72) and as FLAT on the
   * account chip (A68). One `/contract/item` per contract per process; a
   * warm that fails, or outlasts `POSITION_WARM_WAIT_MS`, still answers, on
   * the numeric id.
   */
  async searchOpenPositions(accountId: number): Promise<Position[]> {
    const raw = await this.request<unknown>("GET", "/position/list", undefined, accountId);
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const open: TradovatePosition[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as TradovatePosition;
      if (typeof p.id !== "number" || typeof p.accountId !== "number") continue;
      if (p.accountId !== accountId) continue;
      if (typeof p.netPos !== "number" || p.netPos === 0) continue;
      open.push(p);
    }
    const unmapped = new Set(
      open
        .map((p) => p.contractId)
        .filter((id) => typeof id === "number" && this.getDatedSymbolForContractId(id) === null),
    );
    if (unmapped.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waitCap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POSITION_WARM_WAIT_MS);
      });
      try {
        await Promise.race([Promise.all([...unmapped].map((id) => this.warmContractId(id))), waitCap]);
      } finally {
        clearTimeout(timer);
      }
    }
    return open.map((p) => translatePosition(p, (id) => this.getDatedSymbolForContractId(id)));
  }

  // ── Broker: trades / fills ────────────────────────────────────────

  /**
   * `GET /fill/list` windowed by timestamp. Tradovate's entity-system
   * list endpoints are subject to a variable data-size limit (proposal
   * §"Pagination: the eoh pattern"); for `/fill/list` a single account
   * over a normal trading day shouldn't approach the cap, but the
   * windowed start/end keeps the request bounded.
   *
   * Note: Tradovate doesn't appear to support server-side timestamp
   * filtering on `/fill/list` (the entity system uses entity-id ranges
   * via /deps and /ldeps). For Phase 3 we filter client-side and log
   * if the result count looks suspiciously large; Phase 5's WS path
   * supersedes this for live reconciliation.
   */
  async searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeFill[]> {
    const raw = await this.request<unknown>("GET", "/fill/list", undefined, accountId);
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const startMs = Date.parse(startTimestamp);
    const endMs = endTimestamp ? Date.parse(endTimestamp) : Number.POSITIVE_INFINITY;
    const fills: TradeFill[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const f = item as TradovateFill;
      if (typeof f.id !== "number" || typeof f.accountId !== "number") continue;
      if (f.accountId !== accountId) continue;
      if (typeof f.timestamp === "string") {
        const ts = Date.parse(f.timestamp);
        if (Number.isFinite(ts)) {
          if (ts < startMs) continue;
          if (ts > endMs) continue;
        }
      }
      fills.push(translateFill(f, (id) => this.getDatedSymbolForContractId(id)));
    }
    if (arr.length >= 500) {
      // Soft warn: prior-art doesn't track the exact cap; surface so we
      // can tune before going production.
      log.warn(
        "tradovate.client",
        `searchTrades returned ${arr.length} fills — approaching list cap, may need pagination`,
        { accountId },
      );
    }
    return fills;
  }

  /** `GET /fill/deps?masterid=<orderId>` — direct fill lookup for a
   *  parent order id. Cleaner than scanning /fill/list when the engine
   *  already knows the order id (Phase 4 will route here for entry/exit
   *  attribution). Returns `[]` if no fills indexed yet. */
  async getFillsForOrder(orderId: number, accountId: number): Promise<TradeFill[]> {
    const path = `/fill/deps?masterid=${encodeURIComponent(String(orderId))}`;
    const raw = await this.request<unknown>("GET", path, undefined, accountId);
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const fills: TradeFill[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const f = item as TradovateFill;
      if (typeof f.id !== "number") continue;
      fills.push(translateFill(f, (id) => this.getDatedSymbolForContractId(id)));
    }
    return fills;
  }

  // ── Broker: order placement ───────────────────────────────────────

  /**
   * `POST /order/placeOrder` (no brackets) or `POST /order/placeOSO`
   * (brackets). Translation lives in order-mapping.ts; this method just
   * hydrates the per-account context, posts the body, unwraps the
   * response, and invalidates the open-orders cache on success.
   *
   * Account context (accountSpec, deviceId) is required by Tradovate on
   * every order:
   *   - `accountSpec` comes from the cached account catalog (refreshed
   *     by `searchAccounts`); a placeOrder before the catalog is
   *     populated triggers an inline lookup.
   *   - `deviceId` comes from the credential bundle. Tradovate binds
   *     the API session to a stable deviceId per account; rotating it
   *     forces a fresh device approval.
   */
  async placeOrder(order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    const accountSpec = await this.resolveAccountSpec(order.accountId);
    const deviceId = this.credentialOverride?.deviceId ?? getTradovateDeviceId();
    if (!deviceId) {
      throw new Error(
        "Tradovate placeOrder: deviceId not configured (Settings → Tradovate)",
      );
    }
    const accountCtx: TradovateAccountContext = {
      accountSpec,
      accountId: order.accountId,
      deviceId,
    };
    // Phase 3 contract-context note: the engine call site at
    // engine.ts:3038-3045 builds PlaceOrderRequest with `contractId =
    // contract.id` (Topstep CON.F.US.* string) and does not populate
    // `tickSize`. For a Tradovate-routed order, Phase 4 will route the
    // contract through TradovateContractResolver and pass the dated
    // symbol as `contractId` plus the `tickSize` from the resolved
    // contract. Until that wiring lands, the translator throws a clear
    // error if either is missing on a bracketed entry — surfacing the
    // gap loudly during Phase 4 development.
    const contractCtx: TradovateContractContext = {
      symbol: order.contractId,
      tickSize: order.tickSize ?? 0,
    };

    const { endpoint, body } = translatePlaceOrder(order, accountCtx, contractCtx);
    try {
      const raw = await this.request<unknown>(
        "POST",
        endpoint,
        body as unknown as Record<string, unknown>,
        order.accountId,
      );
      if (!hasPlaceOrderResponseShape(raw)) {
        throw new Error(
          `Tradovate ${endpoint} returned unexpected response shape: ${JSON.stringify(raw).slice(0, 500)}`,
        );
      }
      const res: TradovatePlaceOrderResponse = raw;

      if (
        typeof res.failureReason === "string" &&
        res.failureReason.length > 0 &&
        res.failureReason !== PLACE_SUCCESS_REASON
      ) {
        // Tradovate convention: HTTP 200 with `failureReason` instead of
        // an order id. AccountNotActive auto-pauses, the same reaction as
        // Topstep's AccountNotFoundError.
        if (res.failureReason === "AccountNotActive") {
          throw new TradovateAccountNotActiveError(order.accountId);
        }
        if (PLACE_REFUSAL_REASONS.has(res.failureReason)) {
          throw new TradovateOrderRejectionError(
            endpoint,
            order.accountId,
            res.failureReason,
            res.failureText ?? null,
          );
        }
        // Not a statement that the order was refused (a timeout, a pending
        // command, an unknown): unowned, so the watchdog keeps its stamp.
        throw new Error(
          `Tradovate ${endpoint} did not confirm the order: ${res.failureReason}` +
            (res.failureText ? ` — ${res.failureText}` : "") +
            ` (account ${order.accountId})`,
        );
      }
      const orderId = unwrapOrderId(res);
      if (orderId === null) {
        throw new Error(
          `Tradovate ${endpoint}: response missing orderId (${JSON.stringify(res).slice(0, 200)})`,
        );
      }
      // Persist the (orderId → deploymentId, role) mapping rows BEFORE
      // returning to the caller. The WS dispatcher and any future fill
      // consumer use these to attribute an inbound fill back to the
      // originating deployment — Tradovate rejects unregistered Tag50
      // values so the customTag echo path Topstep relies on isn't
      // available. Sync persist + then return is the load-bearing
      // guarantee: the WS frame can race the placeOrder response and the
      // mapping must already be on disk when the fill lookup fires.
      if (typeof order.deploymentId === "string" && order.deploymentId.length > 0) {
        const role: TradovateOrderRole =
          order.brokerOrderRole === BrokerOrderRole.Exit ? "exit" : "entry";
        try {
          if (endpoint === "/order/placeOSO") {
            // OSO: bracket1 in the request body is the SL leg, bracket2 is
            // the TP leg (see order-mapping.ts:179-180). Tradovate's
            // response carries `oso1Id` / `oso2Id` mirroring that order.
            const rows: Array<{
              orderId: number;
              deploymentId: string;
              role: TradovateOrderRole;
              accountId: number;
              qty: number;
            }> = [
              {
                orderId,
                deploymentId: order.deploymentId,
                role,
                accountId: order.accountId,
                qty: order.size,
              },
            ];
            if (typeof res.oso1Id === "number") {
              rows.push({
                orderId: res.oso1Id,
                deploymentId: order.deploymentId,
                role: "sl",
                accountId: order.accountId,
                qty: order.size,
              });
            }
            if (typeof res.oso2Id === "number") {
              rows.push({
                orderId: res.oso2Id,
                deploymentId: order.deploymentId,
                role: "tp",
                accountId: order.accountId,
                qty: order.size,
              });
            }
            recordOrderMappings(rows);
          } else {
            recordOrderMapping({
              orderId,
              deploymentId: order.deploymentId,
              role,
              accountId: order.accountId,
              qty: order.size,
            });
          }
        } catch (err) {
          // The placeOrder itself succeeded — the broker has the order.
          // Failing to persist the mapping means the fill won't attribute
          // back to the deployment, but blocking the order on a DB write
          // failure would be worse. Log loudly so the operator sees it
          // and can recover via REST polling fallback.
          log.event(
            "order_map_write_failed",
            "tradovate.client",
            `placeOrder mapping persist failed for orderId ${orderId} (${order.deploymentId}/${role}); fill attribution will miss this order`,
            { deploymentId: order.deploymentId, accountId: order.accountId, meta: err },
          );
        }
      }
      // Engine `PlaceOrderResponse` is Topstep-shaped; Tradovate doesn't
      // emit success/errorCode envelope — synthesize the success path.
      // Surface bracket leg ids (oso1Id=SL, oso2Id=TP per the request-body
      // ordering at order-mapping.ts:179-180) so the engine can stamp
      // `sl_order_id`/`tp_order_id` on the trade row synchronously after
      // placeOrder resolves — eliminating the WS-race window where the
      // position-update event fires before the trade-row columns are set
      // and can't be re-driven (Tradovate emits one position event on entry
      // and nothing more until close).
      return {
        orderId,
        success: true,
        errorCode: 0,
        errorMessage: null,
        ...(typeof res.oso1Id === "number" ? { slOrderId: res.oso1Id } : {}),
        ...(typeof res.oso2Id === "number" ? { tpOrderId: res.oso2Id } : {}),
      };
    } finally {
      this.invalidateOpenOrders(order.accountId);
    }
  }

  // ── Broker: cancel + modify ───────────────────────────────────────

  async cancelOrder(orderId: number, accountId: number): Promise<void> {
    const body: TradovateCancelOrderBody = { orderId, isAutomated: true };
    try {
      const raw = await this.request<unknown>(
        "POST",
        "/order/cancelOrder",
        body as unknown as Record<string, unknown>,
        accountId,
      );
      if (!hasCancelOrderResponseShape(raw)) {
        throw new Error(
          `Tradovate /order/cancelOrder returned unexpected response shape: ${JSON.stringify(raw).slice(0, 500)}`,
        );
      }
      const res: TradovatePlaceOrderResponse = raw ?? {};
      if (typeof res.failureReason === "string" && res.failureReason.length > 0) {
        throw new TradovateOrderRejectionError(
          "/order/cancelOrder",
          accountId,
          res.failureReason,
          res.failureText ?? null,
        );
      }
    } finally {
      this.invalidateOpenOrders(accountId);
    }
  }

  async modifyOrder(
    accountId: number,
    orderId: number,
    updates: {
      size?: number;
      limitPrice?: number;
      stopPrice?: number;
      trailPrice?: number;
    },
  ): Promise<void> {
    // Tradovate has no `trailPrice` analog on /order/modifyOrder; engine
    // breakeven flow only sends stopPrice (engine.ts:5354) so this is a
    // documented one-way: trailPrice updates are dropped with a warn.
    if (updates.trailPrice !== undefined) {
      log.warn(
        "tradovate.client",
        `modifyOrder: trailPrice update dropped — Tradovate /order/modifyOrder has no trailing-stop modify analog`,
        { accountId, orderId, trailPrice: updates.trailPrice },
      );
    }
    const body: TradovateModifyOrderBody = { orderId, isAutomated: true };
    if (typeof updates.size === "number") body.orderQty = updates.size;
    if (typeof updates.limitPrice === "number") {
      body.price = updates.limitPrice;
      body.orderType = "Limit";
    }
    if (typeof updates.stopPrice === "number") {
      body.stopPrice = updates.stopPrice;
      body.orderType = "Stop";
    }
    try {
      const res = await this.request<TradovatePlaceOrderResponse>(
        "POST",
        "/order/modifyOrder",
        body as unknown as Record<string, unknown>,
        accountId,
      );
      if (typeof res.failureReason === "string" && res.failureReason.length > 0) {
        throw new TradovateOrderRejectionError(
          "/order/modifyOrder",
          accountId,
          res.failureReason,
          res.failureText ?? null,
        );
      }
    } finally {
      this.invalidateOpenOrders(accountId);
    }
  }

  // ── Internals: account-spec resolution ────────────────────────────

  /**
   * Look up an account's `accountSpec` (Tradovate's human-readable account
   * tag, e.g. "DEMO12345"). Reads from the catalog cache when fresh; falls
   * back to a `searchAccounts` fetch when stale or the cache doesn't carry
   * the requested id (operator added the account after boot).
   */
  private async resolveAccountSpec(accountId: number): Promise<string> {
    const cached = this.accountSpecCache;
    if (cached && cached.expiresAt > Date.now()) {
      const spec = cached.entries.get(accountId);
      if (spec) return spec;
      // Cache fresh but missing this id — fall through to refresh.
    }
    await this.searchAccounts(false);
    const refreshed = this.accountSpecCache?.entries.get(accountId);
    if (!refreshed) {
      throw new Error(
        `Tradovate: account ${accountId} not found in /account/list — credential mismatch or recently revoked`,
      );
    }
    return refreshed;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  /**
   * Authenticated request layer. Wraps `requestRaw` with:
   *   - circuit-breaker check before the wire call
   *   - 401 → renew → retry once (place-order paths exempt; not
   *     reachable in Phase 1 but the gate ships now)
   *   - penalty-envelope detection + sleep+ticket retry
   *
   * Phase 1 has no engine-side caller for this method; the auth
   * methods above use `requestRaw` directly because they don't need
   * an existing token. Later phases route their REST calls through
   * `request()`.
   */
  protected async request<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    accountId: number | null,
  ): Promise<T> {
    this.penalty.assertCircuitClosed(path, accountId);
    if (this.needsRefresh()) {
      await this.validateSession();
    }
    const attempt = async (): Promise<T> => {
      const res = await this.requestRaw<unknown>(method, path, body, this.getToken());
      const handled = await this.penalty.handle(res, {
        method,
        path,
        accountId,
        body,
        retry: async (retryBody) => {
          return this.requestRaw<unknown>(method, path, retryBody, this.getToken());
        },
      });
      return (handled.kind === "ok" ? res : handled.body) as T;
    };
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof TradovateUnauthorizedError)) throw err;
      // /auth/* are exempt from this retry to avoid recursion.
      if (path === AUTH_PATH || path === RENEW_PATH) throw err;
      // Place-order exemption — see the penalty-handler comment for
      // why a retry on 401 after a possibly-queued order is unsafe.
      // Phase 1 doesn't ship any place-order paths but the guard ships
      // here so Phase 3 doesn't have to add it.
      if (path === "/order/placeOrder" || path === "/order/placeOSO") throw err;
      log.debug(
        "tradovate.auth",
        `401 on ${path} — refreshing via renewAccessToken and retrying once`,
      );
      await this.validateSession().catch(() => null);
      return attempt();
    }
  }

  /**
   * Bare HTTP layer. No retry, no penalty handling, no auth refresh.
   * Used by `authenticate()` (which has no token yet) and by `request()`
   * inside its retry loop. Throws `TradovateUnauthorizedError` on 401
   * so the outer wrapper can decide whether to retry.
   */
  private async requestRaw<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    bearerToken: string | null,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

    const timeoutMs = 15_000;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method === "POST" && body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (res.status === 401) {
      throw new TradovateUnauthorizedError(path);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Tradovate API error ${res.status} on ${path}: ${text || "(empty body)"}`,
      );
    }
    return (await res.json()) as T;
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Consume an `/auth/accessTokenRequest` or `/auth/renewAccessToken`
   * response, validate it, store auth state, and return the new state.
   *
   * Tradovate sometimes 200s with an error envelope (e.g. captcha),
   * so check for `errorText` and the penalty fields before trusting
   * the body. A penalty on the auth path itself bubbles up as a
   * standard error — we don't try to recover (no engine-side context
   * for sleep/retry yet, and a captcha-locked auth means the operator
   * has bigger problems).
   */
  private consumeAuthResponse(
    res: TradovateAuthResponse,
    kind: "mint" | "renewal" = "mint",
  ): AuthState {
    if (hasPenaltyEnvelope(res)) {
      const captcha = (res as Record<string, unknown>)["p-captcha"];
      if (typeof captcha === "string" && captcha.length > 0) {
        throw new Error(AUTH_CAPTCHA_LOCKOUT_MESSAGE);
      }
      const pTime = res["p-time"];
      throw new TradovateAuthPenaltyError(typeof pTime === "number" ? pTime : null);
    }
    if (typeof res.errorText === "string" && res.errorText.length > 0) {
      throw new Error(`Tradovate auth failed: ${res.errorText}`);
    }
    if (typeof res.accessToken !== "string" || res.accessToken.length === 0) {
      throw new Error(
        `Tradovate auth response missing accessToken — ${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    const expiresAt = resolveExpiresAt(res);
    // The renewal answer carries no mdAccessToken and may omit userId; a
    // missing field keeps the earlier value (a null userId stops the
    // realtime adapter subscribing new accounts).
    const kept = kind === "renewal" ? this.auth : null;
    this.auth = {
      accessToken: res.accessToken,
      mdAccessToken:
        typeof res.mdAccessToken === "string" && res.mdAccessToken.length > 0
          ? res.mdAccessToken
          : (kept?.mdAccessToken ?? null),
      expiresAt,
      userId: typeof res.userId === "number" ? res.userId : (kept?.userId ?? null),
    };
    log.debug(
      "tradovate.auth",
      `authenticated; token expires at ${new Date(expiresAt).toISOString()}, mdAccessToken=${this.auth.mdAccessToken ? "captured" : "absent"}`,
    );
    this.armRenewAheadForToken();
    return this.auth;
  }
}

/**
 * Coerce a Tradovate auth response's expiry hint into an absolute
 * epoch-ms value. Prefers `expirationTime` (server-clock-anchored,
 * absolute) over `expiresIn` (local-clock-anchored, relative) so any
 * client/server clock drift surfaces in token-renewal timing instead
 * of being masked. Mirrors the prior-art repo's precedence.
 *   - `expirationTime`: ISO string OR ms timestamp number
 *   - `expiresIn`: seconds-from-now
 * Falls back to 75 minutes from now if neither is usable.
 */
function resolveExpiresAt(res: TradovateAuthResponse): number {
  if (res.expirationTime !== undefined) {
    if (typeof res.expirationTime === "number") {
      return res.expirationTime;
    }
    const parsed = Date.parse(res.expirationTime);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof res.expiresIn === "number" && Number.isFinite(res.expiresIn)) {
    return Date.now() + res.expiresIn * 1000;
  }
  return Date.now() + FALLBACK_EXPIRY_MS;
}
