import { randomUUID } from "node:crypto";
import type {
  BrokerCapabilities,
  BrokerPlugin,
  CredentialField,
  BrokerErrorKind,
} from "@/lib/brokers/plugin";
import type { Account, Contract, Order, Position, TradeFill, PlaceOrderRequest, PlaceOrderResponse } from "@/lib/brokers/types";
import { TradovateClient, readTradovateCredentialsFromDb, type TradovateCredentialBundle } from "@/lib/brokers/tradovate/client";
import type { TradovateRealtimeAdapter } from "@/lib/brokers/tradovate/realtime-adapter";
import {
  getTradovateApiCid,
  getTradovateApiSecret,
  getTradovateAppId,
  getTradovateAppVersion,
  getTradovateDeviceId,
  getTradovatePassword,
  getTradovateUsername,
  setTradovateApiCid,
  setTradovateApiSecret,
  setTradovateAppId,
  setTradovateAppVersion,
  setTradovateDeviceId,
  setTradovatePassword,
  setTradovateUsername,
} from "@/lib/db/settings";
import {
  TradovateAccountNotActiveError,
  TradovateAuthPenaltyError,
  TradovateCaptchaLockoutError,
  TradovateCircuitOpenError,
  TradovateOrderRejectionError,
  TradovateUnauthorizedError,
  TradovateUnsupportedOperationError,
  isAlreadyTerminalCancelRejection,
} from "@/lib/brokers/tradovate/errors";
import {
  computeTradovateCredsSignature,
  setTradovateCredsValidatedAt,
  setTradovateCredsValidatedSignature,
} from "@/lib/db/cred-validation";
import { BrokerRegistry as TradingBrokerRegistry } from "@/lib/trading/broker-access/broker-registry";
import { sendDiscordAlert } from "@/lib/notify/discord";
import { log } from "@/lib/logger";
import { runsEngine } from "@/lib/role";

// Suppression window for the engine-boot Tradovate auth alert. Matches
// the penalty handler's PRESSURE_ALERT_SUPPRESSION_MS so a reconnect
// storm doesn't spam Discord faster than the penalty layer would.
const AUTH_ALERT_SUPPRESSION_MS = 5 * 60 * 1000;

/** How much runway `initialize()` demands before it will skip a re-auth.
 *  Exported because `hasLiveToken()` has to answer on the *same* margin:
 *  any looser and a token `initialize()` just failed to refresh would
 *  still read as live for the width of the difference. */
export const TOKEN_FRESHNESS_MARGIN_MS = 60_000;

/**
 * Brief grace window before the engine drains its Layer 1 fill buffer on a
 * Tradovate position-close event, surfaced through
 * `capabilities.positionCloseGraceMs`. Tradovate's WS dispatcher
 * occasionally delivers the position-flat frame ~5ms BEFORE the
 * corresponding fill frame for the same close (transport ordering
 * inversion observed live on trade #30). Without a wait the buffer is
 * empty at drain time, the slot is discarded in `finally`, and the late
 * fill has no slot to land in — the trade ghost-clears with
 * `exit_price=null`. 200ms is ~40x the observed inversion (clock skew,
 * jitter, per-frame staging headroom) and well below the 30s reconciler
 * cadence so other code paths don't see it. It lived on the engine as a
 * module const until Phase E5; it is a property of this transport, not of
 * the exit path.
 */
export const TRADOVATE_POSITION_CLOSE_GRACE_MS = 200;

/** Wire shape returned by `TradovateBrokerPlugin.testConnection()`. The
 *  test-connection route casts the BrokerPlugin's `Promise<unknown>`
 *  back to this when assembling its success response. */
export interface TradovateTestConnectionResult {
  expiresAt: number;
  hasMdAccessToken: boolean;
}

export class TradovateBrokerPlugin implements BrokerPlugin {
  readonly id = "tradovate" as const;
  readonly displayName = "Tradovate";

