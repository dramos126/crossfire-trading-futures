// Exit orchestration cluster extracted from engine.ts. Every order action
// here (cancel brackets, place market exit, force-close on bracket failure)
// routes through `deps.brokerFor`, which resolves the per-account `Broker`
// via the BrokerRegistry — that registry is the broker seam for exits.
// Adding a new broker = register a `BrokerPlugin` in `@/lib/brokers/registry`;
// no changes needed in this file.

import type { Broker } from "../broker-access/broker";
import { executionContractId } from "../broker-access/contract-resolver";
import { BrokerOrderRole } from "../orders/order-role";
import { EntryExitCode } from "../orders/entry-exit-codes";
import { attachPendingExit, getOpenTradeForDeployment } from "@/lib/db/trades";
import { getStrategy } from "../strategies";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type {
  Contract,
  OrderSide,
  PlaceOrderRequest,
  Position,
} from "@/lib/brokers/types";
import { POSITION_TYPE_LONG } from "@/lib/brokers/types";
import { productRootFromContractId } from "../broker-access/contract-pairing";
import { LIVE_ORDER_STATUSES, closingSideOfPosition, isLiveProtectiveLeg } from "./engine-exit-legs";
import { isFailedPreEntrySnapshot } from "./engine-order";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { DeploymentState, LogSubject } from "./engine";
import { exitReasonActivity, resolveExitReason } from "@/lib/logging/exit-reasons";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import type { OpenPosition, StrategyModule } from "../strategy-types";
import { trackOrderRequest } from "@/lib/shutdown-drain";

/**
 * Engine-internal surface used by the exit-orchestration helpers. Mirrors
 * the {@link import("./engine-order").PlaceEntryOrderDeps} pattern: the new
 * module calls private engine methods through bound callbacks rather than
 * flipping access modifiers. `brokerFor` is the broker-routing seam — every
 * order/cancel/position lookup in this module funnels through it.
 */
/**
 * What the caller of `placeExitOrder` was doing. Read only by
 * `verifyExitClean`, and only to decide what its post-exit line *says* —
 * no predicate, no order action and no cancel scope branches on it.
 *
 * It exists because the two callers that reach the sweep's no-evidence arm
 * are not the same situation and were being told apart by nothing. A D-2
 * close has no trade row **by construction** — that is its defining
 * predicate — so it arrives with no `activeTradeId`, and the engine placed
 * no entry, so there is no order snapshot either. Both operands of
 * `hasOwnershipEvidence` are therefore false on every single D-2 close, and
 * the warn was guaranteed rather than exceptional ([bugs.md](../../../../docs/bugs.md), A49).
 * A genuine engine exit reaching the same arm has *lost* something it
 * should have had, which is the case the warn was written for.
 */
export type ExitIntent = "engine_exit" | "unmanaged_position";

/**
 * What the pre-exit cancel pass could prove, threaded to the one line that
 * makes a claim about it.
 *
 * `cancelTrackedBrackets` is best-effort by design — a thrown
 * `searchOpenOrders` leaves it with nothing to cancel and it proceeds, and an
 * individual `cancelOrder` throw is swallowed after a warn — so *"it ran"* and
 * *"the working orders are gone"* are different statements. `degraded` is
 * either of those failures: at least one cancel was not confirmed, so orders
 * may still be resting on the contract the exit is about to flatten.
 *
 * It is deliberately not narrowed by an already-terminal rejection check the
 * way the watchdog's post-flatten cancel is. This value only decides what a
 * line *says*, the failing cancel already printed its own warn, and
 * over-reporting a degrade costs the operator a second look while
 * under-reporting is the unchecked assertion this exists to remove.
 */
export type BracketCancelVerdict = "clean" | "degraded";

export interface ExitOrderDeps {
  brokerFor: (deployment: Deployment) => Broker;
  getState: (deploymentId: string) => DeploymentState;
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
  maybeOrphanFromBrokerError: (err: unknown, accountId: number) => void;
  resolveContract: (ticker: TickerSymbol, accountId: number) => Promise<Contract>;
  notifyForceClose: (
    trade: StrategyTrade,
    entryPrice: number,
    tpError: string,
    slError: string,
    submitted: boolean,
  ) => Promise<void>;
  buildCustomTag: (prefix: "e" | "x" | "s", deploymentId: string) => string;
  /** Read-only handle to the engine's per-deployment state map for
   *  `verifyExitClean`'s preEntryOrderIds lookup. */
  stateMap: Map<string, DeploymentState>;
}

/**
 * How often the `EXIT_FLAT_MISMATCH` warn line repeats for one stranded trade.
 * Same period as the guards' `reportFailure` throttles, for the same reason:
 * the condition is a standing one and the retry cadence is the market's, not
 * the engine's. The escalation to `error` belongs to the guards, which carry a
 * stranded-for-Ns counter.
 */
export const EXIT_FLAT_MISMATCH_WARN_MS = 300_000;

export type BracketRecoveryEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Gate for `recoverFailedBrackets`. Recovery exists for a position that is
 * open and *unprotected*. A trade in `pending_exit` is neither: a market
 * exit is on the wire and has not filled, so the position is already being
 * closed. The exit latch cannot cover this window — its lifetime ends at
 * order submission and this is submission-to-fill.
 *
 * Admitting `pending_exit` made both recovery branches wrong. The retry
 * branch hangs fresh TP/SL on a position about to flatten, racing
 * `verifyExitClean`'s 1.5s sweep. The failure branch reaches
 * `forceCloseAfterBracketFailure` — a second market flatten against a
 * position already being flattened, which flips it.
 *
 * Refusing here leaves nothing uncovered: a post-submit exit rejection is
 * caught by `verifyExitClean`'s residual-position detection and by the 30s
 * naked-position watchdog. Do not restore `pending_exit` as a safety measure.
 *
 * `exitInFlight` is belt-and-braces for the narrower overlap where the exit
 * is mid-submission and the row has not reached `pending_exit` yet.
 */
