// Per-seam health, and the gate that decides whether a deployment may take a
// new entry. D-8, D-10 and D-15 of docs/proposals/position-lifecycle.md.
//
// Three seams, and only two of them are broker-routed:
//
//   marketData.realtime : healthy | stale | down    ONE GLOBAL SLOT
//   broker.topstep      : orders | events           per account / per broker
//   broker.tradovate    : orders | events
//
// Market data is not broker-routed. The registry has `historical` and
// `realtime` slots, both default to Topstep, and there is no Databento live
// subscription — so Topstep is the only realtime bar source and a Topstep
// data outage stops bars for *every* deployment, Tradovate ones included,
// while both brokers' order paths keep working. That asymmetry is the whole
// reason this file is not a single "engine online" boolean.
//
// "Engine online" is therefore derived, never stored. Ask `snapshot` for the
// three seams, or `describeDeployment` for one deployment's summary.
//
// ── Two things here correct the proposal, and both were found by reading ──
//
// **1. `down` is not "socket not connected".** D-15's table says it is, and
// that is wrong for this codebase: when the market hub dies the engine flips
// to passive mode and `swapTickHandler("passive")` runs the *full* tick, so
// strategies keep evaluating on REST-fetched bars at `REST_TICK_MS`. Socket
// down with REST alive is a cadence change, not a data outage, and gating
// evaluation on it would stop trading in a state the engine was explicitly
// built to trade through. `down` here keys off the seam evaluation actually
// reads — `marketDataRegistry.realtime().retrieveBars`, via
// `engine-bar-fetch.ts` — which is the only thing whose failure means "no
// bars". D-15's own point 1 asks for exactly this: the hub constants measure
// *connection* health, and what the engine needs to gate on is *data* health.
//
// **2. The evaluation series is rebuilt from REST every time, so a feed
// outage cannot leave a hole in it.** `fetchBars` re-reads the deployment's
// whole warmup window on every evaluation — a depth per deployment since
// 2026-09-07, the same window either way; the engine keeps no stitched
// series. The 1s per-request TTL added beside it does not weaken that: what
// it shares is one whole-window read, entire, between legs asking the
// identical `(contractId, unit, unitNumber, depth)` question inside one bar
// close, so no series is assembled from more than one call and the next bar
// close always reads fresh. A read reused that way is **not** recorded here —
// `TradingEngine.fetchBars` records one observation per request rather than
// per leg, because a leg handed another's answer observed nothing.
// D-10's bar-hole concern is real but lands somewhere else — see
// `resumeFromBarOpenMs` below.
//
// **3. Nothing here refuses a bar because the feed is down, because nothing
// here can be asked while it is.** `fetchBars` throws on a provider failure
// and `processDeployment` reads bars before it does anything else, so a real
// outage aborts evaluation at the read — every path below it, this file
// included, is unreachable until the read succeeds again. The throw *is* the
// enforcement of `down`; there is no second gate, and a `down` arm here
// would be code only a test could reach. What survives an outage is what
// never went through `processDeployment` in the first place: the session-end
// clock guard, the naked-position watchdog and the closing guard.
//
// ── Thresholds are borrowed, never invented ──
//
// `MARKET_HUB_STALL_MS` (120s) and `HEARTBEAT_TRADE_SILENCE_WARN_S` (60s)
// are imported from `engine-market-hub.ts` rather than restated. They are one
// calibrated ladder and a second copy of a threshold that "matches" is a
// documented failure in this codebase (`replayWindow` carried two). The
// import is a bare number: it can neither carry state nor close a cycle, so
// it is the same carve-out that lets `engine-reconcile.ts` import
// `bracketRecoveryEligibility` directly.
//
// Nothing here rides `HEARTBEAT_MS`, and the reason is a kind mismatch
// rather than whatever it currently holds — the rule reads the same at 30s,
// at 10s, and at any value it takes later. It is a *sampling cadence*: how
// often the hub looks. Everything this file publishes is a threshold: a
// claim about when something is wrong. A health state derived from a cadence
// would be a function of poll frequency, so retuning the heartbeat for log
// volume would silently redefine what `stale` asserts about the feed. The
// cadence is bracketed by the two thresholds above and that relationship is
// argued where it is declared; the borrowing only runs one way.

import { BrokerKind } from "@/lib/db/account-brokers";
import type { Deployment } from "@/lib/trading/domain";
import type { LogSubject } from "./engine";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import { HEARTBEAT_TRADE_SILENCE_WARN_S, MARKET_HUB_STALL_MS } from "./engine-market-hub";
import { collectSessionWindows, isInMaintenanceWindow } from "../session/session";
import { isInTradableSessionWindow } from "../session/exchange-calendar";
import { getStrategy } from "../strategies";
import { defaultParamValues, migrateLegacyParamOverrides } from "../strategy-types";
import type { CommonParams } from "../strategy-types";

