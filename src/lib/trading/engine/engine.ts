// Type-only on both clients, and no broker error class is named here at
// all: control flow goes through `plugin.ownsError` + `classifyError`
// (Phase E5). Re-importing a concrete error class to "just check one
// case" re-couples the engine to a broker's internals — the plugin owns
// its classes, and the taxonomy is how it reports them.
import type { TopstepClient } from "@/lib/brokers/topstep/client";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import { TradovateRealtimeAdapter } from "@/lib/brokers/tradovate/realtime-adapter";
import type { TopstepSignalR, GatewayTrade } from "@/lib/brokers/topstep/signalr";
import { TopstepRealtimeAdapter } from "@/lib/brokers/topstep/realtime-adapter";
import { SignalRUserHubTransport } from "@/lib/brokers/topstep/user-hub";
import { validateOrRefreshToken } from "@/lib/brokers/topstep/auth";
import { readTopstepTradingAccounts } from "@/lib/brokers/topstep/trading-account";
import {
  brokerErrorAccountId,
  type BrokerErrorKind,
  type BrokerRealtimeAdapter,
} from "@/lib/brokers/plugin";
import type { BroadcasterDeps } from "@/lib/realtime/event-broadcaster";
import { TIMEFRAME_TO_MS, type BarAggregator } from "../bar-aggregator";
import {
  clampFetchDepth,
  computeFetchDepth,
  describeFetchDepthCeiling,
  fetchDepthOverCeiling,
  fetchBars as fetchBarsImpl,
  resetBarFetchCache,
  resolveExitFillPrice as resolveExitFillPriceImpl,
  runSnapshotQueue,
  snapshotTradeBars as snapshotTradeBarsImpl,
  type SnapshotOutcome,
} from "./realtime/engine-bar-fetch";
import { isClosingFill as isClosingFillImpl } from "./engine-fill";
import { MarketHubController, type MarketHubStatus } from "./engine-market-hub";
import {
  resolveExitReason as resolveExitReasonImpl,
  notifyEntry as notifyEntryImpl,
  notifyExit as notifyExitImpl,
  notifyForceClose as notifyForceCloseImpl,
  notifyRegimeLabels,
  type NotifyDeps,
} from "./engine-notify";
import type { ResolvedExitReason } from "@/lib/logging/exit-reasons";
import {
  placeEntryOrder as placeEntryOrderImpl,
  type EntryRiskFacts,
  type PlacedEntry,
} from "./engine-order";
import {
  appendBufferedFill as appendBufferedFillImpl,
  handleTrade as handleTradeImpl,
  handleUserPositionClose as handleUserPositionCloseImpl,
  handleUserPositionEvent as handleUserPositionEventImpl,
  replayTopstepFillsAfterReconnect as replayTopstepFillsAfterReconnectImpl,
  replayTradovateFillsAfterReconnect as replayTradovateFillsAfterReconnectImpl,
  wireRealtimeAdapters as wireRealtimeAdaptersImpl,
  type RealtimeDeps,
} from "./realtime/engine-realtime";
import {
  healApproximatedExitFromFills as healApproximatedExitFromFillsImpl,
  PassPositionReads,
  reconcileExitFromBuffer as reconcileExitFromBufferImpl,
  reconcileGhostPositions as reconcileGhostPositionsImpl,
  reconcileOneTrade as reconcileOneTradeImpl,
  reconcilePendingTrades as reconcilePendingTradesImpl,
  resolveExitFromFills as resolveExitFromFillsImpl,
  validateClosedTradePrices as validateClosedTradePricesImpl,
  type ReconcileDeps,
  type ReconcilePosition,
} from "./realtime/engine-reconcile";
import {
  NakedPositionWatchdog,
  NAKED_POSITION_WATCHDOG_INTERVAL_MS,
} from "./flatten/engine-watchdog";
import {
  SessionEndGuard,
  SESSION_END_GUARD_INTERVAL_MS,
} from "./session-close/engine-session-guard";
import {
  ClosingGuard,
  CLOSING_GUARD_INTERVAL_MS,
} from "./session-close/engine-closing";
import {
  RegimeLabelController,
  REGIME_NIGHTLY_INTERVAL_MS,
} from "./engine-regime";
import {
  SessionCloseSampler,
  SESSION_CLOSE_SAMPLER_INTERVAL_MS,
} from "./session-close/engine-session-close";
import {
  AccountStatusJob,
  ACCOUNT_STATUS_JOB_INTERVAL_MS,
  ACCOUNT_STATUS_EVENING_INTERVAL_MS,
  registryStatusFanOut,
  type AccountStatusCheckResult,
} from "./engine-account-status";
import { orphanAbsentAccounts } from "./realtime/orphan-attribution";
// The **only** archive reader under `engine/`, bound in one place so the
// exception is visible. It goes to the Parquet cache directly rather than
// through the registry: a slot is operator-settable and the label's whole
// requirement is that it reads what the CLI reads. Everything on the tick
// path reads `realtime()` through `engine-bar-fetch.ts`, unchanged.
import { fetchArchiveBars } from "@/lib/data/cached-bars";
import { sessionDateOf } from "../regime/session-dates";
import {
  ManualPositionGuard,
  MANUAL_POSITION_GUARD_INTERVAL_MS,
  type ManualPositionClaimPreview,
} from "./flatten/engine-manual-position";
import {
  RestartFlattenGuard,
  RESTART_FLATTEN_INTERVAL_MS,
  formatGapDuration,
  readOwedFlatten,
  type RestartVerdict,
} from "./boot/engine-restart";
import { FlattenCooldown } from "./engine-flatten-cooldown";
import { SetupReadings } from "./engine-setup-status";
import { AccountEntryGate } from "./engine-account-entry-gate";
import {
  EngineHealth,
  anyDeploymentInSession,
  type SeamHealthSnapshot,
} from "./engine-health";
import {
  cancelTrackedBrackets as cancelTrackedBracketsImpl,
  forceCloseAfterBracketFailure as forceCloseAfterBracketFailureImpl,
  noteExitLatchHeldPastWindow,
  placeExitOrder as placeExitOrderImpl,
  verifyExitClean as verifyExitCleanImpl,
  type ExitIntent,
  type ExitOrderDeps,
} from "./engine-exit";
import {
  forceFlatDeployment as forceFlatDeploymentImpl,
  type ForceFlatDeps,
  type ForceFlatResult,
} from "./flatten/engine-force-flat";
import {
  BrokerAwareContractResolver,
  executionContractId,
  stripTradovateContinuousSuffix,
  tickerSymbolForContractId,
  TICKER_CONTRACT_MAP,
} from "../broker-access/contract-resolver";
import { productRootFromContractId, sameContractMonth } from "../broker-access/contract-pairing";
import { daySessionForTicker } from "../contracts/contract-specs";
import {
  BrokerRegistry,
  TradovateAlertEpisode,
  notifyRefreshFailures,
  type RefreshResult,
} from "../broker-access/broker-registry";
import { BrokerRegistry as BrokerPluginRegistry } from "@/lib/brokers/registry";
import type { BrokerPlugin } from "@/lib/brokers/plugin";
import { brokerRegistry as defaultBrokerPluginRegistry } from "@/lib/brokers/registry-singleton";
import { BrokerKind, getAccountBrokerOrNull, listAccountIdsForBroker } from "@/lib/db/account-brokers";
import { EntryExitCode } from "../orders/entry-exit-codes";
import { pnlTicksFromPrices, priceFromTicks } from "../orders/pnl-math";
import type { Broker } from "../broker-access/broker";
import { log } from "@/lib/logger";
import { isShutdownDraining } from "@/lib/shutdown-drain";
import { holdsLease, leaseGate, reportLeaseRefused } from "@/lib/db/lease";
import { leaseGatedBroker } from "./lease-gated-broker";
import { emit, type LogRecord } from "@/lib/logging/pipe";
import {
  ENGINE_SCOPE,
  describeEntryGate,
  type LegacyLevel,
  type LogCategory,
  type LogValues,
  type Severity,
} from "@/lib/logging/vocabulary";
import { calculateAll } from "../indicators";
import { getStrategy } from "../strategies";
import { PLAYBOOK_NOT_IN_BUILD } from "../strategies/prod-playbooks";
import {
  daySessionRefusalFor,
  instrumentRefusalFor,
  resolveDeploymentParams,
  resolveTimeframe,
  undeployableInstrumentRefusal,
} from "../strategy-types";
import {
  collectSessionWindows,
  currentCmeSessionStart,
  mostRecentWindowEnd,
} from "../session/session";
import {
  earlyCloseFor,
  isInEarlyCloseHalt,
  isInTradableSessionWindow,
} from "../session/exchange-calendar";
import {
  etDateKey,
  indicatorNeedsDaySession,
  strategyNeedsDaySession,
} from "../session/session-utils";
import { isValidBracketTicks } from "../orders/brackets";
import { evaluateDailyPnlGate } from "../daily-pnl-gate";
import { getAccountDailyPnlLimits, getAccountDeployState } from "@/lib/db/account-brokers";
import { isEngineManagedStatus } from "@/lib/trading/domain";
import type { StrategyModule, OpenPosition, CommonParams } from "../strategy-types";
import {
  collectExitFilterResults,
  crossTimeframeExitRefusalFor,
  getExitFilterTimeframes,
  attributeSlRatchet,
  isStopAtOrBeyondMarket,
  pickTightestFavorableSl,
  snapshotAllFilterState,
  type AllFilterParams,
} from "../filters";
import {
  getAccountRealizedSinceGross,
  getAllOpenTrades,
  getLastExitAt,
  getOpenTradeForDeployment,
  getReconcilableTrades,
  getTradeById,
  listSessionLatchedEntries,
  markBreakEvenMoved,
  markSlTrailEngaged,
  type SessionLatchedEntry,
} from "@/lib/db/trades";
import {
  markHeartbeatDegraded,
  setPendingFlatten,
  stampEngineHeartbeat,
  type PendingFlatten,
} from "@/lib/db/engine-restart";
import {
  getDeployment,
  listClosingDeployments,
  listGroupLegs,
  listManagedDeployments,
  markOrphanedByAccount,
  reapDestroyingDeployment,
  settlePausingDeployment,
} from "@/lib/db/deployments";
import { getGroup, listGroups, softDeleteGroup } from "@/lib/db/deployment-groups";
import { getLastBarTimestamp, setLastBarTimestamp } from "@/lib/db/settings";
import {
  resolveRiskSizedContracts,
  playbookSizingFrom,
  type RiskSizeResult,
} from "@/lib/trading/orders/risk-sizer";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import { resolveSessionPosture } from "@/lib/db/account-brokers";
import {
  ACCOUNT_RISK_PHASE_LABELS,
  type SessionBudget,
} from "@/lib/trading/orders/account-phase-sizer";
import { insertSkippedSignal } from "@/lib/db/skipped-signals";
import {
  CONTRACT_HELD_GATE,
  DAILY_PNL_GATE,
  RISK_BUDGET_GATE,
  SIZE_RESOLUTION_GATE,
  STALE_LATCH_GATE,
  STALE_LATCH_REASON,
  contractHeldReason,
  contractHeldSkip,
  dailyPnlReason,
  dailyPnlSkip,
  riskBudgetReason,
  riskBudgetSkip,
  sizeResolutionReason,
  sizeResolutionSkip,
  staleLatchSkip,
  strategySkip,
  type ContractHolder,
  type SkippedSignal,
} from "@/lib/trading/skipped-signal";
import { getBroadcaster, peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { engineStatusOf } from "@/lib/trading/engine/handle";
import {
  sendDiscordAlert,
  sendConnectionAlert,
  sendOrphanAlert,
  formatAccountLabel,
  COLOR_EXIT_LOSS,
  COLOR_CONNECTION_LOST,
  COLOR_CONNECTION_RESTORED,
} from "@/lib/notify/discord";
import type {
  Contract,
  BarData,
  Order,
  OrderSide,
  TradeFill,
} from "@/lib/brokers/types";
import type { Deployment, IndicatorConfig, TickerSymbol, Timeframe } from "@/lib/trading/domain";
import type { StrategyTrade } from "@/lib/db/trade-types";
import { signalBarAnchor, stepBarCount, type BarCountAnchor } from "./boot/engine-entry-anchor";

// ── Constants ───────────────────────────────────────────────────────

/**
 * Bundle ID for the single Tradovate client managed today. The engine
 * stores Tradovate clients in a Map keyed by bundle ID so a future
 * multi-prop-firm refactor (e.g. one bundle per prop firm) can add
 * entries without another structural change. Until that lands every
 * caller uses this single key.
 */
export const DEFAULT_TRADOVATE_BUNDLE_ID = "default";

// ── Types ───────────────────────────────────────────────────────────

/**
 * What the rings hold and `/logs` renders. `level` is the seven-chip enum,
 * declared once in the logging vocabulary so the engine and the pipe
 * cannot drift on it.
 */
export interface EngineLog {
  timestamp: string;
  deploymentId: string;
  level: LegacyLevel;
  message: string;
}

/**
 * The envelope fields a call site supplies for itself: the structural ids it
 * happens to hold, and its burst opt-in.
 *
 * `deploymentId` is not here because it is the seam's first argument, and
 * `display` is not here because the engine derives it — one right answer per
 * deployment id, and a site that forgets renders a bare uuid on the
 * operator's phone.
 *
 * **`burstKey` is an opt-in, not a default.** Handing one over declares
 * *"my repeats differ in ids alone"* and lets the collapser normalise digit
 * runs before hashing. Without it a line keys on its exact scrubbed text,
 * which is the safe answer: two ids are two incidents. See the composition
 * contract in docs/modules/logging/README.md before adding one.
 */
export interface LogSubject {
  accountId?: number | null;
  contractId?: string | null;
  /**
   * The **rendered symbol** — `MNQ`, never the contract id.
   *
   * For a line that names a contract and no deployment: the naked-position
   * and orphan-bracket sweeps are account-scoped, so `display` is null and a
   * `{ticker}` slot has nothing to come out of. A deployment-scoped site
   * leaves it alone — its `display` already carries the ticker, and two
   * sources for one slot is two ways to disagree.
   */
  ticker?: string | null;
  tradeId?: number | null;
  burstKey?: string | null;
  /**
   * The Activity template's value slots, for a site that has them in hand.
   * The message keeps saying exactly what it said — these ride beside it, so
   * the diagnostics lane is untouched and the Activity lane gains a sentence
   * it could only fall back from before. See
   * [logging/README.md](../../../../docs/modules/logging/README.md).
   */
  values?: LogValues | null;
}

/**
 * What `ensureHubsReady()` observed after its attempts.
 *
 * Every field is read *after* the corresponding connect, so a caller
 * rendering it is quoting a check rather than restating an intention —
 * which is the whole of A56: the boot line said `(hubs ready)` as a fixed
 * string, on a boot where both hubs had just failed to construct.
 *
 * **Both feed fields are plain booleans, and `user` used to be
 * `boolean | null` for a state that cannot occur.** The third value was meant
 * for an install with no realtime transport to relay, but `getBroadcaster`
 * returns null only when its deps are null, and the deps are set in the
 * constructor on exactly the condition `ensureHubsReady` has already guarded
 * on — so past that guard the broadcaster is always there and `user` is
 * always a reading. The arm rendering it could never print, which is the same
 * shape as the fixed `(hubs ready)` string this type exists to have killed:
 * a boot line describing a state nobody was in. `attempted: false` is the
 * whole of *"nothing was started"*, and its own arm short-circuits before
 * either feed field is read.
 */
export interface HubReadiness {
  /** False when realtime is off entirely — no hub was started. */
  attempted: boolean;
  market: boolean;
  user: boolean;
}

/**
 * Layer 1 buffer slot for hub-first exit reconciliation
 * (docs/proposals/userhub-trade-subscription.md §Buffer shape).
 * Single-tenant per `(accountId, contractId, tradeId)`. The dedup set
 * is slot-scoped — when the slot is discarded, the dedup set goes with
 * it, so reconnect replay landing across a closed-then-reopened slot is
 * NOT deduplicated by design.
 */
export interface BufferSlot {
  accountId: number;
  contractId: string;
  tradeId: number;
  /** Epoch ms when the slot was opened — drives the pre-drain assertion
   *  that `slot.openedAt <= trade.entryFilledAt`. */
  openedAt: number;
  fills: TradeFill[];
  /** Dedup keys of the form `${brokerKind}:${accountId}:${fill.id}`. */
  dedup: Set<string>;
}

/**
 * Pre-resolved exit values produced by Layer 1's `reconcileExitFromBuffer`.
 * Same shape `resolveExitFromFills` returns so `reconcileOneTrade` can
 * consume either path through one branch. When supplied, the close-branch
 * stamps `exit_resolution_source = 'buffer'` and skips the REST
 * `searchTrades` call.
 */
export interface PreResolvedExit {
  exitPrice: number;
  pnlDollars: number;
  pnlTicks: number;
  feesDollars: number;
  exitFilledAt: string;
  matchedOrderId: number | null;
}

export interface DeploymentState {
  /**
   * Timestamp of the most recent closed bar we've processed for this
   * deployment. Used as the "has a new bar closed since last tick?" gate so
   * we only evaluate strategy hooks once per bar. Persisted per deployment
   * (`setLastBarTimestamp`) and restored at boot.
   *
   * **Compared as an instant, never as a string** (`isNewerBar`). It holds
   * whichever spelling the evaluated bar carried — REST's `+00:00` or the
   * aggregator's `.000Z` — and stored rows from before hold either, so a
   * string compare reads one bar as two.
   */
  lastBarTimestamp: string | null;
  /** Exit-anchored cooldown reference. Set when this deployment's position
   *  closes (engine-issued exit OR reconciler-observed close); the next
   *  entry is gated until `cooldownSeconds` elapse from this timestamp. */
  cooldownAnchorAt: string | null;
  position: OpenPosition | null;
  /** Row id in strategy_trades for the currently-open or pending trade. */
  activeTradeId: number | null;
  /** True once we've moved the SL bracket to entry for this position. */
  breakEvenMoved: boolean;
  /** Open-order ids on this account+contract captured immediately before
   * the entry was submitted. Used by the reconciler to diff post-fill
   * and identify the TP/SL bracket pair belonging to THIS trade, so a
   * second deployment sharing the same contract can't steal the match.
   * Cleared once brackets are persisted on the trade row. */
  preEntryOrderIds: number[] | null;
  /** Resolved TP/SL tick offsets for the currently-open trade. Captured at
   *  entry from the strategy's emitted SL collapsed through the deployment-
   *  level Override / Max + RR so breakeven math and logs use the bracket
   *  Topstep actually placed. */
  activeTpTicks: number | null;
  activeSlTicks: number | null;
  /** True once the SL has been moved off its original entry-bracket price.
   *  Distinguishes "Stop Loss" from "Breakeven Stop" / "Trail Stop" at the
   *  moment of the closing fill. Cleared with the rest of the position
   *  state on every close path. */
  slMovedToBe: boolean;
  /** Current SL bracket price after the most recent move (BE seed or trail
   *  bump). Compared against entry ± 1 tick at exit time to label the close
   *  as Breakeven Stop (at entry) vs Trail Stop (beyond entry, favorable). */
  slCurrentPrice: number | null;
  /** Current TP bracket price (limit) mirrored from the broker every reconcile
   *  tick. Parallels slCurrentPrice. Used by the close-time bracket
   *  attribution heuristic when matchedOrderId + OCO survivor checks both
   *  fail (Trade/search lag + broker cancelled survivor before our next
   *  tick) — exit price is compared to last-known TP and SL, closer leg
   *  wins. */
  tpCurrentPrice: number | null;
  /** True while a `placeExitOrder` call for this deployment is in flight.
   *  Set synchronously before any await and cleared in `finally`. Guards
   *  against quote-tick storms firing concurrent exits that all read
   *  `position` as still-set, all pass the broker-flat guard before any
   *  market order has landed, and all dispatch flatten orders against a
   *  book that's already flat — flipping the deployment into a phantom
   *  naked position. Per-deployment, so two deployments on different
   *  contracts can still exit concurrently. */
  exitInFlight: boolean;
  /** Who holds `exitInFlight` and since when, so a latch still held past the
   *  session window can say which exit is stuck. Written and cleared with the
   *  latch by `placeExitOrder`; optional so a state built before it reads as
   *  unset. */
  exitLatchHolder?: { reason: string; takenAt: number; pastWindowBarCloses: number } | null;
  /** Throttle anchor for the `EXIT_FLAT_MISMATCH` warn line, keyed on the
   *  stranded trade so a new one is announced immediately. The throw is never
   *  throttled — only the line. `evaluateRealtimeExits` is unthrottled and
   *  fires on every price change, so a leg stranded between an exogenous exit
   *  and the reconciler closing its row re-enters that arm on every tick.
   *  Lives here rather than in the exit cluster because `applySync` prunes
   *  this map, which is what keeps it bounded on a 24/7 run. */
  flatMismatchWarnedAt: { tradeId: number; at: number } | null;
  /** Throttle anchor for `logExitDispatchFailure`'s line, one frame up from
   *  the anchor above. Throttling the throw site alone left the burst intact
   *  here, because the throw reaches this catch arm on every re-entry. Keyed
   *  on the trade, the arm, the error's class name and its message with digit
   *  runs collapsed, so a *different* failure — or the same one on a *new*
   *  trade — announces immediately, while the same failure carrying a
   *  countdown, a trace id or a timestamp does not defeat the anchor. Cleared
   *  when an exit reaches the wire and pruned with the state entry by
   *  `applySync`, same as its sibling. */
  exitDispatchWarnedAt: { key: string; at: number } | null;
  /** Throttle anchor for the exit's side-mismatch refusal line (the broker
   *  holds the opposite side from the mirror). Same lifetime and clearing as
   *  `flatMismatchWarnedAt`; optional so a state built before it reads as unset. */
  sideMismatchWarnedAt?: { tradeId: number | null; at: number } | null;
  /** The trade the pre-exit rehydrate last seeded the mirror from. It
   *  seeds once per trade: a row stuck `open` over a flat broker would
   *  otherwise be re-seeded after every ghost-sweep clear and announce a
   *  session-end close it never makes, once per bar. */
  preExitRehydratedTradeId?: number;
  /** Strategy-computed session key for the in-flight entry. Stashed when
   *  `placeEntryOrder` is dispatched and read back at fill confirmation
   *  to latch `sessionEntryLatch`. Null between trades and for strategies
   *  that don't emit `sessionKey` on `EntrySignal`. The cap is engine-
   *  authoritative: the strategy's `shouldEnter` reads the latch via
   *  `ctx.hasEnteredThisSession`; the walker no longer derives cap
   *  state from bar history. */
  pendingEntrySessionKey: string | null;
  /** Stale-signal latch. Set true when `shouldEnter` returned a non-null
   *  signal on a bar where entry was suppressed by another deployment
   *  holding an open position on the same (account, contract). While true,
   *  entries are blocked even after the account goes flat — the strategy's
   *  signal condition (e.g. ORB price still above range high) is still
   *  continuously true and would re-fire a stale setup. Cleared on the
   *  next bar where `shouldEnter` returns null (or structured skip), i.e.
   *  conditions have genuinely reset. Per-deployment, not per-account, so
   *  each strategy tracks its own suppression independently. Resets to
   *  false on deployment disable/restart via `applySync` dropping state
   *  and `getState` re-initializing it. */
  signalSuppressed: boolean;
}

/**
 * The ring's feed. It takes the whole record rather than the four legacy
 * fields, because the ring is where the viewer reads the envelope from —
 * the narrowing happens at `engine-singleton`'s accessors, which is the one
 * place a payload leaves the process. Keep the whole record crossing here
 * and the projection there; narrowing at this end would put the privacy
 * rule in two places and leave the ring unable to serve a second consumer.
 */
type LogHandler = (log: LogRecord) => void;

// ── customTag helper ────────────────────────────────────────────────
// Topstep rejects customTags >~64 chars with a silent HTTP 500. Keep
// tags compact: short prefix + first 8 chars of deployment UUID + base36
// timestamp + 4 random base36 chars. Example: "e_a53c17d7_m3k9_7p2x".
// The random suffix defends against two tags built in the same ms for
// the same deployment — e.g. if ticks ever parallelize or a retry fires
// without a clock advance.
export function buildCustomTag(prefix: "e" | "x" | "s", deploymentId: string): string {
  const shortId = deploymentId.replace(/-/g, "").slice(0, 8);
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, "0");
  return `${prefix}_${shortId}_${ts}_${rand}`;
}

/**
 * When USE_REALTIME_BARS=true, the engine subscribes to SignalR market-hub
 * trades, aggregates them into bars locally, and fires strategy evaluation
 * the instant a bar closes instead of polling REST. The polling path is
 * retained as a fallback and for environments without SignalR.
 */
const REALTIME_BARS_ENABLED = process.env.USE_REALTIME_BARS === "true";

/**
 * Cadence for the engine's REST tick.
 *  - In realtime mode this is the *reconciler-only* tick: strategy eval is
 *    bar-driven via SignalR, so this loop just keeps pending trades in
 *    sync with broker state.
 *  - In polling mode (no realtime bars) it's the *full* tick: strategy
 *    eval + reconcile.
 *  - In passive mode (SignalR was up but got kicked) it's the only signal
 *    the engine has, so faster is better — fills, manual closes from the
 *    Topstep webapp, etc. show up within one tick instead of two.
 *
 * 15s is a balance: fast enough that "I just closed a position in the
 * webapp" is reflected in our state quickly while passive, slow enough
 * to stay well under Topstep's REST quota even with several deployments.
 */
const REST_TICK_MS = 15_000;

/**
 * How often a failing heartbeat write is warned about. The heartbeat runs on
 * every tick, so an unthrottled warning would put four lines a minute into the
 * ring buffer for as long as the database is unhappy — and the database being
 * unhappy is already going to be loud elsewhere.
 */
const HEARTBEAT_WRITE_WARN_MS = 300_000;

/** `first_tick` is the deploy measurement's last boundary (engine-boot.md),
 *  so it is said once per process — module state, not engine state, because
 *  an in-process stop → start is not a deploy. */
let firstTickReported = false;

/**
 * How often `logExitDispatchFailure` repeats one arm's failure for one
 * deployment. Same period as `EXIT_FLAT_MISMATCH_WARN_MS` at the throw site
 * and as the guards' `reportFailure`, for the same reason: the conditions that
 * reach that catch arm are standing ones and the retry cadence is the market's,
 * not the engine's.
 */
const EXIT_DISPATCH_WARN_MS = 300_000;

/**
 * How long a standing fault that recurs on every bar close stays at one
 * `warn`: an entry refused on a series missing a bar the aggregator published
 * (`entry_bar_series_gap`, per deployment), a bar ahead of the engine's clock
 * (`bar_ahead_of_clock` per deployment and cause, `engine_clock_behind`
 * engine-wide), and a stop move refused with no reference stop
 * (`stop_move_unknown_stop`, per trade; a new trade warns at once). Thirty
 * minutes, not five, because a five-minute window is one 5m bar and close
 * jitter lets every bar's repeat through at `warn`; thirty keeps repeats out
 * of `warn` on every timeframe the engine trades while a standing fault still
 * re-warns twice an hour. Each site keys its own anchor and picks its own
 * repeat level. A `burstKey` cannot replace this throttle: `trade` lines are
 * exempt from burst collapse, and the 30s burst window is shorter than any
 * bar interval.
 */
const REPEAT_WARN_WINDOW_MS = 1_800_000;

/** What was ahead of the clock: a bar REST served, or the stored cursor. */
type BarAheadCause = "feed" | "cursor";

/** A bar close as the aggregator published it: the bar, the open time of the
 *  bar it published before this one (null for its first), and the timeframe
 *  of the aggregator that closed it. */
export interface TriggerClose {
  bar: BarData;
  previousPublishedAt: string | null;
  timeframe: Timeframe;
}

/** A bar opening past `horizonMs` is ahead of the engine's clock. An
 *  unparseable timestamp is not judged here. */
function isAheadOf(timestamp: string, horizonMs: number): boolean {
  return Date.parse(timestamp) > horizonMs;
}

/**
 * Bar identity is the parsed instant. REST spells a bar `…+00:00` and the
 * aggregator `….000Z`, and persisted `lastBarTimestamp` rows hold either. An
 * unparseable side falls back to inequality, which is the old string rule.
 */
function isNewerBar(candidate: string, than: string): boolean {
  const a = Date.parse(candidate);
  const b = Date.parse(than);
  if (Number.isNaN(a) || Number.isNaN(b)) return candidate !== than;
  return a > b;
}

/**
 * Phase 5 polling-fallback threshold. When a Tradovate-broker account's
 * Real-Time WS subscriber has pushed any frame within this window, the
 * reconciler tick treats that account's WS as healthy and skips the
 * per-account searchOpenOrders/searchOpenPositions fan-out — the WS
 * hooks are already feeding the same reconciliation methods. When the
 * subscriber is silent past this window, the reconciler tick takes over.
 *
 * Sized > the WS subscriber's own 5s inbound-silence reconnect timer so
 * a transient blip doesn't bounce the polling fallback on/off; sized <
 * the 30s plan-§4 contract so a real WS death surfaces as polling within
 * one reconciler tick (REST_TICK_MS = 15s).
 */
const TRADOVATE_WS_HEALTHY_MS = 30_000;

/**
 * After this many consecutive `attemptUserReconnect()` failures within a
 * single auto-heal cycle, stop trying and fire a Discord alert. The counter
 * resets on the next successful reconnect or fresh maintenance-heal trigger.
 */
const USER_RECONNECT_MAX_FAILURES = 3;

/**
 * Bound on `sessionEntryLatch` entries per deployment. Strategies key the
 * latch by their own session-day notion (ORB: ET calendar date or overnight
 * owner date), so 32 distinct keys covers more than a month of trading
 * sessions before eviction kicks in. The eviction is FIFO via Map insertion
 * order, which is fine since stale session-days are by definition not the
 * one a current `shouldEnter` is asking about.
 */
const SESSION_LATCH_MAX_KEYS = 32;

/**
 * How far back a restart reads filled entries to rebuild the latch. The key
 * is the strategy's own session notion, not the CME session, so the read is
 * not cut at the session boundary: an ET-date key spans the 18:00 roll, and
 * a cut there would drop a 17:30 fill that a 19:00 restart still has to see.
 * A week covers any session key a strategy emits, a weekend included; an old
 * key is harmless, because no current `shouldEnter` asks about it.
 */
const SESSION_LATCH_RESTORE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Composite key uniquely identifying a (contract, timeframe) aggregator.
 * Two deployments on the same contract at different cadences need separate
 * aggregators or one cadence wins and the other runs on stale bars. */
export type SubKey = string & { readonly __brand: "subKey" };

/** Per (contract, timeframe) aggregator state in realtime mode. */
export interface ContractSub {
  contractId: string;
  contract: Contract;
  aggregator: BarAggregator;
  timeframe: Timeframe;
  /** Deployment ids currently subscribed to this aggregator. Reference-counted
   * so two deployments on the same (contract, timeframe) share one aggregator
   * and unsubscribe only happens when the last one drops. */
  refs: Set<string>;
}

/** Per-contract market-data subscription state. The underlying SignalR
 * `subscribeTrades`/`unsubscribeTrades` is ref-counted at this level so a
 * single contract feeds N aggregators (one per timeframe in use). */
export interface MarketSub {
  contract: Contract;
  refCount: number;
  timeframes: Set<Timeframe>;
  /** Last tick price observed on this contract. Per-contract (not per-tf)
   * because realtime-exit dedup must fire once per price change regardless
   * of how many aggregators are bound to the same trade stream. */
  lastTickPrice: number | null;
}

/** Why a leg was refused at activation. The value is read only to re-announce
 *  a leg whose reason changed; everything else asks whether there is one. */
type LegRefusal =
  | "day-session"
  | "instrument"
  | "research-instrument"
  | "cross-timeframe-exit"
  | "warmup-depth"
  | "unregistered";

// ── Engine ──────────────────────────────────────────────────────────

/**
 * deploymentId value used for engine-internal (non-deployment) log entries.
 *
 * One definition, re-exported from the vocabulary rather than restated: the
 * pipe compares against it and three engine files used to hold their own
 * copy of the string.
 */
const ENGINE_CTX = ENGINE_SCOPE;

/** `BrokerPlugin.id` is a plain string; `BrokerKind` is the routing key.
 *  Narrow rather than cast, so a third plugin id is a `null` the caller
 *  has to handle instead of a silent Topstep. */
function brokerKindForPluginId(pluginId: string): BrokerKind | null {
  if (pluginId === BrokerKind.Topstep) return BrokerKind.Topstep;
  if (pluginId === BrokerKind.Tradovate) return BrokerKind.Tradovate;
  return null;
}

/**
 * Orphan-pause reason strings, by broker and error kind. Only kinds
 * present here pause an account; everything else is left to the next
 * tick.
 *
 * These strings are **persisted** into the deployment row and rendered in
 * detached-tab history, so they are frozen — `place_order_account_not_found`
 * in particular predates the taxonomy and no longer describes where it
 * comes from. Keyed on broker *and* kind rather than kind alone because
 * the Tradovate strings name a broker: a second broker reporting
 * `captcha` must not inherit `tradovate_captcha_lockout`, it needs its
 * own row here.
 *
 * The outer keys are written as literals rather than `[BrokerKind.X]` on
 * purpose. `BrokerKind` is a string `const enum` that transpiles to a
 * runtime object, so a computed key would make this table a
 * module-*load*-time read of `db/account-brokers` — a dependency
 * `engine.ts` does not otherwise have at load time. The type is still the
 * enum, so a typo is a compile error.
 */
const ORPHAN_PAUSE_REASONS: Partial<
  Record<BrokerKind, Partial<Record<BrokerErrorKind, string>>>
> = {
  topstep: {
    account_unavailable: "place_order_account_not_found",
  },
  tradovate: {
    account_unavailable: "tradovate_account_not_active",
    captcha: "tradovate_captcha_lockout",
    auth: "tradovate_unauthorized",
  },
};

export class TradingEngine {
  /** Null on a Tradovate-only install. Only the two auth-lifecycle
   *  carve-outs read it, and both are Topstep-hub concerns that do not
   *  exist without Topstep. */
  private topstepClient: TopstepClient | null;
  /**
   * Tradovate REST clients keyed by bundle ID. Today only one entry
   * (`DEFAULT_TRADOVATE_BUNDLE_ID`) is ever populated — the map shape
   * is the seam for an eventual multi-prop-firm refactor where each
   * prop firm gets its own bundle. Callers read via
   * `defaultTradovateClient()` which encapsulates the lookup.
   *
   * Mutated at runtime by `reloadTradovateClients()` so the settings
   * page can hot-swap credentials without a container restart.
   */
  private tradovateClients = new Map<string, TradovateClient>();
  private signalr: TopstepSignalR | null;
  private resolver: BrokerAwareContractResolver;
  private brokerRegistry: BrokerRegistry;
  private brokerPluginRegistry: BrokerPluginRegistry;
  /** Asked by every order call `brokerForAccount` hands out; says a loss once. */
  private readonly mayReachOrders = leaseGate(
    "an order call",
    "Exits, stop moves, bracket orders and cancels are refused until it is held again; the engine holding it manages these positions.",
  );
  private state = new Map<string, DeploymentState>();
  /** Each deployment's account as of the last sync, so `applySync` can tell a
   *  re-pointed leg (Move to replacement) from one that stayed. Replaced
   *  wholesale at every sync, so it holds only the current set. */
  private syncedAccountIds = new Map<string, number>();
  /**
   * The last bar each position's `barsSinceEntry` is known on, which every
   * evaluated bar derives the count from (A95). Set at the live entry and at
   * the reload, so a pass that never ran — a restart, an aborted fetch, an
   * in-process stop — cannot leave the count short. Keyed on the position
   * object rather than the deployment: every close path replaces or nulls
   * `position`, so an entry that follows can never pick up a stale anchor,
   * and nothing has to clear it.
   */
  private readonly barCountAnchors = new WeakMap<OpenPosition, BarCountAnchor>();
  /** Reloaded positions whose recount has not been logged yet. */
  private readonly unreportedReloads = new WeakSet<OpenPosition>();
  /**
   * Per-deployment per-session entry latch. Engine-authoritative source of
   * truth for "has this strategy already opened a real position on this
   * side this session?" Set on `markEntryFilled` confirmation (real fill,
   * not signal); read by strategies via `ctx.hasEnteredThisSession`.
   *
   * Bounded eviction: if a deployment accumulates > SESSION_LATCH_MAX_KEYS
   * stale session-day entries (typical: 32 days), the oldest insertion is
   * dropped. The map preserves insertion order so `Map.keys().next()` gives
   * us the oldest. A restart rebuilds it from the trade rows' persisted
   * session keys — see `restoreSessionEntryLatch` (A92).
   */
  private sessionEntryLatch = new Map<string /* deploymentId */, Map<string /* sessionKey */, Set<OrderSide>>>();
  /** Deployments whose latch this process has already rebuilt from the trade
   *  rows. Read once per deployment per process: after that the live fill
   *  paths keep the map current, and re-reading would only re-add keys. */
  private readonly sessionLatchRestored = new Set<string>();
  /** Deployments whose latch read has failed and been announced, so a tick
   *  that retries it does not repeat the line. */
  private readonly sessionLatchRestoreFailed = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  /** What `swapTickHandler`'s interval runs, and that interval's handle —
   *  compared with `intervalId`, because `stop()` and the other start paths
   *  replace `intervalId` without knowing about the swap. */
  private tickHandler: () => void = () => {};
  private swappableTickId: ReturnType<typeof setInterval> | null = null;
  private onLog: LogHandler | null = null;
  /** Whether the installed handler's first throw has been said; see
   *  `deliverToLogHandler`. Reset when a handler is installed. */
  private onLogThrowReported = false;
  /** `deploymentId → { paramValues, strategy, params }` for the quote-tick
   *  exit path, which merged the params afresh per tick per leg (A14).
   *  Dropped wholesale by `applySync`, and an entry is used only while the
   *  deployment's `paramValues` object and strategy module are the ones it was
   *  built from. */
  private tickParamsCache = new Map<
    string,
    { paramValues: Deployment["paramValues"]; strategy: StrategyModule; params: Readonly<CommonParams> }
  >();
  /** `deploymentId → display`, memoising `displayFor`'s row read. Dropped
   *  wholesale by `applySync`; see that method and `displayFor`. */
  private displayCache = new Map<string, string | null>();
  private accountNames = new Map<number, string>();
  private accountNamesRefreshedAt = 0;
  /** Epoch ms of the last `refreshBrokerRegistry` attempt from the
   *  reconciler's empty-account-names branch. Rate-limits the cold-boot
   *  retry: without this gate, an account-search outage means every 15s
   *  reconciler tick re-fires the full registry refresh → Tradovate
   *  resync → contract pre-warm → potential session kick. */
  private brokerRegistryLastAttemptAt = 0;
  /** The Tradovate outage the Discord alert last announced, so one outage is
   *  one alert however many refreshes see it. See `TradovateAlertEpisode`. */
  private readonly tradovateAlertEpisode = new TradovateAlertEpisode();
  /** Per-account epoch ms of the last hourly validation sweep. In-memory only;
   *  on engine restart, the first reconciler tick triggers a sweep for every
   *  account, which is desirable (covers the restart drift window). */
  private lastHourlyValidationSweepAt = new Map<number, number>();
  /** Per-trade count of validateClosedTradePrices attempts. After
   *  `VALIDATION_LOG_VERBOSE_LIMIT` (in `engine-reconcile.ts`, beside its
   *  only use site), per-trade lines drop to debug to avoid
   *  flooding the heartbeat ring for rows that can never heal. */
  private validationAttempts = new Map<number, number>();
  /** Per-trade count of hourly-sweep passes over an approximated row; past
   *  `APPROXIMATED_SWEEP_MAX_PASSES` (in `engine-reconcile.ts`) neither
   *  approximated sweep asks Trade/search about it until restart or `stop()`
   *  (watchlist-3). */
  private approximatedSweepPasses = new Map<number, number>();
  /** Deployments currently running under the realtime path. Needed so
   * `onBarClose` can find every deployment that should evaluate on this
   * contract's bar close. */
  private realtimeDeployments: Deployment[] = [];
  /** Deployment ids refused at activation, against why — see
   *  `classifyActivationRefusals`, which is the only writer. One set with a
   *  reason rather than one set per condition: every consumer but the
   *  indicator substitution asks "is this leg refused", and a second set would
   *  be a second answer to that. Replaced wholesale at activation, so it is
   *  bounded by the deployment set. */
  private refusedLegs = new Map<string, LegRefusal>();
  /** Rows already told they are not in this build. Not `refusedLegs`, which is
   *  replaced every sync: the server's syncs omit Paused rows and the board's
   *  include them, so a Paused row leaves and re-enters that set on every
   *  press. Cleared only by `stop()`; bounded by the rows the process meets. */
  private announcedUnregistered = new Set<string>();
  /** Each flat leg's setup reading — the dashboard's ARMED chip, and nothing
   *  else reads it. See engine-setup-status.ts. */
  private readonly setupReadings = new SetupReadings({
    emitChanged: () => peekBroadcaster()?.emitSetupsChanged(),
    warnHookFailed: (deploymentId, message) => this.log(deploymentId, "warn", "system", message),
  });
  /** Entries skipped on a dead, locked or Topstep OCO-off account. See
   *  engine-account-entry-gate.ts. */
  private readonly accountEntryGate = new AccountEntryGate({
    readState: (accountId) => getAccountDeployState(accountId),
    readOrphanReason: (deploymentId) => getDeployment(deploymentId)?.orphanReason ?? null,
    announce: (event, deploymentId, accountId, message) =>
      this.logEvent(event, deploymentId, message, { accountId }),
  });