  /**
   * Tradovate's answers to the engine's protocol questions. Each of these
   * was a `plugin.id === "tradovate"` branch before Phase E5.
   *
   * `fillCarriesPnl: false` is the Gate B probe finding — `fill` entities
   * never carry `pnl`, which is why the closing-fill discriminator is
   * orderId-against-bracket. `historicalFillsRequireOrderLookup: true`
   * because `/fill/list` is session-scoped and only `/fill/deps` reaches
   * back past a restart. `stopCoverageSource: "order-map"` because the
   * open-order list mis-counted bracketed positions as naked whenever the
   * contract-id cache was cold.
   */
  readonly capabilities: BrokerCapabilities = {
    fillCarriesPnl: false,
    historicalFillsRequireOrderLookup: true,
    bracketAttribution: "sync",
    bracketAnchor: "trigger",
    positionCloseGraceMs: TRADOVATE_POSITION_CLOSE_GRACE_MS,
    stopCoverageSource: "order-map",
    realtimeAccountScope: "registered",
    entryFillMayRacePlaceResponse: false,
    realtimeDrivesReconciliation: true,
    realtimeFeedOutlivesEngineStop: false,
    authFailureScope: "account",
  };

  /**
   * Account-event adapter over the per-account realtime WebSockets.
   * Attached by the engine — the adapter needs the contract resolver's
   * numeric→dated-symbol cache, which the plugin has no handle on.
   * Undefined until then.
   */
  realtime?: TradovateRealtimeAdapter;

  // Kept alive across auth failures *after* the first successful auth —
  // owns PenaltyResponseHandler state. Discarding this on every failed
  // authenticate() would reset the penalty buffer to zero, so a reconnect
  // storm would re-arm the pressure-alert path against an empty history
  // each iteration. Before the first successful auth, we DO null this
  // on failure so downstream callers (positions/route, boot-engine,
  // flatten-all, engine.ts) keep their `getClient() === null →
  // auto-pause` contract from before the plugin refactor.
  private _client: TradovateClient | null = null;
  // True after the first successful authenticate(). Gates the
  // preserve-on-failure behavior — see _client comment above.
  private _everAuthenticated = false;
  // Epoch-ms of the last Tradovate auth-failure Discord alert. Throttles
  // the alert so a reconnect storm or repeated boot retries fire at most
  // one alert per AUTH_ALERT_SUPPRESSION_MS window. Mirrors
  // PenaltyResponseHandler.lastPressureAlertAt — auth happens before any
  // request goes through the penalty pipeline so this layer can't see it.
  private lastTradovateAuthAlertAt = 0;
  // Why the last authenticate() failed. `initialize()` swallows the error
  // so a failed auth does not take its caller down, which leaves every
  // `getClient() === null` caller with nothing but "not configured" to
  // render — and a TradovateCaptchaLockoutError has a specific operator
  // recovery that a generic message loses.
  private _lastAuthError: string | null = null;
  // Set when `invalidate()` drops a live client for a credential change, and
  // cleared by the next success. Only this re-login keeps an unauthenticated
  // client through a network failure — see the catch in `initialize()`.
  private _reloginPending = false;
  // The `initialize()` in flight. Every `accessTokenRequest` opens one of the
  // user's two Tradovate sessions, and the freshness guard cannot see a login
  // still on the wire — a second caller then (a healthcheck's `getEngine()`
  // while the takeover's fan-out logs in) would open another.
  private _initializing: Promise<void> | null = null;

  isConfigured(): boolean {
    return !!getTradovateApiCid();
  }

  // Tradovate is *expected* if either creds are present OR a
  // Tradovate-broker deployment exists (operator opted in even though
  // creds aren't configured yet — the auth-failure alert path uses this
  // signal to decide whether silence is acceptable).
  isExpected(): boolean { return TradingBrokerRegistry.tradovateExpected(); }

  credentialSchema(): CredentialField[] {
    return [
      { key: "tradovateUsername", label: "Username", secret: false, required: true },
      { key: "tradovatePassword", label: "Password", secret: true, required: true },
      { key: "tradovateAppId", label: "App ID", secret: false, required: true },
      { key: "tradovateAppVersion", label: "App Version", secret: false, required: true },
      { key: "tradovateDeviceId", label: "Device ID", secret: false, required: false },
      // Non-secret: a client id is an identifier, not a credential. Marked
      // secret it rendered masked and seeded empty, so a missing cid looked
      // identical to a stored one — see ui-settings.md Decisions.
      { key: "tradovateApiCid", label: "API Client ID", secret: false, required: true },
      { key: "tradovateApiSecret", label: "API Secret", secret: true, required: true },
    ];
  }

