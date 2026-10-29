// Reconciliation cluster extracted from engine.ts. These functions read
// broker fill history and repair the trade rows the live paths could not
// finish: timestamps the engine stamped null, PnL that landed on the
// bar-close approximation, exit labels stuck on the Bracket/Manual
// fallback, and prices that drifted from what the broker actually filled.
//
// Like engine-exit.ts and engine-notify.ts and unlike engine-watchdog.ts,
// this is a pure-function satellite: no engine state moved here. Every
// field the cluster reads or writes is still owned by the engine and
// reached through `ReconcileDeps`, so the engine keeps a one-line
// delegating method per function and no call site moved.

import { log } from "@/lib/logger";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { getDeployment } from "@/lib/db/deployments";
import {
  backfillEntryFilledAt,
  backfillExitFilledAt,
  closeTrade,
  getApproximatedClosedTrades,
  getBracketManualClosedTrades,
  getReconcilableTrades,
  getRecentlyClosedTrades,
  getTradeById,
  getTradesNeedingTimestampHeal,
  healApproximatedExit,
  listAccountsNeedingTimestampHeal,
  listAccountsWithBracketManualClosedTrades,
  listAccountsWithReconcilableTrades,
  listAllAccountsWithApproximatedTrades,
  markEntryFailed,
  markEntryFilled,
  setBracketOrderIds,
  setExitReason,
  setRestingBracketPrices,
} from "@/lib/db/trades";
import type { StrategyTrade } from "@/lib/db/trade-types";
import {
  EXIT_REASON_BRACKET_MANUAL,
  exitReasonActivity,
  type ResolvedExitReason,
} from "@/lib/logging/exit-reasons";
import type { BrokerCapabilities } from "@/lib/brokers/plugin";
import { getAccountBrokerOrNull, type BrokerKind } from "@/lib/db/account-brokers";
import type { RefreshResult } from "../../broker-access/broker-registry";
import { attributeAbsentAccount } from "./orphan-attribution";
import { recordOrders, recordPositions } from "./account-view";
import { signedSize, signedSizeForEntrySide } from "@/lib/brokers/types";
import type {
  Contract,
  Order,
  OrderSide,
  PlaceOrderRequest,
  Position,
  TradeFill,
} from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { Broker } from "../../broker-access/broker";
import { executionContractId } from "../../broker-access/contract-resolver";
import { sameContractMonth } from "../../broker-access/contract-pairing";
import type { BufferSlot, DeploymentState, LogSubject, PreResolvedExit } from "../engine";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import { entryFillValues, fmtSignedDollars } from "../engine-fill-format";
import { latchFilledEntry } from "../engine-entry-latch";
import { bracketRecoveryEligibility } from "../engine-exit";
import { attributePosition, describePositionAttribution } from "./engine-position-attribution";
import type { SnapshotOutcome } from "./engine-bar-fetch";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { feePerSideFor } from "../../orders/fees";
import {
  closePnl,
  pnlTicksFromDollars,
  pnlTicksFromPrices,
  priceFromTicks,
  roundToCents,
} from "../../orders/pnl-math";
import { BrokerOrderRole } from "../../orders/order-role";
import { trackOrderRequest } from "@/lib/shutdown-drain";

/** Per-trade attempt count after which `validateClosedTradePrices` drops its
 *  per-trade lines from the deployment log to debug. Rows that can never heal
 *  are retried on every sweep forever, and at info level they crowd real
 *  trade activity out of the heartbeat ring. */
const VALIDATION_LOG_VERBOSE_LIMIT = 3;

/** Hourly-sweep passes after which an approximated row is no longer sent to
 *  Trade/search by either approximated sweep, until restart: a day of passes.
 *  A fill Topstep has aged out (or never had) never arrives, and the row
 *  otherwise costs a Trade/search a pass for the 7 days
 *  `getApproximatedClosedTrades` keeps it (watchlist-3). Counted on the
 *  hourly sweep only, because the heal loop in `healTradeTimestamps` runs on
 *  whatever tick has a timestamp to heal, which would spend the cap on
 *  indexing lag. */
const APPROXIMATED_SWEEP_MAX_PASSES = 24;

/** What `validateClosedTradePrices` answers when its Trade/search read threw,
 *  so the hourly sweep does not count an outage toward the cap above. */
const TRADE_SEARCH_FAILED = "trade_search_failed";

/** How far past entry-submit the heuristic entry-fill match will look when
 *  the broker's fill list omits the opening fill under its own order id.
 *  Wide enough for a slow gateway ack, tight enough that the next
 *  round-trip on the same contract cannot land inside it. */
const ENTRY_FILL_MATCH_WINDOW_MS = 60_000;

/** Slack added to a recorded exit-fill timestamp before treating a later
 *  fill as belonging to a different trade. An iceberg exit fills in slices
 *  and the last slice can land after the timestamp we stamped. */
const EXIT_FILL_LATE_ARRIVAL_PAD_MS = 60_000;

/** Confidence margins for {@link classifyByPriceDistance}. The winning leg
 *  must sit within this many ticks of the exit AND be at least
 *  BRACKET_DISTANCE_MIN_RATIO times closer than the other one; anything
 *  looser starts labelling a legitimate Stop Loss as a Take Profit. Both
 *  callers of the heuristic share these — they used to be two local pairs
 *  with a comment claiming they matched. */
const BRACKET_DISTANCE_MAX_TICKS = 5;
const BRACKET_DISTANCE_MIN_RATIO = 3;

/** {@link handleEntryClosedNoPosition}'s answer when the row is no longer
 *  `pending_entry` by the time its fill read lands: another path owns it. */
export const ENTRY_ROW_SUPERSEDED = Symbol("entry-row-superseded");

/** {@link handleEntryClosedNoPosition}'s answer when no fill was seen but the
 *  silence is not evidence: Trade/search threw, or the entry is younger than
 *  `EXIT_FILL_LATE_ARRIVAL_PAD_MS` and Trade/search may not have indexed its
 *  fill. The caller writes nothing and the next tick asks again. */
export const ENTRY_FILL_DEFERRED = Symbol("entry-fill-deferred");

/** A `pending_entry` row this old is given up on: the stale-entry sweep
 *  cancels a working entry order, and a failing Trade/search stops deferring
 *  the closed-no-position verdict, so neither holds the contract lock forever.
 *  Real fills happen in seconds. */
const STALE_PENDING_ENTRY_MS = 10 * 60 * 1000;

/**
 * Whether the row was submitted, filled or written at or after `askedAt`, so a
 * read asked then cannot be evidence about it. `updated_at` is SQLite's
 * `datetime('now')` — UTC, no zone marker, whole seconds — so a write in the
 * read's own second counts as after it: keeping a mirror one more pass is the
 * safe side.
 */
function rowWrittenSince(row: StrategyTrade, askedAt: number): boolean {
  const askedSecond = Math.floor(askedAt / 1000) * 1000;
  const updatedAt = row.updatedAt ? Date.parse(`${row.updatedAt.replace(" ", "T")}Z`) : NaN;
  return (
    Date.parse(row.entrySubmittedAt) > askedAt ||
    (row.entryFilledAt != null && Date.parse(row.entryFilledAt) > askedAt) ||
    updatedAt >= askedSecond
  );
}

/** One account's live position read, stamped with its ask time. */
interface PositionRead {
  positions: Position[];
  askedAt: number;
}

/** A broker position as `reconcileOneTrade` looks it up by contract. It keeps
 *  the side (bugs.md A44) so a later reader can take `signedSize` of it; no
 *  reader here does yet. */
export type ReconcilePosition = Pick<Position, "size" | "type"> & { avgPrice: number };

/** The REST pass's by-contract map. `handleUserPositionClose` builds the same
 *  shape inline; the required `type` is what keeps the two in step. */
export function mapPositionsByContract(positions: readonly Position[]): Map<string, ReconcilePosition> {
  return new Map(
    positions.map((p) => [p.contractId, { size: p.size, avgPrice: p.averagePrice, type: p.type }]),
  );
}

/**
 * One live `searchOpenPositions` per account per reconcile pass, shared by
 * the reconciler fan-out and the ghost sweep (bugs.md A9; A115 measured the
 * second read as ~12/min of Topstep's budget). The engine makes one per
 * `runReconcileOnly` and drops it with the pass, so the answer is never
 * older than the pass that asked — it is not the account view, which nothing
 * that acts reads. The promise is memoised, so a caller joins a read still in
 * flight, and a failed read fails every sweep of that pass alike.
 */
export class PassPositionReads {
  private readonly reads = new Map<number, Promise<PositionRead>>();

  read(broker: Broker, accountId: number): Promise<PositionRead> {
    const inPass = this.reads.get(accountId);
    if (inPass) return inPass;
    const askedAt = Date.now();
    const read = broker.searchOpenPositions(accountId).then((positions) => ({ positions, askedAt }));
    this.reads.set(accountId, read);
    return read;
  }
}

/**
 * How often the ghost sweep's month line repeats for one cause. Same period
 * and the same last-key shape as `EXIT_FLAT_MISMATCH_WARN_MS`
 * ([engine-exit.ts](../engine-exit.ts)), for the same reason: the condition is
 * a standing one — a position held across a contract flip stands for days —
 * and the sweep re-enters on the reconciler's 15s clock, so an unthrottled
 * line is a `warn` per tick, which the logging hard rule forbids. The pipe's
 * burst collapser is not the answer here: its window is 30s, which still
 * leaves two rows a minute for as long as the position is held.
 */
const GHOST_MONTH_WARN_MS = 300_000;

/**
 * Single-slot last-key anchor for that line, keyed on its cause: the trade
 * row the divergence is about, or its absence. A new row re-announces
 * immediately, which is the property the exit-side anchor carries the trade
 * id for.
 *
 * Keyed by the `DeploymentState` object rather than by deployment id so its
 * lifetime *is* the state entry's — the same lifetime `flatMismatchWarnedAt`
 * gets from being a field on it, and the reason this satellite needs no
 * pruning pass and no thirty-third `ReconcileDeps` member. The cluster holds
 * no other module state; see [engine.md](../../../../../docs/modules/trading/engine.md).
 */
const ghostMonthWarnedAt = new WeakMap<DeploymentState, { cause: string; at: number }>();

function announceGhostMonth(deplState: DeploymentState, cause: string): boolean {
  const nowMs = Date.now();
  const anchor = ghostMonthWarnedAt.get(deplState);
  if (anchor !== undefined && anchor.cause === cause && nowMs - anchor.at < GHOST_MONTH_WARN_MS) {
    return false;
  }
  ghostMonthWarnedAt.set(deplState, { cause, at: nowMs });
  return true;
}

/**
 * Round-trip commission: the published per-side rate, both sides, whole
 * position. Deliberately not the per-fill `fees` the broker reports — the
 * buffer-drain path and the backtester both use the published rate, and the
 * soak metric compares their PnL against this one, so all three have to
 * source fees the same way or the disagreement is measuring fees.
 */
const roundTripFeesFor = (trade: Pick<StrategyTrade, "ticker" | "size">): number =>
  feePerSideFor(trade.ticker) * 2 * trade.size;

/**
 * Which bracket leg filled, given the order id every matched fill came from.
 * `null` means the fills spanned more than one order (or none resolved), and
 * an id matching neither leg means a non-bracket exit — both are "other",
 * which callers treat as "do not relabel".
 */
export const classifyBracketLeg = (
  matchedOrderId: number | null | undefined,
  trade: Pick<StrategyTrade, "tpOrderId" | "slOrderId">,
): "tp" | "sl" | "other" => {
  if (matchedOrderId == null) return "other";
  if (matchedOrderId === trade.tpOrderId) return "tp";
  if (matchedOrderId === trade.slOrderId) return "sl";
  return "other";
};

/**
 * Last-resort bracket attribution: whichever resting leg the exit price
 * landed nearest. Only for the case where the matched order id is unknown
 * and the OCO survivor is already gone from the book.
 *
 * Returns null — meaning "stay unattributed" — whenever the answer is not
 * high-confidence, including missing prices and a missing tick size.
 * Ambiguity has to fall through to the Bracket/Manual chip: a wrong TP/SL
 * label is worse than no label, because the trades table and the Discord
 * embed both present it as fact.
 *
 * Distances come back with the answer so the caller can log them without
 * recomputing.
 */
export const classifyByPriceDistance = (
  exitPrice: number,
  tpPrice: number | null,
  slPrice: number | null,
  tickSize: number,
): { kind: "tp" | "sl"; tpDistTicks: number; slDistTicks: number } | null => {
  if (!(tickSize > 0) || tpPrice == null || slPrice == null) return null;
  const tpDistTicks = Math.abs(exitPrice - tpPrice) / tickSize;
  const slDistTicks = Math.abs(exitPrice - slPrice) / tickSize;
  if (
    tpDistTicks <= BRACKET_DISTANCE_MAX_TICKS &&
    tpDistTicks * BRACKET_DISTANCE_MIN_RATIO <= slDistTicks
  ) {
    return { kind: "tp", tpDistTicks, slDistTicks };
  }
  if (
    slDistTicks <= BRACKET_DISTANCE_MAX_TICKS &&
    slDistTicks * BRACKET_DISTANCE_MIN_RATIO <= tpDistTicks
  ) {
    return { kind: "sl", tpDistTicks, slDistTicks };
  }
  return null;
};

/**
 * Engine-internal surface used by the reconciliation helpers. Mirrors the
 * {@link import("../engine-exit").ExitOrderDeps} pattern: the new module
 * calls private engine methods through bound callbacks rather than
 * flipping access modifiers.
 *
 * Each member is narrowed to the value the cluster consumes, not the
 * accessor it used to call — `capabilitiesFor` rather than `pluginFor`,
 * `stateFor` rather than the state map — so a satellite cannot reach
 * engine internals the cluster never touched.
 */
export interface ReconcileDeps {
  log: (
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ) => void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent: (event: string, deploymentId: string, message: string, subject?: LogSubject) => void;
  brokerForAccount: (accountId: number) => Broker;
  maybeOrphanFromBrokerError: (err: unknown, accountId: number) => void;
  /**
   * Record one broker REST outcome against that broker's order seam (D-8).
   *
   * Wired to the two per-account fan-outs below, which are this cluster's
   * broadest broker reads and therefore its most representative evidence.
   * Deliberately fail-open: a broker nothing has called reads `up`, because
   * "no failure observed" is the truthful answer and reporting every
   * unqueried broker as down would make the seam meaningless at boot.
   */
  noteBrokerOutcome: (accountId: number, ok: boolean, reason: string | null) => void;
  /** Per-deployment runtime state, looked up rather than handed over as a
   *  map. The cluster reads *and writes through* the returned object —
   *  including nulling `position` on a close it resolves, which makes this
   *  a second writer of the field the exit-latch rule guards, alongside
   *  `processDeployment` and the realtime close handler. A map would
   *  additionally carry `set`/`delete`/iteration it must not use. */
  stateFor: (deploymentId: string) => DeploymentState | undefined;
  /** Decides the exit-reason code and renders its label. `engineExitReason`
   *  is the row's `exit_reason_code` — the code the submitting actor wrote,
   *  never the rendered label. */
  resolveExitReason: (
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
    } | null,
  ) => ResolvedExitReason;
  brokerKindFor: (accountId: number) => BrokerKind;
  /** The capability record, not the plugin that owns it. The cluster reads
   *  two booleans off it; handing over the `BrokerPlugin` would also hand
   *  over its clients, realtime adapter and error classes. */
  capabilitiesFor: (kind: BrokerKind) => BrokerCapabilities;
  /** Engine-owned, mutated here: per-trade `validateClosedTradePrices`
   *  attempt counts, cleared on a successful heal. */
  validationAttempts: Map<number, number>;
  /** Engine-owned, mutated here: per-account epoch ms of the last hourly
   *  validation sweep. */
  lastHourlyValidationSweepAt: Map<number, number>;
  /** Engine-owned, mutated here: per-trade count of hourly-sweep passes over
   *  an approximated row, which caps both approximated sweeps
   *  (`APPROXIMATED_SWEEP_MAX_PASSES`). In-process only, so a restart re-arms
   *  every row. */
  approximatedSweepPasses: Map<number, number>;
  /** Engine-owned, mutated here: trade ids whose entry embed already fired.
   *  Read, added to and deleted from — handed over rather than wrapped in
   *  three accessors. */
  entryNotifiedTradeIds: Set<number>;
  releaseContractLock: (accountId: number, contractId: string, deploymentId: string) => void;
  /** Confirmed-flat hook. Fires at each point this module has established
   *  that a deployment holds nothing, so a `Pausing` / `Destroying` row can
   *  settle without waiting for the closing guard's next interval. A no-op
   *  for every other status, which is nearly every call. This is the seam
   *  that owns position teardown — it is deliberately not the ghost sweep's
   *  attribution branch, which answers a different question. */
  settleIfFlat: (deploymentId: string) => void;
  markEnteredThisSession: (deploymentId: string, sessionKey: string, side: OrderSide) => void;
  isAccountRegistered: (accountId: number) => boolean;
  handleOrphanedAccount: (accountId: number, reason: string) => Promise<void>;
  realtimeSuppressesPolling: (accountId: number) => boolean;
  /** The fan-out's own report, and the reconciler does inspect it: the
   *  orphan cross-check below has to know which arms answered before it
   *  reads an absent account as a broker's claim that it is gone (A74). The
   *  name snapshot is still read separately, through the dep beside this. */
  refreshBrokerRegistry: () => Promise<RefreshResult>;
  /** The registry's name snapshot, not the registry. */
  accountNamesSnapshot: () => ReadonlyMap<number, string>;
  /** Engine-owned, written here from the registry snapshot. */
  accountNames: Map<number, string>;
  /** Two scalar cursors that rate-limit the account-name refresh. Read
   *  through a call rather than a value because the engine field is
   *  mutable and the read happens after an await. */
  accountNamesRefreshedAt: () => number;
  setAccountNamesRefreshedAt: (at: number) => void;
  brokerRegistryLastAttemptAt: () => number;
  setBrokerRegistryLastAttemptAt: (at: number) => void;
  resolveContract: (ticker: TickerSymbol, accountId: number) => Promise<Contract>;
  resolveExitFillPrice: (trade: { contractId: string }) => Promise<number | null>;
  snapshotTradeBars: (tradeId: number) => Promise<SnapshotOutcome>;
  /** A close was booked: the account-status job schedules a balance read.
   *  Synchronous and fire-and-forget; it decides nothing here. */
  noteTradeClosed: () => void;
  notifyEntry: (
    trade: StrategyTrade,
    entryPrice: number,
    filledAt: string,
    filledSize?: number,
  ) => Promise<void>;
  notifyExit: (
    trade: StrategyTrade,
    exitPrice: number,
    exitFilledAt: string,
    pnlTicks: number,
    pnlDollars: number,
    exitReason: ResolvedExitReason,
  ) => Promise<void>;
  forceCloseAfterBracketFailure: (
    trade: StrategyTrade,
    deployment: Deployment,
    entryPrice: number,
    tpError: string,
    slError: string,
  ) => Promise<void>;
  isClosingFill: (brokerKind: BrokerKind, fill: TradeFill, trade: StrategyTrade) => boolean;
  bufferSlotKey: (accountId: number, contractId: string, tradeId: number) => string;
  /** One slot looked up, not the whole fill buffer: the cluster reads a
   *  single slot and must not be able to clear or re-key the map. */
  bufferSlotFor: (slotKey: string) => BufferSlot | undefined;
  buildCustomTag: (prefix: "e" | "x" | "s", deploymentId: string) => string;
}

