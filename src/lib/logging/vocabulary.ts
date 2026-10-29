/**
 * The logging model's vocabulary — the envelope, the severity ladder, the
 * category set, the legacy seven-level mapping, and the seeded event table.
 *
 * It reads no environment, opens no connection and imports nothing, which
 * is what keeps `pipe.ts` a leaf. Keep it that way — a single import here
 * is what would make the logging module reachable from its own callers.
 *
 * Owned by docs/modules/logging/README.md.
 */

/**
 * The ladder. Orthogonal to category — a `broker` line can be any of these.
 * Meanings, not colours, and each one obligates something:
 *
 *   - `error`  the operator is obligated to look. A line may carry `error`
 *              only if the code *checked* the condition it names.
 *   - `warn`   degraded or watch state, no action required yet. Never
 *              emitted per-tick — every warn site keys a throttle on its
 *              cause.
 *   - `info`   a state change worth the durable record.
 *   - `debug`  diagnosis detail. Non-prod only.
 */
export type Severity = "debug" | "info" | "warn" | "error";

/** What the line is *about*. Orthogonal to severity. */
export type LogCategory =
  | "trade"
  | "order"
  | "connection"
  | "lifecycle"
  | "safety"
  | "broker"
  | "system"
  | "heartbeat";

/**
 * The seven-chip enum `engine_logs.level` still stores. Severity and category
 * conflated in one value — which is what the pair above splits.
 *
 * It outlived the migration that was meant to retire it, and it is still
 * load-bearing in one place that is easy to miss. The console mirror stopped
 * rendering it when the two log formats merged, and the viewer's lanes face
 * severity and category — but the **wire payload is still bucketed by level**
 * (`getLogsByLevel` in `engine-singleton.ts`), one cap per bucket, which is
 * what keeps a low-frequency level visible at a small limit. The client merges
 * the buckets straight back into one stream.
 *
 * So retiring it is two changes, not a deletion: re-key that fairness cap on
 * something the viewer actually faces, then migrate a table that has history.
 * Neither is a cleanup, which is why this is still here.
 */
export type LegacyLevel =
  | "info"
  | "warn"
  | "error"
  | "trade"
  | "connection"
  | "heartbeat"
  | "trade-skip";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * The deployment-id sentinel for a line that is about the engine rather
 * than about one deployment. `engine_logs.deployment_id` is NOT NULL, so
 * engine-wide and infra lines need a value and this is it.
 *
 * `engine-health.ts` and `engine-market-hub.ts` still declare a local
 * `ENGINE_CTX`, but each is now `= ENGINE_SCOPE` rather than its own
 * literal, so this is the single definition and changing it propagates.
 * Keep it that way: a local that re-spells the string instead of aliasing
 * it is how the sentinel drifts into two values that both look right.
 */
export const ENGINE_SCOPE = "engine";

// ── The legacy chip, in both directions ────────────────────────────────

/**
 * The seven legacy levels as `severity × category`. `trade` and
 * `trade-skip` deliberately land on the same pair — the discriminator is
 * the *event* (`entry_filled` vs `entry_skipped`).
 *
 * **Nothing writes through this any more**; `deriveLegacyLevel` below is
 * its inverse and is the live direction. It survives because a viewer, a
 * hydrated row and a test all still need to read the mapping, and because
 * the inverse is only checkable against it.
 */
export const LEGACY_LEVEL_LADDER: Readonly<
  Record<LegacyLevel, { severity: Severity; category: LogCategory }>
> = {
  trade: { severity: "info", category: "trade" },
  "trade-skip": { severity: "info", category: "trade" },
  connection: { severity: "info", category: "connection" },
  heartbeat: { severity: "info", category: "heartbeat" },
  info: { severity: "info", category: "system" },
  warn: { severity: "warn", category: "system" },
  error: { severity: "error", category: "system" },
};

/**
 * The `level` column's value. The chips it was written for are gone — the
 * viewer faces severity and category — but the column is still written on
 * every row and still keys the wire payload's per-level fairness cap, so
 * this mapping is live. Read it as the inverse of `LEGACY_LEVEL_LADDER`,
 * because that is what
 * it is: every legacy level maps to a pair, and this maps a pair back.
 *
 * The order of the three rules is load-bearing:
 *
 * 1. **`entry_skipped` is the one chip the pair cannot express**, because
 *    `trade` and `trade-skip` share `info`/`trade`. The event is the only
 *    discriminator, and naming it here is what let the call sites stop
 *    carrying a `legacyLevel` of their own.
 * 2. **`warn` and `error` keep their own chip, ahead of any category.** No
 *    legacy level maps to `warn`/`trade` or `error`/`connection`, so a
 *    category-first rule invents a chip for a pair the old enum could not
 *    produce — and it invents in the dangerous direction, filing a failure
 *    under a routine chip the operator does not scan for problems. A hub
 *    that failed to connect belongs under ERROR, and its `connection`
 *    category is still on the row for the viewer to facet on.
 * 3. **Below that, a chip-bearing category wins**, because at `info` the
 *    category *is* the information the chip carried: `trade`, `connection`
 *    and `heartbeat` are all `info` in the ladder.
 *
 * `debug` has no chip of its own, so it falls out at `info` — **except in
 * the three chip-bearing categories, where rule 3 answers first**: a
 * `debug`/`connection` line lands on CONNECTION, not INFO. That is
 * deliberate, it is what keeps a quiet transport line in the transport
 * chip, and the honest severity stays in the `severity` column, which is
 * what the diagnostics lane reads.
 */
export function deriveLegacyLevel(
  severity: Severity,
  category: LogCategory,
  event: string | null,
): LegacyLevel {
  if (event === "entry_skipped") return "trade-skip";
  if (severity === "warn" || severity === "error") return severity;
  if (category === "trade") return "trade";
  if (category === "connection") return "connection";
  if (category === "heartbeat") return "heartbeat";
  return "info";
}

// ── Tag mapping (compat shim B) ────────────────────────────────────────

/**
 * `logger.ts`'s tag argument as a category. The tag is a dotted path whose
 * head names the world the line came from, so the head is what maps —
 * `tradovate.realtime` and `tradovate.client` are both `broker`.
 *
 * Unrecognised heads fall to `system`, which is the same answer an
 * unclassified engine line gets. This map is the fallback path now that
 * migrated call sites name an event and take their category from it; a
 * line still reaching here is one of the unmigrated `log.*` sites.
 */
const TAG_HEAD_CATEGORY: Readonly<Record<string, LogCategory>> = {
  tradovate: "broker",
  topstep: "broker",
  broker: "broker",
  "broker-registry": "broker",
  client: "broker",
  signalr: "connection",
  broadcaster: "connection",
  engine: "system",
  db: "system",
  auth: "system",
  eval: "trade",
  trading: "trade",
  discord: "system",
  api: "system",
  settings: "system",
  // Both of these were falling to `system` while their rows were already
  // being written, and the viewer facets on the column. `flatten-all` is
  // the last-resort close-everything route, which is a safety action
  // however it was triggered.
  "flatten-all": "safety",
  "bar-aggregator": "system",
};

export function categoryForTag(tag: string): LogCategory {
  const head = tag.split(".")[0];
  return TAG_HEAD_CATEGORY[head] ?? "system";
}

// ── The event vocabulary — seeded, not enumerated ──────────────────────

/**
 * What an event declares. The table below is seeded rather than closed: a
 * new event is added here by hand, and `EVENTS` is keyed on `string`, so a
 * call site naming an event that does not exist **compiles and falls back**
 * to the envelope's own severity/category, or to `info`/`system`. The
 * fallback is deliberate: an unknown event must never throw on a logging
 * path. What catches a typo is a source scan in `vocabulary.test.ts` (A59)
 * over every literal event name a call site writes; a name built at runtime
 * is outside it. A `keyof typeof EVENTS` parameter would be the compile-time
 * answer, but every engine satellite's `logEvent` dep is typed `string`.
 *
 * `template` null means diagnostics-only — the event has no Activity-lane
 * rendering. A non-null template must pass the phone test: it survives
 * being read aloud by someone who does not understand it and still tells
 * the operator which deployment, which action, what state it left and what
 * happens next. `vocabulary.test.ts` asserts the mechanical half of that.
 */
export interface EventSpec {
  severity: Severity;
  category: LogCategory;
  template: string | null;
  /**
   * Send this event to Discord when it lands at `error`.
   *
   * **Deliberately narrow, and deliberately not "every `error`".** The
   * ladder covers lines that today reach nobody; it does not re-plumb lines
   * that already reach the operator through a hand-placed rich embed, and a
   * site with one of those is never also flagged here — that is the dedupe
   * rule, and there is a grep-based pin on the existing embed sites.
   *
   * A flagged event's `template` is what the alert's title renders from,
   * so the phrasing on the phone is the Activity sentence rather than a
   * diagnostics line — **when the line has a subject to fill it with.** An
   * engine-scoped flagged event has none, and the answer is `template:
   * null` plus a title taken from the message, never a `{display}` the
   * line can never resolve. See `notify/log-escalation.ts`.
   */
  escalates?: true;
}