export function bracketRecoveryEligibility(
  trade: Pick<StrategyTrade, "status" | "exitOrderId"> | null | undefined,
  exitInFlight: boolean,
): BracketRecoveryEligibility {
  if (!trade) return { eligible: false, reason: "trade row missing" };
  if (trade.status === "pending_exit") {
    return {
      eligible: false,
      reason: `exit order #${trade.exitOrderId ?? "unknown"} is submitted and unfilled — position is already being closed, not unprotected`,
    };
  }
  if (trade.status !== "open") {
    return { eligible: false, reason: `trade no longer eligible (status=${trade.status})` };
  }
  if (exitInFlight) {
    return { eligible: false, reason: "an exit is mid-submission for this deployment" };
  }
  return { eligible: true };
}

/**
 * `deps` with its three reporting calls made unable to throw, applied at
 * every exported entry point of this module.
 *
 * `log` and `logEvent` end in the process's `onLog` handler, which nothing
 * guards, and `maybeOrphanFromBrokerError` classifies through the plugin
 * registry. None of the three may change what an exit *did*: a throw after
 * an accepted `placeOrder` reads to every caller as "nothing is on the book"
 * and they retry into a closing position; a throw in a cancel arm aborts the
 * exit after the cover is gone; a throw in a refusal replaces the code the
 * caller branches on; and inside `verifyExitClean` or a `.catch` handler it
 * is an unhandled rejection, which terminates the process. Swallowing loses
 * nothing durable — `emit` has stored the record before `onLog` runs.
 *
 * Each handler's first throw goes to the console, once per process, so one
 * that always throws is not invisible; the log pipe is the thing failing, so
 * it cannot carry the report.
 */
type GuardedHandler = "log" | "logEvent" | "maybeOrphanFromBrokerError";
const reportedHandlerThrows = new Set<GuardedHandler>();

function swallowed(handler: GuardedHandler, err: unknown): void {
  if (reportedHandlerThrows.has(handler)) return;
  reportedHandlerThrows.add(handler);
  console.error(`[engine-exit] ${handler} threw; further throws from it are swallowed silently:`, err);
}

function withReportingGuarded(deps: ExitOrderDeps): ExitOrderDeps {
  return {
    ...deps,
    log: (...args) => {
      try { deps.log(...args); } catch (err) { swallowed("log", err); }
    },
    logEvent: (...args) => {
      try { deps.logEvent(...args); } catch (err) { swallowed("logEvent", err); }
    },
    maybeOrphanFromBrokerError: (err, accountId) => {
      try { deps.maybeOrphanFromBrokerError(err, accountId); } catch (e) { swallowed("maybeOrphanFromBrokerError", e); }
    },
  };
}

/** `notifyForceClose` is void-dispatched; its rejection must be handled. */
function dispatchForceCloseAlert(
  deps: ExitOrderDeps,
  ...args: Parameters<ExitOrderDeps["notifyForceClose"]>
): void {
  void deps.notifyForceClose(...args).catch((err: unknown) => {
    deps.log(
      args[0].deploymentId,
      "warn",
      "system",
      `Force-close alert for trade #${args[0].id} failed to send: ${err instanceof Error ? err.message : String(err)}`,
      { tradeId: args[0].id },
    );
  });
}

export async function placeExitOrder(
  rawDeps: ExitOrderDeps,
  strategy: StrategyModule,
  deployment: Deployment,
  contract: Contract,
  position: OpenPosition,
  activeTradeId: number | null,
  reason: string,
  /** Declared by the caller, never inferred here — see {@link ExitIntent}. */
  intent: ExitIntent = "engine_exit",
): Promise<void> {
  // Per-deployment in-flight latch. Quote-tick handler is fire-and-forget,
  // so a tick storm can dispatch N concurrent exits that all read
  // `deplState.position` as still-set, all sail past the broker-flat guard
  // below before any of them places, and all fire flatten orders against a
  // book that's already flat — turning subsequent fires into phantom naked
  // entries opposite the original side. (Observed 2026-04-29 09:00:00:
  // session-close tick storm against a 1-lot NQ long produced a 4-lot
  // naked short.)
  //
  // Latch is set synchronously BEFORE the first await so the second
  // concurrent caller bails before it can race past the guard. Cleared in
  // `finally` so a thrown exit (rejected order, network blip) doesn't
  // permanently lock out future retries.
  const deps = withReportingGuarded(rawDeps);
  const deplState = deps.getState(deployment.id);
  if (deplState.exitInFlight) {
    deps.logEvent(
      "exit_skipped_in_flight",
      deployment.id,
      `Exit skipped (${reason}): another exit already in flight for this deployment`,
      { accountId: deployment.accountId, tradeId: activeTradeId },
    );
    throw new Error(EntryExitCode.EXIT_IN_FLIGHT);
  }
  deplState.exitInFlight = true;
  deplState.exitLatchHolder = { reason, takenAt: Date.now(), pastWindowBarCloses: 0 };
  try {
    // The exit cancels the brackets before its market order: a SIGTERM's
    // exit cutting between the two leaves a position with no stop.
    await trackOrderRequest(() =>
      placeExitOrderInner(deps, strategy, deployment, contract, position, activeTradeId, reason, intent),
    );
  } finally {
    deplState.exitInFlight = false;
    deplState.exitLatchHolder = null;
  }
}

/**
 * How many past-window bar closes may find the exit latch held before the
 * skip is said at `error`. One is the ordinary race: the tick path or the clock
 * guard took the latch for this same session-end close, and the bar-close
 * force-exit landed while that submission was on the wire, which takes
 * seconds. A second bar close is at least a whole bar later — no healthy
 * submission is still in flight then, so the holder is stuck and the position
 * is past its session end with nothing able to close it (Mechanism A of the
 * session-end bug, bugs.md).
 */
