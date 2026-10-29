// The closing guard — what drives a `Pausing` or `Destroying` deployment to
// completion. D-4 and D-5 of docs/proposals/position-lifecycle.md.
//
// The status carries the work, not the HTTP request. `placeExitOrder` returns
// at *submission*; flat is confirmed later, by `handleUserPositionClose` on
// the socket or by the reconciler tick. A request that waited for flat would
// race 15–20s client timeouts and strand the work if the tab closed or the
// process restarted. So the route writes a status and returns, and this is
// the loop that finishes the job — which also settles who retries: nobody
// new, the engine already had a timer.
//
// Two entry points, and they answer different questions:
//
//   - `runClosingGuard()` — the interval. Submits the exit for any closing
//     row that still holds a position, and settles any that no longer does.
//     Idempotent and safe to run against a row it has already acted on.
//   - `settleIfFlat(deploymentId)` — the prompt path, called from the
//     reconciler's close-resolution branch (which `handleUserPositionClose`
//     runs through). Confirming flat belongs on the path that already owns
//     position teardown, not on the ghost sweep's attribution branch: the
//     ghost sweep answers "the broker disagrees with our mirror", which is
//     not the same question as "the trade is closed".
//
// Candidates come from the **database**, not from the engine's in-memory
// deployment set. `stop()` empties that set while the obligation survives,
// and a closing row must survive a restart holding its status — which is the
// property that makes the retry free. Same reasoning as the session-end
// guard's `getAllOpenTrades()` union, arrived at from the other direction.

import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import type { Contract, Order, OrderStatus, Position } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Broker } from "../../broker-access/broker";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { OpenPosition, StrategyModule } from "../../strategy-types";
import type { DeploymentState, LogSubject } from "../engine";
import type { ForceFlatOptions, ForceFlatResult } from "../flatten/engine-force-flat";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { productRootFromContractId } from "../../broker-access/contract-pairing";
import { leaseGate } from "@/lib/db/lease";

/**
 * Sweep cadence. Matches `SESSION_END_GUARD_INTERVAL_MS` and `REST_TICK_MS`
 * so this adds no new timing regime: the operator's Pause is submitted within
 * one tick of the click, and a `Pausing` row that goes flat between ticks is
 * settled promptly by `settleIfFlat` rather than waiting for this at all.
 *
 * The common pass is a single indexed query returning zero rows — both
 * transient states are conditional, so on a healthy install nothing is
 * closing almost all of the time.
 */
export const CLOSING_GUARD_INTERVAL_MS = 15_000;

/**
 * How often a persistent close failure is re-reported per deployment. Same
 * shape and the same reason as the session guard's: a broker outage means
 * this retries every interval and fails every interval, and four lines a
 * minute per stranded row drowns the log that has to carry the incident.
 */
export const CLOSING_GUARD_FAILURE_REPORT_MS = 300_000;

/** The exit reason stamped on a trade closed because its deployment is
 *  going away. One code for both transient states: the *trade* was closed
 *  because the deployment stopped, and which of Pause or Destroy asked for
 *  it is the deployment row's business, not the trade's. */
export const DEPLOYMENT_CLOSE_EXIT_REASON: ExitReasonCode = "deployment_close";

/** Passes a `pending_entry` row may sit with no entry order id before the
 *  guard says so. The id lands with the place response, so one pass is
 *  normal; three is a place that never answered (A45). */
export const MISSING_ENTRY_ORDER_ID_WARN_PASSES = 3;

/** How long a closing row may answer `already_flat` with the mirror still
 *  holding before the guard says so: two of its intervals, so the reconciler
 *  has had at least one tick to clear the mirror. */
export const ALREADY_FLAT_REPORT_AFTER_MS = 2 * CLOSING_GUARD_INTERVAL_MS;

const ORDER_STATUS_CANCELLED: OrderStatus = 3;

/**
 * Engine-internal surface the closing guard calls back into. Mirrors
 * `SessionGuardDeps` — bound callbacks rather than flipped access modifiers.
 *
 * **`stateFor` must stay synchronous**, for the reason stated on
 * `SessionGuardDeps`: no `await` may sit between reading
 * `DeploymentState.position` and calling `placeExitOrder`.
 */