/**
 * Backfill entry_filled_at / exit_filled_at on trades where the engine
 * stamped null (Trade/search hadn't indexed the fill yet at detection
 * time). Reads the unhealed trades for the account, fetches one
 * Trade/search call covering the union of their windows, and writes
 * the real fill timestamps. Closed trades stay closed; open trades
 * stay open — this only touches the timestamp columns + updated_at.
 */
export async function healTradeTimestamps(deps: ReconcileDeps, accountId: number): Promise<void> {
  const trades = getTradesNeedingTimestampHeal(accountId);
  if (trades.length === 0) return;

  // Span the search window from the earliest unhealed entry-submit
  // through now. Trade/search returns up to 1000 fills per window; in
  // practice this batch is small (just trades from the last few ticks
  // whose timestamps haven't settled yet).
  let earliest = trades[0].entrySubmittedAt;
  for (const t of trades) {
    if (new Date(t.entrySubmittedAt) < new Date(earliest)) {
      earliest = t.entrySubmittedAt;
    }
  }
  let fills;
  try {
    fills = await deps.brokerForAccount(accountId).searchTrades(accountId, earliest, new Date().toISOString());
  } catch (err) {
    deps.log(
      ENGINE_SCOPE,
      "warn",
      "broker",
      `Timestamp heal: Trade/search failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      { accountId },
    );
    deps.maybeOrphanFromBrokerError(err, accountId);
    return;
  }
  // Index fills by orderId for O(1) lookup per trade. A single fill is
  // tied to exactly one orderId, so this index is unique within the
  // returned set as long as we stay scoped to non-voided rows.
  const fillsByOrderId = new Map<number, typeof fills>();
  for (const f of fills) {
    if (f.voided) continue;
    const list = fillsByOrderId.get(f.orderId);
    if (list) list.push(f);
    else fillsByOrderId.set(f.orderId, [f]);
  }

  for (const t of trades) {
    // Entry timestamp heal — first fill on the entry order id wins.
    if (t.entryFilledAt == null && t.entryOrderId != null) {
      const entryFills = fillsByOrderId.get(t.entryOrderId);
      if (entryFills && entryFills.length > 0) {
        let firstTs = entryFills[0].creationTimestamp;
        for (const f of entryFills) {
          if (new Date(f.creationTimestamp) < new Date(firstTs)) {
            firstTs = f.creationTimestamp;
          }
        }
        backfillEntryFilledAt(t.id, firstTs);
        // Mirror the heal into in-memory state so the BE gate
        // (position.entryFilledAt != null) opens for trades whose
        // user-hub fast path missed and whose reconciler set
        // filledAt=null. Without this the DB is healed but the
        // engine keeps reading stale state until restart.
        const healState = deps.stateFor(t.deploymentId);
        if (healState?.position && healState.activeTradeId === t.id) {
          healState.position.entryFilledAt = firstTs;
        }
        deps.log(
          t.deploymentId,
          "info",
          "trade",
          `Trade #${t.id} entry timestamp healed to ${firstTs}`,
          { accountId, contractId: t.contractId, tradeId: t.id },
        );
      }
    }
    // Exit timestamp heal — most recent fill on a known exit order
    // (TP/SL/explicit exit). Mirrors resolveExitFromFills' "latest"
    // selection so the timestamp matches what we'd have written had
    // Trade/search been indexed at close time.
    if (t.exitFilledAt == null && t.status === "closed") {
      const exitOrderIds: number[] = [];
      if (t.tpOrderId != null) exitOrderIds.push(t.tpOrderId);
      if (t.slOrderId != null) exitOrderIds.push(t.slOrderId);
      if (t.exitOrderId != null) exitOrderIds.push(t.exitOrderId);
      let latestTs: string | null = null;
      for (const oid of exitOrderIds) {
        const fs = fillsByOrderId.get(oid);
        if (!fs) continue;
        for (const f of fs) {
          if (latestTs == null || new Date(f.creationTimestamp) > new Date(latestTs)) {
            latestTs = f.creationTimestamp;
          }
        }
      }
      if (latestTs != null) {
        backfillExitFilledAt(t.id, latestTs);
        deps.log(
          t.deploymentId,
          "info",
          "trade",
          `Trade #${t.id} exit timestamp healed to ${latestTs}`,
          { accountId, contractId: t.contractId, tradeId: t.id },
        );
      }
    }
  }

  // Re-resolve PnL on closed trades that landed via the bar-close
  // approximation (Trade/search wasn't indexed at close-time). The fast
  // retry for a fresh close; the hourly sweep in `sweepApproximatedTrades`
  // is what reaches every approximated row.
  for (const t of getApproximatedClosedTrades(accountId)) {
    if (approximatedSweepCapped(deps, t, accountId)) continue;
    await healApproximatedRow(deps, t, accountId);
  }

  // Post-close price validation sweep. Catches drift on any close path
  // we didn't instrument directly + cases where the immediate-validation
  // call no-op'd because Trade/search hadn't indexed yet. Window is 10
  // minutes; older rows are out of scope per project policy.
  const VALIDATION_WINDOW_MS = 10 * 60 * 1000;
  const recentClosed = getRecentlyClosedTrades(accountId, VALIDATION_WINDOW_MS);
  for (const t of recentClosed) {
    try {
      await validateClosedTradePrices(deps, t, accountId);
    } catch (err) {
      deps.log(
        t.deploymentId,
        "warn",
        "trade",
        `Trade #${t.id} price validation failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId: t.contractId, tradeId: t.id },
      );
    }
  }
}

/** True when the row healed; a throw is logged and answers false. */
async function healApproximatedRow(deps: ReconcileDeps, t: StrategyTrade, accountId: number): Promise<boolean> {
  try {
    return await healApproximatedExitFromFills(deps, t, accountId);
  } catch (err) {
    deps.log(
      t.deploymentId,
      "warn",
      "trade",
      `Trade #${t.id} approximated-exit heal failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId: t.contractId, tradeId: t.id },
    );
    return false;
  }
}

/**
 * Hourly sweep over the account's approximated closed rows: the heal, then
 * the price validation for a row the heal could not resolve. The
 * slow-path safety net for a row the every-tick paths missed (closed
 * during a long downtime, or on an account with nothing else to
 * reconcile). Bounded to the 7-day window `getApproximatedClosedTrades`
 * enforces and to `APPROXIMATED_SWEEP_MAX_PASSES` per row.
 *
 * Deliberately outside the pending-row gate, the realtime-feed gate and
 * the timestamp heal's early return: behind them it never reached an
 * account whose only work was approximated rows, nor one whose feed was
 * healthy, and those are exactly the rows nothing else revisits.
 */
