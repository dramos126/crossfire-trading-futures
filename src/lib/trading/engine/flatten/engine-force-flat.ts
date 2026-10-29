// The per-deployment force flatten: close this one deployment's position
// now, report what happened, change nothing else.
//
// It is a **primitive for one deployment**. It knows nothing about groups,
// legs or cascades — a caller flattening N of them collects N results, and
// that is the only composition this module owes. Do not grow a multi-leg
// entry point here; the deployment model changes shape and any group logic
// written now is written twice.
//
// Three rules it inherits from `flatten-all`, all of them already recorded
// in deployments.md rather than decided here:
//
//   1. It reaches `Broker.placeOrder` directly rather than going through
//      `placeExitOrder`, so the per-deployment exit latch cannot refuse it —
//      the same bypass the naked-position watchdog carries, and for the same
//      reason. It **reports** an in-flight engine exit and never defers to
//      one. Do not promote that read to a gate, a 409 or a deferral.
//   2. It is never screened by the live-account block. Refusing to *close* a
//      live position inverts the rule the block exists to serve, which is
//      also why `listManagedDeployments()` exempts a closing row. The row is
//      read straight from the database for this reason: a live-account
//      deployment the engine is withholding is still flattenable.
//   3. It stamps a typed `ExitReasonCode`, never a label string.
//
// **Semantics are attempt-then-report, and there is no rollback**, which is
// the answer to the question the punchlist carried from deployment-groups
// v1 (*leg 1 closes, leg 2 rejects, leg 3 closes — what now?*). A closed
// position cannot be re-opened, so all-or-nothing is unavailable at any
// price and the shape of the answer is a per-deployment outcome rather than
// a transaction. Nothing here throws: a caller collecting N results must not
// lose N−1 of them to one failure.
//
// **That "nothing throws" is held structurally rather than arm by arm**, and
// it has to be: `brokerForAccount` throws for an account the registry lost —
// which is the orphaned row this path exists to be able to reach —
// `getDeployment` and `getOpenTradeForDeployment` are `better-sqlite3` reads
// that throw on `SQLITE_BUSY`, `maybeOrphanFromBrokerError` is called from
// inside catch arms, and `logEvent` reaches a database-backed display cache.
// An arm added later will reach something else again. So the whole body sits
// inside one catch that returns an `error` result, and the property cannot
// rot as arms are added.
//
// **Two callers, and one of them is timed.** The board's flatten is a press;
// the closing guard calls it every 15s for a closing row whose playbook this
// build does not register. `ForceFlatOptions.caller` says which, and decides
// who reports a failure and what a stand-down promises.
//
// **It does not touch deployment status.** Not a pause, not a destroy —
// `Active` stays `Active` and the deployment may take a fresh entry on a
// later signal, exactly as `flatten-all` leaves it.

import type { Broker } from "../../broker-access/broker";
import type { Contract, OrderSide, PlaceOrderRequest, Position } from "@/lib/brokers/types";
import { POSITION_TYPE_LONG } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import type { LogSubject, DeploymentState } from "../engine";
import type { BracketCancelVerdict } from "../engine-exit";
import type { FlattenActor, FlattenCooldown, FlattenStamp } from "../engine-flatten-cooldown";
import { FLATTEN_COOLDOWN_MS } from "../engine-flatten-cooldown";
import { executionContractId } from "../../broker-access/contract-resolver";
import { attachPendingExit, getOpenTradeForDeployment } from "@/lib/db/trades";
import { BrokerOrderRole } from "../../orders/order-role";
import { trackOrderRequest } from "@/lib/shutdown-drain";

const ORDER_SIDE_BUY: OrderSide = 0;
const ORDER_SIDE_SELL: OrderSide = 1;
const ORDER_TYPE_MARKET = 2;

/** The exit reason stamped on a trade this primitive closes. A *code*, not
 *  a label — writing `"Flatten All"` into this slot is the fixed bug that
 *  relabelled every panic close to the residual `bracket_manual`. Its own
 *  code rather than a reuse of `flatten_all`, so one deployment's flatten
 *  stays distinguishable from the global one. */
export const FLATTEN_DEPLOYMENT_EXIT_REASON: ExitReasonCode = "flatten_deployment";