export interface ClosingGuardDeps {
  log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ): void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** `Pausing` + `Destroying` rows, read from the DB at call time. */
  listClosing(): Deployment[];
  /** The row's config, for the prompt path which is handed only an id. */
  getDeployment(deploymentId: string): Deployment | null;
  /** The deployment's `pending_entry` / `open` / `pending_exit` row, or null.
   *  The durable half of "is it flat" — it survives a restart, and unlike
   *  `DeploymentState.position` it is not cleared at exit *submission*. The
   *  row rather than a boolean because a `pending_entry` one is closed by
   *  cancelling its entry order, not by an exit (A45). */
  openTradeFor(deploymentId: string): StrategyTrade | null;
  /** Every live row of the deployment. `openTradeFor` answers the newest
   *  only, so a confirmed `pending_entry` row could otherwise settle over an
   *  older `open` one behind it (A45). Read only on that settle. */
  liveTradesFor(deploymentId: string): StrategyTrade[];
  /** For the entry cancel and the read that confirms it (A45). */
  brokerForAccount(accountId: number): Broker;
  /** Non-creating state read. See the note on this interface. */
  stateFor(deploymentId: string): DeploymentState | undefined;
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  placeExitOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    activeTradeId: number | null,
    reason: string,
  ): Promise<void>;
  /** `forceFlatDeployment` — the close for a row with no registered module,
   *  which `placeExitOrder` cannot serve. Never throws. Called with
   *  `caller: "closing_guard"`, so a failure is this guard's to report. */
  forceFlat(deploymentId: string, options: ForceFlatOptions): Promise<ForceFlatResult>;
  /** `Pausing` → `Paused`. False when the row was no longer `Pausing`. */
  settlePausing(deploymentId: string): boolean;
  /** `Destroying` → soft-deleted. Undefined when nothing was reaped. */
  reapDestroying(deploymentId: string): { groupId: string | null } | undefined;
  /** Fired once per completed transition, after the row is written. The
   *  engine re-syncs its deployment set from it so a settled row stops
   *  being iterated. */
  onSettled(deployment: Deployment, from: "Pausing" | "Destroying"): void;
}

/** What the guard has done about a closing row's `pending_entry` trade (A45).
 *  `uncancelled`: no cancel has been accepted yet; each pass sends one.
 *  `cancelled`: the broker took the cancel; waiting for a read that shows the
 *  order gone and no position. `confirmed`: that read happened, so the row
 *  is flat although its trade row is still `pending_entry`. */
interface EntryCancel {
  tradeId: number;
  outcome: "uncancelled" | "cancelled" | "confirmed";
  cancelFailureWarned: boolean;
  readFailureWarned: boolean;
}

/** Passes a `pending_entry` row has gone with no entry order id. */
interface MissingEntryId {
  tradeId: number;
  passes: number;
}

export class ClosingGuard {
  /** First-failure anchor per deployment, in epoch ms. */
  private closeFailureSince = new Map<string, number>();
  /** Last time a failure was reported for this deployment, in epoch ms. */
  private closeFailureReportedAt = new Map<string, number>();
  /** Per deployment; dropped when the row settles. */
  private entryCancels = new Map<string, EntryCancel>();
  /** Per deployment; dropped when the row settles. */
  private missingEntryIds = new Map<string, MissingEntryId>();
  /** When a row's force flatten started finding the broker flat while the
   *  mirror held a position, in epoch ms. Dropped on any other outcome, on
   *  settle, and once the row is no longer closing. */
  private flatAtBrokerSince = new Map<string, number>();
  /** The guard survives `stop()`, so a lost lease does not disarm it. */
  private readonly mayAct = leaseGate(
    "the closing guard",
    "The flatten, entry cancel and settle it owes are left to the process that holds the lease.",
  );

  constructor(private readonly deps: ClosingGuardDeps) {}

