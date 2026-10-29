// Clock-driven session-end force-flat. Tier 2 of the D-9 taxonomy in
// docs/proposals/position-lifecycle.md: safety work that needs a clock and a
// broker, and no market data at all.
//
// `isInAnySessionWindow(now, …)` is evaluated against the wall clock, but
// until this module existed every caller was fed by market data:
// `evaluateRealtimeExits` needs SignalR trade frames, and `processDeployment`
// sits behind `if (latestBar.timestamp === deplState.lastBarTimestamp) return`
// — the *normal* state between bar closes, not an error — so the bar-driven
// backstop could only fire on a new bar close, never at the window boundary.
// In passive mode (SignalR kicked, REST alive) that made session-end
// force-flat late by up to one timeframe: five minutes on a 5m deployment, an
// hour on a 1h one. Prop firms require flat by a stated time, so that is a
// rule violation rather than a bad fill. See bugs.md.
//
// This is a third caller, not a replacement. Both existing paths stay: the
// defect is that neither is *guaranteed*, not that either is wrong.
//
// The predicate itself was a fixed `HH:MM` pair with no exchange-calendar
// term, and that was the *other* half of the same area's failures: on a 13:00
// ET close this guard took the in-window branch for ~700 consecutive passes
// and then submitted a market order into a market that had shut three hours
// earlier, while the backtest force-exited at the 18:00 Globex reopen. All
// three engine actors and `backtest.ts` now read one calendar-aware answer,
// `isInTradableSessionWindow`. See bugs.md A63 and `exchange-calendar.ts`.
//
// A stateful controller for the same reason `engine-watchdog.ts` is one: the
// failure-escalation anchors below are written by this sweep and read nowhere
// else, so they moved here rather than staying on the engine behind getters.

import type { Contract } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { CommonParams, OpenPosition, SessionWindow, StrategyModule } from "../../strategy-types";
import type { DeploymentState, LogSubject } from "../engine";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import type { FlattenCooldown } from "../engine-flatten-cooldown";
import { getAllOpenTrades } from "@/lib/db/trades";
import { getDeployment } from "@/lib/db/deployments";
import { leaseGate } from "@/lib/db/lease";
import { defaultParamValues, migrateLegacyParamOverrides } from "../../strategy-types";
import {
  collectSessionWindows,
  mostRecentWindowEnd,
} from "../../session/session";
import {
  CALENDAR_HORIZON_ESCALATE_DAYS,
  EARLY_CLOSE_CALENDAR_THROUGH,
  calendarHorizonState,
  earlyCloseFor,
  isInEarlyCloseHalt,
  isInTradableSessionWindow,
} from "../../session/exchange-calendar";
import { ENGINE_SCOPE } from "@/lib/logging/vocabulary";
import { etDateKey } from "../../session/session-utils";
import { executionContractId } from "../../broker-access/contract-resolver";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";

/**
 * Sweep cadence. Bounds how late a session-end flatten can be to one
 * interval, replacing "up to one bar interval" — which is 60 minutes on the
 * largest timeframe a deployment can run and 1 minute on the smallest.
 *
 * 15s is chosen against the *smallest* supported timeframe (`1m`): the guard
 * only earns its keep if it is decisively faster than the bar cadence it
 * backstops, and a quarter of the finest timeframe is that. Going below it
 * buys nothing — session windows are specified as `HH:MM`, so one minute is
 * the finest boundary the operator can even express, and 15s already lands
 * four passes inside it. It also matches `REST_TICK_MS`, the cadence the
 * engine already polls at in passive mode, so this adds no new timing
 * regime.
 *
 * The common pass is entirely synchronous — a param merge and a predicate
 * per deployment holding a position — and does no I/O whatsoever unless a
 * deployment is genuinely out of window.
 */
export const SESSION_END_GUARD_INTERVAL_MS = 15_000;

/**
 * How often a persistent exit failure is re-reported per deployment. The
 * guard cannot flatten without the broker, so an outage means it retries
 * every interval and fails every interval. Reporting each one would put four
 * lines a minute per stranded deployment into the ring buffer and drown the
 * log that has to carry the incident; reporting none would silently give up
 * on a position that is past its session close. First failure is reported
 * immediately, then at most one line per this window until it succeeds.
 */
