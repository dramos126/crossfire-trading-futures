import type { Account, Order, Position } from "@/lib/brokers/types";
import type { WireLogRecord } from "@/lib/logging/pipe";
import type { EngineLog, TradingEngine } from "@/lib/trading/engine/engine";
import type { getBootAssertionState } from "@/lib/trading/engine/boot/boot-assertion";
import type { AccountViewSource } from "@/lib/trading/engine/realtime/account-view";
import type { OrphanPassRefresh } from "@/lib/trading/engine/realtime/orphan-attribution";
import type { BroadcastEvent } from "@/lib/realtime/event-broadcaster";
import type { Deployment } from "@/lib/trading/domain";
import type { OpenPosition } from "@/lib/trading/strategy-types";

/**
 * The one door from a route to the engine and the process-wide state beside
 * it — the engine, the broadcaster, the account view, the boot assertion, the
 * staging allowlist and the log rings. A route reaches those only through an
 * `EngineHandle`, never through their modules directly.
 *
 * It exists for the web/engine split (docs/proposals/zero-downtime-deploys.md,
 * step 2): a web process will run with no engine and reach a separate engine
 * process over HTTP, so every reach is one interface with two
 * implementations. Only the in-process one exists so far
 * (`handle/local.ts`).
 *
 * **Every method is async and every argument and result is plain data**, so
 * the remote implementation can carry the same calls without a route
 * changing again. The one exception is the SSE listener `subscribeEvents`
 * takes and the unsubscribe it returns: both stay in the calling process on
 * either side. No method hands out the engine, the broadcaster, a broker
 * client or a live engine object.
 *
 * **Build or peek is a property of each method**, stated on it: a *build*
 * method constructs the engine when none exists (the singleton's
 * `getEngine()`); a *peek* method never does, and resolves to `null` or does
 * nothing when no engine was built. A route that peeked must keep peeking — a
 * settings save or a login would otherwise construct an engine and its hubs.
 */

/** What `/api/engine {action:"status"}` answers, read off the engine in one pass. */
export interface EngineStatus {
  running: boolean;
  marketHub: ReturnType<TradingEngine["getMarketHubStatus"]>;
  health: ReturnType<TradingEngine["getSeamHealth"]>;
  setups: ReturnType<TradingEngine["getSetupReadings"]>;
}

/** The one reading of `EngineStatus` — the status route's and the pushed
 *  `engineStatus` frame's, so the two cannot disagree on a field. */
export function engineStatusOf(
  engine: Pick<TradingEngine, "isRunning" | "getMarketHubStatus" | "getSeamHealth" | "getSetupReadings">,
): EngineStatus {
  return {
    running: engine.isRunning(),
    marketHub: engine.getMarketHubStatus(),
    health: engine.getSeamHealth(),
    setups: engine.getSetupReadings(),
  };
}

/** A copy of the engine's in-memory mirror of one leg's position — what
 *  `legHasOpenPositionWithFallback` reads. Never the engine's own object. */
export interface LegPositionView {
  position: OpenPosition | null;
}

/** One account-view read, or the fact that Topstep is not configured and the
 *  view had nothing fresh to answer with. */
export type AccountViewAnswer<T> =
  | { kind: "slice"; items: readonly T[]; asOf: number; source: AccountViewSource }
  | { kind: "topstep-not-configured" };

/** A strategy trade closed on a deployment — the `strategyTrade` frame. */
export interface ClosedStrategyTrade {
  accountId: number;
  deploymentId: string;
}

export type ManualPositionClaimInput = Parameters<TradingEngine["previewManualPositionClaim"]>[0];
export type ManualPositionClaimPreview = Awaited<ReturnType<TradingEngine["previewManualPositionClaim"]>>;
export type ForceFlatResult = Awaited<ReturnType<TradingEngine["forceFlatDeployment"]>>;
export type AccountStatusCheckResult = Awaited<ReturnType<TradingEngine["checkAccountStatuses"]>>;
/** What a route reads of a registry refresh — the orphan pass's input. */
export type RegistryRefresh = OrphanPassRefresh;
export type ReconnectResult = Awaited<ReturnType<TradingEngine["reconnectMarketHubManually"]>>;

export interface EngineHandle {
  // ── The engine, built ────────────────────────────────────────────────

