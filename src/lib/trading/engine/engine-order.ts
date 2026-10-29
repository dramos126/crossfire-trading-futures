// Entry order placement for the engine. Broker routing flows through
// `deps.brokerFor(deployment)` (returning a `Broker`); the Tradovate
// fast-path bracket attribution branch additionally consults
// `deps.pluginFor(deps.brokerKindFor(...))`. Adding a new broker means
// registering its `BrokerPlugin` (resolved by `pluginFor` in engine.ts)
// and, if needed, extending the broker-specific branch below.

import type { Broker } from "../broker-access/broker";
import { executionContractId } from "../broker-access/contract-resolver";
import { BrokerOrderRole } from "../orders/order-role";
import { priceFromTicks } from "../orders/pnl-math";
import type { AccountRiskBasis, AccountRiskPhase } from "../orders/account-phase-sizer";
import { BrokerKind } from "@/lib/db/account-brokers";
import type { BrokerPlugin } from "@/lib/brokers/plugin";
import {
  insertPendingEntry,
  markEntryFailed,
  setBracketOrderIds,
  setEntryOrderId,
} from "@/lib/db/trades";
import type {
  Contract,
  OrderSide,
  PlaceOrderRequest,
} from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { CommonParams, StrategyModule } from "../strategy-types";
import type { LogSubject } from "./engine";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import { trackOrderRequest } from "@/lib/shutdown-drain";

/**
 * Engine-internal surface used by {@link placeEntryOrder}. Lets the
 * extracted module call private engine methods (broker resolution, lock
 * management, fill-buffer setup, plugin/kind lookup, logging, error
 * triage) without changing their access modifiers.
 */
export interface PlaceEntryOrderDeps {
  brokerFor: (deployment: Deployment) => Broker;
  brokerKindFor: (accountId: number) => BrokerKind;
  pluginFor: (kind: BrokerKind) => BrokerPlugin;
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
  releaseContractLock: (accountId: number, contractId: string, deploymentId: string) => void;
  acquireContractLock: (accountId: number, contractId: string, deploymentId: string, tradeId: number) => void;
  openBufferSlot: (accountId: number, contractId: string, tradeId: number) => void;
  maybeOrphanFromBrokerError: (err: unknown, accountId: number) => void;
  /** The broker threw on an entry: re-read what the account can do now if it
   *  was a refusal (not a 429 or a network error — the engine asks the owning
   *  broker). The account entry gate refuses the next signal off the stored
   *  answer, so a dead or violated account costs one rejection, not one per
   *  signal. Synchronous and fire-and-forget; it decides nothing here. */
  noteEntryRejected: (err: unknown, accountId: number) => void;
  buildCustomTag: (prefix: "e" | "x" | "s", deploymentId: string) => string;
  engineSessionId: string;
}

/**
 * The pre-entry snapshots whose read threw (bugs.md A119). Such a snapshot is
 * an empty array, which is also what a genuinely empty book reads as, and the
 * two must not be one answer: the stage-2 cancel treats a failed one as no
 * snapshot at all, while `attributeBrackets` still diffs against it, because
 * storing `null` instead would skip attribution and bracket recovery.
 *
 * A third value carried by identity rather than a field beside the ids, so
 * `DeploymentState.preEntryOrderIds` keeps its one type and every writer that
 * nulls it clears the mark with it. Keyed weakly: it holds nothing alive. A
 * copy of the array loses the mark and reads as an empty book, which is the
 * behaviour before the mark existed.
 */
const failedPreEntrySnapshots = new WeakSet<readonly number[]>();

/** The snapshot a failed pre-entry read stores: empty, and marked. */
export function failedPreEntrySnapshot(): number[] {
  const ids: number[] = [];
  failedPreEntrySnapshots.add(ids);
  return ids;
}

export function isFailedPreEntrySnapshot(ids: readonly number[] | null | undefined): boolean {
  return ids != null && failedPreEntrySnapshots.has(ids);
}