export const EVENTS: Readonly<Record<string, EventSpec>> = {
  /** The order is on the wire. `entry_filled` is the one that matters, and
   *  this is the one that says the engine tried. */
  entry_submitted: {
    severity: "info",
    category: "trade",
    template: "Placing an entry order for {ticker} on {display} — stop and target go with it",
  },
  /**
   * **`{side}` is a value slot and the word it renders is `Bought` or
   * `Sold`.** The seed template said `Bought` as a fixed string, which was
   * invisible while nothing could render this sentence and becomes a false
   * claim on every short the moment something can — the direction is exactly
   * the discriminator the phone test is about. It is a value rather than
   * prose because the three sites that observe a fill all hold `trade.side`
   * and none of them can be told apart in the registry.
   */
  entry_filled: {
    severity: "info",
    category: "trade",
    template: "{side} {size} {ticker} @ {price} — stop {sl}, target {tp}",
  },
  /** The broker accepted the entry order. Bookkeeping, not the fill. */
  entry_order_placed: { severity: "info", category: "order", template: null },
  entry_order_rejected: {
    severity: "error",
    category: "order",
    template: "The broker refused {display}'s entry order for {ticker} — nothing was bought or sold",
  },
  /** The pre-submit row write failed, so no order was sent at all. */
  entry_insert_failed: {
    severity: "error",
    category: "order",
    template:
      "{display} couldn't record its {ticker} trade before placing it, so no order was sent — nothing is open",
  },
  /**
   * The broker already holds a position on the contract the engine was
   * about to enter. The lock the engine keeps for exactly this missed it,
   * so the entry is refused rather than doubled.
   */
  entry_aborted_broker_position: {
    severity: "warn",
    category: "order",
    template:
      "{display} did not enter {ticker} — the account already holds a position there that the engine was not tracking",
  },
  /** The place response carried the bracket leg ids (Tradovate's OSO). */
  bracket_ids_attributed: { severity: "info", category: "order", template: null },
  /**
   * A bracket leg the broker had anchored to its own fill was moved onto
   * the trigger the strategy signalled. Only a broker whose brackets are
   * tick offsets resolved against the fill emits this.
   */
  bracket_reanchored: { severity: "info", category: "order", template: null },
  /**
   * The move failed, or was refused because the trigger-anchored price was
   * already through the market. The leg keeps the fill-anchored price it
   * had — the position stays protected, and the trade row is corrected to
   * the price actually resting so nothing reads it as trigger-anchored.
   */
  bracket_reanchor_failed: { severity: "warn", category: "order", template: null },
  /** The market exit is on the wire. `exit_filled` is the confirmation. */
  exit_submitted: {
    severity: "info",
    category: "trade",
    template: "Closing {display}'s {ticker} position — {reason}",
  },
  exit_filled: {
    severity: "info",
    category: "trade",
    template: "Closed {ticker} {pnl} — {reason}",
  },
  exit_order_placed: { severity: "info", category: "order", template: null },
  exit_order_rejected: {
    severity: "error",
    category: "order",
    template:
      "The broker refused {display}'s order to close {ticker} — the position is still open, and the engine retries on the next pass",
  },
  /** The exit latch turned a second dispatch away. Routine under a tick
   *  storm, which is why it is `info` and has no Activity phrasing. */
  exit_skipped_in_flight: { severity: "info", category: "order", template: null },
  /** The broker had nothing to close and the engine holds no open row. */
  exit_skipped_already_flat: { severity: "info", category: "order", template: null },
  /**
   * The broker says flat and the engine's own row says open. Nothing was
   * submitted and the position mirror is deliberately kept, so the next
   * pass re-reads the broker. The line is throttled at the call site per
   * `(deployment, trade)`; the throw it accompanies never is.
   */
  exit_flat_mismatch: {
    severity: "warn",
    category: "order",
    template:
      "{display}'s {ticker} position looks closed at the broker while the engine still has it open — nothing was sent, and the engine checks again shortly",
  },
  /** The post-exit sweep could not scope itself and said so. */
  exit_verify_no_evidence: { severity: "warn", category: "safety", template: null },
  exit_verify_failed: { severity: "warn", category: "safety", template: null },
  orphan_order_cancelled: { severity: "warn", category: "order", template: null },
  bracket_cancel_failed: { severity: "warn", category: "order", template: null },
  /** The force-close after a bracket failure could not be submitted. */
  force_close_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't close {display}'s {ticker} position after its stop failed to go on — the position is open without protection, and the engine retries on the next pass",
  },
  force_close_deferred: { severity: "info", category: "safety", template: null },
  force_close_not_needed: { severity: "info", category: "safety", template: null },
  /**
   * The exit landed and the row is closed with a price and a P&L.
   * Distinct from `exit_filled`, which is the Activity lane's account of
   * the same episode: this one is the reconciler saying which layer
   * resolved it, and the two must not fold into one name — the whole point
   * of `exit_resolution_source` is that the layer is worth knowing.
   */
  exit_reconciled: { severity: "info", category: "trade", template: null },
  /** What the engine missed while an account feed was disconnected. */
  replay_completed: { severity: "info", category: "connection", template: null },
  replay_failed: { severity: "warn", category: "connection", template: null },

  // ── The reconciler ───────────────────────────────────────────────────
  /** A closed row's price or P&L was corrected against the broker's fills. */
  pnl_healed: { severity: "info", category: "trade", template: null },
  /** The stored numbers and the broker's disagree, and the row was rewritten. */
  pnl_drift: { severity: "warn", category: "trade", template: null },
  exit_reason_relabelled: { severity: "info", category: "trade", template: null },
  /** An entry order that never filled and never closed, given up on. */
  entry_stale_cancelled: {
    severity: "warn",
    category: "order",
    template:
      "{display}'s entry order for {ticker} sat unfilled too long and was given up on — nothing is open",
  },
  entry_not_filled: {
    severity: "warn",
    category: "trade",
    template: "{display}'s entry order for {ticker} closed without filling — nothing is open",
  },
  /**
   * The engine's mirror said it held a position and the broker says flat.
   * Read-only: the sweep corrects its own bookkeeping and places nothing.
   */
  ghost_position_cleared: {
    severity: "warn",
    category: "safety",
    template:
      "{display} thought it held a {ticker} position that the broker says is already closed — the engine's records are corrected, and nothing was traded",
  },
  ghost_position_attribution: { severity: "warn", category: "safety", template: null },
  /**
   * A sync dropped the state entry of a leg holding a position (it was left
   * out, or moved account), so the engine stopped managing a live position:
   * no session-end exit, break-even or trail until the mirror is rebuilt.
   * Fires only when a position was held. Mechanism B of the session-end bug.
   */
  position_mirror_dropped: {
    severity: "warn",
    category: "safety",
    template:
      "{display} is no longer managed by the engine while it holds a {ticker} position — its stop and target stay at the broker, and the engine picks it up again at the next bar close only if the deployment comes back enabled",
  },
  /** Entry filled and no bracket orders could be found to attribute. */
  bracket_recovery_started: { severity: "warn", category: "order", template: null },
  bracket_retry_submitted: { severity: "info", category: "order", template: null },
  bracket_retry_succeeded: { severity: "info", category: "order", template: null },
  /** The retry placed brackets, but an exit landed while it was placing. */
  bracket_retry_raced: { severity: "warn", category: "order", template: null },
  /**
   * The trade row is missing the tick size or the desired distances, so
   * there is nothing to rebuild a stop and target *from* and the recovery
   * force-closes instead of retrying.
   *
   * Templated where the rest of this family is not, because it is the one
   * arm that ends in a position closing: it is deployment-scoped, so
   * `{display}` and `{ticker}` both resolve. **Not flagged** —
   * `notifyForceClose` builds the close its own rich embed, which is the
   * dedupe rule rather than a judgement about how loud this is.
   */
  bracket_recovery_metadata_missing: {
    severity: "error",
    category: "order",
    template:
      "{display}'s {ticker} trade is missing the numbers its stop and target are built from, so the engine is closing the position instead of retrying them",
  },

  // ── The market and user hubs ─────────────────────────────────────────
  //
  // Engine-wide, so none of them carries a deployment. `hub_reconnected` is
  // the exception with a template; the rest are diagnostics-only, and that
  // is the settled state rather than a pending one — the Activity lane
  // shipped without a way to render a line whose subject is the engine
  // itself, so giving these templates needs that question answered first.
  //
  // **The transition lines are `info` and the anomalies are not**, which is
  // the split the legacy `connection` level could not make: a reconnect
  // attempt failing while another session holds the single CME slot is
  // expected and routine, while a hub reporting Connected with no traffic
  // is the silent-death shape the watchdog exists for.
  hub_connected: { severity: "info", category: "connection", template: null },
  hub_disconnected: { severity: "info", category: "connection", template: null },
  hub_reconnecting: { severity: "info", category: "connection", template: null },
  hub_reconnect_failed: { severity: "info", category: "connection", template: null },
  hub_passive_mode: { severity: "info", category: "connection", template: null },
  /** Connected by the hub's own account, and silent. */
  hub_wedged: { severity: "error", category: "connection", template: null },
  hub_trade_silence: { severity: "warn", category: "connection", template: null },
  /**
   * `/Auth/validate` handed a REST caller a rotated bearer while the hubs
   * were open on the old one, which retires the session they are bound to.
   * `warn` rather than `error`: the engine acts on it within one heartbeat
   * and the line names a state it checked, but a rebuild is a gap in the
   * feed and a burst of these is a credential problem worth looking at.
   *
   * Not per-tick despite riding the heartbeat — the emitting site stamps the
   * new token as the hub's session before it logs, so the cause it keys on
   * is consumed by the first emission. That stamp *is* the throttle.
   */
  hub_token_rotated: { severity: "warn", category: "connection", template: null },
  user_hub_degraded: { severity: "warn", category: "connection", template: null },
  /**
   * A hub that failed to **construct**. `error`, not `warn`: this is not a
   * transient reconnect — the reconnect loop's own retries are the `warn`
   * thing — and on the 2026-08-26 staging boot both hubs threw at
   * construction and the container ran with no market data and no account
   * events (A56).
   */
  hub_init_failed: { severity: "error", category: "connection", template: null },
  /** Gave up reconnecting the user hub for this cycle. */
  hub_reconnect_abandoned: { severity: "warn", category: "connection", template: null },

  // ── Engine lifecycle ─────────────────────────────────────────────────
  engine_started: { severity: "info", category: "lifecycle", template: null },
  engine_stopped: { severity: "info", category: "lifecycle", template: null },
  /** Token expired and revalidation failed; the engine stopped itself. */
  engine_auth_failed: { severity: "error", category: "lifecycle", template: null },
  tick_failed: { severity: "error", category: "system", template: null },
  /** One deployment's tick threw; the others in the pass still ran. */
  deployment_tick_failed: {
    severity: "error",
    category: "system",
    template: "{display} hit an error on its last check and did not act — the engine tries again next bar",
  },
  /**
   * A bar stamped more than one bar interval ahead of the engine's clock:
   * either the bar cursor (`lastBarTimestamp`, live or restored from the
   * database) or a bar the feed served. A cursor ahead of the clock made the
   * dedupe skip every later bar, exits included, so it is discarded; a bar
   * ahead of the clock is left out of the series and never stamped. `warn`
   * because the feed or the clock is wrong. The engine throttles it per
   * deployment and cause (a served bar, the cursor) on a time window, not
   * per timestamp: a slow clock puts a new bar ahead of it on every close.
   * A live trigger bar ahead of the clock is `engine_clock_behind` instead.
   * Diagnostics-only.
   */
  bar_ahead_of_clock: { severity: "warn", category: "system", template: null },
  /**
   * A bar the live feed closed opens more than one bar interval after the
   * engine's clock. The aggregator only closes a bar on a trade stamped
   * after it, so the host clock is behind the exchange; the line says by at
   * least how much. Engine-scoped, because every leg shares the clock, and
   * throttled engine-wide on a time window. The bar is left out and REST's
   * newest is evaluated instead. Diagnostics-only.
   */
  engine_clock_behind: { severity: "warn", category: "system", template: null },
  /**
   * The deployment's strategy measures its signals over the instrument's
   * cash session, and the contract table has no session hours for that
   * ticker. Classified at activation, so it is emitted once per deployment
   * rather than on the tick that would have thrown — which is what makes a
   * `warn` admissible here. `warn` and not `error`: nothing failed and
   * nothing is retried, the configuration is refused and the operator has
   * to change the ticker or the strategy. `lifecycle`, because the subject
   * is what this deployment may do from now on.
   */
  deployment_day_session_missing: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — its strategy needs the instrument's cash-session hours and there are none on file for that symbol",
  },
  /**
   * The deployment's strategy declares the instrument it was calibrated for
   * and this deployment is on a different one. Classified at activation beside
   * the day-session refusal and carrying the same rules: announced once, `warn`
   * because nothing failed and nothing is retried, `lifecycle` because the
   * subject is what this deployment may do from now on. The operator's move is
   * a deployment on the declared instrument, or a playbook calibrated for this
   * one — the instrument is pinned at creation, so it is delete and recreate.
   */
  deployment_instrument_mismatch: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — its strategy was calibrated for a different instrument",
  },
  /**
   * The deployment is on an instrument whose contract row is on file for
   * research only (outside `DEPLOYABLE_SPEC_TICKERS`). Same rules as the
   * mismatch above; the create routes refuse it too, so a row reaches this
   * only by predating the refusal or by the list shrinking.
   */
  deployment_instrument_research_only: {
    severity: "warn",
    category: "lifecycle",
    template: "{display} won't take entries — its instrument is not open for live trading on this platform",
  },
  /**
   * The deployment enables an exit filter set to a timeframe only the live
   * engine fetches bars for, so no backtest or replay has ever exercised it.
   * Classified at activation beside the day-session refusal and carrying the
   * same rules: announced once, `warn` because nothing failed, `lifecycle`
   * because the subject is what this deployment may do from now on. Unlike the
   * other three the operator's move is an edit rather than a recreate — the
   * exit timeframe is a param on a form they still have.
   */
  deployment_cross_timeframe_exit_filter: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — an exit filter is set to a timeframe no backtest can evaluate, so it has never been measured",
  },
  /**
   * The warmup depth the deployment's strategy declares, converted to bars on
   * its timeframe, is past what one bar request reads. Classified at
   * activation beside the day-session refusal and for the same reasons: it is
   * a property of the saved row rather than of any bar, it is announced once,
   * and the operator's move is to change the timeframe or the lookback. The
   * timeframe is the usual cause — the same declaration is five times deeper
   * on 1m than on 5m.
   */
  deployment_warmup_depth_exceeded: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — the history its strategy needs on this timeframe is more than one bar request returns",
  },
  /**
   * The deployment's playbook is not registered in this build — a prod build
   * registers only the allowlist in `strategies/prod-playbooks.ts`, so a row
   * of any other key meets this at boot. Classified at activation beside the
   * four refusals above and carrying their rules: announced once per row,
   * `warn` because nothing failed and nothing is retried, `lifecycle` because
   * the subject is what this row may do from now on. The flat case; a row
   * holding a position takes the event below instead.
   */
  deployment_playbook_unavailable: {
    severity: "warn",
    category: "lifecycle",
    template: "{display} won't take entries — its playbook is not part of this build",
  },
  /**
   * The same row, holding a position — in the mirror or in an open trade row.
   * Unlike the four refusals above, the engine cannot manage it out: with no
   * module there is no session window and no exit hook, so the brackets at
   * the broker, the operator's flatten and a Pause (the closing guard closes
   * it through `forceFlatDeployment`) are what remain. `error` because the
   * code checked the position it names; `safety` because the subject is an
   * unmanaged position. Two emit sites: activation, once per row per process,
   * and the session-end guard, at most once per five minutes for as long as
   * the mirror holds the position or, from the second sighting, the trade row
   * is `open` over a null mirror (2026-10-27). Flagged because nothing else reaches the
   * operator about it and it has no hand-placed embed (logging-vocabulary.md,
   * Escalation).
   */
  deployment_playbook_unavailable_in_position: {
    severity: "error",
    category: "safety",
    template:
      "{display} holds a position nothing is managing — its playbook is not part of this build, so flatten it from its Dashboard row",
    escalates: true,
  },
  /**
   * A running leg's contract lookup failed and the leg had no subscription
   * to keep, so `syncContractSubs` left it out and kept every other leg's
   * feed. It gets no bars: no entries and no bar-close exits. The lookup
   * failing is all the code checked — a 429 and an unknown root read the
   * same — so the sentence claims no cause. Emitted on every sync (start,
   * edits, hub rebuilds, and the heartbeat's retry every five minutes while
   * it stands), never per tick. Flagged: nothing else reaches the operator.
   */
  deployment_contract_unresolved: {
    severity: "error",
    category: "safety",
    template:
      "{display} could not look up its contract with the broker, so it is not getting market data and will not trade until a lookup succeeds",
    escalates: true,
  },
  /**
   * The same lookup failure on a leg already subscribed: its existing stream
   * is kept, so it still gets bars and its exits still run. `warn`, not
   * flagged — nothing has stopped; the retry heals it or keeps saying so.
   */
  deployment_contract_lookup_failed: { severity: "warn", category: "connection", template: null },
  /**
   * A running deployment's account is one its broker last reported dead,
   * locked out, or (Topstep) with Auto OCO Brackets off, so the engine skips
   * its entries; an open position is still managed out. The account-state
   * entry gate (`engine-account-entry-gate.ts`) says each once per deployment
   * per reason, on the entry path where `{display}` is in hand, and never per
   * bar. `warn` because the deployment has stopped trading on a condition the
   * operator may have to act on; `lifecycle` because the subject is what this
   * deployment may do from now on. Three events rather than one with a reason
   * slot, the activation refusals' shape: each says what the operator's move is.
   */
  deployment_account_dead: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — its broker reports the account failed, ineligible or closed",
  },
  deployment_account_locked: {
    severity: "warn",
    category: "lifecycle",
    template: "{display} won't take entries until its account's lockout ends",
  },
  deployment_account_oco_off: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries — Auto OCO Brackets is off for its account in Topstep",
  },
  /** One of the three above cleared — a lock ended or a status check read the
   *  account tradable again — and the deployment takes entries. Said once. */
  deployment_account_entries_resumed: {
    severity: "info",
    category: "lifecycle",
    template: "{display} takes entries again — its account can trade",
  },
  /**
   * A safety sweep threw at its own boundary. One name for all five
   * sweeps, because the operator's question is the same however it
   * arrived: a guard that should have run did not, and coverage is
   * degraded until the next pass.
   */
  safety_sweep_threw: { severity: "error", category: "safety", template: null },
  /**
   * The nightly regime pass wrote the next session's labels. `info` and
   * diagnostics-only: nothing is gated on the label in this phase, so the
   * operator surface for it is the board chip and the Discord line, not the
   * Activity lane — and the job is emitted under the engine sentinel, naming
   * no deployment and no contract, so a `{display}` template would have
   * nothing to fill.
   */
  regime_labelled: { severity: "info", category: "lifecycle", template: null },
  /**
   * One instrument's label could not be computed, or came back `unknown`
   * because the bar read was short of the 250-session baseline. `warn` and
   * not `error`: the day is written `unknown`, which is the fail-closed
   * answer, a later fill replaces it, and nothing refuses a trade over it
   * until the gate ships. The lazy path emits it once more when its attempt
   * budget is spent, which is the line that says no further fill will run for
   * that session — the retries are bounded, so this is not a per-tick warn.
   */
  regime_label_failed: { severity: "warn", category: "lifecycle", template: null },
  /** D-14's crash-loop breaker. Exits keep running; entries do not. */
  flap_breaker_tripped: { severity: "warn", category: "lifecycle", template: null },
  downtime_flatten_complete: { severity: "info", category: "safety", template: null },
  /**
   * The liveness gate could not read the open-trade rows, so it declined
   * the heartbeat stamp — the flatten-ward bias, and the next boot reads a
   * gap it will act on. `safety` because the subject is what the next boot
   * does to a live position, not the write that failed; `warn` rather than
   * `error` because the *declining* is correct behaviour and only the
   * standing read fault is the condition. Diagnostics-only: it is emitted
   * under the engine sentinel, before any engine exists, and names neither
   * a deployment nor a contract — the `hub_reconnected` trap is giving it a
   * slot it can never fill. Throttled at the call site on
   * `LIVENESS_WRITE_WARN_MS`.
   */
  liveness_gate_unreadable: { severity: "warn", category: "safety", template: null },
  /**
   * The same decline, standing past `LIVENESS_DECLINE_ESCALATE_MS`: replaces
   * the warn on its anchor rather than joining it. Flagged because a frozen
   * stamp that old already guarantees the next boot force-flattens, and a
   * warn reaches nobody before then. Not kill-switch exempt: the stamper
   * retries every interval, so silence delays the news rather than losing it.
   * Engine-scoped with no subject, so `template: null` and the message titles
   * the alert.
   */
  liveness_gate_unreadable_persistent: {
    severity: "error",
    category: "safety",
    template: null,
    escalates: true,
  },
  /** The first read that answered after a run of declines. Once per run. */
  liveness_gate_readable_again: { severity: "info", category: "safety", template: null },
  /**
   * Every deployment on an account was auto-paused because the account is
   * unusable. Account-scoped, so it has no deployment and no contract to
   * name — diagnostics-only, because the Activity lane renders a leg and
   * there is still no answer for a line whose subject is an account. Giving
   * this one a template means answering that first.
   */
  account_orphaned: { severity: "warn", category: "lifecycle", template: null },
  /**
   * The sibling of `account_orphaned`: the cross-check declined to orphan an
   * account because the broker that owns it did not answer this fan-out.
   * `warn` because the engine is running with a question it could not settle,
   * and because A74 is what a silent skip looks like from the other side — an
   * operator reconstructing a quiet morning needs the account, the arm and the
   * broker's error in the stream they already filter. Account-scoped, so
   * diagnostics-only for the same reason `account_orphaned` is.
   */
  orphan_check_skipped: { severity: "warn", category: "lifecycle", template: null },
  /**
   * The broker an account routes through changed. `error` because every
   * order for it now resolves its contract somewhere else, and the
   * 2026-08-26 mis-routing incident was un-diagnosable because the only
   * lines about it were console-only.
   */
  broker_route_changed: { severity: "error", category: "broker", template: null },

  // ── The entry gate ───────────────────────────────────────────────────
  /**
   * A real signal refused because another deployment holds or is entering the
   * account's position on this contract. One event for both engine arms (the
   * open-position read and the lock claim), because to the operator they are
   * one fact. `info`, not `debug`: prod drops `debug`, and the daily parity
   * check needs to see a block live as the book does (A108). Fires only on a
   * bar `shouldEnter` signalled, so it is bounded like `entry_skipped`.
   */
  entry_contract_locked: { severity: "info", category: "trade", template: null },
  /**
   * A real signal refused because the stale-signal latch, set while another
   * deployment held the contract, has not been cleared by a bare `null` bar.
   * `entry_contract_locked`'s sibling and `info` for the same reason.
   */
  entry_stale_signal: { severity: "info", category: "trade", template: null },
  /**
   * A real signal refused because the account's daily P&L limit is reached
   * this session. `info` rather than `warn`: it repeats on every candidate bar
   * of every leg on the account until the session ends, and `warn` is never
   * per-tick.
   */
  entry_daily_pnl_limit: { severity: "info", category: "trade", template: null },
  /**
   * A real signal on a bar the entry hold refuses: one that opened before the
   * engine started, or before the feed recovered — the reason text says
   * which. The backtest takes that trade, so without this line the daily
   * parity check shows an unexplained miss after every deploy. Once per bar
   * per deployment (the bar stamp sits above it); a held bar with no signal
   * says nothing. `lifecycle`, not `trade`: the refusal is the engine's
   * start or the feed's recovery, not anything about the account.
   */
  entry_held_after_restart: { severity: "info", category: "lifecycle", template: null },
  /** The engine refused to arm an entry rather than ship a guess. */
  entry_blocked: {
    severity: "error",
    category: "trade",
    template: "{display} couldn't work out a safe order for {ticker}, so it did not enter",
  },
  // `entry_sl_out_of_range` was here. It named the deployment's Min/Max stop
  // gate refusing a strategy's stop, and that gate is deleted — the floor is a
  // playbook constant that widens rather than rejects, and the ceiling is the
  // budget refusal below. A historical row keeps its stored level and message;
  // `resolveLadder` falls back for an event the registry does not carry.
  /**
   * The stop was too wide for the account's per-trade budget to fit even one
   * contract. `warn`, not `error`: nothing is misconfigured and the next
   * setup may fit. It is louder than `info` because a run of these is a
   * deployment that is armed and taking nothing, which reads as a quiet
   * market on every other surface.
   */
  entry_risk_budget: {
    severity: "warn",
    category: "trade",
    template:
      "{display} didn't enter {ticker} — one contract at that stop would risk more than this account's per-trade budget",
  },
  /**
   * A bar close whose series is missing a bar the live feed already
   * published: the broker's bar history had not caught up, so the strategy
   * would have read two bars apart as neighbours. Entries only; exits and
   * stop management still ran on the bar. `warn` and `trade` for the reason
   * `entry_risk_budget` is — a skipped entry check that reads as a quiet
   * market on every other surface. The engine throttles the `warn` per
   * deployment, because a lagging history read tends to lag on the next
   * close too; the repeats inside the window go out at `info` without the
   * event, so every skipped check stays on record in prod. A `burstKey`
   * cannot do the throttle's job here: `trade` is exempt from burst
   * collapse, and its 30s window is shorter than any bar interval.
   */
  entry_bar_series_gap: {
    severity: "warn",
    category: "trade",
    template:
      "{display} skipped its entry check on {ticker} for this bar — the price history was missing the bar before it",
  },

  // ── The account's risk phase ─────────────────────────────────────────
  /**
   * The account is sizing on the lowest budget of its declared phase because
   * the app has no closing balance stamped for this session — a holiday, a
   * missed fan-out, or an engine that was down at the close.
   *
   * `lifecycle` rather than `trade`, because the subject is the account's
   * state for the whole session and not this leg's entry: `entry_risk_budget`
   * next door is a refusal of one signal, and this one refuses nothing. It is
   * the sibling of `account_orphaned`, which is account-scoped for the same
   * reason. `warn` because the account is trading smaller than the operator
   * set it to and nothing else says so; emitted once per account per session
   * from the engine's own anchor, never per tick.
   *
   * It carries a template although its subject is the account: unlike
   * `account_orphaned` it is emitted from the entry path, so the leg that hit
   * it fills `{display}`, and the call-site prose names the account, the phase
   * and both session stamps.
   */
  risk_phase_stale: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} is sizing at the lowest risk budget this account's phase allows — the app has no closing balance for today's session yet",
  },
  /**
   * The close sampler reached an account whose broker reported no usable
   * balance, so it wrote nothing. The catalogue's `balance` is safe to default
   * to `0` everywhere else and that default is withdrawn here: a zero close
   * reads as a busted account and would size the next session at its floor for
   * the wrong reason.
   *
   * `lifecycle` for the reason its sibling above is, and diagnostics-only for
   * the reason `account_orphaned` is: it runs under the engine sentinel in the
   * gap between sessions, names neither a deployment nor a contract, and a
   * slot it can never fill is not a template. The consequence is the sibling —
   * that account takes `risk_phase_stale` on its first entry tomorrow.
   */
  session_close_unsampled: { severity: "warn", category: "lifecycle", template: null },

  // ── Stop management ──────────────────────────────────────────────────
  /** A break-even or trailing ratchet landed at the broker. */
  stop_moved: {
    severity: "info",
    category: "trade",
    template: "Moved the stop on {display}'s {ticker} position",
  },
  stop_move_failed: {
    severity: "error",
    category: "order",
    template:
      "Couldn't move the stop on {display}'s {ticker} position — the old stop is still in place and the engine tries again",
  },
  /**
   * The persisted `slOrderId` was not usable and the fallback heuristic
   * matched **more than one** resting stop, which happens when two
   * deployments share an account and a contract. The move is refused rather
   * than guessed at.
   *
   * `stop_move_failed`'s sibling and not the same event: that one is the
   * broker rejecting a modify the engine had identified, this one is the
   * engine declining to identify. Neither escalates — the outcome is the
   * stop staying exactly where the strategy last put it, which is the safe
   * direction, and the next bar retries.
   */
  stop_move_ambiguous_sl: {
    severity: "error",
    category: "order",
    template:
      "Couldn't tell which resting stop belongs to {display}'s {ticker} position, so the engine left it where it is rather than move the wrong one — it tries again on the next bar",
  },
  /**
   * The ratchet asked for a stop at or past the market, so the engine
   * declined to send it. Third sibling of the two above and quieter than
   * either, because nothing failed and nothing was ambiguous: a break-even
   * arm reads the MFE of the bars since entry, so it fires on a bar whose
   * extreme reached the trigger even when the close is back through entry,
   * and the stop it then asks for would trigger the instant it landed.
   *
   * `info` rather than `warn` because the position is left holding the stop
   * it already had, the next bar retries, and a trade that pokes at its
   * break-even level and comes back is ordinary rather than degraded — the
   * ladder reserves `warn` for a state the operator should be watching.
   */
  stop_move_wrong_side: {
    severity: "info",
    category: "order",
    template:
      "Left {display}'s {ticker} stop where it is — the market has come back through the level the new stop would sit at, so placing it there would have closed the position immediately. The engine tries again on the next bar",
  },
  /**
   * The ratchet's candidate is not tighter than the stop already resting at
   * the broker (or, when the broker's order carries no price, the stop the
   * engine last set). `info` for the reason `stop_move_wrong_side` is: the
   * stop that stays is the safer one and nothing failed. `{reason}` names
   * which stop was compared, the broker's or the engine's, because on a
   * broker whose order list carries no price only the second is ever true.
   */
  stop_move_not_tighter: {
    severity: "info",
    category: "order",
    template:
      "Left {display}'s {ticker} stop where it is — {reason}. The engine tries again on the next bar",
  },
  /**
   * The resting stop order carries no price and the engine holds none, so it
   * cannot tell whether the move tightens and refuses it. `warn`, not `info`:
   * break-even and trail are off for that position meanwhile. The candidate
   * comes back every bar, so the call site throttles per trade
   * (`REPEAT_WARN_WINDOW_MS`) and sends the repeats at `info`.
   */
  stop_move_unknown_stop: {
    severity: "warn",
    category: "order",
    template:
      "Left {display}'s {ticker} stop where it is — the broker did not say where the stop is resting, so the engine could not check that the new one is tighter. It tries again on the next bar",
  },
  /**
   * An exit dispatch failed and the position was kept for the next tick.
   * Throttled at the call site on `(deployment, arm, error class, trade)`;
   * the message names the trade because the pipe folds on text it is
   * handed and would otherwise erase the discriminator the anchor keys on.
   */
  exit_dispatch_failed: { severity: "warn", category: "order", template: null },
  /**
   * A bar that reached entry-candidate state and was turned away by a gate
   * that could still pass later this session. It shares `info`/`trade` with
   * `entry_filled`, and this name is the only thing that tells the
   * TRADE-SKIP chip from the TRADE one — see `deriveLegacyLevel`.
   */
  entry_skipped: {
    severity: "info",
    category: "trade",
    template: "Didn't enter {ticker} on {display} — {gate} said no; the next bar is checked again",
  },
  /**
   * The clock guard's flatten. `trade` rather than `safety` for the reason
   * `deployment_close_flatten` states below: it is the line announcing a
   * position close, and the legacy level it replaces was `trade` — the chip
   * the operator has been reading it under. `safety` derives no chip, so
   * filing it there moved a close announcement from TRADE to INFO.
   */
  session_end_flatten: {
    severity: "info",
    category: "trade",
    template: "Session ended {time} — closed the {ticker} position",
  },
  /**
   * The closing guard's flatten. `trade` rather than `safety` because it is
   * the line announcing a position close — and because the legacy level it
   * replaces was `trade`, which is the chip the operator has been reading it
   * under.
   */
  deployment_close_flatten: {
    severity: "info",
    category: "trade",
    template: "Closing the {ticker} position on {display} so the deployment can finish shutting down",
  },
  deployment_settled: {
    severity: "info",
    category: "lifecycle",
    template: "{display} has finished closing — its position is confirmed flat",
  },
  /**
   * The per-deployment flatten. `trade` for the same reason
   * `deployment_close_flatten` is: it is the line announcing a position
   * close, whichever actor spoke it.
   *
   * A separate family from the closing guard's because the two answer
   * different questions — that one says the deployment is shutting down,
   * this one says the position was closed and the deployment stays armed.
   */
  deployment_flatten: {
    severity: "info",
    category: "trade",
    template: "Closing the {ticker} position on {display} — a flatten was requested for this deployment",
  },
  /**
   * Every arm on which the flatten did not reach the wire: no such row, no
   * broker registered for the account, the contract would not resolve, the
   * positions read threw, or the broker refused the order. One event because
   * the operator's question is the same in all of them — the position may
   * still be open.
   *
   * **Escalated, and the earlier reasoning for not escalating it was
   * wrong.** It read *"the caller is a request the operator is watching, so
   * an alert would page them about a button they are looking at"* — which
   * assumed a surface that does not exist yet. There is no UI: the result
   * is returned to an engine method with no reader, so without the flag a
   * failed emergency close reaches `/logs` and nobody else. It is also the
   * one escalation the notifications kill-switch does not silence; that
   * carve-out is named in logging/README.md and implemented in
   * `log-escalation.ts`.
   */
  deployment_flatten_failed: {
    severity: "error",
    category: "safety",
    escalates: true,
    template: "Couldn't close the {ticker} position on {display} — it may still be open",
  },
  /**
   * The flatten was asked for a deployment id this database has no row for.
   *
   * **Split out of `deployment_flatten_failed` on 2026-09-02, and the split
   * is about what the line may claim.** `getDeployment` does not filter
   * `deleted_at`, so null means no row has ever existed under that id — a
   * board holding a stale id, not a close that failed. The escalating event
   * paged an operator with *"the position may still be open"* about a
   * position this arm never identified, and its throttle keys on the
   * deployment id, so N stale ids were N pages. `warn` and not flagged: no
   * broker was reached, so nothing was left open.
   *
   * `template: null` because the subject is the thing that is missing —
   * `display` is derived from the same absent row, so a `{display}` slot
   * here could never fill.
   */
  deployment_flatten_no_row: {
    severity: "warn",
    category: "safety",
    template: null,
  },
  /**
   * The engine already had an exit on the wire when the flatten was
   * requested. Observational and nothing more: the flatten proceeds, which
   * is what makes this the line that explains a doubled fill count.
   */
  deployment_flatten_exit_in_flight: {
    severity: "warn",
    category: "safety",
    template:
      "The engine was already closing {display}'s {ticker} position when the flatten was requested — both orders may fill",
  },
  /**
   * The close is on the wire and there was no live trade row to record it
   * against, so the exit reason and order id are not on any row. `system`
   * rather than `trade`: the position is being closed correctly and what
   * failed is the bookkeeping.
   */
  deployment_flatten_unstamped: {
    severity: "warn",
    category: "system",
    template:
      "Closed {display}'s {ticker} position, but found no open trade to record the exit against",
  },
  /**
   * A flatten actor stood down because another one may still have an
   * unbooked market order against the same `(account, contract)`.
   *
   * One event for all five actors that take the shared cooldown, because
   * the operator's question is the same whichever of them spoke: something
   * is closing this position, and this pass chose to wait rather than
   * double it.
   *
   * **The template promises no retry, and that is a correction.** It ended
   * *"and the engine retries shortly"*, which was true of the four sweeps
   * and false of the subject the sentence names: `{display}` is this
   * deployment, this pass. `force_flat`'s one interval caller is the closing
   * guard, and its own stamp stands the guard down rather than retrying, so
   * its deferral is reported to its caller instead — and its own stamp is
   * followed up by nobody at all. The four actors that do retry say so in their own call
   * sites' prose, where the claim is checkable.
   */
  flatten_deferred: {
    severity: "warn",
    category: "safety",
    template:
      "Standing down on {display} — another close of {ticker} may still be unbooked, and the position is still open",
  },
  /**
   * P6's downtime sweep, the durable obligation a restart takes on. `trade`
   * for the same reason `deployment_close_flatten` is: it is the line
   * announcing a position close.
   */
  downtime_flatten: {
    severity: "info",
    category: "trade",
    template: "Closing the {ticker} position on {display} — it went unmanaged while the engine was away",
  },
  downtime_flatten_not_needed: {
    severity: "info",
    category: "safety",
    template:
      "{display} was owed a close after the engine was away, and its {ticker} position is already flat — nothing to do",
  },
  /** The owed position closed on its own and a *newer* one is open now. */
  downtime_flatten_superseded: {
    severity: "info",
    category: "safety",
    template:
      "The {ticker} position {display} was owed a close for is gone — what is open now started afterwards, so it is managed normally",
  },
  downtime_flatten_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't close the {ticker} position on {display} that went unmanaged while the engine was away — it is still open, and the engine keeps retrying",
    escalates: true,
  },
  /**
   * The durable obligation itself failing, as opposed to the flatten it
   * asks for. Three arms, all `error`/`safety` and all flagged: a position
   * owed a close that the engine cannot prove it made is exactly the class
   * the ladder exists for, and each of these is a way the *record* of that
   * obligation comes apart — it cannot be persisted, it cannot be read
   * back, or it was resumed with no boot verdict behind it.
   *
   * **All three are diagnostics-only, and that is a subject problem rather
   * than a preference.** They are emitted under the engine sentinel and
   * name a *count* of deployments, not one — there is no `{display}` and no
   * `{ticker}` the wire could ever fill, so the alert titles itself with
   * the message. Do not add a slot here to give them "a template"; that is
   * the `hub_reconnected` trap, recorded in `punchlist.md`.
   */
  downtime_obligation_write_failed: {
    severity: "error",
    category: "safety",
    template: null,
    escalates: true,
  },
  downtime_obligation_unreadable: {
    severity: "error",
    category: "safety",
    template: null,
    escalates: true,
  },
  /** Started owing a flatten with the boot verdict never applied this
   *  process, so the flap breaker was not evaluated either. */
  downtime_obligation_resumed_without_verdict: {
    severity: "error",
    category: "safety",
    template: null,
    escalates: true,
  },
  /** A `Pausing` / `Destroying` row that cannot get flat. */
  deployment_close_stranded: {
    severity: "error",
    category: "safety",
    template:
      "{display} was asked to close and its position is still open — the engine keeps retrying, and nothing new will be entered",
    escalates: true,
  },
  bracket_place_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't place the protective stop for {display} — the position is open without it, retrying",
  },
  /**
   * **The subject-less template, and the reason the rule allows one.** It
   * was seeded as *“Reconnected to market data”* and a mechanical test that
   * required a subject discriminator in every template forced `{display}`
   * onto it — on a line the market hub emits under the engine sentinel,
   * which has no display and never will. The result was a template that
   * rendered its message every time: a guaranteed fallback wearing a
   * sentence.
   *
   * The seed is back. An engine-scoped event may carry a template with no
   * subject **when the sentence is complete without one**, which this is:
   * the market feed is the engine’s, not a leg’s. What the relaxation does
   * *not* license is a subject-less rewrite of a line that is genuinely
   * about a leg or an account it cannot name — those take `template: null`
   * and let the call site’s own prose, which names the account, render.
   */
  hub_reconnected: {
    severity: "info",
    category: "connection",
    template: "Reconnected to market data",
  },
  /**
   * The bar-read path has been failing past the stall threshold. `error`
   * because the code measured the failing run before saying so, and
   * `connection` because that is what the line is about — the chip stays
   * ERROR either way, which is where an operator looks for it.
   *
   * Diagnostics-only, like every engine-wide event here: an Activity
   * template must carry a subject discriminator, and these lines have no
   * deployment to name. `hub_reconnected` is the one exception, and only
   * because its sentence is complete without a subject — see the note
   * there. Rendering the rest needs a way to show a line whose subject is
   * the engine, which the Activity lane does not have.
   */
  feed_down: { severity: "error", category: "connection", template: null },
  feed_restored: { severity: "info", category: "connection", template: null },
  /** Restored after an outage that ended before it could be announced. */
  feed_restored_unannounced: { severity: "warn", category: "connection", template: null },
  unmanaged_position_closed: {
    severity: "warn",
    category: "safety",
    template: "Closed a position the engine didn't open on {ticker} — its orders were cancelled first",
  },
  /**
   * The post-exit verification pass on a D-2 close. Diagnostics-only on
   * purpose: the Activity lane already gets `unmanaged_position_closed` for
   * the same event, and a second card re-asserting the same claim is the
   * *"two lines about one event"* problem arriving from the friendly side.
   * It exists so the line the operator does read stops contradicting the
   * one above it.
   */
  unmanaged_exit_verified: { severity: "info", category: "safety", template: null },
  /**
   * The session-end clock guard could not flatten past the window. It is the
   * last clock-driven thing between an open position and a prop-firm rule
   * violation, which is why it escalates: it spent its early life reaching
   * `/logs` and nobody else, on a failure the operator has minutes to act on.
   */
  session_exit_stranded: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't close {display} after its trading window ended — the position is still open, and the engine keeps retrying",
    escalates: true,
  },
  /**
   * The exchange early-close calendar is within a month of running out, or
   * has run out. Past its horizon the platform cannot tell a 13:00 half-day
   * from a full session and assumes full — which is the whole of
   * [bugs.md](../../../docs/bugs.md) A63, silently.
   *
   * It escalates for the same reason `session_exit_stranded` does, and fires
   * a month *ahead* of the horizon rather than after it: an alarm that first
   * sounds once the assumption is already live has waited too long. The
   * softer half of the ladder — the quarter's notice — is a plain `warn` at
   * the call site, because a Discord ping ninety days out is noise.
   */
  session_calendar_stale: {
    severity: "error",
    category: "safety",
    template:
      "The exchange early-close calendar is running out — until it is extended, the engine assumes every session closes at its normal time",
    escalates: true,
  },
  /**
   * The rest of the manual-position family — every refusal the sweep that
   * enforces D-2 can report, each with its own name.
   *
   * **This family is where the `[D-2]` prefix went.** A proposal decision id
   * prefixed the loudest line the safety path emitted, ten times over, and
   * three months later it says nothing to the person reading it. The
   * sentence after the tag was already good; the tag became the event name,
   * which is the thing a query can group on and a template can render from.
   *
   * All of these are `warn` and none of them escalates: they report states
   * the sweep **refuses to act on**, which is the guard doing its job. The
   * one condition an operator has to act on is
   * `manual_position_close_failed`, and it is the only `error` here.
   */
  /**
   * **The three account-scoped arms, all `template: null` as of 2026-08-27.**
   * Each was written with `{display}`’s account in it and each is emitted
   * under the engine sentinel — the sweep reads an *account*, not a leg —
   * so the slot could never fill and the line rendered its message every
   * time. A subject-less rewrite is the wrong repair here and right for
   * `hub_reconnected`: these sentences are *about* the account they cannot
   * name, and the call site’s prose already names it (truncated, by the
   * scrubber) along with the contract the engine could not read. The
   * message is the better sentence, so the message is what renders.
   */
  manual_position_lookup_failed: { severity: "warn", category: "safety", template: null },
  /** Engine-scoped, and the one line whose subject is a contract the parser
   *  could not read — so there is no ticker to render either, by
   *  construction. Its message carries the raw identifier, which is what
   *  the operator needs to find the position by hand. */
  manual_position_unreadable_contract: { severity: "warn", category: "safety", template: null },
  manual_position_shortfall: {
    severity: "warn",
    category: "safety",
    template:
      "The {ticker} position on {display} is smaller than the engine expected — it is being left alone, because reducing it could close a trade the engine still owns",
  },
  manual_position_entangled: {
    severity: "warn",
    category: "safety",
    template:
      "There is extra size on {display}'s {ticker} position mixed in with the engine's own — it is being left alone, because closing only the extra is not something the engine can do",
  },
  manual_position_window_unreadable: {
    severity: "warn",
    category: "safety",
    template:
      "{display}'s trading hours can't be read, so the engine is not claiming {ticker} — fix the session times; until then a hand position there is left alone",
  },
  manual_position_rows_unreadable: { severity: "warn", category: "safety", template: null },
  manual_position_strategy_missing: {
    severity: "warn",
    category: "safety",
    template:
      "{display} names a strategy the engine doesn't have, so a position on {ticker} it didn't open is being left alone",
  },
  /**
   * The exchange closes early today and the sweep held the close rather than
   * submitting a market order into a shut market.
   *
   * `warn` and unflagged like the rest of the refusals, on the same reading:
   * this is the sweep declining to act, and the thing an operator would do
   * about it — close it by hand — is what the message says. It is not
   * `manual_position_close_failed`, because nothing was submitted and nothing
   * failed; calling it a failure would page on a decision.
   */
  manual_position_exchange_closed: {
    severity: "warn",
    category: "safety",
    template:
      "The exchange closes early today, so a {ticker} position on {display} that the engine didn't open is being left alone until it reopens",
  },
  /** D-2 could not close a position the engine did not open. */
  manual_position_close_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't close a position on {display} that the engine didn't open — it is still open, and the engine keeps retrying",
    escalates: true,
  },
  /** The market exit filled and left size behind on the contract. */
  exit_verification_residual: {
    severity: "error",
    category: "safety",
    template:
      "{display} still has a position open after its exit — the engine will try to close it again on the next pass",
    escalates: true,
  },
  /**
   * The three raw account-feed frames, and the whole of gate decision 2.
   *
   * They render one line per order update, per fill and per position
   * update, which on a prod screenshot was dozens of `status=3
   * size=undefined` lines burying the four CONNECTION lines that carried
   * the story. `debug` is what drops them at the pipe in prod and keeps
   * them below it — and they are emitted **untagged**, through the engine
   * seam, so no `DEBUG_TAGS` opt-in stands between a staging boot and the
   * paper trail the Tradovate fill investigations read.
   *
   * Diagnostics-only: the Activity lane's account of a fill is
   * `entry_filled` / `exit_filled`, which say what happened rather than
   * what arrived on a socket.
   */
  order_frame: { severity: "debug", category: "broker", template: null },
  fill_frame: { severity: "debug", category: "broker", template: null },
  position_frame: { severity: "debug", category: "broker", template: null },

  // ── A broker's account feed ──────────────────────────────────────────
  //
  // Account-scoped, so none of them names a deployment or a ticker and all
  // are diagnostics-only. The `connection` half is the socket's own
  // lifecycle; the `broker` half is what arrived on it and could not be
  // used. **The transitions are `info` and the failures are not**, which is
  // the split the old `connection` level could not make — a reconnect while
  // another session holds the slot is routine, a frame the engine had to
  // drop is not.
  ws_connecting: { severity: "info", category: "connection", template: null },
  ws_subscribed: { severity: "info", category: "connection", template: null },
  ws_disconnected: { severity: "info", category: "connection", template: null },
  /**
   * A gatewaylogout advisory that escalated to a teardown inside the
   * window: another login holds the session slot. Split out of
   * `ws_disconnected` because it is not a transition — the transient closes
   * that keep that event are routine, and this one is the `warn` the site
   * emitted before it named an event.
   */
  ws_session_displaced: { severity: "warn", category: "connection", template: null },
  ws_token_refresh: { severity: "info", category: "connection", template: null },
  /** No usable token, so the socket cannot even be attempted this pass. */
  ws_token_unavailable: { severity: "warn", category: "connection", template: null },
  /** The socket or the protocol failed — construct, error, ack, parse. */
  ws_socket_failed: { severity: "warn", category: "connection", template: null },
  ws_send_failed: { severity: "warn", category: "connection", template: null },
  /** Connected and silent past the watchdog threshold. */
  ws_inbound_silence: { severity: "warn", category: "connection", template: null },
  /** A request the subscriber made came back non-OK. */
  ws_response_error: { severity: "warn", category: "broker", template: null },
  /** `searchOpenOrders`' order-version join read failed; orders keep their list fields. */
  order_version_join_failed: { severity: "warn", category: "broker", template: null },
  /** A translated frame threw on its way to the engine's handler. */
  frame_dispatch_failed: { severity: "warn", category: "broker", template: null },
  /** A hub frame arrived in a shape no known reading matches. */
  frame_unparseable: { severity: "warn", category: "broker", template: null },
  /**
   * A fill whose fee sibling never arrived in the same frame, dispatched
   * with `fees: null`. The documented degraded path, not a failure.
   */
  fill_fee_missing: { severity: "warn", category: "broker", template: null },
  /**
   * A fill for an order the engine has no mapping row for — a pre-existing
   * order, an operator's own, or a safety flatten. **The burst the whole
   * collapser was built for**: a cold boot drops ~23 of these in one frame,
   * every one carrying a different order id, which is why this is the one
   * site in the tree that hands the pipe a `burstKey`.
   */
  orphan_fill_dropped: { severity: "warn", category: "broker", template: null },
  /** A numeric contract id with no dated symbol cached yet. */
  contract_unmapped: { severity: "warn", category: "broker", template: null },
  /** The order-map table could not be read or written. */
  order_map_unreadable: { severity: "warn", category: "system", template: null },
  /**
   * A mapping row that did not persist. `error` rather than `warn` because
   * the row is what attributes a fill: without it the order's fills reach
   * the orphan-drop arm above and the trade never reconciles from them.
   */
  order_map_write_failed: { severity: "error", category: "system", template: null },
  ws_subscribe_failed: { severity: "warn", category: "connection", template: null },
  /** The reconnect loop hit its cap and is in its cooldown. */
  ws_reconnect_suppressed: { severity: "warn", category: "connection", template: null },
  /** The market is closed; the reconnect waits for the reopen. Routine. */
  ws_reconnect_deferred: { severity: "info", category: "connection", template: null },

  // ── A broker's REST surface ──────────────────────────────────────────
  /** The response parsed but part of it had to be thrown away. */
  broker_response_malformed: { severity: "warn", category: "broker", template: null },
  /** A transient failure the client is retrying itself. */
  broker_retry: { severity: "warn", category: "broker", template: null },
  /**
   * A code the gateway sent that this build has no mapping for, passed
   * through unmapped. **The drift arm doing its job** — see
   * [brokers/topstep.md]; identify a code against the docs before widening
   * the known set to silence it.
   */
  broker_code_unknown: { severity: "warn", category: "broker", template: null },
  broker_auth_failed: { severity: "warn", category: "broker", template: null },
  /**
   * The gateway refused a cached session token that its expiry says is
   * still good, and `/Auth/validate` would not revive it (A88). Emitted by
   * the caller that drops it from the cache, once per recovery — the
   * recovery's own cooldown is the throttle.
   */
  broker_token_dead: { severity: "warn", category: "broker", template: null },
  /** The mint that was to replace a dead token threw. Not flagged: the
   *  engine's own `engine_auth_failed` follows when the 401 reaches it. */
  broker_token_recovery_failed: { severity: "error", category: "broker", template: null },
  /** A rate-limit penalty the client is waiting out. */
  broker_penalty: { severity: "warn", category: "broker", template: null },
  /**
   * The broker has locked the app out — Tradovate's p-captcha, which
   * disables the third-party app for about an hour. Nothing reaches the
   * wire until it clears.
   */
  broker_locked_out: { severity: "error", category: "broker", template: null },
  /** A contract could not be warmed into the id ↔ symbol cache. */
  contract_warm_failed: { severity: "warn", category: "broker", template: null },

  // ── Boot ─────────────────────────────────────────────────────────────
  //
  // The operator's most-read surface and the one an unattended prod is
  // judged on. All engine-wide, so all diagnostics-only.
  //
  // **`boot: no enabled deployments — engine idle` and its two withheld
  // siblings are three events, not one.** Before A56/A57 they were one
  // sentence, and a Topstep outage that withheld every deployment printed
  // the same line as an operator who had enabled nothing. An engine that
  // silently trades nothing must never share a line with an engine that
  // correctly has nothing to trade — a new filter gets its own event here
  // in the same commit as its field.
  boot_started: { severity: "info", category: "lifecycle", template: null },
  /** Which brokers this install is configured for, named at boot. */
  boot_brokers_configured: { severity: "info", category: "lifecycle", template: null },
  /** No credentials at all — the wizard has not been run. Not a failure. */
  boot_no_credentials: { severity: "info", category: "lifecycle", template: null },
  /** The clean-shutdown marker landed, so the next boot alarms rather than
   *  reading absence as a crash. */
  shutdown_marker_written: { severity: "info", category: "lifecycle", template: null },
  /** The deploy measurement (zero-downtime-deploys.md, step 1): the old
   *  process was told to stop; how long the boot took to each stage; and
   *  when the first tick ran. Diagnostics, never Discord. */
  shutdown_signal: { severity: "info", category: "lifecycle", template: null },
  boot_timing: { severity: "info", category: "lifecycle", template: null },
  /**
   * The engine lease (one engine per database, engine-boot.md). Boot found
   * another process's fresh lease and is waiting for it to go stale — the
   * ordinary shape of a crash restart — and then took it.
   */
  engine_lease_waiting: { severity: "warn", category: "lifecycle", template: null },
  engine_lease_acquired: { severity: "info", category: "lifecycle", template: null },
  /**
   * An engine entry point refused because this process does not hold the
   * lease, and lost: the lease was taken by another process while this
   * engine ran, so it stopped. Either is two engines on one database, which
   * double-trades every account — flagged, engine-scoped, no subject to fill.
   */
  engine_lease_refused: { severity: "error", category: "safety", template: null, escalates: true },
  engine_lease_lost: { severity: "error", category: "safety", template: null, escalates: true },
  /**
   * The hand-off (engine-boot.md, *Hand-off*): a standby booted beside the
   * running engine, asked it for the engine, the active yielded and released
   * the lease at its exit, and the standby took it. Diagnostics, never
   * Discord — the deploy reads them. A standby that gave up is flagged: the
   * deploy failed, and the active is still trading on the old build.
   */
  standby_ready: { severity: "info", category: "lifecycle", template: null },
  handoff_requested: { severity: "info", category: "lifecycle", template: null },
  handoff_queued: { severity: "info", category: "lifecycle", template: null },
  handoff_yielded: { severity: "info", category: "lifecycle", template: null },
  handoff_taken: { severity: "info", category: "lifecycle", template: null },
  handoff_refused: { severity: "error", category: "safety", template: null, escalates: true },
  first_tick: { severity: "info", category: "lifecycle", template: null },
  /**
   * One account id came back from two brokers. `error` because every order
   * for it now routes by a coin flip, and the 2026-08-26 mis-routing
   * incident is what that looks like from the outside.
   */
  account_id_collision: { severity: "error", category: "broker", template: null },
  boot_idle: { severity: "info", category: "lifecycle", template: null },
  /**
   * Idle *and* a feed that did not come up — the engine will accept a
   * deployment and sit blind. A separate event from `boot_idle` on
   * purpose: A56 is what happened when one line was asked to describe both
   * states, and it said everything was fine on a container with no market
   * data and no account events.
   */
  boot_idle_feed_down: { severity: "warn", category: "lifecycle", template: null },
  /** Every enabled deployment was withheld by a filter. Not idle. */
  boot_all_withheld: { severity: "error", category: "lifecycle", template: null },
  /** A precondition failed hard; the engine did not start. */
  boot_refused: { severity: "error", category: "lifecycle", template: null },
  /** One broker's account fan-out arm threw. Prod continues, staging does not. */
  boot_broker_arm_failed: { severity: "warn", category: "lifecycle", template: null },
  boot_fanout_failed: { severity: "error", category: "lifecycle", template: null },
  boot_accounts_seeded: { severity: "info", category: "lifecycle", template: null },
  boot_staging_allowlist: { severity: "info", category: "lifecycle", template: null },
  /** A non-fatal boot step failed and the sequence carried on. */
  boot_step_failed: { severity: "warn", category: "lifecycle", template: null },
  /**
   * The registry this build made is not `PROD_PLAYBOOK_KEYS`: a listed
   * playbook is missing (its book leg takes no entries), or on prod one off
   * the list is registered (its rows can trade). Boot continues. `safety`
   * because the second half is a playbook the operator excluded being able to
   * trade; flagged because it reaches `/logs` and nothing else, once per boot.
   * Engine-scoped with no slot to fill, so the message is the alert's title.
   */
  boot_playbooks_mismatch: {
    severity: "error",
    category: "safety",
    template: null,
    escalates: true,
  },
  // The pending-session migration, which runs at boot and reports both a
  // summary and a per-row line. One family, not two, because the operator's
  // question is the same at either granularity.
  session_migration_done: { severity: "info", category: "lifecycle", template: null },
  session_migration_deferred: { severity: "warn", category: "lifecycle", template: null },
  session_migration_blocked: { severity: "warn", category: "lifecycle", template: null },
  /** The broker could not be asked, so the row is read as in-position. */
  session_migration_check_failed: { severity: "warn", category: "lifecycle", template: null },

  // The restart verdict's boot half — D-13. `safety`, because what these
  // decide is whether a position that went unmanaged gets closed.
  boot_no_prior_heartbeat: { severity: "info", category: "safety", template: null },
  boot_gap_within_rule: { severity: "info", category: "safety", template: null },
  boot_gap_exceeds_rule: { severity: "error", category: "safety", template: null },
  boot_downtime_flatten_owed: { severity: "error", category: "safety", template: null },
  /** Something the downtime flatten needs could not be read. */
  boot_obligation_unreadable: { severity: "error", category: "safety", template: null },

  // ── The database's own lines ─────────────────────────────────────────
  db_closed: { severity: "info", category: "system", template: null },
  db_close_failed: { severity: "error", category: "system", template: null },
  /**
   * A write that failed for a reason no caller could have avoided. The
   * driver's own sentence names a table and a column, so it belongs here and
   * not in an operator-facing response body.
   */
  db_error: { severity: "error", category: "system", template: null },
  /** A schema migration or a one-off backfill did something. */
  db_migration_applied: { severity: "info", category: "system", template: null },
  /**
   * A migration left rows it could not move — the strategy-key rename's
   * `OR IGNORE` meeting a new-key twin. `warn`, not `info`: a row on a key
   * nothing resolves is inert and the operator decides what to do with it.
   * Diagnostics-only, `db` tag, the prose names the table, key and count.
   */
  db_migration_rows_kept: { severity: "warn", category: "system", template: null },
  /**
   * The status backfill found disabled deployments still holding an open
   * trade and set them `Pausing`, which means the closing guard flattens
   * them at market on this boot. `warn`, because it is an order the
   * operator did not ask for on this run.
   */
  deployment_backfill_pausing: { severity: "warn", category: "lifecycle", template: null },
  /**
   * Rows from before *one deployment, N legs* survived into a build that
   * has no shape for them. The model change is a wipe, not a migration, so
   * this means the wipe was skipped. `error`, because the rows are inert —
   * they resolve no size and never trade — and inert rows on a board are
   * how an operator concludes a deployment is running when it is not.
   */
  deployment_premodel_rows: { severity: "error", category: "lifecycle", template: null },
  /**
   * A deployment the engine will not be given. The live-account block and
   * the staging allowlist are two reasons and two severities: a live
   * account is a policy refusal the operator needs to see, a
   * non-allowlisted account on staging is routine. A detached row is not
   * withheld — it is given to the engine and refused entries, and the entry
   * gate says so under `deployment_detached`. Boot's once-per-row *"exits
   * only"* line for it stays here: it is emitted under the engine tag with no
   * `{display}` to fill, and this event has no template to miss.
   */
  deployment_withheld: { severity: "warn", category: "lifecycle", template: null },
  /**
   * A detached deployment (`orphanReason` set) stays in the managed set and
   * the exit loop and opens nothing until Restore and arm clears the marker.
   * The account entry gate says it once per deployment on the entry path,
   * where `{display}` is in hand, and clears silently because the clear is
   * the operator's own press. `warn`/`lifecycle` for the reason the
   * account-gate refusals are.
   */
  deployment_detached: {
    severity: "warn",
    category: "lifecycle",
    template:
      "{display} won't take entries while it is detached — an open position is still managed to its exit, and Restore and arm clears it",
  },
  deployment_skipped_allowlist: { severity: "info", category: "lifecycle", template: null },
  /** A group turned on, off or was removed, with its legs following. */
  group_state_changed: { severity: "info", category: "lifecycle", template: null },
  /** The one-shot at boot retired the derived rows on cells their book no longer carries, naming them. */
  derived_rows_retired: { severity: "info", category: "lifecycle", template: null },
  /**
   * An operator write changed an account's risk row — per-trade budget,
   * contract ceiling, daily limits or phase — naming each field before and
   * after. `info`, because prod drops `debug` and the parity check reads this
   * line to know which limit was in force at a bar. `lifecycle` for the
   * reason `deployment_withheld` is: the subject is what the account may do
   * from now on. Diagnostics-only, `db` tag, no template: it is emitted from a
   * settings route with no deployment in scope, and its prose names the account.
   */
  account_risk_settings_changed: { severity: "info", category: "lifecycle", template: null },
  /**
   * The account-status check stored a different state or cause for an account
   * than the one it replaced — ok to locked, locked to ok, anything to dead, or
   * one lock's cause for another — naming the account, both states, the cause
   * and its figures. One line per change, never for a rewrite of the same
   * state, so the hourly and after-close checks say nothing while nothing
   * moves. `info`: the broker's state is a fact the engine reads, not a fault,
   * and the deploy and entry gates speak for what it refuses. `lifecycle` for
   * the reason `account_risk_settings_changed` is. Diagnostics-only: emitted
   * under the engine sentinel with no deployment in scope, and its prose names
   * the account. No Discord.
   */
  account_state_changed: { severity: "info", category: "lifecycle", template: null },
  /**
   * A book's or a playbook's switch went back on, and the row it would have
   * resumed stayed `Paused` because the playbook's declared instrument, day
   * session or registration no longer covers this ticker. `warn`, not `info`:
   * unlike the reconciler's create-arm `unregistered` skip there is a row
   * here — Paused, on the board, with trade history — and the operator just
   * asked for it to resume. `lifecycle` for the reason `deployment_withheld`
   * and `deployment_instrument_mismatch` are: the subject is what this row
   * may do from now on. Diagnostics-only: the call site's own prose names the
   * book, the playbook and the row, and none of `TaggedSubject`'s fields
   * reach a `display` a template could render from — this is emitted with the
   * `db` tag, not through an engine seam. Fires only on the resume arm, and
   * only from an operator write (`resumed` is always empty at boot), so it
   * does not reopen "a run that wrote nothing is silent".
   */
  book_resume_refused: { severity: "warn", category: "lifecycle", template: null },
  /**
   * A book on an account the deploy screen refuses — the live-account block,
   * or the account-state gate (dead, locked, Topstep OCO off or unknown) —
   * so the reconciler creates no deployment on it. `warn`: the book is on and
   * armed and runs nothing. Throttled in `reconcile.ts` on the account and
   * its reason, so a standing refusal is said once per process and a changed
   * reason again; a boot and every book route run the reconciler, and the
   * resting state must not repeat. Diagnostics-only, `db` tag, no template.
   */
  book_account_refused: { severity: "warn", category: "lifecycle", template: null },
  /**
   * The one-book-per-account migration merged an account's per-instrument
   * books into one, naming the cells it disarmed because they came from a
   * book that was off. Once per merged account, at the migration only.
   * Diagnostics-only, `db` tag, no template.
   */
  books_merged: { severity: "info", category: "lifecycle", template: null },
  /**
   * The one-time migration onto the books in code put a live account's book
   * on Combine, each playbook's switch as it was. Once per migrated account's
   * book, emitted from boot after the migration committed. Diagnostics-only,
   * `db` tag, no template.
   */
  book_types_migrated: { severity: "info", category: "lifecycle", template: null },
  /**
   * The same migration left a live account's book on its own links, because
   * it has a playbook on that Combine does not carry and moving it would stand
   * that playbook down at the boot. `warn`: the operator's move is *Move to
   * Combine*. Once per boot while it stands. Diagnostics-only, `db` tag.
   */
  book_not_migrated: { severity: "warn", category: "lifecycle", template: null },
  /**
   * *Move to <book>* moved an account onto another book in code: which
   * playbooks kept running, stood down and started. Once per move, from the
   * route after it committed. Diagnostics-only, `db` tag, no template.
   */
  book_moved: { severity: "info", category: "lifecycle", template: null },
  /**
   * A Discord alert did not reach the operator. `warn`, not `error`: the
   * line it was carrying is still in `engine_logs`, so what is lost is the
   * push, not the record.
   */
  alert_send_failed: { severity: "warn", category: "system", template: null },

  // ── The panic button ─────────────────────────────────────────────────
  //
  // `POST /api/deployments/flatten-all` — the last-resort close-everything
  // route, which is a **safety** action however it was reached. Its tag
  // already mapped that way; these give it the events too.
  flatten_all_complete: { severity: "info", category: "safety", template: null },
  /** An account whose positions could not even be listed. */
  flatten_all_accounts_unreadable: { severity: "warn", category: "safety", template: null },
  flatten_all_orders_unreadable: { severity: "warn", category: "safety", template: null },
  /**
   * The operator fired while the engine had an exit of its own on the
   * wire. **Reported, never deferred to**: the panic button must not be
   * refusable, so this exists to explain a doubled fill count rather than
   * to prevent one.
   */
  flatten_all_exits_in_flight: { severity: "warn", category: "safety", template: null },
  flatten_all_close_failed: {
    severity: "warn",
    category: "safety",
    template: "Couldn't close the {ticker} position when everything was flattened — it may still be open",
  },
  flatten_all_cancel_failed: { severity: "warn", category: "safety", template: null },
  /** The exit order id landed on the trade row, so the heal pass can scope. */
  flatten_all_exit_stamped: { severity: "info", category: "safety", template: null },
  /** It did not, so that close reconciles without an order to look up. */
  flatten_all_exit_unstamped: { severity: "warn", category: "safety", template: null },

  // ── The naked-position watchdog ──────────────────────────────────────
  //
  // Account-scoped, so these carry no deployment: the sweep's scope is the
  // trade row, per D-16. The ones that name a contract get a `{ticker}`
  // template off the `contract_id` column; the ones that are about a whole
  // account have no subject an Activity sentence could name, and are
  // diagnostics-only for that reason rather than by preference.
  naked_watchdog_lookup_failed: { severity: "warn", category: "safety", template: null },
  naked_watchdog_rows_unreadable: { severity: "warn", category: "safety", template: null },
  naked_watchdog_coverage_unreadable: { severity: "warn", category: "safety", template: null },
  /** First strike. Two consecutive observations are what trigger a flatten. */
  naked_position_observed: {
    severity: "warn",
    category: "safety",
    template:
      "A {ticker} position has no stop protecting it — if it is still unprotected on the next check, the engine closes it",
  },
  naked_position_flatten: {
    severity: "error",
    category: "safety",
    template: "Closing a {ticker} position that has no stop protecting it",
  },
  naked_position_flatten_submitted: {
    severity: "error",
    category: "safety",
    template: "The order to close the unprotected {ticker} position is on its way to the broker",
  },
  /**
   * Flagged, and the one flagged event with no subject to render a title
   * from: the sweep is account-scoped, so this is emitted under the engine
   * sentinel and `{ticker}` has no `display` to come out of. The alert
   * titles itself with the message instead — see
   * `notify/log-escalation.ts`. Do **not** answer that by giving the event
   * a `{display}` it can never fill.
   */
  naked_position_flatten_rejected: {
    severity: "error",
    category: "safety",
    template:
      "The broker refused the order to close the unprotected {ticker} position — it is still open with no stop, and the engine retries shortly",
    escalates: true,
  },

  // ── Bracket legs orphaned by a watchdog flatten ──────────────────────
  //
  // The closing market order leaves the OSO's stop and target resting, both
  // on the closing side, so against a now-flat account either one filling
  // *opens* an unbracketed reverse. That is why the failure arms here are
  // loud out of proportion to their wording.
  orphan_bracket_cancelled: {
    severity: "info",
    category: "safety",
    template: "Cancelled a leftover {ticker} order that the close left behind",
  },
  orphan_bracket_unresolved: {
    severity: "warn",
    category: "safety",
    template:
      "Couldn't tell which orders were left behind on {ticker} after closing it — check the account by hand, because one of them filling would open a new position",
  },
  orphan_bracket_lookup_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't look up the orders left behind on {ticker} after closing it — check the account by hand, because one of them filling would open a new position",
  },
  orphan_bracket_already_terminal: {
    severity: "warn",
    category: "safety",
    template: "A leftover {ticker} order was already gone at the broker — nothing is resting",
  },
  orphan_bracket_cancel_failed: {
    severity: "error",
    category: "safety",
    template:
      "Couldn't cancel a leftover {ticker} order after closing the position — if it fills it opens a new position the engine did not intend; cancel it by hand",
  },
};