async function sweepApproximatedTrades(deps: ReconcileDeps, accountId: number): Promise<void> {
  const HOURLY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const lastHourlyRun = deps.lastHourlyValidationSweepAt.get(accountId) ?? 0;
  if (Date.now() - lastHourlyRun < HOURLY_SWEEP_INTERVAL_MS) return;
  // Stamped before the query, not after the loop: a throw from it (a SQLite
  // error) would otherwise leave the cursor unstamped and retry, and warn,
  // on every 15s tick. Per-row throws are caught below and cannot skip it.
  deps.lastHourlyValidationSweepAt.set(accountId, Date.now());
  for (const t of getApproximatedClosedTrades(accountId)) {
    if (approximatedSweepCapped(deps, t, accountId)) continue;
    // A row the timestamp heal's loop already asked about on this pass is
    // asked again: one redundant read an hour, accepted over threading the
    // tried ids out of `healTradeTimestamps`.
    if (await healApproximatedRow(deps, t, accountId)) continue;
    try {
      const read = await validateClosedTradePrices(deps, t, accountId);
      // A row that heals leaves the query, so every pass counted is a miss;
      // a Trade/search outage is not one and must not spend the cap.
      if (read !== TRADE_SEARCH_FAILED) {
        deps.approximatedSweepPasses.set(t.id, (deps.approximatedSweepPasses.get(t.id) ?? 0) + 1);
      }
    } catch (err) {
      deps.log(
        t.deploymentId,
        "warn",
        "trade",
        `Hourly validation sweep failed for trade #${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId: t.contractId, tradeId: t.id },
      );
    }
  }
}

/** True once a row has had its `APPROXIMATED_SWEEP_MAX_PASSES`. The first
 *  skip says so at `warn` and moves the count past the cap, so it is said
 *  once per row per process. */
function approximatedSweepCapped(deps: ReconcileDeps, t: StrategyTrade, accountId: number): boolean {
  const passes = deps.approximatedSweepPasses.get(t.id) ?? 0;
  if (passes < APPROXIMATED_SWEEP_MAX_PASSES) return false;
  if (passes === APPROXIMATED_SWEEP_MAX_PASSES) {
    deps.approximatedSweepPasses.set(t.id, passes + 1);
    deps.log(
      t.deploymentId,
      "warn",
      "trade",
      `Trade #${t.id} exit is still approximated after ${passes} hourly checks — Trade/search no longer returns its fill. The engine stops checking it until it restarts.`,
      { accountId, contractId: t.contractId, tradeId: t.id },
    );
  }
  return true;
}

/**
 * Re-attempt bracket attribution on a closed trade that's stuck on the
 * "Bracket/Manual" fallback chip. Two tiers, both safe-by-default:
 *   1. resolveExitFromFills — once Trade/search has indexed, the matched
 *      orderId pins TP vs SL directly.
 *   2. price-distance heuristic — compare exitPrice to the row's
 *      desired_tp_price / desired_sl_price (engine-stamped at submit).
 *      Only labels when the closer leg is ≤5 ticks away AND ≥3× closer
 *      than the other; otherwise leaves the row alone. Same safety
 *      margins as the close-time Tier 3 heuristic.
 *
 * No Discord re-notify — the original exit embed already fired.
 * Idempotent: a successful relabel clears the BRK chip, so the next
 * sweep won't pick the row up again.
 */
export async function relabelBracketManualTrade(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<void> {
  if (trade.exitPrice == null) return;
  // exitOrderId is set but doesn't match either bracket leg — this is a
  // confirmed non-bracket exit (e.g. engine exit-at-market, flatten-all).
  // It will never resolve to TP/SL; skip the resolver to avoid retrying forever.
  if (
    trade.exitOrderId != null &&
    trade.exitOrderId !== trade.tpOrderId &&
    trade.exitOrderId !== trade.slOrderId
  ) return;

  // Tier 1: resolver match.
  const resolved = await resolveExitFromFills(deps, trade, accountId);
  let bracketKind = classifyBracketLeg(resolved?.matchedOrderId, trade);

  // Tier 2: price-distance against stored desired prices. Live-mirrored
  // tpCurrentPrice/slCurrentPrice are gone after close, so fall back to
  // the desired prices captured at order submit. SL was moved (BE/trail)
  // → original desired_sl_price is no longer the resting stop, can't
  // reliably attribute by price distance; fall through to "other".
  if (bracketKind === "other" && !trade.breakEvenMoved) {
    const byDistance = classifyByPriceDistance(
      trade.exitPrice,
      trade.desiredTpPrice,
      trade.desiredSlPrice,
      trade.tickSize ?? 0,
    );
    if (byDistance) bracketKind = byDistance.kind;
  }

  if (bracketKind === "other") return;

  // Flag-derived classification: read from the trade row so this works
  // even after engine restart (state map empty). Live SL price is passed
  // when available for the offset sanity-check fallback on legacy rows.
  const state = deps.stateFor(trade.deploymentId);
  const relabelled = deps.resolveExitReason(
    bracketKind,
    trade.exitReasonCode,
    {
      side: trade.side,
      entryPrice: trade.entryPrice,
      slMovedToBe: trade.slMovedToBreakeven,
      slTrailEngaged: trade.slTrailEngaged,
      slCurrentPrice: state?.slCurrentPrice ?? null,
      tickSize: trade.tickSize ?? 0,
      tradeId: trade.id,
      deploymentId: trade.deploymentId,
    },
  );
  if (relabelled.code === trade.exitReasonCode) return;

  const previousLabel = trade.exitReason;
  setExitReason(trade.id, relabelled);
  deps.logEvent(
    "exit_reason_relabelled",
    trade.deploymentId,
    `Trade #${trade.id} bracket relabel: "${previousLabel}" → "${relabelled.label}"`,
    { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
  );
  peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
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
export async function healApproximatedExitFromFills(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<boolean> {
  if (!trade.exitApproximated) return false;
  const resolved = await resolveExitFromFills(deps, trade, accountId);
  if (!resolved) return false;
  const tickSize = trade.tickSize ?? 0;
  const tickValue = trade.tickValue ?? 0;
  const grossPnl = roundToCents(resolved.pnlDollars + resolved.feesDollars);
  const canComputeTicks = tickSize > 0 && tickValue > 0 && trade.size > 0;
  const pnlTicks = canComputeTicks
    ? pnlTicksFromDollars(grossPnl, tickValue, trade.size)
    : 0;
  if (!canComputeTicks) {
    const bad = tickSize <= 0 ? "tick_size" : tickValue <= 0 ? "tick_value" : "size";
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} approximated heal: pnl_ticks=0 fallback (${bad} <= 0); column will not reflect resolved gross PnL`,
      { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
    );
  }
  const exitKind = classifyBracketLeg(resolved.matchedOrderId, trade);
  const before = trade.pnlDollars;
  healApproximatedExit({
    tradeId: trade.id,
    exitPrice: resolved.exitPrice,
    exitFilledAt: resolved.filledAt,
    pnlTicks,
    pnlDollars: resolved.pnlDollars,
    feesDollars: resolved.feesDollars,
    exitKind,
  });
  deps.logEvent(
    "pnl_healed",
    trade.deploymentId,
    `Trade #${trade.id} approximated PnL healed: ${before?.toFixed(2) ?? "—"} → ${resolved.pnlDollars.toFixed(2)} @ ${resolved.exitPrice}`,
    { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
  );
  // Re-classify the exit reason now that the bracket fill resolved. Only
  // upgrade to a TP/SL chip — never overwrite an existing reason when the
  // resolver couldn't pin a bracket leg, so the write is gated on a
  // resolved bracket kind and this stays strictly an upgrade path.
  //
  // The label-vs-code confusion this gate used to also guard against is
  // gone: `exit_reason_code` carries the submitted code and `exit_reason`
  // carries its rendering, so feeding the row's own value back in can no
  // longer downgrade a correct chip to the residual arm. The gate stays
  // because "the resolver could not pin a leg" is still not a reason to
  // rewrite anything.
  if (exitKind !== "other") {
    const slStateForHeal = deps.stateFor(trade.deploymentId);
    const healed = deps.resolveExitReason(
      exitKind,
      trade.exitReasonCode,
      {
        side: trade.side,
        entryPrice: trade.entryPrice,
        slMovedToBe: trade.slMovedToBreakeven,
        slTrailEngaged: trade.slTrailEngaged,
        slCurrentPrice: slStateForHeal?.slCurrentPrice ?? null,
        tickSize: trade.tickSize ?? 0,
        tradeId: trade.id,
        deploymentId: trade.deploymentId,
      },
    );
    if (healed.code !== trade.exitReasonCode) {
      try {
        setExitReason(trade.id, healed);
      } catch (err) {
        deps.log(
          trade.deploymentId,
          "warn",
          "trade",
          `Trade #${trade.id} exit_reason heal-write failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
        );
      }
    }
  }
  // Tell the browser to re-pull the row so the corrected PnL surfaces
  // immediately on Strategies / deployment-trades surfaces.
  peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
  return true;
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
export async function validateClosedTradePrices(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<typeof TRADE_SEARCH_FAILED | void> {
  // Anything bigger than half a tick is a real fill divergence, not
  // floating-point noise. PnL gets a flat cent tolerance because the
  // Topstep API reports profitAndLoss to 2 decimals.
  const PRICE_DRIFT_TOLERANCE_TICKS = 0.5;
  const PNL_DRIFT_TOLERANCE_DOLLARS = 0.01;

  if (trade.status !== "closed") return;
  if (trade.entryOrderId == null) return;
  // Already fully resolved by the heal path — no drift possible.
  if (!trade.exitApproximated && trade.exitResolutionSource === "rest") return;
  if (
    trade.tpOrderId == null &&
    trade.slOrderId == null &&
    trade.exitOrderId == null
  ) {
    // No exit order IDs to match fills against — validation can never
    // succeed. These are typically rows where bracket attribution failed
    // (e.g. degenerate sub-spread bracket the broker silently rejected)
    // or rows that closed via a path that didn't record the exit order.
    // Skip silently — they sit at exit_approximated=1 until manually fixed.
    return;
  }

  const attempts = (deps.validationAttempts.get(trade.id) ?? 0) + 1;
  deps.validationAttempts.set(trade.id, attempts);
  const verboseLog = attempts <= VALIDATION_LOG_VERBOSE_LIMIT;
  const logPerTrade = (msg: string): void => {
    if (verboseLog) {
      deps.log(trade.deploymentId, "info", "trade", msg, {
        accountId,
        contractId: trade.contractId,
        tradeId: trade.id,
      });
    } else {
      log.debug("eval", `[${trade.deploymentId}] ${msg}`);
    }
  };

  logPerTrade(
    `Validating trade #${trade.id}: entry=${trade.entryOrderId} tp=${trade.tpOrderId} sl=${trade.slOrderId} exit=${trade.exitOrderId}`,
  );

  let fills;
  try {
    fills = await deps.brokerForAccount(accountId).searchTrades(
      accountId,
      trade.entrySubmittedAt,
      new Date().toISOString(),
    );
  } catch (err) {
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} price validation: Trade/search failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return TRADE_SEARCH_FAILED;
  }

  logPerTrade(
    `Trade #${trade.id} searchTrades returned ${fills.length} fills`,
  );

  let entryFills = fills.filter(
    (f) => !f.voided && f.orderId === trade.entryOrderId,
  );

  // Fallback: Topstep's /Trade/search occasionally returns the closing
  // fills for the window without the opening fill matched by orderId
  // (cause unconfirmed — possibly indexing lag scoped to PnL=null fills).
  // Match the opening fill heuristically: same contract, same direction,
  // PnL null (opening), exact size, creation time inside a tight window
  // bounded by min(exitFilledAt, entrySubmittedAt+60s). If exactly one
  // matches, use it. If multiple match, refuse — better to skip the heal
  // than risk picking an unrelated fill from a later trade. Zero matches
  // falls through to the existing missing-fills retry path.
  if (entryFills.length === 0 && fills.length > 0) {
    const windowStart = new Date(trade.entrySubmittedAt).getTime();
    const exitTs = trade.exitFilledAt
      ? new Date(trade.exitFilledAt).getTime()
      : Number.POSITIVE_INFINITY;
    const windowEnd = Math.min(exitTs, windowStart + ENTRY_FILL_MATCH_WINDOW_MS);
    const candidates = fills.filter((f) => {
      if (f.voided) return false;
      if (f.profitAndLoss !== null) return false;
      if (f.contractId !== trade.contractId) return false;
      if (f.side !== trade.side) return false;
      if (f.size !== trade.size) return false;
      const ts = new Date(f.creationTimestamp).getTime();
      return ts >= windowStart && ts <= windowEnd;
    });
    if (candidates.length > 1) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Trade #${trade.id} entry heuristic ambiguous (${candidates.length} candidates within tight window) — refusing to match, skipping validation`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      return;
    }
    if (candidates.length === 1) {
      const picked = candidates[0];
      entryFills = [picked];
      deps.log(
        trade.deploymentId,
        "info",
        "trade",
        `Trade #${trade.id} entry fill matched via heuristic (orderId mismatch): orderId=${picked.orderId} price=${picked.price}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
    }
  }
  const exitOrderIds = new Set<number>();
  if (trade.tpOrderId != null) exitOrderIds.add(trade.tpOrderId);
  if (trade.slOrderId != null) exitOrderIds.add(trade.slOrderId);
  if (trade.exitOrderId != null) exitOrderIds.add(trade.exitOrderId);
  let exitFills = fills.filter(
    (f) => !f.voided && exitOrderIds.has(f.orderId),
  );

  // Manual close from Topstep UI — orderId not in our cached exit-order set,
  // but the fill is still ours (post-entry, same contract, opposing side).
  // Mirrors the resolveExitFromFills fallback. Without this the validator
  // bails as "missing fills" forever and the row stays approximated with
  // the wrong bar-close price.
  //
  // Gate on profitAndLoss !== null: TradeFill.profitAndLoss is null on
  // opening fills and non-null on closing fills. Without this gate, the
  // contract+side filter swept in the NEXT round-trip's entry fill on the
  // same contract whenever the closing side matched (e.g. yesterday's
  // BUY trade picking up today's SELL entry), corrupting healed exit
  // prices into weighted averages across two unrelated trades.
  //
  // Upper-bound on exitFilledAt where available (most exit fills land
  // within seconds; +60s pad covers iceberg fills). Defense-in-depth on
  // top of the pnl-null gate.
  if (exitFills.length === 0 && exitOrderIds.size > 0 && fills.length > 0) {
    const closingSide = trade.side === 0 ? 1 : 0;
    const entryFilledTs = trade.entryFilledAt
      ? new Date(trade.entryFilledAt).getTime()
      : entryFills.length > 0
        ? new Date(entryFills[0].creationTimestamp).getTime()
        : new Date(trade.entrySubmittedAt).getTime();
    const exitUpperBoundTs = trade.exitFilledAt
      ? new Date(trade.exitFilledAt).getTime() + EXIT_FILL_LATE_ARRIVAL_PAD_MS
      : null;
    exitFills = fills.filter((f) => {
      if (f.voided) return false;
      if (f.orderId === trade.entryOrderId) return false;
      if (f.profitAndLoss === null) return false;
      const ts = new Date(f.creationTimestamp).getTime();
      if (ts < entryFilledTs) return false;
      if (exitUpperBoundTs != null && ts > exitUpperBoundTs) return false;
      return f.contractId === trade.contractId && f.side === closingSide;
    });
    if (exitFills.length > 0) {
      logPerTrade(
        `Trade #${trade.id} exit fills matched via contract+side fallback (manual close — orderId=${exitFills[0].orderId} not in cached exit-order set)`,
      );
    }
  }

  // Tradovate post-restart fallback: `/fill/list` only returns
  // current-session fills, so trades that closed before a restart
  // show 0 exit fills above. `/fill/deps?masterid=<orderId>` returns
  // historical fills by parent order id. Topstep's `/Trade/search`
  // is already historical so its `getFillsForOrder` is a no-op.
  if (exitFills.length === 0 && exitOrderIds.size > 0) {
    const broker = deps.brokerForAccount(accountId);
    const depFills: TradeFill[] = [];
    for (const orderId of exitOrderIds) {
      try {
        const fetched = await broker.getFillsForOrder(orderId, accountId);
        if (fetched.length > 0) {
          logPerTrade(
            `Trade #${trade.id} exit fills fetched via /fill/deps fallback (orderId=${orderId}, count=${fetched.length})`,
          );
          for (const f of fetched) depFills.push(f);
        }
      } catch (err) {
        deps.log(
          trade.deploymentId,
          "warn",
          "trade",
          `Trade #${trade.id} /fill/deps fallback failed for orderId=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId, contractId: trade.contractId, tradeId: trade.id },
        );
      }
    }
    if (depFills.length > 0) {
      exitFills = depFills.filter(
        (f) => !f.voided && exitOrderIds.has(f.orderId),
      );
    }
  }

  logPerTrade(
    `Trade #${trade.id} matched: ${entryFills.length} entry fills, ${exitFills.length} exit fills`,
  );

  // Trail-stop trades (and any exit placed post-deployment that cancels the
  // original bracket group) frequently come back from /Trade/search with the
  // exit fill but no entry fill — Topstep stops indexing the entry once the
  // bracket parent is cancelled. The stored entryPrice was captured live by
  // markEntryFilled() from the user-hub fill event (authoritative), so we
  // can still compute real PnL from stored entry + matched exit fill and
  // clear the approximated flag.
  // TODO: symmetric case (entry fills present, exit fills missing) may also
  // be worth healing from a stored exitPrice — not implemented yet.
  if (
    entryFills.length === 0 &&
    exitFills.length > 0 &&
    trade.entryPrice != null &&
    trade.entryPrice > 0
  ) {
    const storedEntryPrice = trade.entryPrice;
    let exitSize = 0;
    let exitWeighted = 0;
    let pnlGross = 0;
    let matchedOrderId: number | null = exitFills[0].orderId;
    for (const f of exitFills) {
      exitSize += f.size;
      exitWeighted += f.price * f.size;
      pnlGross += f.profitAndLoss ?? 0;
      if (matchedOrderId != null && f.orderId !== matchedOrderId) {
        matchedOrderId = null;
      }
    }
    if (exitSize === 0) {
      logPerTrade(
        `Trade #${trade.id} validation skipped: exit fills had zero total size`,
      );
      return;
    }
    const actualExitPrice = exitWeighted / exitSize;
    const feesDollars = roundTripFeesFor(trade);
    // /fill/deps fills never carry profitAndLoss (Tradovate fill entities
    // don't inline PnL). Fall back to price-math when all fills returned null.
    const anyPnlPresent = exitFills.some((f) => f.profitAndLoss != null);
    if (!anyPnlPresent) {
      const tickSize = trade.tickSize ?? 0;
      const tickValue = trade.tickValue ?? 0;
      if (tickSize > 0 && tickValue > 0 && storedEntryPrice > 0) {
        pnlGross = closePnl({
          entryPrice: storedEntryPrice,
          exitPrice: actualExitPrice,
          side: trade.side,
          tickSize,
          tickValue,
          size: exitSize,
          feesDollars: 0,
        }).grossDollars;
      }
    }
    const actualPnlDollars = roundToCents(pnlGross - feesDollars);
    const tickSize = trade.tickSize ?? 0;
    const tickValue = trade.tickValue ?? 0;
    const grossForTicks = roundToCents(actualPnlDollars + feesDollars);
    const pnlTicks =
      tickSize > 0 && tickValue > 0 && trade.size > 0
        ? pnlTicksFromDollars(grossForTicks, tickValue, trade.size)
        : (trade.pnlTicks ?? 0);
    const exitKind = classifyBracketLeg(matchedOrderId, trade);
    let latestExitTs = exitFills[0].creationTimestamp;
    for (const f of exitFills) {
      if (new Date(f.creationTimestamp) > new Date(latestExitTs)) {
        latestExitTs = f.creationTimestamp;
      }
    }
    healApproximatedExit({
      tradeId: trade.id,
      exitPrice: actualExitPrice,
      exitFilledAt: trade.exitFilledAt ?? latestExitTs,
      pnlTicks,
      pnlDollars: actualPnlDollars,
      feesDollars,
      exitKind,
    });
    deps.validationAttempts.delete(trade.id);
    deps.logEvent(
      "pnl_healed",
      trade.deploymentId,
      `Trade #${trade.id} healed via stored entry price (no entry fills indexed): entry=${storedEntryPrice.toFixed(2)} exit=${actualExitPrice.toFixed(2)} pnl=${actualPnlDollars.toFixed(2)}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
    return;
  }

  // Topstep hasn't indexed yet — the heal pass + periodic sweep retry.
  if (entryFills.length === 0 || exitFills.length === 0) {
    logPerTrade(
      `Trade #${trade.id} validation skipped: missing fills (Topstep indexing lag)`,
    );
    return;
  }

  let entrySize = 0;
  let entryWeighted = 0;
  for (const f of entryFills) {
    entrySize += f.size;
    entryWeighted += f.price * f.size;
  }
  if (entrySize === 0) return;
  const actualEntryPrice = entryWeighted / entrySize;

  let exitSize = 0;
  let exitWeighted = 0;
  let pnlGross = 0;
  let matchedOrderId: number | null = exitFills[0].orderId;
  for (const f of exitFills) {
    exitSize += f.size;
    exitWeighted += f.price * f.size;
    pnlGross += f.profitAndLoss ?? 0;
    if (matchedOrderId != null && f.orderId !== matchedOrderId) {
      matchedOrderId = null;
    }
  }
  if (exitSize === 0) return;
  const actualExitPrice = exitWeighted / exitSize;
  // pnlDollars on the row is net of fees — same convention applied here so
  // the comparison is apples-to-apples.
  const feesDollars = roundTripFeesFor(trade);
  // Quantised before the comparison below, not after: the stored value is
  // cent-exact, so an unrounded figure here can differ from an identical row
  // by a float tail and report drift the tolerance was sized to absorb.
  const actualPnlDollars = roundToCents(pnlGross - feesDollars);

  const tickSize = trade.tickSize ?? 0;
  const priceTol = tickSize > 0 ? tickSize * PRICE_DRIFT_TOLERANCE_TICKS : Infinity;

  const entryDrift =
    trade.entryPrice != null &&
    Math.abs(actualEntryPrice - trade.entryPrice) > priceTol;
  const exitDrift =
    trade.exitPrice != null &&
    Math.abs(actualExitPrice - trade.exitPrice) > priceTol;
  const pnlDrift =
    trade.pnlDollars != null &&
    Math.abs(actualPnlDollars - trade.pnlDollars) > PNL_DRIFT_TOLERANCE_DOLLARS;

  if (!entryDrift && !exitDrift && !pnlDrift) return;

  const tickValue = trade.tickValue ?? 0;
  const grossForTicks = roundToCents(actualPnlDollars + feesDollars);
  const pnlTicks =
    tickSize > 0 && tickValue > 0 && trade.size > 0
      ? pnlTicksFromDollars(grossForTicks, tickValue, trade.size)
      : (trade.pnlTicks ?? 0);

  const exitKind = classifyBracketLeg(matchedOrderId, trade);

  let latestExitTs = exitFills[0].creationTimestamp;
  for (const f of exitFills) {
    if (new Date(f.creationTimestamp) > new Date(latestExitTs)) {
      latestExitTs = f.creationTimestamp;
    }
  }

  healApproximatedExit({
    tradeId: trade.id,
    entryPrice: entryDrift ? actualEntryPrice : undefined,
    exitPrice: actualExitPrice,
    exitFilledAt: trade.exitFilledAt ?? latestExitTs,
    pnlTicks,
    pnlDollars: actualPnlDollars,
    feesDollars,
    exitKind,
  });
  deps.validationAttempts.delete(trade.id);

  const fmt = (v: number | null): string => (v == null ? "—" : v.toFixed(2));
  deps.logEvent(
    "pnl_drift",
    trade.deploymentId,
    `Trade #${trade.id} price/PnL drift detected — entry: ${fmt(trade.entryPrice)} → ${actualEntryPrice.toFixed(2)}, exit: ${fmt(trade.exitPrice)} → ${actualExitPrice.toFixed(2)}, pnl: ${fmt(trade.pnlDollars)} → ${actualPnlDollars.toFixed(2)}`,
    { accountId, contractId: trade.contractId, tradeId: trade.id },
  );
  peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
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
export async function resolveExitFromFills(
  deps: ReconcileDeps,
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
  // Without a confirmed entry fill timestamp we can't safely distinguish
  // this trade's exit from an earlier round-trip's bracket fill on the
  // same contract. Bail rather than guess.
  if (trade.entryFilledAt == null) return null;

  // Candidate exit order ids for THIS trade. If none are known yet
  // (snapshot lost on restart + no exit order submitted), fall back
  // to the legacy contract+side filter but cap the window tightly
  // at the entry fill timestamp.
  const exitOrderIds = new Set<number>();
  if (trade.tpOrderId != null) exitOrderIds.add(trade.tpOrderId);
  if (trade.slOrderId != null) exitOrderIds.add(trade.slOrderId);
  if (trade.exitOrderId != null) exitOrderIds.add(trade.exitOrderId);
  const brokerKind = deps.brokerKindFor(accountId);

  try {
    const fills = await deps.brokerForAccount(accountId).searchTrades(
      accountId,
      trade.entrySubmittedAt,
      new Date().toISOString(),
    );
    const closingSide = trade.side === 0 ? 1 : 0;
    let entryFilledTs = new Date(trade.entryFilledAt).getTime();

    // Heuristic entry-fill match (mirrors validateClosedTradePrices).
    // Topstep's /Trade/search occasionally omits the opening fill from
    // the orderId-scoped match — symptom is "0 entry fills" returned
    // from a window that clearly contains hundreds of fills. Without
    // an authoritative entry timestamp the post-entry filter below
    // would either drop legitimate exit fills (timestamp drift) or
    // include ones from a prior round-trip. Re-derive entryFilledTs
    // from a single same-contract / same-side / same-size / PnL=null
    // fill in a tight window. Refuse to guess if multiple match.
    const haveEntryFillByOrderId = fills.some(
      (f) => !f.voided && f.orderId === trade.entryOrderId,
    );
    if (!haveEntryFillByOrderId && fills.length > 0) {
      const windowStart = new Date(trade.entrySubmittedAt).getTime();
      const windowEnd = windowStart + ENTRY_FILL_MATCH_WINDOW_MS;
      const candidates = fills.filter((f) => {
        if (f.voided) return false;
        if (f.profitAndLoss !== null) return false;
        if (f.contractId !== trade.contractId) return false;
        if (f.side !== trade.side) return false;
        if (f.size !== trade.size) return false;
        const ts = new Date(f.creationTimestamp).getTime();
        return ts >= windowStart && ts <= windowEnd;
      });
      if (candidates.length === 1) {
        entryFilledTs = new Date(candidates[0].creationTimestamp).getTime();
      }
      // candidates.length > 1 or 0 → leave entryFilledTs as the persisted
      // value. The exitOrderIds-scoped filter below still works because
      // it doesn't depend on a precise entryFilledTs cutoff.
    }

    const baseSafeties = (f: TradeFill) => {
      if (f.voided) return false;
      if (f.orderId === trade.entryOrderId) return false;
      if (new Date(f.creationTimestamp).getTime() < entryFilledTs) return false;
      return true;
    };
    const contractSideMatch = (f: TradeFill) =>
      f.contractId === trade.contractId && f.side === closingSide;

    let matching = fills.filter((f) => {
      if (!baseSafeties(f)) return false;
      // Preferred: scope to known exit-order ids.
      if (exitOrderIds.size > 0) return exitOrderIds.has(f.orderId);
      // Fallback: contract + opposing side. Still scoped to post-entry
      // timestamps above; only unsafe if another deployment happens to
      // close on the same contract inside the same reconciler window.
      return contractSideMatch(f);
    });

    // Manual close — orderId not in our cached exit-order set, but the fill
    // is still ours (post-entry, same contract, opposing side). Without this
    // fallback, the orderId-scoped match returns 0 and the caller falls
    // through to bar-close approximation with a wildly wrong price + PnL.
    //
    // `fillCarriesPnl`: gate on profitAndLoss !== null. Realized PnL is
    // stamped on closing fills and left null on opening ones, so this
    // distinguishes closing fills without needing the orderId.
    //
    // Otherwise ALL fills have profitAndLoss === null (Tradovate: Gate B
    // probe), so that gate would return 0 results. We omit the pnl-null
    // guard and rely solely on the post-entry timestamp lower-bound
    // (baseSafeties) + contract+opposing-side (contractSideMatch) as
    // defense. The orderId-scoped primary match should have found the fill
    // if the fill list returned it; this fallback only fires when it didn't.
    const caps = deps.capabilitiesFor(brokerKind);
    if (matching.length === 0 && exitOrderIds.size > 0) {
      matching = fills.filter(
        (f) =>
          baseSafeties(f) &&
          (!caps.fillCarriesPnl || f.profitAndLoss !== null) &&
          contractSideMatch(f),
      );
    }

    // Post-restart fallback for a session-scoped fill list (Tradovate's
    // `/fill/list`): a trade that closed before a restart is invisible
    // to `searchTrades`, so both the orderId-scoped match and the
    // contract+side fallback above come back empty. `getFillsForOrder`
    // returns historical fills by parent order id, which is exactly the
    // recovery path we need.
    if (
      matching.length === 0 &&
      caps.historicalFillsRequireOrderLookup &&
      exitOrderIds.size > 0
    ) {
      const broker = deps.brokerForAccount(accountId);
      const depFills: TradeFill[] = [];
      for (const orderId of exitOrderIds) {
        try {
          const fetched = await broker.getFillsForOrder(orderId, accountId);
          if (fetched.length > 0) {
            deps.log(
              trade.deploymentId,
              "info",
              "trade",
              `Trade #${trade.id} exit fills fetched via /fill/deps fallback (orderId=${orderId}, count=${fetched.length})`,
              { accountId, contractId: trade.contractId, tradeId: trade.id },
            );
            for (const f of fetched) depFills.push(f);
          }
        } catch (err) {
          deps.log(
            trade.deploymentId,
            "warn",
            "trade",
            `Trade #${trade.id} /fill/deps fallback failed for orderId=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
            { accountId, contractId: trade.contractId, tradeId: trade.id },
          );
        }
      }
      if (depFills.length > 0) {
        matching = depFills.filter(
          (f) => !f.voided && exitOrderIds.has(f.orderId),
        );
      }
    }

    if (matching.length === 0) return null;

    let totalSize = 0;
    let weightedPrice = 0;
    let pnlGrossInline = 0;
    let anyNullPnl = false;
    let latest = matching[0].creationTimestamp;
    // Which single order was responsible for this exit? If every fill
    // came from the same order id, we can classify the exit (tp vs sl).
    // If fills span multiple orders, we can't attribute cleanly — leave
    // it null and the slippage columns won't populate.
    let matchedOrderId: number | null = matching[0].orderId;
    for (const f of matching) {
      totalSize += f.size;
      weightedPrice += f.price * f.size;
      if (f.profitAndLoss == null) {
        anyNullPnl = true;
      } else {
        pnlGrossInline += f.profitAndLoss;
      }
      if (new Date(f.creationTimestamp) > new Date(latest)) latest = f.creationTimestamp;
      if (matchedOrderId != null && f.orderId !== matchedOrderId) matchedOrderId = null;
    }
    if (totalSize === 0) return null;
    const feesDollars = roundTripFeesFor(trade);
    const exitPrice = weightedPrice / totalSize;

    let pnlGross: number;
    if (anyNullPnl) {
      // Tradovate: fill entities never carry pnl (Gate B probe). Derive gross
      // from price math — same formula as Layer 1 and the bar-close approximation.
      if (trade.entryPrice == null || trade.entryPrice <= 0) {
        deps.log(
          trade.deploymentId,
          "warn",
          "trade",
          `Trade #${trade.id} Layer 2 price-math PnL fallback skipped: entryPrice missing`,
          { accountId, contractId: trade.contractId, tradeId: trade.id },
        );
        return null;
      }
      const tickSize = trade.tickSize ?? 0;
      const tickValue = trade.tickValue ?? 0;
      if (tickSize <= 0 || tickValue <= 0) {
        deps.log(
          trade.deploymentId,
          "warn",
          "trade",
          `Trade #${trade.id} Layer 2 price-math PnL fallback skipped: tickSize/tickValue missing`,
          { accountId, contractId: trade.contractId, tradeId: trade.id },
        );
        return null;
      }
      pnlGross = closePnl({
        entryPrice: trade.entryPrice,
        exitPrice,
        side: trade.side,
        tickSize,
        tickValue,
        size: totalSize,
        feesDollars: 0,
      }).grossDollars;
    } else {
      pnlGross = roundToCents(pnlGrossInline);
    }

    return {
      exitPrice,
      pnlDollars: roundToCents(pnlGross - feesDollars),
      feesDollars,
      filledAt: latest,
      matchedOrderId,
    };
  } catch (err) {
    deps.log(
      ENGINE_SCOPE,
      "warn",
      "broker",
      `Trade/search failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      { accountId },
    );
    deps.maybeOrphanFromBrokerError(err, accountId);
    return null;
  }
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
 *     * tickValue/tickSize * totalSize`. Mirrors the Layer 3 bar-close
 *     approximation in `reconcileOneTrade` and
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
export function reconcileExitFromBuffer(
  deps: ReconcileDeps,
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
  const slotKey = deps.bufferSlotKey(trade.accountId, trade.contractId, trade.id);
  const slot = deps.bufferSlotFor(slotKey);
  if (!slot) {
    return null;
  }
  if (trade.entryFilledAt == null) {
    return null;
  }
  const entryFilledAtMs = new Date(trade.entryFilledAt).getTime();

  // Pre-drain assertion: slot must not be older than the entry it's
  // tracking. A violation implies a slot-reuse leak (engine.stop() race,
  // unrecovered exception during a prior drain). Drop the slot and
  // signal the caller to fall through to Layer 2.
  if (slot.openedAt > entryFilledAtMs) {
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} Layer 1 pre-drain assertion failed: slot opened after entry filled (slot.openedAt=${new Date(slot.openedAt).toISOString()} > entryFilledAt=${trade.entryFilledAt}) — dropping slot, falling through to Layer 2`,
      { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return null;
  }

  // Second pre-drain assertion: any fill predating entryFilledAt is
  // stale (slot reuse, transport replay, or the entry fill itself
  // landed in the buffer). The closing-fill predicate already filters
  // these out via its own timestamp lower-bound; the warn here just
  // surfaces the diagnostic so a leak is observable.
  const preEntryCount = slot.fills.filter(
    (f) => new Date(f.creationTimestamp).getTime() < entryFilledAtMs,
  ).length;
  if (preEntryCount > 0) {
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} Layer 1 buffer slot contains ${preEntryCount} pre-entry fill(s) — skipping at predicate eval (defense in depth)`,
      { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
    );
  }

  const closing = slot.fills.filter((f) => deps.isClosingFill(brokerKind, f, trade));
  if (closing.length === 0) return null;

  let totalSize = 0;
  let weightedPrice = 0;
  let pnlGrossInline = 0;
  let anyNullPnl = false;
  let latestTs = closing[0].creationTimestamp;
  let matchedOrderId: number | null = closing[0].orderId;
  for (const f of closing) {
    totalSize += f.size;
    weightedPrice += f.price * f.size;
    if (f.profitAndLoss == null) {
      anyNullPnl = true;
    } else {
      pnlGrossInline += f.profitAndLoss;
    }
    if (new Date(f.creationTimestamp) > new Date(latestTs)) latestTs = f.creationTimestamp;
    if (matchedOrderId != null && f.orderId !== matchedOrderId) matchedOrderId = null;
  }
  if (totalSize === 0) return null;

  const feesDollars = roundTripFeesFor(trade);
  const exitPrice = weightedPrice / totalSize;
  const tickSize = trade.tickSize ?? 0;
  const tickValue = trade.tickValue ?? 0;

  let pnlGross: number;
  if (anyNullPnl) {
    // Tradovate steady-state path: fill entities never carry pnl
    // (Gate B). Compute gross from price math the same way the Layer 3
    // bar-close approximation and validateClosedTradePrices's
    // delayed-pnl fallback do. If the trade row is missing entry price
    // or tick metadata, signal failure so the caller falls through to
    // Layer 2.
    if (trade.entryPrice == null || trade.entryPrice <= 0) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Trade #${trade.id} Layer 1 price-math PnL fallback skipped: entryPrice missing — falling through to Layer 2`,
        { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      return null;
    }
    if (tickSize <= 0 || tickValue <= 0) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Trade #${trade.id} Layer 1 price-math PnL fallback skipped: tickSize/tickValue missing — falling through to Layer 2`,
        { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      return null;
    }
    pnlGross = closePnl({
      entryPrice: trade.entryPrice,
      exitPrice,
      side: trade.side,
      tickSize,
      tickValue,
      size: totalSize,
      feesDollars: 0,
    }).grossDollars;
  } else {
    pnlGross = roundToCents(pnlGrossInline);
  }

  const pnlDollars = roundToCents(pnlGross - feesDollars);
  const pnlTicks = tickSize > 0 && tickValue > 0
    ? pnlTicksFromDollars(roundToCents(pnlDollars + feesDollars), tickValue, trade.size)
    : 0;

  return {
    exitPrice,
    pnlDollars,
    pnlTicks,
    feesDollars,
    exitFilledAt: latestTs,
    matchedOrderId,
  };
}

/**
 * For every pending_entry / pending_exit row, look up the authoritative
 * Topstep order + position state per account and update the DB. This is
 * the only place PnL gets written — we use Topstep's reported fill price
 * and current position size, not the prices we guessed at submit time.
 */
export async function reconcilePendingTrades(
  deps: ReconcileDeps,
  deployments: Deployment[],
  positionReads: PassPositionReads = new PassPositionReads(),
): Promise<void> {
  // Union the enabled-deployment accounts with any account that still has
  // an in-flight trade (pending_entry / open / pending_exit). The latter
  // covers the corner case where the only deployment on an account was
  // paused or deleted while a trade was still running — without this, the
  // exit fill never lands in our DB and the dashboard shows a stale row
  // forever even though Topstep already filled the bracket.
  const accountIds = new Set(deployments.map((d) => d.accountId));
  for (const acctId of listAccountsWithReconcilableTrades()) {
    accountIds.add(acctId);
  }
  // Self-heal: trades whose entry/exit timestamp got stamped with
  // wallclock-at-detection instead of the real Trade/search fill time.
  // Union those accounts in too — closed trades aren't in the
  // reconcilable set but still need their timestamps backfilled so
  // chart markers eventually align to the right bar.
  for (const acctId of listAccountsNeedingTimestampHeal()) {
    accountIds.add(acctId);
  }
  // Pull in accounts that have nothing in flight but still carry closed
  // trades stuck on the "Bracket/Manual" fallback label. Without this
  // union, an account whose only open trade closed onto a wrong chip
  // drops out of the reconciler loop entirely on the next tick and the
  // hourly relabel sweep never fires for it.
  for (const acctId of listAccountsWithBracketManualClosedTrades()) {
    accountIds.add(acctId);
  }
  // Pull in accounts that have approximated closed trades, for the hourly
  // approximated sweep in the loop below. That sweep runs for every
  // account here, outside the pending-row and realtime-feed gates, so an
  // account whose only work is approximated rows is still swept.
  for (const acctId of listAllAccountsWithApproximatedTrades()) {
    accountIds.add(acctId);
  }
  if (accountIds.size === 0) return;

  // Refresh account name cache + orphan check. 30min cadence balances:
  //   - Catching combine→XFA mid-session upgrades within reasonable time
  //     (worst-case 30min until next refresh; usually much sooner because
  //     placeOrder failures with errorCode 1 also trigger orphan handling)
  //   - Not hammering /api/Account/search every tick (15s × 240 ticks/h)
  // Best-effort; falls back to the raw id and skips orphan detection on
  // failure rather than auto-pausing on transient errors.
  const ACCOUNT_NAME_TTL_MS = 30 * 60 * 1000;
  const REGISTRY_RETRY_INTERVAL_MS = 60_000;
  const stale = Date.now() - deps.accountNamesRefreshedAt() > ACCOUNT_NAME_TTL_MS;
  const namesEmpty = deps.accountNames.size === 0;
  const retryAllowed = Date.now() - deps.brokerRegistryLastAttemptAt() > REGISTRY_RETRY_INTERVAL_MS;
  // `retryAllowed` gates the stale arm too, and that is not tidiness: only the
  // success path stamps `accountNamesRefreshedAt`, so a refresh that throws
  // leaves `stale` true and a `namesEmpty || stale` gate re-fires the fan-out —
  // and the catch's log line — on every 15s tick. The attempt cursor below is
  // stamped before the await, so it is the one bound both arms share.
  if ((namesEmpty || stale) && retryAllowed) {
    // Stamped BEFORE the await, and it must stay there. `refreshBrokerRegistry`
    // stamps both cursors itself — but only after both its awaits, with no
    // catch, so when the registry refresh throws, that stamp never runs and
    // this pre-stamp is the only thing rate-limiting the retry. Without it a
    // throwing refresh re-fires the full fan-out, Tradovate resync and
    // contract pre-warm every 15s tick.
    //
    // The three lines below it — the snapshot read, the write-back and the
    // TTL stamp — genuinely do duplicate `refreshBrokerRegistry`'s own work
    // and are the candidate for removal. This line is not.
    deps.setBrokerRegistryLastAttemptAt(Date.now());
    try {
      // The registry refresh fans `searchAccounts` across every
      // configured broker; read the resulting name snapshot off the
      // registry instead of re-running the fan-out here. One round-trip
      // per broker per refresh tick instead of two.
      const refresh = await deps.refreshBrokerRegistry();
      const snapshot = deps.accountNamesSnapshot();
      for (const [id, name] of snapshot) deps.accountNames.set(id, name);
      deps.setAccountNamesRefreshedAt(Date.now());
      // Orphan detection: any deployment account not currently
      // registered to *any* broker. handleOrphanedAccount is
      // idempotent so re-detecting a previously-orphaned account
      // is a no-op.
      //
      // An account is absent from the registry for two different reasons and
      // only one of them is a broker's answer: `refresh()` carries a failed
      // arm's entries forward, but the arm still contributed nothing new, and
      // on a registry that never warmed it contributed nothing at all. A74
      // orphan-paused a live combine off exactly that silence. Attributed per
      // account against the arm that owns it, so a Tradovate outage cannot
      // stop genuine Topstep detection. Fail-open is deliberate: orphan-pause
      // is not the live-account safety gate (`autoTradeVerdict` is, untouched
      // here), and a skipped cross-check costs at most one rejected order,
      // which orphans as `place_order_account_not_found` — a broker's answer.
      const checkIds = new Set<number>();
      for (const d of deployments) checkIds.add(d.accountId);
      for (const acctId of checkIds) {
        if (deps.isAccountRegistered(acctId)) continue;
        const verdict = attributeAbsentAccount(getAccountBrokerOrNull(acctId), refresh);
        if (verdict.decision === "skip") {
          deps.logEvent(
            "orphan_check_skipped",
            ENGINE_SCOPE,
            `Periodic orphan check skipped for account ${acctId} — ${verdict.reason}.`,
            { accountId: acctId },
          );
          continue;
        }
        await deps.handleOrphanedAccount(acctId, "periodic_account_check");
      }
    } catch (err) {
      // Fail-open: leave the cache as-is and pause nothing. Logged because a
      // silently dropped cross-check is A74's other face. At most once per
      // REGISTRY_RETRY_INTERVAL_MS, because the gate above takes
      // `retryAllowed` on both arms and the cursor is stamped before the
      // await — a throw never reaches the TTL stamp, so the stale arm alone
      // would put this line on every tick.
      deps.logEvent(
        "orphan_check_skipped",
        ENGINE_SCOPE,
        `Periodic orphan check skipped for every account — it failed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }

  for (const accountId of accountIds) {
    // Dead account ids (Combine→XFA, expired sim) linger in this set via
    // historical trade rows; skip rather than warn every reconcile tick.
    if (!deps.isAccountRegistered(accountId)) continue;

    const pending = getReconcilableTrades(accountId);

    // Polling-fallback gate: when this account's realtime feed
    // has pushed a frame within the health window, the WS path is
    // already reconciling pending trades through the shared
    // handleUserPositionEvent → reconcileOneTrade flow. Skip the
    // per-account REST fan-out for this tick — it would just duplicate
    // work the WS hooks already did. Falls back to polling
    // automatically the moment the feed goes silent past 30s. The
    // bracket-relabel sweep below stays in the loop regardless (it
    // hits a different DB query that the WS path doesn't drive).
    // Returns false for Topstep-broker accounts so the existing
    // Topstep behavior is byte-identical.
    const wsHealthy = deps.realtimeSuppressesPolling(accountId);

    if (pending.length > 0 && !wsHealthy) {
      await reconcileAccountPending(deps, accountId, pending, positionReads);
    }

    // After the timestamp heal inside the pending block, so a pass that runs
    // both reads the rows that heal left approximated. Not inside it: a
    // failed orders/positions fetch returns from that block and must not
    // skip this sweep or the relabel below.
    try {
      await sweepApproximatedTrades(deps, accountId);
    } catch (err) {
      deps.log(
        ENGINE_SCOPE,
        "warn",
        "broker",
        `Approximated sweep for account ${accountId} failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId },
      );
    }

    // Bracket/Manual relabel sweep — runs every reconciler tick (not
    // gated on `pending.length`) so accounts whose only open trade just
    // closed onto a wrong "Bracket/Manual" chip still get reattributed
    // once Trade/search indexes the bracket fill. Idempotent: a
    // successful relabel clears the BRK chip, so subsequent ticks skip
    // the row. getBracketManualClosedTrades returns nothing for a clean
    // account, so the cost is a single SQLite query in the common path.
    try {
      const stuckBrk = getBracketManualClosedTrades(accountId);
      for (const t of stuckBrk) {
        try {
          await relabelBracketManualTrade(deps, t, accountId);
        } catch (err) {
          deps.log(
            t.deploymentId,
            "warn",
            "trade",
            `Bracket relabel failed for trade #${t.id}: ${err instanceof Error ? err.message : String(err)}`,
            { accountId, contractId: t.contractId, tradeId: t.id },
          );
        }
      }
    } catch (err) {
      deps.log(
        ENGINE_SCOPE,
        "warn",
        "broker",
        `Bracket relabel sweep failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        { accountId },
      );
    }
  }
}

/**
 * One account's pending rows against a fresh orders/positions read, then the
 * timestamp heal. A failed read returns before the rows: there is nothing to
 * reconcile them against.
 */
async function reconcileAccountPending(
  deps: ReconcileDeps,
  accountId: number,
  pending: StrategyTrade[],
  positionReads: PassPositionReads,
): Promise<void> {
  let openOrders: Order[];
  let openOrderIds: Set<number>;
  let positionsByContract: Map<string, ReconcilePosition>;
  let openPositions: Position[];
  let positionsAskedAt: number;
  // Before the fetch: the view drops a read asked before a newer write.
  const askedAt = Date.now();
  try {
    const broker = deps.brokerForAccount(accountId);
    const [orders, positionRead] = await Promise.all([
      // Reconciler is the source-of-truth path — bypass cache so we
      // never reconcile against stale order state. Cheap: only one
      // reconciler tick is in flight at a time.
      broker.searchOpenOrders(accountId, { forceFresh: true }),
      positionReads.read(broker, accountId),
    ]);
    openOrders = orders;
    openPositions = positionRead.positions;
    positionsAskedAt = positionRead.askedAt;
    openOrderIds = new Set(orders.map((o) => o.id));
    positionsByContract = mapPositionsByContract(openPositions);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.noteBrokerOutcome(accountId, false, `orders/positions fetch: ${reason}`);
    deps.log(
      ENGINE_SCOPE,
      "warn",
      "broker",
      `Reconcile: failed to fetch account ${accountId}: ${reason}`,
      { accountId },
    );
    return;
  }
  // Outside the try on purpose: a throw from the recorder inside it would
  // be caught as a broker failure and reported as one, which is the
  // instrument lying about the thing it measures.
  deps.noteBrokerOutcome(accountId, true, null);
  recordPositions(accountId, openPositions, "sweep", positionsAskedAt);
  recordOrders(accountId, openOrders, "sweep", askedAt);

  for (const trade of pending) {
    try {
      await reconcileOneTrade(deps, trade, accountId, openOrders, openOrderIds, positionsByContract);
    } catch (err) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Reconcile trade #${trade.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
    }
  }

  // Heal pass: backfill null entry/exit timestamps via one Trade/search
  // per account — covers every unhealed trade in a single call.
  try {
    await healTradeTimestamps(deps, accountId);
  } catch (err) {
    deps.log(
      ENGINE_SCOPE,
      "warn",
      "broker",
      `Timestamp heal for account ${accountId} failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId },
    );
  }
}

/**
 * Engine-side divergence sweep. For every managed deployment whose
 * `deplState.position` is set, verify the broker still reports a matching
 * open position. If the broker is flat (or size 0), null the local
 * position state so quote-tick exit handlers stop racing past the
 * broker-flat guard before the next reconcileOneTrade pass closes the
 * trade row.
 *
 * Mismatched-but-present positions are logged only — auto-correcting them
 * risks rewriting state out from under a partial fill or a manual
 * broker-side adjustment. The mismatch is reported as D-6's attribution
 * (`attributePosition`), which is P2 of the position-lifecycle proposal
 * and is **read-only by design**: it names what it sees and nothing here
 * acts on it. Broker positions on contracts no deployment claims are
 * handled by the naked-position watchdog (see runNakedPositionWatchdog) —
 * don't duplicate here, and note that this sweep only visits deployments
 * whose `deplState.position` is already set, so D-6's wholly-manual row
 * (expected flat) is out of its reach by construction.
 *
 * Activetradeid is intentionally NOT cleared: the trade-row close path
 * in reconcileOneTrade owns DB-side reconciliation. This sweep only
 * heals the in-memory mirror that gates runtime decisions.
 *
 * **The contract it asks the broker about is the month the open trade row
 * names, never the month the resolver currently answers.** `OpenPosition`
 * carries no contract, the resolver follows the broker's front month, and
 * a flip therefore points this sweep at a month the deployment never
 * entered — where the broker is honestly flat and the mirror gets cleared
 * over a live position (bugs.md A71). A row naming a back month is
 * reported and never acted on: the position is a ghost only when the
 * broker holds nothing on the row's own contract.
 */
export async function reconcileGhostPositions(
  deps: ReconcileDeps,
  deployments: Deployment[],
  positionReads: PassPositionReads = new PassPositionReads(),
): Promise<void> {
  const ghostCandidates = deployments.filter((d) => {
    const s = deps.stateFor(d.id);
    return s?.position != null;
  });
  if (ghostCandidates.length === 0) return;

  const byAccount = new Map<number, Deployment[]>();
  for (const d of ghostCandidates) {
    const list = byAccount.get(d.accountId) ?? [];
    list.push(d);
    byAccount.set(d.accountId, list);
  }

  for (const [accountId, depls] of byAccount) {
    let positions: Position[];
    let askedAt: number;
    try {
      ({ positions, askedAt } = await positionReads.read(deps.brokerForAccount(accountId), accountId));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.noteBrokerOutcome(accountId, false, `position lookup: ${reason}`);
      deps.log(
        ENGINE_SCOPE,
        "warn",
        "broker",
        `Ghost-position sweep: lookup failed for account ${accountId}: ${reason}`,
        { accountId },
      );
      continue;
    }
    // Outside the try, for the same reason as the fan-out above.
    deps.noteBrokerOutcome(accountId, true, null);
    recordPositions(accountId, positions, "sweep", askedAt);

    for (const deployment of depls) {
      const deplState = deps.stateFor(deployment.id);
      const tracked = deplState?.position;
      if (!deplState || !tracked) continue;

      let resolvedContractId: string;
      try {
        resolvedContractId = executionContractId(
          await deps.resolveContract(deployment.ticker, deployment.accountId),
        );
      } catch (err) {
        deps.log(
          deployment.id,
          "warn",
          "safety",
          `Ghost-position sweep: contract resolve failed for ${deployment.ticker}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId },
        );
        continue;
      }

      // The position is on the month the *row* names, which is not the month
      // the resolver answers once the broker rotates its front contract — and
      // a broker honestly reporting nothing on the new front month is what
      // this sweep would otherwise read as a ghost and clear, leaving a live
      // position with every clock-driven guard gating on a null mirror
      // (bugs.md A71). `trades.contract_id` is the execution id the entry was
      // placed on, the same id space `searchOpenPositions` answers in.
      const openTrade =
        deplState.activeTradeId != null ? getTradeById(deplState.activeTradeId) : null;
      const contractId = openTrade?.contractId ?? resolvedContractId;

      // Both lines below are standing conditions on a 15s sweep, so each is
      // throttled on its own cause and re-announces on a new trade row —
      // `warn` is never per-tick (logging/README), and the pipe's 30s burst
      // window is not a throttle at this cadence.
      if (!openTrade) {
        if (announceGhostMonth(deplState, "no-row")) {
          deps.log(
            deployment.id,
            "warn",
            "safety",
            `Ghost-position sweep: no trade row for ${deployment.ticker}, so the resolved contract ${resolvedContractId} is the only month available — across a contract flip a position on the previous month would read as a ghost here.`,
            { accountId, contractId: resolvedContractId },
          );
        }
      }

      const brokerPos = positions.find((p) => p.contractId === contractId && p.size > 0);

      // Announced only once the broker has confirmed a position on the row's
      // month — before the read, the line would assert a live back-month
      // position that a genuine ghost then contradicts on the next line. The
      // identity check is load-bearing and not a shortcut past the helper:
      // `sameContractMonth` answers false for *cannot tell* as well as for
      // *different month* (contract-pairing.ts), so two byte-identical ids
      // neither reader can parse — a Tradovate numeric id before its symbol
      // cache warms — would otherwise be announced as a divergence that does
      // not exist. Two identical ids are one month, whatever month that is.
      if (
        brokerPos &&
        openTrade &&
        contractId !== resolvedContractId &&
        !sameContractMonth(contractId, resolvedContractId)
      ) {
        if (announceGhostMonth(deplState, `trade-${openTrade.id}`)) {
          deps.log(
            deployment.id,
            "warn",
            "safety",
            `Ghost-position sweep: trade #${openTrade.id} holds ${deployment.ticker} on ${contractId} while the resolver answers ${resolvedContractId}, and the broker confirms the position there. Nothing that resolves the front month is managing it.`,
            { accountId, contractId, tradeId: openTrade.id },
          );
        }
      }

      if (!brokerPos) {
        // The read is shared with the reconciler and asked at the start of
        // its pass; a position opened since (the row written after the ask)
        // is absent from it, not gone. The next pass reads again.
        if (openTrade && rowWrittenSince(openTrade, askedAt)) continue;
        const trackedSide = tracked.side === 0 ? "LONG" : "SHORT";
        deps.logEvent(
          "ghost_position_cleared",
          deployment.id,
          `Ghost position cleared: deployment thought it held ${trackedSide} on ${contractId} but broker reports flat. Likely cause: bracket fill not yet propagated to deplState (now reconciled).`,
          { accountId, contractId },
        );
        deplState.position = null;
        deplState.breakEvenMoved = false;
        deplState.activeTpTicks = null;
        deplState.activeSlTicks = null;
        deplState.slMovedToBe = false;
        deplState.slCurrentPrice = null;
        deplState.tpCurrentPrice = null;
        // preEntryOrderIds is a transient bracket-attribution snapshot,
        // not a trade-row mirror. If we clear `position` but leave the
        // snapshot set, a subsequent entry's pre-entry capture can collide
        // with the stale one and bracket-diff attribution gets unpredictable.
        // Trade-row reconciliation also clears this on close; both paths
        // need to.
        deplState.preEntryOrderIds = null;
        deplState.cooldownAnchorAt = new Date().toISOString();
        continue;
      }

      // D-6 attribution. The two operands are already here, and the side
      // and size mismatches this used to report separately are one
      // comparison once both are read as signed quantities — which is the
      // point: a magnitude-only check calls an engine long 1 against a
      // broker short 1 a match. `tracked.side` is an `OrderSide` and
      // `brokerPos.type` a `PositionType`; they collide at `1` with
      // opposite meanings, so each goes through its own accessor and
      // neither is cast.
      // `tracked.size` is a broker *mirror*, not the engine's intent
      // (strategy-types.ts:354), and `handleUserPositionEvent` resyncs it on
      // **magnitude only** while never touching `tracked.side`. After a
      // crossing it therefore carries the broker's magnitude with the
      // engine's stale side: engine long 1, operator sells 3, broker nets
      // short 2 → `tracked.size` becomes 2 and the expectation reads
      // "Long 2", which the engine never held, and `manualSigned`
      // degenerates to twice the actual.
      //
      // `kind` is sound from this operand — it only asks where `actual` sits
      // relative to zero and expected, and both survive the resync. The
      // *quantities* do not. So the log says which half to trust, and P4
      // fixes the numbers by taking the trade row's size instead.
      const attribution = attributePosition({
        expectedSigned: signedSizeForEntrySide(tracked.side, tracked.size),
        actualSigned: signedSize(brokerPos),
      });
      if (attribution.kind !== "aligned") {
        deps.logEvent(
          "ghost_position_attribution",
          deployment.id,
          `Ghost-position sweep: attribution on ${contractId} — ${describePositionAttribution(attribution)}. Expected size is a broker mirror, so read the classification, not the quantity. Read-only; not auto-correcting.`,
          { accountId, contractId },
        );
      }
    }
  }
}

export async function reconcileOneTrade(
  deps: ReconcileDeps,
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
  const pos = positionsByContract.get(trade.contractId);

  if (trade.status === "pending_entry") {
    // Stale-entry sweep: if the entry order is still open on Topstep but
    // hasn't filled in 10 minutes, the contract lock would otherwise stay
    // held forever (preventing every other deployment on this contract
    // from entering). Force-fail and release.
    const entryAgeMs = Date.now() - new Date(trade.entrySubmittedAt).getTime();
    if (
      entryAgeMs > STALE_PENDING_ENTRY_MS &&
      trade.entryOrderId != null &&
      openOrderIds.has(trade.entryOrderId) &&
      !pos
    ) {
      markEntryFailed(trade.id, EntryExitCode.ENTRY_STALE);
      deps.logEvent(
        "entry_stale_cancelled",
        trade.deploymentId,
        `Trade #${trade.id} entry order #${trade.entryOrderId} stuck open for ${Math.round(entryAgeMs / 60000)}min — marking failed and releasing lock`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      // Best-effort cancel so the order doesn't suddenly fill against a
      // future signal we no longer track.
      try {
        await deps.brokerForAccount(trade.accountId).cancelOrder(trade.entryOrderId, trade.accountId);
      } catch (err) {
        deps.log(
          trade.deploymentId,
          "warn",
          "order",
          `Cancel of stale entry #${trade.entryOrderId} failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId, contractId: trade.contractId, tradeId: trade.id },
        );
      }
      const state = deps.stateFor(trade.deploymentId);
      if (state && state.activeTradeId === trade.id) {
        state.activeTradeId = null;
        state.position = null;
        state.preEntryOrderIds = null;
        state.activeTpTicks = null;
        state.activeSlTicks = null;
        state.slMovedToBe = false;
        state.slCurrentPrice = null;
        state.tpCurrentPrice = null;
        // Failed entry — drop the stashed key so a future legit entry on
        // the same session can latch when (if) it actually fills.
        state.pendingEntrySessionKey = null;
      }
      deps.releaseContractLock(trade.accountId, trade.contractId, trade.deploymentId);
      deps.settleIfFlat(trade.deploymentId);
      return;
    }

    // Entry order is no longer open + a matching position exists ⇒ filled.
    if (trade.entryOrderId != null && !openOrderIds.has(trade.entryOrderId) && pos) {
      // Real fill ts from Trade/search; wallclock can lag by up to one
      // reconciler tick (15s) and push the chart marker onto the wrong
      // bar. Null on miss — heal pass backfills on a later tick.
      const filledAt = await lookupEntryFillTimestamp(deps, trade, accountId);
      // The row was read before the broker read and this await; the user hub
      // may have promoted and closed it meanwhile, and writing `open` over
      // that would resolve the close twice.
      const current = getTradeById(trade.id);
      if (current && current.status !== "pending_entry") return;
      markEntryFilled(trade.id, pos.avgPrice, filledAt);

      // Diff pre-entry snapshot against current open orders to find the
      // TP/SL bracket pair Topstep created for THIS entry. Without this
      // attribution, a second deployment on the same contract could match
      // the wrong SL when we move to breakeven. When attribution finds
      // nothing, the recovery path inside attributeBrackets retries with
      // separate placeOrder calls and force-closes if that also fails.
      // Reached only when the reconciler sees the fill first; a live user
      // hub usually promotes the row to `open` before this tick, and the
      // `open` branch below attributes it instead.
      await attributeBrackets(deps, trade, openOrders, accountId, pos.avgPrice, filledAt);

      // Correct the in-memory position's entry to the real fill price.
      // placeEntryOrder seeded entryPrice from latestBar.close, which can
      // drift from the actual fill and would make breakeven math wrong.
      const state = deps.stateFor(trade.deploymentId);
      if (state?.position && state.activeTradeId === trade.id) {
        state.position.entryPrice = pos.avgPrice;
        state.position.entryFilledAt = filledAt;
        state.position.size = pos.size;
      }
      latchFilledEntry(deps, trade);

      deps.logEvent(
        "entry_filled",
        trade.deploymentId,
        `Trade #${trade.id} entry filled @ ${pos.avgPrice}${filledAt == null ? " (timestamp pending Trade/search heal)" : ""}`,
        {
          accountId,
          contractId: trade.contractId,
          tradeId: trade.id,
          values: entryFillValues(trade, pos.avgPrice, pos.size),
        },
      );
      // Notification carries a best-effort timestamp — wallclock if the
      // real one isn't indexed yet. Discord embeds don't self-heal.
      // Guard against double-fire when the user-hub size>0 event already
      // posted the entry embed.
      if (!deps.entryNotifiedTradeIds.has(trade.id)) {
        deps.entryNotifiedTradeIds.add(trade.id);
        void deps.notifyEntry(trade, pos.avgPrice, filledAt ?? new Date().toISOString(), pos.size);
      }
      return;
    }
    if (trade.entryOrderId != null && !openOrderIds.has(trade.entryOrderId) && !pos) {
      // Order closed but no position — could be (a) rejected/cancelled
      // before fill, or (b) the entry filled AND the TP/SL bracket filled
      // between reconciler ticks. A fill on the entry order id means (b):
      // the promoted copy is re-dispatched so its close resolves this tick.
      const outcome = await handleEntryClosedNoPosition(deps, trade, accountId);
      if (outcome === ENTRY_ROW_SUPERSEDED || outcome === ENTRY_FILL_DEFERRED) return;
      if (outcome) {
        return reconcileOneTrade(
          deps,
          outcome,
          accountId,
          openOrders,
          openOrderIds,
          positionsByContract,
          preResolvedExit,
        );
      }
      markEntryFailed(trade.id, EntryExitCode.ENTRY_NOT_FILLED);
      deps.logEvent(
        "entry_not_filled",
        trade.deploymentId,
        `Trade #${trade.id} entry did not fill (order closed, no position)`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      const state = deps.stateFor(trade.deploymentId);
      if (state && state.activeTradeId === trade.id) {
        state.activeTradeId = null;
        state.position = null;
        state.preEntryOrderIds = null;
        state.activeTpTicks = null;
        state.activeSlTicks = null;
        state.pendingEntrySessionKey = null;
      }
      // Broker confirmed no position ever existed — release the lock
      // so another deployment on the same (account, contract) can enter.
      deps.releaseContractLock(trade.accountId, trade.contractId, trade.deploymentId);
      deps.settleIfFlat(trade.deploymentId);
    }
    return;
  }

  if (trade.status === "open" || trade.status === "pending_exit") {
    // The user hub's position frame promotes the row to `open` before the
    // first reconciler tick on a healthy account, so attribution keys on
    // "position held, no ids yet", not on `pending_entry` (A98). One-shot:
    // attributeBrackets consumes the snapshot on both exits, and a restart
    // leaves it null, which is a no-op. Never on `pending_exit` — recovery
    // must not hang fresh brackets on a position already being exited.
    if (trade.status === "open" && pos && trade.tpOrderId == null && trade.slOrderId == null) {
      await attributeBrackets(deps, trade, openOrders, accountId, pos.avgPrice);
    }

    // Mirror the resting SL price from the broker every tick the position
    // is still open. This is what feeds the close-time BE/Trail classifier
    // — the SL is gone from openOrders by the time we detect close, so we
    // need its last-known price stashed here. Authoritative regardless of
    // which code path moved the stop (registry-filter modify, manual
    // broker-side modify, etc.).
    if (pos && trade.slOrderId != null) {
      const slOrder = openOrders.find((o) => o.id === trade.slOrderId);
      if (slOrder?.stopPrice != null) {
        const state = deps.stateFor(trade.deploymentId);
        if (state) state.slCurrentPrice = slOrder.stopPrice;
      }
    }
    // Parallel TP mirror. Feeds the close-time price-distance heuristic
    // (Tier 3 in the bracket attribution below) — when matchedOrderId and
    // the OCO survivor check both miss because of Trade/search lag and a
    // fast broker-side cancel, the closer leg to the exit price wins.
    // TP is a limit order, hence limitPrice (SL is a stop, hence stopPrice).
    if (pos && trade.tpOrderId != null) {
      const tpOrder = openOrders.find((o) => o.id === trade.tpOrderId);
      if (tpOrder?.limitPrice != null) {
        const state = deps.stateFor(trade.deploymentId);
        if (state) state.tpCurrentPrice = tpOrder.limitPrice;
      }
    }

    // Position is flat ⇒ trade is closed. `open` means exogenous exit
    // (bracket hit, manual close); `pending_exit` means our own market
    // exit filled. Handle both the same way.
    if (!pos && trade.entryPrice != null) {
      // Layer 1 (buffer) pre-empts Layer 2 (REST) when supplied. Layer 2
      // only fires when the buffer drain returned null; Layer 3
      // (bar-close approximation) fires when both miss.
      const resolved = preResolvedExit
        ? {
            exitPrice: preResolvedExit.exitPrice,
            pnlDollars: preResolvedExit.pnlDollars,
            feesDollars: preResolvedExit.feesDollars,
            filledAt: preResolvedExit.exitFilledAt,
            matchedOrderId: preResolvedExit.matchedOrderId,
          }
        : await resolveExitFromFills(deps, trade, accountId);
      let exitPrice: number;
      let pnlDollars: number;
      let pnlTicks: number;
      let feesDollars: number | undefined;
      // Real fill ts when resolveExitFromFills/Layer-1 succeeded; null
      // when we fell back to the bar-close approximation. Heal pass
      // retries on later ticks.
      const exitFilledAt: string | null = resolved?.filledAt ?? null;
      const tickSize = trade.tickSize ?? 0;
      const tickValue = trade.tickValue ?? 0;
      // Tracks whether closeTrade is being called with real fill data
      // (false) or the bar-close approximation (true). The flag drives
      // the heal-pass re-resolution of stuck PnL rows.
      let exitApproximated = false;
      // Reconciliation source label for the new `exit_resolution_source`
      // column — 'buffer' (Layer 1), 'rest' (Layer 2), 'approximated'
      // (Layer 3). Lockstep with `exit_approximated`.
      let exitResolutionSource: "buffer" | "rest" | "approximated";

      if (resolved) {
        exitPrice = resolved.exitPrice;
        pnlDollars = resolved.pnlDollars;
        feesDollars = resolved.feesDollars;
        // pnlDollars is already net here. Reverse-derive ticks from gross
        // so the ticks number stays comparable to backtest output (which
        // doesn't model fees).
        const grossPnl = roundToCents(pnlDollars + feesDollars);
        pnlTicks = tickSize > 0 && tickValue > 0
          ? pnlTicksFromDollars(grossPnl, tickValue, trade.size)
          : 0;
        exitResolutionSource = preResolvedExit ? "buffer" : "rest";
      } else {
        // Fallback: approximate from the latest bar close. Apply the
        // published per-side fee so the row + Discord embed stay net,
        // matching the resolver path.
        let approx = await deps.resolveExitFillPrice(trade);
        if (approx == null) {
          // Bar fetch unavailable (e.g. Tradovate numeric contractId not
          // queryable via Topstep's bar API). Fall back to the last
          // broker-reported avgPrice on the rehydrated state.position,
          // then to entryPrice. Either gives the heal pass a row to
          // re-resolve later instead of leaving the trade stuck `open`
          // forever after a restart-during-position.
          const statePos = deps.stateFor(trade.deploymentId)?.position;
          approx = statePos?.entryPrice ?? trade.entryPrice ?? null;
          if (approx != null) {
            const brokerKind = deps.brokerKindFor(accountId);
            deps.log(
              trade.deploymentId,
              "warn",
              "trade",
              `Trade #${trade.id} Layer 3 bar-close unavailable (broker=${brokerKind} contractId=${trade.contractId}) — closing with entry-price approximation; heal pass will correct`,
              { accountId, contractId: trade.contractId, tradeId: trade.id },
            );
          }
        }
        if (approx == null) return;
        exitPrice = approx;
        feesDollars = roundTripFeesFor(trade);
        const approximated = closePnl({
          entryPrice: trade.entryPrice,
          exitPrice,
          side: trade.side,
          tickSize,
          tickValue,
          size: trade.size,
          feesDollars,
        });
        pnlTicks = approximated.pnlTicks;
        pnlDollars = approximated.netDollars;
        exitApproximated = true;
        exitResolutionSource = "approximated";
      }

      // Classify which bracket filled so the correct slippage columns
      // get populated. Preferred path: matchedOrderId from the resolved
      // fills. Fallback (Topstep fill-indexing lag — searchTrades returns
      // 0 fills, so resolved is null OR matchedOrderId can't be pinned):
      // infer from which bracket order is *still open* on the broker.
      // OCO brackets mean exactly one of {tpOrderId, slOrderId} fills and
      // the other is auto-cancelled — so the survivor in openOrderIds
      // tells us the opposite leg filled. Without this fallback, every
      // close that hits before fills index falls through to the
      // "Bracket/Manual" label, which is the bug report from 2026-04-28.
      let bracketExitKind = classifyBracketLeg(resolved?.matchedOrderId, trade);
      if (bracketExitKind === "other" && trade.tpOrderId != null && trade.slOrderId != null) {
        const tpStillOpen = openOrderIds.has(trade.tpOrderId);
        const slStillOpen = openOrderIds.has(trade.slOrderId);
        // Exactly one survivor → its sibling filled. Both gone or both
        // present is ambiguous (manual close, broker cancelled both,
        // race in the broker feed) — leave as "other".
        if (tpStillOpen && !slStillOpen) bracketExitKind = "sl";
        else if (slStillOpen && !tpStillOpen) bracketExitKind = "tp";
      }
      // Tier 3: price-distance heuristic. Tier 1 (matchedOrderId) needs
      // Trade/search to have indexed the bracket fill; Tier 2 (OCO
      // survivor) needs the loser to still be visible in openOrderIds.
      // Both fail on fast OCO closes where the broker cancels the
      // survivor before our next reconcile tick AND Trade/search hasn't
      // caught up. Compare exitPrice to last-known TP / SL prices —
      // whichever is closer wins, but only with a high-confidence margin
      // (≤5 ticks AND ≥3× closer than the other leg). Falls back to
      // "other" when ambiguous so we never mislabel a legitimate
      // Stop Loss as Take Profit.
      // SL was moved (BE/trail) — original desired_sl_price is no longer
      // the resting stop, can't reliably attribute by price distance.
      // Read from the row (not state) so the relabel sweep path on a
      // post-restart heal also honors this gate.
      if (bracketExitKind === "other" && !trade.breakEvenMoved) {
        const stateForHeuristic = deps.stateFor(trade.deploymentId);
        const byDistance = classifyByPriceDistance(
          exitPrice,
          stateForHeuristic?.tpCurrentPrice ?? null,
          stateForHeuristic?.slCurrentPrice ?? null,
          trade.tickSize ?? 0,
        );
        if (byDistance) {
          bracketExitKind = byDistance.kind;
          const { tpDistTicks, slDistTicks } = byDistance;
          deps.log(
            trade.deploymentId,
            "info",
            "trade",
            byDistance.kind === "tp"
              ? `Trade #${trade.id} bracket inferred via price-distance: TP (Δ=${tpDistTicks.toFixed(1)}t vs SL Δ=${slDistTicks.toFixed(1)}t)`
              : `Trade #${trade.id} bracket inferred via price-distance: SL (Δ=${slDistTicks.toFixed(1)}t vs TP Δ=${tpDistTicks.toFixed(1)}t)`,
            { accountId, contractId: trade.contractId, tradeId: trade.id },
          );
        }
      }
      closeTrade({
        tradeId: trade.id,
        exitPrice,
        exitFilledAt,
        pnlTicks,
        pnlDollars,
        feesDollars,
        exitKind: bracketExitKind,
        exitApproximated,
        exitResolutionSource,
      });
      // Every booked close passes here, whichever actor exited. Guarded so a
      // balance read can never fail the close it follows.
      try {
        deps.noteTradeClosed();
      } catch {
        // Nothing to do: the next scheduled check reads the balance anyway.
      }
      // Per docs/proposals/userhub-trade-subscription.md §Call sites
      // that change item 12 — tagged log line at every Layer
      // 1 / Layer 2 / Layer 3 write.
      const layerTag = exitResolutionSource === "buffer"
        ? "Layer 1"
        : exitResolutionSource === "rest"
          ? "Layer 2"
          : "Layer 3";
      deps.logEvent(
        "exit_reconciled",
        trade.deploymentId,
        `${layerTag} reconciled trade #${trade.id} (account=${accountId} contract=${trade.contractId}) exit_resolution_source=${exitResolutionSource}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      // Validate the just-written row against /Trade/search. Catches the
      // case where resolveExitFromFills returned partial/wrong fills.
      // Idempotent — no-op when prices/PnL match within tolerance.
      if (!exitApproximated) {
        const fresh = getTradeById(trade.id);
        if (fresh) {
          try {
            await validateClosedTradePrices(deps, fresh, accountId);
          } catch (err) {
            deps.log(
              trade.deploymentId,
              "warn",
              "trade",
              `Post-close price validation failed for trade #${trade.id}: ${err instanceof Error ? err.message : String(err)}`,
              { accountId, contractId: trade.contractId, tradeId: trade.id },
            );
          }
        }
      }
      // Snapshot the bar window so the per-trade chart still works
      // after Topstep ages the contract out of /retrieveBars (~3
      // months). Fire-and-forget — failures fall back to the live
      // chart fetch path, which is fine until the contract expires. A
      // snapshot that saved nothing never enters the re-snapshot queue
      // (only `saveTradeBars` sets the due time), so it is said once here.
      void deps
        .snapshotTradeBars(trade.id)
        .then((outcome) => {
          if (outcome.kind !== "retry" && outcome.kind !== "defer") return;
          deps.log(
            trade.deploymentId,
            "info",
            "system",
            `Bar snapshot at close saved nothing for trade #${trade.id} (${outcome.reason}); ` +
              "it is not queued for a re-snapshot, so its chart reads bars live",
            { accountId, contractId: trade.contractId, tradeId: trade.id },
          );
        })
        .catch(() => {});
      // Re-read the row so we pick up exit_reason_code if attachPendingExit
      // wrote one in this same tick path (engine-issued exits). For
      // bracket/manual closes the column stays null and the reason
      // resolves from bracketExitKind instead.
      const slStateForLabel = deps.stateFor(trade.deploymentId);
      // Re-read the row post-closeTrade so the flag columns reflect any
      // writes that landed in this same tick (markBreakEvenMoved etc.).
      const tradeForLabel = getTradeById(trade.id) ?? trade;
      const exitReason = deps.resolveExitReason(
        bracketExitKind,
        tradeForLabel.exitReasonCode,
        {
          side: trade.side,
          entryPrice: trade.entryPrice,
          slMovedToBe: tradeForLabel.slMovedToBreakeven,
          slTrailEngaged: tradeForLabel.slTrailEngaged,
          slCurrentPrice: slStateForLabel?.slCurrentPrice ?? null,
          tickSize: trade.tickSize ?? 0,
          tradeId: trade.id,
          deploymentId: trade.deploymentId,
        },
      );
      // Persist the code and its rendering so the trades-table chip and the
      // Discord embed match. Overwrites whatever attachPendingExit wrote
      // earlier — the post-close reason folds in bracket-fill attribution
      // it can't see.
      try {
        setExitReason(trade.id, exitReason);
      } catch (err) {
        deps.log(
          trade.deploymentId,
          "warn",
          "trade",
          `Failed to persist exit_reason for trade #${trade.id}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId, contractId: trade.contractId, tradeId: trade.id },
        );
      }
      // Heal-pass exit-reason reclassification. On engine restart the
      // tick path above can land on the residual `bracket_manual` because
      // state was empty (no slCurrentPrice mirror) and Trade/search hadn't
      // yet indexed the bracket fill (resolveExitFromFills null, OCO
      // survivor fallback can't fire from a stale openOrderIds).
      // Re-resolve now that fills should be indexed; if a bracket
      // order id pins, rewrite the persisted reason. Scoped to the
      // residual arm — engine-issued reasons (attachPendingExit) and
      // confident live-tick codes stay put.
      // Discord re-notify is intentionally skipped — original notifyExit
      // already fired with the wrong label and a second embed is noisy.
      //
      // INVARIANT: this gate is safe ONLY because resolveExitReason
      // short-circuits bracket TP/SL kinds before consulting the
      // engine-issued reason — a code of `bracket_manual` therefore
      // implies bracketExitKind === "other" AND engineExitReason was
      // null. If resolveExitReason's priority order ever changes so
      // engine-issued reasons take precedence over bracket kinds,
      // revisit this gate or it will start clobbering legitimate
      // strategy/session/force-close/manual reasons.
      const shouldHeal = exitReason.code === EXIT_REASON_BRACKET_MANUAL && !exitApproximated;
      // Single broadcast per close: emit immediately on the no-heal path,
      // otherwise defer to the heal block's finally so the UI sees the
      // post-heal label in one re-render instead of two.
      if (!shouldHeal) {
        // Tell every connected browser that this row finalized so its
        // useTrades cache invalidates immediately. Without this the per-row
        // PnL surfaces lag the hero's session realized by one poll cycle
        // (~5s) since the hero updates from Topstep's userTrade hub event
        // and our row only exists after closeTrade writes here.
        peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
      }
      if (shouldHeal) {
        try {
          const healCurrent = getTradeById(trade.id);
          if (healCurrent) {
            const reResolved = await resolveExitFromFills(deps, healCurrent, accountId);
            const healedKind = classifyBracketLeg(reResolved?.matchedOrderId, healCurrent);
            if (healedKind !== "other") {
              const healState = deps.stateFor(healCurrent.deploymentId);
              const healed = deps.resolveExitReason(
                healedKind,
                healCurrent.exitReasonCode,
                {
                  side: healCurrent.side,
                  entryPrice: healCurrent.entryPrice,
                  slMovedToBe: healCurrent.slMovedToBreakeven,
                  slTrailEngaged: healCurrent.slTrailEngaged,
                  slCurrentPrice: healState?.slCurrentPrice ?? null,
                  tickSize: healCurrent.tickSize ?? 0,
                  tradeId: healCurrent.id,
                  deploymentId: healCurrent.deploymentId,
                },
              );
              if (healed.code !== healCurrent.exitReasonCode) {
                setExitReason(healCurrent.id, healed);
              }
            }
          }
        } catch (err) {
          deps.log(
            trade.deploymentId,
            "warn",
            "trade",
            `Post-close exit_reason heal failed for trade #${trade.id}: ${err instanceof Error ? err.message : String(err)}`,
            { accountId, contractId: trade.contractId, tradeId: trade.id },
          );
        } finally {
          // Always fire — even if the heal threw before relabeling. The
          // row still has the BRK label persisted; the UI needs the close
          // event regardless so the trades cache invalidates.
          peekBroadcaster()?.emitStrategyTradeClosed(trade.accountId, trade.deploymentId);
        }
      }
      void deps.notifyExit(
        trade,
        exitPrice,
        exitFilledAt ?? new Date().toISOString(),
        pnlTicks,
        pnlDollars,
        exitReason,
      );
      // Free the entry-notified guard for this trade — it can't fire
      // again (status is now closed). Bounds memory growth on a 24/7 run.
      deps.entryNotifiedTradeIds.delete(trade.id);
      // A52: who closed this is read off the reason the *submitting actor*
      // recorded, not inferred from the row's status. The old predicate was
      // `trade.status === "open" ? "bracket/manual" : "engine exit"`, which
      // races the row to `pending_exit` and loses on the faster-filling
      // broker: on 2026-08-26 two legs of one pause, closed by the same
      // actor 600ms apart, got different labels, and the mislabelled one had
      // `tp=null sl=null` — naming a bracket that did not exist.
      //
      // `tradeForLabel` is the pre-`setExitReason` snapshot on purpose. The
      // write above stamps a code on every close, so re-reading here would
      // make every exit look submitted.
      //
      // The status inference survives as the fallback for a submission that
      // recorded no reason at all. Nothing writes one today — both
      // `attachPendingExit` call sites name a reason — so this arm is
      // reached only by a genuinely exogenous close, which is exactly the
      // case it was written for.
      const exitKind = tradeForLabel.exitReasonCode != null
        ? "engine exit"
        : trade.status === "open"
          ? "bracket/manual"
          : "engine exit";
      deps.logEvent(
        "exit_filled",
        trade.deploymentId,
        `Trade #${trade.id} closed (${exitKind}) @ ${exitPrice} | PnL: ${pnlDollars.toFixed(2)} (${pnlTicks.toFixed(1)} ticks)`,
        {
          accountId,
          contractId: trade.contractId,
          tradeId: trade.id,
          values: {
            pnl: fmtSignedDollars(pnlDollars),
            reason: exitReasonActivity(exitReason.code, exitReason.detail),
          },
        },
      );
      const state = deps.stateFor(trade.deploymentId);
      if (state && state.activeTradeId === trade.id) {
        state.activeTradeId = null;
        state.position = null;
        state.breakEvenMoved = false;
        state.preEntryOrderIds = null;
        state.activeTpTicks = null;
        state.activeSlTicks = null;
        state.slMovedToBe = false;
        state.slCurrentPrice = null;
        state.tpCurrentPrice = null;
        // Cooldown is exit-anchored: stamp the moment we observe the exit
        // so the next entry attempt can't fire until cooldownSeconds elapse.
        // Use the real fill timestamp when we have it; fall back to now.
        state.cooldownAnchorAt = exitFilledAt ?? new Date().toISOString();
      }
      // Broker position flat + trade closed — release the (account,
      // contract) lock so another deployment can take over.
      deps.releaseContractLock(trade.accountId, trade.contractId, trade.deploymentId);
      // Confirmed flat, and the state teardown above has already run — the
      // point a `Pausing` row has been waiting for.
      deps.settleIfFlat(trade.deploymentId);
    }
  }
}

/**
 * Diff pre-entry open-order ids against post-fill open orders to find the
 * two new bracket orders Topstep created for this entry. Persist them on
 * the trade row so breakeven + reconciliation can target the exact SL/TP
 * belonging to THIS trade — matters when another deployment holds a
 * position on the same (account, contract).
 *
 * Falls back gracefully: if the snapshot is missing (process restart
 * between entry-submit and first reconcile) or the diff yields fewer
 * than two orders, we leave the ids null and the heuristic SL-lookup
 * path in `modifyStopLossToPrice` still works.
 *
 * A snapshot whose read failed is an empty one here (A119): the diff runs
 * on it, because skipping attribution would also skip recovery.
 */
export async function attributeBrackets(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  openOrders: Order[],
  accountId: number,
  entryPrice: number,
  /** The fill instant, when the caller holds a fresher one than the row.
   *  Null or absent falls back to the row's: the `pending_entry` branch
   *  passes null on a fill-lookup miss, which a default would not catch. */
  callerFilledAt?: string | null,
): Promise<void> {
  const entryFilledAt = callerFilledAt ?? trade.entryFilledAt;
  const state = deps.stateFor(trade.deploymentId);
  const snapshot = state?.preEntryOrderIds;
  if (!snapshot) return;

  const preIds = new Set(snapshot);
  const protectiveSide: OrderSide = trade.side === 0 ? 1 : 0;
  const newOnContract = openOrders.filter(
    (o) =>
      o.contractId === trade.contractId &&
      o.side === protectiveSide &&
      !preIds.has(o.id),
  );
  const tp = nearestToEntry(newOnContract.filter((o) => o.type === 1), trade.entrySubmittedAt, entryFilledAt);
  const sl = nearestToEntry(newOnContract.filter((o) => o.type === 4), trade.entrySubmittedAt, entryFilledAt);

  if (tp || sl) {
    setBracketOrderIds(trade.id, tp?.id ?? null, sl?.id ?? null);
    deps.logEvent(
      "bracket_ids_attributed",
      trade.deploymentId,
      `Trade #${trade.id} brackets attributed: TP=${tp?.id ?? "?"} SL=${sl?.id ?? "?"}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    const resting = await reanchorBracketsToTrigger(deps, trade, tp, sl, accountId, entryPrice);
    // Seed slCurrentPrice from the resting SL bracket so the close-time
    // BE/Trail classifier has authoritative data even if the engine
    // never moved the stop. Updated on every reconcile tick afterwards.
    // `resting.slPrice` is where the leg is after the re-anchor, which is
    // the same number as `sl.stopPrice` on a broker that never needed one.
    if (state && resting.slPrice != null) {
      state.slCurrentPrice = resting.slPrice;
    }
    // Snapshot served its purpose — release it.
    if (state) state.preEntryOrderIds = null;
    return;
  }

  deps.logEvent(
    "bracket_recovery_started",
    trade.deploymentId,
    `Trade #${trade.id} bracket attribution found no new orders on ${trade.contractId} — attempting recovery`,
    { accountId, contractId: trade.contractId, tradeId: trade.id },
  );
  // Release the snapshot before recovery: recovery places fresh brackets
  // (or force-closes); either way the pre-entry diff is no longer needed.
  if (state) state.preEntryOrderIds = null;

  await recoverFailedBrackets(deps, trade, accountId, entryPrice);
}

/**
 * The candidate leg created closest to the entry, so an operator's order
 * placed on the contract between the snapshot and this diff loses to the
 * broker's bracket (bugs.md A10). Topstep's `Order` carries no link to its
 * parent, so time is the only evidence. Distance is to the span from submit
 * to fill, because which of the two the broker stamps a bracket with is not
 * on record; the engine's entries are market orders, so the span is short.
 *
 * An ordering, not a window: it never drops a candidate, so a bracket stamped
 * further out than any window would have allowed is still found, and a diff
 * with no bracket in it reaches recovery exactly as before. Ties keep the
 * broker's order, which is what `find` took; so does any unreadable stamp
 * among the candidates, because a missing stamp is no evidence the leg is
 * not the bracket, and ranking it last would hand the pick to whichever
 * order happens to be readable.
 */
function nearestToEntry(
  candidates: Order[],
  entrySubmittedAt: string,
  entryFilledAt: string | null,
): Order | undefined {
  const submitted = Date.parse(entrySubmittedAt);
  const filled = entryFilledAt != null ? Date.parse(entryFilledAt) : Number.NaN;
  const ends = [submitted, filled].filter(Number.isFinite);
  if (ends.length === 0) return candidates[0];
  if (candidates.some((o) => !Number.isFinite(Date.parse(o.creationTimestamp)))) return candidates[0];
  const from = Math.min(...ends);
  const to = Math.max(...ends);
  const distance = (o: Order): number => {
    const at = Date.parse(o.creationTimestamp);
    return at < from ? from - at : at > to ? at - to : 0;
  };
  let best: Order | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const o of candidates) {
    const d = distance(o);
    if (best === undefined || d < bestDistance) {
      best = o;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Move the bracket legs onto the trigger price the strategy signalled,
 * for a broker that anchored them to its own fill.
 *
 * **This is an amend after the fill, and it cannot be anything else.**
 * Topstep's bracket is a signed tick offset it resolves server-side
 * against the fill, so an entry order cannot express "put the stop at
 * 29417.00" — the engine does not know the fill until it happens. Nothing
 * on `/api/Order/place` takes an absolute bracket price. The alternative,
 * placing the entry naked and the brackets afterwards, opens an
 * unprotected window on every entry; this costs one reconciler tick of a
 * bracket sitting `slippage` away from where it belongs, which is the
 * exposure the operator accepted when he chose the trigger anchor
 * ([bugs.md](../../../../../docs/bugs.md) A69).
 *
 * Three properties, each of which is the reason for the line below it:
 *
 * - **A leg already on the target is left alone**, compared through the
 *   integer tick arithmetic rather than a float equality, so a broker whose
 *   brackets are already trigger-anchored pays no round trip.
 * - **A target already through the market is refused.** Topstep's
 *   behaviour on a modify through market is undocumented and one of the
 *   three possibilities is reject-and-orphan, which would strip the stop
 *   off a live position ([topstep.md](../../../../../docs/modules/brokers/topstep.md)).
 *   It can only be reached by slippage wider than the bracket itself. The
 *   mark is the fill, which is the freshest price this path holds and is
 *   up to a reconciler tick stale — the same trade `modifyStopLossToPrice`
 *   makes with the evaluation bar's close. What that leaves uncovered is a
 *   market that has travelled a whole bracket width since the fill, where
 *   the leg being moved was about to trigger regardless.
 * - **What the legs are actually resting at is returned and written to the
 *   row**, so a refusal or a broker error cannot leave the table showing a
 *   price nothing rests at — which was the display half of A69.
 */
async function reanchorBracketsToTrigger(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  tp: Order | undefined,
  sl: Order | undefined,
  accountId: number,
  fillPrice: number,
): Promise<{ tpPrice: number | null; slPrice: number | null }> {
  const resting = {
    tpPrice: tp?.limitPrice ?? null,
    slPrice: sl?.stopPrice ?? null,
  };
  const anchor = deps.capabilitiesFor(deps.brokerKindFor(accountId)).bracketAnchor;
  if (anchor === "trigger") return resting;

  const tickSize = trade.tickSize ?? 0;
  const trigger = trade.desiredEntryPrice;
  const tpTicks = trade.desiredTpTicks;
  const slTicks = trade.desiredSlTicks;
  if (tickSize <= 0 || trigger == null || tpTicks == null || slTicks == null) {
    deps.logEvent(
      "bracket_reanchor_failed",
      trade.deploymentId,
      `Trade #${trade.id} cannot be re-anchored to its trigger: missing tickSize=${tickSize} trigger=${trigger} tpTicks=${tpTicks} slTicks=${slTicks} — the brackets stay where the broker put them`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return resting;
  }

  const isLong = trade.side === 0;
  const legs: Array<{
    kind: "tp" | "sl";
    order: Order | undefined;
    current: number | null;
    target: number;
    /** Where the market has to be for this leg to be placeable at all. */
    marketSideOk: (target: number) => boolean;
  }> = [
    {
      kind: "tp",
      order: tp,
      current: tp?.limitPrice ?? null,
      target: priceFromTicks(trigger, isLong ? tpTicks : -tpTicks, tickSize),
      marketSideOk: (target) => (isLong ? target > fillPrice : target < fillPrice),
    },
    {
      kind: "sl",
      order: sl,
      current: sl?.stopPrice ?? null,
      target: priceFromTicks(trigger, isLong ? -slTicks : slTicks, tickSize),
      marketSideOk: (target) => (isLong ? target < fillPrice : target > fillPrice),
    },
  ];

  // A ratchet can move the stop before attribution — `modifyStopLossToPrice`
  // finds the leg heuristically with no `slOrderId` — when the reconciler
  // falls a bar or more behind the bar path. Re-anchoring that stop would
  // put the original risk back on.
  const stopRatcheted =
    (deps.stateFor(trade.deploymentId)?.slMovedToBe ?? false) ||
    trade.breakEvenMoved ||
    trade.slTrailEngaged;

  for (const leg of legs) {
    if (!leg.order) continue;
    if (leg.kind === "sl" && stopRatcheted) {
      deps.log(
        trade.deploymentId,
        "info",
        "order",
        `Trade #${trade.id} SL #${leg.order.id} not re-anchored: break-even or the trail already moved it — the stop stays at ${leg.current ?? "?"}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      continue;
    }
    if (leg.current != null && pnlTicksFromPrices(leg.current, leg.target, 1, tickSize) === 0) {
      continue;
    }
    if (!leg.marketSideOk(leg.target)) {
      deps.logEvent(
        "bracket_reanchor_failed",
        trade.deploymentId,
        `Trade #${trade.id} ${leg.kind.toUpperCase()} #${leg.order.id} not re-anchored: ${leg.target} is already through the ${fillPrice} fill — the leg stays at ${leg.current ?? "?"}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      continue;
    }
    try {
      await deps.brokerForAccount(accountId).modifyOrder(
        accountId,
        leg.order.id,
        leg.kind === "sl" ? { stopPrice: leg.target } : { limitPrice: leg.target },
      );
      if (leg.kind === "tp") resting.tpPrice = leg.target;
      else resting.slPrice = leg.target;
      deps.logEvent(
        "bracket_reanchored",
        trade.deploymentId,
        `Trade #${trade.id} ${leg.kind.toUpperCase()} #${leg.order.id} re-anchored to the trigger: ${leg.current ?? "?"} → ${leg.target}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
    } catch (err) {
      deps.logEvent(
        "bracket_reanchor_failed",
        trade.deploymentId,
        `Trade #${trade.id} ${leg.kind.toUpperCase()} #${leg.order.id} re-anchor to ${leg.target} failed: ${err instanceof Error ? err.message : String(err)} — the leg stays at ${leg.current ?? "?"}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      deps.maybeOrphanFromBrokerError(err, accountId);
    }
  }

  setRestingBracketPrices(trade.id, resting.tpPrice, resting.slPrice);
  return resting;
}

/**
 * The last check before recovery puts a second bracket pair on the book:
 * is a protective-side limit or stop already working on this contract?
 * The snapshot diff is recovery's only evidence that the broker's pair is
 * missing, and a diff that missed it (a stale snapshot or a stale read)
 * would otherwise leave two pairs. Nothing on the exogenous-close path
 * cancels the spare one, so its stop would rest on a flat book and open an
 * unmanaged position. `contractLocks` keeps any sibling deployment off this
 * (account, contract), so a working order here belongs to this trade or to
 * the operator; either way it is not a reason to add another pair.
 *
 * Returns true when recovery must not place anything: protection was found
 * and adopted, or the read failed. Refusing on a failed read is fail-closed
 * against a duplicate pair; the naked-position watchdog still covers a
 * position that really is unprotected.
 */
async function adoptWorkingProtection(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<boolean> {
  let orders: Order[];
  try {
    orders = await deps.brokerForAccount(accountId).searchOpenOrders(accountId, { forceFresh: true });
  } catch (err) {
    deps.log(
      trade.deploymentId,
      "warn",
      "order",
      `Trade #${trade.id} bracket recovery: open-order lookup failed: ${err instanceof Error ? err.message : String(err)} — not placing brackets without knowing whether some are already working; the naked-position watchdog is the backstop`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    deps.maybeOrphanFromBrokerError(err, accountId);
    return true;
  }
  const protectiveSide: OrderSide = trade.side === 0 ? 1 : 0;
  const working = orders.filter(
    (o) => o.contractId === trade.contractId && o.side === protectiveSide && (o.type === 1 || o.type === 4),
  );
  if (working.length === 0) return false;

  const tp = working.find((o) => o.type === 1);
  const sl = working.find((o) => o.type === 4);
  setBracketOrderIds(trade.id, tp?.id ?? null, sl?.id ?? null);
  deps.logEvent(
    "bracket_ids_attributed",
    trade.deploymentId,
    `Trade #${trade.id} brackets attributed from the working orders on ${trade.contractId}, not the pre-entry diff: TP=${tp?.id ?? "?"} SL=${sl?.id ?? "?"} — no recovery brackets placed`,
    { accountId, contractId: trade.contractId, tradeId: trade.id },
  );
  return true;
}

/**
 * Bracket attribution found no TP/SL on the contract post-fill, meaning
 * Topstep silently rejected the atomic bracket pair attached to the entry
 * order (most likely sub-spread ticks or a degenerate price range). The
 * position is open and unprotected. One retry with separate placeOrder
 * calls — if THAT fails, force-close to prevent unprotected exposure.
 *
 * Same TP/SL ticks the entry was supposed to have. No relaxing the price
 * — if the broker rejected at intended distances, repeating with the same
 * distances at least confirms the rejection isn't transient before we
 * scratch the position.
 */
export function recoverFailedBrackets(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
  entryPrice: number,
): Promise<void> {
  // Tracked whole: a SIGTERM's exit cutting between the TP and the SL
  // leaves a position with only a TP, and its force-close fallback is
  // the cancel-then-close the drain exists to finish.
  return trackOrderRequest(() => recoverFailedBracketsUntracked(deps, trade, accountId, entryPrice));
}

async function recoverFailedBracketsUntracked(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
  entryPrice: number,
): Promise<void> {
  // Verify the position is still open before doing anything. Avoids
  // double-action when the bracket "rejection" was actually a fast TP/SL
  // hit between the entry-fill observation and this recovery path.
  let livePos;
  try {
    const positions = await deps.brokerForAccount(accountId).searchOpenPositions(accountId);
    livePos = positions.find((p) => p.contractId === trade.contractId && p.size > 0);
  } catch (err) {
    deps.log(
      trade.deploymentId,
      "warn",
      "order",
      `Trade #${trade.id} bracket recovery: position lookup failed: ${err instanceof Error ? err.message : String(err)} — skipping retry. The snapshot is already released, so attribution will not run again for this trade; the naked-position watchdog is the backstop`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }
  if (!livePos) {
    deps.log(
      trade.deploymentId,
      "info",
      "order",
      `Trade #${trade.id} bracket recovery: position already flat — no action needed`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }

  // Confirm the trade row is still in a state where recovery makes sense.
  // `pending_exit` is deliberately refused — see bracketRecoveryEligibility.
  const fresh = getTradeById(trade.id);
  const eligibility = bracketRecoveryEligibility(
    fresh,
    deps.stateFor(trade.deploymentId)?.exitInFlight ?? false,
  );
  if (!eligibility.eligible) {
    deps.log(
      trade.deploymentId,
      "info",
      "order",
      `Trade #${trade.id} bracket recovery skipped: ${eligibility.reason}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }

  if (await adoptWorkingProtection(deps, trade, accountId)) return;

  const deployment = getDeployment(trade.deploymentId);
  if (!deployment) {
    deps.log(
      trade.deploymentId,
      "warn",
      "order",
      `Trade #${trade.id} bracket recovery: deployment missing — cannot retry brackets or force-close`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }

  const tickSize = trade.tickSize ?? 0;
  const tpTicks = trade.desiredTpTicks;
  const slTicks = trade.desiredSlTicks;
  if (tickSize <= 0 || tpTicks == null || slTicks == null || tpTicks <= 0 || slTicks <= 0) {
    deps.logEvent(
      "bracket_recovery_metadata_missing",
      trade.deploymentId,
      `Trade #${trade.id} bracket recovery: missing tick metadata (tickSize=${tickSize} tpTicks=${tpTicks} slTicks=${slTicks}) — cannot retry, force-closing`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    await deps.forceCloseAfterBracketFailure(
      trade,
      deployment,
      entryPrice,
      "missing tick metadata",
      "missing tick metadata",
    );
    return;
  }

  const isLong = trade.side === 0;
  const protectiveSide: OrderSide = isLong ? 1 : 0;
  // Anchored to the trigger, like every other bracket the engine places —
  // a replacement leg on the fill would reintroduce the divergence A69
  // closed, on the path where it is least likely to be noticed. Falls back
  // to the fill only for a row written before the trigger was recorded.
  const anchorPrice = trade.desiredEntryPrice ?? entryPrice;
  const tpPrice = priceFromTicks(anchorPrice, isLong ? tpTicks : -tpTicks, tickSize);
  const slPrice = priceFromTicks(anchorPrice, isLong ? -slTicks : slTicks, tickSize);

  const exitSize = livePos.size;
  const tpRequest: PlaceOrderRequest = {
    accountId,
    contractId: trade.contractId,
    type: 1, // Limit
    side: protectiveSide,
    size: exitSize,
    limitPrice: tpPrice,
    customTag: deps.buildCustomTag("e", deployment.id).replace(/^e_/, "rt_"),
    // Bracket-retry legs are standalone post-entry orders (no OSO);
    // tag as "exit" role on the Tradovate map so an inbound fill
    // attributes back to the deployment via the role-agnostic
    // deploymentId column. The DB role enum doesn't carry a separate
    // bracket-retry kind today.
    deploymentId: deployment.id,
    brokerOrderRole: BrokerOrderRole.Exit,
  };
  const slRequest: PlaceOrderRequest = {
    accountId,
    contractId: trade.contractId,
    type: 4, // Stop
    side: protectiveSide,
    size: exitSize,
    stopPrice: slPrice,
    customTag: deps.buildCustomTag("e", deployment.id).replace(/^e_/, "rs_"),
    deploymentId: deployment.id,
    brokerOrderRole: BrokerOrderRole.Exit,
  };

  deps.logEvent(
    "bracket_retry_submitted",
    trade.deploymentId,
    `Trade #${trade.id} bracket retry: TP@${tpPrice} (${tpTicks}t) SL@${slPrice} (${slTicks}t) size=${exitSize}`,
    { accountId, contractId: trade.contractId, tradeId: trade.id },
  );

  const broker = deps.brokerForAccount(accountId);
  let tpOrderId: number | null = null;
  let tpError: string | null = null;
  try {
    const res = await broker.placeOrder(tpRequest);
    tpOrderId = res.orderId;
  } catch (err) {
    tpError = err instanceof Error ? err.message : String(err);
    deps.maybeOrphanFromBrokerError(err, accountId);
  }

  let slOrderId: number | null = null;
  let slError: string | null = null;
  try {
    const res = await broker.placeOrder(slRequest);
    slOrderId = res.orderId;
  } catch (err) {
    slError = err instanceof Error ? err.message : String(err);
    deps.maybeOrphanFromBrokerError(err, accountId);
  }

  if (tpOrderId != null && slOrderId != null) {
    // Stamp the ids even if an exit arrived during the two placeOrder
    // round-trips: they are live orders at the broker either way, and
    // `cancelTrackedBrackets` can only reach what this records. Not
    // stamping them would orphan two working orders, which is worse than
    // the bookkeeping smear `verifyExitClean`'s residual sweep already
    // cleans up. Warn so the collision is visible in /logs rather than
    // inferred later from a stray cancel.
    setBracketOrderIds(trade.id, tpOrderId, slOrderId);
    // The replacement legs are the prices the row now has to show — the
    // same trigger anchor, recomputed on the tick grid.
    setRestingBracketPrices(trade.id, tpPrice, slPrice);
    const raced = bracketRecoveryEligibility(
      getTradeById(trade.id),
      deps.stateFor(trade.deploymentId)?.exitInFlight ?? false,
    );
    deps.logEvent(
      raced.eligible ? "bracket_retry_succeeded" : "bracket_retry_raced",
      trade.deploymentId,
      raced.eligible
        ? `Trade #${trade.id} bracket retry succeeded: TP=${tpOrderId} SL=${slOrderId}`
        : `Trade #${trade.id} bracket retry succeeded (TP=${tpOrderId} SL=${slOrderId}) but an exit landed mid-retry: ${raced.reason}. Brackets recorded so they stay cancellable.`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }

  // Partial success — cancel the leg that placed so we don't leave half-
  // protection sitting in the book once we force-close.
  if (tpOrderId != null) {
    try {
      await broker.cancelOrder(tpOrderId, accountId);
    } catch (err) {
      deps.logEvent(
        "bracket_cancel_failed",
        trade.deploymentId,
        `Trade #${trade.id} bracket retry: cancel of partial TP #${tpOrderId} failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      deps.maybeOrphanFromBrokerError(err, accountId);
    }
  }
  if (slOrderId != null) {
    try {
      await broker.cancelOrder(slOrderId, accountId);
    } catch (err) {
      deps.logEvent(
        "bracket_cancel_failed",
        trade.deploymentId,
        `Trade #${trade.id} bracket retry: cancel of partial SL #${slOrderId} failed: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId: trade.contractId, tradeId: trade.id },
      );
      deps.maybeOrphanFromBrokerError(err, accountId);
    }
  }

  // Re-run the gate. The one at the top of this function is stale by now:
  // two `placeOrder` round-trips and up to two `cancelOrder` round-trips
  // have gone by, and `evaluateRealtimeExits` is fire-and-forget on every
  // price-moving tick with no `ticking` guard, so an exit can be submitted
  // inside any of those awaits. It releases `exitInFlight` at *submission*,
  // so the latch is free again by the time we get here while the position
  // is still open — which is precisely the submission-to-fill window
  // `bracketRecoveryEligibility` exists to refuse, and `placeExitOrder`'s
  // own aliveness check cannot catch, because it reads `searchOpenPositions`
  // and the racing exit has not filled yet.
  //
  // Reaching the force-close on a stale gate is a second market flatten
  // against a position already being flattened — it flips the position.
  // Cheap to re-check: the predicate is pure and both inputs are synchronous
  // reads, so nothing is awaited between the read and the dispatch below.
  const stillEligible = bracketRecoveryEligibility(
    getTradeById(trade.id),
    deps.stateFor(trade.deploymentId)?.exitInFlight ?? false,
  );
  if (!stillEligible.eligible) {
    deps.log(
      trade.deploymentId,
      "warn",
      "safety",
      `Trade #${trade.id} bracket retry FAILED but force-close is skipped: ${stillEligible.reason}. TP error: ${tpError ?? "unknown"}. SL error: ${slError ?? "unknown"}.`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    return;
  }

  await deps.forceCloseAfterBracketFailure(
    trade,
    deployment,
    entryPrice,
    tpError ?? "unknown TP rejection",
    slError ?? "unknown SL rejection",
  );
}

/**
 * Look up the real entry-fill timestamp from /Trade/search for a trade
 * we've just observed transition from pending_entry to filled. Returns
 * null if Topstep hasn't indexed the fill yet (common — fills can lag
 * the position-open event by a few seconds); the heal pass in
 * `reconcilePendingTrades` retries on later ticks.
 *
 * Single Trade/search call — same call we'd make for handleEntry-
 * ClosedNoPosition / resolveExitFromFills. Cost is one extra REST per
 * fill detection, not per tick.
 */
export async function lookupEntryFillTimestamp(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<string | null> {
  if (trade.entryOrderId == null) return null;
  let fills;
  try {
    fills = await deps.brokerForAccount(accountId).searchTrades(
      accountId,
      trade.entrySubmittedAt,
      new Date().toISOString(),
    );
  } catch (err) {
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} entry-timestamp lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    deps.maybeOrphanFromBrokerError(err, accountId);
    return null;
  }
  const entryFills = fills.filter(
    (f) => f.orderId === trade.entryOrderId && !f.voided,
  );
  if (entryFills.length === 0) return null;
  let firstTs = entryFills[0].creationTimestamp;
  for (const f of entryFills) {
    if (new Date(f.creationTimestamp) < new Date(firstTs)) {
      firstTs = f.creationTimestamp;
    }
  }
  return firstTs;
}

/**
 * pending_entry + entry order closed + no position ⇒ two possibilities:
 * (a) entry never filled (rejected/cancelled), or
 * (b) entry filled AND the TP/SL bracket subsequently filled within the
 *     same 30s reconciler window — we missed the transient "open" state.
 * Trade/search disambiguates: a fill on `entryOrderId` means (b), and we
 * need to mark filled + run the exit branch in this same tick, otherwise
 * a win gets silently written off as "entry_not_filled".
 *
 * Trade/search indexes a fill seconds after the broker books it, so the
 * Layer 1 buffer's fills on the entry order count too, deduped by fill id.
 *
 * Returns the promoted row (a copy; the input is not touched) for the
 * caller to re-dispatch; `ENTRY_ROW_SUPERSEDED` when another path moved the
 * row off `pending_entry` meanwhile — the caller's row was read before its
 * broker read, and the user hub promotes and closes a fast round trip inside
 * it; `ENTRY_FILL_DEFERRED` when no fill was seen but Trade/search threw or
 * may not have indexed it yet (until the entry is `STALE_PENDING_ENTRY_MS`
 * old, so a Trade/search that never recovers cannot hold the row); and
 * `null` only when no fill was seen and the silence is an answer.
 */
export async function handleEntryClosedNoPosition(
  deps: ReconcileDeps,
  trade: StrategyTrade,
  accountId: number,
): Promise<StrategyTrade | null | typeof ENTRY_ROW_SUPERSEDED | typeof ENTRY_FILL_DEFERRED> {
  const entryOrderId = trade.entryOrderId;
  if (entryOrderId == null) return null;
  let searched: TradeFill[] = [];
  let searchFailed = false;
  try {
    searched = await deps.brokerForAccount(accountId).searchTrades(
      accountId,
      trade.entrySubmittedAt,
      new Date().toISOString(),
    );
  } catch (err) {
    deps.log(
      trade.deploymentId,
      "warn",
      "trade",
      `Trade #${trade.id} handleEntryClosedNoPosition: Trade/search failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId: trade.contractId, tradeId: trade.id },
    );
    searchFailed = true;
  }

  // After the last await, so nothing can promote the row between this read
  // and the write below.
  const current = getTradeById(trade.id);
  if (current && current.status !== "pending_entry") return ENTRY_ROW_SUPERSEDED;

  const entryAgeMs = Date.now() - new Date(trade.entrySubmittedAt).getTime();
  if (searchFailed && entryAgeMs < STALE_PENDING_ENTRY_MS) return ENTRY_FILL_DEFERRED;

  const buffered =
    deps.bufferSlotFor(deps.bufferSlotKey(accountId, trade.contractId, trade.id))?.fills ?? [];
  const onEntry = [...searched, ...buffered].filter((f) => f.orderId === entryOrderId);
  // Voided in either source is voided: the Tradovate translator hardcodes
  // `voided: false`, so a per-copy check let the buffer's copy win.
  const voidedIds = new Set(onEntry.filter((f) => f.voided).map((f) => f.id));
  const byId = new Map<number, TradeFill>();
  for (const f of onEntry) {
    if (!voidedIds.has(f.id)) byId.set(f.id, f);
  }
  const entryFills = [...byId.values()];
  if (entryFills.length === 0) {
    return entryAgeMs < EXIT_FILL_LATE_ARRIVAL_PAD_MS ? ENTRY_FILL_DEFERRED : null;
  }

  // Compute the entry fill price (size-weighted) and mark the trade as
  // filled so the exit branch below can resolve PnL from the bracket fill.
  let entrySize = 0;
  let entryWeighted = 0;
  let firstFillTs = entryFills[0].creationTimestamp;
  for (const f of entryFills) {
    entrySize += f.size;
    entryWeighted += f.price * f.size;
    if (new Date(f.creationTimestamp) < new Date(firstFillTs)) {
      firstFillTs = f.creationTimestamp;
    }
  }
  const entryPrice = entryWeighted / entrySize;
  markEntryFilled(trade.id, entryPrice, firstFillTs);
  latchFilledEntry(deps, trade);
  deps.logEvent(
    "entry_filled",
    trade.deploymentId,
    `Trade #${trade.id} entry filled @ ${entryPrice} (resolved via Trade/search after bracket exit)`,
    {
      accountId,
      contractId: trade.contractId,
      tradeId: trade.id,
      values: entryFillValues(trade, entryPrice, entrySize),
    },
  );
  if (!deps.entryNotifiedTradeIds.has(trade.id)) {
    deps.entryNotifiedTradeIds.add(trade.id);
    void deps.notifyEntry(trade, entryPrice, firstFillTs, entrySize);
  }

  return { ...trade, entryPrice, entryFilledAt: firstFillTs, status: "open" };
}
