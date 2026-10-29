import type {
  BrokerCapabilities,
  BrokerPlugin,
  CredentialField,
  BrokerErrorKind,
} from "@/lib/brokers/plugin";
import type { Account, Contract, Order, Position, TradeFill, PlaceOrderRequest, PlaceOrderResponse } from "@/lib/brokers/types";
import { resolveTopstepUsername, resolveTopstepApiKey, invalidateSettingsCache } from "@/lib/db/settings-cache";
import {
  AccountNotFoundError,
  TopstepClient,
  TopstepOrderRejectionError,
  UnauthorizedError,
  topstepSessionState,
} from "@/lib/brokers/topstep/client";
import type { TopstepRealtimeAdapter } from "@/lib/brokers/topstep/realtime-adapter";
import { getEngineToken, getToken } from "@/lib/brokers/topstep/auth";
import {
  getTopstepApiKey,
  getTopstepUsername,
  setTopstepApiKey,
  setTopstepUsername,
} from "@/lib/db/settings";
import { clearCachedToken } from "@/lib/db/auth";
import {
  computeTopstepCredsSignature,
  setTopstepCredsValidatedAt,
  setTopstepCredsValidatedSignature,
} from "@/lib/db/cred-validation";

export class TopstepBrokerPlugin implements BrokerPlugin {
  readonly id = "topstep" as const;
  readonly displayName = "Topstep";

  /**
   * Topstep's answers to the engine's protocol questions. Each of these
   * was a `plugin.id === "tradovate"` branch before Phase E5.
   *
   * `positionCloseGraceMs: 0` is load-bearing: the gateway books the
   * position-flat event and the trade event in order, and an
   * unconditional yield on the close path would be a behaviour change,
   * not a no-op. `realtimeFeedOutlivesEngineStop: true` because the user
   * hub is process-wide and the browser's SSE relay pins it up across an
   * engine stop.
   */
  readonly capabilities: BrokerCapabilities = {
    fillCarriesPnl: true,
    historicalFillsRequireOrderLookup: false,
    bracketAttribution: "reconciler",
    bracketAnchor: "fill",
    positionCloseGraceMs: 0,
    stopCoverageSource: "open-orders",
    realtimeAccountScope: "traded",
    entryFillMayRacePlaceResponse: true,
    realtimeDrivesReconciliation: false,
    realtimeFeedOutlivesEngineStop: true,
    authFailureScope: "engine",
  };

  /**
   * Account-event adapter over the user hub. Attached by the engine —
   * the hub lives on the process-wide `TopstepSignalR` the engine
   * singleton constructs, which the plugin has no handle on. Undefined
   * when Topstep is unconfigured or realtime bars are off, exactly like
   * the hubs themselves.
   */
  realtime?: TopstepRealtimeAdapter;

  // Single TopstepClient instance per process. Re-used across boot retries
  // so per-request token refresh in engine-singleton can swap the token
  // without rebuilding the client (and its in-memory caches).
  private _client: TopstepClient | null = null;

  isConfigured(): boolean {
    return !!(resolveTopstepUsername() && resolveTopstepApiKey());
  }

  // Credential presence, mirroring Tradovate's predicate. It used to be a
  // hardcoded `true` on the reasoning that Topstep is *the* broker — which
  // stopped being true when a Tradovate-only install became a supported
  // shape, and left an unconfigured Topstep declaring itself expected.
  //
  // Nothing regresses for a Topstep install: `initialize()` already
  // returned early on `!isConfigured()`, so the only behaviour this gates
  // was a no-op. The wizard still lights up the engine on first save,
  // because that path calls `activateFromSettings()` after the credentials
  // are written, at which point this is true.
  isExpected(): boolean { return this.isConfigured(); }

  credentialSchema(): CredentialField[] {
    return [
      { key: "topstepUsername", label: "Username", secret: false, required: true, envFallback: "TOPSTEP_USERNAME" },
      { key: "topstepApiKey", label: "API Key", secret: true, required: true, envFallback: "TOPSTEP_API_KEY" },
    ];
  }

  async initialize(): Promise<void> {
    if (!this.isExpected()) return;
    if (!this.isConfigured()) return;
    if (!this._client) this._client = new TopstepClient();
    const token = await getEngineToken();
    this._client.setToken(token);
  }

  invalidate(): void {
    this._client?.setToken("");
  }

  getClient(): TopstepClient | null {
    return this._client;
  }

  async getBrowserToken(): Promise<string | null> {
    if (!this.isConfigured()) return null;
    return getToken();
  }