export function eventSpec(event: string): EventSpec | undefined {
  return EVENTS[event];
}

/**
 * The Activity templates that carry no `{display}` and no `{ticker}`, named
 * rather than inferred.
 *
 * **A subject-less template is allowed only when the sentence is complete
 * without a subject** — *"Reconnected to market data"* is about the engine's
 * own feed, not a leg's. A line that is *about* a subject it cannot name
 * takes `template: null` instead. The rule used to be unconditional and it
 * manufactured the defect it was meant to catch: `hub_reconnected` was given
 * a `{display}` the engine sentinel can never fill, so it rendered its
 * message every time.
 *
 * It lives here beside the table it describes because two suites read it and
 * a second copy is a second thing to keep true — `vocabulary.test.ts` holds
 * the equality pin against the templates actually in `EVENTS`, so adding a
 * subject-less template stays a deliberate act, and `acceptance.test.ts`
 * reads it as criterion 1's exception list.
 */
export const SUBJECT_LESS_TEMPLATES: readonly string[] = [
  "hub_reconnected",
  // The exchange calendar is the platform's, not a leg's. Every deployment
  // is equally exposed to a stale one, so naming a subject would be picking
  // an arbitrary member of the set — and the engine sentinel it is emitted
  // under could not fill `{display}` anyway.
  "session_calendar_stale",
];