/** deploymentId value used for engine-internal log entries. One definition,
 *  re-exported from the vocabulary rather than restated. */
const ENGINE_CTX = ENGINE_SCOPE;

export type MarketDataState = "healthy" | "stale" | "down";
export type SeamState = "up" | "down";

/**
 * Tier-1 work that stops for as long as the data slot is `down` — i.e. for as
 * long as the bar read keeps throwing, which is what aborts `processDeployment`
 * before any of it runs.
 *
 * D-10's operator requirement in one place: break-even and trailing degrade
 * *invisibly* today, and a stop that has stopped trailing looks identical on
 * the broker's book to one that is still trailing. Every operator-facing
 * surface that reports degraded mode renders this list rather than composing
 * its own sentence, so none of them can drift out of agreement about what is
 * frozen.
 *
 * **All four resume together the moment a bar read succeeds.** Only `entries`
 * is held back past that instant, by `mayEnterOnBar`; the other three are
 * position management on a live position and freezing them a second longer
 * than the outage lasts is the defect, not the safety measure.
 */
export const FROZEN_WHILE_FEED_DOWN: readonly string[] = [
  "entries",
  "strategy exits",
  "break-even",
  "trailing",
];

/**
 * What is still frozen while the entry anchor — stamped by a feed recovery or
 * by a start — has not been cleared by a bar that opened after it. A strict
 * subset of the list above — the other three resume on the first bar the
 * provider serves.
 */
export const FROZEN_AWAITING_ENTRY_BAR: readonly string[] = ["entries"];

/**
 * What the restart flap breaker freezes. The same single item as the list
 * above and deliberately its own constant: the two holds have different
 * lifetimes and different operator answers — one clears on the next bar, the
 * other lasts the life of the process — so a surface that renders one must be
 * able to say which.
 */
export const FROZEN_WHILE_ENTRIES_SUSPENDED: readonly string[] = ["entries"];

/**
 * Why entries are being refused while the feed itself is healthy. Null is the
 * ordinary state. Every arm freezes the same thing; the difference an operator
 * needs is how long it lasts. `post-start-bar` is the bar hold after a
 * `start()`, which is every boot: the dashboard's parser does not know it yet
 * and reads it as no hold.
 */
export type EntryHoldReason = "post-outage-bar" | "post-start-bar" | "flap-breaker";

/** Which instant the entry anchor holds to — the two writers of one field. */
type EntryAnchorCause = "feed-recovered" | "engine-started";

export interface MarketDataHealth {
  state: MarketDataState;
  /** Open time (epoch ms) of the newest bar that reached evaluation. */
  lastBarAt: number | null;
  /** Epoch ms of the last inbound trade on ANY subscribed contract. */
  lastFeedTickAt: number | null;
  /**
   * Epoch ms the slot entered `down` — `MARKET_HUB_STALL_MS` after the first
   * failure of the current failing run; null while the slot is not down.
   *
   * **Derived, never stamped.** The crossing happens *between* two reads and
   * the read that observes it can be a whole timeframe late, so a value
   * stamped at the observing read reports the detection instant while calling
   * itself the entry instant. It used to hold the instant an alert fired,
   * which is a third thing again.
   */
  downSince: number | null;
  /**
   * **Entries** on bars opening before this instant are refused; exits,
   * break-even and trailing are not. Stamped at the moment the slot recovers
   * from `down` and at every `start()`, and never cleared while the engine
   * runs — a later stamp overwrites it, an earlier one never does, and any bar
   * at or after it passes forever, so there is nothing to leak or prune.
   */
  resumeFromBarOpenMs: number | null;
  reason: string | null;
}

export interface BrokerSeamHealth {
  orders: SeamState;
  events: SeamState;
  ordersReason: string | null;
  eventsReason: string | null;
}

export interface SeamHealthSnapshot {
  marketData: { realtime: MarketDataHealth };
  brokers: Record<string, BrokerSeamHealth>;
  /** Derived: the data slot is `down`, so tier 1 is off engine-wide. */
  degraded: boolean;
  /** What has stopped, whether or not the feed is the cause. Empty only when
   *  nothing is held. */
  frozen: readonly string[];
  /**
   * Why entries are being refused while the feed is healthy, or null.
   *
   * Separate from `degraded` because it is not the same severity: nothing is
   * broken, one class of work is held. Reporting it as degraded would put a
   * "No Market Data" banner over a healthy feed; reporting nothing at all is
   * what shipped, and it showed a green *Connected* pill for up to two bar
   * intervals after an outage — and forever, once the flap breaker trips.
   */
  entriesHeld: EntryHoldReason | null;
}