export const SESSION_END_GUARD_FAILURE_REPORT_MS = 300_000;

/**
 * Engine-internal surface the session guard calls back into. Mirrors
 * `NakedWatchdogDeps` — bound callbacks rather than flipped access modifiers.
 *
 * **`stateFor` must stay synchronous.** The engine's hard rule is that no
 * `await` may sit between reading `DeploymentState.position` and calling
 * `placeExitOrder`; a promise here would park one there and reopen the
 * concurrent-exit flip that the latch exists to prevent. It is also
 * deliberately `state.get`, not `getState` — a guard must not lazily create
 * a state entry for a deployment it is only inspecting.
 */
export interface SessionGuardDeps {
  log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ): void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category, and whether it escalates. See
   *  `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** Current realtime deployment set, read at call time — the sweep must see
   *  deployments added or removed since the interval was armed. */
  realtimeDeployments(): Deployment[];
  /** Exit-eval scope predicate: engine-enabled OR holding an open position. */
  isLegInExitLoop(deployment: Deployment): boolean;
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
  /** The engine-owned instance every flatten actor shares. This guard is one
   *  of four that can put a market order against the same (account,
   *  contract), and the naked-position watchdog — which bypasses
   *  `placeExitOrder` entirely — is invisible to the exit latch in both
   *  directions. See engine-flatten-cooldown.ts. */
  flattenCooldown: FlattenCooldown;
}

/** A deployment this pass may act on, carrying what `collectCandidates`
 *  already knew about it. `openTradeContractId` is non-null exactly when the
 *  DB half of the union saw a `status = 'open'` row — the discriminator that
 *  separates a legitimately flat leg from a leg whose mirror lost a position
 *  the database still says is open. Carried rather than re-queried: the sweep
 *  runs every 15s and the read is already done. */
interface SessionCandidate {
  deployment: Deployment;
  openTradeContractId: string | null;
}

export class SessionEndGuard {
  /** First-failure anchor per deployment, in epoch ms. Present means the
   *  guard has tried and failed to flatten this deployment at least once and
   *  has not since succeeded; used both to escalate and to throttle. */
  private exitFailureSince = new Map<string, number>();
  /** Last time a failure was reported for this deployment, in epoch ms. */
  private exitFailureReportedAt = new Map<string, number>();
  /** ET date the calendar-horizon line was last said on. One a day: the fact
   *  stands for months and the sweep runs four times a minute.
   *
   *  **Per process, not per day on the wire** — this is in memory, so a
   *  restart re-emits today's line. That is consistent with the rest of the
   *  ladder's anchors (`exitFailureSince` and the failure throttle are the
   *  same shape), and a duplicate on a condition that stands for months is
   *  the cheap side of the trade. Do not read "once per ET day" as literal
   *  across restarts. */
  private calendarReportedOn: string | null = null;
  /** Unregistered rows seen once with an open row over a null mirror. The
   *  ghost sweep nulls the mirror while a bracket fill has not yet reached the
   *  row, so one sighting is a normal exit and only a later one is reported.
   *  Dropped when the mirror is back, the row is no longer open, or the
   *  deployment leaves the candidate set. */
  private unregisteredNullMirrorSeen = new Set<string>();

  private readonly mayFlatten = leaseGate(
    "the session-end guard",
    "Its flatten is left to the process that holds the lease.",
  );

  constructor(private readonly deps: SessionGuardDeps) {}

  /**
   * One clock-driven pass. For every deployment the engine could exit —
   * whether or not the engine is running — force-flat any open position that
   * has fallen outside all of its session windows.
   *
   * Ordering inside the loop is load-bearing. The contract resolve is the one
   * await, and it happens *before* `DeploymentState.position` is read, so the
   * read and the dispatch that consumes it are separated by nothing. The
   * pre-check earlier in the loop reads `position` too, but only to decide
   * whether the resolve is worth paying for — the value it sees is never the
   * one handed to `placeExitOrder`.
   */
  async runSessionEndGuard(): Promise<void> {
    const candidates = this.collectCandidates();
    const candidateIds = new Set(candidates.map((c) => c.deployment.id));
    for (const id of this.unregisteredNullMirrorSeen) {
      if (!candidateIds.has(id)) this.unregisteredNullMirrorSeen.delete(id);
    }
    if (candidates.length === 0) return;

    const now = new Date();
    this.reportCalendarHorizon(now);
    for (const { deployment, openTradeContractId } of candidates) {
      const pre = this.deps.stateFor(deployment.id);
      if (pre?.position || openTradeContractId === null) {
        this.unregisteredNullMirrorSeen.delete(deployment.id);
      }
      if (!pre?.position) {
        // Nothing to force flat. A tick-driven exit that already fired left
        // `position` null here, which is the no-op this guard should be in
        // realtime mode — and it is the common case, so it stays silent.
        //
        // It is *not* the only way to arrive here. A leg carrying a DB-open
        // trade row past its session close with a null mirror is the
        // 2026-08-25 incident: the union that exists to catch exactly that leg
        // discarded it on this line, said nothing, and the operator found the
        // position by looking at the broker. See below.
        if (openTradeContractId !== null) {
          this.reportNullMirror(deployment, openTradeContractId, now);
          continue;
        }
        this.clearFailure(deployment.id);
        continue;
      }

      const strategy = getStrategy(deployment.strategyKey);
      if (!strategy) {
        this.reportUnregistered(deployment, now);
        continue;
      }

      const sessionWindows = this.sessionWindowsFor(deployment, strategy);
      if (isInTradableSessionWindow(now, sessionWindows)) {
        this.clearFailure(deployment.id);
        continue;
      }

      let contract: Contract;
      try {
        contract = await this.deps.resolveContract(deployment.ticker, deployment.accountId);
      } catch (err) {
        this.reportFailure(deployment, now, `contract resolve failed: ${message(err)}`);
        continue;
      }

      // Another flatten actor put a market order against this (account,
      // contract) inside the last window and it may still be unbooked. Skip
      // *this pass* only: the failure anchor is deliberately left alone, so a
      // position that keeps being deferred keeps escalating, and the next
      // 15s pass retries. The exit latch cannot cover this — the watchdog
      // bypasses `placeExitOrder` and sets no latch.
      const contractId = executionContractId(contract);
      if (this.deps.flattenCooldown.active(deployment.accountId, contractId)) {
        this.deps.logEvent(
          "flatten_deferred",
          deployment.id,
          `[SESSION] Another flatten on ${contractId} may still be unbooked — deferring this pass; ` +
            `the position is past its session close and will be retried in ${Math.round(SESSION_END_GUARD_INTERVAL_MS / 1000)}s`,
          { accountId: deployment.accountId, contractId },
        );
        continue;
      }

      // Re-read after the resolve. The pre-check's value is stale by now:
      // `handleUserPositionEvent` is void-dispatched with no `ticking` guard,
      // so a close event landing during the resolve nulls `position`
      // underneath us, and `placeExitOrderInner` would read `.side` off null.
      const deplState = this.deps.stateFor(deployment.id);
      const position = deplState?.position;
      if (!deplState || !position) {
        this.clearFailure(deployment.id);
        continue;
      }
      // Immediately before the dispatch, after the resolve's await: the guard
      // survives `stop()`, so a lost lease does not disarm it.
      if (!this.mayFlatten()) return;

      // Two ways to be out of session and they read differently to an
      // operator. The declared window ending is the everyday one; the
      // exchange closing early leaves the leg *inside* its window, and a line
      // naming `09:30–15:55` at 12:55 would look like a bug in the guard.
      // The `{time}` slot follows the same split — `mostRecentWindowEnd`
      // would name 15:55 for a session that ends at 13:00. `processDeployment`
      // carries the same split, because either of the two can be the actor.
      //
      // Present tense: the cushion puts this line five minutes *ahead* of the
      // published halt, so "closed early" would be a claim about a market
      // that is still open.
      const earlyClose = isInEarlyCloseHalt(now) ? earlyCloseFor(etDateKey(now)) : null;
      const windowList = sessionWindows.map((w) => `${w.start}–${w.end}`).join(", ");
      const sessionEnd = earlyClose ?? mostRecentWindowEnd(now, sessionWindows);
      const cause =
        earlyClose != null
          ? `the exchange closes early at ${earlyClose} NY, inside the session window (${windowList} NY)`
          : `outside all session windows (${windowList} NY)`;
      this.deps.logEvent(
        "session_end_flatten",
        deployment.id,
        `[SESSION] Clock guard: ${cause} — force-exiting`,
        {
          accountId: deployment.accountId,
          contractId,
          tradeId: deplState.activeTradeId,
          ...(sessionEnd != null ? { values: { time: `at ${sessionEnd} NY` } } : {}),
        },
      );
      // Stamped *before* the submit, never after it: the window this closes is
      // the round trip itself.
      this.deps.flattenCooldown.note(deployment.accountId, contractId, "session");
      try {
        await this.deps.placeExitOrder(
          strategy,
          deployment,
          contract,
          position,
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
        this.clearFailure(deployment.id);
      } catch (err) {
        // The latch refused because an exit for this deployment is already on
        // the wire — which is the outcome this guard wanted. Not a failure,
        // and reporting it as one would raise a compliance alarm at the exact
        // moment the flatten it is alarming about is succeeding.
        //
        // **The cooldown stamp is deliberately kept here**, unlike D-2's. D-2
        // takes an `EXIT_IN_FLIGHT` from the *claiming* deployment's own exit
        // against a different position, so its stamp describes nothing. This
        // guard's latch, deployment and contract are all the same one, so an
        // exit really is in flight against this (account, contract) — which is
        // exactly what the stamp is for. The tick-driven exit path stamps
        // nothing of its own, so dropping it here would leave the watchdog
        // unguarded for that exit's whole fill latency.
        if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
          this.clearFailure(deployment.id);
          continue;
        }
        // Nothing reached the wire: `placeExitOrderInner` cannot throw past a
        // successful `placeOrder` — the DB attach is caught locally and the
        // verification pass is void-dispatched — so every throw arriving here
        // is a rejected order, a failed positions read, a refused latch or an
        // `EXIT_FLAT_MISMATCH` (broker flat against an open row).
        // Releasing keeps the compliance retry at one pass rather than two,
        // and `release` cannot drop another actor's stamp.
        this.deps.flattenCooldown.release(deployment.accountId, contractId, "session");
        // Position is deliberately kept so the next pass retries.
        this.reportFailure(deployment, now, `exit dispatch failed: ${message(err)}`, contractId);
      }
    }
  }

  /**
   * Say out loud that the early-close calendar is running out, once per ET
   * day, on a ladder that escalates *before* the horizon rather than after
   * it.
   *
   * **Past the horizon the platform keeps trading on the declared window** —
   * it does not stand the account down. That is the judgement call in this
   * change. Standing down converts a table that takes ten minutes to extend
   * into a certain loss of every session until someone does; the exposure it
   * would buy off is the nine or ten early closes a year, each published
   * weeks ahead. What the platform must not do is assume a normal close
   * *silently*, so the ladder is: nothing until a quarter out, a durable
   * `warn` from there, and an escalating `error` from a month out that keeps
   * repeating for as long as the table is short.
   *
   * Placed after the candidate set is collected, so an idle box with nothing
   * deployed says nothing — there is no position for a stale calendar to be
   * wrong about, and a daily line on an engine holding nothing is the kind of
   * alarm an operator learns to skip.
   */
  private reportCalendarHorizon(now: Date): void {
    const { state, daysRemaining } = calendarHorizonState(now);
    if (state === "fresh") return;
    const today = etDateKey(now);
    if (this.calendarReportedOn === today) return;
    this.calendarReportedOn = today;

    if (daysRemaining > CALENDAR_HORIZON_ESCALATE_DAYS) {
      this.deps.log(
        ENGINE_SCOPE,
        "warn",
        "safety",
        `[SESSION] The exchange early-close calendar runs out in ${daysRemaining} days (${EARLY_CLOSE_CALENDAR_THROUGH}). ` +
          "Past that date the session-end flatten cannot tell a half-day from a full session and will assume a full one — extend the table in exchange-calendar.ts.",
      );
      return;
    }
    const overdue = daysRemaining < 0;
    this.deps.logEvent(
      "session_calendar_stale",
      ENGINE_SCOPE,
      `[SESSION] The exchange early-close calendar ends ${EARLY_CLOSE_CALENDAR_THROUGH} and ` +
        (overdue
          ? `ran out ${-daysRemaining} days ago — every session-end flatten since has assumed a full session, and an exchange early close would be carried to the 18:00 reopen. `
          : `runs out in ${daysRemaining} days — after that the session-end flatten will assume every session closes at its normal time. `) +
        "Extend the table in exchange-calendar.ts.",
    );
  }

  /**
   * The smoke alarm for a null position mirror on a leg the database says is
   * still open.
   *
   * **This does not fix the null mirror — that is not root-caused.** On
   * 2026-08-25 a Topstep leg held a position past its 14:40 cutoff, the mirror
   * was null, this guard skipped it silently, and the incident showed
   * `ERROR (0)` throughout. The DB half of the candidate union exists to catch
   * a leg the in-memory set lost, and the `!pre?.position` check discarded
   * every one of them.
   *
   * A null mirror is *legitimate* while the window is open, and legitimate
   * when the leg is genuinely flat — which is why the silent arm keys off the
   * absence of an open trade row rather than off the mirror. It is never
   * legitimate with an open row, a closed window and no mirror, and that is
   * the only combination that reaches an `error` here.
   *
   * Routed through `reportFailure` for its throttle and its stranded-for-Ns
   * counter: the guard retries every 15s and will keep finding the same null,
   * so an unthrottled line is four a minute in the log carrying the incident.
   *
   * A row whose playbook this build does not register has no window to test,
   * so it cannot wait for the close: an open row is reported as unregistered,
   * in or out of what its window would have been — from the second sighting,
   * because the ghost sweep nulls the mirror ahead of a bracket fill reaching
   * the row, and one sighting is an ordinary exit.
   */
  private reportNullMirror(deployment: Deployment, contractId: string, now: Date): void {
    const strategy = getStrategy(deployment.strategyKey);
    if (!strategy) {
      if (!this.unregisteredNullMirrorSeen.has(deployment.id)) {
        this.unregisteredNullMirrorSeen.add(deployment.id);
        return;
      }
      this.reportUnregistered(deployment, now);
      return;
    }
    if (isInTradableSessionWindow(now, this.sessionWindowsFor(deployment, strategy))) {
      this.clearFailure(deployment.id);
      return;
    }
    this.reportFailure(
      deployment,
      now,
      `the engine holds no position for ${deployment.ticker} on ${contractId} but its trade row is still open, ` +
        "so there was nothing to submit and the position may still be open at the broker — flatten it by hand if it is",
    );
  }

  /** The merged session windows for one deployment. Two callers, and both are
   *  on paths that already decided the work is worth paying for. */
  private sessionWindowsFor(deployment: Deployment, strategy: StrategyModule): SessionWindow[] {
    const params = {
      ...defaultParamValues(strategy.params),
      ...migrateLegacyParamOverrides(deployment.strategyKey, deployment.paramValues, {
        deploymentId: deployment.id,
      }),
    } as CommonParams;
    return collectSessionWindows(strategy.config.session, params);
  }

  /**
   * Deployments this pass may act on: the engine's exit-loop set, unioned
   * with every deployment carrying a DB-open trade.
   *
   * The union is what makes the guard's lifetime key off *whether a position
   * is open* rather than engine run state, which is the whole point of not
   * disarming it in `stop()`. `stop()` clears `realtimeDeployments` but not
   * `this.state`, so without the DB half a stopped engine — and both
   * fatal-auth paths stop the engine themselves — would arm an interval that
   * could never find anything. It also covers a leg dropped from the
   * deployment set by a `sync()` while still holding a position.
   *
   * **The open-trade half is recorded on every candidate, not only on the
   * ones it contributed.** A leg the engine still lists *and* holds an open
   * row for is the 2026-08-25 incident's leg, and the earlier `has()` skip
   * threw that fact away for exactly those — leaving the DB half able to add
   * a deployment but never to say anything about one already present.
   */
  private collectCandidates(): SessionCandidate[] {
    const byId = new Map<string, SessionCandidate>();
    for (const d of this.deps.realtimeDeployments()) {
      if (this.deps.isLegInExitLoop(d)) {
        byId.set(d.id, { deployment: d, openTradeContractId: null });
      }
    }
    try {
      for (const trade of getAllOpenTrades()) {
        const existing = byId.get(trade.deploymentId);
        if (existing) {
          existing.openTradeContractId = trade.contractId;
          continue;
        }
        const d = getDeployment(trade.deploymentId);
        if (d) byId.set(d.id, { deployment: d, openTradeContractId: trade.contractId });
      }
    } catch {
      // Best-effort: a DB hiccup must not keep the guard from sweeping the
      // deployments it already has in memory.
    }
    return [...byId.values()];
  }

  /**
   * Escalate on the first failure, then throttle. The guard is the last
   * clock-driven thing standing between an open position and a prop-firm rule
   * violation, so a failure here is an `error` and says how long it has been
   * failing — an operator reading `/logs` needs "for 12 minutes", not "again".
   */
  private reportFailure(
    deployment: Deployment,
    now: Date,
    detail: string,
    contractId: string | null = null,
  ): void {
    const stranded = this.throttle(deployment.id, now);
    if (stranded == null) return;
    // The one line here the ladder sends to Discord. This guard is the last
    // clock-driven thing between an open position and a prop-firm rule
    // violation, which is why it names an event rather than logging plain
    // prose: the event is what gives it a subject and a destination. Keep it
    // named — a bare `log()` here would be durable, correct and unread.
    this.deps.logEvent(
      "session_exit_stranded",
      deployment.id,
      `[SESSION] Clock guard could not force-flat past session close — ${detail}. ` +
        `Position has been outside its session window for ${stranded}s and is still open; retrying every ${Math.round(SESSION_END_GUARD_INTERVAL_MS / 1000)}s.`,
      { accountId: deployment.accountId, contractId },
    );
  }

  /**
   * A position on a row whose playbook this build does not register
   * (strategies/prod-playbooks.ts decides prod's) — in the mirror, or in an
   * open trade row behind a null mirror. There is no window to
   * test and no module to build an exit from, so the guard can neither tell
   * whether the session has ended nor flatten — and says so on the failure
   * throttle rather than skipping. Not `session_exit_stranded`: that names a
   * window that ended, which this arm cannot check. No broker call.
   */
  private reportUnregistered(deployment: Deployment, now: Date): void {
    const seen = this.throttle(deployment.id, now);
    if (seen == null) return;
    this.deps.logEvent(
      "deployment_playbook_unavailable_in_position",
      deployment.id,
      `[SESSION] Clock guard cannot read this leg's session window or build its exit — ${deployment.strategyKey} ` +
        `is not part of this build${seen > 0 ? `, and the position has stood unmanaged for ${seen}s` : ""}. ` +
        "Nothing will flatten it at the session close; flatten it from its Dashboard row.",
      { accountId: deployment.accountId },
    );
  }

  /** Seconds since the first failure, or null inside the report window. */
  private throttle(deploymentId: string, now: Date): number | null {
    const nowMs = now.getTime();
    const since = this.exitFailureSince.get(deploymentId) ?? nowMs;
    this.exitFailureSince.set(deploymentId, since);
    const lastReported = this.exitFailureReportedAt.get(deploymentId);
    if (lastReported != null && nowMs - lastReported < SESSION_END_GUARD_FAILURE_REPORT_MS) return null;
    this.exitFailureReportedAt.set(deploymentId, nowMs);
    return Math.round((nowMs - since) / 1000);
  }

  private clearFailure(deploymentId: string): void {
    this.exitFailureSince.delete(deploymentId);
    this.exitFailureReportedAt.delete(deploymentId);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