/**
 * What one attempt did.
 *
 *  - `closed` — a market exit is on the wire. Not *filled*: like every other
 *    exit in this engine, flat is confirmed later by the socket or the
 *    reconciler.
 *  - `already_flat` — the broker holds nothing on this deployment's
 *    contract, so there was nothing to close and nothing was touched.
 *  - `deferred` — a flatten actor's market order against the same
 *    `(account, contract)` may still be unbooked. Doubling it is a naked
 *    reverse, so this pass stood down. **Whose stamp it hit decides what
 *    happens next**, which is what `deferredTo` carries: the other four
 *    actors run on an interval and are finishing the close. This one's only
 *    interval caller is the closing guard, and its own stamp stands the guard
 *    down rather than retrying: an operator has to press again, and the
 *    guard's row settles when the submitted close books.
 *  - `error` — the flatten did not reach the wire. The position is very
 *    likely still open.
 */
export type ForceFlatStatus = "closed" | "already_flat" | "deferred" | "error";

/**
 * One deployment's outcome. Flat and self-describing on purpose: a caller
 * flattening N deployments collects `ForceFlatResult[]` and needs no second
 * lookup to render or count them.
 */
export interface ForceFlatResult {
  deploymentId: string;
  /** Null only when the deployment row could not be read. */
  accountId: number | null;
  /** The execution contract the attempt was scoped to; null when the
   *  contract could not be resolved. */
  contractId: string | null;
  status: ForceFlatStatus;
  /** Contracts the closing order was submitted for. Present on `closed`. */
  size?: number;
  /** The closing order's broker id. Present on `closed`. */
  orderId?: number;
  /** Why, for every status but `closed`. */
  reason?: string;
  /** True when an engine exit was latched for this deployment as the order
   *  went out. Observational — the flatten proceeded regardless, and this is
   *  what explains a fill count that looks doubled. Omitted when false. */
  exitInFlight?: true;
  /**
   * **The field a surface reads instead of the status string.** Two of the
   * four statuses — `deferred` and `error` — leave the position possibly
   * open, and a caller rendering on `status !== "error"` shows a deferral as
   * a completed close. Set on both, omitted on the two that mean the
   * position is closing or was never open.
   */
  positionMayStillBeOpen?: true;
  /**
   * **The bracket cancel was not confirmed, so a protective leg may still be
   * resting on this contract.** An OCO leg that survives the close sits on
   * the *closing* side, so filling it opens an unbracketed reverse — which
   * is an actionable fact and therefore a field rather than a sentence a
   * surface has to substring-match out of `reason`, exactly as
   * `positionMayStillBeOpen` is. Set on `closed` when the verdict was
   * `degraded`, and on the `already_flat` arm that returns *after* the
   * cancel. Omitted wherever the position was not closed: a leg that
   * survives a cancel is still cover while the position is open, and only
   * becomes a reverse once it is flat.
   */
  workingOrdersMayRemain?: true;
  /** `deferred` only: the actor whose stamp this pass stood down for.
   *  `force_flat` is this path's own, and nothing retries that one. */
  deferredTo?: FlattenActor;
  /** `deferred` only: milliseconds until the stamp expires, so a surface can
   *  render a countdown rather than parse it back out of the reason. */
  retryAfterMs?: number;
}

/**
 * Who asked, which decides what a failure and a stand-down say.
 *
 *  - `operator` — a press. Nothing retries it, so an `error` pages through
 *    `deployment_flatten_failed` and a stand-down on its own stamp says to
 *    press again.
 *  - `closing_guard` — the closing guard's 15s loop, the one timed caller. It
 *    retries every pass and reports a failure itself, throttled, as
 *    `deployment_close_stranded`, so an `error` here logs nothing: the
 *    kill-switch-exempt line every pass would be an alert nobody can silence.
 */
export type ForceFlatCaller = "operator" | "closing_guard";

export interface ForceFlatOptions {
  caller?: ForceFlatCaller;
}

/**
 * Engine-internal surface this module calls back into. Bound callbacks
 * rather than flipped access modifiers, the same shape as its `*Deps`
 * siblings.
 */