/** Per-deployment answer to "may this one trade right now?" — D-8's derived
 *  summary, which is a function of the deployment's broker plus the one
 *  global data slot. */
export interface DeploymentHealth {
  canEvaluate: boolean;
  /**
   * Whether a *new entry* would be admitted right now. Separate from
   * `canEvaluate` because the two are separately true: after an outage,
   * evaluation resumes on the first bar the provider serves and entries stay
   * held until a bar that opened entirely post-outage reaches evaluation.
   */
  canEnter: boolean;
  canPlaceOrders: boolean;
  frozen: readonly string[];
  reason: string | null;
}

/** Everything the derivation reads that is not stored here. Supplied at call
 *  time so the snapshot never has to make a broker call to answer. */
export interface MarketDataContext {
  now: number;
  /** `marketHub.lastActivityAt()` — 0 when no trade has ever arrived. */
  lastFeedTickAt: number;
  /** `marketHub.marketSubs.size` — how many contracts are subscribed. */
  subscribedContracts: number;
  /** True when at least one managed deployment is inside a session window. */
  inSessionWindow: boolean;
  inMaintenanceWindow: boolean;
}

/**
 * The stored half the derivation reads — deliberately only the two fields it
 * actually consults, not everything the controller keeps. Separated from the
 * context so the ladder is a pure function of two plain records and can be
 * exercised without a controller.
 */
export interface MarketDataObservations {
  /** Epoch ms of the first bar-read failure in the current failing run. */
  barFailingSince: number | null;
  lastBarError: string | null;
}

/**
 * The `down` half of the ladder, isolated because it is the only half that
 * changes behaviour and the only half on a hot path.
 *
 * It reads two numbers, so the transition detection in `noteBarRead` can run
 * on every bar read without paying for the session-window scan the `stale`
 * arm needs. The full ladder is only asked for by the status surfaces.
 */
export function isFeedDown(barFailingSince: number | null, now: number): boolean {
  return barFailingSince != null && now - barFailingSince >= MARKET_HUB_STALL_MS;
}

/**
 * The three-state ladder, as a pure function.
 *
 * `down` — the bar path has been failing for at least `MARKET_HUB_STALL_MS`.
 * That is the same threshold at which the hub's own watchdog stops waiting
 * and acts, reused rather than re-picked.
 *
 * `stale` — the bar path is answering, but nothing has ticked on **any**
 * subscribed contract for `HEARTBEAT_TRADE_SILENCE_WARN_S` while in session.
 * *Any*, not *each*: two contracts subscribed and neither ticking is the
 * feed; MGC silent while MNQ ticks is MGC being quiet. That is why this is
 * one global state and not a per-instrument one — a per-contract signal
 * cannot distinguish those two cases and must never gate evaluation on its
 * own (D-15 point 3).
 *
 * The session gate exists because the 120s stall threshold is justified in
 * `engine-market-hub.ts` by "RTH ticks arrive multiple times per second" —
 * true in session, false at 03:00, where silence is *correct* and must not
 * read as stale (D-15 point 2).
 *
 * `isInSessionWindow` fails open on an unparseable `HH:MM`, and that is the
 * safe direction *here*: a wrong `true` costs one advisory warn line. Do not
 * copy this reasoning to a caller where in-window means authority to place an
 * order — there the fail-open is inverted and a claim check is required.
 *
 * **Only `down` changes behaviour, and `stale` emits nothing new.** The warn
 * D-15 asks for already exists — the hub's heartbeat logs
 * "No market trades for Ns on N subscribed contract(s)" off the same
 * constant — and the repair already exists too, in the watchdog at 120s.
 * Re-warning here would put two lines on one silence. What was missing was a
 * *readable status*, which is this. Acting on `stale` is how a quiet contract
 * produces a spurious flatten.
 *
 * The heartbeat's warn deliberately keeps no session gate: it is connection
 * diagnostics, where an extra line costs nothing. The session gate belongs on
 * the state the engine *reads to decide*, which is here.
 */
export function deriveMarketDataState(
  obs: MarketDataObservations,
  ctx: MarketDataContext,
): { state: MarketDataState; reason: string | null } {
  if (isFeedDown(obs.barFailingSince, ctx.now)) {
    const secs = Math.round((ctx.now - (obs.barFailingSince ?? ctx.now)) / 1000);
    return {
      state: "down",
      reason: `bar reads failing for ${secs}s${obs.lastBarError ? `: ${obs.lastBarError}` : ""}`,
    };
  }

  if (ctx.subscribedContracts === 0) return { state: "healthy", reason: null };
  if (ctx.inMaintenanceWindow) return { state: "healthy", reason: null };
  if (!ctx.inSessionWindow) return { state: "healthy", reason: null };
  if (ctx.lastFeedTickAt <= 0) return { state: "healthy", reason: null };

  const silentMs = ctx.now - ctx.lastFeedTickAt;
  if (silentMs >= HEARTBEAT_TRADE_SILENCE_WARN_S * 1000) {
    return {
      state: "stale",
      reason:
        `no trade on any of ${ctx.subscribedContracts} subscribed contract(s) ` +
        `for ${Math.round(silentMs / 1000)}s while in session`,
    };
  }

  return { state: "healthy", reason: null };
}