  /** Build. Constructs the engine if none exists and nothing else. */
  ensureEngine(): Promise<void>;
  /** Build. */
  start(deployments: Deployment[]): Promise<void>;
  /** Build. */
  stop(): Promise<void>;
  /** Build. Applies this list as the engine's deployment set. */
  sync(deployments: Deployment[]): Promise<void>;
  /** Build. */
  isRunning(): Promise<boolean>;
  /** Build. */
  status(): Promise<EngineStatus>;
  /** Build. Mints a fresh Topstep session for the market hub. */
  reconnectMarketHub(): Promise<ReconnectResult>;
  /** Build. */
  checkAccountStatuses(): Promise<AccountStatusCheckResult>;
  /** Build. The refresh's arm answers, without its balance map. */
  refreshBrokerRegistry(): Promise<RegistryRefresh>;
  /** Build. Which of these accounts the engine's broker registry holds now. */
  registeredAccountIds(accountIds: number[]): Promise<number[]>;
  /** Build. */
  handleOrphanedAccount(accountId: number, reason: string): Promise<void>;

  // ── The engine, peeked ───────────────────────────────────────────────

  /** Peek. Re-reads `listManagedDeployments()` and syncs the engine to it;
   *  reads nothing when no engine was built. */
  syncIfRunning(): Promise<void>;
  /** Peek. */
  stopIfRunning(): Promise<void>;
  /** Peek. Starts the closing guard's pass now; does not wait for it. */
  nudgeClosingGuard(): Promise<void>;
  /** Peek. Null when no engine was built or it holds no state for the leg. */
  peekLegPosition(deploymentId: string): Promise<LegPositionView | null>;
  /** Peek. Null when no engine was built — nothing was attempted. */
  forceFlatDeployment(deploymentId: string): Promise<ForceFlatResult | null>;
  /** Peek. Null when no engine was built. */
  exitsInFlightForAccount(accountId: number): Promise<string[] | null>;
  /** Peek. Null when no engine was built. */
  previewManualPositionClaim(input: ManualPositionClaimInput): Promise<ManualPositionClaimPreview | null>;
  /** Peek. Null when no engine was built. */
  engineSessionId(): Promise<string | null>;
  /** Peek. Null when no engine was built or it cannot tell. */
  marketDataContractId(contractId: string): Promise<string | null>;
  /** Peek. Null when no engine was built. */
  areHubsReady(): Promise<boolean | null>;
  /** Peek. Rejects with the reload's own failure. */
  reloadTradovateClients(): Promise<void>;
  /** Peek. */
  invalidateAccountNames(): Promise<void>;

  // ── Process-wide state ───────────────────────────────────────────────

  /** Runs the boot sequence, which builds and starts the engine. */
  activateFromSettings(): Promise<void>;
  /** The Topstep account roster through the engine's client; empty when
   *  Topstep is not configured, rejects when Topstep throws. Builds no engine. */
  listTopstepAccounts(): Promise<Account[]>;
  getLogsByLevel(limit: number): Promise<Record<EngineLog["level"], WireLogRecord[]>>;
  clearAllLogs(): Promise<void>;
  getBootAssertionState(): Promise<ReturnType<typeof getBootAssertionState>>;
  getBootAssertionFailureReason(): Promise<string | null>;
  /** Null when no allowlist applies (prod). */
  getStagingAllowlist(): Promise<number[] | null>;

  // ── The broadcaster ──────────────────────────────────────────────────

  /** Peek. Emits on the broadcaster if one was built. */
  emitDeploymentsChanged(): Promise<void>;
  /** Peek. One peek for the whole list; emits nothing when none was built. */
  emitStrategyTradeClosedIfRunning(trades: ClosedStrategyTrade[]): Promise<void>;
  /**
   * Build: the engine, then the broadcaster over its realtime transports.
   * Null when the engine has no transport to relay from — the answer the
   * stream and subscriptions routes 503 on; the build error is the rejection.
   * The three below build the same way and do nothing on a null relay.
   */
  getConnectedState(): Promise<boolean | null>;
  /** Build. The listener and the returned unsubscribe stay in this process. */
  subscribeEvents(key: string, listener: (event: BroadcastEvent) => void): Promise<() => void>;
  /** Build. */
  ensureRunning(accountIds: number[], contractIds: string[]): Promise<void>;
  /** Build. */
  retainContractTrades(contractIds: string[]): Promise<void>;

  // ── The account view ─────────────────────────────────────────────────

  /** Builds no engine: the view, or one shared live Topstep read. */
  readPositions(accountId: number): Promise<AccountViewAnswer<Position>>;
  /** Builds no engine: the view, or one shared live Topstep read. */
  readOrders(accountId: number): Promise<AccountViewAnswer<Order>>;
  /** Peek. Tradovate numeric ids → dated symbols, in order; null until the
   *  engine has constructed the Tradovate realtime adapter. */
  resolveDatedSymbols(contractIds: string[]): Promise<string[] | null>;
}