  /**
   * Persist Topstep credential edits. Field keys match `credentialSchema()`
   * (`topstepUsername`, `topstepApiKey`). Per the BrokerPlugin contract:
   *  - non-empty string = set/overwrite
   *  - `null` = explicitly clear (delete the row)
   *  - absent key = leave this field alone (route normalizes the masked-
   *    form tri-state before dispatch — empty string never reaches here)
   *
   * Side-effects: invalidates the settings cache, clears the cached
   * Topstep token (so next request cold-mints under the new creds), and
   * drops the cached engine-side broker token. The cred-validation
   * signature is NOT re-stamped here — that happens in `testConnection()`.
   *
   * The webhook URL and engine.invalidateAccountNames() bookkeeping live
   * outside the plugin — they're route-owned concerns (notification
   * settings + per-engine cache) that don't belong on the broker plugin
   * boundary.
   */
  async applyCredentials(fields: Record<string, string | null>): Promise<void> {
    const prevUsername = getTopstepUsername();
    const prevApiKey = getTopstepApiKey();
    let usernameChanged = false;
    let apiKeyChanged = false;
    if ("topstepUsername" in fields) {
      const next = fields.topstepUsername;
      if (next === null) {
        if (prevUsername !== null) {
          setTopstepUsername(null);
          usernameChanged = true;
        }
      } else if (typeof next === "string" && next.length > 0 && next !== prevUsername) {
        setTopstepUsername(next);
        usernameChanged = true;
      }
    }
    if ("topstepApiKey" in fields) {
      const next = fields.topstepApiKey;
      if (next === null) {
        if (prevApiKey !== null) {
          setTopstepApiKey(null);
          apiKeyChanged = true;
        }
      } else if (typeof next === "string" && next.length > 0 && next !== prevApiKey) {
        setTopstepApiKey(next);
        apiKeyChanged = true;
      }
    }
    // Cache before token (load-bearing — see PUT route §8 race notes).
    if (usernameChanged) invalidateSettingsCache("topstep_username");
    if (apiKeyChanged) invalidateSettingsCache("topstep_api_key");
    if (usernameChanged || apiKeyChanged) {
      clearCachedToken();
      this.invalidate();
    }
  }

  /**
   * Mint a fresh Topstep token to verify credentials. With `overrideFields`,
   * tests the supplied values without touching DB state (wizard flow). With
   * no overrides, reads stored DB creds (Settings flow).
   *
   * On success: persists the cred-validation signature + `_validated_at`
   * timestamp so a subsequent Save is allowed to commit these creds.
   * Throws on any failure — caller is responsible for `classifyError()`.
   */
  async testConnection(overrideFields?: Record<string, string>): Promise<unknown> {
    let username: string;
    let apiKey: string;
    if (overrideFields) {
      const u = overrideFields.topstepUsername;
      const k = overrideFields.topstepApiKey;
      if (typeof u !== "string" || u.length === 0) {
        throw new Error("topstepUsername required");
      }
      if (typeof k !== "string" || k.length === 0) {
        throw new Error("topstepApiKey required");
      }
      username = u;
      apiKey = k;
    } else {
      const dbUsername = getTopstepUsername();
      const dbApiKey = getTopstepApiKey();
      if (!dbUsername || !dbApiKey) {
        throw new Error("Topstep credentials not configured");
      }
      username = dbUsername;
      apiKey = dbApiKey;
    }
    const client = new TopstepClient();
    await client.authenticate({ userName: username, apiKey });
    // This login bypasses getToken(), so it retires the failed-mint backoff
    // itself — otherwise Settings says OK while every route rethrows the
    // stored failure for the rest of the window.
    topstepSessionState().lastFailedMint = null;
    const signature = computeTopstepCredsSignature({ username, apiKey });
    setTopstepCredsValidatedSignature(signature);
    setTopstepCredsValidatedAt(new Date().toISOString());
    return undefined;
  }

  /** `instanceof` over Topstep's own error classes. See
   *  `BrokerPlugin.ownsError` for why `classifyError` cannot answer this. */
  ownsError(err: unknown): boolean {
    return (
      err instanceof UnauthorizedError ||
      err instanceof AccountNotFoundError ||
      err instanceof TopstepOrderRejectionError
    );
  }

  /**
   * Map a thrown error from `testConnection()` (or any other broker call)
   * to the cross-broker BrokerErrorKind taxonomy. Topstep's `/Auth/loginKey`
   * doesn't carry the rate-limit / captcha / circuit shapes Tradovate
   * does — `auth` / `network` / `config_missing` are the buckets the
   * credential probe puts in play.
   *
   * The typed classes are matched first, ahead of the message
   * heuristics: `AccountNotFoundError` is the engine's orphan-pause
   * signal and must never fall through to the `auth` catch-all, which
   * would stop the engine on a single dead account — nor may a place
   * refusal, whose gateway text can read like a credential problem.
   */
  classifyError(err: unknown): BrokerErrorKind {
    if (err instanceof AccountNotFoundError) return "account_unavailable";
    if (err instanceof TopstepOrderRejectionError) return "order_rejected";
    if (err instanceof UnauthorizedError) return "auth";
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    if (
      lowered.includes("not configured") ||
      lowered.includes("required") ||
      lowered.includes("missing topstep_username") ||
      lowered.includes("missing topstep_api_key")
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
   * the BrokerPlugin interface — only the routes that own the gate-save
   * pre-write check call this.
   */
  computeCredsSignature(fields: Record<string, string>): string {
    const username = fields.topstepUsername;
    const apiKey = fields.topstepApiKey;
    if (typeof username !== "string" || typeof apiKey !== "string") {
      throw new Error("topstepUsername and topstepApiKey required");
    }
    return computeTopstepCredsSignature({ username, apiKey });
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
