// Restart semantics — P6 of docs/proposals/position-lifecycle.md, D-13 and
// D-14.
//
// **The trigger is duration unmanaged, not the stop event.** D-7 as written
// flattened everything on every deploy, because "no engine means no Active
// deployment" plus "not Active means flat" fires on a twenty-second redeploy.
// What actually matters is how long the position went without a manager:
// twenty seconds flattens nothing, four hours probably should — session
// windows passed, break-even and trailing never ran, and the operator's model
// of what is happening is stale.
//
// Two signals, doing two different jobs, and this module keeps them apart:
//
//   heartbeat `last_seen_at`  → how long unmanaged → **flatten or not**
//   clean-shutdown marker     → was it intentional → **alarm or not**
//
//   | case                                   | flatten | alarm |
//   |----------------------------------------|---------|-------|
//   | marker + short gap — planned redeploy  | no      | no    |
//   | no marker + short gap — crashed, fast  | **no**  | yes   |
//   | long gap, either way                   | yes     | yes   |
//
// A crash with a short gap does not flatten: the position survived, the
// brackets are live at the broker, and flattening would realize a P&L nobody
// asked for on a position that was fine. A crash is a *reliability* signal,
// not a position-safety one — which is also exactly where the marker earns its
// keep, because a crash loop recovering in fifteen seconds never trips the
// duration threshold and looks perfectly healthy from the position's point of
// view.
//
// **The SIGTERM handler may only record, never act.** `docker stop` allows 30
// seconds before SIGKILL (as the deploy runs it), nowhere near enough to cancel brackets
// and flatten across N deployments with broker round-trips in each. So the
// flatten can only ever happen on the *next boot*, which is what
// `RestartFlattenGuard` below is. The marker write is one synchronous
// better-sqlite3 statement to the volume already mounted at `/app/data`,
// ordered ahead of the DB close by `registerPreCloseHook` rather than by
// import order — and the grace is 30s rather than Docker's default 10s so the
// write cannot lose to SIGKILL while the handler waits for a busy main thread.
//
// Nothing here is CI-specific: the app writes the marker on SIGTERM and
// SIGINT, so it covers `docker stop`, systemd and a manual restart alike —
// including Ctrl-C under `next dev`, whose own SIGINT handler exits first
// unless the close handler is prepended ahead of it (`connection.ts`, A51).

import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import type { Contract } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { OpenPosition, StrategyModule } from "../../strategy-types";
import type { DeploymentState, LogSubject } from "../engine";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import type { FlattenCooldown } from "../engine-flatten-cooldown";
import { formatGapDuration } from "@/lib/logging/duration";
import { registerPreCloseHook, runShutdownSequence } from "@/lib/db/connection";
import { flushBeforeExit, flush as flushEngineLogs } from "@/lib/db/engine-logs";
import { HANDOFF_TRIGGER, markShutdownDraining } from "@/lib/shutdown-drain";
import { appRole, runsEngine } from "@/lib/role";
import {
  acceptHandoff,
  describeLeaseHolder,
  handoffRequestedBy,
  holdsLease,
  leaseGate,
  leaseHolderId,
  readLease,
  releaseLeaseForExit,
  renewLease,
  LEASE_FRESH_MS,
  LEASE_RENEW_MS,
} from "@/lib/db/lease";
import {
  consumeCleanShutdownMarker,
  consumeHeartbeatDegradedMarker,
  markCleanShutdown,
  markHeartbeatDegraded,
  readEngineRestartState,
  recordUncleanResume,
  stampEngineHeartbeat,
  type OwedFlatten,
  type PendingFlatten,
} from "@/lib/db/engine-restart";
import { executionContractId } from "../../broker-access/contract-resolver";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { log } from "@/lib/logger";

// ── Provisional values — a release gate, not settled ───────────────────────
//
// All three were taken as operator defaults on 2026-08-24 to unblock this
// phase, not decided on evidence. Each is one line to retune; what is not free
// is nobody noticing they were never revisited. Re-review before this ships.
// See the *Values* table in docs/proposals/position-lifecycle.md.

/** How long a position may go unmanaged before the next boot flattens it.
 *  **Provisional: 10 minutes** — longer than any plausible deploy, far shorter
 *  than a session window. Wants measuring against real deploy
 *  durations rather than argued. */
export const UNMANAGED_FLATTEN_MS = 10 * 60_000;

/** Window over which unclean death→resume cycles are counted.
 *  **Provisional: 15 minutes.** */
export const RESUME_FLAP_WINDOW_MS = 15 * 60_000;

/** Cycles inside that window before the flap breaker trips.
 *  **Provisional: 3** — a crash loop is obvious by three, and a genuine
 *  one-off blip never reaches it. */
export const RESUME_FLAP_LIMIT = 3;

// ── Everything below is mechanism, not policy ──────────────────────────────

/** Cadence of the boot-time flatten sweep. Matches `REST_TICK_MS` and the
 *  three sibling guards so this adds no new timing regime. The sweep exists
 *  only while something is pending and disarms itself once drained. */
export const RESTART_FLATTEN_INTERVAL_MS = 15_000;

/** How often a persistent failure is re-reported per deployment. Same shape
 *  and the same reason as the session and closing guards': the broker being
 *  unreachable is the *most likely cause of the outage this sweep is cleaning
 *  up after*, so it will retry and fail every interval, and four lines a
 *  minute per stranded deployment drowns the log carrying the incident. */
export const RESTART_FLATTEN_FAILURE_REPORT_MS = 300_000;

/** Exit reason stamped on a position closed because it went unmanaged for
 *  longer than the duration rule allows. Distinct from `deployment_close`
 *  (the operator asked) and `time_window_close` (the session ended): this one
 *  says the engine was not there, which is the only one of the three that is
 *  an incident. */
export const ENGINE_DOWNTIME_EXIT_REASON: ExitReasonCode = "engine_downtime";