  /**
   * One pass over every row the engine still owes a close.
   *
   * Ordering inside the loop is load-bearing and copied from the session
   * guard: the contract resolve is the one `await`, and it happens *before*
   * `DeploymentState.position` is read for the dispatch, so the read and the
   * call that consumes it are separated by nothing.
   */
  async runClosingGuard(): Promise<void> {
    const closing = this.deps.listClosing();
    // A row that left Pausing / Destroying without settling here (a status
    // write elsewhere) must not carry its since-time into a later close.
    const closingIds = new Set(closing.map((d) => d.id));
    for (const id of this.flatAtBrokerSince.keys()) {
      if (!closingIds.has(id)) this.flatAtBrokerSince.delete(id);
    }
    if (closing.length === 0) return;

    for (const deployment of closing) {
      // Per row, after the previous row's awaits: ahead of the settle, the
      // entry cancel and the force-flat, none of which awaits before acting.
      if (!this.mayAct()) return;
      if (this.settleIfFlatSync(deployment)) continue;

      // No position yet, so no exit to submit — but the entry order is still
      // working and can fill after the operator was told the deployment is
      // stopping. Cancel it rather than wait out the stale-entry sweep (A45).
      const trade = this.deps.openTradeFor(deployment.id);
      if (trade?.status === "pending_entry") {
        await this.closePendingEntry(deployment, trade);
        continue;
      }

      const pre = this.deps.stateFor(deployment.id);
      if (!pre?.position) {
        // Not flat, but nothing to submit: the exit is already on the wire
        // (`placeExitOrder`'s callers null the mirror at submission and the
        // trade row sits at `pending_exit` until the fill resolves). It
        // resolves through the reconciler, which then reaches `settleIfFlat`.
        continue;
      }

      // A playbook this build does not register (strategies/prod-playbooks.ts
      // decides prod's) leaves no module to build an exit from.
      // `forceFlatDeployment` needs none: it reads the broker, cancels the
      // brackets, sends the market order, tears down the mirror and stamps the
      // row — and it carries the shared cooldown, so it cannot double another
      // actor's close. As the caller it logs no failure line of its own; this
      // guard's throttled `deployment_close_stranded` is the only alert.
      const strategy = getStrategy(deployment.strategyKey);
      if (!strategy) {
        const result = await this.deps.forceFlat(deployment.id, { caller: "closing_guard" });
        const flatSince = this.flatAtBrokerSince.get(deployment.id);
        if (result.status !== "already_flat") this.flatAtBrokerSince.delete(deployment.id);
        if (result.status === "closed") this.clearFailure(deployment.id);
        else if (result.status === "error") {
          this.reportFailure(
            deployment,
            Date.now(),
            `its playbook is not part of this build and the flatten did not reach the broker: ${result.reason ?? "no reason given"}`,
          );
        } else if (result.status === "already_flat") {
          // The reconciler owns a mirror the broker contradicts, so it gets
          // at least one 15s tick first — timed, not counted, because a nudge
          // and the interval can run two passes milliseconds apart. Past that
          // the mirror still holds and the broker has nothing on the front
          // month: a back-month position after a roll returns this forever,
          // and saying nothing strands it.
          const nowMs = Date.now();
          if (flatSince === undefined) this.flatAtBrokerSince.set(deployment.id, nowMs);
          else if (nowMs - flatSince >= ALREADY_FLAT_REPORT_AFTER_MS) {
            this.reportFailure(
              deployment,
              nowMs,
              `its playbook is not part of this build, the engine still holds a position for it and the broker holds none on ${result.contractId ?? "its contract"} — ` +
                "if the position is on another contract month (after a roll), flatten it by hand at the broker",
            );
          }
        }
        // `deferred`: another actor is closing it; the next pass looks again.
        continue;
      }

      let contract: Contract;
      try {
        contract = await this.deps.resolveContract(deployment.ticker, deployment.accountId);
      } catch (err) {
        this.reportFailure(deployment, Date.now(), `contract resolve failed: ${message(err)}`);
        continue;
      }

      // Re-read after the resolve, for the reason the session guard does:
      // `handleUserPositionEvent` is void-dispatched with no `ticking` guard,
      // so a close event landing during the resolve nulls `position`
      // underneath us and `placeExitOrderInner` would read `.side` off null.
      const deplState = this.deps.stateFor(deployment.id);
      const position = deplState?.position;
      if (!deplState || !position) continue;
      if (!this.mayAct()) return;

      this.deps.logEvent(
        "deployment_close_flatten",
        deployment.id,
        `[${deployment.status.toUpperCase()}] Closing guard: flattening so the deployment can settle`,
        {
          accountId: deployment.accountId,
          contractId: contract.id,
          tradeId: deplState.activeTradeId,
        },
      );
      try {
        await this.deps.placeExitOrder(
          strategy,
          deployment,
          contract,
          position,
          deplState.activeTradeId,
          DEPLOYMENT_CLOSE_EXIT_REASON,
        );
        deplState.position = null;
        deplState.breakEvenMoved = false;
        deplState.activeTpTicks = null;
        deplState.activeSlTicks = null;
        deplState.slMovedToBe = false;
        deplState.slCurrentPrice = null;
        deplState.tpCurrentPrice = null;
        deplState.cooldownAnchorAt = new Date().toISOString();
        this.clearFailure(deployment.id);
      } catch (err) {
        // `EXIT_IN_FLIGHT` means "already happening, fine" — never an error.
        // The exit already on the wire is the outcome this pass wanted, and
        // reporting it as a failure would say "pause failed" at the exact
        // moment the exit it asked for is succeeding (D-12 / Q-8).
        if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
          this.clearFailure(deployment.id);
          continue;
        }
        // Position is deliberately kept so the next pass retries.
        this.reportFailure(deployment, Date.now(), `exit dispatch failed: ${message(err)}`);
      }
    }
  }

  /**
   * Prompt path: the deployment behind a just-closed trade may now be flat,
   * so settle it if it is. A no-op for a deployment that is not closing,
   * which is the overwhelmingly common case — this runs on every trade close.
   */
  settleIfFlat(deploymentId: string): void {
    const deployment = this.deps.getDeployment(deploymentId);
    if (!deployment) return;
    this.settleIfFlatSync(deployment);
  }

  /**
   * The transition itself. Returns whether the row settled.
   *
   * "Flat" is the durable answer *and* the in-memory one, and it needs both:
   * the trade row alone would call a deployment flat in the window between
   * `closeTrade` and the state teardown two lines later, and
   * `DeploymentState.position` alone is nulled at exit **submission**, which
   * is precisely the moment D-5 exists to distinguish from confirmed flat.
   *
   * The one open row that does not block is a `pending_entry` whose cancel
   * this guard has confirmed (A45): the order is gone and the broker holds
   * nothing on the product — and only when no other live row stands behind
   * it. The row itself is left to the reconciler, which owns telling a
   * cancelled entry from a fast round trip.
   */
  private settleIfFlatSync(deployment: Deployment): boolean {
    if (deployment.status !== "Pausing" && deployment.status !== "Destroying") {
      this.flatAtBrokerSince.delete(deployment.id);
      return false;
    }
    const trade = this.deps.openTradeFor(deployment.id);
    if (trade && !this.entryCancelConfirmed(deployment.id, trade)) return false;
    if (trade && this.deps.liveTradesFor(deployment.id).some((t) => t.id !== trade.id)) return false;
    if (this.deps.stateFor(deployment.id)?.position != null) return false;

    const from = deployment.status;
    const settled =
      from === "Pausing"
        ? this.deps.settlePausing(deployment.id)
        : this.deps.reapDestroying(deployment.id) !== undefined;
    if (!settled) return false;

    this.clearFailure(deployment.id);
    this.entryCancels.delete(deployment.id);
    this.missingEntryIds.delete(deployment.id);
    this.flatAtBrokerSince.delete(deployment.id);
    this.deps.logEvent(
      "deployment_settled",
      deployment.id,
      from === "Pausing"
        ? "Pause complete — position confirmed flat, deployment is now Paused"
        : "Destroy complete — position confirmed flat, deployment removed",
      { accountId: deployment.accountId },
    );
    this.deps.onSettled(deployment, from);
    return true;
  }

  private entryCancelConfirmed(deploymentId: string, trade: StrategyTrade): boolean {
    if (trade.status !== "pending_entry") return false;
    const record = this.entryCancels.get(deploymentId);
    return record?.tradeId === trade.id && record.outcome === "confirmed";
  }

  /**
   * Cancel a closing row's working entry order, then settle on a read that
   * shows it gone (A45). A cancel that throws — the order already filled, or
   * the broker unreachable — is sent again each pass (cancel is idempotent)
   * and warned about once. Meanwhile the reconciler either promotes a fill to
   * `open` (the exit path then takes it) or resolves the entry within
   * `STALE_PENDING_ENTRY_MS`.
   */
  private async closePendingEntry(deployment: Deployment, trade: StrategyTrade): Promise<void> {
    const orderId = trade.entryOrderId;
    const subject: LogSubject = { accountId: trade.accountId, contractId: trade.contractId, tradeId: trade.id };
    if (orderId == null) {
      this.noteMissingEntryOrderId(deployment, trade, subject);
      return;
    }

    let record = this.entryCancels.get(deployment.id);
    if (record?.tradeId !== trade.id) {
      record = { tradeId: trade.id, outcome: "uncancelled", cancelFailureWarned: false, readFailureWarned: false };
      this.entryCancels.set(deployment.id, record);
    }
    if (record.outcome === "uncancelled") {
      try {
        await this.deps.brokerForAccount(trade.accountId).cancelOrder(orderId, trade.accountId);
        record.outcome = "cancelled";
        this.logSafely(deployment.id, "info", `Closing guard: cancelled pending entry order #${orderId} so the deployment can settle`, subject);
      } catch (err) {
        if (!record.cancelFailureWarned) {
          record.cancelFailureWarned = true;
          this.logSafely(
            deployment.id,
            "warn",
            `Closing guard: cancel of pending entry order #${orderId} failed: ${message(err)} — retrying every ${Math.round(CLOSING_GUARD_INTERVAL_MS / 1000)}s; the deployment stays ${deployment.status} until the order is gone or the reconciler resolves the entry (up to 10 minutes), and the order may still fill`,
            subject,
          );
        }
        return;
      }
    }

    if (record.outcome === "cancelled") {
      if (!(await this.entryReadsCancelled(deployment, trade, orderId, record, subject))) return;
      // After the reads: a fill promoted inside them moves the row off
      // `pending_entry`, and the exit path owns it from the next pass.
      const current = this.deps.openTradeFor(deployment.id);
      if (current?.id !== trade.id || current.status !== "pending_entry") return;
      record.outcome = "confirmed";
      // The mirror is seeded at entry submission; this is the teardown the
      // reconciler's entry-not-filled branch does, which is a no-op for it
      // afterwards (`activeTradeId` no longer matches).
      const state = this.deps.stateFor(deployment.id);
      if (state && state.activeTradeId === trade.id) {
        state.activeTradeId = null;
        state.position = null;
        state.preEntryOrderIds = null;
        state.activeTpTicks = null;
        state.activeSlTicks = null;
        state.pendingEntrySessionKey = null;
      }
    }
    this.settleIfFlatSync(deployment);
  }

  /** The row has had no entry order id for `MISSING_ENTRY_ORDER_ID_WARN_PASSES`
   *  passes: say so once. Nothing to cancel without it, and the reconciler has
   *  no branch for it either, so silence would hide a stuck Pause. */
  private noteMissingEntryOrderId(deployment: Deployment, trade: StrategyTrade, subject: LogSubject): void {
    let seen = this.missingEntryIds.get(deployment.id);
    if (seen?.tradeId !== trade.id) {
      seen = { tradeId: trade.id, passes: 0 };
      this.missingEntryIds.set(deployment.id, seen);
    }
    seen.passes += 1;
    if (seen.passes !== MISSING_ENTRY_ORDER_ID_WARN_PASSES) return;
    this.logSafely(
      deployment.id,
      "warn",
      `Closing guard: pending entry trade #${trade.id} has had no entry order id for ${seen.passes} passes, so there is nothing to cancel — the deployment stays ${deployment.status} until the reconciler resolves the entry`,
      subject,
    );
  }

  /** The entry order is off the book and the broker holds nothing on its
   *  product. A position there is a fill that beat the cancel, which the
   *  trade row has not caught up with yet.
   *
   *  Orders first, then positions, never in parallel: "not in open orders"
   *  covers filled as well as cancelled, so the position read must start
   *  after the order read answered, or a fill landing between them is seen
   *  by neither. */
  private async entryReadsCancelled(
    deployment: Deployment,
    trade: StrategyTrade,
    orderId: number,
    record: EntryCancel,
    subject: LogSubject,
  ): Promise<boolean> {
    let orders: Order[];
    let positions: Position[];
    try {
      const broker = this.deps.brokerForAccount(trade.accountId);
      orders = await broker.searchOpenOrders(trade.accountId, { forceFresh: true });
      positions = await broker.searchOpenPositions(trade.accountId);
    } catch (err) {
      if (!record.readFailureWarned) {
        record.readFailureWarned = true;
        this.logSafely(
          deployment.id,
          "warn",
          `Closing guard: could not confirm the cancel of entry order #${orderId}: ${message(err)} — retrying every ${Math.round(CLOSING_GUARD_INTERVAL_MS / 1000)}s`,
          subject,
        );
      }
      return false;
    }
    if (orders.some((o) => o.id === orderId && !cancelledUnfilled(o))) return false;
    return !mayHoldProduct(positions, trade.contractId);
  }

  /** A throwing log handler must not end the pass for the rows after this one. */
  private logSafely(deploymentId: string, severity: Severity, text: string, subject: LogSubject): void {
    try {
      this.deps.log(deploymentId, severity, "order", text, subject);
    } catch {
      // Nowhere left to report it.
    }
  }

  /**
   * Escalate on the first failure, then throttle. A closing row that cannot
   * close is holding a live position the operator believes they have already
   * closed, so the line says how long it has been failing rather than just
   * "again".
   */
  private reportFailure(deployment: Deployment, nowMs: number, detail: string): void {
    const since = this.closeFailureSince.get(deployment.id) ?? nowMs;
    this.closeFailureSince.set(deployment.id, since);
    const lastReported = this.closeFailureReportedAt.get(deployment.id);
    if (lastReported != null && nowMs - lastReported < CLOSING_GUARD_FAILURE_REPORT_MS) return;
    this.closeFailureReportedAt.set(deployment.id, nowMs);
    const stranded = Math.round((nowMs - since) / 1000);
    this.deps.logEvent(
      "deployment_close_stranded",
      deployment.id,
      `Deployment has been ${deployment.status} for ${stranded}s and is not flat — ${detail}. ` +
        `Retrying every ${Math.round(CLOSING_GUARD_INTERVAL_MS / 1000)}s; the position is still open.`,
      { accountId: deployment.accountId },
    );
  }

  private clearFailure(deploymentId: string): void {
    this.closeFailureSince.delete(deploymentId);
    this.closeFailureReportedAt.delete(deploymentId);
  }
}

/** An order the read still lists is gone only as Cancelled with nothing
 *  filled. The neutral `Order` carries no filled quantity, so a set
 *  `filledPrice` is the evidence of a fill. */
function cancelledUnfilled(order: Order): boolean {
  return order.status === ORDER_STATUS_CANCELLED && order.filledPrice == null;
}

/** A73's product test, as `engine-exit.ts` applies it: a position on the
 *  row's root, or on a root that will not parse, may be the row's fill.
 *  Absence on an id is not flat — Tradovate reads a position back under a
 *  numeric id until its symbol lookup warms. Both ids are the execution
 *  broker's, so the roots share a namespace. */
function mayHoldProduct(positions: Position[], rowContractId: string): boolean {
  const rowRoot = productRootFromContractId(rowContractId);
  return positions.some((p) => {
    if (p.size <= 0) return false;
    const root = productRootFromContractId(p.contractId);
    return rowRoot === null || root === null || root === rowRoot;
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