/**
 * True when any of these deployments is inside one of its session windows
 * **and the exchange is open to fill it**.
 *
 * Feed health is a property of the *feed*, not of a deployment, so the
 * question is deliberately "is anything supposed to be trading right now"
 * rather than "is this deployment trading" — one silent contract on a
 * deployment that is out of window says nothing about the socket.
 *
 * **The calendar term is part of that question rather than a symmetry tidy.**
 * After an exchange early close the declared window reads in-session for
 * hours with zero ticks, so the staleness arm above fires and keeps firing on
 * a silence that is the market being shut — nine or ten times a year, on a
 * lane whose whole value is being rare. During a halt, nothing is supposed to
 * be trading, which is the answer this predicate exists to give.
 */
export function anyDeploymentInSession(deployments: readonly Deployment[], now: Date): boolean {
  for (const deployment of deployments) {
    const strategy = getStrategy(deployment.strategyKey);
    if (!strategy) continue;
    const params = {
      ...defaultParamValues(strategy.params),
      ...migrateLegacyParamOverrides(deployment.strategyKey, deployment.paramValues, {
        deploymentId: deployment.id,
      }),
    } as CommonParams;
    if (isInTradableSessionWindow(now, collectSessionWindows(strategy.config.session, params))) {
      return true;
    }
  }
  return false;
}

/** Engine-internal surface the health controller reads back through. Bound
 *  callbacks rather than flipped access modifiers, as everywhere else. */
export interface HealthDeps {
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
  /** `marketHub.lastActivityAt()`. */
  lastFeedTickAt(): number;
  /** Number of contracts with a live market-data subscription. */
  subscribedContracts(): number;
  /** True when at least one managed deployment is inside a session window.
   *  Bound to `anyDeploymentInSession` over the current deployment set — the
   *  controller takes the answer rather than the deployments so it needs no
   *  knowledge of strategies, params or window collection. */
  inSessionWindow(now: Date): boolean;
  /** Accounts the engine manages, grouped by the broker that routes them. */
  managedAccounts(): ReadonlyMap<BrokerKind, ReadonlySet<number>>;
  /** Whether this broker's realtime adapter reports a healthy transport for
   *  this account. Reads the adapter's own counters — no broker call. */
  realtimeHealthy(kind: BrokerKind, accountId: number): boolean;
  /** The restart flap breaker: entries are refused for the life of the
   *  process. Read at call time, like the accessors above. It is not a
   *  deployment status and it appears on no other surface, so a health model
   *  that ignored it would report a green pill over an engine that is never
   *  going to enter again. */
  entriesSuspended(): boolean;
  /** Out-of-band alert on a degraded-mode transition. Fire-and-forget. */
  alertDegraded(entering: boolean, detail: string): void;
}

/** One bar-read outcome, as observed at the single funnel in `engine.ts`. */
export interface BarReadOutcome {
  ok: boolean;
  /** Open time (epoch ms) of the newest bar returned, or null for an empty
   *  series or a failure. An empty series is still a successful read — the
   *  provider answered. */
  newestBarOpenMs: number | null;
  error?: string;
}

/**
 * Owns the mutable half of seam health.
 *
 * A controller rather than a `*Deps` satellite, by the exclusive-ownership
 * litmus in engine.md: every field below is written here and nowhere else.
 *
 * **It has no interval, deliberately.** The state is a pure function of
 * stored anchors plus live accessors, so it is correct whenever it is read,
 * and the one transition that has to be *announced* is always discovered at
 * a bar read — the only thing that can move it. `fetchBars` runs on every
 * tick and every bar close, so the crossing is detected within one tick of
 * happening. A timer would add a lifetime to clean up and would observe
 * nothing the reads do not.
 */