/** Cadence of the process-liveness stamp — 60s, currently four tick periods.
 *  (`REST_TICK_MS` is private to `engine.ts` and importing it here would be
 *  the upward edge this module refuses; the relationship is stated, not
 *  depended on.)
 *
 *  It only has to keep `last_seen_at` inside the duration rule's tolerance,
 *  and the rule's threshold is `UNMANAGED_FLATTEN_MS` — ten minutes — so the
 *  worst reading this cadence can manufacture is one minute of phantom gap on
 *  top of the real stop-to-start window. Faster buys nothing and puts a write
 *  on the tick regime for no reader; slower starts eating into a threshold
 *  that exists to measure something else. */
export const PROCESS_LIVENESS_INTERVAL_MS = 60_000;

/** How often a failing liveness stamp is re-reported. Same window as the
 *  tick stamper's, for the same reason: a wedged database fails every
 *  interval, and the record only has to land once. */
const LIVENESS_WRITE_WARN_MS = 300_000;

/** How long a run of declined stamps (the row read throwing every time) may
 *  stand before the report becomes a flagged `error`. Thirty minutes is three
 *  times `UNMANAGED_FLATTEN_MS`: by then the frozen `last_seen_at` already
 *  guarantees the next boot force-flattens whatever is open, so the phone has
 *  to ring before that boot does, while a lock that clears on the next pass
 *  never gets near it. */
const LIVENESS_DECLINE_ESCALATE_MS = 30 * 60_000;

let livenessTimer: ReturnType<typeof setInterval> | null = null;
let livenessHookInstalled = false;
let livenessWarnedAt = 0;
// Its own anchor rather than the write arm's, for the reason the exit
// cluster keeps two: they are different conditions, and one sharing a stamp
// with the other means whichever spoke first silences the one that has not.
let gateWarnedAt = 0;
/** First decline of the current unbroken run of row-read failures; null
 *  when the last read answered. */
let gateDeclineRunSince: number | null = null;

/**
 * What the liveness stamp is allowed to claim about this process, injected
 * rather than imported.
 *
 * **The direction is why it is a dep.** `engine-singleton` imports `engine`,
 * `engine` imports this module, so reaching *up* for `getEngineIfReady()`
 * here closes a runtime cycle through the file that constructs the engine.
 * `boot-engine` already imports both sides and is the single caller, so the
 * predicate is composed there and handed down.
 */
export interface LivenessGate {
  /** Is an engine constructed and running in this process. False before the
   *  engine exists and after either `stop()`. */
  engineRunning(): boolean;
  /** Does the database still hold a trade row the engine is meant to be
   *  managing — `pending_entry | open | pending_exit`. */
  openTradesExist(): boolean;
}

/**
 * **The stamper stamps unless the engine is stopped while open trade rows
 * exist**, which is the whole of the rule and the narrowing it closes.
 *
 * A57 made `last_seen_at` prove *process alive* rather than *work happening*,
 * which is right for the state it was written for — an idle box with nothing
 * to manage — and wrong for one it swept in with it: a fatal-auth `stop()` on
 * a live process kept stamping all night, so the next boot read seconds of
 * gap for a position that genuinely went unmanaged for hours and adopted it
 * instead of flattening it. Gating on the *engine* alone would re-conflate
 * idleness with absence and put A57 straight back; gating on rows alone would
 * stop a healthy trading engine stamping. It takes both.
 *
 * So: an idle process with nothing to manage stamps, a running engine stamps
 * whatever it holds, and a **stopped** engine holding rows does not — the gap
 * accrues exactly as it did before A57, which is what makes a manual
 * Stop-with-positions and a fatal-auth stop behave the way they always have
 * (flatten at the next boot past `UNMANAGED_FLATTEN_MS`).
 *
 * **The two predicates have different throw arms, and one `try` around both
 * gave the wrong one to `engineRunning`.** A throwing `engineRunning` means
 * *this process cannot say whether an engine is running*, which is not the
 * same claim as "rows may exist" — it is the pre-engine reading the gate
 * already has a name for, so it falls through to the row predicate, which is
 * the half that decides. A throwing `openTradesExist` is the one the
 * flatten-ward bias is about: **read as "rows may exist" and the stamp is
 * declined.** That is the opposite bias from `heartbeatDegraded`'s and the
 * asymmetry is deliberate — a silent non-stamp costs a flatten of a position
 * that was probably fine, and a silent stamp costs an unmanaged position
 * nobody will ever be told about. This one fails toward *measuring* the gap.
 *
 * **What it must not be is silent.** A standing `strategy_trades` read fault
 * freezes `last_seen_at` for as long as it lasts, and the next boot reads a
 * phantom gap and force-flattens with nothing in `/logs` saying why. The
 * decline therefore speaks, throttled on the write arm's window because a
 * wedged read fails every interval and the operator only needs telling once.
 * It does **not** set `heartbeatDegraded`: nothing was attempted, and marking
 * it would downgrade the very flatten this arm exists to allow.
 *
 * **A run that outlasts `LIVENESS_DECLINE_ESCALATE_MS` ratchets** to the
 * flagged `liveness_gate_unreadable_persistent`, on the same anchor and window,
 * so each window carries one line or the other, never both. The decline
 * itself does not change: the ratchet makes the standing fault page, it does
 * not make the gate stamp.
 */
function mayStamp(gate: LivenessGate, now: number): boolean {
  let running = false;
  try {
    running = gate.engineRunning();
  } catch {
    // Cannot say, so do not claim: fall through to the row predicate.
  }
  if (running) return true;
  let rowsExist: boolean;
  try {
    rowsExist = gate.openTradesExist();
  } catch (err) {
    reportGateDecline(now, err);
    return false;
  }
  if (gateDeclineRunSince != null) {
    gateDeclineRunSince = null;
    log.event(
      "liveness_gate_readable_again",
      "engine",
      "Engine liveness gate can read the open trade rows again — the heartbeat stamp is back to its normal rule.",
    );
  }
  return !rowsExist;
}