export interface ForceFlatDeps {
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** Read from the **database**, not from the engine's deployment set: a
   *  row the engine is withholding — a live account, a staging exclusion, a
   *  paused leg — is still a position somebody has to be able to close. */
  getDeployment(deploymentId: string): Deployment | null;
  /** Non-creating state read. `state.get`, never `getState`: this must not
   *  materialise a state entry for a deployment the engine does not manage. */
  stateFor(deploymentId: string): DeploymentState | undefined;
  /** **Throws** for an account the registry no longer knows — see the guard
   *  at its call site. */
  brokerForAccount(accountId: number): Broker;
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  maybeOrphanFromBrokerError(err: unknown, accountId: number): void;
  buildCustomTag(prefix: "e" | "x" | "s", identity: string): string;
  /** The engine's own pre-exit bracket cancel, bound to `ExitOrderDeps`. */
  cancelTrackedBrackets(
    deployment: Deployment,
    contract: Contract,
    activeTradeId: number | null,
    protectiveSide: OrderSide,
  ): Promise<BracketCancelVerdict>;
  /** The engine's own post-exit verification, bound the same way. */
  verifyExitClean(
    deployment: Deployment,
    contract: Contract,
    exitOrderId: number,
    protectiveSide: OrderSide,
    activeTradeId: number | null,
    cancelVerdict: BracketCancelVerdict,
  ): Promise<void>;
  /** The instance the other four flatten actors hold. */
  flattenCooldown: FlattenCooldown;
}

/**
 * Close `deploymentId`'s position now.
 *
 * **The outer catch is the contract.** Every exit from this function is a
 * `ForceFlatResult`, including the paths no arm below can see — a registry
 * that lost the account, a locked database, a log line that could not be
 * written. See the module header for why the property is held here rather
 * than by guarding each arm one at a time.
 */
export async function forceFlatDeployment(
  deps: ForceFlatDeps,
  deploymentId: string,
  options: ForceFlatOptions = {},
): Promise<ForceFlatResult> {
  const caller = options.caller ?? "operator";
  const onError = caller === "closing_guard" ? CALLER_REPORTS : REACHED_NO_BROKER;
  try {
    // Cancels before its market order, and the closing guard reaches it
    // without a route around it: a SIGTERM's exit waits for it.
    return await trackOrderRequest(() => attemptForceFlat(deps, deploymentId, caller, onError));
  } catch (err) {
    return failed(deps, deploymentId, null, null, `the flatten path itself failed: ${message(err)}`, onError);
  }
}

/**
 * The ordering is the engine's own exit path's, with one addition. Cancel
 * the brackets *before* the market order, because an OCO leg surviving the
 * close sits on the closing side and filling it opens an unbracketed
 * reverse; then re-read the broker, because the cancel is a round trip and
 * the size that goes on the wire has to be the one the broker holds now.
 * The addition is the read *in front* of the cancel: a deployment that is
 * already flat has nothing to close, and stripping its working orders is
 * not what the operator asked for.
 */