export const EXIT_LATCH_PAST_WINDOW_BAR_CLOSES_TOLERATED = 1;

/**
 * The bar-close force-exit found the latch held with the window shut. Counted
 * per hold, said once per hold at `error` when the count passes the tolerance;
 * the skip's own `info` line already covers the first.
 */
export function noteExitLatchHeldPastWindow(
  rawDeps: ExitOrderDeps,
  deployment: Deployment,
  activeTradeId: number | null,
): void {
  const deps = withReportingGuarded(rawDeps);
  const holder = deps.getState(deployment.id).exitLatchHolder;
  if (!holder) return;
  holder.pastWindowBarCloses++;
  if (holder.pastWindowBarCloses !== EXIT_LATCH_PAST_WINDOW_BAR_CLOSES_TOLERATED + 1) return;
  const heldSeconds = Math.floor((Date.now() - holder.takenAt) / 1000);
  deps.log(
    deployment.id,
    "error",
    "safety",
    `Session-end close blocked: an earlier exit (${holder.reason}) took this deployment's exit lock ${heldSeconds}s ago and has not finished, ` +
      `so the close has been skipped on ${holder.pastWindowBarCloses} bar closes past the session window. ` +
      "The engine still holds the position as open; check the broker and close it by hand if it is.",
    { accountId: deployment.accountId, tradeId: activeTradeId },
  );
}