export class EngineHealth {
  private barFailingSince: number | null = null;
  private lastBarAt: number | null = null;
  private lastBarError: string | null = null;
  /** Announcement latch, and nothing else: the instant the DOWN alert fired.
   *  It is **not** the instant the slot entered `down` — a slow read cadence
   *  can leave a whole outage unannounced — so nothing derives state from it.
   *  `MarketDataHealth.downSince` comes from `downEnteredAt`. */
  private downAnnouncedAt: number | null = null;
  private resumeFromBarOpenMs: number | null = null;
  private resumeAnchorCause: EntryAnchorCause | null = null;
  /** Per-**account** order-seam evidence. Absent means "nothing observed",
   *  which reads as `up` — see `brokerSeams` for the per-broker aggregate and
   *  `noteBrokerOrders` for why the key is the account. */
  private orderSeam = new Map<number, { failingSince: number; reason: string | null }>();

  constructor(private readonly deps: HealthDeps) {}

  // ── Writers ─────────────────────────────────────────────────────────

  /**
   * Record one outcome from the engine's single bar-read funnel, and
   * announce a degraded-mode transition if this outcome caused one.
   *
   * The announcement is transition-driven, not per-read: a provider outage
   * produces one failing read per deployment per tick, and reporting each
   * would bury the incident in its own noise.
   *
   * **The run is measured against this read's clock; only the *announcement*
   * reads the announced state.** Those are two different questions and
   * conflating them made the resume anchor dead code above 1m. The read
   * cadence is the shortest active timeframe — `fetchBars` is called from
   * `processDeployment`, which in realtime mode runs at bar close — so a 180s
   * outage on a 3m deployment produces exactly two reads: one failure at the
   * start and one success at the end. Neither lands while the *announced*
   * state is `down`, because nothing announced it, so arming off an announced
   * transition armed nothing on every timeframe from 3m up. `runWasDown` asks
   * the question that survives a slow cadence — had the failing run this read
   * is ending already crossed the threshold? — and that is what arms the
   * anchor. The announcement keeps its own latch, because the crossing itself
   * happens between reads and the failing read that first observes it already
   * reads as down before its outcome is folded in.
   */
  noteBarRead(outcome: BarReadOutcome, now: number): void {
    // Both captured before the outcome is folded in: a successful read clears
    // `barFailingSince`, so after the fold there is no run left to measure.
    const runStartedAt = this.barFailingSince;
    const runWasDown = isFeedDown(runStartedAt, now);
    const announced = this.downAnnouncedAt != null;

    if (outcome.ok) {
      this.barFailingSince = null;
      this.lastBarError = null;
      if (outcome.newestBarOpenMs != null) this.lastBarAt = outcome.newestBarOpenMs;
    } else {
      this.lastBarError = outcome.error ?? null;
      if (this.barFailingSince == null) this.barFailingSince = now;
    }

    if (isFeedDown(this.barFailingSince, now)) {
      if (announced) return;
      this.downAnnouncedAt = now;
      const detail =
        `Market data feed DOWN — bar reads failing for ` +
        `${Math.round((now - (this.barFailingSince ?? now)) / 1000)}s` +
        `${this.lastBarError ? `: ${this.lastBarError}` : ""}. ` +
        `Degraded mode: ${FROZEN_WHILE_FEED_DOWN.join(", ")} are FROZEN for every deployment, ` +
        `on every broker, because bars are one global slot. Open positions are still monitored: ` +
        `session-end force-flat, the naked-position watchdog and fill reconciliation all run on ` +
        `their own clocks and are unaffected.`;
      this.deps.logEvent("feed_down", ENGINE_CTX, detail);
      this.deps.alertDegraded(true, detail);
      return;
    }

    // Not down now, and never crossed: a blip that healed inside the
    // threshold. Nothing to announce and nothing to hold entries back for.
    if (!runWasDown) return;

    // The recovering read returns a window whose newest bar may have opened
    // while the engine was blind. Entering on it is entering on a setup whose
    // formation nobody watched, which is D-14's discard-the-trigger rule, so
    // entries wait for a bar that opened entirely after this instant. Exits,
    // break-even and trailing do not wait: they are management of a position
    // that is already on the books, and holding them back past the outage is
    // strictly worse than acting on the bar the provider just served.
    this.holdEntriesUntilBarOpensAt(now, "feed-recovered");
    this.downAnnouncedAt = null;
    const waitLine =
      `Entries wait for a bar opening at or after ${new Date(now).toISOString()} — no deployment ` +
      `enters on a bar that was forming while the feed was down.`;

    // An outage nobody was told about still gets exactly one line, and it says
    // so. A retroactive DOWN alert is deliberately **not** sent: it announces
    // *entering* degraded mode, which is already false by the time it is read,
    // and a DOWN/RESTORED pair one second apart teaches the operator to skim
    // past both. The level is `warn` rather than `connection` because this
    // line is the only record the incident gets.
    if (!announced) {
      const detail =
        `Market data feed RESTORED after ${Math.round((now - (runStartedAt ?? now)) / 1000)}s of ` +
        `failing bar reads that ended before it could be announced — the bar read runs at the ` +
        `shortest active timeframe, and no read landed while the feed was down. ` +
        `${FROZEN_WHILE_FEED_DOWN.join(", ")} were frozen for that window. ${waitLine}`;
      this.deps.logEvent("feed_restored_unannounced", ENGINE_CTX, detail);
      this.deps.alertDegraded(false, detail);
      return;
    }

    const detail =
      `Market data feed RESTORED. Strategy exits, break-even and trailing resume immediately. ` +
      waitLine;
    this.deps.logEvent("feed_restored", ENGINE_CTX, detail);
    this.deps.alertDegraded(false, detail);
  }