async function attemptForceFlat(
  deps: ForceFlatDeps,
  deploymentId: string,
  caller: ForceFlatCaller,
  onError: FailureReport | null,
): Promise<ForceFlatResult> {
  const deployment = deps.getDeployment(deploymentId);
  if (!deployment) {
    return failed(deps, deploymentId, null, null, "no deployment with that id", NO_SUCH_ROW);
  }

  const accountId = deployment.accountId;
  let broker: Broker;
  try {
    broker = deps.brokerForAccount(accountId);
  } catch (err) {
    // Guarded here as well as by the outer catch, because this is the one
    // throw carrying an `accountId` worth putting on the result — and it is
    // a reachable state rather than a defensive one: an account that
    // vanished (combine → XFA, a partial registry refresh) leaves the row
    // behind, and that orphaned row is exactly what somebody needs to close.
    return failed(
      deps,
      deploymentId,
      accountId,
      null,
      `no broker is registered for this account: ${message(err)}`,
      onError,
    );
  }

  let contract: Contract;
  try {
    contract = await deps.resolveContract(deployment.ticker, accountId);
  } catch (err) {
    return failed(deps, deploymentId, accountId, null, `contract resolve failed: ${message(err)}`, onError);
  }
  const contractId = executionContractId(contract);

  const pre = await readPosition(deps, deployment, broker, contractId);
  if (!pre.ok) return failed(deps, deploymentId, accountId, contractId, pre.reason, onError);
  if (!pre.position) {
    return {
      deploymentId,
      accountId,
      contractId,
      status: "already_flat",
      reason: "the broker holds no position on this contract",
    };
  }

  // Ahead of the bracket cancel, deliberately: deferring after it would
  // strip the cover off a position this pass then declines to close. This is
  // *not* what makes the cooldown a mutex — see the re-check below.
  const standing = deps.flattenCooldown.stampedBy(accountId, contractId);
  if (standing) return standDown(deps, deploymentId, accountId, contractId, standing, caller);

  const activeTradeId = getOpenTradeForDeployment(deploymentId)?.id ?? null;
  // **Unconditional, including when `activeTradeId` is null**, and that was
  // narrowed once and reverted on 2026-09-02. With no row, Stage 1 has no
  // ids and Stage 2 cancels every working order on the contract outside the
  // deployment's pre-entry snapshot — which on this path may be an
  // operator's own hand stop. Three things make cancelling it correct
  // anyway:
  //
  //   - Nothing covers the tail if this is skipped. `verifyExitClean`'s
  //     primary sweep is gated on `preIds.size > 0 || activeTradeId != null`,
  //     which is false by construction here — no row, and no snapshot for a
  //     deployment the engine placed no entry for — and that gate does not
  //     widen. Skipping cancels nothing and nothing else cancels later.
  //   - The hand position is being closed regardless. `readPosition` matches
  //     on **contract**, not on deployment, so the market order below is
  //     sized to the account's whole position on this contract. Cancelling
  //     its stop first is the order of operations, not collateral damage: a
  //     protective order left resting after the position goes flat is
  //     precisely what opens an unbracketed reverse.
  //   - The residual is another *deployment's* orders on the same
  //     `(account, contract)`, which the one-deployment-per-pair invariant
  //     forecloses — and which `flatten-all` and the manual-position guard's
  //     close accept on the same reasoning.
  const cancelVerdict: BracketCancelVerdict = await deps.cancelTrackedBrackets(
    deployment,
    contract,
    activeTradeId,
    closingSideOf(pre.position),
  );

  const live = await readPosition(deps, deployment, broker, contractId);
  if (!live.ok) return failed(deps, deploymentId, accountId, contractId, live.reason, onError);
  if (!live.position) {
    return {
      deploymentId,
      accountId,
      contractId,
      status: "already_flat",
      reason:
        cancelVerdict === "clean"
          ? "the position closed while its brackets were being cancelled"
          : "the position closed before this pass could close it, and its brackets were not confirmed cancelled — working orders may still be resting on this contract",
      // This arm returns before the post-exit verification, so a degraded
      // verdict has nowhere else to go.
      ...(cancelVerdict === "degraded" ? { workingOrdersMayRemain: true as const } : {}),
    };
  }

  const position = live.position;
  const size = position.size;
  const closingSide = closingSideOf(position);

  // Observed, never deferred to. The latch refuses a second exit through
  // `placeExitOrder`; this path deliberately is not one, so an operator
  // firing during an in-flight engine exit gets two flattens and gets told
  // why rather than having to reconstruct it from the log.
  const exitInFlight = deps.stateFor(deploymentId)?.exitInFlight === true;
  if (exitInFlight) {
    deps.logEvent(
      "deployment_flatten_exit_in_flight",
      deploymentId,
      `[FLATTEN] An engine exit is already in flight for this deployment — flattening anyway; expect duplicate exit fills`,
      { accountId, contractId, tradeId: activeTradeId },
    );
  }

  const order: PlaceOrderRequest = {
    accountId,
    contractId,
    type: ORDER_TYPE_MARKET,
    side: closingSide,
    size,
    customTag: deps.buildCustomTag("x", deploymentId),
    tickSize: contract.tickSize,
    deploymentId,
    brokerOrderRole: BrokerOrderRole.Exit,
  };

  // **The re-check and the stamp are one synchronous run, and no `await` may
  // be introduced between them.** That adjacency is the whole of what makes
  // the cooldown a mutex, and it is how the other four actors read — they
  // get it for free by checking and stamping in adjacent statements. The
  // check at the top of this function is two broker round trips back, so on
  // its own it lets two presses of one button both pass and both submit,
  // which is the unbracketed reverse the cooldown exists to prevent. This
  // one is what stops the double submit.
  //
  // **The early check narrows the cover-stripping window; it does not close
  // it, and the difference is worth stating so nobody closes it the wrong
  // way.** It holds only while no actor stamps between the two reads: an
  // operator clears the early check, a sweep actor stamps and submits during
  // the two round trips, and this pass then cancels the brackets and stands
  // down here — cover gone, no close from this pass, and if that actor's
  // order is rejected the position is open and uncovered until its next
  // interval, 15–30s away. The trade is still the right one. **Do not close
  // it by moving the cancel below the stamp**: the cancel is a broker round
  // trip, so it would sit inside the mutex and reopen the double submit.
  const held = deps.flattenCooldown.stampedBy(accountId, contractId);
  if (held) return standDown(deps, deploymentId, accountId, contractId, held, caller);
  // Stamped before the submit, never after it: the window this closes is the
  // round trip itself.
  deps.flattenCooldown.note(accountId, contractId, "force_flat");

  // Announced after the stand-down check, not before it: a pass that defers
  // must not have already said it was closing the position. `logSafely`
  // because a throwing log handler here would otherwise be reported as a
  // failed flatten, which is the same lie the tail catch below prevents.
  logSafely(
    deps,
    "deployment_flatten",
    deploymentId,
    `[FLATTEN] Force-flattening on request: market ${closingSide === ORDER_SIDE_BUY ? "BUY" : "SELL"} ${size} ${deployment.ticker} (reason=${FLATTEN_DEPLOYMENT_EXIT_REASON})`,
    { accountId, contractId, tradeId: activeTradeId },
  );

  let orderId: number;
  try {
    orderId = (await broker.placeOrder(order)).orderId;
  } catch (err) {
    // Nothing reached the wire, so the stamp describes nothing. `release`
    // cannot drop another actor's.
    deps.flattenCooldown.release(accountId, contractId, "force_flat");
    deps.maybeOrphanFromBrokerError(err, accountId);
    return failed(
      deps,
      deploymentId,
      accountId,
      contractId,
      `broker refused the closing order: ${message(err)}`,
      onError,
    );
  }

  const result: ForceFlatResult = {
    deploymentId,
    accountId,
    contractId,
    status: "closed",
    size,
    orderId,
    ...(exitInFlight ? { exitInFlight: true as const } : {}),
    ...(cancelVerdict === "degraded" ? { workingOrdersMayRemain: true as const } : {}),
  };

  // The order is on the wire, so the answer is settled. The bookkeeping
  // below runs inside its own catch for that reason and no other: letting a
  // throw here reach the outer one would report `error` — *the position may
  // still be open* — over a market exit the broker has already accepted,
  // which is the one lie this path must not tell.
  try {
    // **Teardown first**, because it is the only step here that cannot
    // throw and because it is the one whose omission is dangerous: a live
    // mirror lets the tick path dispatch a second exit against a position
    // already closing. Behind the stamp it was reachable only when the stamp
    // succeeded, and the stamp logs unguarded.
    tearDownMirror(deps, deploymentId);
    try {
      stampExitOnTradeRow(deps, deployment, contractId, activeTradeId, orderId);
    } catch (err) {
      logSafely(
        deps,
        "deployment_flatten_unstamped",
        deploymentId,
        `[FLATTEN] Closing order #${orderId} is on the wire and the exit could not be recorded against the trade row: ${message(err)}`,
        { accountId, contractId, tradeId: activeTradeId },
      );
    }
    // Background, exactly as the engine's own exit path dispatches it: it
    // sleeps 1.5s before reading. **The `.catch` is not decoration** — its
    // own catch arm calls `logEvent` and `maybeOrphanFromBrokerError`
    // unguarded, so it can reject, and a rejected promise escapes the try
    // around it and terminates the process on a 24/7 engine. Tracked so a
    // SIGTERM's exit waits for it, as for the engine's exit.
    void trackOrderRequest(() =>
      deps.verifyExitClean(deployment, contract, orderId, closingSide, activeTradeId, cancelVerdict),
    )
      .catch((err: unknown) => {
        // `exit_verify_failed`, not `deployment_flatten_unstamped`: the stamp
        // may have landed perfectly one statement earlier, and that event
        // names a trade row that could not be written. Reusing it here would
        // make a `/logs` filter for unstamped exits return false positives,
        // and would render "found no open trade to record the exit against"
        // over a stamp that succeeded the moment these subjects carry a
        // ticker. An arm whose truth differs needs its own name.
        logSafely(
          deps,
          "exit_verify_failed",
          deploymentId,
          `[FLATTEN] Closing order #${orderId} is on the wire and the post-exit verification failed: ${message(err)}`,
          { accountId, contractId, tradeId: activeTradeId },
        );
      });
  } catch (err) {
    logSafely(
      deps,
      "deployment_flatten_unstamped",
      deploymentId,
      `[FLATTEN] Closing order #${orderId} is on the wire and the bookkeeping after it failed: ${message(err)}`,
      { accountId, contractId, tradeId: activeTradeId },
    );
  }

  return result;
}