/**
 * A strategy's gate identifier as the Activity lane's `{gate}` slot —
 * `rangeTier` → *"the range tier gate"*, `filter:time_window` → *"the time
 * window filter"*.
 *
 * **Derived rather than looked up, and that is forced rather than chosen.**
 * `EntrySkip.gate` is a *stable identifier* the strategy author invents
 * (`cap`, `bodyClose`, `filter:adx`), so the set is open and there can be no
 * table of them the way `exit-reasons.ts` is a table. What a derivation can
 * do honestly is unpick the casing an identifier carries and stop there — it
 * never renames a gate and never guesses what one means.
 *
 * `null` for an empty gate, which is the withheld-slot state: the line falls
 * back to its own prose rather than saying *"the gate said no"*.
 */
export function describeEntryGate(gate: string): string | null {
  const raw = gate.trim();
  if (raw.length === 0) return null;
  const isFilter = raw.startsWith("filter:");
  const words = (isFilter ? raw.slice("filter:".length) : raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_:-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  // `slGate` already ends in the noun the phrase appends.
  const kind = isFilter ? "filter" : "gate";
  if (words[words.length - 1] === kind) words.pop();
  if (words.length === 0) return null;
  return `the ${words.join(" ")} ${kind}`;
}

// ── The envelope ───────────────────────────────────────────────────────

/**
 * What an Activity template's **non-subject** slots are filled from —
 * `{size}`, `{price}`, `{sl}`, `{tp}`, `{pnl}`, `{reason}`, `{gate}`,
 * `{time}`. `{display}` and `{ticker}` are not in here: they come off the
 * subject columns, which the pipe owns.
 *
 * **Rendering data, not structure.** A number arrives already formatted by
 * the convention its call site's embed uses, or as a bare count the viewer
 * stringifies; nothing keys on a value, nothing queries one, and a value
 * never enters the burst key — two lines that differ only in their values
 * differ in their message too, which is what the collapser reads.
 *
 * **A value may never carry an account number or a contract id.** That is a
 * construction rule at the call site rather than a filter here: a price and
 * a size are digit runs too, so there is no positional rule the way
 * `display` has one. The pipe scrubs every string value through
 * `scrubMessage` as a backstop, and `acceptance.test.ts` asserts the
 * backstop holds through the row, the ring, the wire and the Activity lane.
 *
 * **`display` and `ticker` are refused by the type, not only skipped at
 * render.** `slotValues` drops both keys so a value cannot outrank the
 * subject columns — `display` is truncated positionally and unconditionally
 * on the way into the pipe, while a value gets only the catalog-conditional
 * message rule, so a shadowing value is a route around the one account rule
 * with no timing hole in it. That skip is a runtime answer to a mistake the
 * compiler can give: the `never` pair fails the call site instead, which is
 * where the author is.
 */
export type LogValues = Readonly<Record<string, string | number>> & {
  readonly display?: never;
  readonly ticker?: never;
};

/** The subject columns. Full ids live here and are never rendered raw. */
interface LogSubject {
  /** `ENGINE_SCOPE` for a line that is not about one deployment. */
  deploymentId: string;
  /**
   * `account-strategy.ticker`. **Hand it the full account number** — the
   * pipe truncates it on the way in, so the rule lives in one place rather
   * than at every call site.
   *
   * **Both** engine seams derive it from the deployment row — `log()` and
   * `logEvent()` each call `displayFor(deploymentId)` — so an engine line
   * carries it whether or not it names an event. What leaves it null is a
   * `logger.ts` line, which has a tag instead of a deployment and so has no
   * row to read. A null renders as the deployment id.
   */
  display?: string | null;
  accountId?: number | null;
  contractId?: string | null;
  /**
   * The **rendered symbol** — `MNQ` — never the broker’s contract id.
   *
   * It exists for the line that names a contract and no deployment: the
   * naked-position and orphan-bracket sweeps are account-scoped, so there
   * is no `display` for a `{ticker}` slot to come out of. A ticker is
   * public market vocabulary — it names a product every exchange lists,
   * nothing about this operator, and nothing a broker would recognise as
   * an account — which is why it may cross to a browser where
   * `contractId` may not.
   */
  ticker?: string | null;
  /** The episode link: entry → brackets → exit → reconcile share it. */
  tradeId?: number | null;
  /** Already-rendered text. The pipe scrubs it; callers do not. */
  message: string;
  /**
   * The template's value slots, when the call site has them in hand. The
   * message keeps saying what it always said — these ride alongside it, so
   * the diagnostics lane is unchanged and the Activity lane gains a
   * sentence it could not render before.
   */
  values?: LogValues | null;
  /** The cause key a burst collapses on, when the site knows one. */
  burstKey?: string | null;
  /**
   * Set by `logger.ts` only. Its one remaining job is the `DEBUG_TAGS`
   * gate — it stopped selecting a console format when the two shapes
   * merged, and it stopped deciding a category before that.
   */
  tag?: string | null;
  /** Console-only structured detail. Scrubbed, never persisted. */
  meta?: unknown;
}

/**
 * One line, one shape.
 *
 * Either the line names a vocabulary `event` — in which case the registry
 * decides its severity and category and the caller may omit both — or it
 * names the pair itself. An `event` the registry does not carry falls to
 * `info` / `system`, the same answer an unclassified shim-A line gets.
 */
export type LogEnvelope = LogSubject &
  (
    | ({ event: string } & Partial<{ severity: Severity; category: LogCategory }>)
    | ({ event: null } & { severity: Severity; category: LogCategory })
  );

/**
 * Resolve the ladder for an envelope. **The registry outranks the caller**,
 * and that order is the escalation gate's safety property rather than a
 * preference: an event names a *kind* of thing, its severity is settled once
 * where the event is declared, and a call site that passes a quieter level
 * beside a flagged event must not be able to talk it out of ringing a phone.
 * The caller's pair is the fallback for an event the registry does not carry
 * — a typo, or a name that has not been enumerated yet — and `info`/`system`
 * is the answer when neither side has one.
 */
export function resolveLadder(env: LogEnvelope): { severity: Severity; category: LogCategory } {
  const spec = env.event === null ? undefined : EVENTS[env.event];
  return {
    severity: spec?.severity ?? env.severity ?? "info",
    category: spec?.category ?? env.category ?? "system",
  };
}