function reportGateDecline(now: number, err: unknown): void {
  gateDeclineRunSince ??= now;
  if (now - gateWarnedAt < LIVENESS_WRITE_WARN_MS) return;
  gateWarnedAt = now;
  const said = `Database said: ${err instanceof Error ? err.message : String(err)}`;
  const standing = now - gateDeclineRunSince;
  if (standing > LIVENESS_DECLINE_ESCALATE_MS) {
    log.event(
      "liveness_gate_unreadable_persistent",
      "engine",
      `Engine heartbeat frozen for ${formatGapDuration(standing)}: the open trade rows cannot be read, ` +
        "so a restart now would count all of it as unmanaged time and force-flatten any open position. " +
        said,
    );
    return;
  }
  log.event(
    "liveness_gate_unreadable",
    "engine",
    "Engine liveness gate could not read the open trade rows — the heartbeat stamp is declined while that lasts, " +
      "so the next boot measures a gap it did not have and may force-flatten a position that was fine. " +
      said,
  );
}

/**
 * One liveness stamp, with the tick stamper's failure arm.
 *
 * **`heartbeatDegraded` keeps meaning "the write failed" and never "the
 * engine was idle."** That is the whole reason this reuses
 * `stampEngineHeartbeat` and `markHeartbeatDegraded` rather than inventing a
 * second signal: idleness stops being a state `last_seen_at` can be in at
 * all once the process stamps for itself, so the marker is left saying
 * exactly what it said before — the database would not take the write. A
 * stamp the gate above declines is therefore *not* degraded: nothing was
 * attempted, so there is nothing to report.
 */
function stampLiveness(gate: LivenessGate): void {
  const now = Date.now();
  if (!mayStamp(gate, now)) return;
  try {
    stampEngineHeartbeat(now);
  } catch (err) {
    try {
      markHeartbeatDegraded(now);
    } catch {
      // A database that cannot take either write leaves the next boot where
      // it was before this marker existed. Nothing further to try.
    }
    if (now - livenessWarnedAt < LIVENESS_WRITE_WARN_MS) return;
    livenessWarnedAt = now;
    log.warn(
      "engine",
      `Engine liveness heartbeat write failed: ${err instanceof Error ? err.message : String(err)} — ` +
        "the next boot is being told its duration reading is untrustworthy, so it will alarm rather than force-flatten",
    );
  }
}

/**
 * Stamp `last_seen_at` for as long as this process is alive, whatever it has
 * to trade. Idempotent; disarmed by the pre-close hook it installs. **A
 * second call while the interval is armed returns without replacing the
 * gate**, so the predicates in force are the first caller's — which is the
 * property `classifyBoot`'s memo already relies on and the one to know
 * before adding a second call site.
 *
 * **A57.** `noteEngineAlive()` is called from the two tick bodies and nowhere
 * else, so a process that boots to `no-deployments` never starts a tick loop
 * and never stamps: `last_seen_at` freezes at whatever instant the engine
 * last had work, and every restart after that reads the idle hours as
 * unmanaged time. Two staging deploys 508 seconds apart reported 45,132s and
 * 45,640s of "no engine activity" — the same frozen stamp, measured twice.
 * The column was conflating three states the duration rule needs apart: the
 * process was down, the process was up and ticking, and the process was up
 * and idle. **Only the first is unmanaged time**, and this is what makes the
 * other two indistinguishable from each other, which is what they are.
 *
 * The tick loops keep their own `noteEngineAlive()` call. The two are the
 * same statement written from two places, and the redundancy costs one
 * single-row UPDATE by integer primary key.
 *
 * **It is tied to `start()`/`stop()` in exactly one state**, and `mayStamp`
 * above is that state: a stopped engine on a live process is still a process
 * that can write, so a stop-then-start with nothing on the books closes its
 * own gap — but a stopped engine holding open rows has positions no one is
 * managing, and the column has to say so. What otherwise ends the stamp is
 * the process ending.
 */
export function startProcessLiveness(gate: LivenessGate): void {
  // A web process is not the engine's liveness; its stamp would hide an
  // engine process's absence from the duration rule.
  if (livenessTimer || !runsEngine()) return;
  stampLiveness(gate);
  livenessTimer = setInterval(() => stampLiveness(gate), PROCESS_LIVENESS_INTERVAL_MS);
  livenessTimer.unref?.();
  if (livenessHookInstalled) return;
  livenessHookInstalled = true;
  // Ordered ahead of `db.close()` structurally rather than by import order,
  // for the reason `registerPreCloseHook` exists — a stamp that fires after
  // the close would reopen the connection to claim liveness for a process
  // that is on its way out.
  registerPreCloseHook(stopProcessLiveness);
}

/** Disarm the liveness stamp. The pre-close hook above, and the test seam. */
export function stopProcessLiveness(): void {
  if (!livenessTimer) return;
  clearInterval(livenessTimer);
  livenessTimer = null;
  // A disarmed stamper declines nothing, so a run cannot span a re-arm.
  gateDeclineRunSince = null;
}

/** How often a renew that threw is re-reported. A wedged database fails every
 *  pass, and the operator needs telling once per window. */
const LEASE_RENEW_WARN_MS = 60_000;

let leaseTimer: ReturnType<typeof setInterval> | null = null;
let leaseExitReleaseInstalled = false;
let leaseRenewWarnedAt = 0;
/** Set when this process accepted a hand-off request; read by the exit's
 *  release to say what the release was for. */
let yieldingTo: { requester: string; acceptedAt: number } | null = null;

/**
 * What a lost lease does, injected for the reason `LivenessGate` is: the
 * engine sits above this module, and `boot-engine` composes the call.
 */
export interface LeaseRenewalDeps {
  onLost(): void;
}