type PositionRead =
  | { ok: true; position: Position | null }
  | { ok: false; reason: string };

/**
 * The broker is authoritative for both the size and the side, and a failed
 * read is a failure rather than a fallback: sizing a market exit off params
 * is the over-sell bug the post-entry rule exists to prevent.
 */
function closingSideOf(position: Pick<Position, "type">): OrderSide {
  return position.type === POSITION_TYPE_LONG ? ORDER_SIDE_SELL : ORDER_SIDE_BUY;
}

async function readPosition(
  deps: ForceFlatDeps,
  deployment: Deployment,
  broker: Broker,
  contractId: string,
): Promise<PositionRead> {
  try {
    const positions = await broker.searchOpenPositions(deployment.accountId);
    return { ok: true, position: positions.find((p) => p.contractId === contractId && p.size > 0) ?? null };
  } catch (err) {
    deps.maybeOrphanFromBrokerError(err, deployment.accountId);
    return { ok: false, reason: `open positions could not be read: ${message(err)}` };
  }
}

/**
 * Stand down for whoever holds the stamp, and say which of the two it is.
 *
 * **Its own stamp is the case that had to stop lying.** The message for the
 * other four is true of them: they run on an interval, so the actor that
 * stamped really is finishing the close. This one's only interval caller is
 * the closing guard, and its own stamp stands the guard down rather than
 * retrying, so *"another close is coming"* over its own stamp promises a
 * retry nothing performs — on a partial fill or an accepted-then-rejected
 * order, `verifyExitClean` logs the residual and explicitly never re-fires,
 * and the mirror is already torn down.
 *
 * **The second press stays refused**: overriding risks doubling into an
 * unbracketed reverse, which is worse than a visible wait. What changes is
 * that the line and the reason say plainly that nothing retries this one,
 * and the result carries the remaining window so a surface can count it down.
 *
 * **The closing guard gets neither "press again" nor a promised retry**: the
 * mirror is already torn down, so its next pass skips the row, which settles
 * when the submitted close books.
 */