  /**
   * Hold entries to a bar that opens at or after this start. Called from
   * `start()`, after `stop()`'s `reset()`, so every start — a process boot and
   * an in-process restart alike — holds them.
   *
   * A bar that closed while no engine was running is new to this one: the old
   * process never handled it, so `restoreLastBarTimestamps` lets it through,
   * and the priming tick would enter on a setup whose formation nobody
   * watched. That is the feed-outage case with the engine as the thing that
   * was down, so it is the same anchor and the same entries-only gate.
   */
  noteEngineStarted(now: number): void {
    this.holdEntriesUntilBarOpensAt(now, "engine-started");
  }

  /**
   * Record one broker REST outcome against that **account's** order seam.
   *
   * **Keyed per account, because that is how it is fed.** Both of the
   * reconciler's fan-outs report per account, so a per-broker key was
   * last-writer-wins across a whole broker: one healthy account's success
   * deleted the entry another account on the same broker was failing on, and
   * a single-account outage was invisible for as long as any sibling
   * answered. The published per-broker state is an aggregate over these
   * entries, on the same rule the `events` seam already uses — one bad
   * account is an account problem, every bad account is the seam.
   *
   * Evidence-based and deliberately fail-open: an account nothing has called
   * reads `up`, because "no evidence of failure" is the honest answer and the
   * alternative is a cold-start that reports every broker down. See
   * `describeDeployment` for why that also makes the seam unusable as a gate.
   */
  noteBrokerOrders(accountId: number, ok: boolean, reason: string | null, now: number): void {
    if (ok) {
      this.orderSeam.delete(accountId);
      return;
    }
    const existing = this.orderSeam.get(accountId);
    if (existing) {
      existing.reason = reason;
      return;
    }
    this.orderSeam.set(accountId, { failingSince: now, reason });
  }

  // ── Read surface ────────────────────────────────────────────────────

  /** Current data-slot state. Synchronous, and makes no broker call. */
  marketDataState(now: number): { state: MarketDataState; reason: string | null } {
    return deriveMarketDataState(this.observations(), this.context(now));
  }

  marketData(now: number): MarketDataHealth {
    const { state, reason } = this.marketDataState(now);
    return {
      state,
      lastBarAt: this.lastBarAt,
      lastFeedTickAt: this.deps.lastFeedTickAt() || null,
      downSince: this.downEnteredAt(now),
      resumeFromBarOpenMs: this.resumeFromBarOpenMs,
      reason,
    };
  }

  /**
   * The engine-wide answer, and the one the dashboard renders.
   *
   * **It reports every hold, not only the feed's.** `degraded` alone was the
   * whole surface, so the two states where entries are refused while the feed
   * is healthy — the post-outage anchor and the flap breaker — showed a green
   * pill and an empty `frozen` list while `mayEnterOnBar` and the breaker gate
   * turned away every entry. `describeDeployment` answered correctly and has
   * no production caller, which is the shape of a report that drifts from the
   * gate it describes.
   */
  snapshot(now: number = Date.now()): SeamHealthSnapshot {
    const marketData = this.marketData(now);
    const degraded = marketData.state === "down";
    const entriesHeld = this.entryHoldReason(degraded);
    return {
      marketData: { realtime: marketData },
      brokers: this.brokerSeams(),
      degraded,
      frozen: degraded ? FROZEN_WHILE_FEED_DOWN : this.frozenWhileHeld(entriesHeld),
      entriesHeld,
    };
  }