/**
 * What the sizer decided `size` from, and which arm of the account's phase
 * produced the budget it divided.
 *
 * The three numbers on top are the sizer's own; the rest are the session
 * budget's facts, and they are here because nothing else reconstructs *why* a
 * trade was sized as it was — a $350 trade on a day the operator thought was a
 * $500 day is either a stale sample or a threshold crossed, and the row has to
 * say which. Every phase fact is `null` in phase `off`, where the flat pair is
 * all that was read.
 */
export interface EntryRiskFacts {
  maxRiskPerTradeUsd: number;
  maxContracts: number;
  riskPerContractUsd: number;
  /** The playbook cap the sizer applied, `null` when it sets none. Named apart
   *  from the `playbookMaxContracts` setting, whose `0` means the same. */
  appliedPlaybookMaxContracts: number | null;
  appliedPlaybookRiskPercent: number;
  /** The account's budget scaled by the applied share — what was divided. */
  playbookBudgetUsd: number;
  phase: AccountRiskPhase;
  basis: AccountRiskBasis;
  headroomUsd: number | null;
  floorUsd: number | null;
  closeUsd: number | null;
  peakUsd: number | null;
  sizesSessionStart: string | null;
}

export interface PlacedEntry {
  tradeId: number | null;
  preEntryOrderIds: number[];
  /** Where the SL bracket was placed, when this call stamped its id (a
   *  `"sync"` broker); null when the reconciler attributes it later. */
  slCurrentPrice: number | null;
}

/**
 * Place an entry and its brackets. Run as order work, so a SIGTERM's exit
 * waits for it: an entry cut after `placeOrder` left leaves a fill nobody
 * saw placed until the next process attributes it.
 */
export function placeEntryOrder(
  ...args: Parameters<typeof placeEntryOrderUntracked>
): Promise<PlacedEntry> {
  return trackOrderRequest(() => placeEntryOrderUntracked(...args));
}