function standDown(
  deps: ForceFlatDeps,
  deploymentId: string,
  accountId: number,
  contractId: string,
  stamp: FlattenStamp,
  caller: ForceFlatCaller,
): ForceFlatResult {
  const elapsedMs = Math.max(0, Date.now() - stamp.at);
  const retryAfterMs = Math.max(0, FLATTEN_COOLDOWN_MS - elapsedMs);
  const seconds = Math.ceil(retryAfterMs / 1000);
  const own = stamp.by === "force_flat";
  if (own && caller === "closing_guard") {
    logSafely(
      deps,
      "flatten_deferred",
      deploymentId,
      `[FLATTEN] A force flatten of ${contractId} was already submitted for this deployment ${Math.round(elapsedMs / 1000)}s ago and may still be unbooked — ` +
        `standing down; the row settles when the submitted close books`,
      { accountId, contractId },
    );
    return {
      deploymentId,
      accountId,
      contractId,
      status: "deferred",
      reason: `a force flatten of this position was submitted ${Math.round(elapsedMs / 1000)}s ago and may still be unbooked — standing down; the row settles when the submitted close books`,
      deferredTo: stamp.by,
      retryAfterMs,
      positionMayStillBeOpen: true,
    };
  }
  // `logSafely`, not `logEvent`: a throwing log handler would otherwise take
  // this return into the outer catch and report `status: "error"` with
  // `positionMayStillBeOpen` and an unsilenceable page, when the truth is
  // that another actor is closing the position.
  logSafely(
    deps,
    "flatten_deferred",
    deploymentId,
    own
      ? `[FLATTEN] A force flatten of ${contractId} was already submitted for this deployment ${Math.round(elapsedMs / 1000)}s ago and may still be unbooked — ` +
          `standing down rather than doubling it. Nothing retries this one: if the position is still open in ${seconds}s, press flatten again`
      : `[FLATTEN] Another flatten on ${contractId} may still be unbooked — standing down rather than doubling it; ` +
          `the actor that submitted it is finishing the close`,
    { accountId, contractId },
  );
  return {
    deploymentId,
    accountId,
    contractId,
    status: "deferred",
    reason: own
      ? `a force flatten of this position was submitted ${Math.round(elapsedMs / 1000)}s ago and may still be unbooked — nothing retries it, so press again in ${seconds}s if the position is still open`
      : `another close of this position was submitted in the last ${Math.round(FLATTEN_COOLDOWN_MS / 1000)}s`,
    deferredTo: stamp.by,
    retryAfterMs,
    positionMayStillBeOpen: true,
  };
}