  /**
   * D-8's derived summary for one deployment: its broker, plus the one global
   * data slot.
   *
   * **Every value here is reported, none of them is a gate**, which is the
   * honest shape rather than a weakening. `canEvaluate` restates what the bar
   * read has already done — a `down` slot means `fetchBars` is throwing and
   * `processDeployment` is aborting at its first line. `canEnter` restates
   * `mayEnterOnBar`, and it is a separate value because it is separately
   * true: after the feed is back, exit management resumes on the first bar the
   * provider serves while entries stay held for a bar that postdates the
   * outage, and a surface reporting an all-clear across that window tells the
   * operator nothing is wrong while every entry is being refused.
   *
   * **The order seam could not gate even if it wanted to, and the reason is
   * absence of evidence, not ordering.** Its probes are the reconciler's
   * per-account fetches, which run only when there is a pending trade or a
   * tracked position to reconcile — so a flat idle engine produces no
   * evidence at all and the seam reads `up` by construction. `up` therefore
   * means "nothing has failed lately", not "the broker answers", and `down`
   * exists only while the work that would clear it is already running.
   * Blocking on it suppresses the calls that clear it in exactly the state
   * where it is set.
   */
  describeDeployment(kind: BrokerKind, now: number = Date.now()): DeploymentHealth {
    const marketData = this.marketData(now);
    const seams = this.brokerSeams();
    const broker = seams[kind];
    const degraded = marketData.state === "down";
    const entriesHeld = this.entryHoldReason(degraded);
    return {
      canEvaluate: !degraded,
      canEnter: !degraded && entriesHeld == null,
      canPlaceOrders: broker?.orders !== "down",
      frozen: degraded ? FROZEN_WHILE_FEED_DOWN : this.frozenWhileHeld(entriesHeld),
      reason: degraded
        ? marketData.reason
        : entriesHeld === "flap-breaker"
          ? "entries suspended for the life of this process — the engine resumed from repeated " +
            "crashes and will not take a new entry until it is restarted cleanly"
          : entriesHeld != null
            ? `entries held until a bar opens at or after ` +
              `${new Date(this.resumeFromBarOpenMs ?? now).toISOString()} — no deployment enters on ` +
              (entriesHeld === "post-start-bar"
                ? `a bar that was forming before the engine started`
                : `a bar that was forming while the feed was down`)
            : (broker?.ordersReason ?? null),
    };
  }

  /**
   * The post-outage **entry** gate, asked once per candidate bar from the
   * entry branch of `processDeployment`.
   *
   * **It gates entries and nothing else, and the narrowing is the whole
   * point.** A whole-tier gate here froze break-even, trailing and strategy
   * exits on live positions for one to two full bar intervals *after* the
   * feed was back and the dashboard was reporting healthy — an hour and
   * fifty-five minutes on a 1h deployment after a five-minute outage. Exit
   * management is the half that must never wait on a bar boundary; a
   * mismanaged open position is a worse outcome than an entry taken one bar
   * late. Do not widen this back to "may this deployment evaluate".
   *
   * **There is no `down` arm**, because there cannot be a reachable one:
   * `fetchBars` throws while the feed is down and `processDeployment` reads
   * bars first, so nothing below that read is ever asked. See point 3 in the
   * file header.
   *
   * Takes the bar rather than a deployment id, because the resume rule is a
   * property of the *bar* — "did this open entirely after the outage" — and
   * asking it that way needs no per-deployment bookkeeping to prune when a
   * deployment goes away. `now` is deliberately not a parameter: the answer
   * is a comparison between two stored instants and nothing about it decays.
   */
  mayEnterOnBar(barOpenMs: number): { allowed: boolean; reason: string | null } {
    if (this.resumeFromBarOpenMs != null && barOpenMs < this.resumeFromBarOpenMs) {
      const anchor = new Date(this.resumeFromBarOpenMs).toISOString();
      return {
        allowed: false,
        reason:
          `bar opened ${new Date(barOpenMs).toISOString()}, ` +
          (this.resumeAnchorCause === "engine-started"
            ? `before the engine started at ${anchor} — awaiting a bar that opened after the start`
            : `before the feed recovered at ${anchor} — awaiting a bar that postdates the outage`),
      };
    }
    return { allowed: true, reason: null };
  }