async function placeEntryOrderUntracked(
  deps: PlaceEntryOrderDeps,
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
  /** What the sizer decided `size` from — see `paramSnapshot` below. */
  risk: EntryRiskFacts,
  signalBarTs: string,
  /** The regime label in force for the signal bar's session day, as
   *  `regime_days` held it at this instant, or null when nothing has labelled
   *  that day yet. Stamped on the row and never recomputed — a label derived
   *  later is a label under whatever classifier is on disk then. */
  regime: { label: string; classifierVersion: string } | null,
  /** `EntrySignal.sessionKey`. Stamped at insert, before the order can fill,
   *  so a restart at any point after the fill can rebuild the latch. */
  sessionKey: string | undefined,
): Promise<PlacedEntry> {
  const exId = executionContractId(contract);

  // Snapshot open orders on (account, contract) BEFORE we submit entry.
  // The reconciler diffs this against post-fill open orders to identify
  // the TP/SL bracket pair Topstep creates for this specific entry —
  // critical when a second deployment holds a position on the same
  // contract, since a contract-only filter could otherwise match the
  // wrong SL when we move to breakeven.
  let preEntryOrderIds: number[] = [];
  try {
    // Fresh, not the 1s cache: the snapshot is the whole basis of bracket
    // attribution, and a cached read that predates an order already working
    // here would count that order as one of this entry's brackets.
    const orders = await deps
      .brokerFor(deployment)
      .searchOpenOrders(deployment.accountId, { forceFresh: true });
    preEntryOrderIds = orders
      .filter((o) => o.contractId === exId)
      .map((o) => o.id);
  } catch (err) {
    preEntryOrderIds = failedPreEntrySnapshot();
    deps.log(
      deployment.id,
      "warn",
      "order",
      `Pre-entry order snapshot failed: ${err instanceof Error ? err.message : String(err)} — bracket attribution will fall back to heuristic filter`,
      { accountId: deployment.accountId, contractId: exId },
    );
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
  }

  // Broker-side safety net: verify Topstep has no live position on this
  // (account, contract) before we submit. Catches the case where our
  // in-memory lock map has drifted from reality — e.g. manual trade on
  // the webapp, prior engine crash with stale DB, or a bracket fill the
  // reconciler hasn't observed yet. Cheaper than stacking a position and
  // discovering the mismatch at fill time. Lock is held by the caller; on
  // any abort path here we must release it so the next bar isn't blocked.
  try {
    const positions = await deps.brokerFor(deployment).searchOpenPositions(deployment.accountId);
    // Position.type: 1 = long, 2 = short. `size` is always positive.
    const existing = positions.find((p) => p.contractId === exId && p.size > 0);
    if (existing) {
      deps.releaseContractLock(deployment.accountId, exId, deployment.id);
      deps.logEvent(
        "entry_aborted_broker_position",
        deployment.id,
        `Entry aborted: Topstep already reports an open ${existing.type === 1 ? "LONG" : "SHORT"} ${existing.size} on ${exId} — engine lock missed this position`,
        { accountId: deployment.accountId, contractId: exId },
      );
      throw new Error("broker position conflict");
    }
  } catch (err) {
    // If the error is our own abort, rethrow — the caller treats it as a
    // signal to skip and retry later.
    if (err instanceof Error && err.message === "broker position conflict") throw err;
    // Otherwise the position query itself failed; log and proceed. Better
    // to trust the engine lock than to block every entry on a transient
    // REST blip.
    deps.log(
      deployment.id,
      "warn",
      "order",
      `Broker position check failed: ${err instanceof Error ? err.message : String(err)} — proceeding on engine lock only`,
      { accountId: deployment.accountId, contractId: exId },
    );
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
  }

  const order: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: exId,
    type: strategy.config.entryType,
    side,
    size,
    customTag: deps.buildCustomTag("e", deployment.id),
    // Tradovate-translation context (Topstep ignores both). The
    // Tradovate translator multiplies signed bracket ticks by
    // tickSize and adds them to referencePrice to materialize
    // absolute bracket1/bracket2 prices on the OSO body. Phase 3
    // throws loudly on a bracketed order that arrives without
    // these — Phase 4 wires them at every Tradovate-routable site.
    tickSize: contract.tickSize,
    referencePrice: desiredEntryPrice,
    deploymentId: deployment.id,
    brokerOrderRole: BrokerOrderRole.Entry,
  };

  // Topstep's bracket `ticks` is a signed offset from entry:
  // long  (side 0) → TP above (+tp), SL below (-sl)
  // short (side 1) → TP below (-tp), SL above (+sl)
  const tpTicks = side === 0 ? resolvedTp : -resolvedTp;
  const slTicks = side === 0 ? -resolvedSl : resolvedSl;
  order.takeProfitBracket = { ticks: tpTicks, type: 1 };
  order.stopLossBracket = { ticks: slTicks, type: 4 };

  const sideLabel = side === 0 ? "BUY" : "SELL";
  deps.logEvent(
    "entry_submitted",
    deployment.id,
    `${sideLabel} ${size} ${deployment.ticker} (${exId}) | TP:${tpTicks} SL:${slTicks}`,
    { accountId: deployment.accountId, contractId: exId },
  );

  // The bracket, anchored to the trigger. This is where both brokers'
  // legs end up resting: Tradovate prices its OSO body off
  // `referencePrice` directly, and Topstep's fill-anchored offsets are
  // re-anchored onto these prices once the fill is known (see
  // `reanchorBracketsToTrigger`). The signal identifies levels, so the
  // level is what the bracket sits on — bugs.md A69.
  const desiredTpPrice = priceFromTicks(desiredEntryPrice, tpTicks, contract.tickSize);
  const desiredSlPrice = priceFromTicks(desiredEntryPrice, slTicks, contract.tickSize);

  // Engine-session + deployment-version stamps for the analytics
  // exclusion bucket. Capture failure must not block the trade — falls
  // through as null and analytics treats null as "predates session
  // tracking, include unconditionally" (null-as-include).
  let engineSessionId: string | undefined;
  let deploymentVersionId: string | undefined;
  try {
    engineSessionId = deps.engineSessionId;
    deploymentVersionId = String(deployment.version);
  } catch (err) {
    deps.log(
      deployment.id,
      "warn",
      "system",
      `Session/version stamp capture failed; persisting null: ${err instanceof Error ? err.message : String(err)}`,
      { accountId: deployment.accountId, contractId: exId },
    );
    engineSessionId = undefined;
    deploymentVersionId = undefined;
  }

  // Insert the trade row BEFORE `placeOrder` so the user-hub
  // position-event handler can find the row the moment the broker pushes
  // a fill (Tradovate's WS push is sub-10ms and routinely beats the
  // REST `placeOrder` response, leaving `findTradeByAccountContract`
  // missing and `markEntryFilled` never running). `entry_order_id` is
  // null here and stamped via `setEntryOrderId` after placeOrder
  // returns. Reconciler branches that key off `entryOrderId != null`
  // (stale-sweep, fill-detect, closed-no-position) safely no-op during
  // the sub-second window between insert and stamp.
  let tradeId: number;
  try {
    tradeId = insertPendingEntry({
      deploymentId: deployment.id,
      strategyKey: deployment.strategyKey,
      accountId: deployment.accountId,
      ticker: deployment.ticker,
      contractId: exId,
      side,
      size,
      entryOrderId: null,
      entrySubmittedAt: new Date().toISOString(),
      signalBarTs,
      regimeLabel: regime?.label,
      regimeClassifierVersion: regime?.classifierVersion,
      sessionKey,
      tickSize: contract.tickSize,
      tickValue: contract.tickValue,
      desiredEntryPrice,
      desiredTpPrice,
      desiredSlPrice,
      desiredTpTicks: resolvedTp,
      desiredSlTicks: resolvedSl,
      // Pin the merged params + runtime-gate snapshot for replay.
      // Replaying against current deployment params would be dishonest
      // the moment a deployment is edited.
      //
      // The fields after the spread are what the params blob cannot
      // reconstruct, and each is there because something downstream asked
      // the question and could not answer it: the resolved bracket, since
      // the strategy owns `tpTicks` now; the resolved contract count, the
      // account's budget and ceiling, the per-contract loss, and the
      // playbook's applied cap, share and scaled budget, since the count is
      // a function of the account's posture at the instant of entry and the
      // operator is free to change that posture tonight. `tickValue`, the
      // sizer's third input, is already its own column on the row.
      //
      // The phase facts after them answer the next question a review asks —
      // why *that* budget. `maxRiskPerTradeUsd` is the account's budget for
      // the session, before the playbook's share; `playbookBudgetUsd` is what
      // the sizer divided. The applied keys are named apart from the two
      // settings so the spread's stored values survive for replay and parity.
      paramSnapshot: {
        ...(params as unknown as Record<string, unknown>),
        size,
        slTicks: resolvedSl,
        tpTicks: resolvedTp,
        maxRiskPerTradeUsd: risk.maxRiskPerTradeUsd,
        maxContracts: risk.maxContracts,
        riskPerContractUsd: risk.riskPerContractUsd,
        appliedPlaybookMaxContracts: risk.appliedPlaybookMaxContracts,
        appliedPlaybookRiskPercent: risk.appliedPlaybookRiskPercent,
        playbookBudgetUsd: risk.playbookBudgetUsd,
        riskPhase: risk.phase,
        riskBasis: risk.basis,
        headroomUsd: risk.headroomUsd,
        floorUsd: risk.floorUsd,
        eodCloseUsd: risk.closeUsd,
        eodPeakUsd: risk.peakUsd,
        sizesSessionStart: risk.sizesSessionStart,
      },
      filterSnapshot: filterSnapshot ?? undefined,
      engineSessionId,
      deploymentVersionId,
    });
  } catch (err) {
    deps.releaseContractLock(deployment.accountId, exId, deployment.id);
    deps.logEvent(
      "entry_insert_failed",
      deployment.id,
      `Pre-placeOrder DB insert failed: ${err instanceof Error ? err.message : String(err)} — order not submitted`,
      { accountId: deployment.accountId, contractId: exId },
    );
    return { tradeId: null, preEntryOrderIds, slCurrentPrice: null };
  }
  // Upgrade the lock entry with the now-known tradeId so the reconciler
  // can correlate later (useful for debug snapshots via getContractLocks).
  deps.acquireContractLock(deployment.accountId, exId, deployment.id, tradeId);
  // Open the Layer 1 buffer slot BEFORE the user-hub fill event for
  // this entry can arrive — closes the cold-start race window where
  // a sub-second fill would land before slot creation. Idempotent
  // with the opportunistic-open path inside appendBufferedFill.
  deps.openBufferSlot(deployment.accountId, exId, tradeId);

  let result;
  try {
    result = await deps.brokerFor(deployment).placeOrder(order);
  } catch (err) {
    // Broker rejected the order — mark the pre-inserted row failed and
    // release the lock so another deployment can take the contract next
    // bar. Without this, a rejected entry would block the contract
    // indefinitely AND leave a phantom pending_entry row that the
    // stale-sweep would never catch (entry_order_id is null).
    markEntryFailed(tradeId, "place_order_rejected");
    deps.releaseContractLock(deployment.accountId, exId, deployment.id);
    deps.logEvent(
      "entry_order_rejected",
      deployment.id,
      `Entry order rejected: ${err instanceof Error ? err.message : String(err)} (${sideLabel} ${size} ${deployment.ticker})`,
      { accountId: deployment.accountId, contractId: exId, tradeId },
    );
    // AccountNotFound / Tradovate AccountNotActive / Tradovate captcha —
    // the account is unusable. Auto-pause every deployment on it so we
    // don't keep hammering a dead/locked account on subsequent signals.
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
    deps.noteEntryRejected(err, deployment.accountId);
    throw err; // Signal to caller that no position was opened.
  }
  setEntryOrderId(tradeId, result.orderId);
  deps.logEvent("entry_order_placed", deployment.id, `Entry order placed: #${result.orderId}`, {
    accountId: deployment.accountId,
    contractId: exId,
    tradeId,
  });

  // Fast-path bracket attribution, for a broker whose place response
  // carries the bracket leg ids (Tradovate's `/order/placeOSO`, surfaced
  // via PlaceOrderResponse.tp/slOrderId by the adapter). Stamp them onto
  // the trade row immediately so Layer 1 `isClosingFill` can match the
  // closing-fill orderId without depending on the user-hub position
  // event — that broker emits a single position event on entry and
  // nothing until close, so the prior position-event-driven retry only
  // ever got one shot, and that shot routinely fired before placeOrder
  // returned (trade #29 confirmed live). A `"reconciler"` broker returns
  // no bracket ids; attribution there stays on the REST reconciler's
  // `attributeBrackets` path and is unaffected here.
  const attribution =
    deps.pluginFor(deps.brokerKindFor(deployment.accountId)).capabilities.bracketAttribution;
  let slCurrentPrice: number | null = null;
  if (attribution === "sync") {
    const tpOrderId = result.tpOrderId ?? null;
    const slOrderId = result.slOrderId ?? null;
    if (tpOrderId != null || slOrderId != null) {
      setBracketOrderIds(tradeId, tpOrderId, slOrderId);
      deps.logEvent(
        "bracket_ids_attributed",
        deployment.id,
        `Trade #${tradeId} brackets attributed (placeOrder fast-path): TP=${tpOrderId ?? "?"} SL=${slOrderId ?? "?"}`,
        { accountId: deployment.accountId, contractId: exId, tradeId },
      );
    }
    // The ids stamped, the reconciler never runs `attributeBrackets`, the
    // other seed of the stop mirror — and Tradovate's `/order/list` likely
    // carries no `stopPrice` (it sits on the order version). The OSO leg rests
    // where this request put it, so that price is the mirror; without it the
    // no-loosen guard has no reference and refuses every break-even and trail.
    if (slOrderId != null) slCurrentPrice = desiredSlPrice;
  }

  return { tradeId, preEntryOrderIds, slCurrentPrice };
}