  /**
   * Layer 1 (hub-first exit reconciliation) per-trade fill buffer.
   * docs/proposals/userhub-trade-subscription.md.
   *
   * Slot key: `${accountId}:${contractId}:${tradeId}`. Slot is opened at
   * trade-row creation (BEFORE markEntryFilled) and discarded inside the
   * `try/finally` of the position-close drain. `fillBufferByContract`
   * reverse-indexes `${accountId}:${contractId}` → slot key so the
   * adapter, which only knows account+contract from the broker event,
   * can locate the slot.
   */
  private fillBuffer = new Map<string, BufferSlot>();
  private fillBufferByContract = new Map<string, string>();
  /**
   * Recently-seen dedup keys for slots that have already been discarded,
   * keyed by `${accountId}:${contractId}`. Drives cross-slot redelivery
   * detection per docs/proposals/userhub-trade-subscription.md §Buffer
   * shape: a fill arriving after its slot was discarded — but inside the
   * recall window — is logged at warn and dropped instead of being
   * accepted into a fresh slot for the next trade on the same key.
   *
   * Bounded eviction: once per-contract entries exceed
   * `RECENT_DEDUP_MAX_PER_CONTRACT`, the oldest insertions evict (Set
   * iteration is insertion order). Bound is generous vs. typical per-trade
   * fill count (single digits even with iceberg fills).
   */
  private recentDedupByContract = new Map<string, Set<string>>();
  private static readonly RECENT_DEDUP_MAX_PER_CONTRACT = 256;
  /**
   * Last user-hub event timestamp (epoch ms) per Topstep account.
   * Updated on every `position` / `order` / `userTrade` event the engine
   * observes via the broadcaster. Read by the reconnect-gap REST replay
   * to scope `searchTrades(...)` over the disconnect window. Per
   * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation
   * — fixed-lookback alternative was rejected; per-account anchor is the
   * only correct version.
   */
  private lastTopstepEventAt = new Map<number, number>();

  /**
   * Cache of `deployment_groups` rows keyed by group_id. Avoids N+1 SQL
   * hits when filtering `realtimeDeployments` by group state.
   *
   * **It is a precondition of the entry gate, not an optimisation** —
   * `isLegEngineEnabled` refuses a leg whose parent is not in it. In healthy
   * realtime mode `tick()` runs once, at `start()`, and the interval is
   * `runReconcileOnly`; the bar-close entry path does not refresh. So this
   * map is primed by that first tick and kept current by `applySync` alone.
   * A binding mutation that skips `sync()` takes every leg under that parent
   * out of entry eval, silently. See docs/modules/trading/engine.md.
   */
  private groupCache = new Map<string, import("@/lib/trading/domain").DeploymentGroup>();

  /** Refresh `groupCache` from DB. Called at the top of `tick()` and from
   *  `applySync`, so cascading group operations land before filter sites
   *  evaluate. Cheap — group count is small (one row per user-created
   *  deployment; typically <10). */
  private refreshGroupCache(): void {
    const next = new Map<string, import("@/lib/trading/domain").DeploymentGroup>();
    for (const g of listGroups()) next.set(g.id, g);
    this.groupCache = next;
  }

  /** Entry-eval gate: the leg is `Active` AND its parent is enabled and
   *  not soft-deleted. Every leg has a parent; a missing one answers false,
   *  which is the conservative direction. */
  private isLegEngineEnabled(d: Deployment): boolean {
    if (d.status !== "Active") return false;
    const group = this.groupCache.get(d.groupId);
    if (!group) return false;
    if (group.deletedAt != null) return false;
    return group.enabled;
  }

  /**
   * Exit-eval predicate: every status but `Paused`.
   *
   * This used to read `legHasOpenPosition(state) || isLegEngineEnabled(d)`,
   * because the only way to express "stopped entering, still holding" was a
   * disabled row with a position hanging off it. Under D-4 that state cannot
   * exist — a pause that leaves a position open is a `Pausing` row, and the
   * status says so — so the widening came out with the bug class it patched.
   *
   * The group is deliberately *not* consulted here. A leg whose group was
   * turned off is a leg the engine still owes a flatten, and gating exits on
   * group state is what made the widening necessary in the first place.
   *
   * It also keeps a stale in-memory copy safe. `PATCH /api/groups/[id]` **does**
   * re-sync now, on every exit downstream of its enable/disable cascade — it
   * did not on any path with legs until 2026-08-25, and only on its final
   * return until 2026-08-26 — so this is defence in depth rather than the only
   * thing standing between a group disable and an unsupervised position. It is
   * still load-bearing, because the deployment set is a *pushed* projection
   * with no timer behind it: a route that mutates a binding without syncing, or
   * a `sync()` deferred into `pendingSync` while a tick holds the lock, leaves
   * the cached row reading `Active` after the DB says otherwise. Reading that
   * as "in the exit loop" is the conservative answer.
   */
  private isLegInExitLoop(d: Deployment): boolean {
    return isEngineManagedStatus(d.status);
  }

  /**
   * The entry path's cooldown gate. The anchor is null after a restart, so it
   * is lazy-seeded from the DB's most recent exit for this deployment.
   */
  private isInEntryCooldown(deploymentId: string, deplState: DeploymentState, cooldownSeconds: number, now: Date): boolean {
    if (cooldownSeconds <= 0) return false;
    if (deplState.cooldownAnchorAt == null) {
      deplState.cooldownAnchorAt = getLastExitAt(deploymentId);
    }
    if (!deplState.cooldownAnchorAt) return false;
    const elapsedSeconds = (now.getTime() - new Date(deplState.cooldownAnchorAt).getTime()) / 1000;
    return elapsedSeconds < cooldownSeconds;
  }
  /**
   * Market-hub connection lifecycle — connect, watchdog, passive mode,
   * maintenance auto-heal, manual reconnect. Owns its own state; the
   * engine reads it through `isReady()` / `mode()` / `lastActivityAt()`
   * and pushes into it through `noteTradeActivity()`. See
   * [engine-market-hub.ts](./engine-market-hub.ts) for why this one is a
   * stateful controller rather than a `*Deps` pure-function extraction.
   */
  private marketHub: MarketHubController;

  /** Naked-position watchdog interval ref. Periodically sweeps every
   *  account the engine manages and flattens any open position that lacks
   *  a live Stop Market bracket on the closing side. See
   *  NAKED_POSITION_WATCHDOG_INTERVAL_MS. */
  private nakedWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  /** The sweep itself. Owns the two-strike memory and the post-flatten
   *  cooldown map; the engine only arms/disarms the interval that drives
   *  it. See [engine-watchdog.ts](./flatten/engine-watchdog.ts) for why this one
   *  is a stateful controller rather than a `*Deps` pure-function
   *  extraction, and why its flatten bypasses the exit latch. */
  private nakedWatchdog: NakedPositionWatchdog;

  /** Session-end clock guard interval ref. Evaluates session windows against
   *  the wall clock and force-flats any open position that has fallen outside
   *  them, on a cadence that owes nothing to market data. See
   *  SESSION_END_GUARD_INTERVAL_MS. */
  private sessionGuardInterval: ReturnType<typeof setInterval> | null = null;
  /** The sweep itself. Owns the per-deployment failure-escalation anchors;
   *  the engine only arms the interval that drives it. See
   *  [engine-session-guard.ts](./session-close/engine-session-guard.ts) for why the two
   *  market-data-triggered session-end paths are not enough on their own. */
  private sessionGuard: SessionEndGuard;

  /** Regime-label job interval ref. Polls for the CME maintenance break and
   *  fills `regime_days` for the session about to open. See
   *  REGIME_NIGHTLY_INTERVAL_MS. */
  private regimeInterval: ReturnType<typeof setInterval> | null = null;
  /** The nightly job and the lazy fill behind it. Owns the per-ticker attempt
   *  memory; the engine arms the interval and nudges it from the tick. It is
   *  **not** a safety sweep — nothing is gated on the label — which is why it
   *  is the one controller `stop()` disarms. See
   *  [engine-regime.ts](./engine-regime.ts). */
  private regimeLabels: RegimeLabelController;

  /** Closing-guard interval ref. Drives every `Pausing` / `Destroying` row
   *  to completion — submits the exit, then settles the row once it is
   *  confirmed flat. See CLOSING_GUARD_INTERVAL_MS. */
  private closingGuardInterval: ReturnType<typeof setInterval> | null = null;
  /** The sweep itself. Reads its candidates from the DB rather than from
   *  `realtimeDeployments`, so a close survives `stop()` and a restart —
   *  see [engine-closing.ts](./session-close/engine-closing.ts). */
  private closingGuard: ClosingGuard;

  /** Close-sampler interval ref. In the gap after each session close it takes
   *  one account fan-out and records the closing balance the next session's
   *  budget is set from. See SESSION_CLOSE_SAMPLER_INTERVAL_MS. */
  private sessionCloseSamplerInterval: ReturnType<typeof setInterval> | null = null;
  /** The sampler itself. Owns the per-account "could not sample" anchor; the
   *  engine arms the interval and hands it one fan-out. See
   *  [engine-session-close.ts](./session-close/engine-session-close.ts). */
  private sessionCloseSampler: SessionCloseSampler;

  /** Account-status interval ref. Hourly, it checks each configured broker's
   *  accounts (ok, locked or dead, plus Topstep's OCO) when no clean check
   *  stands for the day; the entry gate, the deploy screen and the Risk list
   *  read what it stores. See
   *  [engine-account-status.ts](./engine-account-status.ts). */
  private accountStatusInterval: ReturnType<typeof setInterval> | null = null;
  /** The 17:55 ET evening pass's clock, armed and disarmed with the one above. */
  private accountStatusEveningInterval: ReturnType<typeof setInterval> | null = null;
  private accountStatusJob: AccountStatusJob;

  /** Which session each account has already been warned about running on its
   *  phase's lowest budget, so the warn is once per account per session rather
   *  than once per entry tick. Cleared by `stop()` with the other per-boot
   *  state: the line is emitted on the transition, and a map that survived the
   *  stop would silence the first entry after a restart. */
  private riskPhaseStaleWarnedAt = new Map<number, string>();
  /** When each deployment last warned about an entry refused on a spliced
   *  series with a hole (`REPEAT_WARN_WINDOW_MS`). Cleared by `stop()` on the
   *  reasoning above, and pruned by `applySync` for a removed deployment. */
  private spliceGapWarnedAt = new Map<string, number>();
  /** When each deployment last warned, per cause, that a bar was ahead of the
   *  clock (`bar_ahead_of_clock`, `REPEAT_WARN_WINDOW_MS`). Cleared and pruned
   *  with `spliceGapWarnedAt`. */
  private barAheadWarnedAt = new Map<string, Partial<Record<BarAheadCause, number>>>();
  /** Per deployment, the trade that last warned that a stop move had no
   *  reference stop, and when (`REPEAT_WARN_WINDOW_MS`). Cleared and pruned
   *  with `spliceGapWarnedAt`. */
  private stopUnknownWarnedAt = new Map<string, { tradeId: number | null; at: number }>();
  /** When the engine last warned that a trigger bar was ahead of its clock
   *  (`engine_clock_behind`). Engine-wide: the fault is the host clock, which
   *  every leg shares. Cleared by `stop()`. */
  private clockBehindWarnedAt: number | null = null;

  /** D-2 enforcement interval ref. Force-closes positions the engine did not
   *  open, on instruments it is Active and in-window on. See
   *  MANUAL_POSITION_GUARD_INTERVAL_MS. */
  private manualPositionGuardInterval: ReturnType<typeof setInterval> | null = null;
  /** The sweep itself. Owns its report anchors. Unlike the three sweeps above
   *  it takes its candidates *only* from `realtimeDeployments`, so `stop()`
   *  silences it — a stopped engine claims no instrument and must not close an
   *  operator's position. See
   *  [engine-manual-position.ts](./flatten/engine-manual-position.ts). */
  private manualPositionGuard: ManualPositionGuard;

  /** Downtime-flatten interval ref. Armed by `start()` only when the boot
   *  verdict left something pending, and cleared by the sweep itself the pass
   *  after the last position is confirmed flat. See
   *  RESTART_FLATTEN_INTERVAL_MS. */
  private restartFlattenInterval: ReturnType<typeof setInterval> | null = null;
  /** D-13's flatten, which can only ever run on the next boot: the SIGTERM
   *  handler may record but never act, because `docker stop` gives 10s before
   *  SIGKILL. Owns the pending set and its report anchors. See
   *  [engine-restart.ts](./boot/engine-restart.ts). */
  private restartGuard: RestartFlattenGuard;
  /** D-14's flap breaker, set once from the boot verdict. While true the
   *  engine keeps managing open positions and takes no new entries — the
   *  churn Q-11 named (die → resume → re-enter → die, a round trip in fees
   *  and slippage each cycle) is the entry, not the management. Not a
   *  deployment status: nothing here is the operator's intent, and a status
   *  would have to be undone by hand after the counter has already decayed. */
  private entriesSuspended = false;
  /** Whether the restart obligation has been handed over in this process, by
   *  either door — the boot path's `applyRestartVerdict` or `start()`'s
   *  `ensureRestartVerdictApplied`. One flag, because two would drift and the
   *  thing they latch is a force-close. */
  private restartVerdictApplied = false;
  /** Throttle anchor for the heartbeat-write warning, in epoch ms. */
  private heartbeatWriteWarnedAt = 0;

  /** Post-flatten cooldown per (account, contract), shared by the two paths
   *  that submit a market order against a position they have not re-read: the
   *  naked-position watchdog and D-2 enforcement. Owned by the engine because
   *  it is owned by neither controller — a cooldown one of them cannot see is
   *  a cooldown that stops nothing. See
   *  [engine-flatten-cooldown.ts](./engine-flatten-cooldown.ts). */
  private readonly flattenCooldown = new FlattenCooldown();

  /** Per-seam health: the one global market-data slot plus each broker's
   *  order and event seams. Owns the bar-read anchors and the order-seam
   *  evidence, and nothing else writes them. Deliberately has no interval —
   *  see [engine-health.ts](./engine-health.ts). */
  private health: EngineHealth;

  /** Guard against re-entrant ticks when a tick body runs longer than the
   * interval (e.g. slow reconciler, network hang). Without this, two ticks
   * race: duplicate order submissions, duplicate Discord alerts, and the
   * reconciler can process the same pending trade twice. */
  private ticking = false;
  /** When sync() lands while a tick is in flight, the deployments list is
   *  stashed here and applied in the tick's finally-drain. Single-slot
   *  dedup — only the most recent sync() call wins, which is correct
   *  because each call is a snapshot of current DB state, not a delta. */
  private pendingSync: Deployment[] | null = null;
  /** Bar-close evals deferred while another holder has `ticking`, keyed by
   *  deployment id and resolved against the live `realtimeDeployments` at
   *  drain time so we don't act on a stale deployment object. **The value
   *  is the close the aggregator published** (null for a bar-less call): the
   *  drain hands each leg its own bar, because REST's newest still lags the
   *  close and evaluating that is evaluating the previous bar. A later close
   *  for the same id replaces an earlier one. Cleared in `stop()`. */
  private pendingBarCloses = new Map<string, TriggerClose | null>();
  /** Single-flight guard for user-hub reconnects (auto-heal + heartbeat
   *  anomaly recovery). Mirrors the market hub's own `reconnecting` guard
   *  but scoped to the user hub, so a market-hub reconnect can run in
   *  parallel without contention. */
  private userReconnecting = false;
  /** A `token-rotation` reconnect that arrived while another attempt held
   *  `userReconnecting`. Drained once when that attempt ends: dropping it
   *  left the hub `Connected` on a retired token with nothing to re-fire. */
  private userRotationPending = false;
  /** An attempt has handed off to the rotation rebuild. `userReconnecting`
   *  is already down so the rebuild's own `token-rotation` can run; this
   *  keeps every other trigger out until the rebuild finishes, or a
   *  heartbeat mid-rebuild starts a second user-hub rebuild. */
  private userHandoffInFlight = false;
  /** Consecutive `attemptUserReconnect()` failures within a single auto-heal
   *  window. Reset on success and on every fresh maintenance-heal cycle.
   *  After USER_RECONNECT_MAX_FAILURES we stop banging on the hub and fire
   *  a Discord alert — at that point a real session displacement is the
   *  more likely cause and retrying just fights the user. */
  private userReconnectFailures = 0;
  /**
   * Per (account, contract) lock. Only one deployment at a time can hold an
   * open or pending position on a given account+contract combination —
   * Topstep exposes a single net position per (account, contract), so
   * multiple deployments stacking positions would share one position on the
   * broker side with per-deployment brackets trampling each other.
   *
   * Acquired in `placeEntryOrder` (after the pre-entry snapshot, before the
   * `placeOrder` call) and released in every terminal-state path that nulls
   * `state.position` / `state.activeTradeId`. Rebuilt on engine start from
   * `getReconcilableTrades()` so a restart doesn't drop the lock.
   *
   * Key: `${accountId}:${contractId}`. Not a nested map — the composite key
   * is cheaper to scan and the namespace collision risk (ticker strings
   * containing `:`) is zero for Topstep's contract id format.
   */
  private contractLocks: Map<string, { deploymentId: string; tradeId: number | null; acquiredAt: string }> = new Map();

  /**
   * Trade ids for which we've already fired the Discord entry notification.
   * Sub-second round-trips can have the user-hub size>0 event AND a later
   * REST reconcile path both observe entry — without this guard, both would
   * post an embed. In-memory only: on restart we'd re-fire at most once per
   * trade, which is acceptable noise vs persisting a flag for every trade.
   */
  private entryNotifiedTradeIds = new Set<number>();

  /**
   * Process-lifetime UUID stamped on every trade at entry. Survives
   * start/stop cycles within the same Node process; resets only when the
   * engine is reconstructed (process boot). Drives the analytics-panel
   * exclusion bucket — trades from a prior engine session don't count
   * against the current session's stats.
   */
  public readonly engineSessionId: string = crypto.randomUUID();

  /**
   * The Topstep user-hub adapter, when Topstep has a hub at all. Held
   * concretely (not as `BrokerRealtimeAdapter`) because the engine's
   * heartbeat and auto-heal read hub-specific diagnostics off it —
   * `hubState()`, `liveness()`, `forceReconnect()` — that no other
   * broker has an analogue for. Also attached to the Topstep plugin so
   * the SSE relay can reach it without going through the engine.
   */
  private topstepRealtime: TopstepRealtimeAdapter | null = null;

  /**
   * Whether the engine acts on realtime account events. Reproduces the
   * old `broadcaster.subscribe("engine:user-hub")` /
   * `unsubscribe(...)`-on-stop lifecycle: adapters outlive start/stop
   * cycles and their handler registration is permanent, so the gate is a
   * flag rather than a deregistration.
   *
   * It is only half the gate — see `realtimeEventsAllowed`. The two
   * brokers had different pre-`start()` semantics and one flag cannot
   * carry both.
   */
  private realtimeEventsEnabled = true;

  /** Deps for the in-process SSE relay. Null when there is no realtime
   *  transport to relay from (no Topstep, or realtime bars off). */
  private broadcasterDepsValue: BroadcasterDeps | null = null;

  /** Coalescing guard for the Topstep reconnect-gap replay. One hub
   *  reconnect fires `onReconnect` once per live account; the replay is
   *  a whole-engine sweep, so N signals must collapse to one sweep. */
  private topstepReplayInflight: Promise<void> | null = null;
  /** A reconnect landed while a sweep was running. Exactly one follow-up
   *  is queued — see `replayFillsAfterReconnect`. */
  private topstepReplayQueued = false;