  /** Drop every anchor. Called from `stop()`: the bar reads that feed this
   *  stop with the tick loop, so leaving a failing run behind would have the
   *  next start inherit an outage that is over. */
  reset(): void {
    this.barFailingSince = null;
    this.lastBarAt = null;
    this.lastBarError = null;
    this.downAnnouncedAt = null;
    this.resumeFromBarOpenMs = null;
    this.resumeAnchorCause = null;
    this.orderSeam.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private observations(): MarketDataObservations {
    return { barFailingSince: this.barFailingSince, lastBarError: this.lastBarError };
  }

  /** The instant the current failing run crossed into `down`, or null while
   *  the slot is not down. See `MarketDataHealth.downSince`. */
  private downEnteredAt(now: number): number | null {
    const since = this.barFailingSince;
    if (since == null || !isFeedDown(since, now)) return null;
    return since + MARKET_HUB_STALL_MS;
  }

  /**
   * Why entries are refused right now, for both read surfaces. One place, so a
   * third hold cannot be added to one answer and not the other — and the
   * ordering is a decision: the breaker outranks the anchor because it lasts
   * the life of the process, and telling an operator to wait for a bar would
   * be telling them to wait for something that changes nothing. A `down` feed
   * is its own, louder state and does not report as an entry hold.
   */
  private entryHoldReason(degraded: boolean): EntryHoldReason | null {
    if (degraded) return null;
    if (this.deps.entriesSuspended()) return "flap-breaker";
    if (!this.entriesHeldAwaitingBar()) return null;
    return this.resumeAnchorCause === "engine-started" ? "post-start-bar" : "post-outage-bar";
  }

  /** The exported list for an entry hold, so no surface writes its own. */
  private frozenWhileHeld(reason: EntryHoldReason | null): readonly string[] {
    if (reason === "flap-breaker") return FROZEN_WHILE_ENTRIES_SUSPENDED;
    if (reason != null) return FROZEN_AWAITING_ENTRY_BAR;
    return [];
  }

  /**
   * Both writers go through here, and the later instant wins by construction:
   * a start inside an outage, or a recovery read stamped against a clock that
   * stepped back, must not reopen a window the other one closed.
   */
  private holdEntriesUntilBarOpensAt(at: number, cause: EntryAnchorCause): void {
    if (this.resumeFromBarOpenMs != null && at < this.resumeFromBarOpenMs) return;
    this.resumeFromBarOpenMs = at;
    this.resumeAnchorCause = cause;
  }

  /**
   * True while the entry anchor is still refusing entries.
   *
   * `lastBarAt` is what makes this answerable without a bar in hand: it is the
   * open of the newest bar that reached evaluation, so once it is at or past
   * the anchor, a bar postdating the outage has already been through the tick
   * and `mayEnterOnBar` passes. Both anchors are global, so on a mixed install
   * a 1m deployment's bar clears the *report* while a 1h deployment is still
   * held — the same imprecision the one global slot already carries, not a new
   * one, and it is a status rather than the gate.
   */
  private entriesHeldAwaitingBar(): boolean {
    const resume = this.resumeFromBarOpenMs;
    if (resume == null) return false;
    return this.lastBarAt == null || this.lastBarAt < resume;
  }

  private context(now: number): MarketDataContext {
    return {
      now,
      lastFeedTickAt: this.deps.lastFeedTickAt(),
      subscribedContracts: this.deps.subscribedContracts(),
      inSessionWindow: this.deps.inSessionWindow(new Date(now)),
      inMaintenanceWindow: isInMaintenanceWindow(new Date(now)),
    };
  }

  /**
   * Both broker seams, for every broker the engine routes an account to.
   *
   * **Both are per-broker aggregates over per-account evidence, on one rule:
   * one bad account is an account problem, every bad account is the seam.**
   * `events` reads live off each adapter's own counters rather than being
   * recorded, because the adapters already track it and a second copy would be
   * a second answer; `orders` reads the per-account evidence `noteBrokerOrders`
   * stores. An account with no evidence counts as answering, which is the
   * fail-open the order seam is built on.
   *
   * The oldest failing account supplies the reason, so the reported anchor is
   * the start of the broker-wide outage rather than whichever account happened
   * to fail last.
   */
  private brokerSeams(): Record<string, BrokerSeamHealth> {
    const out: Record<string, BrokerSeamHealth> = {};
    for (const [kind, accountIds] of this.deps.managedAccounts()) {
      let events: SeamState = "up";
      let eventsReason: string | null = null;
      let orders: SeamState = "up";
      let ordersReason: string | null = null;

      if (accountIds.size > 0) {
        let healthyTransports = 0;
        let failingOrders = 0;
        let oldest: { accountId: number; failingSince: number; reason: string | null } | null = null;

        for (const accountId of accountIds) {
          if (this.deps.realtimeHealthy(kind, accountId)) healthyTransports++;
          const seam = this.orderSeam.get(accountId);
          if (!seam) continue;
          failingOrders++;
          if (oldest == null || seam.failingSince < oldest.failingSince) {
            oldest = { accountId, failingSince: seam.failingSince, reason: seam.reason };
          }
        }

        if (healthyTransports === 0) {
          events = "down";
          eventsReason = `no healthy realtime transport across ${accountIds.size} managed account(s)`;
        }
        if (oldest != null && failingOrders === accountIds.size) {
          orders = "down";
          ordersReason =
            `${oldest.reason ?? "broker call failed"} (account ${oldest.accountId}, since ` +
            `${new Date(oldest.failingSince).toISOString()}) — all ${accountIds.size} managed ` +
            `account(s) failing`;
        }
      }

      out[kind] = { orders, events, ordersReason, eventsReason };
    }
    return out;
  }
}