/**
 * Renew the engine lease every `LEASE_RENEW_MS` for as long as this process
 * holds it. **Its own interval, not the liveness one**: the liveness stamp is
 * 60s and gated on the engine's state, and folding the renew into it would
 * either slow the lease to a minute — a crash restart waiting minutes for a
 * stale row — or put the liveness write on a 5s cadence and give its gate a
 * second job. The two say different things, so they keep separate clocks.
 *
 * **A renew that finds the lease gone stops the engine, and that is the one
 * thing the lease ever does.** Another process holds it, so continuing is two
 * engines on one account. A renew that *throws* is not a loss — the row may
 * still be ours — and only warns; if the failures outlast `LEASE_FRESH_MS`
 * another process may take it, and the first renew that lands sees that.
 *
 * **It runs until the process exits, through a stop's drain**, and the
 * release is the exit's (`releaseLeaseAtExit`): the drain can outlast
 * `LEASE_FRESH_MS`, and a lease left unrenewed through it would go stale
 * under a process still placing exits. Each renew that lands also asks
 * whether a standby wants the engine (`maybeYield`) — here rather than on
 * the tick, because an engine with nothing deployed, or stopped by an auth
 * failure, never ticks and would refuse every hand-off.
 */
export function startLeaseRenewal(deps: LeaseRenewalDeps): void {
  if (leaseTimer) return;
  // A process that yielded exits and never re-arms; a fresh arm has no yield.
  yieldingTo = null;
  leaseTimer = setInterval(() => renewOnce(deps), LEASE_RENEW_MS);
  leaseTimer.unref?.();
  if (leaseExitReleaseInstalled) return;
  leaseExitReleaseInstalled = true;
  // The exit listener, not the drain's exit step: the drain owns the exit on
  // SIGTERM and a hand-off, but SIGINT and any other `process.exit` do not go
  // through it, and a lease left held makes the next process wait for it to
  // go stale.
  process.once("exit", releaseLeaseAtExit);
}

/** Disarm the renew. The exit's release, a lost lease, and the test seam. */
export function stopLeaseRenewal(): void {
  if (!leaseTimer) return;
  clearInterval(leaseTimer);
  leaseTimer = null;
}

/**
 * The lease's release, as the last thing the process does: after the stop
 * sequence's marker and drain, whoever calls `process.exit` — the drain's
 * exit on a stop, anything else's otherwise. Nothing of this process runs after it, so no order it
 * places can follow the release, and a standby polling for a free lease
 * takes it at once. Synchronous throughout, as an exit listener must be.
 * Exported as the test seam.
 */