/**
 * Record the exit against the deployment's own live trade row.
 *
 * Deployment-scoped rather than `(account, contract)`-scoped, which is where
 * this differs from `flatten-all`: that route sweeps the broker's book and
 * has no deployment to ask, while this one does. A close with no row to
 * stamp is a real outcome — the fill can beat the response — and it is said
 * out loud rather than swallowed, because the reason code and the order id
 * are what the reconciler's heal pass scopes itself with.
 */
function stampExitOnTradeRow(
  deps: ForceFlatDeps,
  deployment: Deployment,
  contractId: string,
  activeTradeId: number | null,
  orderId: number,
): void {
  if (activeTradeId == null) {
    deps.logEvent(
      "deployment_flatten_unstamped",
      deployment.id,
      `[FLATTEN] Closing order #${orderId} is on the wire and no live trade row was found to stamp it on ` +
        `(account=${deployment.accountId}, contract=${contractId})`,
      { accountId: deployment.accountId, contractId },
    );
    return;
  }
  try {
    attachPendingExit({
      tradeId: activeTradeId,
      exitOrderId: orderId,
      exitSubmittedAt: new Date().toISOString(),
      exitReason: FLATTEN_DEPLOYMENT_EXIT_REASON,
    });
  } catch (err) {
    deps.logEvent(
      "deployment_flatten_unstamped",
      deployment.id,
      `[FLATTEN] Closing order #${orderId} is on the wire and trade #${activeTradeId} could not be stamped with it. ` +
        `Database said: ${message(err)}`,
      { accountId: deployment.accountId, contractId, tradeId: activeTradeId },
    );
  }
}

/**
 * The same teardown every other exit submitter performs, and it happens for
 * the same reason: a normal return is the claim that the exit is on the
 * wire, and leaving the mirror set lets the tick path dispatch a second one
 * against a position already on its way out. The durable half is the trade
 * row, which sits at `pending_exit` until the fill resolves.
 *
 * A missing state entry is ordinary rather than an error — the engine holds
 * none for a deployment it does not manage, and this path reaches those.
 */
function tearDownMirror(deps: ForceFlatDeps, deploymentId: string): void {
  const deplState = deps.stateFor(deploymentId);
  if (!deplState) return;
  deplState.position = null;
  deplState.breakEvenMoved = false;
  deplState.activeTpTicks = null;
  deplState.activeSlTicks = null;
  deplState.slMovedToBe = false;
  deplState.slCurrentPrice = null;
  deplState.tpCurrentPrice = null;
  deplState.cooldownAnchorAt = new Date().toISOString();
  // An exit on the wire ends whatever stranding these were suppressing.
  deplState.flatMismatchWarnedAt = null;
  deplState.exitDispatchWarnedAt = null;
}