async function placeExitOrderInner(
  deps: ExitOrderDeps,
  strategy: StrategyModule,
  deployment: Deployment,
  contract: Contract,
  position: OpenPosition,
  activeTradeId: number | null,
  reason: string,
  intent: ExitIntent,
): Promise<void> {
  const exId = executionContractId(contract);
  const closingSide: OrderSide = position.side === 0 ? 1 : 0;

  // Post-entry, broker position is the ONLY source of truth for size.
  // Strategy/params describe intent; once we hold a position, they're
  // irrelevant — what matters is exactly what Topstep has on the books.
  // This serves two purposes simultaneously:
  //   - Size: flatten exactly what's open. Param-overridden sizes and
  //     partial fills mean strategy.config.size can disagree with reality.
  //   - Aliveness: evaluateRealtimeExits is fire-and-forget on every quote
  //     tick. When the session-close burst dispatches N concurrent exits,
  //     the first one's fill leaves the broker flat; subsequent fires read
  //     no livePos here and bail. Prior bug: 6 concurrent size-1 sells
  //     against a 3-lot long flipped the deployment short.
  // On lookup failure we throw — caller retries on next tick. Falling back
  // to a strategy-derived size would re-introduce the over-sell bug.
  const readPositions = async (): Promise<Position[]> => {
    try {
      return await deps.brokerFor(deployment).searchOpenPositions(deployment.accountId);
    } catch (err) {
      deps.maybeOrphanFromBrokerError(err, deployment.accountId);
      throw err;
    }
  };
  const liveOn = (positions: Position[], contractId: string) =>
    positions.find((p) => p.contractId === contractId && p.size > 0);

  // Already flat is usually legitimate — a tick-driven exit that fired a
  // moment ago leaves exactly this, with its row at `pending_exit` until
  // the fill resolves. The one shape that is not legitimate is the broker
  // saying flat while the engine still holds an `open` row for this
  // deployment: on 2026-08-26 an exit resolved the *other* broker's
  // contract, asked about a contract the account never held, and returned
  // normally — so the caller nulled the position mirror over an exit that
  // placed nothing, and every clock-driven guard gates on that mirror.
  // Throwing is what stops the caller recording a completed exit; it does
  // not re-attempt anything, and the next pass re-reads the broker before
  // it could place. Same-contract scoping would miss the incident exactly:
  // there, `exId` was the contract the engine had no row for.
  const cancelBracketsOnFlatBook = async (openTrade: StrategyTrade): Promise<void> => {
    // The legs rest on the row's month, which on a flip day is not `exId`.
    const rowContract: Contract = openTrade.contractId === exId
      ? contract
      : { ...contract, id: openTrade.contractId, executionContractId: openTrade.contractId };
    // The row's legs close the row's side; `position` may be a hand position
    // the hand-position close passed.
    const rowClosingSide: OrderSide = openTrade.side === 0 ? 1 : 0;
    const verdict = await cancelTrackedBrackets(deps, deployment, rowContract, openTrade.id, rowClosingSide);
    deps.log(
      deployment.id,
      verdict === "clean" ? "info" : "warn",
      "order",
      verdict === "clean"
        ? `Trade #${openTrade.id}: the broker is flat on ${openTrade.contractId} too, so its resting brackets covered nothing and were cancelled`
        : `Trade #${openTrade.id}: the broker is flat on ${openTrade.contractId} too, and cancelling its resting brackets was not confirmed (see the warning above) — they may still be working against a flat book`,
      { accountId: deployment.accountId, contractId: openTrade.contractId, tradeId: openTrade.id },
    );
  };

  /** `positions` is the read that found `exId` flat, passed only from the
   *  read *before* the cancel; the one after it has nothing left to cancel. */
  const refuseFlat = async (positions: Position[] | null): Promise<void> => {
    const openTrade = getOpenTradeForDeployment(deployment.id);
    if (openTrade?.status === "open") {
      // The line is throttled per (deployment, trade); the throw never is.
      // Reaching this state is routine — any exogenous exit (a TP/SL fill, a
      // hand flatten) leaves an `open` row against a flat broker for the
      // reconcile gap — and `evaluateRealtimeExits` re-enters on every price
      // change, so an unthrottled line puts tens of identical warnings into
      // the ring buffer per stranded leg. Throttling here covers every catch
      // arm at once. A smoke alarm that cries wolf every tick is one nobody
      // reads on the day it matters.
      const state = deps.getState(deployment.id);
      const nowMs = Date.now();
      const anchor = state.flatMismatchWarnedAt;
      if (anchor === null || anchor.tradeId !== openTrade.id || nowMs - anchor.at >= EXIT_FLAT_MISMATCH_WARN_MS) {
        state.flatMismatchWarnedAt = { tradeId: openTrade.id, at: nowMs };
        deps.logEvent(
          "exit_flat_mismatch",
          deployment.id,
          `Exit skipped (${reason}): broker reports no open position on ${exId}, but trade #${openTrade.id} ` +
            `(${openTrade.contractId}) is still open — nothing was submitted; the position mirror is kept for the next pass`,
          { accountId: deployment.accountId, contractId: exId, tradeId: openTrade.id },
        );
        // A73. Flat on the row's month as well means the trade's legs cover
        // nothing, and on the closing side they are an armed reverse that
        // nothing else sweeps. A position on the row's month is A71's
        // contract flip, and its legs stay. Rides the line's throttle so a
        // stranded trade costs one cancel pass, not one per price change.
        if (positions && !mayHoldRowProduct(positions, openTrade.contractId)) {
          await cancelBracketsOnFlatBook(openTrade);
        }
      }
      throw new Error(EntryExitCode.EXIT_FLAT_MISMATCH);
    }
    deps.logEvent(
      "exit_skipped_already_flat",
      deployment.id,
      `Exit skipped (${reason}): broker reports no open position on ${exId} — already flat`,
      { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
    );
  };

  // The position read comes BEFORE the cancel, deliberately, and this is
  // `attemptForceFlat`'s ordering for the same reason: the refusals below
  // submit nothing, so cancelling first strips the cover off a position this
  // pass then declines to close. The brackets' ids are contract-agnostic and
  // come off the trade row, so on a contract-flip day the cancel would take
  // out the back-month legs and the read would then refuse on the front
  // month — a live position with neither a bracket nor an exit, once per
  // pass (bugs.md A71). `contract` is the caller's and stays the target of
  // the read: the unmanaged-position arm deliberately closes a contract that
  // is not the deployment's own, so inferring it here would aim at the wrong one.
  const firstRead = await readPositions();
  const firstPos = liveOn(firstRead, exId);
  if (!firstPos) {
    await refuseFlat(firstRead);
    return;
  }
  refuseSideMismatch(deps, deployment, exId, firstPos, closingSide, activeTradeId, reason);

  // Cancel the trade's TP/SL brackets BEFORE the market exit. On Topstep,
  // OCO brackets should auto-cancel when the position flattens, but in
  // practice we've seen them linger in the book after rapid exits (test
  // strategy orphan pile). Explicit cancel here prevents the orphan case
  // and narrows the window where a bracket could fill against a
  // different deployment's re-entered position on the same contract.
  //
  // Best-effort: cancel errors are logged but don't block the market
  // exit — an unrecoverable bracket that didn't cancel is less bad than
  // a stuck position that didn't exit. The verdict rides down to
  // `verifyExitClean` because the quiet arm there asserts these orders are
  // gone, and best-effort means it cannot know that without being told.
  const cancelVerdict = await cancelTrackedBrackets(deps, deployment, contract, activeTradeId, closingSide);

  // Re-read after the cancel, as force-flat does: a bracket filling inside
  // those round-trips flattens the book, and the size the order is built
  // from has to be the one read on this side of them.
  const livePos = liveOn(await readPositions(), exId);
  if (!livePos) {
    await refuseFlat(null);
    return;
  }
  refuseSideMismatch(deps, deployment, exId, livePos, closingSide, activeTradeId, reason);
  const exitSize = livePos.size;

  const order: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: exId,
    type: 2, // Market exit
    side: closingSide,
    size: exitSize,
    customTag: deps.buildCustomTag("x", deployment.id),
    // No brackets on a market exit — Tradovate translator only needs
    // tickSize/referencePrice when bracket1/bracket2 must be priced.
    // Provided here for symmetry; harmless for both brokers.
    tickSize: contract.tickSize,
    deploymentId: deployment.id,
    brokerOrderRole: BrokerOrderRole.Exit,
  };

  // The reason reaches the wire twice and deliberately in two forms: the
  // message keeps the submitted code, which is what the diagnostics lane
  // and every grep have always matched on, while the value is the reason
  // table’s plain-language rendering of the same code.
  //
  // `resolveExitReason`'s residual `bracket_manual` arm is unreachable from
  // here, and it matters that it stays that way: its phrasing is "it was
  // closed outside the engine", which is the opposite of what this line —
  // the engine submitting the exit — says one argument earlier. What keeps
  // it unreachable is `exit-reasons.test.ts`, which scans source for every
  // `placeExitOrder` reason argument and fails on any the table does not
  // carry, so a new caller passing an unlisted string is a red test rather
  // than a sentence contradicting its own message.
  const submittedReason = resolveExitReason(reason);
  deps.logEvent(
    "exit_submitted",
    deployment.id,
    `EXIT ${closingSide === 0 ? "BUY" : "SELL"} ${exitSize} ${deployment.ticker} (${reason})`,
    {
      accountId: deployment.accountId,
      contractId: exId,
      tradeId: activeTradeId,
      values: { reason: exitReasonActivity(submittedReason.code, submittedReason.detail) },
    },
  );

  let result;
  try {
    result = await deps.brokerFor(deployment).placeOrder(order);
  } catch (err) {
    deps.logEvent(
      "exit_order_rejected",
      deployment.id,
      `Exit order rejected: ${err instanceof Error ? err.message : String(err)} (${deployment.ticker}, reason=${reason})`,
      { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
    );
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
    throw err; // Keep deplState.position so we retry on the next tick.
  }
  deps.logEvent("exit_order_placed", deployment.id, `Exit order placed: #${result.orderId}`, {
    accountId: deployment.accountId,
    contractId: exId,
    tradeId: activeTradeId,
  });
  // An exit on the wire ends whatever stranding the throttles were suppressing
  // — both this arm's line and the caller's catch-arm line one frame up.
  const throttled = deps.getState(deployment.id);
  throttled.flatMismatchWarnedAt = null;
  throttled.exitDispatchWarnedAt = null;
  throttled.sideMismatchWarnedAt = null;

  if (activeTradeId != null) {
    try {
      attachPendingExit({
        tradeId: activeTradeId,
        exitOrderId: result.orderId,
        exitSubmittedAt: new Date().toISOString(),
        exitReason: reason,
      });
    } catch (err) {
      deps.log(
        deployment.id,
        "warn",
        "system",
        `DB attach failed for exit order #${result.orderId}: ${err instanceof Error ? err.message : String(err)}`,
        { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
      );
    }
  }

  // Post-exit verification — runs in the background so the caller can flip
  // `deplState.position` to null and release the exit-in-flight latch
  // without waiting on the cleanup. Cancels in `cancelTrackedBrackets` are
  // best-effort and the broker can race a working order onto the book
  // between our pre-exit cancel and the market exit landing. This pass
  // catches both of those tails plus residual position size from a
  // partial fill / silent reject.
  //
  // **The `.catch` stays even though `verifyExitClean`'s reporting is
  // guarded**: anything outside its `try` can still reject, and an unhandled
  // rejection terminates the Node process, mid-position, on an engine that
  // runs 24/7. `deps` here is the guarded copy, so the handler cannot throw.
  // Tracked, not awaited: a SIGTERM's exit landing inside the 1.5s sleep
  // skips the sweep that cancels a bracket leg left resting on a flat
  // position, which can fill into an unprotected reverse.
  void trackOrderRequest(() =>
    verifyExitClean(deps, deployment, contract, result.orderId, closingSide, activeTradeId, intent, cancelVerdict),
  ).catch((err: unknown) => {
    deps.log(
      deployment.id,
      "warn",
      "order",
      `Post-exit verification for #${result.orderId} failed to run: ${err instanceof Error ? err.message : String(err)}`,
      { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
    );
  });
}

/**
 * The market side comes from the mirror, which past the window Mechanism B
 * seeds from the trade row; the broker is what the order lands on. A stale
 * long row against a broker short (a hand reverse) would SELL the short's
 * size and double it, so a disagreement refuses, the way force-flat takes
 * its side from the broker. The line rides `EXIT_FLAT_MISMATCH_WARN_MS` per
 * trade; the throw never is throttled.
 */
function refuseSideMismatch(
  deps: ExitOrderDeps,
  deployment: Deployment,
  exId: string,
  live: Position,
  closingSide: OrderSide,
  activeTradeId: number | null,
  reason: string,
): void {
  if (closingSideOfPosition(live) === closingSide) return;
  const state = deps.getState(deployment.id);
  const nowMs = Date.now();
  const anchor = state.sideMismatchWarnedAt ?? null;
  if (anchor === null || anchor.tradeId !== activeTradeId || nowMs - anchor.at >= EXIT_FLAT_MISMATCH_WARN_MS) {
    state.sideMismatchWarnedAt = { tradeId: activeTradeId, at: nowMs };
    const held = live.type === POSITION_TYPE_LONG ? "LONG" : "SHORT";
    const mirrored = closingSide === 1 ? "LONG" : "SHORT";
    deps.log(
      deployment.id,
      "error",
      "safety",
      `Exit refused (${reason})${activeTradeId === null ? "" : ` for trade #${activeTradeId}`}: the broker holds ${held} ${live.size} on ${exId}, ` +
        `but the engine's position is ${mirrored} — closing it would add to the broker's position. Nothing was submitted; check the account by hand.`,
      { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
    );
  }
  throw new Error(EntryExitCode.EXIT_SIDE_MISMATCH);
}

/**
 * Whether a read could be holding a position on the row's product: one on
 * the same root, or one whose root will not parse. A73's cancel needs
 * positive evidence of flat, and absence on an id is not that — Tradovate's
 * position translator answers a stringified numeric contract id until its
 * symbol lookup warms, so a live MNQZ6 long can read back as "4012345" (A71's
 * lesson, in a second place). A row whose own root will not parse proves
 * nothing either.
 */
function mayHoldRowProduct(positions: Position[], rowContractId: string): boolean {
  const rowRoot = productRootFromContractId(rowContractId);
  return positions.some((p) => {
    if (p.size <= 0) return false;
    const root = productRootFromContractId(p.contractId);
    return rowRoot === null || root === null || root === rowRoot;
  });
}

/**
 * Post-exit reconciliation pass. Best-effort — never throws to the caller,
 * never auto-refires the exit. Verifies on (account, contract) that the
 * market exit actually flattened us and that no working orders survived
 * the cancel pass.
 *
 *   - Residual position: log error and let the next tick re-evaluate.
 *     `deplState.position` has already been cleared by the caller; the
 *     engine's normal reconcile will repopulate it from broker state if
 *     truth disagrees.
 *   - Orphan working orders: cancel in parallel. Topstep auto-attaches
 *     OCO bracket children with broker-generated tags that do NOT carry
 *     our customTag, so a customTag-only filter would miss exactly the
 *     orders this safety net exists to clean up. Primary scope is
 *     narrower than `cancelTrackedBrackets` Stage 2's predicate
 *     (contract match + not in preEntryOrderIds): extended here with
 *     status Working or Pending and type ∈ {Limit (1), Stop (4)} on the protective
 *     (closing) side, so we don't accidentally cancel an unrelated
 *     working entry order on this same contract from another deployment.
 *     A secondary customTag branch still catches engine-issued
 *     retry/replacement orders that may not match the type/side filter.
 *
 * `cancelVerdict` has no default on purpose. It is what the unmanaged arm
 * below claims about the working orders, and a default would let a caller
 * assert a cancel it never measured — which is the defect the parameter was
 * added to close.
 */
export async function verifyExitClean(
  rawDeps: ExitOrderDeps,
  deployment: Deployment,
  contract: Contract,
  exitOrderId: number,
  protectiveSide: OrderSide,
  activeTradeId: number | null,
  intent: ExitIntent = "engine_exit",
  cancelVerdict: BracketCancelVerdict,
): Promise<void> {
  const deps = withReportingGuarded(rawDeps);
  const exId = executionContractId(contract);
  try {
    await new Promise((r) => setTimeout(r, 1500));

    const positions = await deps.brokerFor(deployment).searchOpenPositions(deployment.accountId);
    const residual = positions.find((p) => p.contractId === exId && p.size > 0);
    if (residual) {
      // Named event rather than a bare level: this is one of the three the
      // ladder escalates to Discord, and it reached nobody but `/logs`
      // before. The condition is checked — a live broker position read on
      // (account, contract) after the exit should have flattened it.
      deps.logEvent(
        "exit_verification_residual",
        deployment.id,
        `Exit verification: residual position size=${residual.size} detected on (${exId}, ${deployment.accountId}); next tick will retry exit`,
        { accountId: deployment.accountId, contractId: exId },
      );
      return;
    }

    const deplState = deps.stateMap.get(deployment.id);
    const preIds = new Set(deplState?.preEntryOrderIds ?? []);

    const shortId = deployment.id.replace(/-/g, "").slice(0, 8);
    const tagFragment = `_${shortId}_`;

    const openOrders = await deps.brokerFor(deployment).searchOpenOrders(deployment.accountId, { forceFresh: true });

    // Primary: protective-side TP/SL working orders on this contract that
    // weren't in the pre-entry snapshot. Catches broker-attached OCO
    // children which don't carry our customTag. Builds on the
    // `cancelTrackedBrackets` Stage 2 predicate (contract match + not in
    // preEntryOrderIds) and narrows it with status Working or Pending and
    // type ∈ {Limit (1), Stop (4)} on the protective (closing) side so
    // we don't accidentally cancel an unrelated working entry order on
    // this same contract from another deployment.
    //
    // Defense-in-depth gate: when preEntryOrderIds is empty AND we have
    // no activeTradeId, the predicate degrades to "cancel every working
    // TP/SL on the protective side of (account, contract)." That's
    // safe under the one-deployment-per-(account, contract) invariant,
    // but if that invariant ever breaks (manual deploy via two browser
    // tabs, race in deployment registration) we'd nuke an unrelated
    // deployment's brackets. Skip the primary sweep when neither
    // evidence of ownership is present; the customTag secondary branch
    // still runs and is scoped to engine-issued retries.
    const orphanIds = new Set<number>();
    const hasOwnershipEvidence = preIds.size > 0 || activeTradeId != null;
    if (hasOwnershipEvidence) {
      for (const o of openOrders) {
        if (preIds.has(o.id)) continue;
        if (!isLiveProtectiveLeg(o, exId, protectiveSide)) continue;
        orphanIds.add(o.id);
      }
    } else if (intent === "unmanaged_position") {
      // A49. The gate above is definitionally false here — this close acts
      // only where the engine holds no trade row, so there is no active
      // trade id and it placed no entry, so there is no snapshot. The warn
      // was firing on every force-close of a hand position, one line per
      // leg, directly under a trade line saying the contract's working
      // orders had been cancelled first. An operator reading the pair was
      // told protection was both handled and not handled.
      //
      // **The gate itself does not widen**, which is the wrong fix named in
      // the bug entry: without ownership evidence the sweep cannot tell an
      // orphaned engine bracket from an operator's own resting order, and
      // cancelling on a guess is the failure the guard exists to prevent.
      // What changes is the claim.
      //
      // The claim splits again on what the pre-exit cancel could prove.
      // `cancelTrackedBrackets` is best-effort — on a D-2 close
      // `activeTradeId` is null, so Stage 2 *is* the whole cancel, and a
      // thrown `searchOpenOrders` leaves it with nothing to cancel and it
      // proceeds. Asserting the orders were cancelled on that path is the
      // same unchecked claim, one layer down.
      const cancelled = cancelVerdict === "clean"
        ? "Its working orders were cancelled before the exit and the engine-tag branch still runs."
        : "The pre-exit cancel pass reported a failure (see the warning above), so working orders may still be resting; the engine-tag branch still runs.";
      deps.logEvent(
        "unmanaged_exit_verified",
        deployment.id,
        `Post-exit check on ${exId}: no primary sweep, because the engine holds no trade row for this position — that is what makes it an unmanaged close. ${cancelled}`,
        { accountId: deployment.accountId, contractId: exId },
      );
    } else {
      deps.logEvent(
        "exit_verify_no_evidence",
        deployment.id,
        `verifyExitClean: primary sweep skipped — no entry-order snapshot or active trade id (snapshot may have been cleared post-attribution); customTag branch still runs`,
        { accountId: deployment.accountId, contractId: exId },
      );
    }

    // Secondary: engine-issued orders matched by customTag shortId (e.g.
    // retry/replacement brackets with `rt_`/`rs_` prefixes) that don't
    // fit the type/side filter above. preEntryOrderIds still excluded
    // so a stale snapshot can't cause us to cancel pre-existing orders.
    for (const o of openOrders) {
      if (o.contractId !== exId) continue;
      if (!LIVE_ORDER_STATUSES.has(o.status)) continue;
      if (preIds.has(o.id)) continue;
      if (orphanIds.has(o.id)) continue;
      if (typeof o.customTag !== "string") continue;
      if (!o.customTag.includes(tagFragment)) continue;
      orphanIds.add(o.id);
    }

    if (orphanIds.size === 0) return;

    const orphans = openOrders.filter((o) => orphanIds.has(o.id));
    await Promise.all(
      orphans.map(async (order) => {
        try {
          await deps.brokerFor(deployment).cancelOrder(order.id, deployment.accountId);
          deps.logEvent(
            "orphan_order_cancelled",
            deployment.id,
            `Orphan recovery: cancelled #${order.id} type=${order.type} side=${order.side} (post-exit cleanup)`,
            { accountId: deployment.accountId, contractId: exId },
          );
        } catch (err) {
          deps.logEvent(
            "bracket_cancel_failed",
            deployment.id,
            `Cancel bracket #${order.id} failed: ${err instanceof Error ? err.message : String(err)}`,
            { accountId: deployment.accountId, contractId: exId },
          );
          deps.maybeOrphanFromBrokerError(err, deployment.accountId);
        }
      }),
    );
  } catch (err) {
    deps.logEvent(
      "exit_verify_failed",
      deployment.id,
      `Exit verification (#${exitOrderId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      { accountId: deployment.accountId, contractId: exId },
    );
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
  }
}

/**
 * Cancel the TP/SL brackets Topstep attached to this trade so they don't
 * orphan in the book after the upcoming market exit flattens the position.
 *
 * Two-stage strategy:
 *   1. Preferred — use the attributed `tpOrderId`/`slOrderId` on the
 *      trade row. Populated by the reconciler after entry fills.
 *   2. Fallback — if bracket ids aren't attributed yet (fast reversal
 *      before the reconciler ran, or DB row missing), fetch open orders
 *      on (account, contract) and cancel anything that wasn't in the
 *      pre-entry snapshot — narrowed to protective-side legs when an
 *      engine trade has no snapshot to diff against (A11).
 *
 * Entirely best-effort — a failed cancel logs a warning but does not
 * abort the exit. A stuck bracket is less harmful than a stuck position.
 * **That is why it returns a verdict rather than nothing.** Best-effort
 * means "it ran" and "the orders are gone" are different statements, and
 * `verifyExitClean`'s unmanaged arm makes the second one out loud.
 */
export async function cancelTrackedBrackets(
  rawDeps: ExitOrderDeps,
  deployment: Deployment,
  contract: Contract,
  activeTradeId: number | null,
  /** The side the position closes on, which is the side its legs rest on. */
  protectiveSide: OrderSide,
): Promise<BracketCancelVerdict> {
  const deps = withReportingGuarded(rawDeps);
  let verdict: BracketCancelVerdict = "clean";
  const exId = executionContractId(contract);
  // Stage 1: known bracket ids on the trade row.
  const trade = activeTradeId != null
    ? getOpenTradeForDeployment(deployment.id)
    : null;
  const idsToCancel = new Set<number>();
  if (trade?.id === activeTradeId) {
    if (trade.tpOrderId != null) idsToCancel.add(trade.tpOrderId);
    if (trade.slOrderId != null) idsToCancel.add(trade.slOrderId);
  }

  // Stage 2: fallback to open-order diff when attribution is missing.
  // This catches the "reversed before reconciler ran" case — common in
  // fast test strategies and the reason we saw orphan piles.
  if (idsToCancel.size === 0) {
    const snapshot = deps.stateMap.get(deployment.id)?.preEntryOrderIds ?? null;
    const preIds = new Set(snapshot ?? []);
    // A11. An engine trade with no snapshot left (attribution released it, a
    // restart lost it) has nothing to exclude, so the bare diff took every
    // working order on the contract. Narrowed to `verifyExitClean`'s primary
    // predicate, which runs on this same evidence 1.5 s later anyway. With no
    // trade row the whole contract stays in scope: that is the hand-position
    // close's and force-flat's close of a position sized to the whole contract.
    // A snapshot whose read failed is as empty as a missing one (A119).
    const protectiveOnly =
      (snapshot === null || isFailedPreEntrySnapshot(snapshot)) && activeTradeId != null;
    try {
      const openOrders = await deps.brokerFor(deployment).searchOpenOrders(deployment.accountId);
      for (const order of openOrders) {
        if (order.contractId !== exId) continue;
        if (preIds.has(order.id)) continue;
        if (protectiveOnly && !isLiveProtectiveLeg(order, exId, protectiveSide)) continue;
        idsToCancel.add(order.id);
      }
    } catch (err) {
      // Nothing was cancelled and nothing will be — `idsToCancel` is still
      // empty below, so the pass ends silently. On a D-2 close this arm is
      // the whole cancel.
      verdict = "degraded";
      deps.log(
        deployment.id,
        "warn",
        "order",
        `Bracket-cancel lookup failed: ${err instanceof Error ? err.message : String(err)} — proceeding to market exit; brackets may orphan`,
        { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
      );
      deps.maybeOrphanFromBrokerError(err, deployment.accountId);
    }
  }

  if (idsToCancel.size === 0) return verdict;

  // Parallelize cancellations — they're independent and the exit below
  // wants to hit the wire as soon as possible.
  await Promise.all(
    Array.from(idsToCancel).map(async (orderId) => {
      try {
        await deps.brokerFor(deployment).cancelOrder(orderId, deployment.accountId);
      } catch (err) {
        // Already-filled or already-cancelled brackets return an error
        // here; swallow. Only the first log tells us something useful.
        // Swallowed for control flow, not for the verdict: an unconfirmed
        // cancel is exactly what the caller's claim must not paper over.
        verdict = "degraded";
        deps.logEvent(
          "bracket_cancel_failed",
          deployment.id,
          `Cancel bracket #${orderId} failed: ${err instanceof Error ? err.message : String(err)}`,
          { accountId: deployment.accountId, contractId: exId, tradeId: activeTradeId },
        );
        deps.maybeOrphanFromBrokerError(err, deployment.accountId);
      }
    }),
  );
  return verdict;
}

/**
 * Final safety net: bracket retry failed (or pre-conditions made retry
 * impossible). Flatten the position via market order with a distinct
 * exit reason and fire a high-visibility Discord alert. The standard
 * notifyExit path still fires when the close is reconciled, providing
 * the final fill price + PnL.
 */
export async function forceCloseAfterBracketFailure(
  rawDeps: ExitOrderDeps,
  trade: StrategyTrade,
  deployment: Deployment,
  entryPrice: number,
  tpError: string,
  slError: string,
): Promise<void> {
  const deps = withReportingGuarded(rawDeps);
  let contract: Contract;
  try {
    contract = await deps.resolveContract(deployment.ticker, deployment.accountId);
  } catch (err) {
    deps.logEvent(
      "force_close_failed",
      trade.deploymentId,
      `[ERROR] Trade #${trade.id} bracket retry FAILED — force-close ALSO failed: contract resolve error: ${err instanceof Error ? err.message : String(err)}. TP error: ${tpError}. SL error: ${slError}. POSITION REMAINS UNPROTECTED.`,
      { accountId: deployment.accountId, tradeId: trade.id },
    );
    dispatchForceCloseAlert(deps, trade, entryPrice, tpError, slError, /*submitted*/ false);
    return;
  }

  const livePosition: OpenPosition = {
    side: trade.side,
    entryPrice,
    entryTimestamp: trade.entrySubmittedAt,
    barsSinceEntry: 0,
    entryFilledAt: trade.entryFilledAt,
    size: trade.size,
    slTicks: trade.desiredSlTicks,
  };

  const strategy = getStrategy(trade.strategyKey);
  if (!strategy) {
    deps.logEvent(
      "force_close_failed",
      trade.deploymentId,
      `[ERROR] Trade #${trade.id} bracket retry FAILED — force-close ALSO failed: strategy ${trade.strategyKey} not registered. TP error: ${tpError}. SL error: ${slError}. POSITION REMAINS UNPROTECTED.`,
      { accountId: deployment.accountId, contractId: executionContractId(contract), tradeId: trade.id },
    );
    dispatchForceCloseAlert(deps, trade, entryPrice, tpError, slError, /*submitted*/ false);
    return;
  }

  deps.logEvent(
    "bracket_place_failed",
    trade.deploymentId,
    `Trade #${trade.id} bracket retry FAILED — force-closing position to prevent unprotected exposure. TP error: ${tpError}. SL error: ${slError}.`,
    { accountId: deployment.accountId, contractId: executionContractId(contract), tradeId: trade.id },
  );

  // Hoisted because two arms need it: the exit that landed, and the exit that
  // found the book already flat. In both, the position this state mirrors is
  // gone, and leaving the mirror set feeds the session guard a live-looking
  // position over a flat book.
  const clearPositionMirror = (): void => {
    const state = deps.stateMap.get(trade.deploymentId);
    if (!state || state.activeTradeId !== trade.id) return;
    state.position = null;
    state.breakEvenMoved = false;
    state.activeTpTicks = null;
    state.activeSlTicks = null;
    state.slMovedToBe = false;
    state.slCurrentPrice = null;
    state.tpCurrentPrice = null;
    state.cooldownAnchorAt = new Date().toISOString();
  };

  let submitted = true;
  try {
    await placeExitOrder(
      deps,
      strategy,
      deployment,
      contract,
      livePosition,
      trade.id,
      "bracket_failure_force_close",
    );
    clearPositionMirror();
  } catch (err) {
    // `exit_in_flight` from placeExitOrder's per-deployment latch means
    // another exit is already in flight for this deployment — the latch
    // does its job, we just need to wait one tick. Promoting that to an
    // [ERROR] "POSITION REMAINS UNPROTECTED" with a Discord force-close
    // alert is a false alarm; nothing is wrong, the retry happens next
    // reconciler tick. String-match here is safe: the throw site is the
    // only producer of that message.
    if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
      deps.logEvent(
        "force_close_deferred",
        trade.deploymentId,
        `Trade #${trade.id} force-close deferred — another exit already in flight; will retry next reconciler tick.`,
        { accountId: deployment.accountId, contractId: executionContractId(contract), tradeId: trade.id },
      );
      return;
    }
    // `exit_flat_mismatch` means the broker reported flat on the contract this
    // force-close resolved. `recoverFailedBrackets` checked the position and
    // then spent up to four broker round-trips getting here, so a lingering
    // bracket filling or an operator flattening inside that window lands
    // exactly here — and both claims the generic arm makes below would be
    // false. The book is not unprotected, and nothing will retry: this path is
    // reachable only from `attributeBrackets`, whose `preEntryOrderIds`
    // snapshot has already been released. The mirror teardown sits inside the
    // `try`, so without this arm it is skipped too and the session guard is
    // handed a live-looking position over a flat book every 15s.
    if (err instanceof Error && err.message === EntryExitCode.EXIT_FLAT_MISMATCH) {
      clearPositionMirror();
      deps.logEvent(
        "force_close_not_needed",
        trade.deploymentId,
        `Trade #${trade.id} force-close not needed — the broker reports flat on ${deployment.ticker}; the position closed during the bracket-recovery round-trips. Nothing was submitted and the trade row is left to the reconciler.`,
        { accountId: deployment.accountId, contractId: executionContractId(contract), tradeId: trade.id },
      );
      return;
    }
    submitted = false;
    deps.logEvent(
      "force_close_failed",
      trade.deploymentId,
      `[ERROR] Trade #${trade.id} force-close exit submission failed: ${err instanceof Error ? err.message : String(err)} — POSITION REMAINS UNPROTECTED, will retry on next reconciler tick.`,
      { accountId: deployment.accountId, contractId: executionContractId(contract), tradeId: trade.id },
    );
  }

  dispatchForceCloseAlert(deps, trade, entryPrice, tpError, slError, submitted);
}