export function releaseLeaseAtExit(): void {
  try {
    stopLeaseRenewal();
    stopProcessLiveness();
    const released = releaseLeaseForExit();
    if (yieldingTo && released) {
      log.event(
        "handoff_yielded",
        "engine",
        `handoff: yielded the engine to ${yieldingTo.requester} — lease released ` +
          `${Date.now() - yieldingTo.acceptedAt}ms after the request was accepted, once order work had drained`,
      );
    }
  } catch (err) {
    log.warn(
      "engine",
      `Engine lease release at exit failed — the next engine waits up to ${LEASE_FRESH_MS / 1000}s for it to go stale. ` +
        `Database said: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    flushBeforeExit();
  } catch {
    // The store's flush reports its own failures; nothing is left to tell.
  }
}

/**
 * Yield to a standby that asked for the engine: accept the request, then run
 * the stop sequence with the hand-off as its trigger. **That is the whole of
 * the yield, and it is the SIGTERM path**: the marker hook raises the draining
 * latch and writes the marker, the drain waits for order work, and the exit
 * releases the lease. It places, cancels and closes nothing, and it does not
 * call `stop()` — the sweeps and controllers are left exactly where a SIGTERM
 * leaves them. The accept is the atomic half of the standby's withdraw, so a
 * standby that gave up at its bound is never yielded to.
 *
 * Only the `engine` role yields: an `all` process serves the UI too, and a
 * standby beside one refuses at its bound instead.
 */
function maybeYield(nowMs: number): void {
  if (yieldingTo || appRole() !== "engine") return;
  const self = leaseHolderId();
  const requester = handoffRequestedBy(self, nowMs);
  if (requester == null || !acceptHandoff(self, requester, nowMs)) return;
  yieldingTo = { requester, acceptedAt: nowMs };
  runShutdownSequence(HANDOFF_TRIGGER);
}

function renewOnce(deps: LeaseRenewalDeps): void {
  const now = Date.now();
  let held: boolean;
  try {
    held = renewLease(leaseHolderId(), now);
  } catch (err) {
    if (now - leaseRenewWarnedAt >= LEASE_RENEW_WARN_MS) {
      leaseRenewWarnedAt = now;
      log.warn(
        "engine",
        `Engine lease renew failed — if it keeps failing for ${LEASE_FRESH_MS / 1000}s another engine may take the lease ` +
          `and this one will stop. Database said: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (held) {
    try {
      maybeYield(now);
    } catch (err) {
      log.warn(
        "engine",
        `Engine could not read or accept a hand-off request; it keeps the engine and the standby refuses at its bound. ` +
          `Database said: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  stopLeaseRenewal();
  // After the `stop()` below the gate still stamps whenever no rows are open,
  // and `last_seen_at` is what measures the real engine's absence.
  stopProcessLiveness();
  let holder: string;
  try {
    holder = describeLeaseHolder(readLease(), now);
  } catch (err) {
    holder = `the lease row could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  log.event(
    "engine_lease_lost",
    "engine",
    `Engine lease lost — another process now runs the engine on this database, so this engine is stopping ` +
      `to avoid two engines trading one account. Lease: ${holder}.`,
  );
  deps.onLost();
}

/**
 * A gap as an operator reads it: `98s`, `14m`, `12h 40m`.
 *
 * **Moved to `logging/duration.ts`, re-exported here so every caller in this
 * module and in `boot-engine` is unchanged.** The `/logs` Activity lane
 * renders relative timestamps through it and that lane is a client
 * component; this file imports `db/connection` and the strategy loader, so a
 * direct import would drag both into the browser bundle — the same reason
 * `exit-reasons.ts` lives under `logging/`. There is still one
 * implementation, and it is that one.
 */
export { formatGapDuration };

export interface RestartInputs {
  /** Epoch ms at which a process was last alive on this database, or null if
   *  none ever has been. Not "the last tick": the liveness stamper runs
   *  whether or not anything is deployed, so an idle process is not an absent
   *  one here (A57). */
  lastSeenAt: number | null;
  /** Epoch ms of the consumed clean-shutdown marker, or null. */
  cleanShutdownAt: number | null;
  /** Epoch ms of the consumed degraded-heartbeat marker, or null. Non-null
   *  means a process was *alive and could not write* while it tried to stamp,
   *  so `lastSeenAt` measures a write failure rather than an absence. Never
   *  set for a stamp the liveness gate declined — that one is a measured gap
   *  on purpose. */
  heartbeatDegradedAt: number | null;
  nowMs: number;
  unmanagedFlattenMs?: number;
}

export interface RestartClassification {
  /** How long the engine was absent, in ms. Null when there is no prior
   *  heartbeat at all — a first boot has no gap, not a zero-length one. */
  gapMs: number | null;
  /** The previous stop wrote a marker, so it was intentional. */
  clean: boolean;
  /** The gap exceeded the duration rule. */
  flatten: boolean;
  /** Something happened the operator needs to hear about. */
  alarm: boolean;
  /** The previous process could not write its heartbeat, so `gapMs` is not a
   *  measurement of unmanaged time and the duration rule was not applied. */
  heartbeatDegraded: boolean;
}

export interface RestartVerdict extends RestartClassification {
  /** Unclean death→resume cycles inside `RESUME_FLAP_WINDOW_MS`, including
   *  this boot when this boot was one. */
  flapCycles: number;
  /** The flap breaker tripped: keep managing open positions, but take no new
   *  entries this process. */
  entriesSuspended: boolean;
  /** Epoch ms of the clean-shutdown marker this classification consumed.
   *  Read only by boot's timing line; absent on a verdict nothing classified. */
  cleanShutdownAt?: number | null;
}

/**
 * The decision, as a pure function of the two signals.
 *
 * **The marker cannot be stale**, which is why `clean` needs no freshness
 * check against `lastSeenAt`: it is *consumed* at boot, so a marker that
 * survives to be read here was written by the stop that immediately preceded
 * this boot. Without the consume, one clean shutdown would make every later
 * crash read as intentional.
 *
 * **A degraded heartbeat downgrades the flatten to an alarm.** `lastSeenAt`
 * answers one question by proxy — the engine was ticking, therefore it could
 * stamp — and the proxy fails whenever the write fails: twelve minutes of
 * locked-database or WAL-stalled writes on a *healthy, trading* engine present
 * here as twelve minutes of absence, and force-close everything. The duration
 * rule needs a reading it can trust, and a reading it cannot trust must fail
 * toward leaving positions alone. The alarm is kept, and is what tells the
 * operator the rule was not applied this boot.
 */
export function classifyRestart(input: RestartInputs): RestartClassification {
  const threshold = input.unmanagedFlattenMs ?? UNMANAGED_FLATTEN_MS;
  const clean = input.cleanShutdownAt != null;
  const heartbeatDegraded = input.heartbeatDegradedAt != null;
  if (input.lastSeenAt == null) {
    // Never ticked on this database: nothing went unmanaged, so there is
    // nothing to flatten and nothing to alarm about.
    return { gapMs: null, clean, flatten: false, alarm: heartbeatDegraded, heartbeatDegraded };
  }
  // Clamped: a clock stepping backwards must not read as a negative gap and
  // it must not read as a four-hour one either.
  const gapMs = Math.max(0, input.nowMs - input.lastSeenAt);
  const exceeded = gapMs > threshold;
  return {
    gapMs,
    clean,
    flatten: exceeded && !heartbeatDegraded,
    alarm: exceeded || !clean || heartbeatDegraded,
    heartbeatDegraded,
  };
}

/**
 * Classify this boot against durable state, and record the cycle if this boot
 * followed a crash. Reads and writes the database; the pure half above is
 * where the rule lives.
 */
export function evaluateRestart(nowMs: number = Date.now()): RestartVerdict {
  const state = readEngineRestartState();
  const marker = consumeCleanShutdownMarker();
  const degraded = consumeHeartbeatDegradedMarker();
  const classification = classifyRestart({
    lastSeenAt: state.lastSeenAt,
    cleanShutdownAt: marker,
    heartbeatDegradedAt: degraded,
    nowMs,
  });

  // Only a *crash* counts toward the flap breaker. A clean redeploy is not a
  // death, however many of them happen in fifteen minutes, and counting them
  // would suspend entries for a busy deploy afternoon.
  const isCrashResume = classification.gapMs != null && !classification.clean;
  const flapCycles = isCrashResume
    ? recordUncleanResume(nowMs, RESUME_FLAP_WINDOW_MS)
    : state.resumeCycles.filter((t) => nowMs - t <= RESUME_FLAP_WINDOW_MS).length;

  return {
    ...classification,
    flapCycles,
    entriesSuspended: flapCycles >= RESUME_FLAP_LIMIT,
    cleanShutdownAt: marker,
  };
}

/**
 * What the previous process was still owed when it stopped.
 *
 * **Read at every boot, whatever *this* boot's verdict is.** The obligation is
 * D-7's, and D-7's requirement is that it survives the process — so it cannot
 * be gated on the new classification. The sequence that makes this concrete:
 * a four-hour outage decides `flatten`, the broker is still unreachable, the
 * sweep retries every 15s and errors every 5 min, and the operator restarts
 * the container to clear the broker connection. The heartbeat was stamped
 * throughout the retries, so the next boot measures a 30-second gap and
 * classifies "keep" — and the set the previous boot judged unsafe would be
 * gone with the process that held it.
 *
 * A database that cannot answer yields an empty set and a throw the caller
 * reports; an unreadable obligation is one nothing can act on either way.
 *
 * **An entry with no seed instant of its own takes this read's**, and this is
 * the only place that substitution happens. `seededAt` reads as `0` for an id
 * a legacy payload carried without an instant or for a value nothing could
 * parse, and `0` would refuse that entry outright (every open row is newer),
 * silently discarding a genuine obligation. Reading it as "now" is the
 * conservative half of the same invariant — every position an obligation is
 * about predates the boot carrying it — and doing it here keeps both readers of
 * this payload, the boot path and `start()`, on one answer.
 */
export function readOwedFlatten(nowMs: number = Date.now()): PendingFlatten {
  const owed = readEngineRestartState().pendingFlatten;
  return {
    ...owed,
    entries: owed.entries.map((e) => (e.seededAt > 0 ? e : { ...e, seededAt: nowMs })),
  };
}

let markerInstalled = false;

/**
 * Arrange for a clean-shutdown marker on SIGTERM / SIGINT, and on a hand-off's
 * yield, which runs the same stop sequence. Idempotent.
 *
 * Registered as a DB pre-close hook rather than as its own signal handler, so
 * the write is ordered ahead of `db.close()` structurally instead of by
 * whichever module imported first — see `registerPreCloseHook`.
 */
export function installCleanShutdownMarker(): void {
  // A web process stopping says nothing about whether the engine stopped.
  if (markerInstalled || !runsEngine()) return;
  markerInstalled = true;
  registerPreCloseHook((signal) => {
    // A refusal, not an action: SIGTERM does not stop the engine, so its
    // ticks run through the drain, and a bar closing there must not start an
    // entry the exit then cuts. Exits and stop moves still run.
    markShutdownDraining();
    // The stop's start as the log sees it; queued in memory, so the marker
    // below is still the first thing this handler writes.
    log.event("shutdown_signal", "engine", `restart: ${signal} received — this process was told to stop`, {
      meta: { msSinceProcessStart: Math.round(performance.now()) },
    });
    // A process that lost the lease is not the engine: its marker would tell
    // the real engine's next boot that a stop nobody made was intentional.
    if (!holdsLease()) {
      log.warn(
        "engine",
        `restart: no clean-shutdown marker written on ${signal} — this process does not hold the engine lease, ` +
          "so the stop is not the engine's",
      );
      flushEngineLogs();
      return;
    }
    markCleanShutdown(Date.now());
    log.event(
      "shutdown_marker_written",
      "engine",
      `restart: clean-shutdown marker written on ${signal}`,
    );
    // The lease is not released here. It stays held, and renewed, through
    // the drain — this process may still place exits there — and the exit
    // releases it (`releaseLeaseAtExit`), so no process takes it while this
    // one can still act.
    //
    // The log store's own SIGTERM flush runs ahead of every pre-close hook,
    // so the two lines above would wait on its 5s timer — after the close,
    // and after the process now exits in about a second. Flushed here they
    // reach `engine_logs` and the next process's `/logs`.
    flushEngineLogs();
  });
}

/**
 * Engine-internal surface the boot-time flatten sweep calls back into.
 * Mirrors `ClosingGuardDeps` — bound callbacks rather than flipped access
 * modifiers.
 *
 * **`stateFor` must stay synchronous**, for the reason stated on
 * `SessionGuardDeps`: no `await` may sit between reading
 * `DeploymentState.position` and calling `placeExitOrder`.
 */
export interface RestartGuardDeps {
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
  getDeployment(deploymentId: string): Deployment | null;
  /** True while a `strategy_trades` row for this deployment is still
   *  `pending_entry` / `open` / `pending_exit`. The durable half of "is it
   *  flat" — unlike `DeploymentState.position` it is not cleared at exit
   *  *submission*, which is what makes it the right thing to drain on. */
  hasOpenTrade(deploymentId: string): boolean;
  /** Epoch ms the deployment's open trade row started, or null when there is
   *  none. Read off the same row `hasOpenTrade` answers from, and it is what
   *  gives the obligation a trade identity: the id says *which deployment*,
   *  this says *which position*. */
  openTradeStartedAt(deploymentId: string): number | null;
  /** Non-creating state read. See the note on this interface. */
  stateFor(deploymentId: string): DeploymentState | undefined;
  /** Replace the durable record of what is still owed. Called on every
   *  mutation of the pending set — the seed and each drain — so a process
   *  that dies mid-sweep hands the remainder to the next boot. Best-effort:
   *  the binding reports a failure and never throws, because a flatten that
   *  cannot be recorded must still be attempted. */
  persistPending(entries: readonly OwedFlatten[], gapMs: number): void;
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  placeExitOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    activeTradeId: number | null,
    reason: string,
  ): Promise<void>;
  /** The engine-owned instance every flatten actor shares. This sweep is one
   *  of four that can put a market order against the same (account,
   *  contract), and the naked-position watchdog — which bypasses
   *  `placeExitOrder` entirely — is invisible to the exit latch in both
   *  directions. See engine-flatten-cooldown.ts. */
  flattenCooldown: FlattenCooldown;
}

/**
 * D-13's flatten, which can only ever run on the next boot.
 *
 * Seeded once from the boot path with the deployments that were holding a
 * position while nobody was managing it — this boot's own set, plus whatever a
 * previous boot was still owed. Drains on **confirmed flat** — the trade row
 * going away — not on a successful submission, so a rejected exit, an
 * unreachable broker or a partial fill all simply retry on the next pass. That
 * is the closing guard's rule, and it is what makes the sweep safe to run
 * against a deployment it has already acted on.
 *
 * **The pending set is durable, and that is the property D-7 asked for by
 * name.** Every mutation writes through to `engine_restart.pending_flatten`,
 * so the obligation belongs to the database rather than to this process; the
 * boot path re-seeds from it regardless of the new boot's verdict. An
 * in-memory-only set is lost by exactly the event the sweep's own retry loop
 * provokes — see `readOwedFlatten` for the sequence.
 *
 * **Durability is what makes the position identity necessary.** A set that
 * outlives the process that took it on can outlive the *position* it was about
 * — so every entry carries its own `seededAt`, and a trade row that started
 * after it is not the one owed. Without that, an obligation from a four-hour
 * outage force-closes whatever happens to be open under the same deployment id
 * when the sweep finally reaches it.
 *
 * **The instant belongs to the entry, not to the set.** A merged set holds a
 * carried obligation and one this boot computed, taken on hours apart; a
 * single threshold across both refuses whatever the *earlier* one refuses, and
 * a position the later obligation is genuinely about is dropped as "not the
 * one owed".
 */
export class RestartFlattenGuard {
  /** Deployments still owed a downtime flatten, each against the instant its
   *  own obligation was taken on. Every position an entry is about predates
   *  its instant, which is the only thing that distinguishes the owed position
   *  from whatever happens to be open on the same deployment when the sweep
   *  finally runs. Carried through the persisted set, never re-stamped on a
   *  re-seed. */
  private pending = new Map<string, number>();
  /** The gap that produced the pending set, for the log line. Set-wide, unlike
   *  the seed instants: it describes the outage rather than a position.
   *  Carried through the persisted set so a later boot reports the outage that
   *  created the obligation rather than its own restart. */
  private gapMs = 0;
  private failureSince = new Map<string, number>();
  private failureReportedAt = new Map<string, number>();
  /** The sweep survives `stop()`, so a lost lease does not disarm it; this
   *  is what keeps it from flattening once another process runs the engine. */
  private readonly mayFlatten = leaseGate(
    "the downtime flatten sweep",
    "Its flatten is left to the process that holds the lease, whose boot re-seeds the obligation from the database.",
  );

  constructor(private readonly deps: RestartGuardDeps) {}

  /** Seed the sweep. Called once per process, from whichever door hands the
   *  obligation over — the boot path, or `start()` when boot returned early —
   *  and always before the priming tick. */
  markUnmanaged(entries: readonly OwedFlatten[], gapMs: number): void {
    this.gapMs = gapMs;
    for (const entry of entries) this.pending.set(entry.deploymentId, entry.seededAt);
    this.persist();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * One pass. Ordering inside the loop is the closing guard's, copied
   * deliberately: the contract resolve is the only `await`, and it happens
   * before `DeploymentState.position` is read for the dispatch, so the read
   * and the call that consumes it are separated by nothing.
   */
  async runRestartFlatten(): Promise<void> {
    if (this.pending.size === 0) return;

    for (const [deploymentId, seededAt] of [...this.pending]) {
      const deployment = this.deps.getDeployment(deploymentId);
      if (!deployment) {
        this.drop(deploymentId);
        continue;
      }
      // A row that has since been asked to close belongs to the closing guard,
      // which owns the same flatten with a status behind it. Two sweeps on one
      // position would be serialised by the exit latch rather than harmful,
      // but the obligation is the closing guard's and the reason it fired
      // should be the operator's Pause, not this.
      if (deployment.status !== "Active") {
        this.drop(deploymentId);
        continue;
      }
      if (!this.deps.hasOpenTrade(deploymentId)) {
        this.deps.logEvent(
          "downtime_flatten_not_needed",
          deploymentId,
          `[RESTART] Position is confirmed flat after ${formatGapDuration(this.gapMs)} unmanaged — nothing further owed`,
        );
        this.drop(deploymentId);
        continue;
      }

      // **The obligation is about one position, and this is where that is
      // enforced.** `hasOpenTrade` answers for the *deployment*, so a sweep
      // that retried across an operator restart can find a row that is not the
      // one it owes: the outage-era position closes at the broker on its own
      // bracket, the priming tick retires that row, and a genuine signal opens
      // a new one minutes later. Force-closing that is the failure the
      // application latch stops in-process, arriving through the durable path
      // instead. A row that started after *this entry's* obligation was taken
      // on is by construction not the owed one — and the comparison is against
      // this entry's instant rather than the set's, or a carried obligation's
      // older threshold discards the position a freshly merged one owes.
      const startedAt = this.deps.openTradeStartedAt(deploymentId);
      if (startedAt != null && startedAt > seededAt) {
        this.deps.logEvent(
          "downtime_flatten_superseded",
          deploymentId,
          `[RESTART] The position that went unmanaged for ${formatGapDuration(this.gapMs)} is gone — ` +
            `what is open now started ${new Date(startedAt).toISOString()}, after this sweep was seeded, ` +
            "so it is not the one owed and is left to normal management",
        );
        this.drop(deploymentId);
        continue;
      }

      const pre = this.deps.stateFor(deploymentId);
      if (!pre?.position) {
        // Not flat, but nothing to submit: the exit is already on the wire, or
        // an entry is still pending. Both resolve through the reconciler, and
        // `hasOpenTrade` above is what will retire this entry when they do.
        continue;
      }

      const strategy = getStrategy(deployment.strategyKey);
      if (!strategy) {
        this.reportFailure(
          deployment,
          Date.now(),
          `strategy ${deployment.strategyKey} is not registered, so no exit can be built`,
        );
        continue;
      }

      let contract: Contract;
      try {
        contract = await this.deps.resolveContract(deployment.ticker, deployment.accountId);
      } catch (err) {
        this.reportFailure(deployment, Date.now(), `contract resolve failed: ${message(err)}`);
        continue;
      }

      // Another flatten actor put a market order against this (account,
      // contract) inside the last window and it may still be unbooked. Skip
      // *this pass* only — the pending entry is deliberately not dropped and
      // the failure anchor is deliberately not cleared, because the obligation
      // is durable and the whole point of it is that it outlives a pass that
      // could not act. The exit latch cannot cover this: the watchdog bypasses
      // `placeExitOrder` and sets no latch.
      const contractId = executionContractId(contract);
      if (this.deps.flattenCooldown.active(deployment.accountId, contractId)) {
        this.deps.logEvent(
          "flatten_deferred",
          deploymentId,
          `[RESTART] Another flatten on ${contractId} may still be unbooked — deferring this pass; ` +
            `the downtime flatten is still owed and will be retried in ${Math.round(RESTART_FLATTEN_INTERVAL_MS / 1000)}s`,
          { accountId: deployment.accountId, contractId },
        );
        continue;
      }

      // Re-read after the resolve: `handleUserPositionEvent` is void-dispatched
      // with no `ticking` guard, so a close event landing during the resolve
      // nulls `position` underneath us and `placeExitOrderInner` would read
      // `.side` off null.
      const deplState = this.deps.stateFor(deploymentId);
      const position = deplState?.position;
      if (!deplState || !position) continue;
      // After the resolve's await, immediately before the dispatch. The entry
      // stays pending: the obligation is durable, not this process's.
      if (!this.mayFlatten()) return;

      this.deps.logEvent(
        "downtime_flatten",
        deploymentId,
        `[RESTART] Position went unmanaged for ${formatGapDuration(this.gapMs)} — force-exiting per the duration rule`,
        {
          accountId: deployment.accountId,
          contractId,
          tradeId: deplState.activeTradeId,
        },
      );
      // Stamped *before* the submit, never after it: the window this closes is
      // the round trip itself.
      this.deps.flattenCooldown.note(deployment.accountId, contractId, "restart");
      try {
        await this.deps.placeExitOrder(
          strategy,
          deployment,
          contract,
          position,
          deplState.activeTradeId,
          ENGINE_DOWNTIME_EXIT_REASON,
        );
        deplState.position = null;
        deplState.breakEvenMoved = false;
        deplState.activeTpTicks = null;
        deplState.activeSlTicks = null;
        deplState.slMovedToBe = false;
        deplState.slCurrentPrice = null;
        deplState.tpCurrentPrice = null;
        deplState.cooldownAnchorAt = new Date().toISOString();
        this.clearFailure(deploymentId);
        // Deliberately still pending: the latch covers submission, not fill,
        // and `hasOpenTrade` is the only answer that means confirmed flat.
      } catch (err) {
        // `EXIT_IN_FLIGHT` means "already happening, fine" — never an error.
        // **The cooldown stamp is deliberately kept**: the latch, the
        // deployment and the contract are all this one, so an exit really is
        // in flight against this (account, contract), which is exactly what
        // the stamp says. D-2 drops its stamp on the same code because its
        // refusal comes from a *different* position's exit.
        if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
          this.clearFailure(deploymentId);
          continue;
        }
        // Nothing reached the wire: `placeExitOrderInner` cannot throw past a
        // successful `placeOrder`, so every throw arriving here is a rejected
        // order, a failed positions read, or an `EXIT_FLAT_MISMATCH` — broker
        // flat against a row the engine still calls open. Releasing keeps the
        // retry at one pass rather than two, and `release` cannot drop
        // another actor's.
        this.deps.flattenCooldown.release(deployment.accountId, contractId, "restart");
        // Position is deliberately kept so the next pass retries.
        this.reportFailure(deployment, Date.now(), `exit dispatch failed: ${message(err)}`);
      }
    }
  }

  /** The only place the pending set shrinks, and therefore the only place the
   *  durable obligation is cleared. Every arm that reaches it has established
   *  confirmed flat, a row that is gone, or a row the closing guard now owns. */
  private drop(deploymentId: string): void {
    this.pending.delete(deploymentId);
    this.clearFailure(deploymentId);
    this.persist();
  }

  /** **The gap describes the set, so it goes when the set does.** Written
   *  beside an *empty* set it outlives it: the boot path's carried half
   *  returns early on an empty set and never writes it back down, so the next
   *  obligation silently adopts the last one's four hours and every incident
   *  surface reports it. The seed instants need no such clearing — they live
   *  on the entries and leave with them. */
  private persist(): void {
    if (this.pending.size === 0) this.gapMs = 0;
    this.deps.persistPending(
      [...this.pending].map(([deploymentId, seededAt]) => ({ deploymentId, seededAt })),
      this.gapMs,
    );
  }

  /**
   * Escalate on the first failure, then throttle. A downtime flatten that
   * cannot execute is a position that has *already* been unmanaged past the
   * threshold and still is, so the line says how long the retry has been
   * failing rather than just "again".
   */
  private reportFailure(deployment: Deployment, nowMs: number, detail: string): void {
    const since = this.failureSince.get(deployment.id) ?? nowMs;
    this.failureSince.set(deployment.id, since);
    const lastReported = this.failureReportedAt.get(deployment.id);
    if (lastReported != null && nowMs - lastReported < RESTART_FLATTEN_FAILURE_REPORT_MS) return;
    this.failureReportedAt.set(deployment.id, nowMs);
    const stranded = Math.round((nowMs - since) / 1000);
    this.deps.logEvent(
      "downtime_flatten_failed",
      deployment.id,
      `[RESTART] Could not force-flat a position that went unmanaged for ${formatGapDuration(this.gapMs)} — ${detail}. ` +
        `Retrying every ${Math.round(RESTART_FLATTEN_INTERVAL_MS / 1000)}s; failing for ${stranded}s so far and the position is still open.`,
      { accountId: deployment.accountId },
    );
  }

  private clearFailure(deploymentId: string): void {
    this.failureSince.delete(deploymentId);
    this.failureReportedAt.delete(deploymentId);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