/**
 * The two lines an `error` return can take. **One reporter, parameterised**
 * — not two reporters — so every `error` arm still passes through a single
 * place and the choice of line is visible at the call site.
 */
interface FailureReport {
  event: string;
  line(reason: string): string;
}

/**
 * The default, and the one that pages. `deployment_flatten_failed` escalates
 * to Discord and is exempt from the notifications kill-switch — see
 * [logging](../../../../../docs/modules/logging/README.md) — so the line is
 * written consequence-first: the clause the operator has to act on has to
 * survive the alert title's cap however long a broker error body runs.
 */
const REACHED_NO_BROKER: FailureReport = {
  event: "deployment_flatten_failed",
  line: (reason) =>
    `[FLATTEN] Force flatten returned status=error and did not reach the broker — the position may still be open. ${reason}`,
};

/**
 * **The one `error` arm that must not page.** `getDeployment` does not
 * filter `deleted_at`, so a null row means no row has ever existed under
 * that id — a board holding a stale id, not a close that failed. The
 * escalating line claimed *"the position may still be open"* about a
 * position this arm never identified, and the sender's throttle keys on the
 * deployment id, so N stale ids were N unsilenceable pages.
 */
const NO_SUCH_ROW: FailureReport = {
  event: "deployment_flatten_no_row",
  line: (reason) =>
    `[FLATTEN] Force flatten was asked for a deployment this database has no row for — nothing was closed, no position was identified and no broker was reached, so nothing has been left open. Reason: ${reason}`,
};

/**
 * **No line: the caller reports.** The closing guard's loop reaches this every
 * 15s while a broker is down, and `deployment_flatten_failed` is the one alert
 * the kill-switch does not silence. The guard carries `reason` into its own
 * throttled `deployment_close_stranded` instead.
 */
const CALLER_REPORTS = null;

/** Every `error` return goes through here, so a failed emergency close is
 *  loud in exactly one place. Required rather than defaulted, so an arm added
 *  later cannot page on the closing guard's behalf by omission. */
function failed(
  deps: ForceFlatDeps,
  deploymentId: string,
  accountId: number | null,
  contractId: string | null,
  reason: string,
  report: FailureReport | typeof CALLER_REPORTS,
): ForceFlatResult {
  if (report !== CALLER_REPORTS) {
    logSafely(
      deps,
      report.event,
      deploymentId,
      report.line(reason),
      {
        ...(accountId != null ? { accountId } : {}),
        ...(contractId != null ? { contractId } : {}),
      },
    );
  }
  return {
    deploymentId,
    accountId,
    contractId,
    status: "error",
    reason,
    // Omitted on `NO_SUCH_ROW`, and that is the whole point of splitting it
    // out. That arm identified no position — no row has ever existed — and
    // this field is what a surface renders *instead of* the status string,
    // so setting it here re-tells through the field the claim the event was
    // split out to stop telling. A board would show the may-still-be-open
    // warning and offer a retry against an id that will never resolve.
    ...(report === NO_SUCH_ROW ? {} : { positionMayStillBeOpen: true as const }),
  };
}

/**
 * A log line can throw, so the sites whose whole contract is that they
 * cannot throw route through here: the failure reporter, the stand-down, the
 * close announcement and the bookkeeping after an order is already on the
 * wire. Everywhere else a throw is caught by `forceFlatDeployment`'s outer
 * catch and reported.
 *
 * **The unguarded surface is `this.onLog?.(record)` in `engine.ts`**, which
 * `TradingEngine.logEvent` calls with whatever handler the process
 * installed. `emit` itself wraps each of its sinks, and `displayFor`
 * catches its own database read and documents that it yields no display
 * rather than no line — so neither of those is what this exists for.
 */
function logSafely(
  deps: ForceFlatDeps,
  event: string,
  deploymentId: string,
  text: string,
  subject: LogSubject,
): void {
  try {
    deps.logEvent(event, deploymentId, text, subject);
  } catch {
    // The reporting channel is what failed; there is nothing better to try.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