  constructor(
    topstepClient: TopstepClient | null,
    tradovateClient: TradovateClient | null,
    signalr: TopstepSignalR | null = null,
    brokerPluginRegistry: BrokerPluginRegistry = defaultBrokerPluginRegistry,
  ) {
    this.topstepClient = topstepClient;
    if (tradovateClient) {
      this.tradovateClients.set(DEFAULT_TRADOVATE_BUNDLE_ID, tradovateClient);
    }
    this.signalr = signalr;
    this.brokerRegistry = new BrokerRegistry({
      topstep: topstepClient,
      tradovate: tradovateClient,
    });
    this.brokerPluginRegistry = brokerPluginRegistry;
    // Resolver needs the broker registry for per-deployment dispatch.
    // Bound through a closure so the registry can be re-populated by
    // refreshBrokerRegistry() without re-constructing the resolver.
    this.resolver = new BrokerAwareContractResolver(
      topstepClient,
      tradovateClient,
      (accountId) => this.brokerRegistry.brokerKind(accountId),
    );
    this.marketHub = new MarketHubController(signalr, {
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      // No-op without Topstep: this stamps the token the Topstep SignalR
      // hub authenticates with, and there is no hub to stamp.
      setBrokerToken: (token) => this.topstepClient?.setToken(token),
      onTrade: (contractId, trade) => this.handleTrade(contractId, trade),
      swapTickHandler: (mode) => this.swapTickHandler(mode),
      reconnectUserHub: (trigger) => this.attemptUserReconnect(trigger),
      resetUserReconnectFailures: () => {
        this.userReconnectFailures = 0;
      },
      // Read `realtimeDeployments` at call time — a reconnect that lands
      // after a deployment edit must sync against the current set.
      realtimeDeployments: () => this.realtimeDeployments,
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      onBarClose: (key, bar, previousPublishedAt) => this.onBarClose(key, bar, previousPublishedAt),
      pendingBarCloseCount: () => this.pendingBarCloses.size,
      userHubState: () => this.topstepRealtime?.hubState(),
      userHubLiveness: () => this.topstepRealtime?.liveness(),
      brokerToken: () => this.topstepClient?.getToken() ?? null,
    });
    this.nakedWatchdog = new NakedPositionWatchdog({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      // Read at call time — a sweep must see deployments added or removed
      // since the interval was armed.
      realtimeDeployments: () => this.realtimeDeployments,
      isLegInExitLoop: (d) => this.isLegInExitLoop(d),
      isAccountRegistered: (a) => this.isAccountRegistered(a),
      stopCoverageSourceFor: (a) => this.pluginFor(this.brokerKindFor(a)).capabilities.stopCoverageSource,
      brokerForAccount: (a) => this.brokerForAccount(a),
      defaultTradovateClient: () => this.defaultTradovateClient(),
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      maybeOrphanFromBrokerError: (e, a) => this.maybeOrphanFromBrokerError(e, a),
      // Same attribution seam its sibling above uses: the plugin whose client
      // raised it answers, and an unattributed throw answers false — the loud
      // arm, which is the fail-safe direction on this path.
      rejectionProvesTerminal: (e) => this.pluginOwningError(e)?.rejectionProvesTerminal?.(e) ?? false,
      // The owning plugin's class for a failed flatten (A37): a refusal
      // releases the cooldown so the next tick retries; a timeout holds it.
      brokerErrorKind: (e) => this.pluginOwningError(e)?.classifyError(e) ?? null,
      buildCustomTag,
      flattenCooldown: this.flattenCooldown,
    });
    this.sessionGuard = new SessionEndGuard({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      // Read at call time, for the same reason the watchdog does.
      realtimeDeployments: () => this.realtimeDeployments,
      isLegInExitLoop: (d) => this.isLegInExitLoop(d),
      // `state.get`, not `getState` — a guard must not lazily create a state
      // entry for a deployment it is only inspecting. Synchronous by
      // requirement: see the note on `SessionGuardDeps`.
      stateFor: (id) => this.state.get(id),
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      placeExitOrder: (strategy, deployment, contract, position, activeTradeId, reason) =>
        this.placeExitOrder(strategy, deployment, contract, position, activeTradeId, reason),
      // The same instance the watchdog holds. Four flatten actors on one
      // position, and this is what lets each see the others' submission —
      // the watchdog's bypasses the latch, so nothing else can.
      flattenCooldown: this.flattenCooldown,
    });
    this.regimeLabels = new RegimeLabelController({
      // Read at call time, for the same reason the sweeps above do: the
      // deployment set changes under a job that runs once an hour.
      tickers: () => this.realtimeDeployments.map((d) => d.ticker),
      // **The one archive read in the engine, and it is deliberate.** The
      // classifier's warmup is 275 completed sessions; no broker here holds
      // that, and the one that was asked for it truncated to a month without
      // saying so (bugs.md A81). So the label reads the Parquet cache
      // directly — the same source, over the same coverage predicate, that
      // the backtest CLI reads, which is what keeps the two labels one claim.
      // On a clock, during the CME break, never from the tick path. See
      // engine-regime.ts and market-data/providers.md.
      readArchiveBars: (read) => fetchArchiveBars(read),
      logEvent: (event, message) => this.logEvent(event, ENGINE_CTX, message),
      log: (severity, category, message) => this.log(ENGINE_CTX, severity, category, message),
      announce: (sessionDate, labels) => notifyRegimeLabels(sessionDate, labels),
    });
    this.sessionCloseSampler = new SessionCloseSampler({
      // The engine consumes the registry's fan-out result and never calls a
      // broker client itself; the balances come off the same refresh that
      // rebuilds the routing table. An arm that threw is named rather than
      // silently missing, so the sampler can tell "this broker did not answer"
      // from "this account has no usable balance".
      refreshAccountBalances: async () => {
        const result = await this.refreshBrokerRegistry();
        const failedBrokers = new Set<BrokerKind>();
        if (result.errors.topstep != null) failedBrokers.add(BrokerKind.Topstep);
        if (result.errors.tradovate != null) failedBrokers.add(BrokerKind.Tradovate);
        return { balances: this.brokerRegistry.accountBalancesSnapshot(), failedBrokers };
      },
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      engineScope: ENGINE_CTX,
    });
    this.accountStatusJob = new AccountStatusJob({
      // The same registry fan-out the sampler consumes, read off its own
      // result — never off the registry or the client handles, which a
      // concurrent refresh can change during `refreshBrokerRegistry`'s later
      // awaits. The orphan pass runs over it because the refresh resets the
      // reconciler's clock.
      fanOut: registryStatusFanOut({
        refresh: () => this.refreshBrokerRegistry(),
        orphanAbsentAccounts: (result) => this.orphanAbsentAccountsAfter(result),
        // GET only, on the cached session token — never a mint.
        readTopstepAccounts: () => readTopstepTradingAccounts(),
        hasOpenPosition: (accountId) => this.hasOpenPositionOnAccount(accountId),
        logEvent: (event, message) => this.logEvent(event, ENGINE_CTX, message),
      }),
      logEvent: (event, message, subject) => this.logEvent(event, ENGINE_CTX, message, subject),
    });
    this.closingGuard = new ClosingGuard({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      listClosing: () => listClosingDeployments(),
      getDeployment: (id) => getDeployment(id),
      // The row itself, not a boolean: a closing row whose trade is still
      // `pending_entry` gets its entry order cancelled (A45).
      openTradeFor: (id) => getOpenTradeForDeployment(id),
      // Every live row, for the settle of a confirmed pending_entry (A45):
      // an older stranded row behind it blocks the settle.
      liveTradesFor: (id) => getReconcilableTrades().filter((t) => t.deploymentId === id),
      brokerForAccount: (a) => this.brokerForAccount(a),
      // `state.get`, not `getState` — same rule as the session guard.
      stateFor: (id) => this.state.get(id),
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      placeExitOrder: (strategy, deployment, contract, position, activeTradeId, reason) =>
        this.placeExitOrder(strategy, deployment, contract, position, activeTradeId, reason),
      // Bypasses the public `forceFlatDeployment` to pass `options`; the two must stay equivalent.
      forceFlat: (id, options) => forceFlatDeploymentImpl(this.forceFlatDeps(), id, options),
      settlePausing: (id) => settlePausingDeployment(id),
      reapDestroying: (id) => reapDestroyingDeployment(id),
      onSettled: (deployment, from) => this.onDeploymentSettled(deployment, from),
    });
    this.manualPositionGuard = new ManualPositionGuard({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      // Read at call time, for the same reason the three sweeps above do.
      realtimeDeployments: () => this.realtimeDeployments,
      // The *entry* gate, not `isLegInExitLoop`: D-11 scopes the claim to a
      // deployment the engine is trading.
      isLegEngineEnabled: (d) => this.isLegEngineEnabled(d),
      isAccountRegistered: (a) => this.isAccountRegistered(a),
      brokerForAccount: (a) => this.brokerForAccount(a),
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      reconcilableTrades: (accountId) => getReconcilableTrades(accountId),
      // Synchronous by requirement — it is re-read at the point of use, after
      // every await, and a promise here would put an await back in front of
      // the dispatch it gates.
      isContractLocked: (accountId, contractId) =>
        this.hasOpenPositionOnContract(accountId, contractId),
      placeExitOrder: (strategy, deployment, contract, position, activeTradeId, reason) =>
        // The one caller that declares a non-default intent. It closes a
        // position the engine did not open, so the post-exit verification
        // has no ownership evidence to scope its sweep to — by construction,
        // not by degradation (A49).
        this.placeExitOrder(
          strategy,
          deployment,
          contract,
          position,
          activeTradeId,
          reason,
          "unmanaged_position",
        ),
      // The same instance the watchdog holds. Four flatten actors on one
      // position, and this is what lets each see the others' submission.
      flattenCooldown: this.flattenCooldown,
    });
    this.restartGuard = new RestartFlattenGuard({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      getDeployment: (id) => getDeployment(id),
      hasOpenTrade: (id) => getOpenTradeForDeployment(id) != null,
      // The same row `hasOpenTrade` reads, for the instant it started. The
      // deployment id says which deployment is owed a flatten; only this says
      // which *position*, and the sweep can outlive the one it was seeded for.
      openTradeStartedAt: (id) => {
        const trade = getOpenTradeForDeployment(id);
        if (!trade) return null;
        const startedAt = Date.parse(trade.entrySubmittedAt);
        return Number.isFinite(startedAt) ? startedAt : null;
      },
      // `state.get`, not `getState` — same rule as the session and closing
      // guards, and synchronous for the same reason.
      stateFor: (id) => this.state.get(id),
      // Bounded by the size of the seeded set — one write at boot and one per
      // drain — so it needs no throttle. A failure is reported at error and
      // swallowed: the flatten still has to be attempted, and the cost of the
      // lost record is what the next boot will not know it owed.
      persistPending: (entries, gapMs) => {
        try {
          setPendingFlatten(entries, gapMs);
        } catch (err) {
          this.logEvent(
            "downtime_obligation_write_failed",
            ENGINE_CTX,
            // Consequence first, the unbounded body last: this event's
            // template is null, so the message *is* the Discord title and the
            // 256-cap lands wherever a SQLite error stops talking.
            `[RESTART] Could not persist the downtime-flatten obligation for ${entries.length} deployment(s) — ` +
              `a restart before the sweep drains would drop it. ` +
              `Database said: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      resolveContract: (ticker, accountId) => this.resolver.resolve(ticker, accountId),
      placeExitOrder: (strategy, deployment, contract, position, activeTradeId, reason) =>
        this.placeExitOrder(strategy, deployment, contract, position, activeTradeId, reason),
      // The same instance the watchdog holds. Four flatten actors on one
      // position, and this is what lets each see the others' submission.
      flattenCooldown: this.flattenCooldown,
    });
    this.health = new EngineHealth({
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      logEvent: (event, deploymentId, message, subject) =>
        this.logEvent(event, deploymentId, message, subject),
      lastFeedTickAt: () => this.marketHub.lastActivityAt(),
      subscribedContracts: () => this.marketHub.marketSubCount(),
      // Read at call time, for the same reason the guards do.
      inSessionWindow: (now) => anyDeploymentInSession(this.realtimeDeployments, now),
      managedAccounts: () => this.managedAccountsByBroker(),
      realtimeHealthy: (kind, accountId) =>
        this.brokerPluginRegistry.getPlugin(kind)?.realtime?.isHealthy(accountId) ?? false,
      entriesSuspended: () => this.entriesSuspended,
      alertDegraded: (entering, detail) => {
        void sendConnectionAlert({
          title: entering ? "Market data feed down — degraded mode" : "Market data feed restored",
          color: entering ? COLOR_CONNECTION_LOST : COLOR_CONNECTION_RESTORED,
          fields: [{ name: "Status", value: detail }],
        });
      },
    });
    this.attachRealtimeAdapters(signalr);
    this.wireRealtimeAdapters();
  }

  /**
   * Build each broker's account-event adapter and hand it to that
   * broker's plugin. Done here rather than inside the plugins because
   * both adapters need engine-owned collaborators the plugin has no
   * handle on — Topstep the process-wide `TopstepSignalR`.
   *
   * `signalr` is null when Topstep is unconfigured or realtime bars are
   * off; there is no user hub in either case, so Topstep gets no adapter
   * and the engine's realtime sync simply finds nothing to drive.
   *
   * **This is a constructor side effect on process-global plugins.** The
   * plugins outlive any one engine, so an incumbent adapter is shut down
   * and cleared before the replacement is attached — otherwise it keeps
   * its live sockets, Topstep's 30s reconnect interval and 1-hour reset
   * timer, and handler arrays still closed over the *previous* engine.
   * Production has one engine per process (`engine-singleton`), but that
   * invariant is held elsewhere, not here; dev HMR is the reproducer, and
   * two engines with handlers on adapters over one hub is the only shape
   * that can double a fill.
   */
  private attachRealtimeAdapters(signalr: TopstepSignalR | null): void {
    for (const plugin of this.brokerPluginRegistry.allPlugins()) {
      plugin.realtime?.shutdown();
      plugin.realtime = undefined;
    }
    // Plugin ids by literal. `BrokerKind` is a `const enum`, and under the
    // test transform (esbuild, isolatedModules) a member access is a live
    // read of `db/account-brokers` — which puts a DB module on the one
    // path every engine construction takes. The import at module scope is
    // free; the member access is not.
    const tradovatePlugin = this.brokerPluginRegistry.getPlugin("tradovate");
    if (tradovatePlugin) {
      tradovatePlugin.realtime = new TradovateRealtimeAdapter({
        getClient: () => this.defaultTradovateClient(),
        resolverSymbolLookup: (numericId) =>
          this.resolver.getTradovateSymbolForNumericId(numericId),
        enumerateWarmRoots: () => this.tradovateWarmRoots(),
        // The adapter's own lifecycle lines — subscriber spawned, start
        // failed, dispose failed. All `connection`; the frames it delivers
        // are classified where they are translated, in `engine-realtime`.
        log: (severity, message) => this.log(ENGINE_CTX, severity, "connection", message),
      });
    }
    if (!signalr) return;
    const adapter = new TopstepRealtimeAdapter(new SignalRUserHubTransport(signalr));
    this.topstepRealtime = adapter;
    const plugin = this.brokerPluginRegistry.getPlugin("topstep");
    if (plugin) plugin.realtime = adapter;
    this.broadcasterDepsValue = {
      userEvents: adapter,
      // The relay and the engine share one SignalR client and the wire has
      // no ref count. Refuse the unsubscribe while an aggregator still wants
      // the contract; otherwise a browser position closing takes the
      // engine's tick feed for that contract down with it, and
      // `syncContractSubs` will not re-subscribe because the `marketSubs`
      // entry never went away.
      marketTrades: {
        subscribe: (contractId) => signalr.subscribeTrades(contractId),
        unsubscribe: async (contractId) => {
          if (this.marketHub.hasMarketSub(contractId)) return;
          await signalr.unsubscribeTrades(contractId);
        },
      },
      marketDataContractId: (contractId) => this.marketDataContractId(contractId),
      engineStatus: () => engineStatusOf(this),
    };
  }

  /**
   * Unique contract roots for the Tradovate adapter's pre-warm. Reads the
   * DB account-broker table rather than the live registry: the registry
   * may be empty at boot or on a new-deployment add, and filtering by it
   * would skip the warm exactly when the burst it protects against is
   * about to arrive.
   */
  private tradovateWarmRoots(): string[] {
    const tradovateAccountIds = new Set(listAccountIdsForBroker(BrokerKind.Tradovate));
    const roots = new Set<string>();
    for (const d of listManagedDeployments()) {
      if (!tradovateAccountIds.has(d.accountId)) continue;
      const root = stripTradovateContinuousSuffix(d.ticker);
      if (root) roots.add(root);
    }
    return [...roots];
  }

  /** Built once and reused, unlike the other four deps builders.
   *
   *  `handleTrade` is the market hub's `onTrade` handler — it fires once per
   *  inbound trade frame per subscribed contract, which is three to five
   *  orders of magnitude hotter than `reconcileDeps` (15s tick), `exitDeps`
   *  (per exit) or `notifyDeps` (per embed). Rebuilding a 37-member object
   *  and its closures there is allocation the code did not do before this
   *  seam existed: it read `this.marketSubs` / `this.contractSubs` directly.
   *
   *  Caching is safe because every member is a late-binding arrow over
   *  `this` — a cached object still observes `vi.spyOn` replacements and any
   *  post-boot field write — and the single value member,
   *  `entryNotifiedTradeIds`, is assigned once at its declaration and never
   *  reassigned. **If that ever changes, this must become a getter**, or the
   *  cache pins a dead Set. */
  private realtimeDepsCache: RealtimeDeps | null = null;

  private realtimeDeps(): RealtimeDeps {
    return (this.realtimeDepsCache ??= {
      log: (d, sev, cat, m, s) => this.log(d, sev, cat, m, s),
      logEvent: (e, d, m, s) => this.logEvent(e, d, m, s),
      brokerForAccount: (a) => this.brokerForAccount(a),
      brokerKindFor: (a) => this.brokerKindFor(a),
      pluginIdFor: (k) => this.pluginFor(k).id,
      capabilitiesFor: (k) => this.pluginFor(k).capabilities,
      realtimeAdapters: () => this.realtimeAdapters(),
      realtimeEventsAllowed: (a) => this.realtimeEventsAllowed(a),
      noteRealtimeEvent: (a) => this.noteRealtimeEvent(a),
      replayFillsAfterReconnect: (a, le) => this.replayFillsAfterReconnect(a, le),
      handleUserPositionEvent: (p) => this.handleUserPositionEvent(p),
      handleUserPositionClose: (a, c) => this.handleUserPositionClose(a, c),
      appendBufferedFill: (k, a, f) => this.appendBufferedFill(k, a, f),
      stateFor: (id) => this.state.get(id),
      markEnteredThisSession: (d, k, s) => this.markEnteredThisSession(d, k, s),
      entryNotifiedTradeIds: this.entryNotifiedTradeIds,
      notifyEntry: (t, p, f, s) => this.notifyEntry(t, p, f, s),
      bufferSlotKey: (a, c, t) => TradingEngine.bufferSlotKey(a, c, t),
      bufferContractKey: (a, c) => TradingEngine.bufferContractKey(a, c),
      openBufferSlot: (a, c, t) => this.openBufferSlot(a, c, t),
      discardBufferSlot: (k) => this.discardBufferSlot(k),
      bufferSlotFor: (k) => this.fillBuffer.get(k),
      bufferSlots: () => this.fillBuffer.values(),
      slotKeyForContract: (k) => this.fillBufferByContract.get(k),
      recentDedupFor: (k) => this.recentDedupByContract.get(k),
      reconcileExitFromBuffer: (k, t) => this.reconcileExitFromBuffer(k, t),
      reconcileOneTrade: (t, a, o, ids, pos, pre) =>
        this.reconcileOneTrade(t, a, o, ids, pos, pre),
      healApproximatedExitFromFills: (t, a) => this.healApproximatedExitFromFills(t, a),
      validateClosedTradePrices: (t, a) => this.validateClosedTradePrices(t, a),
      lastTopstepEventAt: (a) => this.lastTopstepEventAt.get(a),
      noteTradeActivity: () => this.marketHub.noteTradeActivity(),
      noteMarketTrade: () => this.marketHub.noteMarketTrade(),
      marketSubFor: (c) => this.marketHub.marketSubFor(c),
      contractSubFor: (c, tf) => this.marketHub.contractSubFor(c, tf),
      evaluateRealtimeExits: (c, p) => this.evaluateRealtimeExits(c, p),
    });
  }

  /**
   * Register the engine's handlers on every adapter, once, at
   * construction. Broker-agnostic: the adapters have already translated
   * into `Order` / `Position` / `TradeFill`, and every handler is told
   * which account fired rather than inferring it from which adapter did.
   */
  private wireRealtimeAdapters(): void {
    return wireRealtimeAdaptersImpl(this.realtimeDeps());
  }

  /**
   * Whether this account's realtime events may act on engine state.
   *
   * Two semantics, and they stay distinct — collapsing them into the
   * process-wide flag alone resolves to the more permissive one:
   *
   * - A transport the engine's own `sync(new Set())` disposes delivers
   *   nothing once the engine stops, so the flag is the whole gate. It
   *   starts `true` because those subscribers have always spawned, and
   *   dispatched, from the boot registry refresh, before `start()` runs.
   * - A transport held up by someone else — Topstep's process-wide user
   *   hub, pinned by the browser's SSE relay — keeps delivering across a
   *   stop, so it additionally gates on `isRunning()`. Without that arm a
   *   zero-deployment boot brings the hub up through `ensureHubsReady()`
   *   and a manual flatten reaches `reconcileOneTrade` on a stopped
   *   engine — closing the row, emitting `strategyTrade` and cancelling a
   *   stale pending entry — where it used to be a no-op.
   */
  private realtimeEventsAllowed(accountId: number): boolean {
    if (!this.realtimeEventsEnabled) return false;
    const plugin = this.pluginFor(this.brokerKindFor(accountId));
    if (!plugin.capabilities.realtimeFeedOutlivesEngineStop) return true;
    return this.isRunning();
  }

  /** Every registered plugin's account-event adapter. */
  private realtimeAdapters(): BrokerRealtimeAdapter[] {
    const out: BrokerRealtimeAdapter[] = [];
    for (const plugin of this.brokerPluginRegistry.allPlugins()) {
      if (plugin.realtime) out.push(plugin.realtime);
    }
    return out;
  }

  /** Deps for the in-process SSE relay — see `broadcaster-singleton.ts`.
   *  Null when no broker has a realtime transport to relay from. */
  broadcasterDeps(): BroadcasterDeps | null {
    return this.broadcasterDepsValue;
  }

  /**
   * Per-account event-arrival anchor, used as the lower bound of the
   * reconnect-gap replay window. Position / order / fill all count as
   * evidence the feed is alive on this account.
   */
  private noteRealtimeEvent(accountId: number): void {
    if (this.pluginFor(this.brokerKindFor(accountId)).id !== "topstep") return;
    this.lastTopstepEventAt.set(accountId, Date.now());
  }

  /**
   * The adapter signals a reconnect; the engine decides what to replay.
   * Recovery policy is broker-agnostic and belongs here — putting it
   * inside each adapter would let the two brokers' recovery silently
   * diverge.
   *
   * Topstep's hub is process-wide, so **one** reconnect fires this once
   * per live account while the replay itself is a whole-engine sweep.
   * Two different things have to be told apart:
   *
   * - The N signals of a single reconnect. They arrive in one
   *   synchronous turn (`fireReconnect` is a plain loop), so the sweep
   *   yields once before starting and clears the queue flag they set.
   *   One reconnect, one sweep — unchanged.
   * - A **later** reconnect landing while that sweep is still running.
   *   The sweep is a `searchTrades` round-trip per account and a
   *   flapping hub reconnects well inside that window. Dropping it
   *   leaves its gap `[lastTopstepEventAt, now]` unqueried forever, so
   *   it queues exactly one follow-up that re-runs once the current
   *   sweep settles.
   *
   * **Deliberately still an identity branch after E5.** This is not one
   * behaviour selected by a flag: it is two whole recovery policies with
   * different window sources (`lastTopstepEventAt` here, the pre-drop
   * anchor the signal carries there) and different fan-out (one coalesced
   * whole-engine sweep vs. one per account). A flag at the dispatch would
   * leave both bodies broker-named and still filtering on identity
   * internally — an interface member that removes no coupling. Unifying
   * them is its own change, with its own review.
   *
   * `lastEventAtBeforeReconnect` is the Tradovate replay's window anchor,
   * carried on the reconnect signal; the Topstep coalesced sweep sources
   * its own lower bound and ignores it.
   */
  private async replayFillsAfterReconnect(
    accountId: number,
    lastEventAtBeforeReconnect: number,
  ): Promise<void> {
    if (this.pluginFor(this.brokerKindFor(accountId)).id === "tradovate") {
      await this.replayTradovateFillsAfterReconnect(accountId, lastEventAtBeforeReconnect);
      return;
    }
    if (this.topstepReplayInflight) {
      this.topstepReplayQueued = true;
      return this.topstepReplayInflight;
    }
    this.topstepReplayInflight = this.runTopstepReplaySweeps().finally(() => {
      this.topstepReplayInflight = null;
      this.topstepReplayQueued = false;
    });
    return this.topstepReplayInflight;
  }

  private async runTopstepReplaySweeps(): Promise<void> {
    // Yield once so the rest of this reconnect's per-account signals land
    // on the in-flight promise first. After this point the flag can only
    // have been set by a reconnect that is genuinely later.
    await Promise.resolve();
    do {
      this.topstepReplayQueued = false;
      await this.replayTopstepFillsAfterReconnect();
    } while (this.topstepReplayQueued);
  }

  /**
   * Desired-state sync of every broker's account-event adapter.
   * Idempotent — safe from engine boot, after a registry refresh, and
   * from `applySync()`.
   */
  private async syncRealtimeAdapters(): Promise<void> {
    for (const plugin of this.brokerPluginRegistry.allPlugins()) {
      const adapter = plugin.realtime;
      if (!adapter) continue;
      // `plugin.id` is a plain string on the interface. A cast would send
      // a third broker's adapter down `desiredRealtimeAccounts`' Topstep
      // branch — the deployment-account scope — silently.
      const kind = brokerKindForPluginId(plugin.id);
      if (!kind) {
        this.log(
          ENGINE_CTX,
          "warn",
          "broker",
          `Realtime sync skipped for "${plugin.id}": no BrokerKind for that plugin id — the adapter has no desired-account scope`,
        );
        continue;
      }
      try {
        await adapter.sync(this.desiredRealtimeAccounts(kind));
      } catch (err) {
        this.log(
          ENGINE_CTX,
          "warn",
          "connection",
          `Realtime sync failed for ${plugin.id}: ${err instanceof Error ? err.message : String(err)} — polling fallback only`,
        );
      }
    }
  }

  /**
   * Which accounts this broker's adapter should be streaming.
   *
   * The two scopes are genuinely different and stay that way. A
   * per-account transport (`"registered"`) costs one connection per
   * account either way, so the registry's membership list is the right
   * set. A shared hub (`"traded"`) carries every account the credential
   * can see on one connection, so the engine subscribes only the accounts
   * it trades — widening it would flood the engine with events for
   * accounts no deployment touches.
   */
  private desiredRealtimeAccounts(kind: BrokerKind): Set<number> {
    if (this.pluginFor(kind).capabilities.realtimeAccountScope === "registered") {
      return new Set(this.brokerRegistry.accountIdsForKind(kind));
    }
    const out = new Set<number>();
    for (const d of this.realtimeDeployments) {
      if (this.brokerRegistry.brokerKind(d.accountId) === kind) out.add(d.accountId);
    }
    return out;
  }

  /** Release the engine's interest in every adapter without disturbing
   *  other holders. `engine.stop()` uses this: the browser's SSE relay
   *  keeps Topstep's hub up for its own panels, exactly as before. */
  private releaseRealtimeAdapters(): void {
    for (const adapter of this.realtimeAdapters()) {
      void adapter.sync(new Set()).catch(() => {});
    }
  }

  /** Current default Tradovate REST client, or null when none configured.
   *  Single source of truth for all engine callers that need the client.
   *  Hot-swapped by `reloadTradovateClients()`. */
  private defaultTradovateClient(): TradovateClient | null {
    return this.tradovateClients.get(DEFAULT_TRADOVATE_BUNDLE_ID) ?? null;
  }

  /** Reverse-lookup: given a Tradovate execution contractId (e.g. "MNQM6"),
   *  return the Topstep contractId (e.g. "CON.F.US.MNQ.M26") if the engine
   *  has already resolved that contract. Sub-scoped, so it answers only for
   *  a contract some deployment currently holds a sub on — prefer
   *  `marketDataContractId`, which falls back to a resolve, unless the
   *  caller genuinely cannot await. */
  getTopstepContractId(executionContractId: string): string | null {
    for (const [topstepId, sub] of this.marketHub.marketSubEntries()) {
      if (sub.contract.executionContractId === executionContractId) {
        return topstepId;
      }
    }
    return null;
  }

  /**
   * The id a contract's **market data** arrives under, given any identifier
   * the browser or a broker feed might name it by. `"MNQM6"` →
   * `"CON.F.US.MNQ.M26"`; a Topstep id answers itself.
   *
   * `getTopstepContractId` alone is a scan of live market subs, so it goes
   * blank for exactly the contracts that need it most: a manual position, or
   * one stranded on a paused deployment, has no sub for the scan to find.
   * The fallback derives the product from the symbol, resolves it through
   * the same Topstep resolver every deployment uses (cached, 15-minute TTL),
   * and **verifies both the expiry and the product before answering** — the
   * resolver returns the front month, and a position on a back month must
   * produce no mark rather than one taken off the wrong contract.
   *
   * Null is "cannot tell": an unparseable identifier, a product this install
   * does not map, or a resolver that cannot answer. Callers render nothing.
   */
  async marketDataContractId(contractId: string): Promise<string | null> {
    // Dotted (CON.F.US.MNQ.M26) and hyphenated (NQ-2026) are Topstep's own
    // shapes — already market-data identity, nothing to translate.
    if (contractId.includes(".") || contractId.includes("-")) return contractId;
    const fromSub = this.getTopstepContractId(contractId);
    if (fromSub) return fromSub;
    const ticker = tickerSymbolForContractId(contractId);
    if (!ticker) return null;
    // `sameContractMonth` is product-blind by design, and two products' front
    // months share a month code most of the time — so a `TICKER_CONTRACT_MAP`
    // row whose `search` drifted to a sibling would answer with that
    // product's contract, and this id is what becomes the operator's P&L
    // mark. The row is picked from the identifier's own root, so check that
    // root back against the row's own fields. **Only the `search` half can
    // ever fail**: `tickerSymbolForContractId` matches `map.root` first, so a
    // row selected through that arm satisfies `root === map.root` by
    // construction, and the check bites only on the seven rows reached
    // through the key arm (`GCZ6` → `GC` → `/GC`). It cannot see a corrupted
    // `root` that names a sibling the correct `search` still returns —
    // `/GC = {search:"GC", root:"MGC"}` resolves the micro's front month and
    // passes here. Pure, so it runs ahead of the Topstep round trip.
    const root = productRootFromContractId(contractId);
    const map = TICKER_CONTRACT_MAP[ticker];
    if (root !== map.search && root !== map.root) return null;
    try {
      const contract = await this.resolver.resolveMarketData(ticker);
      if (!sameContractMonth(contract.id, contractId)) return null;
      return contract.id;
    } catch {
      return null;
    }
  }

  /**
   * Hot-reload the Tradovate REST client from the singleton's cached
   * value. Called from the /api/settings save path so a freshly-saved
   * (or removed) credential set takes effect without a container
   * restart. Idempotent: passing the same client through is a no-op for
   * the registry/refresh path, and a freshly-disabled credential
   * clears the map + propagates `null` so subsequent ticks skip
   * Tradovate fan-out entirely.
   *
   * The singleton owns auth/caching; this method just shuffles the
   * already-authenticated client into the engine's map + broker
   * registry, then triggers a registry refresh so the per-account
   * routing table picks up any newly-visible Tradovate accounts.
   */
  async reloadTradovateClients(): Promise<void> {
    const { getTradovateClientIfConfigured } = await import("./engine-singleton");
    const client = await getTradovateClientIfConfigured();
    this.tradovateClients.clear();
    if (client) {
      this.tradovateClients.set(DEFAULT_TRADOVATE_BUNDLE_ID, client);
    }
    this.brokerRegistry.updateTradovateClient(client);
    // Before the refresh: it can tag an account Tradovate, and the next
    // resolve of that account must find a client.
    this.resolver.setTradovateClient(client);
    await this.refreshBrokerRegistry();
  }

  /**
   * Per-account broker routing — Phase 4. Pre-entry decisions ride on
   * `deployment.accountId`; post-entry/SAFETY paths that only have an
   * accountId in scope use `brokerForAccount`. Both throw a scoped engine
   * error if the registry doesn't know the account, so a single
   * misregistered deployment can't silently route to the wrong broker.
   *
   * Carve-outs that bypass this (per plan §0): `retrieveBars`,
   * `getToken`/`setToken`, and the `searchAccounts` catalog refresh stay
   * on `this.topstepClient` directly. The registry itself fans out to
   * both brokers; the engine only consumes the *result*.
   *
   * **The one order gate is here**: the broker comes back with `placeOrder`,
   * `cancelOrder` and `modifyOrder` refused without the engine lease
   * (`lease-gated-broker.ts`), so every exit, stop move, bracket and cancel
   * any satellite makes asks it at the wire.
   */
  private brokerFor(deployment: Deployment): Broker {
    return this.brokerForAccount(deployment.accountId);
  }

  private brokerForAccount(accountId: number): Broker {
    const broker = this.brokerRegistry.get(accountId);
    if (!broker) {
      throw new Error(
        `No broker registered for account ${accountId} — broker registry refresh may have lost it (or it was never added). Engine refusing to route.`,
      );
    }
    return leaseGatedBroker(broker, accountId, this.mayReachOrders);
  }

  /** Trigger a registry fan-out. Surface to engine boot + the periodic
   *  refresh path; alerts on a partial failure only when the broker that
   *  failed was one this install expects to have. Returns the
   *  RefreshResult so callers (e.g. check-orphans route) can inspect
   *  partial-failure state before acting on registry contents. */
  async refreshBrokerRegistry(): Promise<RefreshResult> {
    const result = await this.brokerRegistry.refresh();
    // Through `this.log`, not `log.*`: a re-route of live order flow has to
    // survive the process. `engine_logs` is what /logs renders and what an
    // incident is reconstructed from, and the 2026-08-26 mis-routing was
    // un-diagnosable precisely because every broker-registry line was
    // console-only. A first sighting is normal and stays quiet; a change on
    // an existing mapping never is.
    for (const change of result.kindChanges) {
      this.logEvent(
        "broker_route_changed",
        ENGINE_CTX,
        `Broker routing changed for account ${change.accountId}${change.name ? ` (${change.name})` : ""}: ` +
          `${change.from} → ${change.to}. Every order for this account now resolves its contract through ${change.to}.`,
        { accountId: change.accountId },
      );
    }
    await notifyRefreshFailures(result, this.tradovateAlertEpisode);
    // Warm the local name cache so the reconciler's namesEmpty gate doesn't
    // fire a second searchAccounts on the first tick after boot.
    const snapshot = this.brokerRegistry.accountNamesSnapshot();
    for (const [id, name] of snapshot) this.accountNames.set(id, name);
    this.accountNamesRefreshedAt = Date.now();
    this.brokerRegistryLastAttemptAt = Date.now();
    // After the registry settles, reconcile every broker's account-event
    // adapter against the new membership — a freshly-added account joins
    // the feed, a removed one is released.
    void this.syncRealtimeAdapters();
    return result;
  }

  /**
   * True when this account's realtime feed is fresh enough that the
   * reconciler tick can skip its per-account REST fan-out.
   *
   * Deliberately **not** `adapter.isHealthy()` alone. A healthy transport
   * is not the same claim as "REST reconciliation can be skipped", so the
   * capability carries the second claim and health only narrows it. A
   * broker whose feed does not drive reconciliation never skips, however
   * healthy its socket is.
   */
  private realtimeSuppressesPolling(accountId: number): boolean {
    const plugin = this.pluginFor(this.brokerKindFor(accountId));
    if (!plugin.capabilities.realtimeDrivesReconciliation) return false;
    return plugin.realtime?.isHealthy(accountId) ?? false;
  }

  /** Engine-boot consumer for the broker-kind registry tag. Used by
   *  `runBootSequence` and internal tests / diagnostics — keep it as a
   *  stable surface. */
  brokerKindFor(accountId: number): BrokerKind {
    return this.brokerRegistry.brokerKind(accountId);
  }

  /**
   * Accounts the engine currently manages, grouped by the broker that routes
   * them. The per-broker half of D-8's seam model: orders and positions are
   * per *account*, fills and position events are per *broker*, so the health
   * read needs both the grouping and the ids.
   *
   * Built from `realtimeDeployments` at call time rather than cached — a
   * deployment added or removed since the last read must be visible, and the
   * set is a handful of entries.
   */
  private managedAccountsByBroker(): ReadonlyMap<BrokerKind, ReadonlySet<number>> {
    const out = new Map<BrokerKind, Set<number>>();
    for (const deployment of this.realtimeDeployments) {
      const kind = this.brokerKindFor(deployment.accountId);
      const existing = out.get(kind);
      if (existing) existing.add(deployment.accountId);
      else out.set(kind, new Set([deployment.accountId]));
    }
    return out;
  }

  /** Per-seam health snapshot. Synchronous and makes no broker call, which
   *  is the property that lets the status route and the engine's own gate
   *  read the same answer. */
  getSeamHealth(): SeamHealthSnapshot {
    return this.health.snapshot();
  }

  /** Deployment id → setup note, for every leg whose setup is armed. */
  getSetupReadings(): Record<string, string> {
    return this.setupReadings.snapshot();
  }

  private pluginFor(kind: BrokerKind): BrokerPlugin {
    const plugin = this.brokerPluginRegistry.getPlugin(kind);
    if (!plugin) {
      throw new Error(`No broker plugin registered for kind "${kind}"`);
    }
    return plugin;
  }

  // ── Layer 1 buffer (hub-first exit reconciliation) ──────────────────
  // docs/proposals/userhub-trade-subscription.md.

  private static bufferSlotKey(accountId: number, contractId: string, tradeId: number): string {
    return `${accountId}:${contractId}:${tradeId}`;
  }

  private static bufferContractKey(accountId: number, contractId: string): string {
    return `${accountId}:${contractId}`;
  }

  /**
   * Open a buffer slot for an in-flight trade. Idempotent — re-opening
   * for the same (accountId, contractId, tradeId) is a no-op so both
   * the trade-row-creation hook and the cold-start "open opportunistically"
   * path can call it freely.
   *
   * Per the proposal §Buffer lifecycle: slot opens at trade-row creation
   * (BEFORE markEntryFilled) so fills arriving in the cold-start race
   * window land in a slot rather than being dropped.
   *
   * `openedAtMs` overrides the default `Date.now()` stamp. The restart
   * rehydrate path passes the trade's `entryFilledAt` so the pre-drain
   * assertion (`slot.openedAt <= trade.entryFilledAt`) stays valid for
   * slots reconstructed after the engine restarted mid-trade — without
   * this, Layer 1 always drops post-restart slots and Tradovate exits
   * silently fall through to the bar-close approximation.
   */
  private openBufferSlot(
    accountId: number,
    contractId: string,
    tradeId: number,
    openedAtMs?: number,
  ): void {
    const slotKey = TradingEngine.bufferSlotKey(accountId, contractId, tradeId);
    if (this.fillBuffer.has(slotKey)) return;
    this.fillBuffer.set(slotKey, {
      accountId,
      contractId,
      tradeId,
      openedAt: openedAtMs ?? Date.now(),
      fills: [],
      dedup: new Set(),
    });
    this.fillBufferByContract.set(
      TradingEngine.bufferContractKey(accountId, contractId),
      slotKey,
    );
  }

  /** Discard a slot by key. Used in the post-drain `finally` and at
   *  engine.stop(). Removes both the slot and the (account, contract)
   *  reverse-index entry. The slot's dedup set folds into the recent-
   *  redelivery LRU for that (accountId, contractId) so a fill that
   *  re-arrives after the slot is gone is detected as cross-slot
   *  redelivery and dropped at warn instead of being accepted into the
   *  next trade's fresh slot. */
  private discardBufferSlot(slotKey: string): void {
    const slot = this.fillBuffer.get(slotKey);
    if (!slot) return;
    this.fillBuffer.delete(slotKey);
    const contractKey = TradingEngine.bufferContractKey(slot.accountId, slot.contractId);
    if (this.fillBufferByContract.get(contractKey) === slotKey) {
      this.fillBufferByContract.delete(contractKey);
    }
    if (slot.dedup.size === 0) return;
    let recent = this.recentDedupByContract.get(contractKey);
    if (!recent) {
      recent = new Set();
      this.recentDedupByContract.set(contractKey, recent);
    }
    for (const k of slot.dedup) recent.add(k);
    while (recent.size > TradingEngine.RECENT_DEDUP_MAX_PER_CONTRACT) {
      const oldest = recent.values().next();
      if (oldest.done) break;
      recent.delete(oldest.value);
    }
  }

  private discardAllBufferSlots(): void {
    this.fillBuffer.clear();
    this.fillBufferByContract.clear();
    this.recentDedupByContract.clear();
  }

  /**
   * Single entry point for broker adapters delivering normalized
   * `TradeFill` events into the Layer 1 buffer.
   *
   * Owns:
   *  - dedup on `(brokerKind, accountId, fill.id)` (slot-scoped),
   *  - slot-existence check + cross-slot redelivery warn-and-drop,
   *  - the cold-start "open opportunistically" rule — open a slot on
   *    first fill event for `(accountId, contractId)` if a trade row
   *    exists at that key (folded with row-creation slot opening; both
   *    idempotent).
   */
  private appendBufferedFill(
    brokerKind: BrokerKind,
    accountId: number,
    fill: TradeFill,
  ): void {
    return appendBufferedFillImpl(this.realtimeDeps(), brokerKind, accountId, fill);
  }

  private isClosingFill(
    brokerKind: BrokerKind,
    fill: TradeFill,
    trade: StrategyTrade,
  ): boolean {
    return isClosingFillImpl(
      { pluginFor: (kind) => this.pluginFor(kind) },
      brokerKind,
      fill,
      trade,
    );
  }

  /**
   * Drain the buffer slot for `trade` and reconcile the closing fills
   * into a `{exitPrice, pnlDollars, pnlTicks, feesDollars, exitFilledAt,
   * matchedOrderId}` payload — same shape `resolveExitFromFills` returns
   * — so the existing close path can consume it via the optional
   * `preResolvedExit` arm of `reconcileOneTrade`.
   *
   * Returns null when:
   *  - no slot exists for this trade,
   *  - the pre-drain assertion fails (slot opened after entry-filled),
   *  - the predicate matches zero fills,
   *  - the price-math PnL fallback fires but the trade row is missing
   *    the data (`entryPrice` / `tickSize` / `tickValue`) needed to run
   *    the math.
   * Caller is responsible for falling through to Layer 2 in those cases.
   *
   * Per the proposal §Layer 1 — buffer drain + §Per-broker PnL and fees
   * sourcing: sum sizes, weighted-average price. PnL sourcing forks per
   * broker:
   *   - Topstep — every closing `TradeFill` carries `profitAndLoss`
   *     inline; sum across fills for gross PnL.
   *   - Tradovate — `TradeFill.profitAndLoss` is null on every fill
   *     (Tradovate doesn't emit per-fill PnL on its WS stream); compute
   *     gross from price math `(weightedExit - entryPrice) * direction
   *     * tickValue/tickSize * totalSize`. Mirrors the bar-close
   *     approximation path's gross-PnL math (engine.ts:6051-6054) and
   *     `validateClosedTradePrices`'s delayed-PnL fallback.
   *
   * If ANY fill in the closing set has `profitAndLoss === null` the
   * routine takes the price-math path — mixing inline-PnL fills with
   * computed-PnL fills risks fee-attribution drift, and per Gate B the
   * Tradovate stream is null-on-every-fill so the mixed case isn't
   * actually expected in production.
   *
   * Fee math mirrors `resolveExitFromFills` — published per-side rate
   * via `feePerSideFor(ticker)`, not per-fill `fees`. PnL net-of-fees
   * is comparable to the Layer 2 path so the soak disagreement metric
   * isn't biased by the fee-source split.
   */
  private reconcileExitFromBuffer(
    brokerKind: BrokerKind,
    trade: StrategyTrade,
  ): {
    exitPrice: number;
    pnlDollars: number;
    pnlTicks: number;
    feesDollars: number;
    exitFilledAt: string;
    matchedOrderId: number | null;
  } | null {
    return reconcileExitFromBufferImpl(this.reconcileDeps(), brokerKind, trade);
  }

  /**
   * Topstep reconnect-gap REST replay per
   * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation.
   *
   * For each active buffer slot belonging to a Topstep account, fire one
   * `broker.searchTrades(...)` over `[lastEventReceivedAt, now + 60s
   * pad]`, capped at 24h. Backfill via `appendBufferedFill` (idempotent
   * on the slot's dedup key). Beyond the 24h cap, fall through to
   * Layer 2/3 cold-start paths instead.
   */
  private async replayTopstepFillsAfterReconnect(): Promise<void> {
    return replayTopstepFillsAfterReconnectImpl(this.realtimeDeps());
  }

  /**
   * Tradovate reconnect-gap REST replay per
   * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation.
   * Tradovate analog of `replayTopstepFillsAfterReconnect`. Fired by the
   * adapter's `onReconnect` signal when its subscriber transitions back
   * to `subscribed` after a prior subscribe — which happens after any
   * inbound-silence reconnect, defensive token-refresh reconnect, or
   * socket-close reconnect. The signal is the transport's; the policy
   * below is the engine's.
   *
   * Window source: `lastEventAtBeforeReconnect`, the lower bound of the gap
   * the adapter carries on the reconnect signal — the new socket's
   * handshake has already bumped live `status(accountId).lastEventAt` to
   * ~now. Backfill fires `searchTrades` over `[lastEventAt, now + 60s pad]`,
   * capped at 24h. Beyond the cap, fall through to Layer 2/3 cold-start
   * paths. Backfill via `appendBufferedFill('tradovate', ...)` — idempotent
   * on the slot's dedup key so any fills already received via the WS
   * post-resubscribe are silently de-duped.
   */
  private async replayTradovateFillsAfterReconnect(
    accountId: number,
    lastEventAtBeforeReconnect: number,
  ): Promise<void> {
    return replayTradovateFillsAfterReconnectImpl(
      this.realtimeDeps(),
      accountId,
      lastEventAtBeforeReconnect,
    );
  }

  /** Boot helper consults this to spot deployments whose accountId
   *  vanished between sessions (combine→XFA, expired sim) — true iff
   *  any registered broker reported the account in the latest refresh. */
  isAccountRegistered(accountId: number): boolean {
    return this.brokerRegistry.has(accountId);
  }

  setLogHandler(handler: LogHandler): void {
    this.onLog = handler;
    this.onLogThrowReported = false;
  }

  /**
   * Hand a finished record to the installed handler, never letting it throw.
   * `log`/`logEvent` are called from `.catch` arms and void-dispatched
   * promises, where a throw is a second unhandled rejection and terminates
   * Node. `emit` has already stored the record, so a swallowed throw loses only
   * the ring push. Said once per installed handler on the console, because the
   * handler is the thing that is broken.
   */
  private deliverToLogHandler(record: LogRecord): void {
    try {
      this.onLog?.(record);
    } catch (err) {
      if (this.onLogThrowReported) return;
      this.onLogThrowReported = true;
      console.error("[engine] log handler threw; further throws from it are swallowed:", err);
    }
  }

  /**
   * Bring up market hub + user hub independently of the deployment-tick
   * loop. Called from the boot helper so the dashboard's account/positions/
   * orders panels (which depend on user-hub fan-out via SSE) light up
   * immediately after auth, even when zero deployments are enabled.
   *
   * Without this, an operator who completes the wizard before configuring
   * any deployments lands on a dashboard whose first-render fetches race
   * against an unbuilt hub and surface as "Auth failed". Hubs always come
   * up after creds resolve; only the per-tick loop stays gated on
   * enabled-deployment count.
   *
   * Idempotent: market-hub guarded by `marketHub.isReady()`; user-hub guarded
   * by the broadcaster's own `userHubStarted` check inside connectUserHub.
   * Concurrent callers (wizard activation + SSE route mount) collapse via
   * the in-flight promise on each side.
   */
  async ensureHubsReady(): Promise<HubReadiness> {
    if (!this.signalr) return { attempted: false, market: false, user: false };
    if (!this.marketHub.isReady()) {
      try {
        await this.marketHub.connect();
      } catch (err) {
        // `error`, not `warn`. A hub that could not be *constructed* is not
        // a transient reconnect — on the 2026-08-26 staging boot both threw
        // `Cannot find module 'tough-cookie'` and the container ran with no
        // market data and no account events. The reconnect loop's own
        // retries are the `warn`-level thing; this is the one that says the
        // feed never came up at all (A56).
        this.logEvent(
          "hub_init_failed",
          ENGINE_CTX,
          `ensureHubsReady: market hub init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const broadcaster = getBroadcaster(this.broadcasterDepsValue);
    if (broadcaster) {
      try {
        await broadcaster.ensureRunning([], []);
      } catch (err) {
        this.logEvent(
          "hub_init_failed",
          ENGINE_CTX,
          `ensureHubsReady: user hub init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Read after the attempts, so this is a reading rather than a claim.
    // `broadcaster` is non-null on every path that reaches here — the deps it
    // needs are set on the same `signalr` condition guarded at the top — so
    // the `??` is the type's shape, not a third state. See `HubReadiness`.
    return {
      attempted: true,
      market: this.marketHub.isReady(),
      user: broadcaster?.getConnectedState() ?? false,
    };
  }

  /** True when both hubs the dashboard depends on are connected. The
   *  wizard's polling readiness gate uses this to defer the post-setup
   *  redirect until SSE-backed panels can render without racing the
   *  hub-init handshake. */
  areHubsReady(): boolean {
    if (!this.signalr) {
      // Realtime bars off — nothing to wait on, REST-only path is the
      // happy state.
      return true;
    }
    const broadcaster = peekBroadcaster();
    return this.marketHub.isReady() && (broadcaster?.getConnectedState() ?? false);
  }

  /**
   * Drop the accountId→name cache and force the next reconciler tick to
   * re-fetch under whatever credentials are currently active. Called from
   * the `/api/settings` PUT handler when Topstep username/apiKey change so
   * the engine doesn't keep a stale roster from the prior login until the
   * 30-min TTL expires.
   */
  invalidateAccountNames(): void {
    this.accountNames.clear();
    this.accountNamesRefreshedAt = 0;
  }

  /**
   * Hand the boot's restart verdict to the engine. Called from
   * `runBootSequence` **before** `start()`, which matters for both halves:
   * the suppression latch has to be set before the priming tick can evaluate
   * anything, and `start()` is what arms the flatten sweep.
   *
   * `owed` is what the sweep must drain: the deployments that were holding a
   * position while nobody was managing it — read from the trade rows at boot,
   * so no broker call is needed to decide — **unioned with whatever a previous
   * boot recorded and never finished.** The gap comes with the set rather than
   * off the verdict, because the boot that acts on an obligation is not
   * necessarily the boot that measured it, and reporting this boot's 30-second
   * restart against a four-hour outage's obligation is a lie in the one log
   * line an operator reads after finding a position force-closed.
   *
   * **The verdict decides what this boot *adds*; it does not decide whether
   * there is anything owed.** That split is why there is no `verdict.flatten`
   * check here: a boot that classifies "keep" can still be carrying an
   * obligation the previous boot took on, and dropping it on that ground is
   * exactly the failure the durable set exists to close.
   *
   * **`signalSuppressed = true` is D-14, and it is set only on the
   * deployments the duration rule is about to flatten.** The latch already
   * distinguishes "is true" from "just became true" — it clears only when
   * `shouldEnter` returns plain null — never on a skip — i.e. once conditions
   * have genuinely reset — but its lifetime is backwards for this purpose, because
   * `applySync` dropping state and `getState` re-initialising it is precisely
   * how a restart clears it. Setting it here inverts that for exactly the
   * deployments whose flatten was involuntary, so the first post-resume
   * evaluation cannot fire on a signal that was already standing before the
   * outage. It is deliberately **not** applied to deployments that were flat
   * across the gap: nothing of theirs was involuntarily closed, and blocking a
   * genuine setup on the reconciled series is a cost D-14 does not ask for.
   */
  applyRestartVerdict(verdict: RestartVerdict, owed: PendingFlatten): void {
    this.restartVerdictApplied = true;
    this.entriesSuspended = verdict.entriesSuspended;
    if (verdict.entriesSuspended) {
      // `log.*` is console-only; `this.log` is the only path that reaches
      // `engine_logs` and therefore the operator. Without this line a
      // suspended engine is indistinguishable in the UI from one whose
      // strategy simply is not firing: every leg renders `Active`, never
      // enters, and the per-tick skip is a `debug` behind a tag. The flap
      // breaker is deliberately not a deployment status (see the Decisions
      // entry), so this log line is its entire operator-visible surface.
      this.logEvent(
        "flap_breaker_tripped",
        ENGINE_CTX,
        `[RESTART] Flap breaker tripped (${verdict.flapCycles} crash-resume cycles in the window) — ` +
          "open positions keep being managed, but no new entries will be taken for the life of this process",
      );
    }
    this.seedOwedFlatten(owed);
  }

  /** True once the obligation has been handed over in this process, by either
   *  door. The boot path reads it to decide whether to compute a candidate set
   *  at all: the verdict is memoised while `getAllOpenTrades()` is not, so a
   *  second application would meet a 09:00 outage's verdict with a position
   *  opened at 14:15. */
  hasAppliedRestartVerdict(): boolean {
    return this.restartVerdictApplied;
  }

  /**
   * The obligation applies at **every** engine entry point, not just the boot
   * path's — the same rule the deployment and account allowlists follow.
   *
   * `runBootSequence` hands the verdict over after seven early returns, and
   * two callers reach `start()` without it: `maybeAutoStart` and
   * `action: "start"` on `/api/engine`. The reachable sequence needs no race —
   * a long outage with the broker unreachable orphans every account,
   * `listManagedDeployments()` comes back empty, boot returns having applied
   * nothing (correctly: it never computed a candidate set), the broker
   * recovers, and the operator re-enables from the UI. Without this the sweep
   * is never armed, D-14's suppression is never latched, and the durable
   * obligation sits in the database unread until some later boot.
   *
   * **It can only restore the durable half.** The flap breaker lives on the
   * boot verdict, and re-classifying here is exactly what the memo forbids: a
   * second classification finds the marker consumed and the heartbeat freshly
   * stamped, and reads a running engine as a crash. So this seeds what the
   * database still owes, latches the same flag the boot path does — one owner
   * for the obligation, and a later boot must not re-apply a stale verdict to
   * a freshly recomputed set — and says at `error` that the rest of the
   * verdict was never read this process.
   *
   * **The latch is set at the point of application**, below both no-op arms:
   * an unreadable obligation and an empty one have handed nothing over, and
   * latching on either closes the boot door against a verdict that has not
   * been applied yet.
   */
  private ensureRestartVerdictApplied(): void {
    if (this.restartVerdictApplied) return;
    let owed: PendingFlatten;
    try {
      owed = readOwedFlatten();
    } catch (err) {
      this.logEvent(
        "downtime_obligation_unreadable",
        ENGINE_CTX,
        `[RESTART] Could not read the outstanding downtime-flatten obligation on start — ` +
          `a position owed a flatten may be left open. ` +
          `Database said: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (owed.entries.length === 0) return;
    // Latched here and nowhere earlier: the two paths above applied nothing,
    // and a latch set on a transient SQLITE_BUSY closes the boot door for the
    // life of the process — a later `runBootSequence` carrying a live
    // `flatten` verdict reads `hasAppliedRestartVerdict()` and hands over
    // nothing.
    this.restartVerdictApplied = true;
    this.logEvent(
      "downtime_obligation_resumed_without_verdict",
      ENGINE_CTX,
      `[RESTART] Started with ${owed.entries.length} deployment(s) still owed a downtime flatten ` +
        `after ${formatGapDuration(owed.gapMs)} unmanaged, and no boot verdict was applied this process — ` +
        "resuming the sweep. The flap breaker was not evaluated, so entries are not suspended.",
    );
    this.seedOwedFlatten(owed);
  }

  /** The durable half of the hand-over, shared by both doors above. */
  private seedOwedFlatten(owed: PendingFlatten): void {
    if (owed.entries.length === 0) return;
    this.restartGuard.markUnmanaged(owed.entries, owed.gapMs);
    for (const entry of owed.entries) {
      this.getState(entry.deploymentId).signalSuppressed = true;
    }
  }

  /**
   * Stamp the heartbeat D-13's duration rule reads on the next boot. Called
   * from both tick bodies *before* the `ticking` guard: a tick skipped because
   * the previous one is still running is an engine that is very much alive,
   * and reading it as absence is how a busy reconciler would manufacture a
   * flatten.
   *
   * One single-row UPDATE by integer primary key per `REST_TICK_MS`. A failure
   * is warned about at most once per `HEARTBEAT_WRITE_WARN_MS` and never
   * propagates — a SQLite hiccup must not take down the tick.
   *
   * **The cost of a missed stamp is not a slightly wider gap; it is a
   * manufactured flatten**, which is why the failure arm records rather than
   * only warning. `classifyRestart` cannot tell "absent for twelve minutes"
   * from "running and could not write", so twelve minutes of failed writes on
   * a healthy, trading engine reads on the next boot as twelve minutes of
   * unmanaged time and force-closes everything. `markHeartbeatDegraded` is the
   * durable half of the warning: it downgrades the next boot's flatten to an
   * alarm. It is best-effort — the channel it reports on is the one that just
   * failed — and it is attempted on *every* failed stamp rather than once per
   * warning window, because it only has to land once and the throttle exists
   * for the log, not for the record.
   */
  private noteEngineAlive(): void {
    try {
      stampEngineHeartbeat(Date.now());
    } catch (err) {
      const now = Date.now();
      try {
        markHeartbeatDegraded(now);
      } catch {
        // A database that cannot take either write leaves the next boot where
        // it was before this marker existed. Nothing further to try.
      }
      if (now - this.heartbeatWriteWarnedAt < HEARTBEAT_WRITE_WARN_MS) return;
      this.heartbeatWriteWarnedAt = now;
      this.log(
        ENGINE_CTX,
        "warn",
        "system",
        `Engine heartbeat write failed: ${err instanceof Error ? err.message : String(err)} — ` +
          "the next boot is being told its duration reading is untrustworthy, so it will alarm rather than force-flatten",
      );
    }
  }

  start(deployments: Deployment[]): void {
    if (this.intervalId || this.realtimeDeployments.length > 0) return;

    // Ahead of everything this method arms. Two engines on one database
    // double-trade every account, and `start()` is reached from routes as
    // well as from boot, which is where the lease is taken.
    if (!holdsLease()) {
      reportLeaseRefused("start()");
      return;
    }

    // Before anything can evaluate: the sweep has to be armed and D-14's
    // suppression latched ahead of the priming tick, and this is the entry
    // point the boot path's early returns bypass.
    this.ensureRestartVerdictApplied();

    // Before the priming tick: a bar that closed while no engine ran was never
    // handled, so nothing else stops the first pass entering on it.
    this.health.noteEngineStarted(Date.now());

    this.realtimeEventsEnabled = true;

    // Reset bounded-retry counter at engine startup so a prior process's
    // accumulated failures (carried via state restoration) can't immediately
    // trip the cap on the first heartbeat anomaly.
    this.userReconnectFailures = 0;

    // Restore contract locks from any open trades in the DB before the first
    // tick runs — prevents a second deployment on the same (account, contract)
    // from slipping in between engine boot and the first reconciler pass.
    this.rebuildContractLocksFromDb();

    // Rehydrate `state.position` for every DB-open trade so the realtime exit
    // path (session force-exit, BE, strategy realtime exits) doesn't sit blind
    // until the next bar-close eval. Without this a position opened pre-restart
    // can sail past activeEnd because evaluateRealtimeExits skips when
    // `state.position` is null.
    this.rebuildStatePositionsFromDb();

    this.restoreSessionEntryLatch(deployments);

    this.restoreLastBarTimestamps(deployments);

    // Both arms below start evaluating; `start()` is the other door onto the
    // deployment set and does not go through `applySync`. Same ordering as
    // there: the cache is dropped first so a refusal on an in-process restart
    // renders the row as it is now, not as it was before the stop.
    this.displayCache.clear();
    this.classifyActivationRefusals(deployments);

    if (REALTIME_BARS_ENABLED && this.signalr) {
      this.logEvent("engine_started", ENGINE_CTX, "Trading engine started (realtime bars)");
      // Kick off a priming tick so reconciliation + any already-closed bar
      // from warmup is processed immediately instead of waiting for the
      // next live bar close. The reconciler loop below also doubles as
      // passive-mode's only heartbeat when SignalR is dead.
      this.realtimeDeployments = deployments;
      void this.initRealtime(deployments);
      void this.syncRealtimeAdapters();
      // Construct and hold the SSE relay, as `initUserHubListener` did
      // before E4. Two things depend on it happening here rather than on
      // the first browser connect: `peekBroadcaster()` is how the engine
      // emits `marketTrade` / `strategyTrade` and returns null until
      // something calls `getBroadcaster`, and the retain is what keeps
      // the account feed up when `start()` runs with zero deployments
      // (the sync above wants no accounts, so nothing else would).
      const broadcaster = getBroadcaster(this.broadcasterDepsValue);
      if (broadcaster) {
        void broadcaster.ensureRunning([], []).catch((err) => {
          // `warn`, not the `error` its `ensureHubsReady` sibling carries:
          // that one is a hub that never came up at all, this one falls back
          // to the REST reconciler and keeps trading.
          this.log(
            ENGINE_CTX,
            "warn",
            "connection",
            `User-hub init failed: ${err instanceof Error ? err.message : String(err)} — falling back to REST reconciler only`,
          );
        });
      }
      void this.runTick(deployments);
      this.swapTickHandler("realtime");
      this.marketHub.startHeartbeat();
      this.startNakedPositionWatchdog();
      this.startSessionEndGuard();
      this.startClosingGuard();
      this.startManualPositionGuard();
      this.startRestartFlattenGuard();
      this.startRegimeLabelJob();
      this.startSessionCloseSampler();
      this.startAccountStatusJob();
      return;
    }

    this.logEvent("engine_started", ENGINE_CTX, "Trading engine started (polling bars)");
    void this.runTick(deployments);
    this.intervalId = setInterval(() => void this.runTick(deployments), REST_TICK_MS);
    this.marketHub.startHeartbeat();
    this.startNakedPositionWatchdog();
    this.startSessionEndGuard();
    this.startClosingGuard();
    this.startManualPositionGuard();
    this.startRestartFlattenGuard();
    this.startRegimeLabelJob();
    this.startSessionCloseSampler();
    this.startAccountStatusJob();
  }

  /**
   * Realtime handler for a broker position event. Maps the (accountId,
   * contractId) pair back to a strategy_trades row and triggers the
   * matching entry-fill / exit-fill reconcile path immediately.
   *
   * Idempotency invariants:
   *  - If `state.position.entryFilledAt` is already set, the entry-fill
   *    branch no-ops (we'd still call markEntryFilled but the SQL is a
   *    same-value update).
   *  - If the trade is already `closed` and not approximated, the exit
   *    branch no-ops via the DB filter (findRecentApproximatedTradeByAccountContract).
   *
   * Per-fill events are wired separately via the Layer 1
   * buffer (docs/proposals/userhub-trade-subscription.md). Fills feed
   * `appendBufferedFill(...)` and the position-close path drains
   * them ahead of the REST `searchTrades` fan-out. This handler stays
   * focused on entry-confirmation + close-detection; reconciliation of
   * exit price / PnL / fees is owned by the buffer drain or by Layer 2's
   * `resolveExitFromFills` fallback.
   */
  private async handleUserPositionEvent(
    payload: { accountId: number; contractId: string; size: number; averagePrice: number; creationTimestamp: string },
  ): Promise<void> {
    return handleUserPositionEventImpl(this.realtimeDeps(), payload);
  }

  /**
   * User-hub position-close fast path. Two cases:
   *
   *   (1) An in-flight trade exists ⇒ run the same exit-resolution path
   *       the REST reconciler runs (`reconcileOneTrade`'s !pos branch).
   *       This is what fixes the 15s lag on close detection.
   *
   *   (2) Trade is already closed but exit_approximated=true (or
   *       exit_filled_at is null) ⇒ try to upgrade the row's PnL from
   *       the bar-close approximation to real fills now that Topstep
   *       has confirmed the close. If Trade/search still hasn't
   *       indexed, no-op — heal pass picks it up later.
   *
   * Worth running both branches: on the same close event, an already-
   * closed-by-reconciler row gets promoted to authoritative PnL the
   * moment Topstep pushes the position event.
   */
  private async handleUserPositionClose(accountId: number, contractId: string): Promise<void> {
    return handleUserPositionCloseImpl(this.realtimeDeps(), accountId, contractId);
  }

  // ── Naked-position safety watchdog ────────────────────────────────
  /**
   * Periodic safety sweep. For every account the engine touches, fetch
   * open positions + open orders and verify each open position has at
   * least one live Stop Market order on the closing side covering the
   * full size. A position observed naked across two consecutive ticks is
   * flattened with reason `safety_no_bracket`.
   *
   * This is account-scoped, not deployment-scoped. A phantom position
   * (e.g. left behind by a race in the exit path) may not match any
   * `deplState.position`, and that's exactly the case this exists to
   * catch — see the 2026-04-29 NQ phantom-4-lot incident.
   *
   * Per the project's source-of-truth split: post-entry, the broker is
   * the only authority. Strategy/deployment state is irrelevant here.
   */
  /**
   * Arm the naked-position sweep. **Deliberately never disarmed by `stop()`** —
   * its lifetime keys off whether a position is open, not off engine run
   * state. Both fatal-auth paths call `this.stop()` themselves, so tying
   * coverage to the trading loop meant a token-rotation failure silently
   * stripped the safety net off live positions and left it off (bugs.md).
   *
   * Leaving it armed is cheap and self-limiting: the sweep's account set is
   * the union of `realtimeDeployments()` and `listAccountsWithReconcilableTrades()`,
   * and it returns immediately when that set is empty, so an idle engine
   * costs one indexed query per interval.
   *
   * The `.catch` is not decoration. The sweep is fire-and-forget, most of its
   * body is guarded per account, but the coverage-source lookup runs outside
   * that guard — and an unhandled rejection under Node's default
   * `--unhandled-rejections=throw` takes down a process that runs 24/7.
   */
  private startNakedPositionWatchdog(): void {
    if (this.nakedWatchdogInterval) return;
    this.nakedWatchdogInterval = setInterval(() => {
      this.nakedWatchdog.runNakedPositionWatchdog().catch((err) => {
        this.logEvent(
          "safety_sweep_threw",
          ENGINE_CTX,
          `[SAFETY] Naked-position sweep threw: ${err instanceof Error ? err.message : String(err)} — coverage is degraded until the next tick`,
        );
      });
    }, NAKED_POSITION_WATCHDOG_INTERVAL_MS);
  }

  /**
   * Arm the session-end clock guard. **Deliberately never disarmed by
   * `stop()`**, on the same reasoning as the naked-position sweep above: its
   * lifetime keys off whether a position is open, not off engine run state.
   * A token-rotation failure stops the engine, and a position that then sails
   * past its session close is a prop-firm rule violation, not a missed fill.
   * The guard's candidate set unions the DB's open trades precisely so it
   * still finds something after `stop()` has cleared `realtimeDeployments`.
   *
   * Cheap and self-limiting: a pass over deployments holding no position is a
   * map lookup each and makes no broker call at all.
   *
   * The `.catch` is not decoration. The sweep is fire-and-forget, and an
   * unhandled rejection under Node's default `--unhandled-rejections=throw`
   * takes down a process that runs 24/7.
   */
  private startSessionEndGuard(): void {
    if (this.sessionGuardInterval) return;
    this.sessionGuardInterval = setInterval(() => {
      this.sessionGuard.runSessionEndGuard().catch((err) => {
        this.logEvent(
          "safety_sweep_threw",
          ENGINE_CTX,
          `[SESSION] Session-end clock guard threw: ${err instanceof Error ? err.message : String(err)} — force-flat coverage is degraded until the next pass`,
        );
      });
    }, SESSION_END_GUARD_INTERVAL_MS);
  }

  /**
   * Arm the nightly regime-label job. **`stop()` disarms it**, and the
   * asymmetry with the three sweeps above is the point: they carry safety
   * obligations over live positions, while this one writes a label nothing is
   * gated on. With neither an obligation nor a claim, disarmed is the default:
   * a stopped engine trades nothing, so this job has no reason to run. Cost is
   * why the default points that way — a label it did not compute costs a stale
   * board chip, and the pass spends a multi-hundred-thousand-bar history read.
   *
   * The pass is a wall-clock check and a map lookup outside the CME
   * maintenance break, which is 23 hours of the day.
   *
   * The `.catch` is not decoration: the pass is fire-and-forget, and an
   * unhandled rejection under Node's default `--unhandled-rejections=throw`
   * takes down a process that runs 24/7.
   */
  private startRegimeLabelJob(): void {
    if (this.regimeInterval) return;
    this.regimeInterval = setInterval(() => {
      this.regimeLabels.runNightlyPass().catch((err) => {
        this.logEvent(
          "regime_label_failed",
          ENGINE_CTX,
          `Nightly regime pass threw: ${err instanceof Error ? err.message : String(err)} — the session stays unlabelled until the lazy fill reaches it`,
        );
      });
    }, REGIME_NIGHTLY_INTERVAL_MS);
  }

  /**
   * Arm the close sampler. **`stop()` disarms it**, on the regime job's
   * reasoning rather than the safety sweeps': it carries no obligation over a
   * live position and no claim on an instrument — it records the number
   * tomorrow's budget is set from, and a stopped engine takes no entries. The
   * cost of a pass is a broker fan-out, which a stopped engine has no business
   * making, and the cost of a missed sample is fail-closed by construction: the
   * account runs the lowest budget of its phase and says so once.
   *
   * Cheap outside the gap between sessions — a wall-clock read and a return —
   * and inside one it reads the catalogue and stops there unless an opted-in
   * account is still unsampled.
   *
   * The `.catch` is not decoration — see `startSessionEndGuard`.
   */
  private startSessionCloseSampler(): void {
    if (this.sessionCloseSamplerInterval) return;
    this.sessionCloseSamplerInterval = setInterval(() => {
      this.sessionCloseSampler.runSessionCloseSampler().catch((err) => {
        this.logEvent(
          "session_close_unsampled",
          ENGINE_CTX,
          `Close sampling threw: ${err instanceof Error ? err.message : String(err)} — accounts ` +
            `with no close recorded for the next session size at the lowest budget of their phase`,
        );
      });
    }, SESSION_CLOSE_SAMPLER_INTERVAL_MS);
  }

  /**
   * Arm the daily account-status check, and run one pass now. **`stop()`
   * disarms it**: its pass costs a broker fan-out, and what it writes — the
   * stored account state the entry gate and the deploy screen read — is read,
   * never refreshed, by anything a stopped engine does. Settings and the
   * deploy surfaces still check on open through `checkAccountStatuses`,
   * stopped or not.
   *
   * **The pass at arm time is for a fresh boot**: with no website answer
   * stored, every Topstep deploy reads OCO-unknown and is refused until a
   * check runs, and the first interval is an hour out. On an in-process
   * restart it is a no-op unless the last clean check is a day old.
   *
   * The `.catch` is not decoration — see `startSessionEndGuard`.
   */
  private startAccountStatusJob(): void {
    if (this.accountStatusInterval) return;
    const runPass = () => {
      this.accountStatusJob.runDailyPass().catch((err) => {
        this.logEvent(
          "boot_broker_arm_failed",
          ENGINE_CTX,
          `Account status check threw: ${err instanceof Error ? err.message : String(err)} — ` +
            `accounts keep the status the last check gave them`,
        );
      });
    };
    this.accountStatusJob.arm();
    runPass();
    this.accountStatusInterval = setInterval(runPass, ACCOUNT_STATUS_JOB_INTERVAL_MS);
    // The 17:55 ET pass and the post-open lock recheck share one minute clock;
    // their windows do not overlap.
    const clockPass = (pass: Promise<void>, what: string) =>
      pass.catch((err) => {
        this.logEvent(
          "boot_broker_arm_failed",
          ENGINE_CTX,
          `${what} account status check threw: ${err instanceof Error ? err.message : String(err)} — ` +
            `accounts keep the status and balance the last check gave them`,
        );
      });
    this.accountStatusEveningInterval = setInterval(() => {
      void clockPass(this.accountStatusJob.runEveningPass(), "Evening");
      void clockPass(this.accountStatusJob.runOpenRecheck(), "Post-open");
    }, ACCOUNT_STATUS_EVENING_INTERVAL_MS);
  }

  /** Ask every configured broker now which accounts can still trade (ok,
   *  locked or dead), and record the answer. Joins a check already running. */
  checkAccountStatuses(): Promise<AccountStatusCheckResult> {
    return this.accountStatusJob.check();
  }

  /**
   * The orphan pass over a refresh the reconciler did not run — the
   * account-status check's. `refreshBrokerRegistry` stamps
   * `accountNamesRefreshedAt`, which the reconciler's 30-minute pass reads as
   * "a refresh has been cross-checked", so this runs the pass that refresh
   * displaced, under the reconciler's own reason code: it *is* the periodic
   * check, run on the refresh that reset its clock.
   */
  private async orphanAbsentAccountsAfter(result: RefreshResult): Promise<void> {
    await orphanAbsentAccounts(listManagedDeployments(), result, "periodic_account_check", {
      isAccountRegistered: (id) => this.isAccountRegistered(id),
      brokerOf: getAccountBrokerOrNull,
      handleOrphanedAccount: (id, reason) => this.handleOrphanedAccount(id, reason),
      onSkip: (accountId, reason) =>
        this.logEvent(
          "orphan_check_skipped",
          ENGINE_CTX,
          `Account-status orphan check skipped for account ${accountId} — ${reason}.`,
          { accountId },
        ),
    });
  }

  /**
   * Arm the closing guard. **Deliberately never disarmed by `stop()`**, for
   * the same reason as the two sweeps above and one of its own: a `Pausing`
   * row is a promise the operator has already been given, and a stopped
   * engine is exactly when it most needs keeping. Its candidates come from
   * the DB, so clearing `realtimeDeployments` does not blind it.
   *
   * Cheap: one indexed query that returns nothing on a healthy install,
   * because both transient states are conditional.
   *
   * The interval body is `nudgeClosingGuard()` itself, so the scheduled pass
   * and the route-triggered one cannot drift in how they handle a throw.
   */
  private startClosingGuard(): void {
    if (this.closingGuardInterval) return;
    this.closingGuardInterval = setInterval(() => {
      this.nudgeClosingGuard();
    }, CLOSING_GUARD_INTERVAL_MS);
  }

  /**
   * Run one closing-guard pass now instead of waiting up to
   * `CLOSING_GUARD_INTERVAL_MS` for the next scheduled one. Called by the
   * three routes that write `Pausing` or `Destroying`.
   *
   * **This does not make the request wait for flat, and must not be made to.**
   * D-5 is unchanged: the status is still the durable handle on the work and
   * `placeExitOrder` still returns at submission. What this removes is the
   * idle time before the *first* attempt — measured at 7s on an ordinary
   * Pause click, up to the full 15 on an unlucky one, which reads to the
   * operator as a Pause that did nothing.
   *
   * Fire-and-forget by construction: it returns `void` and swallows into the
   * log, so no caller can turn a status write into something that blocks on a
   * close, and no caller can leave an unhandled rejection in a process that
   * runs 24/7. The `.catch` is not decoration — see `startSessionEndGuard`.
   *
   * Safe to overlap the interval pass: the sweep is a full re-read of
   * `listClosing()`, so a second pass finds the same work or none, and
   * `placeExitOrder`'s latch refuses a concurrent submission with
   * `EXIT_IN_FLIGHT` — which `runClosingGuard` reads as already-happening,
   * never as a failure. A row with no registered playbook closes through
   * `forceFlatDeployment` instead, which takes no latch: there the shared
   * `FlattenCooldown` refuses the second pass's order, and the guard reads
   * its `deferred` the same way.
   */
  nudgeClosingGuard(): void {
    this.closingGuard.runClosingGuard().catch((err) => {
      this.logEvent(
        "safety_sweep_threw",
        ENGINE_CTX,
        `Closing guard threw: ${err instanceof Error ? err.message : String(err)} — pausing and destroying deployments are stalled until the next pass`,
      );
    });
  }

  /**
   * Arm D-2 enforcement. **This one *is* disarmed by `stop()`**, and the
   * asymmetry with the three sweeps above is the point: they exist to finish
   * work the engine owes on positions it opened, so their lifetime keys off
   * whether a position is open. This one acts on positions the *operator*
   * opened, and its authority to do so is the claim — a deployment that is
   * Active and inside its session window. A stopped engine holds no claim.
   *
   * Leaving it armed would be inert today, because `stop()` also clears
   * `realtimeDeployments` and the sweep takes its candidates from nothing
   * else. Disarming makes that a property of the lifecycle rather than a
   * consequence of another field's teardown, which is the difference between
   * a guarantee and a coincidence.
   *
   * **Disarming is two things, not one.** `clearInterval` prevents the next
   * pass; `guard.arm()` / `guard.disarm()` is what stops one already parked on
   * a broker round-trip, which captured `realtimeDeployments` before `stop()`
   * emptied it and would otherwise complete and submit against an operator's
   * position on a stopped engine. Without the flag the paragraph above is a
   * near-guarantee, and a near-guarantee on the one path that closes a
   * position the operator opened is not worth writing down.
   *
   * The `.catch` is not decoration — see `startSessionEndGuard`.
   */
  private startManualPositionGuard(): void {
    this.manualPositionGuard.arm();
    if (this.manualPositionGuardInterval) return;
    this.manualPositionGuardInterval = setInterval(() => {
      this.manualPositionGuard.runManualPositionGuard().catch((err) => {
        this.logEvent(
          "safety_sweep_threw",
          ENGINE_CTX,
          `Manual-position sweep threw: ${err instanceof Error ? err.message : String(err)} — positions the engine did not open are unenforced until the next pass`,
        );
      });
    }, MANUAL_POSITION_GUARD_INTERVAL_MS);
  }

  /**
   * Arm D-13's downtime flatten, if the boot verdict left anything pending.
   *
   * **Unlike the four sweeps above it is finite**, and that is what shapes it:
   * it drains when every position it was seeded with is confirmed flat, and
   * the pass after that clears its own interval. Nothing re-seeds it — the
   * boot verdict is the only writer — so an engine that has settled its
   * downtime obligation pays nothing for the rest of the process's life.
   *
   * Like the session and closing guards it is **not disarmed by `stop()`**:
   * this is an obligation on a position the engine opened, not a claim, and a
   * stopped engine is exactly when the obligation is still outstanding. Its
   * candidates are its own set plus a DB trade-row check, so clearing
   * `realtimeDeployments` does not blind it.
   *
   * The `.catch` is not decoration — see `startSessionEndGuard`.
   */
  private startRestartFlattenGuard(): void {
    if (this.restartFlattenInterval) return;
    if (this.restartGuard.pendingCount() === 0) return;
    this.restartFlattenInterval = setInterval(() => {
      if (this.restartGuard.pendingCount() === 0) {
        this.stopRestartFlattenGuard();
        return;
      }
      this.restartGuard.runRestartFlatten().catch((err) => {
        this.logEvent(
          "safety_sweep_threw",
          ENGINE_CTX,
          `[RESTART] Downtime flatten sweep threw: ${err instanceof Error ? err.message : String(err)} — positions that went unmanaged stay open until the next pass`,
        );
      });
    }, RESTART_FLATTEN_INTERVAL_MS);
  }

  private stopRestartFlattenGuard(): void {
    if (!this.restartFlattenInterval) return;
    clearInterval(this.restartFlattenInterval);
    this.restartFlattenInterval = null;
    this.logEvent(
      "downtime_flatten_complete",
      ENGINE_CTX,
      "[RESTART] Downtime flatten complete — every position that went unmanaged is confirmed flat",
    );
  }

  /**
   * A `Pausing` or `Destroying` row reached its terminal state. Re-read the
   * managed set so the settled row stops being iterated, and — for a reaped
   * destroy — run the same last-leg group cascade the immediate delete path
   * runs, so a group does not survive as an empty shell.
   */
  private onDeploymentSettled(deployment: Deployment, from: "Pausing" | "Destroying"): void {
    if (from === "Destroying" && listGroupLegs(deployment.groupId).length === 0) {
      softDeleteGroup(deployment.groupId);
    }
    // The one lifecycle write no request is waiting on: `Pausing` → `Paused`
    // lands 0–15s after the route returned, so without this even the tab that
    // pressed pause never learns the close finished.
    peekBroadcaster()?.emitDeploymentsChanged();
    this.sync(listManagedDeployments());
  }

  /**
   * Realtime-mode reconciler tick. Skips strategy evaluation (handled by
   * onBarClose) and only reconciles pending trades, which isn't tied to
   * bar closes and still needs a time-based loop.
   */
  private async runReconcileOnly(): Promise<void> {
    this.noteEngineAlive();
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Exit-eval site: relax `enabled` so a leg with an open position
      // stays in the reconciler's view (ghost-position sweep filters by
      // `state.position != null` itself but only sees what we pass in).
      // reconcilePendingTrades unions with listAccountsWithReconcilableTrades
      // for the broader paused-deployment-with-open-trade case; the
      // relaxation here keeps `reconcileGhostPositions` covered too.
      const enabled = this.realtimeDeployments.filter((d) => this.isLegInExitLoop(d));
      // Don't short-circuit when there are zero enabled deployments —
      // reconcilePendingTrades also covers accounts with orphan in-flight
      // trades (paused/deleted deployment with a still-open position), and
      // bailing here would strand those rows in 'open' forever.
      if (this.marketHub.mode() === "passive") {
        await this.marketHub.maybeValidatePassiveToken();
      }
      // One live position read per account for this pass, shared by both
      // sweeps (bugs.md A9). Dropped with the pass, so never a cached answer.
      const positionReads = new PassPositionReads();
      await this.reconcilePendingTrades(enabled, positionReads);
      // Engine-side ghost-position sweep: catch the case where deplState.position
      // is set but the broker is flat. Window observed 2026-04-29 09:00:00 — a
      // bracket SL filled and the broker went flat, but deplState.position
      // stayed set until the next placeExitOrder ran, letting four phantom
      // quote-tick exits race past the broker-flat guard. Broker-side
      // divergence (broker has a position no deployment claims) is handled
      // by the naked-position watchdog.
      await this.reconcileGhostPositions(enabled, positionReads);
      // Re-snapshot any trades whose post-exit bar window has matured.
      // Runs after reconcile so reconcile keeps priority on the API rate
      // budget; processSnapshotQueue caps itself at 3 fetches per tick.
      await this.processSnapshotQueue();
    } catch (err) {
      if (this.isEngineFatalAuthError(err)) {
        this.logEvent(
          "engine_auth_failed",
          ENGINE_CTX,
          "Auth failed after session refresh — stopping engine. Reconnect to resume.",
        );
        this.stop();
        return;
      }
      this.logEvent(
        "tick_failed",
        ENGINE_CTX,
        `Reconcile tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
    this.drainPendingSync();
    this.drainPendingBarCloses();
  }

  /** If bar-close events landed while `ticking` was held by reconcile or
   *  another eval, drain them now. Single-flight: re-acquires `ticking`
   *  internally via runBarCloses. */
  private drainPendingBarCloses(): void {
    if (this.pendingBarCloses.size === 0) return;
    const bars = this.pendingBarCloses;
    this.pendingBarCloses = new Map();
    // Exit-eval site: queued deployments include disabled legs that still
    // hold a position so BE / trail / force-flat keep firing on them.
    const queued: Array<readonly [Deployment, TriggerClose | null]> = [];
    for (const d of this.realtimeDeployments) {
      if (bars.has(d.id) && this.isLegInExitLoop(d)) queued.push([d, bars.get(d.id) ?? null]);
    }
    if (queued.length > 0) void this.runBarCloses(queued);
  }

  /** Connect market hub, subscribe trades per unique contract, wire bar-close
   *  events into processDeployment. Idempotent — safe to call during start
   *  and on sync() when the deployment set changes. */
  private async initRealtime(deployments: Deployment[]): Promise<void> {
    if (!this.signalr) return;
    try {
      if (!this.marketHub.isReady()) {
        await this.marketHub.connect();
        // A `stop()` that landed during the connect has cleared the maps a
        // sync would refill, and `connect()` returns quietly when abandoned.
        if (!this.isRunning()) return;
      }
      await this.marketHub.syncContractSubs(deployments);
    } catch (err) {
      // On a stopped engine the fallback would arm an interval nothing clears,
      // and `start()` refuses to run while `intervalId` is set.
      if (!this.isRunning()) return;
      this.logEvent(
        "hub_init_failed",
        ENGINE_CTX,
        `Realtime init failed: ${err instanceof Error ? err.message : String(err)} — falling back to polling`,
      );
      // Fallback: behave like the polling engine from here on. Read
      // realtimeDeployments live each tick so subsequent sync() calls
      // (edits, toggles) take effect even in this degraded mode.
      if (!this.intervalId) {
        this.intervalId = setInterval(() => this.runTick(this.realtimeDeployments), 30_000);
      }
    }
  }

  /** Set what the REST tick runs: full evaluation in passive mode, the
   *  reconciler in realtime. The interval this armed keeps its clock across
   *  flips — clearing and re-arming it put the first tick in the new mode a
   *  whole interval after the flip (bugs.md A13). Any other interval in
   *  `intervalId` (the polling start, the init fallback) is replaced. */
  private swapTickHandler(mode: "realtime" | "passive"): void {
    this.tickHandler = mode === "passive"
      ? () => void this.runTick(this.realtimeDeployments)
      : () => void this.runReconcileOnly();
    if (this.intervalId !== null && this.intervalId === this.swappableTickId) return;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tickHandler(), REST_TICK_MS);
    this.swappableTickId = this.intervalId;
  }

  /**
   * Force a user-hub teardown + rebuild. Parallel to the market hub's own
   * `attemptReconnect` but for the user hub side (owned by Topstep's
   * realtime adapter), which is why it stays here rather than moving into
   * `engine-market-hub.ts`. Idempotent — no-op when the underlying SignalR
   * user-hub already reports "Connected".
   *
   * Bounded retry: after USER_RECONNECT_MAX_FAILURES consecutive failures
   * within a single auto-heal cycle, gives up and fires a Discord alert.
   * That cap protects against fighting a real session displacement (the
   * user's slot got taken by mobile / another tab) — at that point retrying
   * just ping-pongs the slot.
   *
   * `trigger` is logged + sent in the alert so we can tell auto-heal-driven
   * attempts apart from heartbeat-anomaly-driven ones.
   */
  private async attemptUserReconnect(
    trigger: "auto-heal" | "heartbeat" | "token-rotation",
  ): Promise<boolean> {
    if (!this.signalr) return false;
    if (this.userReconnecting || (this.userHandoffInFlight && trigger !== "token-rotation")) {
      if (trigger === "token-rotation") this.userRotationPending = true;
      return false;
    }
    const adapter = this.topstepRealtime;
    if (!adapter) return false;
    const state = adapter.hubState();
    // A rotated session is the one case where `Connected` is not evidence of
    // health: the socket stays open and the gateway stops streaming to it, so
    // the inference below ("it healed itself") is exactly backwards and this
    // trigger is the only thing that will ever reconnect that hub.
    if (state === "Connected" && trigger !== "token-rotation") {
      // Hub recovered on its own (SignalR withAutomaticReconnect); reset
      // the failure counter and bail.
      this.userReconnectFailures = 0;
      return false;
    }
    if (this.userReconnectFailures >= USER_RECONNECT_MAX_FAILURES) {
      // Already gave up this cycle — let the next auto-heal fire reset us.
      return false;
    }
    this.userReconnecting = true;
    const attemptNumber = this.userReconnectFailures + 1;
    this.logEvent(
      "hub_reconnecting",
      ENGINE_CTX,
      `USER HUB RECONNECTING — trigger=${trigger}, attempt #${attemptNumber}, state=${state}`,
    );
    let rotated = false;
    try {
      // The hub needs a live session, not just a JWT inside its `exp`; the
      // user hub only ever recovered right after a market-hub connect, the
      // one path that validated first (A79). `token-rotation` skips it: that
      // trigger fires because a fresh token is already in the client, and a
      // second validate here could rotate it again under the market hub the
      // rebuild just bound — which the heartbeat would read as a new rotation.
      if (trigger !== "token-rotation") {
        this.topstepClient?.setToken(await validateOrRefreshToken());
        // This validate retired the market hub's session too. Hand the whole
        // attempt to the rotation rebuild below, which does both hubs now
        // instead of the user hub alone and the market hub a heartbeat later.
        rotated = this.marketHub.tokenMovedUnderHubs();
      }
      if (!rotated) {
        await adapter.forceReconnect();
        this.userReconnectFailures = 0;
        this.logEvent(
          "hub_reconnected",
          ENGINE_CTX,
          `USER HUB RECONNECTED — recovered after ${attemptNumber} attempt(s)`,
        );
      }
    } catch (err) {
      this.userReconnectFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.logEvent(
        "hub_reconnect_failed",
        ENGINE_CTX,
        `User hub reconnect attempt #${attemptNumber} failed: ${message}`,
      );
      if (this.userReconnectFailures >= USER_RECONNECT_MAX_FAILURES) {
        this.logEvent(
          "hub_reconnect_abandoned",
          ENGINE_CTX,
          `User hub reconnect giving up after ${USER_RECONNECT_MAX_FAILURES} consecutive failures — likely real session displacement; click Reconnect Market Hub or sign out elsewhere to recover.`,
        );
        void sendConnectionAlert({
          title: "Engine user hub auto-heal failed",
          color: COLOR_CONNECTION_LOST,
          fields: [
            { name: "Trigger", value: trigger, inline: true },
            { name: "Attempts", value: String(USER_RECONNECT_MAX_FAILURES), inline: true },
            { name: "Last error", value: message },
            {
              name: "Status",
              value:
                "Engine continues evaluating strategies on REST polling. The user hub powers fill detection / dashboard live updates — likely cause is another active session on this Topstep login. Sign out elsewhere then click **Reconnect Market Hub** to recover.",
            },
          ],
        });
      }
    } finally {
      this.userReconnecting = false;
    }
    // After the guard is down, so the rebuild's own `token-rotation` call is
    // not the one it bounces. No await since the validate: the rebuild stamps
    // the new session before a heartbeat can see the move and fire a second.
    // A rotation that bounced during this attempt is covered by the rebuild,
    // or honoured here once.
    const pending = this.userRotationPending;
    this.userRotationPending = false;
    if (rotated) {
      this.userHandoffInFlight = true;
      try {
        await this.marketHub.rebuildOnTokenMove();
      } finally {
        this.userHandoffInFlight = false;
      }
    } else if (pending) {
      await this.attemptUserReconnect("token-rotation");
    }
    return true;
  }

  /**
   * User-triggered reconnect from the dashboard. Used when the engine is
   * in passive mode after a `gatewaylogout` (auto-retry was suppressed so
   * we don't keep re-kicking whoever the user opened a session for).
   * Returns a result so the API can surface success/failure. Public API
   * surface for `/api/engine`; the work is the market hub's.
   */
  async reconnectMarketHubManually(): Promise<{ ok: boolean; error?: string }> {
    return this.marketHub.reconnectManually();
  }

  /** Snapshot of market-hub state for the dashboard's connection UI. */
  getMarketHubStatus(): MarketHubStatus {
    return this.marketHub.status();
  }

  private handleTrade(contractId: string, trade: GatewayTrade | GatewayTrade[]): void {
    return handleTradeImpl(this.realtimeDeps(), contractId, trade);
  }

  /**
   * Dispatch one tick-driven exit for a deployment the caller has already
   * decided should exit.
   *
   * Exists as its own method because the ordering inside it is load-bearing
   * and belongs in exactly one place. The contract resolve is the only
   * `await`, and `DeploymentState.position` is re-read *after* it with
   * nothing between that read and the dispatch — the exit hard rule in
   * [engine.md](../../../docs/modules/trading/engine.md), obeyed by ordering,
   * the same way the session-end clock guard obeys it. The caller's earlier
   * `position` read is a pre-check only: it decides whether the resolve is
   * worth paying for and never reaches `placeExitOrder`.
   *
   * Throws on a failed resolve or a refused/failed exit; the caller keeps the
   * position mirror and retries on the next tick.
   */
  private async dispatchTickExit(
    strategy: StrategyModule,
    deployment: Deployment,
    deplState: DeploymentState,
    reason: string,
    now: Date,
  ): Promise<void> {
    // Execution identity is per deployment. A market sub is one global slot
    // per Topstep contract id, so a Topstep leg and a Tradovate leg on the
    // same product share it and `MarketSub.contract` is whichever one created
    // it — handing the shared object to both is how a Topstep leg's
    // session-end exit asked Tradovate about `NQU6`, got "no position", and
    // submitted nothing (docs/bugs.md, 2026-08-26).
    const contract = await this.resolver.resolve(deployment.ticker, deployment.accountId);
    // `handleUserPositionEvent` is void-dispatched with no `ticking` guard, so
    // a close landing during the resolve nulls `position` underneath us and
    // `placeExitOrderInner` would read `.side` off null.
    const position = deplState.position;
    if (!position) return;
    await this.placeExitOrder(
      strategy,
      deployment,
      contract,
      position,
      deplState.activeTradeId,
      reason,
    );
    deplState.position = null;
    deplState.breakEvenMoved = false;
    deplState.activeTpTicks = null;
    deplState.activeSlTicks = null;
    deplState.slMovedToBe = false;
    deplState.slCurrentPrice = null;
    deplState.tpCurrentPrice = null;
    deplState.cooldownAnchorAt = now.toISOString(); // exit-anchored cooldown seed
  }

  /** The merged params the quote-tick path reads, built once per deployment
   *  per sync rather than per tick (A14). Shared and read-only: the tick path
   *  only hands it to `collectSessionWindows` and `shouldExitRealtime`. */
  private tickParamsFor(deployment: Deployment, strategy: StrategyModule): Readonly<CommonParams> {
    const hit = this.tickParamsCache.get(deployment.id);
    if (hit && hit.paramValues === deployment.paramValues && hit.strategy === strategy) {
      return hit.params;
    }
    const params: Readonly<CommonParams> = resolveDeploymentParams(strategy, deployment.paramValues, {
      strategyKey: deployment.strategyKey,
      deploymentId: deployment.id,
    });
    this.tickParamsCache.set(deployment.id, { paramValues: deployment.paramValues, strategy, params });
    return params;
  }

  /** Tick-driven exit evaluation. Runs BE, session-window force-close, and
   * any per-strategy `shouldExitRealtime` against the current price for every
   * deployment with an open position on this contract. Indicator-based exits
   * stay on the bar-close path — see strategy-types.ts for the contract. */
  private async evaluateRealtimeExits(contractId: string, price: number): Promise<void> {
    const marketSub = this.marketHub.marketSubFor(contractId);
    if (!marketSub) return;
    // Market-data identity only — shared by every leg on this sub, whatever
    // broker each one routes to. `tickSize` / `tickValue` are safe to take
    // from it (both are Topstep-sourced even for Tradovate legs, see
    // `BrokerAwareContractResolver`); execution identity is not, and comes
    // from the per-deployment resolve in `dispatchTickExit`.
    const contract = marketSub.contract;
    // Tick-driven exits ignore timeframe — collect refs from every aggregator on this contract.
    const refIds = new Set<string>();
    for (const tf of marketSub.timeframes) {
      const sub = this.marketHub.contractSubFor(contractId, tf);
      if (sub) for (const id of sub.refs) refIds.add(id);
    }
    // Exit-eval site: relax `enabled` to keep BE / trail / session-end
    // force-flat / strategy realtime exits firing on a leg whose enabled
    // flag flipped while still holding a broker position.
    const deployments = this.realtimeDeployments.filter(
      (d) => refIds.has(d.id) && this.isLegInExitLoop(d),
    );
    if (deployments.length === 0) return;
    const now = new Date();
    for (const deployment of deployments) {
      const deplState = this.getState(deployment.id);
      // Pre-check. Decides whether this leg is worth evaluating at all; the
      // value handed to `placeExitOrder` is re-read inside `dispatchTickExit`.
      const position = deplState.position;
      if (!position) continue;
      const strategy = getStrategy(deployment.strategyKey);
      if (!strategy) continue;
      const params = this.tickParamsFor(deployment, strategy);

      // 1) Session-window force-close — fire the moment any active window
      // flips, or the moment the exchange calendar says the session this leg
      // declares has already ended for the day. Same predicate the clock
      // guard and `backtest.ts` read; see exchange-calendar.ts.
      const sessionWindows = collectSessionWindows(strategy.config.session, params);
      if (!isInTradableSessionWindow(now, sessionWindows)) {
        try {
          await this.dispatchTickExit(strategy, deployment, deplState, "time_window_close", now);
        } catch (err) {
          // Position kept for next-tick retry. A failed contract resolve
          // arrives here too and skips only this leg — the others on this sub
          // still get evaluated.
          this.logExitDispatchFailure(deployment.id, "time_window_close", err);
        }
        continue;
      }

      // 2) Strategy-defined realtime exit (price-only — no indicators).
      // BE/trail moved to the registry exit filters (bar-close cadence) in
      // step 4 of the refactor; the realtime tick loop only runs the
      // strategy's tick-evaluated exit hook now.
      if (strategy.shouldExitRealtime) {
        const triggered = strategy.shouldExitRealtime({
          position,
          price,
          params: params as never,
          tickSize: contract.tickSize,
        });
        if (triggered) {
          try {
            await this.dispatchTickExit(strategy, deployment, deplState, "realtime_exit", now);
          } catch (err) {
            // Position kept for next-tick retry.
            this.logExitDispatchFailure(deployment.id, "realtime_exit", err);
          }
        }
      }
    }
  }

  /** Fires when an aggregator closes a bar for a (contract, timeframe).
   *  Dispatches strategy eval only to deployments bound to this exact
   *  aggregator — a 5m deployment must not evaluate on a 1m close, and
   *  vice versa. The aggregated bar is forwarded so processDeployment can
   *  append it to the REST series — REST can lag the live close by several
   *  seconds, which would otherwise make every bar close a no-op until REST
   *  caught up. */
  private onBarClose(key: SubKey, bar: BarData, previousPublishedAt: string | null): void {
    const sub = this.marketHub.contractSubForKey(key);
    if (!sub) return;
    // Exit-eval site: a leg with `enabled=false` but an open position
    // still needs bar-close exit eval (shouldExit, BE/trail bar paths,
    // session-end force-flat). processDeployment short-circuits the
    // entry branch when `position != null`, and a defensive guard there
    // also skips entries on disabled legs that fall through after a
    // mid-tick close.
    const deployments = this.realtimeDeployments.filter(
      (d) => sub.refs.has(d.id) && this.isLegInExitLoop(d),
    );
    // diagnostic: an in-exit-loop leg that no aggregator carries gets no bar
    // closes at all. A leg on another (contract, timeframe) is not a miss —
    // its own aggregator fires it.
    for (const d of this.realtimeDeployments) {
      if (this.isLegInExitLoop(d) && !this.marketHub.hasDeploymentSub(d.id)) {
        this.log(
          d.id,
          "warn",
          "system",
          `onBarClose: deployment on no bar aggregator at key=${key} bar=${bar.timestamp} — missed bar close`,
          { accountId: d.accountId },
        );
      }
    }
    if (deployments.length === 0) return;
    void this.runTickForDeployments(deployments, { bar, previousPublishedAt, timeframe: sub.timeframe });
  }

  /** Strategy-evaluation pass for a subset of deployments, triggered by a
   *  bar close. Mirrors tick() but skips the reconciler (the 30s interval
   *  handles that in realtime mode) and is keyed off bar close, not clock. */
  private async runTickForDeployments(deployments: Deployment[], trigger?: TriggerClose): Promise<void> {
    await this.runBarCloses(deployments.map((d) => [d, trigger ?? null] as const));
  }

  /** `runTickForDeployments` with a trigger bar per leg — the drain's shape,
   *  since legs queued behind one holder can carry different closes. */
  private async runBarCloses(closes: ReadonlyArray<readonly [Deployment, TriggerClose | null]>): Promise<void> {
    if (this.ticking) {
      // Reconciler (or another eval) is mid-flight. Queue and drain when the
      // holder releases. One slot per deployment, so a long stall colliding
      // with several closes still produces one extra eval per leg — and the
      // slot keeps the newest close's bar, the one REST may not have yet.
      for (const [d, close] of closes) {
        const queued = this.pendingBarCloses.get(d.id) ?? null;
        if (queued == null || (close != null && isNewerBar(close.bar.timestamp, queued.bar.timestamp))) {
          // A stall longer than one bar interval drops the older close. If
          // REST already holds it no hole is seen, so this line is the only
          // record that the leg never evaluated that bar on its own.
          if (queued != null && close != null) {
            this.log(
              d.id,
              "info",
              "system",
              `Queued bar close ${queued.bar.timestamp} was replaced by ${close.bar.timestamp} before it was evaluated; ${queued.bar.timestamp} is not evaluated on its own`,
              { accountId: d.accountId, burstKey: `bar_close_replaced:${d.id}` },
            );
          }
          this.pendingBarCloses.set(d.id, close);
        }
      }
      return;
    }
    this.ticking = true;
    try {
      for (const [deployment, trigger] of closes) {
        const strategy = getStrategy(deployment.strategyKey);
        if (!strategy) {
          log.debug("eval", `runTickForDeployments: NO STRATEGY found for deployment.strategyKey=${deployment.strategyKey} deployment.id=${deployment.id}`);
          continue;
        }
        log.debug("eval", `runTickForDeployments: processDeployment START deployment=${deployment.id} strategy=${deployment.strategyKey} status=${deployment.status}`);
        try {
          await this.processDeployment(strategy, deployment, trigger ?? undefined);
          log.debug("eval", `runTickForDeployments: processDeployment OK deployment=${deployment.id}`);
        } catch (err) {
          log.debug("eval", `runTickForDeployments: processDeployment ERR deployment=${deployment.id} err=${err instanceof Error ? err.message : String(err)}`);
          this.logEvent(
            "deployment_tick_failed",
            deployment.id,
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            { accountId: deployment.accountId },
          );
        }
      }
    } finally {
      this.ticking = false;
    }
    this.drainPendingSync();
    this.drainPendingBarCloses();
  }

  /** Guarded tick wrapper. Skips if the previous tick is still in flight. */
  private async runTick(deployments: Deployment[]): Promise<void> {
    this.noteEngineAlive();
    if (this.ticking) {
      this.log(ENGINE_CTX, "warn", "system", "Skipping tick: previous tick still running");
      return;
    }
    this.ticking = true;
    if (!firstTickReported && deployments.length > 0) {
      firstTickReported = true;
      const msSinceProcessStart = Math.round(performance.now());
      log.event(
        "first_tick",
        "engine",
        `First engine tick ran ${msSinceProcessStart}ms after process start, with ${deployments.length} deployment(s)`,
        { meta: { msSinceProcessStart, deployments: deployments.length } },
      );
    }
    try {
      await this.tick(deployments);
    } catch (err) {
      // An engine-scoped auth failure reaching us here means the client
      // already tried to refresh the session and failed. There's no recovery
      // path without user action, so stop the engine instead of spamming
      // errors for hours. An account-scoped one orphan-pauses instead and
      // never gets here.
      if (this.isEngineFatalAuthError(err)) {
        this.logEvent(
          "engine_auth_failed",
          ENGINE_CTX,
          `Auth failed after session refresh — stopping engine. Reconnect to resume.`,
        );
        void sendDiscordAlert({
          title: "Engine stopped: auth failure",
          color: COLOR_EXIT_LOSS,
          fields: [
            {
              name: "Reason",
              value:
                "Token expired and session revalidation failed. Reconnect the app to issue a new token, then restart the engine.",
            },
          ],
        });
        this.stop();
        return;
      }
      this.logEvent(
        "tick_failed",
        ENGINE_CTX,
        `Tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
    this.drainPendingSync();
    this.drainPendingBarCloses();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Tears down the passive-mode reconnect loop, the maintenance heal and
    // the watchdog, and resets to realtime — without this, a stopped engine
    // would keep trying to bring the market hub back up.
    this.marketHub.shutdown();
    // The naked-position sweep deliberately survives `stop()` — see
    // `startNakedPositionWatchdog`. Its memory is deliberately not reset
    // either: `nakedFlattenAt` is the cooldown that stops a second flatten
    // landing while the first is still in flight, so clearing it while the
    // sweep keeps running would reintroduce the double-flatten it exists to
    // prevent. The session-end clock guard survives for the same reason —
    // see `startSessionEndGuard`. Both are tier-2 safety work whose lifetime
    // keys off whether a position is open, not off engine run state. The
    // closing guard survives too: a `Pausing` row is a promise already made
    // to the operator, and it reads its candidates from the DB rather than
    // from the `realtimeDeployments` this method clears. So does the downtime
    // flatten sweep — same reason, and it disarms itself once every position
    // it was seeded with is confirmed flat rather than on any lifecycle event.
    //
    // D-2 enforcement is the one sweep that does *not* survive, because its
    // authority is a claim rather than an obligation: it closes positions the
    // operator opened, and a stopped engine claims no instrument. See
    // `startManualPositionGuard`. `disarm()` is the half that covers a pass
    // already in flight — `clearInterval` alone only prevents the next one.
    this.manualPositionGuard.disarm();
    if (this.manualPositionGuardInterval) {
      clearInterval(this.manualPositionGuardInterval);
      this.manualPositionGuardInterval = null;
    }
    // The regime-label job is the second controller `stop()` disarms, and for
    // the opposite reason to the manual-position guard's: it carries no
    // obligation at all. Nothing is gated on the label, so a session the
    // engine did not label while stopped costs a stale board chip — against
    // which the pass's one action is a year-deep history read a stopped engine
    // has no reason to make. Its per-ticker attempt memory is deliberately
    // kept: a `start()` in the same process should not re-fire a fill that
    // just ran.
    if (this.regimeInterval) {
      clearInterval(this.regimeInterval);
      this.regimeInterval = null;
    }
    // The close sampler is the third, on the regime job's reasoning: it holds
    // no obligation over a position and no claim on an instrument, its pass
    // costs a broker fan-out, and a sample it does not take leaves the account
    // on the lowest budget of its phase rather than on a wrong one. Its warn
    // anchor is kept for the same reason the regime job's attempt memory is;
    // its per-gap attempt count is not, because that bounds an unattended
    // retry loop rather than a repeated line.
    if (this.sessionCloseSamplerInterval) {
      clearInterval(this.sessionCloseSamplerInterval);
      this.sessionCloseSamplerInterval = null;
    }
    this.sessionCloseSampler.resetAttempts();
    // The account-status check is the fourth: its pass is a broker fan-out, and
    // the state it stores gates only the entries of a running engine.
    if (this.accountStatusInterval) {
      clearInterval(this.accountStatusInterval);
      this.accountStatusInterval = null;
    }
    if (this.accountStatusEveningInterval) {
      clearInterval(this.accountStatusEveningInterval);
      this.accountStatusEveningInterval = null;
    }
    this.accountStatusJob.cancelPending();
    this.marketHub.stopHeartbeat();
    this.marketHub.teardownSubscriptions();
    this.realtimeDeployments = [];
    // Drop contract locks — the DB still has open trades, and `start()`
    // rebuilds the lock map from that on next boot. Keeping stale in-memory
    // locks after stop would block a fresh start() from rebuilding cleanly.
    this.contractLocks.clear();
    // The approximated-sweep cap is documented as "until restart"; an
    // in-process stop → start is one, and a kept count would leave a row
    // unasked by the new run (watchlist-3).
    this.approximatedSweepPasses.clear();
    // Drop any deferred sync queued mid-tick before stop(). Without this,
    // an in-process restart (stop() → start()) would apply a stale snapshot
    // from before the stop on the next post-tick drain.
    this.pendingSync = null;
    // Same reasoning: a queued close from before the stop would be evaluated
    // by the first post-start drain, on a bar from the previous run.
    this.pendingBarCloses.clear();
    // Drop the activation verdicts. The refusal line is emitted once, on the
    // transition into the set, so keeping the set across an in-process restart
    // would have `start()` re-classify into an already-populated set and say
    // nothing — a re-activated deployment that still cannot trade, with no
    // line saying so.
    this.refusedLegs.clear();
    this.announcedUnregistered.clear();
    this.setupReadings.reset();
    this.accountEntryGate.reset();
    // Same reasoning, on the same shape: the stale-budget warn is emitted once
    // per account per session, so an anchor that survived the stop would leave
    // a re-started engine sizing every entry at the floor with no line saying
    // so.
    this.riskPhaseStaleWarnedAt.clear();
    this.spliceGapWarnedAt.clear();
    this.barAheadWarnedAt.clear();
    this.stopUnknownWarnedAt.clear();
    this.clockBehindWarnedAt = null;
    // Stop acting on realtime account events, then release the engine's
    // interest in every adapter. Releasing rather than shutting down is
    // load-bearing: the SSE relay holds Topstep's process-wide user hub
    // open for the dashboard's panels, exactly as it did before, while a
    // per-account transport with no other holder (Tradovate) is disposed.
    this.realtimeEventsEnabled = false;
    this.releaseRealtimeAdapters();
    // Layer 1 buffer is non-persistent by design — discard slots and the
    // per-account event-arrival anchor so a restart starts clean.
    this.discardAllBufferSlots();
    this.lastTopstepEventAt.clear();
    // Seam health is dropped, unlike the three safety loops that survive a
    // stop. It is neither an obligation nor a claim — it is an observation of
    // tier-1 evaluation, and tier 1 does not run on a stopped engine. Its
    // only writer is the bar-read funnel, which stops with the tick loop, so
    // leaving the anchors would have the next start inherit an outage that
    // ended while it was down and refuse every bar until a new one opened.
    this.health.reset();
    // Same reasoning one line up, on the same writer: the in-flight bar reads
    // are a within-one-bar-close sharing window, and a stopped engine has no
    // bar close. Nothing outlives the second it was made in anyway; dropping it
    // is what keeps that true across an in-process restart.
    resetBarFetchCache();
    this.logEvent("engine_stopped", ENGINE_CTX, "Trading engine stopped");
  }

  isRunning(): boolean {
    return this.intervalId !== null || this.realtimeDeployments.length > 0;
  }

  /** Prune state for removed deployments; call when deployment list changes.
   *
   *  Concurrency: sync() can be invoked from HTTP route handlers (e.g.
   *  /api/engine update, group edit/delete) that interleave on the Node
   *  event loop with timer-driven ticks. If a tick is mid-await when
   *  sync() lands, we'd lose `position` / `breakEvenMoved` / SL state
   *  for the in-flight leg — getState() lazily creates a fresh entry on
   *  the next access. To close that race, defer the work to the tick's
   *  finally-drain when `ticking === true`; single-slot dedup so a burst
   *  of edits collapses to one apply. */
  sync(deployments: Deployment[]): void {
    if (this.ticking) {
      this.pendingSync = deployments;
      return;
    }
    this.applySync(deployments);
  }

  /** Apply a previously-queued sync() snapshot if one is pending. Called
   *  from the finally-drain of every tick-holder (runTick, runReconcileOnly,
   *  runTickForDeployments) so a sync() that landed mid-tick is applied
   *  exactly once after the tick releases. */
  private drainPendingSync(): void {
    if (this.pendingSync == null) return;
    const next = this.pendingSync;
    this.pendingSync = null;
    this.applySync(next);
  }

  /**
   * Refuse, at activation, a deployment the engine cannot evaluate as
   * configured — or may not. One set: its strategy needs the instrument's
   * day-session window on a ticker `CONTRACT_SPECS` has no row for (a
   * `SESSION_VWAP` strategy on `/NQ`), it is on an instrument the module was
   * not calibrated for, it enables an exit filter on a timeframe no backtest
   * can evaluate, or the warmup depth it declares on its resolved timeframe is
   * past what one bar request reads.
   *
   * Here rather than on the tick because every answer is a property of
   * `(strategy, ticker, params)` — not of any bar — and because the per-tick
   * discovery the first one replaces was a throw inside `calculateAll`, which
   * lands *before* exit management, so an already-open position lost
   * break-even, trailing, the time stop and `shouldExit` for as long as the row
   * stayed enabled, while `deployment_tick_failed` promised a retry every 30s
   * forever. The depth ceiling throws one line earlier, at the fetch, and would
   * have done exactly the same thing. Every refusal is entry-only for the same
   * reason the flap breaker is: a position the engine already opened is still
   * the engine's to manage out. `processDeployment` is where both halves land.
   *
   * Two of the four move under a live group — the depth with the `timeframe`
   * select, the cross-timeframe exit filter with two exit-filter params — and
   * that is fine rather than a hole: this runs on every sync, and a group PATCH
   * ends in one, so an edit into a refusal is caught before the next tick and an
   * edit out of it releases the leg the same way.
   *
   * The line is emitted on the transition into the set — or on a change of
   * reason, which is a different sentence about the same deployment — not on
   * every sync.
   *
   * **A row whose playbook this build does not register is the sixth reason,
   * and the one exception to "entry-only".** A prod build registers only the
   * allowlist (`strategies/prod-playbooks.ts`), so rows of every other key are
   * an ordinary boot. Both tick loops already skip a row with no module; what
   * this adds is the one line per row that says so, in place of the REST
   * loop's warn on every tick — once per row per process, keyed on
   * `announcedUnregistered` rather than on the transition into this set. With
   * no module the engine has no window, no exit hook and no exit of its own,
   * so a position on such a row is not managed out — it takes the `error`
   * event, and its brackets, the closing guard's `forceFlatDeployment` and the
   * board's flatten are what remain (strategies.md, the prod allowlist).
   */
  private classifyActivationRefusals(deployments: Deployment[]): void {
    const refused = new Map<string, LegRefusal>();
    for (const d of deployments) {
      const strategy = getStrategy(d.strategyKey);
      if (!strategy) {
        refused.set(d.id, "unregistered");
        if (this.announcedUnregistered.has(d.id)) continue;
        // The trade row too: the mirror is null between an entry's submission
        // and its fill, and on a row a restart has not seeded. Not
        // `pending_exit`: that exit is already on the wire.
        const tradeStatus = getOpenTradeForDeployment(d.id)?.status;
        const holding =
          this.state.get(d.id)?.position != null ||
          tradeStatus === "open" ||
          tradeStatus === "pending_entry";
        this.logEvent(
          holding ? "deployment_playbook_unavailable_in_position" : "deployment_playbook_unavailable",
          d.id,
          `${d.strategyKey}: ${PLAYBOOK_NOT_IN_BUILD}` +
            (holding
              ? " It holds a position now: its brackets stay at the broker, and nothing moves its" +
                " stop, exits it or flattens it at the session close. Flatten it from its Dashboard row."
              : ""),
          { accountId: d.accountId },
        );
        // After the line, so a read or a log that throws leaves the row to be
        // announced on the next sync rather than marked as told.
        this.announcedUnregistered.add(d.id);
        continue;
      }
      const verdict = this.refusalFor(strategy, d);
      if (!verdict) continue;
      refused.set(d.id, verdict.reason);
      if (this.refusedLegs.get(d.id) === verdict.reason) continue;
      this.logEvent(verdict.event, d.id, verdict.message, { accountId: d.accountId });
    }
    this.refusedLegs = refused;
  }

  /** One deployment's activation verdict. Day session first: a leg with no
   *  window cannot compute the session-scoped quantity the depth would have
   *  been read for, so naming the depth there would be the second-order
   *  answer. Instrument and the cross-timeframe exit filter then sit between
   *  the window and the depth: both are claims that the numbers were never
   *  measured for what this leg would trade rather than claims about what can
   *  be computed, so they outrank a depth the leg should not be reading
   *  anyway. The ordering is editorial: `processDeployment` drops the
   *  day-session indicator configs on the window's absence, not on the reason
   *  returned here. */
  private refusalFor(
    strategy: StrategyModule,
    d: Deployment,
  ): { reason: LegRefusal; event: string; message: string } | null {
    const hasWindow = daySessionForTicker(d.ticker) != null;
    // Params-free and cannot throw, so it is available to the catch arm below
    // as well: a module that could not build its indicators on the instrument
    // it was never calibrated for is still refused for the calibration.
    const researchOnlySentence = undeployableInstrumentRefusal(d.ticker);
    const instrumentSentence = instrumentRefusalFor(strategy.config, d.ticker);
    // Same reasoning, and params-free for the same reason: `config.requiresDaySession`
    // is the declared half of `strategyNeedsDaySession` below, so this answers
    // before params are merged. `null` here does not mean "not refused" — the
    // indicator-scan half (an undeclared `SESSION_VWAP`) still refuses through
    // `needsWindow`, just with the engine's own broader wording, because this
    // sentence cannot claim a declaration the module did not make.
    const daySessionSentence = daySessionRefusalFor(strategy.config, d.ticker);
    // A research-only row outranks the calibration: no playbook may trade it.
    const instrumentVerdict = researchOnlySentence
      ? {
          reason: "research-instrument" as const,
          event: "deployment_instrument_research_only",
          message:
            researchOnlySentence +
            " This deployment will not enter; an open position is still managed to its exit.",
        }
      : instrumentSentence
      ? {
          reason: "instrument" as const,
          event: "deployment_instrument_mismatch",
          message:
            instrumentSentence +
            " This deployment will not enter; an open position is still managed to its exit.",
        }
      : null;
    const timeframe = resolveTimeframe(strategy.config, d.paramValues) as Timeframe;
    let needsWindow = false;
    let crossTimeframeSentence: string | null = null;
    let overCeiling: number | null = null;
    try {
      // The tick's merge, through `resolveDeploymentParams` — not a second
      // one. `strategyNeedsDaySession` reads `buildIndicators(params)`, so a
      // filter-enable key a migration renames has to classify on the value
      // the tick will evaluate on, or one bar's worth of indicator set
      // decides the refusal and another decides the trade.
      const params = resolveDeploymentParams(strategy, d.paramValues, {
        strategyKey: d.strategyKey,
        deploymentId: d.id,
      });
      needsWindow = !hasWindow && strategyNeedsDaySession(strategy, params);
      // The same merged blob, for the same reason: the enable key and the
      // timeframe select are both operator-set params, so the verdict has to
      // be taken on the params the tick evaluates.
      crossTimeframeSentence = crossTimeframeExitRefusalFor(
        params as unknown as AllFilterParams,
      );
      overCeiling = fetchDepthOverCeiling({
        indicatorConfigs: strategy.buildIndicators?.(params) ?? strategy.config.indicators,
        warmupDaySessions: strategy.warmupDaySessions?.(params) ?? 0,
        timeframe,
      });
    } catch (err) {
      // `buildIndicators` runs every filter's `indicatorConfig(params)`, and
      // this loop is inside `applySync`: one module throwing on an odd saved
      // row would otherwise take the state prune, the `realtimeDeployments`
      // swap and the adapter sync down with it, as an unhandled rejection
      // out of `drainPendingSync`. On a ticker with no session hours a module
      // that cannot say what it needs is refused, not trusted; on one that has
      // them there is nothing to refuse it *for*, and the per-tick catch is
      // the backstop it always was.
      log.debug(
        "eval",
        `classifyActivationRefusals: ${d.strategyKey} could not build indicators for ${d.id} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          (hasWindow ? "not refused — its ticker has session hours" : "refused"),
      );
      if (hasWindow) return instrumentVerdict;
      return {
        reason: "day-session",
        event: "deployment_day_session_missing",
        message:
          `${strategy.config.name} could not say whether it measures its signals over the cash session ` +
          `(${err instanceof Error ? err.message : String(err)}), and there are no session hours on file for ${d.ticker}` +
          " — this deployment will not enter; an open position is still managed to its exit",
      };
    }

    if (needsWindow) {
      // The declared arm passes `daySessionRefusalFor` through verbatim and
      // appends the consequence the same way `instrumentVerdict` does — its
      // sentence already ends in a period, so the connector matches that
      // shape rather than the broader arm's dash-joined clause below.
      return daySessionSentence
        ? {
            reason: "day-session",
            event: "deployment_day_session_missing",
            message:
              daySessionSentence +
              " This deployment will not enter; an open position is still managed to its exit.",
          }
        : {
            reason: "day-session",
            event: "deployment_day_session_missing",
            message:
              `${strategy.config.name} measures its signals over the cash session and there are no session hours on file for ${d.ticker}` +
              " — this deployment will not enter; an open position is still managed to its exit",
          };
    }
    if (instrumentVerdict) return instrumentVerdict;
    if (crossTimeframeSentence) {
      return {
        reason: "cross-timeframe-exit",
        event: "deployment_cross_timeframe_exit_filter",
        message:
          crossTimeframeSentence +
          " This deployment will not enter; an open position is still managed to its exit.",
      };
    }
    if (overCeiling != null) {
      return {
        reason: "warmup-depth",
        event: "deployment_warmup_depth_exceeded",
        message:
          `${strategy.config.name} on ${timeframe}: ${describeFetchDepthCeiling(overCeiling, timeframe)}` +
          " — this deployment will not enter; run it on a coarser timeframe or with a shorter" +
          " lookback. An open position is still managed to its exit.",
      };
    }
    return null;
  }

  /**
   * The one silent way the position mirror goes null with the trade row still
   * open: a sync that drops the state entry, which the next sync or tick
   * re-creates empty. Every other writer of `position = null` either follows a
   * submitted exit or a closed or failed row, or logs its own line (the ghost
   * sweep's `ghost_position_cleared`). Said so the next lost mirror names its
   * cause (Mechanism B of the session-end bug, bugs.md).
   */
  private warnDroppedPositionMirror(deploymentId: string, why: string): void {
    const held = this.state.get(deploymentId)?.position;
    if (!held) return;
    this.logEvent(
      "position_mirror_dropped",
      deploymentId,
      `Dropped the engine's in-memory ${held.side === 0 ? "LONG" : "SHORT"} position because ${why}: ` +
        "the engine no longer manages this position (no session-end exit, break-even or trail); " +
        "its brackets stay at the broker, and it is rebuilt from its open trade on the deployment's " +
        "next bar close only if the deployment comes back into the engine's list",
      { tradeId: this.state.get(deploymentId)?.activeTradeId ?? null },
    );
  }

  private applySync(deployments: Deployment[]): void {
    const activeIds = new Set(deployments.map((d) => d.id));
    for (const id of this.state.keys()) {
      if (activeIds.has(id)) continue;
      this.warnDroppedPositionMirror(id, "the deployment list this sync applied does not include it");
      this.state.delete(id);
    }
    for (const warned of [this.spliceGapWarnedAt, this.barAheadWarnedAt, this.stopUnknownWarnedAt]) {
      for (const id of warned.keys()) {
        if (!activeIds.has(id)) warned.delete(id);
      }
    }
    this.accountEntryGate.retain(activeIds);
    // A leg moved onto another account keeps its id, and everything its state
    // holds — bar gate, cooldown anchor, pre-entry order ids — is the old
    // account's. The move refuses a leg with an open trade, so no position goes.
    for (const d of deployments) {
      const was = this.syncedAccountIds.get(d.id);
      if (was !== undefined && was !== d.accountId) {
        this.warnDroppedPositionMirror(d.id, "it moved to another account");
        this.state.delete(d.id);
      }
    }
    this.tickParamsCache.clear();
    this.syncedAccountIds = new Map(deployments.map((d) => [d.id, d.accountId]));
    // Before anything can evaluate a leg this sync admits: a leg resumed
    // after a restart has the same lost latch a booted one has.
    this.restoreSessionEntryLatch(deployments);
    // Replace unconditionally — passive-mode ticks read this array too.
    // Hub-side effects below stay gated on marketHub.isReady().
    this.realtimeDeployments = deployments;
    // Every log line's `display` is read through this cache, and a sync is
    // the only thing that can change a row's account, strategy or ticker
    // under a running engine. Cleared rather than repopulated: a deployment
    // nobody logs about should not cost a row read.
    this.displayCache.clear();
    // After the clear, never before it: a refusal fired by a ticker edit
    // renders its `{display}` through this cache, so classifying first put the
    // pre-edit row on a line that names the new ticker.
    this.classifyActivationRefusals(deployments);
    // Refresh group cache so the next filter pass sees the freshly-synced
    // group state — group enable/disable cascades to engine view in <1 tick.
    this.refreshGroupCache();
    // After both verdicts above: a leg this sync paused, disabled or refused
    // takes no entry, so its last bar's setup reading is no longer true —
    // and it may not be evaluated again to say so.
    this.setupReadings.retain(
      new Set(
        deployments
          .filter((d) => this.isLegEngineEnabled(d) && !this.refusedLegs.has(d.id))
          .map((d) => d.id),
      ),
    );
    if (REALTIME_BARS_ENABLED && this.signalr && this.marketHub.isReady()) {
      this.marketHub.syncContractSubs(deployments).catch((err) =>
        this.logEvent(
          "hub_init_failed",
          ENGINE_CTX,
          `Subscription sync failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    // Reconcile every broker's account-event adapter against the new
    // deployment set. The broker registry itself isn't touched here
    // (that's owned by the periodic refresh), but a deployment add/remove
    // may shift which accounts are *expected*. Idempotent and a no-op
    // when membership hasn't changed.
    void this.syncRealtimeAdapters();
  }

  /**
   * Mark every enabled deployment for an account as orphaned, log loudly,
   * fire one Discord alert listing the paused deployments, and resync
   * realtime state so we don't keep contract subs open for an orphan
   * deployment's contract. Idempotent — markOrphanedByAccount only
   * "transitions" deployments that weren't already orphaned, so repeated
   * calls from racing detection sites collapse to one notification.
   *
   * Called from four detection sites:
   *  - instrumentation.ts: engine boot cross-checks enabled deployments
   *    against live Topstep accounts.
   *  - placeOrder failure path: AccountNotFound (errorCode 1) → instant
   *    auto-pause for that accountId, no waiting for the periodic poll.
   *  - reconcilePendingTrades: 30min searchAccounts() refresh detects
   *    orphans even when no order has fired.
   *  - POST /api/deployments/check-orphans: an on-demand check against a
   *    freshly refreshed registry. No caller in `src/` — the Deployments page
   *    mounted it and went away with its tabs; nothing has picked it up.
   */
  /**
   * The plugin whose client raised this error, or null if no registered
   * plugin claims it.
   *
   * `classifyError` cannot do this on its own — both plugins end in a
   * `return "auth"` catch-all, so asking the wrong one about the other's
   * error gets a confident wrong answer, and `auth` is exactly the kind
   * whose two reactions are opposite (stop the engine vs. pause one
   * account). `ownsError` is the attribution half; see `plugin.ts`.
   */
  private pluginOwningError(err: unknown): BrokerPlugin | null {
    for (const plugin of this.brokerPluginRegistry.allPlugins()) {
      if (plugin.ownsError(err)) return plugin;
    }
    return null;
  }

  /**
   * Whether this error kills the session the engine runs on, as opposed
   * to one account's access. Only a broker that declares
   * `authFailureScope: "engine"` can, and only for an `auth` kind — an
   * `account_unavailable` from the same broker is the orphan path below,
   * not a stop.
   */
  private isEngineFatalAuthError(err: unknown): boolean {
    const owner = this.pluginOwningError(err);
    if (!owner) return false;
    if (owner.capabilities.authFailureScope !== "engine") return false;
    return owner.classifyError(err) === "auth";
  }

  /**
   * Map a broker error to the appropriate orphan-pause action. Driven by
   * the taxonomy, NOT by call path — invoke from any catch arm that wraps
   * a broker REST call (place / cancel / modify / search). Same kind
   * produces the same response everywhere:
   *
   *  - `account_unavailable` — Topstep's AccountNotFound, Tradovate's
   *    AccountNotActive (typed, or an order rejection carrying that
   *    `failureReason`). The account is dead; nothing the deployment can
   *    do but pause.
   *  - `captcha` — lockout is endpoint-scoped at the broker but
   *    account-scoped from here: every request for this account routes
   *    through the same circuit. The Discord alert was already fired by
   *    the penalty handler.
   *  - `auth`, and only from a broker whose `authFailureScope` is
   *    `"account"`. Place-order paths are exempt from the client-side 401
   *    auto-retry (Tradovate `client.ts` `requestRaw`), so a 401 there
   *    propagates raw. Pause rather than thrash; the operator un-pauses
   *    after verifying creds in Settings. A broker whose auth failure is
   *    engine-scoped is handled by `isEngineFatalAuthError`, and stopping
   *    the engine *and* orphaning its accounts would be both.
   *
   * `circuit_open` is intentionally absent — it is transient (60s lockout
   * from a fast-trip) and the next tick should retry rather than pause
   * the account. So are `order_rejected`, `rate_limited`, `network` and
   * `config_missing`: none of them says this account is unusable.
   *
   * `fallbackAccountId` is used when the error carries no accountId of
   * its own (captcha on a global path, a 401 with only a request path) —
   * pass the surrounding deployment/account id.
   */
  private maybeOrphanFromBrokerError(
    err: unknown,
    fallbackAccountId: number,
  ): void {
    const owner = this.pluginOwningError(err);
    if (!owner) return;
    const brokerKind = brokerKindForPluginId(owner.id);
    if (!brokerKind) return;
    const kind = owner.classifyError(err);
    if (kind === "auth" && owner.capabilities.authFailureScope !== "account") return;
    const reason = ORPHAN_PAUSE_REASONS[brokerKind]?.[kind];
    if (!reason) return;
    const accountId = brokerErrorAccountId(err) ?? fallbackAccountId;
    // Void-dispatched from catch arms; an unhandled rejection here terminates
    // the process. `this.log` cannot throw.
    void this.handleOrphanedAccount(accountId, reason).catch((e: unknown) => {
      this.log(
        ENGINE_CTX,
        "error",
        "lifecycle",
        `Could not pause the deployments on account ${accountId} after the broker refused it (${reason}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
        { accountId },
      );
    });
  }

  async handleOrphanedAccount(accountId: number, reason: string): Promise<void> {
    const transitioned = markOrphanedByAccount(accountId, reason);
    if (transitioned.length === 0) return;
    const accountLabel = formatAccountLabel(this.accountNames.get(accountId) ?? null);
    this.logEvent(
      "account_orphaned",
      ENGINE_CTX,
      `Account ${accountLabel} (${accountId}) unavailable — auto-paused ${transitioned.length} deployment(s): ${reason}`,
      { accountId },
    );
    void sendOrphanAlert({
      accountLabel,
      reason,
      deployments: transitioned.map((d) => {
        const strat = getStrategy(d.strategyKey);
        return {
          strategyName: strat?.config.name ?? d.strategyKey,
          ticker: d.ticker,
        };
      }),
    });
    // Resync realtime state so the orphan deployment's contract sub gets
    // dropped if no other enabled deployment cares about it.
    // listEnabledDeployments() applies the staging allowlist filter — on
    // staging this prevents an orphan event from silently re-broadening
    // the deployment set to non-allowlisted accounts. On prod the
    // allowlist is null so this is semantically equivalent to the prior
    // listDeployments().filter(enabled) call.
    const remaining = listManagedDeployments();
    peekBroadcaster()?.emitDeploymentsChanged();
    this.sync(remaining);
  }

  // ── Core loop ─────────────────────────────────────────────────────

  private async tick(deployments: Deployment[]): Promise<void> {
    // Refresh group cache once per tick so all filter sites below see a
    // consistent group view.
    this.refreshGroupCache();

    // Exit-eval site (polling fallback): a leg with an open position
    // stays in the iteration regardless of `enabled` so processDeployment
    // can run BE/trail/session-end/strategy exits on the bar path. The
    // entry-side guard inside processDeployment blocks new entries on
    // disabled legs (and group-disabled legs).
    const enabled = deployments.filter((d) => this.isLegInExitLoop(d));
    if (enabled.length === 0) return;

    // Reconcile pending trades against Topstep before evaluating strategies.
    // Any uncaught throw here would block all strategy evaluation for the
    // tick, so we trap at the boundary — per-trade and per-account failures
    // are already handled inside reconcilePendingTrades.
    try {
      await this.reconcilePendingTrades(enabled);
    } catch (err) {
      this.logEvent(
        "tick_failed",
        ENGINE_CTX,
        `Reconcile pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-snapshot due trades. Best-effort — never blocks strategy eval.
    try {
      await this.processSnapshotQueue();
    } catch (err) {
      this.log(
        ENGINE_CTX,
        "warn",
        "system",
        `Snapshot queue tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const deployment of enabled) {
      // Said once per row at activation (`classifyActivationRefusals`); a line
      // here would be a warn every tick for as long as the row exists.
      const strategy = getStrategy(deployment.strategyKey);
      if (!strategy) continue;

      try {
        await this.processDeployment(strategy, deployment);
      } catch (err) {
        this.logEvent(
          "deployment_tick_failed",
          deployment.id,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: deployment.accountId },
        );
      }
    }
  }

  /**
   * Persist one skipped signal. A quiet session used to leave no row at all,
   * which is what makes "why didn't it trade today" unanswerable on a playbook
   * that fires five times a month.
   *
   * **The write is best-effort and never propagates.** It sits between the
   * strategy's refusal and the tick's return; a failure here must not turn a
   * skip into a `deployment_tick_failed`, because the entry was already
   * correctly declined and the row is diagnostics. The log line beside every
   * call site is the primary record and lands regardless.
   *
   * **The row is built by `build` inside that guard, and the thunk is the
   * whole reason the shape is a thunk.** Every constructor in
   * [`skipped-signal.ts`](../skipped-signal.ts) runs `sessionDateOf`, which
   * throws `RangeError` on an unparseable bar timestamp — evaluated at the
   * call site that lands in `processDeployment`'s catch as the tick failure
   * this method exists not to cause. Today every shipped module guards the
   * timestamp before it can emit a skip, which is a property of four modules
   * rather than of the mechanism.
   */
  private recordSkippedSignal(
    deployment: Deployment,
    gate: string,
    build: () => SkippedSignal,
  ): void {
    try {
      insertSkippedSignal(
        {
          deploymentId: deployment.id,
          groupId: deployment.groupId,
          accountId: deployment.accountId,
          strategyKey: deployment.strategyKey,
          ticker: deployment.ticker,
        },
        build(),
      );
    } catch (err) {
      log.warn(
        "eval",
        `skipped_signals insert failed (gate=${gate} deployment=${deployment.id}): ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        // A SQLite fault takes every leg down at once, and the repeats differ
        // in ids alone.
        "skipped_signals insert failed",
      );
    }
  }

  /**
   * A real signal refused because another deployment holds or is entering the
   * account's position on this contract. Both arms that find that — the
   * open-position read and the lock claim — say it in one event under one
   * gate, and name the holder by the playbook's app name.
   */
  private refuseEntryOnHeldContract(deployment: Deployment, exId: string, latestBar: BarData): void {
    const holderId = this.getContractLockHolder(deployment.accountId, exId);
    // The lookup only names the holder; a failed read must not turn a
    // correctly refused entry into a `deployment_tick_failed`.
    let holderDeployment: Deployment | null = null;
    if (holderId) {
      try {
        holderDeployment = getDeployment(holderId);
      } catch {
        holderDeployment = null;
      }
    }
    const holder: ContractHolder = {
      deploymentId: holderId,
      label: holderDeployment
        ? `${getStrategy(holderDeployment.strategyKey)?.config.name ?? holderDeployment.strategyKey} (${holderId!.slice(0, 8)})`
        : holderId?.slice(0, 8) ?? "(unknown)",
    };
    this.logEvent(
      "entry_contract_locked",
      deployment.id,
      `Entry signal dropped: ${contractHeldReason(deployment.ticker, holder)}`,
      { accountId: deployment.accountId, contractId: exId },
    );
    this.recordSkippedSignal(deployment, CONTRACT_HELD_GATE, () =>
      contractHeldSkip(latestBar, deployment.ticker, holder),
    );
  }

  private async processDeployment(
    strategy: StrategyModule,
    deployment: Deployment,
    trigger?: TriggerClose,
  ): Promise<void> {
    // The setup reading a bar earns is published however the bar ends — every
    // return and every throw below it — so no exit path can leave the last
    // bar's ARMED standing. A throw clears too — most throw before the bar is
    // stamped (a failed contract resolve or bar read), and a dead feed is not
    // a standing setup.
    try {
      await this.processDeploymentBar(strategy, deployment, trigger);
    } catch (err) {
      this.setupReadings.clear(deployment.id);
      throw err;
    } finally {
      this.setupReadings.settle(deployment.id);
    }
  }

  /** The one line for an entry refused on a spliced series with a hole: a
   *  `warn` at most once per deployment per `REPEAT_WARN_WINDOW_MS`, and
   *  `info` for the repeats inside the window. */
  private refuseEntryOnSpliceGap(
    deployment: Deployment,
    trigger: TriggerClose,
    restNewest: string,
    nowMs: number,
  ): void {
    const message = `Entry check skipped on bar ${trigger.bar.timestamp}: the live feed published ${trigger.previousPublishedAt} before it, and REST's newest bar is ${restNewest}, so that bar is missing from the series`;
    const subject = { accountId: deployment.accountId };
    const warnedAt = this.spliceGapWarnedAt.get(deployment.id);
    if (warnedAt != null && nowMs - warnedAt < REPEAT_WARN_WINDOW_MS) {
      this.log(deployment.id, "info", "trade", message, subject);
      return;
    }
    this.spliceGapWarnedAt.set(deployment.id, nowMs);
    this.logEvent("entry_bar_series_gap", deployment.id, message, subject);
  }

  /** `stop_move_unknown_stop`, at most once per trade per
   *  `REPEAT_WARN_WINDOW_MS`; repeats inside the window go out at `info`, so
   *  every refusal is on record. `warn` first because break-even and trail are
   *  off for the position while it lasts. */
  private warnStopUnknown(
    deployment: Deployment,
    tradeId: number | null,
    message: string,
    subject: LogSubject,
    nowMs: number,
  ): void {
    const warned = this.stopUnknownWarnedAt.get(deployment.id);
    if (warned != null && warned.tradeId === tradeId && nowMs - warned.at < REPEAT_WARN_WINDOW_MS) {
      this.log(deployment.id, "info", "order", message, subject);
      return;
    }
    this.stopUnknownWarnedAt.set(deployment.id, { tradeId, at: nowMs });
    this.logEvent("stop_move_unknown_stop", deployment.id, message, subject);
  }

  /** `bar_ahead_of_clock`, at most once per deployment per cause per
   *  `REPEAT_WARN_WINDOW_MS`; repeats inside the window go to `debug`. */
  private warnBarAheadOfClock(deployment: Deployment, cause: BarAheadCause, message: string, nowMs: number): void {
    const warned = this.barAheadWarnedAt.get(deployment.id) ?? {};
    const warnedAt = warned[cause];
    if (warnedAt != null && nowMs - warnedAt < REPEAT_WARN_WINDOW_MS) {
      log.debug("eval", `processDeployment: ${message} deployment=${deployment.id}`);
      return;
    }
    this.barAheadWarnedAt.set(deployment.id, { ...warned, [cause]: nowMs });
    this.logEvent("bar_ahead_of_clock", deployment.id, message, { accountId: deployment.accountId });
  }

  /** `engine_clock_behind`, at most once per engine per `REPEAT_WARN_WINDOW_MS`.
   *  The aggregator closes a bar on a trade stamped in a later bucket, so
   *  the exchange was at least at the bar's close when it published. */
  private warnClockBehind(trigger: TriggerClose, now: Date): void {
    const nowMs = now.getTime();
    const closeMs = Date.parse(trigger.bar.timestamp) + TIMEFRAME_TO_MS[trigger.timeframe];
    const message = `Engine clock is at least ${Math.floor((closeMs - nowMs) / 1000)}s behind the exchange: the live feed closed ${trigger.timeframe} bar ${trigger.bar.timestamp} at ${now.toISOString()} on the engine's clock. Live bars are left out of the series until the clock catches up; REST's newest bar is evaluated instead`;
    if (this.clockBehindWarnedAt != null && nowMs - this.clockBehindWarnedAt < REPEAT_WARN_WINDOW_MS) {
      log.debug("eval", `processDeployment: ${message}`);
      return;
    }
    this.clockBehindWarnedAt = nowMs;
    this.logEvent("engine_clock_behind", ENGINE_CTX, message);
  }

  private async processDeploymentBar(
    strategy: StrategyModule,
    deployment: Deployment,
    trigger?: TriggerClose,
  ): Promise<void> {
    // Refused at activation — no day-session window, or a declared warmup
    // deeper than one request reads. It stays in the loop only to manage a
    // position opened before the refusal; flat, there is nothing here for it
    // to do and no bar read worth paying for. Flat means the row too: a lost
    // mirror over an `open` row is a position, and the rehydrate below needs
    // the bars to rebuild and manage it. Only `open`: the rehydrate seeds from
    // nothing else, so a pending row would pay a bar read every bar for no
    // rebuild until the reconciler settles it.
    const refusal = this.refusedLegs.get(deployment.id);
    if (
      refusal &&
      !this.state.get(deployment.id)?.position &&
      getOpenTradeForDeployment(deployment.id)?.status !== "open"
    ) {
      this.setupReadings.clear(deployment.id);
      return;
    }

    const contract = await this.resolver.resolve(deployment.ticker, deployment.accountId);
    // Execution-side identifier (Tradovate dated symbol for Tradovate-routed
    // deployments; Topstep contract id otherwise). Use this everywhere the
    // value flows into a broker order body, a broker position/order match,
    // or an engine-internal lock that mirrors broker-side identifiers.
    // `contract.id` is the Topstep market-data id and stays in use for
    // bars + SignalR sub keys.
    const exId = executionContractId(contract);

    const tf = resolveTimeframe(strategy.config, deployment.paramValues) as Timeframe;

    // The leg's timeframe changed while this close sat in the queue (or before
    // the hub re-keyed its aggregators): the bar is the old timeframe's, and
    // the leg's new aggregator delivers its own. Only the timeframe is
    // compared, not the whole subscription key — a front-month roll changes
    // the contract half with no resubscribe, and dropping on it would stop the
    // leg's bar closes, exits included, until the next sync. `info`, not
    // `debug`: if the resubscribe failed, every close is dropped here and this
    // line is the only sign the leg's bar-close exits have stopped.
    if (trigger && trigger.timeframe !== tf) {
      this.log(
        deployment.id,
        "info",
        "system",
        `Dropped a ${trigger.timeframe} bar close (${trigger.bar.timestamp}): the leg is now on ${tf} and waits for its own ${tf} close`,
        { accountId: deployment.accountId, burstKey: `tf_mismatch_drop:${deployment.id}` },
      );
      return;
    }

    // Schema defaults ← deployment overrides, through the one helper
    // `classifyActivationRefusals` also uses, so the params the activation
    // verdict was taken on are the params this bar is evaluated on. Resolved
    // ahead of the bar read because the read's depth is a function of them.
    const params = resolveDeploymentParams(strategy, deployment.paramValues, {
      strategyKey: deployment.strategyKey,
      deploymentId: deployment.id,
    });

    // Asked once, here, and used twice — for the fetch depth and for
    // `calculateAll` below. A leg refused *because* `buildIndicators` threw is
    // the case the guard exists for: asking again unguarded put that throw
    // ahead of the exit block, which is the failure the refusal was written to
    // close. A refused leg reaching here is holding a position, so it falls
    // back to the module's static declaration and exits on the price-only
    // filters; an unrefused leg's throw still surfaces as a tick failure.
    let indicatorConfigs: IndicatorConfig[];
    let warmupDaySessions: number;
    // Set when the hook threw: the ids below are the module's *static*
    // declaration and nothing was computed for any of them.
    let indicatorsUnbuilt = false;
    try {
      indicatorConfigs = strategy.buildIndicators?.(params) ?? strategy.config.indicators;
      warmupDaySessions = strategy.warmupDaySessions?.(params) ?? 0;
    } catch (err) {
      if (!refusal) throw err;
      // The static list, not an empty one: it is the only set of ids still
      // knowable once the hook has thrown, and the substitution below needs
      // ids to fill. An empty list left every one of them *absent* from the
      // map, which is the read `shouldExit` cannot survive.
      indicatorConfigs = strategy.config.indicators;
      warmupDaySessions = 0;
      indicatorsUnbuilt = true;
      log.debug(
        "eval",
        `processDeployment: refused leg ${deployment.id} could not build indicators (${err instanceof Error ? err.message : String(err)}); exiting on price-only filters`,
      );
    }

    // Sampled before the read, not after it. Every wall-clock gate below —
    // the session window and the cooldown — has to refer to the instant this
    // tick took the bar up, and the read between them is now a whole warmup
    // window over REST rather than 200 bars. A `now` sampled after it puts a
    // bar that closed inside the session window on the wrong side of it.
    const now = new Date();

    const bars = await this.fetchBars(
      contract,
      tf,
      // A refused leg reads only what its exit filters need. The session-scoped
      // depth exists for a quantity it cannot compute either way — with no
      // window there is no session to walk, and past the ceiling the read is
      // the thing that was refused — so asking for it would be paying a whole
      // warmup window per bar close for nothing. **Clamped, not computed**: the
      // indicator half alone can be past the ceiling, and a throw here lands
      // ahead of the exit block, which is the failure the refusal exists to
      // close.
      refusal
        ? clampFetchDepth({ indicatorConfigs, warmupDaySessions: 0, timeframe: tf })
        : computeFetchDepth({ indicatorConfigs, warmupDaySessions, timeframe: tf }),
    );
    // Topstep's REST bar feed can lag the live SignalR bar close by several
    // seconds. When this fires from onBarClose, append the just-closed bar
    // if REST hasn't caught up yet — otherwise every realtime tick would
    // see a stale `latestBar` and SKIP because we already processed it on
    // the previous tick (or boot polling pass).
    //
    // REST two bars behind leaves a hole the strategy would read as a
    // contiguous series. It is a hole only when the aggregator published a
    // bar REST does not hold yet; a gap neither published (the daily halt, a
    // weekend, a bucket nothing traded in) is the market's. A hole still
    // drives exits and position management (they are owed on what is open)
    // but refuses the entry below. With no previous close on record (the
    // aggregator's first) there is nothing to compare, and the splice is
    // today's. No re-read: inside the fetch's 1s TTL it returns the same
    // answer, and past it a whole warmup window again for a lag of seconds.
    //
    // A bar opening more than one bar interval past the clock is not a bar
    // the engine may evaluate or stamp: stamped as `lastBarTimestamp`, it
    // would make the dedupe below skip every bar until the clock caught up,
    // exits included, and the stamp persists across restarts. Such bars are
    // left out of the series, REST's and the trigger alike. REST reads with
    // `endTime = now` and serves no partial bar, so a REST bar ahead is the
    // feed's fault; a trigger bar ahead is the engine's clock running slow.
    const horizonMs = now.getTime() + TIMEFRAME_TO_MS[tf];
    let restAhead: string | null = null;
    while (bars.length > 0 && isAheadOf(bars[bars.length - 1].timestamp, horizonMs)) {
      restAhead ??= bars[bars.length - 1].timestamp;
      bars.pop();
    }
    if (restAhead != null) {
      this.warnBarAheadOfClock(
        deployment,
        "feed",
        `Left bar ${restAhead} out of the series: REST served it, and it opens more than one ${tf} bar after the engine's clock (${now.toISOString()})`,
        now.getTime(),
      );
    }
    const triggerAhead = trigger != null && isAheadOf(trigger.bar.timestamp, horizonMs);
    if (trigger && triggerAhead) this.warnClockBehind(trigger, now);
    let spliceGapAfter: string | null = null;
    if (trigger && !triggerAhead) {
      const triggerBar = trigger.bar;
      const restNewest = bars[bars.length - 1]?.timestamp;
      if (!restNewest || isNewerBar(triggerBar.timestamp, restNewest)) {
        bars.push(triggerBar);
        if (restNewest && trigger.previousPublishedAt != null && isNewerBar(trigger.previousPublishedAt, restNewest)) {
          spliceGapAfter = restNewest;
        }
        log.debug("eval", `processDeployment: appended SignalR triggerBar ${triggerBar.timestamp} (REST newest was ${restNewest ?? "—"}) deployment=${deployment.id}`);
      }
    }
    if (bars.length === 0) {
      log.debug("eval", `processDeployment: SKIP (no bars) deployment=${deployment.id}`);
      this.setupReadings.clear(deployment.id);
      return;
    }

    const deplState = this.getState(deployment.id);
    const latestBar = bars[bars.length - 1];

    // A cursor ahead of the clock (stamped before the guard above, or restored
    // from the database) would skip every bar until the clock reached it. It
    // is stale: this bar is evaluated and the stamp below overwrites it.
    let cursor = deplState.lastBarTimestamp;
    if (cursor != null && isAheadOf(cursor, horizonMs)) {
      this.warnBarAheadOfClock(
        deployment,
        "cursor",
        `Discarded the stored bar cursor ${cursor}: it is more than one ${tf} bar after the engine's clock (${now.toISOString()}) and would have skipped every bar until then. Evaluating bar ${latestBar.timestamp}`,
        now.getTime(),
      );
      cursor = null;
    }

    // Only a later bar is new. Equal is the same bar in either spelling, and
    // earlier is a lagging REST read behind a trigger bar already evaluated.
    if (cursor != null && !isNewerBar(latestBar.timestamp, cursor)) {
      log.debug("eval", `processDeployment: SKIP (already processed bar ${latestBar.timestamp}) deployment=${deployment.id}`);
      return;
    }

    // There is deliberately no degraded-mode gate here. D-10's `down` state
    // is already enforced above, by `fetchBars` throwing — a feed the engine
    // cannot read aborts this function at its first line, so tier 1 is off
    // for exactly as long as the outage lasts and not one bar longer. The
    // post-outage half of D-10 gates **entries only** and lives in the entry
    // branch below; break-even, trailing and strategy exits are management of
    // a position that is already on the books and resume on the first bar the
    // provider serves.
    deplState.lastBarTimestamp = latestBar.timestamp;
    setLastBarTimestamp(deployment.id, latestBar.timestamp);
    // A new bar: no setup reading until `shouldEnter` below has been reached
    // and returned no signal.
    this.setupReadings.beginBar(deployment.id);
    log.debug("eval", `processDeployment: evaluating bar ${latestBar.timestamp} deployment=${deployment.id} barCount=${bars.length} hasPosition=${!!deplState.position}`);

    // The regime label's lazy path: the first evaluation of a session day this
    // ticker has no row for kicks off a fill. **It never awaits and never
    // throws** — the fill is a year-deep history read, and parking the tick
    // behind one is exactly what the "no decision-time path touches the cache"
    // rule forbids. In practice the first evaluation of a Globex day is the
    // 18:00 ET bar, hours before any day-session playbook can enter, so the
    // row is there by the time the entry path wants to stamp it; when it is
    // not, the trade is stamped unlabelled and nothing is gated either way.
    this.regimeLabels.noteBar(deployment.ticker, latestBar.timestamp);

    const daySession = daySessionForTicker(deployment.ticker);
    // A refused leg reaches here only holding a position. With no session hours
    // on file there is nothing to compute a day-session indicator from, and
    // `calculateAll` would throw ahead of the exit block — the failure the
    // refusal exists to close — so the drop is keyed on the window's absence
    // rather than on the refusal's reason label, and holds for any reason a
    // later condition is refused under. The exit filters' own series need no
    // window, so break-even, trailing and the time stop still run on what the
    // engine already opened. A leg whose `buildIndicators` threw computes
    // nothing at all: the list here is its static declaration, which the module
    // never agreed describes this deployment's params.
    const isDropped = (config: IndicatorConfig): boolean =>
      indicatorsUnbuilt || (daySession == null && indicatorNeedsDaySession(config));
    const indicatorResults = calculateAll(
      refusal ? indicatorConfigs.filter((c) => !isDropped(c)) : indicatorConfigs,
      bars,
      daySession,
    );
    if (refusal) {
      // The dropped configs come back all-NaN rather than absent. Dropping the
      // key hands `shouldExit` a map that is missing an id the strategy itself
      // declared, so a `.values[barIndex]` read throws on the one path the
      // refusal exists to keep running; NaN is the same "no value for this
      // bar" every indicator already answers with, and the `isFinite` guards
      // written for warmup do the refusing. The residual: an id only
      // `buildIndicators` would have produced is still absent on the unbuilt
      // path, because nothing left can name it.
      for (const config of indicatorConfigs) {
        if (!isDropped(config)) continue;
        indicatorResults.set(config.id, {
          id: config.id,
          type: config.type,
          values: new Array<number>(bars.length).fill(NaN),
        });
      }
    }
    const barIndex = bars.length - 1;

    // The playbook's own window minus this deployment's pauses. Resolved
    // before the context so the hook is handed the same intervals the gate
    // below uses; two answers to "when is this leg armed" is the drift the
    // single owner exists to prevent.
    const sessionWindows = collectSessionWindows(strategy.config.session, params);
    // `now` is the wall clock at bar close, so it is already the instant the
    // backtest reconstructs as `bar.timestamp + one bar`. The two paths ask
    // the same question of the same helper from opposite ends of that.
    const inWindow = isInTradableSessionWindow(now, sessionWindows);

    // Mechanism B of the session-end bug (bugs.md): a mirror lost mid-trade
    // with the row still open. The entry path's rehydrate sits behind the
    // enabled, refusal, window and cooldown gates, so a leg past its window,
    // disabled, refused or in cooldown never reached it, and every exit below
    // gates on the mirror — the position rode on its brackets alone, past the
    // session end for the first of those. Seeded here so the exits see it;
    // `placeExitOrder` still sizes and refuses from the broker, and
    // `modifyStopLossToPrice` refuses a stop that would not tighten the one
    // resting there. A leg the entry path does reach keeps that site, and its
    // one-bar delay (A95). Once per trade — see `preExitRehydratedTradeId`.
    // The cooldown gate is asked last and only when flat, as the entry path
    // asks it, so its lazy anchor seed runs where it always did.
    if (
      !deplState.position &&
      !(
        inWindow &&
        !refusal &&
        this.isLegEngineEnabled(deployment) &&
        !this.isInEntryCooldown(deployment.id, deplState, params.cooldownSeconds, now)
      )
    ) {
      const openTrade = getOpenTradeForDeployment(deployment.id);
      if (
        openTrade &&
        deplState.preExitRehydratedTradeId !== openTrade.id &&
        this.rehydrateFromOpenTrade(deployment, deplState, openTrade)
      ) {
        deplState.preExitRehydratedTradeId = openTrade.id;
      }
    }

    if (deplState.position) {
      this.advanceBarsSinceEntry(deployment, deplState, deplState.position, bars);
    }

    // Cross-timeframe bars for exit filters (e.g. 5m strategy running a 15m
    // EMA exit). Only fetched when a position is open AND at least one exit
    // filter declared a non-"same" timeframe — entries never touch this.
    // Parallelized so multiple declared timeframes cost one round-trip worth
    // of latency, not N.
    //
    // **Deliberately outside the health funnel**, calling the module function
    // rather than `this.fetchBars`. This read's failure is tolerated three
    // lines below — caught, warned, the filter skips — so it cannot mean "no
    // bars for evaluation", which is what the `down` seam is defined as; and
    // the evaluation read above it necessarily *succeeded* in this same tick,
    // so folding a failure here in writes evidence its own sibling
    // contradicts. Since `EngineHealth` now measures a failing run against
    // the recovering read's clock, one tolerated failure would otherwise
    // manufacture a threshold-crossing outage on any timeframe past 2m,
    // holding entries back globally and alerting on a feed that never stopped
    // serving. It costs no detection: a genuine outage throws at the
    // evaluation read, which is recorded, and every success there clears the
    // anchor anyway.
    const crossTimeframeBars = new Map<string, BarData[]>();
    if (deplState.position) {
      const neededTfs = getExitFilterTimeframes(params as unknown as AllFilterParams);
      if (neededTfs.length > 0) {
        const results = await Promise.all(
          neededTfs.map(async (tf) => {
            try {
              return [tf, await fetchBarsImpl(contract, tf)] as const;
            } catch (err) {
              this.log(
                deployment.id,
                "warn",
                "system",
                `Exit-filter bar fetch for ${tf} failed: ${err instanceof Error ? err.message : String(err)} — filter for this timeframe will skip`,
                { accountId: deployment.accountId },
              );
              return [tf, [] as BarData[]] as const;
            }
          }),
        );
        for (const [tf, bars] of results) crossTimeframeBars.set(tf, bars);
      }
    }

    const ctx = {
      bars,
      barIndex,
      indicators: indicatorResults,
      position: deplState.position,
      params,
      tickSize: contract.tickSize,
      daySession,
      sessionWindows,
      crossTimeframeBars,
      hasEnteredThisSession: (sessionKey: string, side: OrderSide) =>
        this.hasEnteredThisSession(deployment.id, sessionKey, side),
    };

    // ── Exit logic (only if in position) ────────────────────────────
    // Exit order rejections keep deplState.position intact so the next tick
    // retries; a successful submit flips us flat. Reconciler reconciles the
    // DB side from Topstep's actual position.
    if (deplState.position) {
      // Registry exit filters — modifySl pathway. Exit-type results still
      // flow through the strategy's `shouldExit` (which calls
      // `anyExitFilterTriggered` itself), so this block only handles
      // bracket-modify. Multiple modifySl candidates compose
      // "tightest-favorable wins"; rejected when no candidate would
      // actually tighten the current SL.
      //
      // Step 4 retired the legacy CommonParam BE/trail machinery; the
      // registry filters (`breakeven`, `trail`, `time-stop`) are now the
      // only path for those behaviors. The BE filter's arm-once latch is
      // load-bearing — see breakeven.ts module doc. `markBreakEvenMoved`
      // is called on the first favorable ratchet so trade-row attribution
      // distinguishes BE-stops from original SL hits.
      if (deplState.position && deplState.position.entryFilledAt != null) {
        const exitFilterResults = collectExitFilterResults({
          bars,
          barIndex,
          indicators: indicatorResults,
          side: deplState.position.side,
          params: params as unknown as AllFilterParams,
          tickSize: contract.tickSize,
          crossTimeframeBars,
          position: deplState.position,
        });
        const slCandidates = exitFilterResults
          .filter((r) => r.result.type === "modifySl")
          .map((r) => (r.result as { type: "modifySl"; newSlPrice: number }).newSlPrice);
        if (slCandidates.length > 0) {
          const tightest = pickTightestFavorableSl(
            deplState.position.side,
            deplState.slCurrentPrice,
            slCandidates,
          );
          if (tightest != null) {
            // Flags are stamped per cause, not per modify, through the rule
            // the backtest also uses — a desync labels the same close
            // differently on the two paths.
            const attribution = attributeSlRatchet(
              deplState.position.side,
              deplState.position.entryPrice,
              tightest,
              exitFilterResults,
            );
            try {
              const newSlPrice = await this.modifyStopLossToPrice(
                deployment,
                contract,
                deplState.position,
                deplState.activeTradeId,
                tightest,
                // The close of the bar being evaluated is the freshest mark
                // this path holds, and it is the same series every filter
                // above just made its decision on — so the ratchet and the
                // wrong-side refusal cannot disagree about where the market
                // is. Fresher marks exist (`MarketSub.lastTickPrice`), but
                // they are absent whenever the hub is passive, and a guard
                // that only works in one of the two tick modes is worse than
                // one that is a few seconds stale in both.
                bars[barIndex]?.close ?? null,
                deplState.slCurrentPrice,
                "Exit-filter SL modify",
              );
              deplState.slCurrentPrice = newSlPrice;
              if (attribution.breakEven) {
                if (!deplState.slMovedToBe && deplState.activeTradeId != null) {
                  // The resolved stop, so the chart marker can show where
                  // the broker's stop sits after the move (A20).
                  markBreakEvenMoved(deplState.activeTradeId, newSlPrice);
                }
                deplState.breakEvenMoved = true;
                deplState.slMovedToBe = true;
              }
              if (attribution.trail && deplState.activeTradeId != null) {
                markSlTrailEngaged(deplState.activeTradeId);
              }
            } catch {
              // Logged in modifyStopLossToPrice; retry on next bar.
            }
          }
        }
      }

      // Re-narrow after the SL-modify await. `handleUserPositionEvent` is
      // void-dispatched with no `ticking` guard, so a close event landing
      // during `modifyStopLossToPrice` nulls `position` underneath us — and
      // the exit paths below would then read `.side` off null inside
      // placeExitOrderInner.
      const pos = deplState.position;
      if (!pos) {
        log.debug("eval", `processDeployment: position closed during SL modify deployment=${deployment.id}`);
        return;
      }

      // Force-exit at session close regardless of shouldExit.
      if (!inWindow) {
        // The same split the clock guard states, and for the same reason:
        // on an early close the leg is still *inside* its declared window,
        // so naming `09:30–15:55` at 12:55 reads as a bug in the engine.
        // Both actors can be the one that fires — on a 5m leg the bar
        // opening 12:50 closes at the first instant of the halt, so this
        // path and the 15s guard race — which is why the sentence cannot
        // live in only one of them.
        const earlyClose = isInEarlyCloseHalt(now) ? earlyCloseFor(etDateKey(now)) : null;
        const windowList = sessionWindows.map((w) => `${w.start}–${w.end}`).join(", ");
        const sessionEnd = earlyClose ?? mostRecentWindowEnd(now, sessionWindows);
        const cause =
          earlyClose != null
            ? `The exchange closes early at ${earlyClose} NY, inside the session window (${windowList} NY)`
            : `Outside all session windows (${windowList} NY)`;
        this.logEvent(
          "session_end_flatten",
          deployment.id,
          `${cause} — force-exiting`,
          {
            accountId: deployment.accountId,
            contractId: executionContractId(contract),
            tradeId: deplState.activeTradeId,
            ...(sessionEnd != null ? { values: { time: `at ${sessionEnd} NY` } } : {}),
          },
        );
        try {
          await this.placeExitOrder(
            strategy,
            deployment,
            contract,
            pos,
            deplState.activeTradeId,
            "time_window_close",
          );
          deplState.position = null;
          deplState.breakEvenMoved = false;
          deplState.activeTpTicks = null;
          deplState.activeSlTicks = null;
          deplState.slMovedToBe = false;
          deplState.slCurrentPrice = null;
          deplState.tpCurrentPrice = null;
          deplState.cooldownAnchorAt = now.toISOString(); // exit-anchored cooldown seed
        } catch (err) {
          // Position kept for next-tick retry.
          if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
            noteExitLatchHeldPastWindow(this.exitDeps(), deployment, deplState.activeTradeId);
          }
          this.logExitDispatchFailure(deployment.id, "time_window_close", err);
        }
        return;
      }
      const exitDecision = strategy.shouldExit(ctx);
      const exitTriggered =
        exitDecision === true ||
        (typeof exitDecision === "string" && exitDecision.length > 0) ||
        (typeof exitDecision === "object" && exitDecision.exit === true);
      if (exitTriggered) {
        // String result = registry exit-filter key (e.g. "time_stop",
        // "ema_exit"). Forward as the engineReason directly so the trade
        // row + Discord embed attribute the exit to the firing filter via
        // formatExitReason's filter-key cases. Structured decision (reason
        // string) flows through `strategy_signal:<reason>` as before.
        const reasonDetail =
          typeof exitDecision === "object" ? exitDecision.reason : null;
        const engineReason =
          typeof exitDecision === "string"
            ? exitDecision
            : reasonDetail
              ? `strategy_signal:${reasonDetail}`
              : "strategy_signal";
        try {
          await this.placeExitOrder(
            strategy,
            deployment,
            contract,
            pos,
            deplState.activeTradeId,
            engineReason,
          );
          deplState.position = null;
          deplState.breakEvenMoved = false;
          deplState.activeTpTicks = null;
          deplState.activeSlTicks = null;
          deplState.slMovedToBe = false;
          deplState.slCurrentPrice = null;
          deplState.tpCurrentPrice = null;
          deplState.cooldownAnchorAt = now.toISOString(); // exit-anchored cooldown seed
        } catch (err) {
          // Position kept for next-tick retry.
          this.logExitDispatchFailure(deployment.id, engineReason, err);
        }
      }
      return; // One action per tick
    }

    // ── Entry logic ────────────────────────────────────────────────
    // Defensive: the exit-loop filter sites may admit a disabled leg
    // into processDeployment when it still holds a position. No new
    // entries on disabled legs, and group-disabled or soft-deleted
    // groups must not enter even if the leg's own enabled flag is on.
    if (!this.isLegEngineEnabled(deployment)) {
      log.debug("eval", `processDeployment: SKIP entry (leg/parent disabled) deployment=${deployment.id} groupId=${deployment.groupId}`);
      return;
    }
    // Announced once at activation; silent here, because a refusal that holds
    // for the life of the deployment would otherwise speak on every bar.
    if (refusal) {
      log.debug("eval", `processDeployment: SKIP entry (refused at activation: ${refusal}) deployment=${deployment.id} ticker=${deployment.ticker}`);
      return;
    }
    if (!inWindow) {
      const windowList = sessionWindows.map((w) => `${w.start}-${w.end}`).join(", ");
      log.debug("eval", `processDeployment: SKIP entry (outside all session windows ${windowList}) deployment=${deployment.id}`);
      return;
    }

    // Cooldown — exit-anchored. `cooldownAnchorAt` is set when a position
    // CLOSES (engine-issued exits + reconciler-observed close). After a
    // restart it's null, so we lazy-seed it from the DB's most recent exit
    // timestamp for this deployment.
    if (this.isInEntryCooldown(deployment.id, deplState, params.cooldownSeconds, now)) {
      log.debug("eval", `processDeployment: SKIP entry (cooldown ${params.cooldownSeconds}s from ${deplState.cooldownAnchorAt}) deployment=${deployment.id}`);
      return;
    }

    // DB-backed position guard. In-memory `deplState.position` can desync from
    // reality: process restart wipes memory while the DB still has an open
    // row; placeExitOrder clears memory before Topstep confirms the exit fill.
    // Without this check, a new entry signal during either window fires a
    // reversal order that cancels the original position by netting and leaves
    // the original TP/SL brackets as orphaned OCO working orders.
    const openTrade = getOpenTradeForDeployment(deployment.id);
    if (openTrade) {
      this.rehydrateFromOpenTrade(deployment, deplState, openTrade);
      return;
    }

    // D-14's flap breaker. Entries only: everything above this line is exit
    // and bookkeeping work the engine still owes on positions it opened, and
    // a crash loop is not a reason to stop managing them. What a crash loop
    // *is* a reason to stop is the churn Q-11 named — die, resume, re-enter,
    // die — where every cycle costs a round trip in fees and slippage on a
    // signal nobody re-examined. Set once from the boot verdict; the counter
    // it reads decays on its own, so a run of stable boots clears it.
    if (this.entriesSuspended) {
      log.debug(
        "eval",
        `processDeployment: SKIP entry (restart flap breaker — entries suspended for this process) deployment=${deployment.id}`,
      );
      return;
    }

    // The stop's drain, on the same entries-only reasoning. SIGTERM does not
    // stop the engine, so a bar can close while the process waits on order
    // work; an entry placed then is one the exit at the cap would cut.
    if (isShutdownDraining()) {
      log.debug("eval", `processDeployment: SKIP entry (process stopping) deployment=${deployment.id}`);
      return;
    }

    // The lease, on the same entries-only reasoning. A process paused past
    // `LEASE_FRESH_MS` resumes with an overdue tick and the renew in no
    // guaranteed order, and a tick already awaiting bars survives the
    // `stop()` a lost renew makes — either can reach here after another
    // engine has taken the account.
    if (!holdsLease()) {
      log.debug("eval", `processDeployment: SKIP entry (engine lease not held) deployment=${deployment.id}`);
      return;
    }

    // The account's broker state, entries only on the same reasoning: a dead,
    // locked-out or Topstep OCO-off account takes no new entry, and a position
    // already open on it is managed out above. An unknown OCO setting does not
    // stop a running deployment — see engine-account-entry-gate.ts. Announced
    // on a change of reason; silent per bar.
    if (this.accountEntryGate.skipsEntry(deployment.id, deployment.accountId, now)) {
      log.debug("eval", `processDeployment: SKIP entry (account state) deployment=${deployment.id}`);
      return;
    }

    // D-10's post-outage gate, and the same "entries only" reasoning as the
    // flap breaker above it: a bar that was forming while the feed was down
    // is a setup whose formation nobody watched, which is D-14's
    // discard-the-trigger rule expressed against a bar instead of a restart.
    // Everything above this line is exit and bookkeeping work on a position
    // the engine already holds, and freezing that past the outage is the
    // defect this gate was narrowed to fix. Placed below the stamp on
    // purpose — the bar *was* evaluated, only the entry was refused, so
    // marking it processed is correct and the next bar is unaffected.
    const entryGate = this.health.mayEnterOnBar(new Date(latestBar.timestamp).getTime());
    if (!entryGate.allowed) {
      log.debug("eval", `processDeployment: SKIP entry (${entryGate.reason}) deployment=${deployment.id}`);
      // The backtest takes a signal on this bar, so a held one leaves a line
      // the parity check can read. `shouldEnter` is pure; its answer is
      // reported, never acted on, and touches no latch.
      const heldSignal = strategy.shouldEnter(ctx);
      if (heldSignal && !("skip" in heldSignal)) {
        this.logEvent(
          "entry_held_after_restart",
          deployment.id,
          `[${strategy.config.name}] Entry signal held, not placed: ${entryGate.reason}`,
          { accountId: deployment.accountId, contractId: exId },
        );
      }
      return;
    }

    // The splice above left a hole, and the strategy would read the series
    // as contiguous. Same placement and reasoning as the post-outage gate:
    // the bar was evaluated for everything else, so it stays stamped.
    if (trigger && spliceGapAfter != null) {
      this.refuseEntryOnSpliceGap(deployment, trigger, spliceGapAfter, now.getTime());
      return;
    }

    // Fail closed: a deployment whose latch rows could not be read may have
    // traded a side already, and a second trade there costs more than a
    // missed one. The tick retries the read, because sync runs only when the
    // deployment set changes.
    if (!this.sessionLatchRestored.has(deployment.id)) {
      this.restoreSessionEntryLatch([deployment]);
      if (!this.sessionLatchRestored.has(deployment.id)) {
        log.debug("eval", `processDeployment: SKIP entry (session latch not restored) deployment=${deployment.id}`);
        return;
      }
    }

    const signal = strategy.shouldEnter(ctx);
    // Display only, and after the decision: the hook is pure and its answer
    // reaches nothing but the dashboard chip.
    if (!signal || "skip" in signal) this.setupReadings.offer(deployment.id, strategy, ctx);
    if (!signal) {
      // Conditions reset — clear the stale-signal latch. The next genuine
      // signal fires normally.
      deplState.signalSuppressed = false;
      return;
    }
    if ("skip" in signal) {
      // Structured gate-rejection — strategy opted into trade-skip
      // instrumentation. Format on a single line so /logs search can find
      // it: `[<playbook name>] <skip> — gate:<gate> k1=v1 k2=v2`. The name is
      // `config.name`, as the app shows it — the key stays in `display`.
      // Detail keys come from the strategy's `detail` object verbatim; the
      // engine doesn't own the schema.
      const detailParts: string[] = [];
      if (signal.detail) {
        for (const [k, v] of Object.entries(signal.detail)) {
          detailParts.push(`${k}=${typeof v === "string" ? v : String(v)}`);
        }
      }
      const tail = detailParts.length > 0 ? ` ${detailParts.join(" ")}` : "";
      // The event, not a level: `trade` and `trade-skip` share
      // `info`/`trade`, so `entry_skipped` is the only thing that keeps the
      // TRADE-SKIP chip apart from TRADE. See `deriveLegacyLevel`.
      const gatePhrase = describeEntryGate(signal.gate);
      this.logEvent(
        "entry_skipped",
        deployment.id,
        `[${strategy.config.name}] ${signal.skip} — gate:${signal.gate}${tail}`,
        {
          accountId: deployment.accountId,
          contractId: exId,
          ...(gatePhrase != null ? { values: { gate: gatePhrase } } : {}),
        },
      );
      // The same skip, on the row rather than in the ring buffer. `EntrySkip`
      // is emitted only on real-candidate bars, so the volume is bounded by
      // the playbook's candidate window rather than by the session — see
      // `db/skipped-signals.ts`. The backtest builds this row through the same
      // constructor, which is what keeps the two paths' vocabularies one.
      this.recordSkippedSignal(deployment, signal.gate, () => strategySkip(signal, latestBar));
      // EntrySkip is emitted only on real-candidate bars (reference_entry_skip_contract.md):
      // a filter rejected the entry for an orthogonal reason, but the underlying
      // breakout/signal IS still being asserted. Do NOT clear the latch — only a
      // plain null (conditions genuinely reset) should do that.
      return;
    }

    // Global gate: any open position on (account, contract) — regardless of
    // which deployment owns it — blocks new entries. Topstep nets positions
    // per (account, contract), so a second deployment entering would either
    // share or reverse the existing one. The contract lock below catches
    // pending entries we've claimed; this read covers already-filled
    // positions held by any deployment on the account.
    //
    // Suppression latch: a signal that fires here is "stale" relative to
    // the next flat-account bar. Latch it so the strategy can't re-trigger
    // on the same continuously-true condition (e.g. price still above ORB
    // high) the instant another deployment's position closes. The latch
    // only clears when `shouldEnter` returns a plain null (never a skip) — proving conditions
    // genuinely reset.
    //
    // The three account refusals below are the book's `REFUSALS`, and each
    // writes a skip row under the book's gate id so the daily parity check can
    // see a block live as the book does (A108). They follow a real signal only,
    // so they stay inside the candidate-bar volume bound.
    if (this.hasOpenPositionOnContract(deployment.accountId, exId)) {
      deplState.signalSuppressed = true;
      this.refuseEntryOnHeldContract(deployment, exId, latestBar);
      return;
    }

    // Account is flat but the latch is still active — conditions haven't
    // reset since suppression. Block the entry and wait for a null bar.
    if (deplState.signalSuppressed) {
      this.logEvent(
        "entry_stale_signal",
        deployment.id,
        `[${strategy.config.name}] Entry signal dropped: ${STALE_LATCH_REASON}`,
        { accountId: deployment.accountId, contractId: exId },
      );
      this.recordSkippedSignal(deployment, STALE_LATCH_GATE, () => staleLatchSkip(latestBar));
      return;
    }

    // Daily-PnL money gate. Per-**account**, session-scoped (6pm → 4pm ET),
    // gross realized only by default. Inclusive thresholds. Block-only —
    // never force-flattens (an open position from a prior bar can still
    // play out). At this point the deployment is flat by construction
    // (open-trade and contract-position guards above already returned),
    // so unrealized = 0 even when the include-unrealized flag is on. A trip
    // logs and records a skip on every signalled bar, like the arms above.
    //
    // The number and the sum both come from the account: it is Topstep's rule,
    // and two playbooks on one account spend one drawdown. Read per tick rather
    // than cached — the operator can change it in Settings mid-session, and the
    // read is one indexed lookup on `account_brokers`.
    {
      const sessionStart = currentCmeSessionStart(now);
      const realizedGross = getAccountRealizedSinceGross(deployment.accountId, sessionStart);
      const gate = evaluateDailyPnlGate({
        ...getAccountDailyPnlLimits(deployment.accountId),
        realizedGross,
        unrealized: 0,
      });
      if (gate.tripped) {
        // The evaluator sets both whenever it trips; the check is the type's.
        if (gate.side != null && gate.thresholdUsd != null) {
          const numbers = { side: gate.side, thresholdUsd: gate.thresholdUsd, effectivePnlUsd: gate.effectivePnl };
          this.logEvent(
            "entry_daily_pnl_limit",
            deployment.id,
            `[${strategy.config.name}] Entry signal dropped: ${dailyPnlReason(numbers)}`,
            { accountId: deployment.accountId, contractId: exId },
          );
          this.recordSkippedSignal(deployment, DAILY_PNL_GATE, () => dailyPnlSkip(latestBar, numbers));
        }
        return;
      }
    }

    // Contract-level lock: only one deployment at a time may hold an open
    // or pending position on a given (account, contract). Topstep exposes a
    // single net position per pair, so two deployments entering simultaneously
    // would share one position with conflicting brackets. Signals from a
    // blocked deployment are dropped (not queued) — the next signal a few
    // bars later is usually a better setup than a stale one.
    //
    // Claim the lock atomically here (single check+claim) BEFORE any REST
    // awaits in placeEntryOrder. Doing it earlier closes the TOCTOU window
    // that would otherwise exist between a separate peek and the eventual
    // claim — important the moment any caller stops being strictly serial.
    if (!this.acquireContractLock(deployment.accountId, exId, deployment.id, null)) {
      this.refuseEntryOnHeldContract(deployment, exId, latestBar);
      return;
    }

    // Brackets are deterministic: the strategy emits both legs on the
    // signal and both pass through untouched — the deployment-level
    // Override / Min / Max knobs are deleted, so the only platform opinion
    // left is validity. No fallback path — a strategy that fails to emit a
    // usable slTicks or tpTicks is a bug, and the engine refuses to arm the
    // entry rather than ship a guess.
    const badLeg = !isValidBracketTicks(signal.slTicks)
      ? (["slTicks", signal.slTicks] as const)
      : !isValidBracketTicks(signal.tpTicks)
        ? (["tpTicks", signal.tpTicks] as const)
        : null;
    if (badLeg) {
      this.logEvent(
        "entry_blocked",
        deployment.id,
        `Entry blocked: strategy ${deployment.strategyKey} emitted invalid ${badLeg[0]}=${String(badLeg[1])}. Strategy must return a positive number of ticks.`,
        { accountId: deployment.accountId, contractId: exId },
      );
      this.releaseContractLock(deployment.accountId, exId, deployment.id);
      return;
    }
    const resolvedTp = signal.tpTicks;
    const resolvedSl = signal.slTicks;

    // Capture the filter + engine-gate state at trigger time. Pinned to
    // the trade row so the live-vs-backtest replay can faithfully
    // reconstruct the gate evaluation that fired this entry. Today's
    // filters are stateless (snapshotAllFilterState returns {}); the
    // engine-level cooldown anchor is the only meaningful gate that
    // isn't derivable from bars + params at replay time.
    //
    // Wrapped in try/catch because a future stateful filter's snapshot()
    // can throw — the contract lock is already held here, so an unhandled
    // throw would propagate to the outer catch which only logs and would
    // leak the lock. Persist a null snapshot and let the entry proceed:
    // replay correctness on this single trade is a worse outcome than
    // poisoning the contract slot.
    let filterSnapshot: Record<string, unknown> | null;
    try {
      filterSnapshot = {
        filters: snapshotAllFilterState({
          bars,
          barIndex,
          indicators: indicatorResults,
          side: signal.side,
          params: params as unknown as AllFilterParams,
          tickSize: contract.tickSize,
        }),
        cooldownAnchorAt: deplState.cooldownAnchorAt,
        triggerBarTimestamp: latestBar.timestamp,
      };
    } catch (err) {
      this.log(
        deployment.id,
        "warn",
        "system",
        `Filter snapshot capture failed; persisting null (replay will fall back): ${err instanceof Error ? err.message : String(err)}`,
        { accountId: deployment.accountId, contractId: exId },
      );
      filterSnapshot = null;
    }

    // Size the entry from the account's risk posture: the largest contract
    // count whose loss at this stop fits the budget, capped by the account's
    // ceiling. Throws on a missing posture or an input it cannot make sense
    // of — catch at the boundary, log, release the lock, skip the tick. No
    // order placement on undefined size.
    //
    // The budget is the *session's*, not the flat field: `resolveSessionPosture`
    // runs the account's declared phase against its last recorded close and
    // hands back an ordinary posture. In phase `off` that is byte-for-byte the
    // flat pair. Its own throws — a phase off Topstep, a combine on an MLL
    // nobody measured, a close at or below the floor — land in this same catch
    // deliberately: they are inputs the platform cannot price an entry from,
    // which is what this arm already means.
    let sized: RiskSizeResult;
    let budget: SessionBudget;
    try {
      budget = resolveSessionPosture(deployment.accountId, now);
      sized = resolveRiskSizedContracts({
        slTicks: resolvedSl,
        tickValue: contract.tickValue,
        feePerSideUsd: feePerSideFor(deployment.ticker),
        posture: budget.posture,
        playbook: playbookSizingFrom(params),
        where: `deployment ${deployment.id}`,
      });
    } catch (err) {
      this.releaseContractLock(deployment.accountId, exId, deployment.id);
      const failure = err instanceof Error ? err.message : String(err);
      this.logEvent(
        "entry_blocked",
        deployment.id,
        `Entry blocked: ${sizeResolutionReason(failure)}`,
        { accountId: deployment.accountId, contractId: exId },
      );
      // The third writer, and the one a fresh build hits most: until the
      // operator sets a risk posture the sizer throws on every entry tick, so
      // without a row here the single most likely reason a staging session is
      // quiet leaves no evidence at all. It meets the criterion the other two
      // do — the strategy asked for the trade and the platform refused it.
      this.recordSkippedSignal(deployment, SIZE_RESOLUTION_GATE, () =>
        sizeResolutionSkip(latestBar, { slTicks: resolvedSl, failure }),
      );
      return;
    }
    this.noteStaleRiskPhase(deployment, budget, now);
    // A budget refusal is transient — the next setup's stop may fit — so it
    // is `entry_risk_budget` rather than `entry_blocked`, and it names both
    // numbers so a run of them reads as a geometry problem rather than as a
    // quiet market.
    if (!sized.sized) {
      this.releaseContractLock(deployment.accountId, exId, deployment.id);
      // One spelling of the refusal, shared with the row: the operator reads
      // the line and the review reads the column, and two sentences for one
      // number drift apart on the first edit.
      const numbers = {
        slTicks: resolvedSl,
        riskPerContractUsd: sized.riskPerContractUsd,
        // The budget the division refused: the playbook's share of the account's.
        maxRiskPerTradeUsd: sized.budgetUsd,
      };
      this.logEvent(
        "entry_risk_budget",
        deployment.id,
        `Entry skipped: ${riskBudgetReason(numbers)}`,
        { accountId: deployment.accountId, contractId: exId },
      );
      // The platform's own skip. The strategy wanted this trade, so it is not
      // an `EntrySkip` and carries no strategy gate — `riskBudgetSkip` gives
      // it the platform gate id the backtest CLI already counts under.
      this.recordSkippedSignal(deployment, RISK_BUDGET_GATE, () =>
        riskBudgetSkip(latestBar, numbers),
      );
      return;
    }
    const effectiveSize = sized.contracts;

    let entryResult: PlacedEntry;
    try {
      entryResult = await this.placeEntryOrder(
        strategy,
        deployment,
        contract,
        signal.side,
        params,
        resolvedTp,
        resolvedSl,
        latestBar.close,
        filterSnapshot,
        effectiveSize,
        {
          maxRiskPerTradeUsd: sized.posture.maxRiskPerTradeUsd,
          maxContracts: sized.posture.maxContracts,
          riskPerContractUsd: sized.riskPerContractUsd,
          appliedPlaybookMaxContracts: sized.playbook.maxContracts,
          appliedPlaybookRiskPercent: sized.playbook.riskPercent,
          playbookBudgetUsd: sized.budgetUsd,
          phase: budget.phase,
          basis: budget.basis,
          headroomUsd: budget.headroomUsd,
          floorUsd: budget.floorUsd,
          closeUsd: budget.closeUsd,
          peakUsd: budget.peakUsd,
          sizesSessionStart: budget.sizesSessionStart,
        },
        latestBar.timestamp,
        this.regimeAtEntry(deployment.ticker, latestBar.timestamp),
        signal.sessionKey,
      );
    } catch {
      // Error already logged; skip state update so we try again next signal.
      return;
    }

    deplState.activeTradeId = entryResult.tradeId;
    deplState.preEntryOrderIds = entryResult.preEntryOrderIds;
    deplState.activeTpTicks = resolvedTp;
    deplState.activeSlTicks = resolvedSl;
    // Unconditional: a stale stop from the previous trade must not survive
    // into this one. The entry-never-filled teardowns do not clear it, and
    // the no-loosen check in modifyStopLossToPrice would compare against it.
    // Topstep's reconciler seed still wins later, because it overwrites.
    deplState.slCurrentPrice = entryResult.slCurrentPrice;
    // Stash the strategy's session key so the fill-confirmation path can
    // latch `sessionEntryLatch` against the same key the strategy will
    // ask about on subsequent bars. Strategies that don't enforce a cap
    // omit `sessionKey` and the latch never fires for this entry.
    deplState.pendingEntrySessionKey = signal.sessionKey ?? null;

    // On a feed whose entry-fill event can beat the place response, that
    // event fires concurrently with placeEntryOrder's await. For group
    // legs processed later in the sequential loop it arrives, writes
    // entry_filled_at to the DB (early write in handleUserPositionEvent),
    // then hits the `activeTradeId !== trade.id` guard — still null at
    // that point — and returns without promoting entryFilledAt onto
    // in-memory position state. Sync from the DB now so the exit-filter
    // block isn't blocked until the first bar close. A feed whose fill
    // event provably follows the place response never lost the promotion,
    // so the re-read is a wasted query on the entry path.
    let promotedEntryFilledAt: string | null = null;
    let promotedEntryPrice = latestBar.close;
    if (
      this.pluginFor(this.brokerKindFor(deployment.accountId))
        .capabilities.entryFillMayRacePlaceResponse &&
      entryResult.tradeId != null
    ) {
      const tradeRow = getTradeById(entryResult.tradeId);
      if (tradeRow?.entryFilledAt != null) {
        promotedEntryFilledAt = tradeRow.entryFilledAt;
        promotedEntryPrice = tradeRow.entryPrice ?? latestBar.close;
      }
    }

    const position: OpenPosition = {
      side: signal.side,
      entryPrice: promotedEntryPrice,
      entryTimestamp: now.toISOString(),
      barsSinceEntry: 0,
      entryFilledAt: promotedEntryFilledAt,
      size: effectiveSize,
      slTicks: resolvedSl,
    };
    deplState.position = position;
    const anchor = signalBarAnchor(latestBar.timestamp);
    if (anchor) this.barCountAnchors.set(position, anchor);
  }

  // ── Order placement ───────────────────────────────────────────────

  private async placeEntryOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    side: OrderSide,
    params: CommonParams,
    resolvedTp: number,
    resolvedSl: number,
    desiredEntryPrice: number,
    filterSnapshot: Record<string, unknown> | null,
    size: number,
    risk: EntryRiskFacts,
    signalBarTs: string,
    regime: { label: string; classifierVersion: string } | null,
    sessionKey: string | undefined,
  ): Promise<PlacedEntry> {
    return placeEntryOrderImpl(
      {
        brokerFor: (d) => this.brokerFor(d),
        brokerKindFor: (a) => this.brokerKindFor(a),
        pluginFor: (k) => this.pluginFor(k),
        log: (d, sev, cat, m, s) => this.log(d, sev, cat, m, s),
        logEvent: (e, d, m, s) => this.logEvent(e, d, m, s),
        releaseContractLock: (a, c, d) => this.releaseContractLock(a, c, d),
        acquireContractLock: (a, c, d, t) => this.acquireContractLock(a, c, d, t),
        openBufferSlot: (a, c, t) => this.openBufferSlot(a, c, t),
        maybeOrphanFromBrokerError: (e, a) => this.maybeOrphanFromBrokerError(e, a),
        // The classification maybeOrphanFromBrokerError reads; the job runs a
        // check only on a refusal, spaced.
        noteEntryRejected: (err, accountId) =>
          this.accountStatusJob.noteEntryRejected(this.pluginOwningError(err)?.classifyError(err) ?? null, accountId),
        buildCustomTag,
        engineSessionId: this.engineSessionId,
      },
      strategy,
      deployment,
      contract,
      side,
      params,
      resolvedTp,
      resolvedSl,
      desiredEntryPrice,
      filterSnapshot,
      size,
      risk,
      signalBarTs,
      regime,
      sessionKey,
    );
  }

  /**
   * Say once, per account per session, that the account is sizing on its
   * phase's lowest budget because the app has no close for this session.
   *
   * The resolver deliberately does not log — a stale sample is a state, not an
   * event, and it is read on every entry tick. The warn belongs here because
   * only the engine can hold the once-per-session anchor, and `warn` is never
   * emitted per tick. It is not a refusal: the entry proceeds, sized down.
   */
  private noteStaleRiskPhase(deployment: Deployment, budget: SessionBudget, now: Date): void {
    if (budget.basis !== "stale_floor" || budget.posture == null) return;
    const sessionStart = currentCmeSessionStart(now);
    if (this.riskPhaseStaleWarnedAt.get(deployment.accountId) === sessionStart) return;
    this.riskPhaseStaleWarnedAt.set(deployment.accountId, sessionStart);
    const found = budget.sizesSessionStart ?? "no close on record";
    this.logEvent(
      "risk_phase_stale",
      deployment.id,
      `Account ${deployment.accountId} is on the lowest risk budget of its ` +
        `${ACCOUNT_RISK_PHASE_LABELS[budget.phase]} phase, ` +
        `$${budget.posture.maxRiskPerTradeUsd.toFixed(2)} a trade: it wanted the balance at the ` +
        `close before the session that opened ${sessionStart}, and has ${found}. ` +
        `It stays on that budget until a close is recorded.`,
      { accountId: deployment.accountId },
    );
  }

  /**
   * The regime label to stamp on a trade about to be placed: whatever
   * `regime_days` holds for the signal bar's session day, read synchronously
   * and never computed here.
   *
   * **Null is a real answer and is not repaired.** A session nothing has
   * labelled yet leaves the columns null, which reads as *unlabelled* —
   * distinct from `"unknown"`, which is the classifier's own fail-closed
   * answer to a baseline it could not fill. Guarded because a diagnostic
   * column must never turn a fillable entry into a tick failure.
   */
  private regimeAtEntry(
    ticker: TickerSymbol,
    barTimestamp: string,
  ): { label: string; classifierVersion: string } | null {
    try {
      const day = this.regimeLabels.labelFor(ticker, sessionDateOf(new Date(barTimestamp)));
      return day == null ? null : { label: day.label, classifierVersion: day.classifierVersion };
    } catch {
      return null;
    }
  }

  private exitDeps(): ExitOrderDeps {
    return {
      brokerFor: (d) => this.brokerFor(d),
      getState: (id) => this.getState(id),
      log: (d, sev, cat, m, s) => this.log(d, sev, cat, m, s),
      logEvent: (e, d, m, s) => this.logEvent(e, d, m, s),
      maybeOrphanFromBrokerError: (e, a) => this.maybeOrphanFromBrokerError(e, a),
      resolveContract: (t, a) => this.resolver.resolve(t, a),
      notifyForceClose: (t, ep, te, se, sub) => this.notifyForceClose(t, ep, te, se, sub),
      buildCustomTag,
      stateMap: this.state,
    };
  }

  private async placeExitOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    activeTradeId: number | null,
    reason: string,
    intent: ExitIntent = "engine_exit",
  ): Promise<void> {
    return placeExitOrderImpl(
      this.exitDeps(),
      strategy,
      deployment,
      contract,
      position,
      activeTradeId,
      reason,
      intent,
    );
  }

  /**
   * Shared catch arm for the four exit-dispatch sites, all of which keep
   * `deplState.position` on a throw so the next tick retries. These used to
   * be empty on the grounds that `placeExitOrder` had already logged, which
   * only holds for a rejected order: a failed `searchOpenPositions` rethrows
   * unlogged, and anything unexpected surfaces nowhere at all.
   *
   * `EXIT_IN_FLIGHT` stays silent — the latch already logs it at info, and it
   * is the one arrival frequent enough to drown the log during a tick storm.
   *
   * Every other arrival is *throttled*, which is not the same thing. The
   * dispatch conditions that reach here are standing ones — a stranded leg
   * throws `EXIT_FLAT_MISMATCH` until the reconciler closes its row, minutes
   * later — and `evaluateRealtimeExits` re-enters on every price change, so an
   * unthrottled line puts one warning per quote into the ring buffer. The key
   * carries the arm and a normalised message, so a different failure is
   * announced on the tick it happens; only repetition is quieted. The control
   * flow is untouched: every caller still keeps its position mirror for the
   * retry.
   */
  private logExitDispatchFailure(deploymentId: string, reason: string, err: unknown): void {
    if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) return;
    const detail = err instanceof Error ? err.message : String(err);
    const state = this.getState(deploymentId);
    // Digit runs are stripped from the **key only** — the line below still
    // prints the whole message. A single-slot last-key anchor is defeated
    // outright by a message carrying a varying token, and that is reachable
    // rather than theoretical: `TradovateCircuitOpenError` interpolates a
    // countdown computed at construction, `assertCircuitClosed` throws a
    // freshly built one before every wire call, and the first thing
    // `placeExitOrderInner` does is a `searchOpenPositions` whose catch arm
    // rethrows unlogged — so this was one line per quote for up to the hour a
    // p-captcha circuit stays open, and `circuit_open` is outside the
    // orphan-pause set so nothing else spoke. Same shape for any wrapped body
    // carrying a trace id or a timestamp. A `Map` keyed on the message would
    // trade this for unbounded growth on a 24/7 process.
    //
    // Four or more, not `\d+`: **an HTTP status is exactly three digits**, and
    // collapsing it erased the only thing that distinguishes two transport
    // failures on the same path. Both clients wrap a non-2xx as `… API error
    // <status> on <path>: …` on a plain `Error`, so nothing else in the
    // message varies — a 429 and a 502 ninety seconds apart normalised to one
    // key and the 502 went unsaid for the rest of the window, on the arm where
    // this line is the only voice and where the two want opposite operator
    // responses. Order ids, account ids, epoch stamps and
    // `TradovateCircuitOpenError`'s `remainMs` are all four digits or more and
    // still collapse. Accepted residual: in the last second of a circuit
    // window `remainMs` drops to three digits and a handful of extra lines
    // print — bounded by quotes-in-one-second, against the hour of per-quote
    // spam this key exists to stop.
    //
    // The trade id is the same axis the sibling anchor carries, and for the
    // same reason: without it a second trade stranding the same way inside the
    // window is silenced by the first one's stamp. That is a genuinely
    // separate incident — the reconciler closed the first row, a new entry
    // filled, and it stranded too — and on the `searchOpenPositions`-throw arm
    // there is no other line at all.
    const key = `${state.activeTradeId ?? "none"}|${reason}|${err instanceof Error ? err.name : "unknown"}|${detail.replace(/\d{4,}/g, "#")}`;
    const anchor = state.exitDispatchWarnedAt;
    const nowMs = Date.now();
    if (anchor !== null && anchor.key === key && nowMs - anchor.at < EXIT_DISPATCH_WARN_MS) return;
    state.exitDispatchWarnedAt = { key, at: nowMs };
    // The trade id rides the **message** as well as the key, and that is a
    // composition rule rather than decoration. The log pipe collapses
    // repeats on the text it is handed, so a discriminator this anchor
    // carries and the message omits is one the pipe erases: a second trade
    // stranding the same way re-stamps the anchor here — the key differs —
    // and is then folded onto the first trade's row and reaches no surface
    // at all. See docs/modules/logging/README.md.
    const subject = state.activeTradeId === null ? "" : ` for trade #${state.activeTradeId}`;
    this.logEvent(
      "exit_dispatch_failed",
      deploymentId,
      `Exit dispatch (${reason})${subject} failed: ${detail} — position kept for next-tick retry`,
      { tradeId: state.activeTradeId },
    );
  }

  // ── Reconciliation ────────────────────────────────────────────────

  private reconcileDeps(): ReconcileDeps {
    return {
      log: (d, sev, cat, m, s) => this.log(d, sev, cat, m, s),
      logEvent: (e, d, m, s) => this.logEvent(e, d, m, s),
      brokerForAccount: (a) => this.brokerForAccount(a),
      maybeOrphanFromBrokerError: (e, a) => this.maybeOrphanFromBrokerError(e, a),
      noteBrokerOutcome: (a, ok, reason) =>
        this.health.noteBrokerOrders(a, ok, reason, Date.now()),
      stateFor: (id) => this.state.get(id),
      resolveExitReason: (k, r, c) => this.resolveExitReason(k, r, c),
      brokerKindFor: (a) => this.brokerKindFor(a),
      capabilitiesFor: (k) => this.pluginFor(k).capabilities,
      validationAttempts: this.validationAttempts,
      lastHourlyValidationSweepAt: this.lastHourlyValidationSweepAt,
      approximatedSweepPasses: this.approximatedSweepPasses,
      entryNotifiedTradeIds: this.entryNotifiedTradeIds,
      releaseContractLock: (a, c, d) => this.releaseContractLock(a, c, d),
      settleIfFlat: (id) => this.closingGuard.settleIfFlat(id),
      markEnteredThisSession: (d, k, s) => this.markEnteredThisSession(d, k, s),
      isAccountRegistered: (a) => this.isAccountRegistered(a),
      handleOrphanedAccount: (a, r) => this.handleOrphanedAccount(a, r),
      realtimeSuppressesPolling: (a) => this.realtimeSuppressesPolling(a),
      refreshBrokerRegistry: () => this.refreshBrokerRegistry(),
      accountNamesSnapshot: () => this.brokerRegistry.accountNamesSnapshot(),
      accountNames: this.accountNames,
      accountNamesRefreshedAt: () => this.accountNamesRefreshedAt,
      setAccountNamesRefreshedAt: (at) => { this.accountNamesRefreshedAt = at; },
      brokerRegistryLastAttemptAt: () => this.brokerRegistryLastAttemptAt,
      setBrokerRegistryLastAttemptAt: (at) => { this.brokerRegistryLastAttemptAt = at; },
      resolveContract: (t, a) => this.resolver.resolve(t, a),
      resolveExitFillPrice: (t) => this.resolveExitFillPrice(t),
      snapshotTradeBars: (id) => this.snapshotTradeBars(id),
      noteTradeClosed: () => this.accountStatusJob.noteTradeClosed(),
      notifyEntry: (t, p, f, s) => this.notifyEntry(t, p, f, s),
      notifyExit: (t, xp, xf, pt, pd, l) => this.notifyExit(t, xp, xf, pt, pd, l),
      forceCloseAfterBracketFailure: (t, d, ep, te, se) =>
        this.forceCloseAfterBracketFailure(t, d, ep, te, se),
      isClosingFill: (k, f, t) => this.isClosingFill(k, f, t),
      bufferSlotKey: (a, c, t) => TradingEngine.bufferSlotKey(a, c, t),
      bufferSlotFor: (k) => this.fillBuffer.get(k),
      buildCustomTag,
    };
  }

  /**
   * For every pending_entry / pending_exit row, look up the authoritative
   * Topstep order + position state per account and update the DB. This is
   * the only place PnL gets written — we use Topstep's reported fill price
   * and current position size, not the prices we guessed at submit time.
   */
  private async reconcilePendingTrades(
    deployments: Deployment[],
    positionReads?: PassPositionReads,
  ): Promise<void> {
    return reconcilePendingTradesImpl(this.reconcileDeps(), deployments, positionReads);
  }

  /**
   * Engine-side divergence sweep. For every managed deployment whose
   * `deplState.position` is set, verify the broker still reports a matching
   * open position. If the broker is flat (or size 0), null the local
   * position state so quote-tick exit handlers stop racing past the
   * broker-flat guard before the next reconcileOneTrade pass closes the
   * trade row.
   *
   * Mismatched-but-present positions (different size or side) are logged
   * only — auto-correcting them risks rewriting state out from under a
   * partial fill or a manual broker-side adjustment. Broker positions on
   * contracts no deployment claims are handled by the naked-position
   * watchdog (see runNakedPositionWatchdog) — don't duplicate here.
   *
   * Activetradeid is intentionally NOT cleared: the trade-row close path
   * in reconcileOneTrade owns DB-side reconciliation. This sweep only
   * heals the in-memory mirror that gates runtime decisions.
   */
  private async reconcileGhostPositions(
    deployments: Deployment[],
    positionReads?: PassPositionReads,
  ): Promise<void> {
    return reconcileGhostPositionsImpl(this.reconcileDeps(), deployments, positionReads);
  }

  /**
   * Re-run the exit resolver against a closed trade whose exit data came
   * from the bar-close approximation. On success, rewrites exit_price /
   * pnl_dollars / fees / slippage columns and clears the
   * `exit_approximated` flag. No-op if the resolver still can't see the
   * fills (Topstep continues to lag indexing) — caller's loop just retries
   * on the next tick.
   *
   * Idempotent: clearing the flag means subsequent ticks skip this row
   * entirely. Safe to invoke from both the heal pass and the user-hub
   * position-close fast path.
   */
  private async healApproximatedExitFromFills(
    trade: StrategyTrade,
    accountId: number,
  ): Promise<boolean> {
    return healApproximatedExitFromFillsImpl(this.reconcileDeps(), trade, accountId);
  }

  /**
   * Validate that a closed trade's stored entryPrice / exitPrice / pnlDollars
   * agree with what Topstep's /Trade/search reports for the trade's order ids.
   * On drift beyond tolerance, overwrite the row via the heal write path and
   * log a WARN. No-op when:
   *
   *   - row is not closed (defensive)
   *   - row has no entryOrderId (legacy/manual rows we can't validate)
   *   - Trade/search hasn't indexed any fills yet (the periodic sweep retries)
   *   - all stored values agree within tolerance
   *
   * Idempotent: a second invocation with already-corrected values is a no-op.
   * Stronger guarantee than `exit_approximated`: that flag relies on the
   * close path knowing it approximated; this validates every close path.
   */
  private async validateClosedTradePrices(
    trade: StrategyTrade,
    accountId: number,
  ): Promise<void> {
    await validateClosedTradePricesImpl(this.reconcileDeps(), trade, accountId);
  }

  private async reconcileOneTrade(
    trade: StrategyTrade,
    accountId: number,
    openOrders: Order[],
    openOrderIds: Set<number>,
    positionsByContract: Map<string, ReconcilePosition>,
    /** Layer 1 pre-resolved exit values — when supplied, the close-branch
     *  skips `resolveExitFromFills` and stamps `exit_resolution_source =
     *  'buffer'`. Caller (handleUserPositionClose) drains the buffer
     *  inside its own try/finally; this method just consumes the result. */
    preResolvedExit: PreResolvedExit | null = null,
  ): Promise<void> {
    return reconcileOneTradeImpl(
      this.reconcileDeps(),
      trade,
      accountId,
      openOrders,
      openOrderIds,
      positionsByContract,
      preResolvedExit,
    );
  }

  /**
   * Final safety net: bracket retry failed (or pre-conditions made retry
   * impossible). Flatten the position via market order with a distinct
   * exit reason and fire a high-visibility Discord alert. The standard
   * notifyExit path still fires when the close is reconciled, providing
   * the final fill price + PnL.
   */
  private async forceCloseAfterBracketFailure(
    trade: StrategyTrade,
    deployment: Deployment,
    entryPrice: number,
    tpError: string,
    slError: string,
  ): Promise<void> {
    return forceCloseAfterBracketFailureImpl(this.exitDeps(), trade, deployment, entryPrice, tpError, slError);
  }

  private async notifyForceClose(
    trade: StrategyTrade,
    entryPrice: number,
    tpError: string,
    slError: string,
    submitted: boolean,
  ): Promise<void> {
    return notifyForceCloseImpl(this.notifyDeps(), trade, entryPrice, tpError, slError, submitted);
  }

  /**
   * Move the SL bracket to an arbitrary price. Used by the registry-level
   * breakeven / trail exit filters which compute target prices in their
   * own logic and just want the bracket-modify mechanics.
   *
   * SL-order resolution: prefer the persisted `slOrderId` captured at
   * fill-time. Fallback: heuristic filter on contract + opposing side +
   * type=4 + protective-side price. Fallback is unsafe when multiple
   * deployments share (account, contract); guard by refusing to modify
   * if more than one candidate matches.
   *
   * Tick-grid alignment is favorable-side: long stops round DOWN
   * (loosens slightly to match the tick grid), short stops round UP.
   * Avoids accidentally tightening the stop past where the strategy
   * asked for it.
   *
   * `marketPrice` is where the caller believes the market is, and it is
   * what the wrong-side refusal below is measured against. Pass null when
   * that is genuinely unknown — the refusal is then skipped rather than
   * guessed at, which is the direction that keeps today's behaviour.
   *
   * `storedStopPrice` is the mirror's `slCurrentPrice`. It is the tightening
   * reference only when the resting order carries no `stopPrice`; with
   * neither, the move is refused.
   *
   * Returns the aligned price actually sent to the broker. Throws when the
   * move cannot be made, which is what stops the caller stamping a ratchet
   * that never reached the wire: every flag flip at the call site sits
   * after the await, so only control flow can skip them.
   */
  private async modifyStopLossToPrice(
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    tradeId: number | null,
    targetPrice: number,
    marketPrice: number | null,
    storedStopPrice: number | null,
    label: string,
  ): Promise<number> {
    const exId = executionContractId(contract);
    const isLong = position.side === 0;
    const tickSize = contract.tickSize;
    // Fixed point, so an on-grid candidate is sent as itself: a float floor
    // turns a 0.1-tick 2649.2 into 2649.1000000000004, and the caller stores
    // what this returns, so the candidate would read as tighter every bar.
    const gridTicks = pnlTicksFromPrices(0, targetPrice, 1, tickSize);
    const alignedStop = tickSize > 0
      ? priceFromTicks(0, isLong ? Math.floor(gridTicks) : Math.ceil(gridTicks), tickSize)
      : targetPrice;

    // A protective stop rests on the far side of the market: below it for a
    // long, above it for a short. A break-even ratchet arms off the MFE of
    // the bars since entry, so the bar that armed it can be one whose *high*
    // reached the trigger and whose close is back through entry — at which
    // point the stop this asks for is at or past the market and the broker
    // rejects it as immediately triggerable ("Invalid stop price", observed
    // 2026-04-26 on a /MNQ short). Refuse it here instead: the position keeps
    // the stop it already has, which is its original protection, and the next
    // bar retries once price is back on the right side.
    //
    // This is the *side*, not any broker minimum-distance rule — a stop one
    // tick from the market passes here and may still be rejected, which is
    // the pre-existing `stop_move_failed` path and is left alone.
    //
    // The backtest refuses the same ratchet through the same predicate, so a
    // lock the engine would never send is never filled there either.
    if (isStopAtOrBeyondMarket(position.side, alignedStop, marketPrice)) {
      this.logEvent(
        "stop_move_wrong_side",
        deployment.id,
        `${label}: stop ${alignedStop} is on the wrong side of ${marketPrice} for a ${isLong ? "long" : "short"} — leaving the SL where it is`,
        { accountId: deployment.accountId, contractId: exId, tradeId },
      );
      throw new Error("Stop would sit on the wrong side of the market");
    }

    let slOrderId: number | null = null;

    if (tradeId != null) {
      const openTrade = getOpenTradeForDeployment(deployment.id);
      if (openTrade?.id === tradeId) slOrderId = openTrade.slOrderId;
    }

    let openOrders;
    try {
      openOrders = await this.brokerFor(deployment).searchOpenOrders(deployment.accountId);
    } catch (err) {
      this.maybeOrphanFromBrokerError(err, deployment.accountId);
      throw err;
    }
    let slOrder = slOrderId != null
      ? openOrders.find((o) => o.id === slOrderId)
      : undefined;

    if (!slOrder) {
      const protectiveSide: OrderSide = position.side === 0 ? 1 : 0;
      const candidates = openOrders.filter(
        (o) =>
          o.contractId === exId &&
          o.type === 4 &&
          o.side === protectiveSide &&
          o.stopPrice != null &&
          (isLong ? o.stopPrice < position.entryPrice : o.stopPrice > position.entryPrice),
      );
      if (candidates.length === 0) {
        this.log(
          deployment.id,
          "warn",
          "order",
          `${label}: no SL bracket found for ${exId} (side ${position.side})`,
          { accountId: deployment.accountId, contractId: exId },
        );
        throw new Error("SL bracket not found");
      }
      if (candidates.length > 1) {
        this.logEvent(
          "stop_move_ambiguous_sl",
          deployment.id,
          `${label}: ${candidates.length} SL candidates on ${exId} and no persisted slOrderId — refusing to guess`,
          { accountId: deployment.accountId, contractId: exId },
        );
        throw new Error("Ambiguous SL bracket");
      }
      slOrder = candidates[0];
    }

    // The caller picks against `slCurrentPrice`, which is null on a position
    // rebuilt from its row, and the trail's candidate follows the bar's
    // extreme rather than ratcheting on its own — so a pullback bar after a
    // rebuild offers a stop looser than the one the broker already holds. The
    // resting stop is the only reference that cannot be stale here.
    // Tradovate's `/order/list` likely carries no `stopPrice` (its docs put
    // it on the order version; unconfirmed), so the mirror is the fallback,
    // and with neither the move fails closed: sending it unchecked is the
    // loosening this guard exists to stop.
    const reference = slOrder.stopPrice ?? storedStopPrice;
    if (reference == null) {
      this.warnStopUnknown(
        deployment,
        tradeId,
        `${label}: SL order #${slOrder.id} carries no stop price and the engine holds none, so it cannot tell whether ${alignedStop} tightens it — leaving the SL where it is`,
        { accountId: deployment.accountId, contractId: exId, tradeId },
        Date.now(),
      );
      throw new Error("Stop move has no reference stop");
    }
    if (isLong ? alignedStop <= reference : alignedStop >= reference) {
      const fromBroker = slOrder.stopPrice != null;
      const source = fromBroker ? "resting stop" : "stop the engine last set";
      const sourceWords = fromBroker ? "the stop resting at the broker" : "the stop the engine last set";
      this.logEvent(
        "stop_move_not_tighter",
        deployment.id,
        `${label}: stop ${alignedStop} would not tighten the ${source} ${reference} on SL order #${slOrder.id} for a ${isLong ? "long" : "short"} — leaving the SL where it is`,
        {
          accountId: deployment.accountId,
          contractId: exId,
          tradeId,
          values: { reason: `${sourceWords} is already at or tighter than the new one would be` },
        },
      );
      throw new Error("Stop move would not tighten the resting stop");
    }

    let brokerPositions;
    try {
      brokerPositions = await this.brokerFor(deployment).searchOpenPositions(deployment.accountId);
    } catch (err) {
      this.maybeOrphanFromBrokerError(err, deployment.accountId);
      throw err;
    }
    const livePos = brokerPositions.find((p) => p.contractId === exId && p.size > 0);
    const updates: { stopPrice: number; size?: number } = { stopPrice: alignedStop };
    let sizeNote = "";
    if (livePos && livePos.size !== slOrder.size) {
      updates.size = livePos.size;
      sizeNote = `, size ${slOrder.size}→${livePos.size}`;
    }

    try {
      await this.brokerFor(deployment).modifyOrder(deployment.accountId, slOrder.id, updates);
      this.logEvent(
        "stop_moved",
        deployment.id,
        `${label}: SL order #${slOrder.id} moved ${slOrder.stopPrice} → ${alignedStop}${sizeNote}`,
        { accountId: deployment.accountId, contractId: exId, tradeId },
      );
      return alignedStop;
    } catch (err) {
      this.logEvent(
        "stop_move_failed",
        deployment.id,
        `${label}: modify SL #${slOrder.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: deployment.accountId, contractId: exId, tradeId },
      );
      this.maybeOrphanFromBrokerError(err, deployment.accountId);
      throw err;
    }
  }

  // ── Contract-lock helpers ─────────────────────────────────────────

  private static contractLockKey(accountId: number, contractId: string): string {
    return `${accountId}:${contractId}`;
  }

  /** Try to claim the lock for (accountId, contractId). Returns true if we
   *  hold it after the call (either just claimed, or already held by the
   *  same deployment — idempotent retry case). Returns false if another
   *  deployment holds it. */
  private acquireContractLock(
    accountId: number,
    contractId: string,
    deploymentId: string,
    tradeId: number | null,
  ): boolean {
    const key = TradingEngine.contractLockKey(accountId, contractId);
    const existing = this.contractLocks.get(key);
    if (existing) {
      // Same deployment retrying (e.g. pre-order snapshot succeeded but
      // placeOrder failed and we re-enter on the next bar) — refresh the
      // tradeId if we now have one, keep the lock.
      if (existing.deploymentId === deploymentId) {
        if (tradeId != null && existing.tradeId !== tradeId) {
          existing.tradeId = tradeId;
        }
        return true;
      }
      return false;
    }
    this.contractLocks.set(key, {
      deploymentId,
      tradeId,
      acquiredAt: new Date().toISOString(),
    });
    return true;
  }

  /** Release the lock for (accountId, contractId) iff it's held by the
   *  expected deployment. Prevents a late reconciler tick for a closed
   *  trade from stomping a lock that's already been re-acquired by a
   *  different deployment. */
  private releaseContractLock(
    accountId: number,
    contractId: string,
    deploymentId: string,
  ): void {
    const key = TradingEngine.contractLockKey(accountId, contractId);
    const existing = this.contractLocks.get(key);
    if (!existing) return;
    if (existing.deploymentId !== deploymentId) return;
    this.contractLocks.delete(key);
  }

  /** Human-readable label for logs when a deployment is blocked. */
  private getContractLockHolder(accountId: number, contractId: string): string | null {
    const key = TradingEngine.contractLockKey(accountId, contractId);
    return this.contractLocks.get(key)?.deploymentId ?? null;
  }

  /** Global gate for the entry path: any deployment holding an open or
   *  pending position on (account, contract) blocks every other deployment
   *  on that pair from entering. The contract lock map is the source of
   *  truth — populated on entry submit, cleared on terminal exit, and
   *  rebuilt from DB at boot. */
  private hasOpenPositionOnContract(accountId: number, contractId: string): boolean {
    const key = TradingEngine.contractLockKey(accountId, contractId);
    return this.contractLocks.has(key);
  }

  /** Any open or pending engine position on the account, from the same
   *  contract locks — the account-status check's flat test. */
  private hasOpenPositionOnAccount(accountId: number): boolean {
    const prefix = TradingEngine.contractLockKey(accountId, "");
    for (const key of this.contractLocks.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Seed `state.position` (and the related per-trade fields) from a DB-open
   *  trade row. Shared between engine boot (rebuildStatePositionsFromDb) and
   *  the bar-close rehydrate path in processDeployment so both call sites
   *  agree on which fields the in-memory state needs to mirror. No-op if the
   *  state already holds a position, or if the trade isn't actually filled.
   *  Caller logs the rehydrate (the message differs by site). */
  /** `processDeployment`'s two bar-close rehydrate sites, with their line. */
  private rehydrateFromOpenTrade(deployment: Deployment, deplState: DeploymentState, openTrade: StrategyTrade): boolean {
    if (!this.seedStatePositionFromOpenTrade(deplState, openTrade)) return false;
    this.log(
      deployment.id,
      "info",
      "trade",
      `Rehydrated position from DB trade #${openTrade.id} (${openTrade.side === 0 ? "LONG" : "SHORT"} @ ${openTrade.entryPrice})`,
      {
        accountId: deployment.accountId,
        contractId: openTrade.contractId,
        tradeId: openTrade.id,
      },
    );
    return true;
  }

  private seedStatePositionFromOpenTrade(deplState: DeploymentState, openTrade: StrategyTrade): boolean {
    if (deplState.position) return false;
    if (openTrade.status !== "open" || openTrade.entryPrice == null) return false;
    const position: OpenPosition = {
      side: openTrade.side,
      entryPrice: openTrade.entryPrice,
      entryTimestamp: openTrade.entryFilledAt ?? openTrade.entrySubmittedAt,
      barsSinceEntry: 0,
      entryFilledAt: openTrade.entryFilledAt,
      size: openTrade.size,
      slTicks: openTrade.desiredSlTicks,
    };
    deplState.position = position;
    const anchor = signalBarAnchor(openTrade.signalBarTs);
    if (anchor) {
      this.barCountAnchors.set(position, anchor);
      this.unreportedReloads.add(position);
    } else {
      // Every row inserted since the column landed carries it and open trades
      // are intraday, so this is a hand-edited or corrupt row. No bar is
      // guessed from the fill time: it is a reconciler wall clock that can sit
      // a bar late.
      this.log(
        openTrade.deploymentId,
        "warn",
        "trade",
        `Trade #${openTrade.id} has no signal bar on its row, so its bars since entry are counted from this restart. A time stop on it fires late.`,
        { accountId: openTrade.accountId, tradeId: openTrade.id },
      );
    }
    deplState.activeTradeId = openTrade.id;
    deplState.breakEvenMoved = openTrade.breakEvenMoved;
    deplState.activeTpTicks = openTrade.desiredTpTicks;
    deplState.activeSlTicks = openTrade.desiredSlTicks;
    // SL bracket price isn't persisted, so on restart the in-memory
    // mirror starts null and re-populates on the first reconciler tick.
    // The breakeven / trail labels survive restart anyway because
    // formatExitReason now reads sl_moved_to_be_flag / sl_trail_engaged
    // straight from the trade row — slCurrentPrice is only consulted
    // for the offset-based sanity check / legacy fallback.
    deplState.slMovedToBe = openTrade.breakEvenMoved;
    deplState.slCurrentPrice = null;
    deplState.tpCurrentPrice = null;
    return true;
  }

  /**
   * Derive `barsSinceEntry` on the newest bar from the last bar it is known
   * on (A95). Only a position with no anchor — a row with no signal bar —
   * falls back to adding one per evaluation.
   *
   * **An anchor older than the bars held is counted from the oldest one** and
   * said at `warn`. That count is short of the true one, so a time stop at or
   * under it fires on this bar and a longer one fires late rather than never.
   * Leaving it at 0 restarts the time stop instead. A `barIndex -
   * barsSinceEntry` read then lands on the oldest bar, so a native exit that
   * needs the entry bar itself cannot find it and holds — the line says so,
   * and the bracket still protects the position.
   */
  private advanceBarsSinceEntry(
    deployment: Deployment,
    deplState: DeploymentState,
    position: OpenPosition,
    bars: readonly BarData[],
  ): void {
    const anchor = this.barCountAnchors.get(position);
    if (!anchor) {
      position.barsSinceEntry++;
      return;
    }
    const step = stepBarCount(bars, anchor);
    if (step.kind === "ahead") return;
    this.barCountAnchors.set(position, step.anchor);
    position.barsSinceEntry = step.anchor.count;
    const reloaded = this.unreportedReloads.delete(position);
    const subject = { accountId: deployment.accountId, tradeId: deplState.activeTradeId };
    if (step.kind === "older") {
      const from = anchor.count === 0 ? "entered" : "was last counted";
      this.log(
        deployment.id,
        "warn",
        "trade",
        `Trade #${deplState.activeTradeId} ${from} before the oldest bar the engine holds (${bars[0].timestamp}), so its bars since entry are counted from that bar: ${step.anchor.count}, fewer than the true count. ` +
          "A time stop fires late rather than never; an exit that looks back at the entry bar will not fire. The bracket stop and target are unaffected.",
        subject,
      );
      return;
    }
    if (!reloaded) return;
    this.log(
      deployment.id,
      "info",
      "trade",
      `Trade #${deplState.activeTradeId} reloaded at ${step.anchor.count} bars since entry, counted from its signal bar`,
      subject,
    );
  }

  /** Boot-time companion to `rebuildContractLocksFromDb`. Walks every
   *  DB-open trade and seeds the matching deployment's in-memory state so
   *  the realtime exit path (session force-exit, BE, realtime strategy
   *  exits) is alive on the very first tick after restart — otherwise a
   *  position opened pre-restart sits invisible to evaluateRealtimeExits
   *  until the next bar-close cycle rebuilds it. */
  private rebuildStatePositionsFromDb(): void {
    const trades = getAllOpenTrades();
    let seeded = 0;
    for (const trade of trades) {
      const deplState = this.getState(trade.deploymentId);
      if (this.seedStatePositionFromOpenTrade(deplState, trade)) seeded++;
    }
    if (seeded > 0) {
      this.log(
        ENGINE_CTX,
        "info",
        "lifecycle",
        `Rebuilt state.position for ${seeded} open trade(s)`,
      );
    }
  }

  private restoreLastBarTimestamps(deployments: Deployment[]): void {
    for (const d of deployments) {
      const ts = getLastBarTimestamp(d.id);
      if (ts != null) {
        this.getState(d.id).lastBarTimestamp = ts;
      }
    }
  }

  /** Populate the lock map from DB-open trades. Called on engine start so a
   *  restart doesn't briefly release contracts before the reconciler runs —
   *  otherwise a second deployment's entry signal between `start()` and the
   *  first reconciler tick could slip through and stack a position. */
  private rebuildContractLocksFromDb(): void {
    this.contractLocks.clear();
    const trades = getReconcilableTrades();
    for (const trade of trades) {
      const key = TradingEngine.contractLockKey(trade.accountId, trade.contractId);
      // First-in wins if two rows somehow share a key (shouldn't happen —
      // the lock prevents it — but guard against legacy data from before
      // this feature landed).
      if (this.contractLocks.has(key)) continue;
      this.contractLocks.set(key, {
        deploymentId: trade.deploymentId,
        tradeId: trade.id,
        acquiredAt: trade.entrySubmittedAt,
      });
      // Layer 1 buffer slot for the recovered in-flight row so subsequent
      // fill events on this key land in a slot rather than being dropped.
      // The buffer itself does not persist — cold-start trades that close
      // before a new fill event arrives still fall through to Layer 2.
      //
      // Stamp `openedAt` with the trade's `entryFilledAt` (when known) so
      // the pre-drain assertion `slot.openedAt <= trade.entryFilledAt`
      // holds for trades that entered before this restart. Without this,
      // every post-restart Layer 1 drain trips the assertion and falls
      // through — defeating the buffer for the exact case it exists for.
      // `pending_entry` rows (entryFilledAt == null) keep `Date.now()`
      // because no fill timestamp exists to anchor against yet.
      const entryFilledAtMs = trade.entryFilledAt
        ? new Date(trade.entryFilledAt).getTime()
        : undefined;
      this.openBufferSlot(trade.accountId, trade.contractId, trade.id, entryFilledAtMs);
    }
    if (this.contractLocks.size > 0) {
      this.log(
        ENGINE_CTX,
        "info",
        "lifecycle",
        `Rebuilt ${this.contractLocks.size} contract lock(s) from open trades`,
      );
    }
  }

  /** Read-only access to per-deployment state so route handlers can call
   *  `legHasOpenPosition` without reaching into private fields. Returns
   *  the structural shape that helper consumes; `undefined` for unknown
   *  ids keeps DeploymentState's other fields encapsulated. */
  peekState(deploymentId: string): { position: import("../strategy-types").OpenPosition | null } | undefined {
    const s = this.state.get(deploymentId);
    if (!s) return undefined;
    return { position: s.position };
  }

  /** Deployment ids on `accountId` whose exit latch is currently set — an
   *  engine exit is between submission and its `finally`. Read-only, and
   *  deliberately so: `flatten-all` reports this alongside its fill counts
   *  so a doubled count has an explanation, but the panic button must never
   *  be refusable and does not consult it as a gate. */
  exitsInFlightForAccount(accountId: number): string[] {
    const out: string[] = [];
    for (const d of this.realtimeDeployments) {
      if (d.accountId !== accountId) continue;
      if (this.state.get(d.id)?.exitInFlight) out.push(d.id);
    }
    return out;
  }

  private forceFlatDeps(): ForceFlatDeps {
    return {
      logEvent: (e, d, m, s) => this.logEvent(e, d, m, s),
      // The DB row, not `realtimeDeployments`: a live-account or otherwise
      // withheld deployment still has to be closeable. See the module header.
      getDeployment: (id) => getDeployment(id),
      // `state.get`, not `getState` — this must not materialise an entry for
      // a deployment the engine does not manage, and it reaches those.
      stateFor: (id) => this.state.get(id),
      brokerForAccount: (a) => this.brokerForAccount(a),
      resolveContract: (t, a) => this.resolver.resolve(t, a),
      maybeOrphanFromBrokerError: (e, a) => this.maybeOrphanFromBrokerError(e, a),
      buildCustomTag,
      cancelTrackedBrackets: (deployment, contract, activeTradeId, protectiveSide) =>
        cancelTrackedBracketsImpl(this.exitDeps(), deployment, contract, activeTradeId, protectiveSide),
      verifyExitClean: (deployment, contract, exitOrderId, protectiveSide, activeTradeId, verdict) =>
        verifyExitCleanImpl(
          this.exitDeps(),
          deployment,
          contract,
          exitOrderId,
          protectiveSide,
          activeTradeId,
          "engine_exit",
          verdict,
        ),
      // The same instance the four sweeps hold. This is the fifth actor that
      // puts a market order against an (account, contract) without another
      // actor's unbooked order being visible to it any other way.
      flattenCooldown: this.flattenCooldown,
    };
  }

  /**
   * Close one deployment's position now, through the broker directly.
   *
   * The board's per-deployment flatten. Bypasses `placeExitOrder` and its
   * latch like `flatten-all` does, is never screened by the live-account
   * block, and leaves the deployment's status exactly as it found it —
   * `Active` stays `Active`. Never throws: every outcome is a result, so a
   * caller flattening N deployments keeps the other N−1.
   */
  forceFlatDeployment(deploymentId: string): Promise<ForceFlatResult> {
    return forceFlatDeploymentImpl(this.forceFlatDeps(), deploymentId);
  }

  /** D-11's activation preflight: what a deployment on this
   *  (account, ticker) would force-close under D-2, and when. Read-only —
   *  it places nothing and mutates nothing — and it answers through the same
   *  object that enforces the rule, so the prompt cannot drift from it. */
  previewManualPositionClaim(input: {
    accountId: number;
    ticker: TickerSymbol;
    strategyKey: string;
    paramValues: Deployment["paramValues"];
    live?: boolean;
  }): Promise<ManualPositionClaimPreview> {
    return this.manualPositionGuard.previewClaim(input);
  }

  /** Public snapshot for the dashboard — shows which deployment holds each
   *  (account, contract) pair so the UI can explain why a strategy isn't
   *  entering. */
  getContractLocks(): Array<{ accountId: number; contractId: string; deploymentId: string; tradeId: number | null; acquiredAt: string }> {
    const out: Array<{ accountId: number; contractId: string; deploymentId: string; tradeId: number | null; acquiredAt: string }> = [];
    for (const [key, value] of this.contractLocks) {
      const sepIdx = key.indexOf(":");
      if (sepIdx < 0) continue;
      const accountId = Number(key.slice(0, sepIdx));
      const contractId = key.slice(sepIdx + 1);
      out.push({ accountId, contractId, ...value });
    }
    return out;
  }

  // ── Discord notifications ─────────────────────────────────────────

  private notifyDeps(): NotifyDeps {
    return {
      accountNames: this.accountNames,
      log: (d, sev, cat, m, s) => this.log(d, sev, cat, m, s),
    };
  }

  private async notifyEntry(
    trade: {
      id: number;
      deploymentId: string;
      strategyKey: string;
      accountId: number;
      ticker: string;
      side: 0 | 1;
      size: number;
      tickSize: number | null;
      tickValue: number | null;
      desiredTpTicks: number | null;
      desiredSlTicks: number | null;
      desiredEntryPrice: number | null;
    },
    fillPrice: number,
    filledAt: string,
    filledSize?: number,
  ): Promise<void> {
    return notifyEntryImpl(this.notifyDeps(), trade, fillPrice, filledAt, filledSize ?? trade.size);
  }

  /**
   * Snapshot the bar window around a closed trade and persist it via
   * saveTradeBars. Window: max(300, computeWarmupBars(strategy)) bars
   * before entry + 300 bars after exit. The 300 floor matches the chart
   * route's BARS_BEFORE_ENTRY; the warmup ceiling lets a slowPeriod=200
   * strategy's indicators settle by the trigger bar so the replay
   * engine doesn't false-tag the trade as signal_drift.
   *
   * Best-effort: any failure here is logged at warn level but doesn't
   * block the close path. The chart route falls back to a live
   * /retrieveBars hit when no snapshot exists, so worst-case the
   * trade just gets a live-fetched chart until the contract ages out
   * of Topstep's ~3-month history horizon.
   */
  private async snapshotTradeBars(tradeId: number): Promise<SnapshotOutcome> {
    return snapshotTradeBarsImpl(
      tradeId,
      (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
      (contractId) => this.marketDataContractId(contractId),
    );
  }

  /** Re-snapshot any rows whose maturity time has passed. Called from the
   *  reconciler tick; the queue's rules are `runSnapshotQueue`'s. */
  private async processSnapshotQueue(): Promise<void> {
    return runSnapshotQueue({
      passive: () => this.marketHub.mode() === "passive",
      snapshot: (tradeId) => this.snapshotTradeBars(tradeId),
      log: (deploymentId, severity, category, message, subject) =>
        this.log(deploymentId, severity, category, message, subject),
    });
  }

  private async notifyExit(
    trade: {
      id: number;
      deploymentId: string;
      strategyKey: string;
      accountId: number;
      ticker: string;
      side: 0 | 1;
      size: number;
      entryPrice: number | null;
      entryFilledAt: string | null;
    },
    exitPrice: number,
    exitFilledAt: string,
    pnlTicks: number,
    pnlDollars: number,
    exitReason: ResolvedExitReason,
  ): Promise<void> {
    return notifyExitImpl(
      this.notifyDeps(),
      trade,
      exitPrice,
      exitFilledAt,
      pnlTicks,
      pnlDollars,
      exitReason,
    );
  }

  private resolveExitReason(
    bracketExitKind: "tp" | "sl" | "other",
    engineExitReason: string | null,
    slContext: {
      side: 0 | 1;
      entryPrice: number | null;
      slMovedToBe: boolean;
      slTrailEngaged: boolean;
      slCurrentPrice: number | null;
      tickSize: number;
      tradeId?: number;
      deploymentId?: string;
    } | null = null,
  ): ResolvedExitReason {
    return resolveExitReasonImpl(this.notifyDeps(), bracketExitKind, engineExitReason, slContext);
  }

  /**
   * Resolve exact exit from Topstep's /api/Trade/search feed. Scopes fills
   * by the exit-candidate order ids belonging to THIS trade (tp/sl/exit) —
   * a contract+side filter would cross-attribute fills when a second
   * deployment is closing a position on the same contract in the same
   * window. Returns the size-weighted exit price, summed per-fill PnL,
   * and the most recent fill timestamp. Returns null if we can't
   * confidently attribute any fill.
   */
  private async resolveExitFromFills(
    trade: StrategyTrade,
    accountId: number,
  ): Promise<{
    exitPrice: number;
    /** Net of fees — fee total subtracted in this method so the rest of
     * the close path doesn't need to know fees exist. */
    pnlDollars: number;
    feesDollars: number;
    filledAt: string;
    matchedOrderId: number | null;
  } | null> {
    return resolveExitFromFillsImpl(this.reconcileDeps(), trade, accountId);
  }

  /**
   * Best-effort exit fill price. Uses the latest bar close for the contract
   * since `searchOpenOrders` only exposes working orders and there's no
   * fills endpoint. Replace with SignalR GatewayUserOrder feed for exact
   * fills when we add the hub listener.
   */
  private async resolveExitFillPrice(trade: { contractId: string }): Promise<number | null> {
    return resolveExitFillPriceImpl(trade, (contractId) => this.marketDataContractId(contractId));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * The engine's **evaluation** bar read, and therefore the only honest place
   * to observe market-data health from: `fetchBarsImpl` is the one call that
   * reaches `marketDataRegistry.realtime()`, and a failure *of this read* is
   * the only thing that actually means "no bars" — it aborts
   * `processDeployment` at its first line. Hub state does not; passive mode
   * evaluates on exactly these reads.
   *
   * The exit-filter cross-timeframe read calls `fetchBarsImpl` directly and
   * is not observed here, because its failure is caught and tolerated at the
   * call site. See the comment there.
   *
   * An **empty** series is a successful read: the provider answered, it just
   * had nothing for the window. Counting it as a failure would report a
   * closed market as an outage.
   *
   * Records and rethrows. Callers rely on the throw to abort evaluation, and
   * swallowing it here would hand `processDeployment` an empty series that
   * looks like a quiet market.
   *
   * **One observation per read, not per leg.** N legs on one contract and
   * timeframe share one request through the fetch's TTL, and a leg handed
   * another's answer has observed nothing about the seam — recording it would
   * report N successes for one call, and N failures for one failure. The leg
   * that issued the request records for all of them, which is the same count
   * the seam actually produced.
   */
  private async fetchBars(
    contract: Contract,
    timeframe: Timeframe,
    depthBars?: number,
  ): Promise<BarData[]> {
    let reused = false;
    try {
      const bars = await fetchBarsImpl(contract, timeframe, depthBars, (info) => {
        reused = info.reused;
      });
      if (reused) return bars;
      const newest = bars.length > 0 ? new Date(bars[bars.length - 1].timestamp).getTime() : null;
      this.health.noteBarRead(
        { ok: true, newestBarOpenMs: Number.isFinite(newest) ? newest : null },
        Date.now(),
      );
      return bars;
    } catch (err) {
      if (reused) throw err;
      this.health.noteBarRead(
        {
          ok: false,
          newestBarOpenMs: null,
          error: err instanceof Error ? err.message : String(err),
        },
        Date.now(),
      );
      throw err;
    }
  }

  private getState(deploymentId: string): DeploymentState {
    let s = this.state.get(deploymentId);
    if (!s) {
      s = { lastBarTimestamp: null, cooldownAnchorAt: null, position: null, activeTradeId: null, breakEvenMoved: false, preEntryOrderIds: null, activeTpTicks: null, activeSlTicks: null, slMovedToBe: false, slCurrentPrice: null, tpCurrentPrice: null, exitInFlight: false, flatMismatchWarnedAt: null, exitDispatchWarnedAt: null, pendingEntrySessionKey: null, signalSuppressed: false };
      this.state.set(deploymentId, s);
    }
    return s;
  }

  /**
   * Engine-authoritative cap predicate. Returns true when a real entry has
   * already filled on `(deploymentId, sessionKey, side)`. Strategies that
   * enforce one-entry-per-side-per-session call this from `shouldEnter`
   * via `ctx.hasEnteredThisSession`.
   */
  hasEnteredThisSession(deploymentId: string, sessionKey: string, side: OrderSide): boolean {
    return this.sessionEntryLatch.get(deploymentId)?.get(sessionKey)?.has(side) ?? false;
  }

  /**
   * Latch a real-fill confirmation. Called from the entry-fill path, NOT
   * from signal acceptance — a rejected/cancelled order must not cap the
   * side. Bounded by SESSION_LATCH_MAX_KEYS via FIFO eviction.
   */
  private markEnteredThisSession(deploymentId: string, sessionKey: string, side: OrderSide): void {
    let perDeployment = this.sessionEntryLatch.get(deploymentId);
    if (!perDeployment) {
      perDeployment = new Map();
      this.sessionEntryLatch.set(deploymentId, perDeployment);
    }
    let sides = perDeployment.get(sessionKey);
    if (!sides) {
      sides = new Set();
      perDeployment.set(sessionKey, sides);
      // Evict the oldest key once we exceed the bound. Map iteration is
      // insertion-order, so the first key is the oldest one.
      while (perDeployment.size > SESSION_LATCH_MAX_KEYS) {
        const oldest = perDeployment.keys().next();
        if (oldest.done) break;
        perDeployment.delete(oldest.value);
      }
    }
    sides.add(side);
  }

  /**
   * Rebuild the latch from the trade rows for deployments this process has
   * not rebuilt yet (A92). Both doors onto the deployment set call it —
   * `start()` and `applySync` — so a leg resumed mid-session after a restart
   * is covered as well as one present at boot, and `processDeployment` calls
   * it again for a deployment still unrestored.
   *
   * A read failure leaves those deployments unmarked, and `processDeployment`
   * takes no new entry on them until a retry lands. It says so at `error`
   * once per outage, not on every tick that retries, and at `info` when the
   * read lands after a failure.
   */
  private restoreSessionEntryLatch(deployments: readonly Deployment[]): void {
    const ids = deployments.map((d) => d.id).filter((id) => !this.sessionLatchRestored.has(id));
    if (ids.length === 0) return;
    let entries: SessionLatchedEntry[];
    try {
      const since = new Date(Date.now() - SESSION_LATCH_RESTORE_LOOKBACK_MS).toISOString();
      entries = listSessionLatchedEntries(ids, since);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const id of ids.filter((id) => !this.sessionLatchRestoreFailed.has(id))) {
        this.sessionLatchRestoreFailed.add(id);
        this.log(
          id,
          "error",
          "lifecycle",
          `Could not read which sides were already traded this session: ${reason}. ` +
            "Until it is read, this playbook takes no new trades; open positions are still managed.",
        );
      }
      return;
    }
    for (const e of entries) this.markEnteredThisSession(e.deploymentId, e.sessionKey, e.side);
    for (const id of ids) this.sessionLatchRestored.add(id);
    for (const id of ids.filter((id) => this.sessionLatchRestoreFailed.delete(id))) {
      this.log(
        id,
        "info",
        "lifecycle",
        "Read which sides were already traded this session; this playbook takes new trades again.",
      );
    }
  }

  /**
   * The log seam. A thin delegate over `@/lib/logging/pipe` — it renders
   * nothing, scrubs nothing and persists nothing itself; the pipe does all
   * three and hands back the finished record for the ring.
   *
   * **Raw-at-rest ended here.** This site used to scrub stdout only and
   * pass the raw entry on, on the reasoning that the ring keeps full detail
   * for an auth-gated `/logs`. That was correct while the operator was the
   * only reader. It is not any more: `engine_logs` is the durable record —
   * the file that gets backed up, rsynced and exported — so the auth gate
   * is no longer the privacy boundary and the pipe is. The ring, the row
   * and the wire now all receive the same scrubbed message, and losing
   * raw-token archaeology in `/logs` is the accepted cost. Full-fidelity
   * identifiers live in the envelope's structural columns instead.
   *
   * **It takes `severity × category`, not a chip.** The seven-value enum
   * conflated the two — what the operator owes a line and what the line is
   * about — and splitting it is the defect the rework exists to fix. The
   * `level` column is still written, derived from the pair and the event.
   */
  private log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject: LogSubject = {},
  ): void {
    const record = emit({
      event: null,
      severity,
      category,
      deploymentId,
      message,
      display: this.displayFor(deploymentId),
      accountId: subject.accountId ?? null,
      contractId: subject.contractId ?? null,
      ticker: subject.ticker ?? null,
      tradeId: subject.tradeId ?? null,
      burstKey: subject.burstKey ?? null,
      values: subject.values ?? null,
    });
    if (record) this.deliverToLogHandler(record);
  }

  /**
   * The same seam for a line that names a vocabulary event.
   *
   * Severity and category come from the registry rather than the call site,
   * which is the whole point of an event — and it is what lets the ladder
   * decide escalation without a hand-placed alert at each site.
   *
   * **It goes through `this.onLog` for the same reason `log()` does.** A
   * bare `emit()` reaches the store but not the rings the `/logs` page
   * polls, so a line that skipped this method would be durable and
   * invisible until the next restart.
   *
   * **Prefer it over `log()` wherever the vocabulary has a name for what
   * happened.** `log()` is what remains for a line that is genuinely one of
   * a kind, and its `event` column stays null — which is a legible state
   * and not a gap to be filled with a name nobody will reuse.
   */
  private logEvent(
    event: string,
    deploymentId: string,
    message: string,
    subject: LogSubject = {},
  ): void {
    const record = emit({
      event,
      deploymentId,
      message,
      display: this.displayFor(deploymentId),
      accountId: subject.accountId ?? null,
      contractId: subject.contractId ?? null,
      ticker: subject.ticker ?? null,
      tradeId: subject.tradeId ?? null,
      burstKey: subject.burstKey ?? null,
      values: subject.values ?? null,
    });
    if (record) this.deliverToLogHandler(record);
  }

  /**
   * The envelope's `display` — `account-strategy.ticker` — for one
   * deployment, or null when there is no row to read it off.
   *
   * It is derived here rather than passed in by each call site for the same
   * reason the pipe scrubs rather than asking callers to: there is exactly
   * one right answer per deployment id, and a site that forgets it renders a
   * bare uuid on the operator's phone. Every flagged event's Discord title
   * is `template.replace("{display}", record.display ?? deploymentId)`, so
   * the fallback is a real uuid in a real alert, not a cosmetic default.
   *
   * **The full account number goes out and the pipe truncates it.** That
   * rule belongs to `scrub.ts` and lives in one place; see
   * [logging/README.md](../../../../docs/modules/logging/README.md).
   *
   * The engine sentinel is not a deployment and has no display; D-2's
   * account-wide arms reach here under it.
   *
   * **A failed read means no display, never no log line** — the same rule
   * the pipe's own account-catalog lookup obeys. This runs on the
   * error-and-safety paths, where the database being briefly unavailable is
   * a plausible neighbour of whatever is already wrong, and a throw here
   * would land in the caller's tick.
   *
   * **It is cached, because every log line reaches it.** It began as four
   * rare safety callers already paying broker round-trips; it now sits under
   * every line the engine emits, including the per-tick ones, and a
   * primary-key `get()` per line is a `prepare` the
   * tick loop does not need. The cache is keyed on the deployment id and
   * dropped wholesale by `applySync`, which is the one place a row's
   * account, strategy or ticker can change under a running engine.
   *
   * **A throw is not cached; a missing row is.** They are different answers:
   * *the database could not say* is transient and must be re-asked on the
   * next line, while *there is no such row* is a fact that only `applySync`
   * can change.
   */
  private displayFor(deploymentId: string): string | null {
    if (deploymentId === ENGINE_CTX) return null;
    const cached = this.displayCache.get(deploymentId);
    if (cached !== undefined) return cached;
    let display: string | null;
    try {
      const deployment = getDeployment(deploymentId);
      display = deployment
        ? `${deployment.accountId}-${deployment.strategyKey}.${deployment.ticker.replace(/^\//, "")}`
        : null;
    } catch {
      return null;
    }
    this.displayCache.set(deploymentId, display);
    return display;
  }
}