  /** Single-flight: concurrent callers share one pass, and the slot clears when
   *  it settles, so a failed login does not latch. */
  initialize(): Promise<void> {
    if (this._initializing) return this._initializing;
    const flight = this.initializeOnce().finally(() => {
      if (this._initializing === flight) this._initializing = null;
    });
    this._initializing = flight;
    return flight;
  }

  private async initializeOnce(): Promise<void> {
    if (!this.isExpected()) return;
    const creds = readTradovateCredentialsFromDb();
    if (!creds) {
      // Drop a previously-configured client when creds disappear from
      // the DB and reset the alert throttle so a re-add gets a fresh
      // alert window. Clear the ever-authenticated flag so a fresh
      // re-add starts under first-failure-nulls semantics.
      this._client?.dispose();
      this._client = null;
      this._everAuthenticated = false;
      this.lastTradovateAuthAlertAt = 0;
      this._lastAuthError = null;
      this._reloginPending = false;
      return;
    }
    // Only a process that runs the engine renews ahead: a web process's
    // login is for the UI, and renewed it would hold one of the user's two
    // Tradovate sessions open for good instead of lapsing after the last hit.
    if (!this._client) this._client = new TradovateClient(undefined, null, { renewAhead: runsEngine() });
    // Idempotency guard: skip re-auth if the token is still fresh.
    // Lets boot-engine and engine-singleton both call initialize() freely
    // without coordination; only the first cold call pays the auth round-trip.
    if (this._everAuthenticated && this.hasLiveToken()) {
      return;
    }
    try {
      await this._client.authenticate();
      this._everAuthenticated = true;
      this._lastAuthError = null;
      this._reloginPending = false;
    } catch (err) {
      // After the first successful auth: do NOT null this._client. The
      // instance owns the PenaltyResponseHandler (penalty history +
      // circuit-breaker state); discarding it on every auth failure
      // would reset that history to zero, so a reconnect storm (e.g.
      // the user hub's 5-attempt loop after a 429) would create N fresh
      // clients, each with an empty penalty buffer, each firing the
      // pressure-alert path independently. The next caller re-runs
      // authenticate() against the same instance and the penalty
      // handler keeps its memory.
      //
      // Before the first successful auth: null the client so getClient()
      // returns null. Downstream callers (positions/route, boot-engine,
      // flatten-all, engine.ts) treat null as "Tradovate unavailable →
      // auto-pause"; preserving an unauthenticated client here would
      // silently break that contract.
      //
      // Except a re-login after a credential change that failed on the
      // network: nulling there drops every Tradovate account from the
      // routing map until the next save or restart, and open positions lose
      // their engine exits (bugs.md A76). Kept, the registry's arm throws
      // and carries its accounts forward, and the client re-authenticates
      // lazily on the next request — which is the retry. Any other kind
      // (bad credentials, p-time, captcha) still nulls: a wrong password
      // retried on every request walks into a captcha lockout. Boot's first
      // login is unchanged, so its auto-pause contract stands.
      const keepForRetry = this._reloginPending && this.classifyError(err) === "network";
      if (!this._everAuthenticated && !keepForRetry) {
        // A kept client may have authenticated lazily since; its renew-ahead
        // timer must not outlive it.
        this._client?.dispose();
        this._client = null;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this._lastAuthError = reason;
      log.event(
        "broker_auth_failed",
        "tradovate.plugin",
        `Tradovate authenticate() failed during initialize: ${reason}`,
      );
      // Reaching this catch means Tradovate is *expected* — creds present
      // or a Tradovate-broker deployment exists — because `initialize()`
      // returns at the top otherwise. So the failure is always worth an
      // operator alert. Throttled to AUTH_ALERT_SUPPRESSION_MS so a
      // reconnect storm doesn't spam the channel.
      const now = Date.now();
      if (now - this.lastTradovateAuthAlertAt >= AUTH_ALERT_SUPPRESSION_MS) {
        this.lastTradovateAuthAlertAt = now;
        await sendDiscordAlert({
          title: "Tradovate broker unavailable",
          color: 0xe67e22,
          fields: [
            {
              name: "Reason",
              value:
                "Tradovate auth failed at engine boot. Tradovate-broker " +
                "deployments will be auto-paused. Verify Tradovate " +
                "credentials in Settings.",
            },
            { name: "Error", value: reason.slice(0, 1000) },
          ],
        }).catch(() => {
          // best-effort
        });
      }
    }
  }

  invalidate(): void {
    // Drop the cached client + reset throttle so the next initialize()
    // re-authenticates with whatever creds are now in the DB. Reset the
    // ever-authenticated flag too so a fresh-creds first-failure nulls
    // the client per the auto-pause contract.
    this._reloginPending ||= this._client !== null;
    this._client?.dispose();
    this._client = null;
    this._everAuthenticated = false;
    // A login in flight is on the old credentials; the next caller starts its own.
    this._initializing = null;
    this.lastTradovateAuthAlertAt = 0;
    this._lastAuthError = null;
  }

  getClient(): TradovateClient | null {
    return this._client;
  }

  /**
   * Why the last `initialize()` could not authenticate — read this when
   * `getClient()` came back null, so the caller renders the reason instead
   * of "Tradovate is not configured". Null means no auth has failed since
   * the last success or credential change, which for a null client means
   * the credentials are genuinely absent.
   *
   * Only meaningful against a null client: after the first success
   * `initialize()` preserves `_client` through auth failures, so a non-null
   * client can sit alongside a stale reason here.
   */
  lastAuthError(): string | null {
    return this._lastAuthError;
  }

  /**
   * Is Tradovate authenticated *right now*.
   *
   * `getClient() !== null` does not answer this. After the first success
   * `initialize()` deliberately preserves `_client` through every auth
   * failure so the PenaltyResponseHandler keeps its circuit-breaker
   * history across a reconnect storm — so a non-null client means "this
   * process authenticated at some point", which is a different question.
   * `/api/auth` asked the null one and minted a 30-day session off dead
   * credentials; anything deciding "is this broker usable" asks this.
   */
  hasLiveToken(): boolean {
    if (!this._client) return false;
    return this._client.getTokenExpiresAt() > Date.now() + TOKEN_FRESHNESS_MARGIN_MS;
  }

  async getBrowserToken(): Promise<string | null> { return null; }

  /**
   * Persist Tradovate credential edits. Field keys match `credentialSchema()`.
   * Per the BrokerPlugin contract:
   *  - non-empty string = set/overwrite
   *  - `null` = explicitly clear (delete the row)
   *  - absent key = leave this field alone
   *
   * Wizard-shape input (all seven fields present, all non-empty strings)
   * works the same as before. Settings-page partial edits work field-by-
   * field. When `tradovateDeviceId` is absent (not in input map) AND no
   * existing deviceId is on disk, a fresh UUID is auto-generated and
   * persisted (parity with resolveTradovateAppIdentity()'s
   * persist-on-generate semantics — keeps `readTradovateCredentialsFromDb()`
   * consistent across the wizard and per-field edit paths).
   *
   * The route-side `tradovate_device_id_user_set` flag (which drives the
   * AUTO badge in the UI) stays under the route's ownership — this plugin
   * doesn't touch it. The signature recompute, webhook URL, and engine
   * hot-reload likewise stay route-owned.
   *
   * Always calls `this.invalidate()` so the next initialize() reauths
   * against the new creds. The penalty / circuit-breaker history is
   * intentionally reset here (creds rotation = new auth identity, prior
   * penalty memory no longer relevant).
   */
  async applyCredentials(fields: Record<string, string | null>): Promise<void> {
    const setters: Array<[string, (v: string | null) => void]> = [
      ["tradovateUsername", setTradovateUsername],
      ["tradovatePassword", setTradovatePassword],
      ["tradovateApiCid", setTradovateApiCid],
      ["tradovateApiSecret", setTradovateApiSecret],
      ["tradovateAppId", setTradovateAppId],
      ["tradovateAppVersion", setTradovateAppVersion],
    ];
    for (const [key, setter] of setters) {
      if (!(key in fields)) continue;
      const v = fields[key];
      if (v === null) {
        setter(null);
      } else if (typeof v === "string" && v.length > 0) {
        setter(v);
      }
      // Empty string isn't possible per the route's normalization, but
      // guard by ignoring it here too — leaves the field alone.
    }
    if ("tradovateDeviceId" in fields) {
      const submitted = fields.tradovateDeviceId;
      if (submitted === null) {
        setTradovateDeviceId(null);
      } else if (typeof submitted === "string" && submitted.length > 0) {
        setTradovateDeviceId(submitted);
      }
    } else {
      // Wizard / first-touch path: ensure a deviceId exists on disk so
      // readTradovateCredentialsFromDb() returns a complete bundle.
      const existing = getTradovateDeviceId();
      if (!existing || existing.length === 0) {
        setTradovateDeviceId(randomUUID());
      }
    }
    this.invalidate();
  }

  /**
   * Authenticate against the Tradovate gateway. With `overrideFields`,
   * tests the supplied seven-field bundle without touching DB state
   * (wizard / unsaved-form flow). With no overrides, reads the stored
   * cred bundle (Settings post-Save flow).
   *
   * On success: persists the cred-validation signature + `_validated_at`
   * timestamp so a subsequent Save can commit these creds. Returns
   * `{ expiresAt, hasMdAccessToken }` for the test-connection route's
   * response shape. Throws on any failure — caller is responsible for
   * `classifyError()`.
   */
  async testConnection(overrideFields?: Record<string, string>): Promise<TradovateTestConnectionResult> {
    let creds: TradovateCredentialBundle;
    if (overrideFields) {
      creds = bundleFromOverride(overrideFields);
    } else {
      const dbCreds = readTradovateCredentialsFromDb();
      if (!dbCreds) {
        throw new Error("Tradovate credentials not configured");
      }
      creds = dbCreds;
    }
    const client = overrideFields
      ? new TradovateClient(undefined, creds)
      : new TradovateClient();
    try {
      await client.authenticate();
    } finally {
      // A throwaway login: it must not keep renewing after this answer.
      client.dispose();
    }
    const signature = computeTradovateCredsSignature(creds);
    setTradovateCredsValidatedSignature(signature);
    setTradovateCredsValidatedAt(new Date().toISOString());
    return {
      expiresAt: client.getTokenExpiresAt(),
      hasMdAccessToken: client.getMdAccessToken() !== null,
    };
  }

  /** `instanceof` over Tradovate's own error classes. See
   *  `BrokerPlugin.ownsError` for why `classifyError` cannot answer this. */
  ownsError(err: unknown): boolean {
    return (
      err instanceof TradovateAuthPenaltyError ||
      err instanceof TradovateCaptchaLockoutError ||
      err instanceof TradovateCircuitOpenError ||
      err instanceof TradovateUnauthorizedError ||
      err instanceof TradovateAccountNotActiveError ||
      err instanceof TradovateOrderRejectionError ||
      err instanceof TradovateUnsupportedOperationError
    );
  }

  /** Delegates to the shipped predicate rather than restating it — a second
   *  copy of a fail-safe rule is a second thing to get wrong. See
   *  `BrokerPlugin.rejectionProvesTerminal`. */
  readonly rejectionProvesTerminal = (err: unknown): boolean =>
    isAlreadyTerminalCancelRejection(err);

  /**
   * Map a thrown error from `testConnection()` (or any other broker call)
   * to the cross-broker BrokerErrorKind taxonomy. Tradovate's auth path
   * carries the full set of kinds — `rate_limited` / `captcha` /
   * `circuit_open` are Tradovate-specific bands the penalty handler
   * raises before the request reaches the gateway.
   *
   * `TradovateOrderRejectionError` splits, and the split is load-bearing:
   * `AccountNotActive` is the same condition as the typed
   * `TradovateAccountNotActiveError` and orphan-pauses the account, while
   * every other `failureReason` — RiskExceeded, MarketClosed,
   * InvalidPrice — is a one-off refusal that must not. Without the
   * explicit arm both fall through to the `auth` catch-all, and the
   * engine orphan-pauses a deployment for hitting a risk limit.
   */
  classifyError(err: unknown): BrokerErrorKind {
    if (err instanceof TradovateAuthPenaltyError) return "rate_limited";
    if (err instanceof TradovateCaptchaLockoutError) return "captcha";
    if (err instanceof TradovateCircuitOpenError) return "circuit_open";
    if (err instanceof TradovateUnauthorizedError) return "auth";
    if (err instanceof TradovateAccountNotActiveError) return "account_unavailable";
    // The credentials are fine; this venue cannot answer the question.
    // No orphan-pause reason is mapped to `entitlement`, which is the
    // point — a refused member must not pause an account.
    if (err instanceof TradovateUnsupportedOperationError) return "entitlement";
    if (err instanceof TradovateOrderRejectionError) {
      return err.failureReason === "AccountNotActive"
        ? "account_unavailable"
        : "order_rejected";
    }
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    if (
      lowered.includes("not configured") ||
      lowered.includes("required")
    ) {
      return "config_missing";
    }
    if (
      lowered.includes("fetch failed") ||
      lowered.includes("timeout") ||
      lowered.includes("aborted") ||
      /\b5\d\d\b/.test(message)
    ) {
      return "network";
    }
    return "auth";
  }

  /**
   * Compute the cred-validation signature for a candidate field set
   * without persisting anything. Used by Save handlers to verify the
   * operator clicked Test Connection against these exact values. Not on
   * the BrokerPlugin interface — only routes that own the gate-save
   * pre-write check call this.
   */
  computeCredsSignature(fields: Record<string, string>): string {
    return computeTradovateCredsSignature(bundleFromOverride(fields));
  }

  // ── Broker execution methods — stubbed ───────────────────────────────────
  async searchAccounts(): Promise<Account[]> { throw new Error("not yet implemented"); }
  async searchOpenOrders(_accountId: number): Promise<Order[]> { throw new Error("not yet implemented"); }
  async searchOpenPositions(_accountId: number): Promise<Position[]> { throw new Error("not yet implemented"); }
  async searchTrades(_accountId: number, _start: string, _end?: string): Promise<TradeFill[]> { throw new Error("not yet implemented"); }
  async getFillsForOrder(_orderId: number, _accountId: number): Promise<TradeFill[]> { throw new Error("not yet implemented"); }
  async searchContracts(_searchText: string, _live?: boolean): Promise<Contract[]> { throw new Error("not yet implemented"); }
  async placeOrder(_order: PlaceOrderRequest): Promise<PlaceOrderResponse> { throw new Error("not yet implemented"); }
  async cancelOrder(_orderId: number, _accountId: number): Promise<void> { throw new Error("not yet implemented"); }
  async modifyOrder(_accountId: number, _orderId: number, _updates: { size?: number; limitPrice?: number; stopPrice?: number; trailPrice?: number }): Promise<void> { throw new Error("not yet implemented"); }
  invalidateOpenOrders(_accountId: number): void { throw new Error("not yet implemented"); }
}

/** Strict-shape extractor for the seven cred fields out of a flat field
 *  map. Throws when any field is absent or empty so the override path
 *  fails loud rather than auth'ing against a partially-populated body. */
function bundleFromOverride(fields: Record<string, string>): TradovateCredentialBundle {
  const map: Array<[string, keyof TradovateCredentialBundle]> = [
    ["tradovateUsername", "username"],
    ["tradovatePassword", "password"],
    ["tradovateApiCid", "apiCid"],
    ["tradovateApiSecret", "apiSecret"],
    ["tradovateAppId", "appId"],
    ["tradovateAppVersion", "appVersion"],
    ["tradovateDeviceId", "deviceId"],
  ];
  const out: Partial<TradovateCredentialBundle> = {};
  for (const [src, dest] of map) {
    const v = fields[src];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${src} required`);
    }
    out[dest] = v;
  }
  return out as TradovateCredentialBundle;
}
