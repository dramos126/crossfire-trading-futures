import { getDb, registerMigration } from "./connection";
import {
  EXIT_REASON_BRACKET_MANUAL,
  resolveExitReason as resolveExitReasonCode,
  type ExitReasonCode,
  type ResolvedExitReason,
} from "@/lib/logging/exit-reasons";

/**
 * Every `(label, code)` pair the `exit_reason_code` backfill rewrites,
 * **frozen at authorship on 2026-08-27 and deliberately not derived from
 * `EXIT_REASONS`.**
 *
 * A migration reads rows written by builds that are already history, so what
 * it must match is the labels those builds *wrote* — not the labels the
 * current table renders. Deriving the list live tied the two together: a
 * reword of `EXIT_REASONS[x].label` would silently change what an
 * un-migrated database backfills, and every row carrying the old wording
 * would be stranded at `exit_reason_code IS NULL` with nothing to heal it
 * (the relabel sweep matches the residual *code*, which those rows do not
 * have either).
 *
 * Sixteen entries for seventeen codes: `strategy_signal` and `realtime_exit`
 * render the same label and no surface distinguishes them, so the label maps
 * to the first of the two exactly as the derived list's dedupe did.
 *
 * **Divergence procedure.** `exitReasonCode.test.ts` asserts every pair here
 * still resolves through the live label index, so a reword fails
 * deliberately. When one is intended: reword the table, then *add* the new
 * `(label, code)` pair here — never edit the old one out. Both spellings
 * exist on disk somewhere.
 */
const EXIT_REASON_LABEL_BACKFILL: ReadonlyArray<{ label: string; code: ExitReasonCode }> = [
  { label: "Take Profit", code: "take_profit" },
  { label: "Stop Loss", code: "stop_loss" },
  { label: "Breakeven Stop", code: "breakeven_stop" },
  { label: "Trail Stop", code: "trail_stop" },
  { label: "Strategy Exit", code: "strategy_signal" },
  { label: "Strategy Exit · Time Stop", code: "time_stop" },
  { label: "Strategy Exit · EMA Close-Through", code: "ema_exit" },
  { label: "Time Window Close", code: "time_window_close" },
  { label: "Deployment Close", code: "deployment_close" },
  { label: "Force Close (bracket failure)", code: "bracket_failure_force_close" },
  { label: "Engine Downtime", code: "engine_downtime" },
  { label: "Hand Position Close", code: "manual_position_close" },
  { label: "Flatten All", code: "flatten_all" },
  // No row can predate this one — the label and its code shipped together
  // with the per-deployment flatten, so the backfill will never match it.
  // It is here because the completeness assertion is what stops a code
  // arriving *without* a pair, and carving out an exception would cost more
  // than the unused row.
  { label: "Flatten Deployment", code: "flatten_deployment" },
  { label: "Manual", code: "manual" },
  { label: "Bracket/Manual", code: "bracket_manual" },
];

/**
 * Exported for the drift test only. Nothing else may read it — the list is a
 * migration artifact, not a second copy of the exit-reason table.
 */
export const EXIT_REASON_LABEL_BACKFILL_PAIRS = EXIT_REASON_LABEL_BACKFILL;

/**
 * The one label that a submission site ever wrote into the *code* slot.
 * `/api/deployments/flatten-all` passed the display label to
 * `attachPendingExit`, which stores its argument verbatim, so a
 * `pending_exit` row from before that fix carries prose where a code
 * belongs — and the verbatim arm below would copy it across unchanged.
 * Nothing heals it afterwards: the relabel sweep matches
 * `exit_reason_code = 'bracket_manual'` and this row's code column says
 * `Flatten All`, so it would render the residual chip forever.
 */
const PENDING_CODE_SLOT_REPAIR: { readonly wrongCode: string; readonly code: ExitReasonCode } = {
  wrongCode: "Flatten All",
  code: "flatten_all",
};

/** The `app_settings` key that records the one-shot replay-cache clear ran.
 *  Exported for its test. */
export const REPLAY_CACHE_TAIL_CLEARED_KEY = "trades_replay_cache_tail_300_cleared_at";

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS strategy_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      strategy_key TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      side INTEGER NOT NULL,
      size INTEGER NOT NULL,

      entry_order_id INTEGER,
      entry_price REAL,
      entry_filled_at TEXT,
      entry_submitted_at TEXT NOT NULL,

      exit_order_id INTEGER,
      exit_price REAL,
      exit_filled_at TEXT,
      exit_submitted_at TEXT,
      exit_reason TEXT,

      pnl_ticks REAL,
      pnl_dollars REAL,
      tick_size REAL,
      tick_value REAL,

      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trades_deployment ON strategy_trades(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_trades_account ON strategy_trades(account_id);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON strategy_trades(status);
    -- Reconciler hot path: getReconcilableTrades filters by account_id AND
    -- status IN (...). The single-column indexes force a table scan once
    -- the trade table grows past a few thousand rows.
    CREATE INDEX IF NOT EXISTS idx_trades_recon ON strategy_trades(account_id, status);
  `);

  // Column adds are idempotent via try/catch — SQLite has no IF NOT EXISTS
  // for ALTER TABLE ADD COLUMN. On fresh DBs the CREATE TABLE above already
  // has them (once we extend it there), but the migration approach keeps
  // existing DBs intact.
  const addColumn = (col: string, type: string) => {
    try { d.exec(`ALTER TABLE strategy_trades ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  };
  addColumn("tp_order_id", "INTEGER");
  addColumn("sl_order_id", "INTEGER");
  addColumn("break_even_moved", "INTEGER NOT NULL DEFAULT 0");

  // SL classification flags set at the cause site (engine), not derived
  // from price arithmetic at exit time. break_even_moved already mirrors
  // sl_moved_to_be semantically — kept distinct only because the BE flag
  // is also a gate for "don't fire BE move twice" and may diverge from
  // the label-classification flag in future. sl_trail_engaged is reserved
  // for a future trail-ratchet path that modifies the SL bracket toward
  // the trail (today's trail logic issues a market exit, never an SL
  // modify). Both flags drive formatExitReason; missing flag → fallback
  // to the price-offset heuristic with a drift-detect warning.
  addColumn("sl_moved_to_be_flag", "INTEGER NOT NULL DEFAULT 0");
  addColumn("sl_trail_engaged", "INTEGER NOT NULL DEFAULT 0");

  // Where the break-even move put the stop: entry ± the filter's offset
  // ticks. `desired_sl_price` keeps the bracket as placed, so without this
  // the chart could only guess entry. Null = never moved, or a row from
  // before the column; nothing backfills it, because no older row recorded
  // the price.
  addColumn("break_even_sl_price", "REAL");

  // Slippage tracking: desired prices captured at order submit, deltas
  // filled in during reconcile once actual fill prices are known.
  // "Desired" = the price we would have filled at in the backtest model
  // (last closed bar's close for entry; entry±bracket_ticks for tp/sl).
  // "Actual" comes from Topstep reconciliation (entry_price / exit_price
  // on this row, or resolved via /Trade/search for bracket fills).
  addColumn("desired_entry_price", "REAL");
  addColumn("entry_slippage_ticks", "REAL");
  addColumn("entry_slippage_dollars", "REAL");
  addColumn("desired_tp_price", "REAL");
  addColumn("tp_slippage_ticks", "REAL");
  addColumn("tp_slippage_dollars", "REAL");
  addColumn("desired_sl_price", "REAL");
  addColumn("sl_slippage_ticks", "REAL");
  addColumn("sl_slippage_dollars", "REAL");

  // Bracket tick offsets the deployment was configured with at the
  // moment the entry was submitted. Stored alongside desired_tp_price /
  // desired_sl_price so the deployments UI can render
  // "21850.00 (+125t)" without re-deriving from current params (which
  // may have been edited since the trade was placed).
  addColumn("desired_tp_ticks", "REAL");
  addColumn("desired_sl_ticks", "REAL");

  // Per-trade exchange fees (in dollars, positive). Recorded alongside
  // pnl_dollars at exit-fill reconcile time. Stored separately from
  // pnl_dollars (which is now net of fees as of the engine update on
  // 2026-04-26) so the UI can render "fees: $X" tooltips and so we can
  // recompute gross if ever needed. Null on rows closed before this
  // column existed.
  addColumn("fees_dollars", "REAL");

  // True when closeTrade() was reached via the bar-close approximation
  // fallback (Trade/search hadn't indexed the real fill yet). The heal
  // pass re-runs resolveExitFromFills on these rows on every reconciler
  // tick and clears the flag once the real fill price + PnL land. Without
  // this flag a trade that closed via approximation stays frozen at the
  // wrong PnL forever.
  addColumn("exit_approximated", "INTEGER NOT NULL DEFAULT 0");

  // Best-effort backfill: any row already marked closed without an
  // exit_filled_at timestamp almost certainly went through the
  // approximation path. Mark them so the heal pass picks them up on the
  // next run; the resolver is a no-op if Trade/search still hasn't
  // indexed by then.
  d.exec(`
    UPDATE strategy_trades
    SET exit_approximated = 1
    WHERE status = 'closed'
      AND exit_filled_at IS NULL
      AND exit_approximated = 0
  `);

  // Hub-first exit reconciliation source label
  // (docs/proposals/userhub-trade-subscription.md §Call sites that change
  // item 11). Values: 'buffer' (Layer 1 user-hub drain) | 'rest' (Layer 2
  // /Trade/search) | 'approximated' (Layer 3 bar-close). Kept in lockstep
  // with `exit_approximated`: 'approximated' ↔ 1, otherwise 0. Default
  // for existing rows is 'rest' — closest to historical behavior, since
  // Layer 2 was the primary path before Layer 1 shipped.
  addColumn("exit_resolution_source", "TEXT");
  d.exec(`
    UPDATE strategy_trades
    SET exit_resolution_source = CASE
      WHEN exit_approximated = 1 THEN 'approximated'
      ELSE 'rest'
    END
    WHERE status = 'closed' AND exit_resolution_source IS NULL
  `);

  // **When this row was first seen to be closed. Written once, never again.**
  //
  // The session window over closed trades — the daily-P&L gate's, and the
  // board's — has to answer "did this close in the current session" for a row
  // whose `exit_filled_at` is still null, because Layer 3 of the exit cascade
  // writes real money and leaves the fill timestamp to the heal pass.
  // `updated_at` looked like the answer and is not: `backfillEntryFilledAt`,
  // `backfillExitOrderId` and `setExitReason` all bump it on a closed,
  // still-unhealed row, and each runs over a 7-day window — so a week-old loss
  // could be restamped into today and trip today's limit, halting a deployment
  // that should be trading. This column has exactly one writer, in
  // `closeTrade`, guarded by COALESCE so a re-close cannot move it.
  addColumn("exit_detected_at", "TEXT");
  // Backfill from `updated_at` because it is the only evidence these rows
  // carry, and for a row nothing has touched since it closed it is exact. A
  // row that *was* touched is at worst placed late, which is the same error
  // the pre-migration code already had and is bounded by this one-time run.
  d.exec(`
    UPDATE strategy_trades
    SET exit_detected_at = updated_at
    WHERE status = 'closed' AND exit_detected_at IS NULL
  `);

  // Per-trade bar snapshot. Topstep only retains bars for the active +
  // most-recent-prior contract (~3 months of usable history per
  // strategy on standard timeframes), so without snapshotting, charts
  // for older closed trades would render empty and post-mortem review
  // breaks down. Snapshotted on the engine's exit-fill path; bars are
  // stored as a compact JSON blob keyed by trade id. Window is wide
  // enough for the strategy to draw EMA-50 cleanly (300 bars before
  // entry — 6× period — plus 50 after exit).
  d.exec(`
    CREATE TABLE IF NOT EXISTS strategy_trade_bars (
      trade_id INTEGER PRIMARY KEY REFERENCES strategy_trades(id) ON DELETE CASCADE,
      bars_json TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Re-snapshot queue. The at-exit snapshot only contains bars Topstep
  // has *already* published — for a trade that just closed, that's
  // entry-300 → now, missing the post-exit context. We mark the row
  // with snapshot_due_at = exitTime + 50 × tf and re-fetch via the
  // reconciler tick once that time arrives. Survives engine restarts
  // and offline windows because the queue lives in SQLite.
  // snapshot_due_at IS NULL once the snapshot is complete (or after
  // we've given up retrying).
  const addBarsColumn = (col: string, type: string) => {
    try { d.exec(`ALTER TABLE strategy_trade_bars ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  };
  addBarsColumn("snapshot_due_at", "TEXT");
  addBarsColumn("snapshot_retry_count", "INTEGER NOT NULL DEFAULT 0");
  // Wallclock at which the snapshot's post-exit window is fully populated.
  // The replay route uses this to gate the snapshot vs. live-fetch decision:
  // an immature snapshot truncates near the trigger bar and would false-tag
  // recently-closed trades as "insufficient post-entry bars for replay".
  // NULL = mature (either born mature post-maturityMs, or row predates this
  // column).
  addBarsColumn("bars_mature_at", "TEXT");

  // Param + filter-state snapshots captured at order-placement time. Drive
  // the live-vs-backtest replay engine: replaying against current
  // deployment params is dishonest the moment a deployment is edited,
  // so the snapshot pins the params the live trade actually fired with.
  // Filter snapshot captures runtime gates (cooldown, contract lock from
  // a different deployment) that aren't derivable from bars + params.
  // Both null on rows that predate this column — the replay engine
  // short-circuits with "no snapshot, can't compare" rather than lying.
  addColumn("param_snapshot", "TEXT");
  addColumn("filter_snapshot", "TEXT");

  // Replay-result cache. Closed trades are immutable, so we compute the
  // BacktestReplayResult once on first request and store it here; later
  // route hits return the cached blob. Null until first replay. Stored
  // as JSON blob keyed off the trade row directly (not a side table) —
  // simplest invalidation story, since invalidation never happens.
  addColumn("replay_result_json", "TEXT");

  // One-shot: every blob cached before the snapshot's post-exit tail went
  // from 50 to 300 bars may hold the $0 result the wider tail fixed, and
  // nothing else ever clears a closed trade's cache. Completion is stamped in
  // `app_settings` because this block re-runs on every boot, and without the
  // stamp each boot would throw away every replay computed since. That table
  // belongs to `settings.ts`, so the existence guard applies: no table, no
  // clear, and the next boot does it.
  const settingsTable = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'`)
    .get();
  if (settingsTable) {
    // The read sits inside an immediate transaction and the stamp is
    // `INSERT OR IGNORE`, so two processes opening the file on the same
    // first boot cannot both clear or throw a key conflict out of `getDb()`.
    d.transaction(() => {
      const cleared = d
        .prepare(`SELECT 1 FROM app_settings WHERE key = ?`)
        .get(REPLAY_CACHE_TAIL_CLEARED_KEY);
      if (cleared) return;
      d.exec(`UPDATE strategy_trades SET replay_result_json = NULL WHERE replay_result_json IS NOT NULL`);
      d.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`)
        .run(REPLAY_CACHE_TAIL_CLEARED_KEY, new Date().toISOString());
    }).immediate();
  }

  // Engine session + deployment version stamped at trade entry. Drives
  // the analytics-panel exclusion bucket: trades whose values don't match
  // the current engine session / deployment version are flagged as
  // "from a prior engine session or deployment version" and dropped from
  // analytics aggregation. Null on rows that predate this column —
  // null-as-include semantics: the analytics panel treats null as
  // "predates session tracking, include unconditionally" so existing
  // history flows through unchanged.
  addColumn("engine_session_id", "TEXT");
  addColumn("deployment_version_id", "TEXT");

  // Timestamp of the bar whose close produced the entry signal. Persisted
  // at entry because it cannot be reconstructed afterwards: the monthly
  // review joins live trades to backtest trades on
  // (strategy_key, ticker, signal_bar_ts), and `entry_submitted_at` is a
  // wallclock that drifts from the bar by however long the broker round
  // trip took. Null on rows written before this column.
  addColumn("signal_bar_ts", "TEXT");

  // The regime label this trade was taken under, and the classifier version
  // that produced it. Written at entry from `regime_days` and never rewritten:
  // a label recomputed later is a label under whatever classifier is on disk
  // then, and the whole point of the version is that a persisted label and a
  // recomputed one can be compared rather than confused. Both null on rows
  // written before the columns existed — `"unknown"` is a real label the
  // classifier emits and is stored as one, so NULL means only "unlabelled".
  addColumn("regime_label", "TEXT");
  addColumn("regime_classifier_version", "TEXT");

  // The strategy's own session key from the entry signal, which is what the
  // engine's one-per-side latch is keyed on. The key is strategy-defined
  // (today every module uses the ET date), so the engine cannot re-derive it
  // from a timestamp afterwards — a restart rebuilds the latch from this
  // column, and a fill after a restart latches from it (bugs-fixed.md A92).
  // Null for a strategy that emits no key, which opts out of the latch, and
  // on rows written before the column.
  addColumn("session_key", "TEXT");

  // The exit reason's owner. `exit_reason` keeps the rendered label — the
  // chip tooltip, the CSV export and every pre-migration row read it — and
  // this column carries the stable code the label is rendered *from*. The
  // relabel sweep matches here, so a wording change can no longer silently
  // un-match rows.
  addColumn("exit_reason_code", "TEXT");

  // Backfill, in two shapes because the old column meant two things.
  //
  //  - A `pending_exit` row's `exit_reason` *is* the raw submitted code —
  //    `attachPendingExit` wrote it there — so it moves across verbatim,
  //    with one repair for the single label a submission site ever wrote
  //    into the code slot (see `PENDING_CODE_SLOT_REPAIR`). Without this
  //    arm, a trade in flight across the migration would close onto the
  //    residual label.
  //  - A `closed` row's `exit_reason` is a rendered label, so it maps back
  //    through `EXIT_REASON_LABEL_BACKFILL` — frozen, not derived from the
  //    live table, for the reason stated there. A label the list does not
  //    carry (a strategy detail suffix that predates the current wording,
  //    say) stays null and reads as "no envelope", which is the honest
  //    answer.
  //
  // `entry_failed` rows are deliberately untouched: `markEntryFailed`
  // stores a broker rejection message in the same column, and that is not
  // an exit reason at all.
  //
  // Both arms are sixteen full-table UPDATEs and every migration block
  // re-runs on every boot, so one `SELECT EXISTS` goes in front of them:
  // after the first run there is nothing left to match and boot pays a
  // single indexed-free probe instead of sixteen scans. The probe's
  // predicate is the union of both arms' predicates, so anything either
  // one would touch keeps them running.
  const probe = d.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM strategy_trades
      WHERE exit_reason_code IS NULL
        AND exit_reason IS NOT NULL
        AND status IN ('pending_exit', 'closed')
    ) AS needed
  `).get() as { needed: number };
  if (probe.needed === 1) {
    d.prepare(`
      UPDATE strategy_trades
      SET exit_reason_code = CASE exit_reason WHEN ? THEN ? ELSE exit_reason END
      WHERE status = 'pending_exit'
        AND exit_reason IS NOT NULL
        AND exit_reason_code IS NULL
    `).run(PENDING_CODE_SLOT_REPAIR.wrongCode, PENDING_CODE_SLOT_REPAIR.code);
    const backfill = d.prepare(`
      UPDATE strategy_trades
      SET exit_reason_code = ?
      WHERE status = 'closed'
        AND exit_reason = ?
        AND exit_reason_code IS NULL
    `);
    for (const { label, code } of EXIT_REASON_LABEL_BACKFILL) backfill.run(code, label);
  }
});

export type { TradeStatus, StrategyTrade, PnLSummary } from "./trade-types";
import type { TradeStatus, StrategyTrade } from "./trade-types";

interface TradeRow {
  id: number;
  deployment_id: string;
  strategy_key: string;
  account_id: number;
  ticker: string;
  contract_id: string;
  side: number;
  size: number;
  entry_order_id: number | null;
  entry_price: number | null;
  entry_filled_at: string | null;
  entry_submitted_at: string;
  signal_bar_ts: string | null;
  regime_label: string | null;
  regime_classifier_version: string | null;
  session_key: string | null;
  tp_order_id: number | null;
  sl_order_id: number | null;
  break_even_moved: number;
  sl_moved_to_be_flag: number;
  sl_trail_engaged: number;
  break_even_sl_price: number | null;
  exit_order_id: number | null;
  exit_price: number | null;
  exit_filled_at: string | null;
  exit_submitted_at: string | null;
  exit_reason: string | null;
  exit_reason_code: string | null;
  pnl_ticks: number | null;
  pnl_dollars: number | null;
  tick_size: number | null;
  tick_value: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  desired_entry_price: number | null;
  entry_slippage_ticks: number | null;
  entry_slippage_dollars: number | null;
  desired_tp_price: number | null;
  tp_slippage_ticks: number | null;
  tp_slippage_dollars: number | null;
  desired_sl_price: number | null;
  sl_slippage_ticks: number | null;
  sl_slippage_dollars: number | null;
  desired_tp_ticks: number | null;
  desired_sl_ticks: number | null;
  fees_dollars: number | null;
  exit_approximated: number;
  exit_resolution_source: string | null;
  exit_detected_at: string | null;
  param_snapshot: string | null;
  filter_snapshot: string | null;
  replay_result_json: string | null;
  engine_session_id: string | null;
  deployment_version_id: string | null;
}

function rowToTrade(r: TradeRow): StrategyTrade {
  return {
    id: r.id,
    deploymentId: r.deployment_id,
    strategyKey: r.strategy_key,
    accountId: r.account_id,
    ticker: r.ticker,
    contractId: r.contract_id,
    side: r.side as 0 | 1,
    size: r.size,
    entryOrderId: r.entry_order_id,
    entryPrice: r.entry_price,
    entryFilledAt: r.entry_filled_at,
    entrySubmittedAt: r.entry_submitted_at,
    signalBarTs: r.signal_bar_ts,
    regimeLabel: r.regime_label,
    regimeClassifierVersion: r.regime_classifier_version,
    sessionKey: r.session_key,
    tpOrderId: r.tp_order_id,
    slOrderId: r.sl_order_id,
    breakEvenMoved: r.break_even_moved === 1,
    slMovedToBreakeven: r.sl_moved_to_be_flag === 1,
    slTrailEngaged: r.sl_trail_engaged === 1,
    breakEvenSlPrice: r.break_even_sl_price ?? null,
    exitOrderId: r.exit_order_id,
    exitPrice: r.exit_price,
    exitFilledAt: r.exit_filled_at,
    exitSubmittedAt: r.exit_submitted_at,
    exitReason: r.exit_reason,
    exitReasonCode: r.exit_reason_code,
    pnlTicks: r.pnl_ticks,
    pnlDollars: r.pnl_dollars,
    feesDollars: r.fees_dollars,
    tickSize: r.tick_size,
    tickValue: r.tick_value,
    status: r.status as TradeStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    desiredEntryPrice: r.desired_entry_price,
    entrySlippageTicks: r.entry_slippage_ticks,
    entrySlippageDollars: r.entry_slippage_dollars,
    desiredTpPrice: r.desired_tp_price,
    tpSlippageTicks: r.tp_slippage_ticks,
    tpSlippageDollars: r.tp_slippage_dollars,
    desiredSlPrice: r.desired_sl_price,
    slSlippageTicks: r.sl_slippage_ticks,
    slSlippageDollars: r.sl_slippage_dollars,
    desiredTpTicks: r.desired_tp_ticks,
    desiredSlTicks: r.desired_sl_ticks,
    exitApproximated: r.exit_approximated === 1,
    exitResolutionSource: parseExitResolutionSource(r.exit_resolution_source),
    exitDetectedAt: r.exit_detected_at ?? null,
    paramSnapshot: parseJsonRecord(r.param_snapshot),
    filterSnapshot: parseJsonRecord(r.filter_snapshot),
    replayResultJson: r.replay_result_json,
    engineSessionId: r.engine_session_id,
    deploymentVersionId: r.deployment_version_id,
  };
}

/** Defensive JSON.parse for snapshot columns. Topstep API responses are
 *  validated at boundaries; these blobs are *our own* writes, but a
 *  corrupt/legacy row shouldn't crash the trades list — fall back to
 *  null and let the replay engine treat it as "no snapshot". */
/** Cast a raw `exit_resolution_source` value into the StrategyTrade enum.
 *  Anything outside the known set degrades to null so a stray write
 *  doesn't crash the trades list. */
function parseExitResolutionSource(
  raw: string | null,
): "buffer" | "rest" | "approximated" | null {
  if (raw === "buffer" || raw === "rest" || raw === "approximated") return raw;
  return null;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw == null || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface InsertEntryInput {
  deploymentId: string;
  strategyKey: string;
  accountId: number;
  ticker: string;
  contractId: string;
  side: 0 | 1;
  size: number;
  /** Null when the row is inserted BEFORE the broker `placeOrder` call to
   *  pre-empt the user-hub position-event race (engine.ts:placeEntryOrder).
   *  `setEntryOrderId` stamps the broker-returned id moments later when
   *  placeOrder resolves. */
  entryOrderId: number | null;
  entrySubmittedAt: string;
  /** Timestamp of the bar whose close produced this signal. See
   *  `StrategyTrade.signalBarTs` for why it is persisted here and not
   *  derived later. */
  signalBarTs?: string;
  /** The regime label in force for the signal bar's session day and the
   *  version that produced it, taken as a pair. Absent when no row was
   *  labelled yet — the label is stamped, never re-derived, so an absent
   *  one stays absent. See `StrategyTrade.regimeLabel`. */
  regimeLabel?: string;
  regimeClassifierVersion?: string;
  /** `EntrySignal.sessionKey`, absent when the strategy emitted none. */
  sessionKey?: string;
  tickSize?: number;
  tickValue?: number;
  /** Last closed bar's close at signal time — the price the backtest
   * model would have filled this entry at. Used post-fill to compute
   * entry slippage. */
  desiredEntryPrice?: number;
  /** TP bracket target price, computed at submit time as
   * entry ± tp_ticks * tickSize. Stored so post-fill we can show
   * desired-vs-actual even if the bracket gets modified later (breakeven). */
  desiredTpPrice?: number;
  desiredSlPrice?: number;
  /** Tick offsets the deployment was configured with at submit time.
   * Stored on the row so the trades table can render "+125t / -75t"
   * even after the user edits the deployment params. */
  desiredTpTicks?: number;
  desiredSlTicks?: number;
  /** Merged deployment params (defaults + overrides) at submit time.
   * Pinned for the replay engine — see paramSnapshot on StrategyTrade. */
  paramSnapshot?: Record<string, unknown>;
  /** Runtime gates (cooldown anchor, contract-locked-by-other) at
   *  submit time. Pinned for the replay engine. */
  filterSnapshot?: Record<string, unknown>;
  /** Process-lifetime UUID for the running engine. Stamped on the row so
   *  analytics can exclude trades fired under a different engine session. */
  engineSessionId?: string;
  /** Deployment's `version` value at the moment of capture, stringified.
   *  Increments on every deployment PATCH; analytics excludes trades whose
   *  stamped version doesn't match the deployment's current version. */
  deploymentVersionId?: string;
}

let tradeWriteListener: (() => void) | null = null;

/**
 * Installed by the engine, which relays it to the browser as `tradesChanged`.
 * Registered rather than imported, as the log pipe's sinks are: the relay is
 * engine-process state this table module does not reach (engine/handle/index.ts).
 *
 * So it exists only in the process that runs the engine. A write a `web`
 * process's route makes — `flatten-all`'s `attachPendingExit`, a dev delete —
 * announces nothing, and other tabs see it on their next stream reconnect.
 */
export function setTradeWriteListener(listener: (() => void) | null): void {
  tradeWriteListener = listener;
}

/**
 * Every row write and delete below ends here, so a browser reading
 * `/api/trades` learns its copy is stale — it has no poll behind it while the
 * stream is up. The replay cache is the one write that does not: it is
 * derived, not the row.
 */
function announceTradeWrite(): void {
  try {
    tradeWriteListener?.();
  } catch {
    // The row is written; a relay failure must not turn the write into a
    // throw at a caller that would then retry or abandon a committed change.
  }
}

export function insertPendingEntry(input: InsertEntryInput): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO strategy_trades (
      deployment_id, strategy_key, account_id, ticker, contract_id,
      side, size, entry_order_id, entry_submitted_at, signal_bar_ts,
      regime_label, regime_classifier_version, session_key,
      tick_size, tick_value, status,
      desired_entry_price, desired_tp_price, desired_sl_price,
      desired_tp_ticks, desired_sl_ticks,
      param_snapshot, filter_snapshot,
      engine_session_id, deployment_version_id
    ) VALUES (
      @deploymentId, @strategyKey, @accountId, @ticker, @contractId,
      @side, @size, @entryOrderId, @entrySubmittedAt, @signalBarTs,
      @regimeLabel, @regimeClassifierVersion, @sessionKey,
      @tickSize, @tickValue, 'pending_entry',
      @desiredEntryPrice, @desiredTpPrice, @desiredSlPrice,
      @desiredTpTicks, @desiredSlTicks,
      @paramSnapshot, @filterSnapshot,
      @engineSessionId, @deploymentVersionId
    )
  `);
  const result = stmt.run({
    ...input,
    entryOrderId: input.entryOrderId ?? null,
    signalBarTs: input.signalBarTs ?? null,
    regimeLabel: input.regimeLabel ?? null,
    regimeClassifierVersion: input.regimeClassifierVersion ?? null,
    sessionKey: input.sessionKey ?? null,
    tickSize: input.tickSize ?? null,
    tickValue: input.tickValue ?? null,
    desiredEntryPrice: input.desiredEntryPrice ?? null,
    desiredTpPrice: input.desiredTpPrice ?? null,
    desiredSlPrice: input.desiredSlPrice ?? null,
    desiredTpTicks: input.desiredTpTicks ?? null,
    desiredSlTicks: input.desiredSlTicks ?? null,
    paramSnapshot: input.paramSnapshot ? JSON.stringify(input.paramSnapshot) : null,
    filterSnapshot: input.filterSnapshot ? JSON.stringify(input.filterSnapshot) : null,
    engineSessionId: input.engineSessionId ?? null,
    deploymentVersionId: input.deploymentVersionId ?? null,
  });
  announceTradeWrite();
  return Number(result.lastInsertRowid);
}

/** Persist a computed BacktestReplayResult on the trade row. Closed
 *  trades are immutable so the cache key is the trade id alone — once
 *  written, the same blob serves every subsequent /replay request. */
export function setReplayResult(tradeId: number, resultJson: string): void {
  getDb()
    .prepare(`UPDATE strategy_trades SET replay_result_json = ? WHERE id = ?`)
    .run(resultJson, tradeId);
}

/** Read back the cached replay blob, or null if not yet computed. */
export function getReplayResult(tradeId: number): string | null {
  const row = getDb()
    .prepare(`SELECT replay_result_json FROM strategy_trades WHERE id = ?`)
    .get(tradeId) as { replay_result_json: string | null } | undefined;
  return row?.replay_result_json ?? null;
}

export function markEntryFilled(
  tradeId: number,
  entryPrice: number,
  entryFilledAt: string | null,
): void {
  const d = getDb();
  // Compute entry slippage in-transaction off the stored desired price,
  // tick size, tick value, side, and size so every closed trade ends up
  // with consistent numbers regardless of which path set the fill price.
  // Signed so positive = worse than backtest; negative = price improvement.
  d.prepare(`
      UPDATE strategy_trades
      SET entry_price = ?,
          entry_filled_at = ?,
          status = 'open',
          entry_slippage_ticks = CASE
            WHEN desired_entry_price IS NULL OR tick_size IS NULL OR tick_size = 0
              THEN NULL
            ELSE ((? - desired_entry_price) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size
          END,
          entry_slippage_dollars = CASE
            WHEN desired_entry_price IS NULL OR tick_size IS NULL OR tick_size = 0
              OR tick_value IS NULL
              THEN NULL
            ELSE (((? - desired_entry_price) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size) * tick_value * size
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(entryPrice, entryFilledAt, entryPrice, entryPrice, tradeId);
  announceTradeWrite();
}

/**
 * Stamp the broker-returned entry order id onto a row that was inserted
 * with `entry_order_id = NULL` (the pre-placeOrder insert path that
 * eliminates the user-hub position-event race — engine.ts:placeEntryOrder).
 * Idempotent overwrite; called once immediately after `placeOrder` resolves.
 */
export function setEntryOrderId(tradeId: number, entryOrderId: number): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET entry_order_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(entryOrderId, tradeId);
  announceTradeWrite();
}

export function setBracketOrderIds(
  tradeId: number,
  tpOrderId: number | null,
  slOrderId: number | null,
): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET tp_order_id = ?, sl_order_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(tpOrderId, slOrderId, tradeId);
  announceTradeWrite();
}

/**
 * Correct `desired_tp_price` / `desired_sl_price` to where the bracket
 * legs are actually resting once the entry has filled and the legs have
 * been observed at the broker.
 *
 * Both brokers are trigger-anchored, so on the ordinary path these are
 * already the values `insertPendingEntry` wrote and the update is a
 * same-value write. It exists for the path where they are not: a Topstep
 * re-anchor that the broker refused leaves the legs on the fill, and a row
 * claiming the trigger would be the display defect in bugs.md A69 all over
 * again. **Intent is not lost by writing the truth here** — it is
 * `desired_entry_price ± desired_*_ticks * tick_size`, three columns that
 * are never rewritten.
 *
 * Entry only. A break-even or trail ratchet is stamped by its own flags and
 * must not move these, which is what keeps `sl_slippage_ticks` and the chart
 * marker measuring against the bracket as placed.
 */
export function setRestingBracketPrices(
  tradeId: number,
  tpPrice: number | null,
  slPrice: number | null,
): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET desired_tp_price = COALESCE(?, desired_tp_price),
          desired_sl_price = COALESCE(?, desired_sl_price),
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(tpPrice, slPrice, tradeId);
  announceTradeWrite();
}

/**
 * Stamp the break-even move, and the stop price it set at the broker. The
 * price goes in its own column rather than over `desired_sl_price`, which
 * keeps the bracket as placed (see `setRestingBracketPrices`). A call
 * without a price keeps whatever an earlier call stored.
 */
export function markBreakEvenMoved(tradeId: number, slPrice: number | null = null): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET break_even_moved = 1, sl_moved_to_be_flag = 1,
          break_even_sl_price = COALESCE(?, break_even_sl_price),
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(slPrice, tradeId);
  announceTradeWrite();
}

/** Stamp the trade row when a future trail-ratchet path modifies the SL
 *  bracket past breakeven. No engine site sets this today (current trail
 *  logic issues a market exit instead of moving the SL bracket). Wired
 *  for forward-compatibility; formatExitReason promotes the SL fill to
 *  "Trail Stop" when set. */
export function markSlTrailEngaged(tradeId: number): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET sl_trail_engaged = 1, updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(tradeId);
  announceTradeWrite();
}

export function markEntryFailed(tradeId: number, reason: string): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET status = 'entry_failed', exit_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(reason, tradeId);
  announceTradeWrite();
}

export interface AttachExitInput {
  tradeId: number;
  exitOrderId: number;
  exitSubmittedAt: string;
  /** The submitting actor's reason **code** (`deployment_close`,
   *  `strategy_signal:EMA close-through`). Stored as the code and rendered
   *  to the label column here, so a row that never reaches the reconciler
   *  still shows trader prose rather than a snake_case identifier. */
  exitReason?: string;
}

/** Write the exit reason on a trade row — the code and its rendering, in
 *  one statement so the two columns cannot come apart. Used at close time
 *  to persist the same reason the Discord embed renders, so the trades
 *  table can show a matching chip. Idempotent — overwrites whatever
 *  attachPendingExit wrote earlier (the post-close reason is the
 *  authoritative one because it folds in bracket-fill attribution that
 *  attachPendingExit can't see). */
export function setExitReason(tradeId: number, reason: ResolvedExitReason): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET exit_reason = ?, exit_reason_code = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(reason.label, reason.code, tradeId);
  announceTradeWrite();
}

/** Stamp exit_order_id on a closed trade without changing status.
 *  Used when a WS fill arrives post-close and gives us the orderId
 *  that the `/fill/deps` resolver needs for historical fill lookup. */
export function backfillExitOrderId(tradeId: number, exitOrderId: number): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET exit_order_id = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'closed' AND exit_order_id IS NULL
    `)
    .run(exitOrderId, tradeId);
  announceTradeWrite();
}

export function attachPendingExit(input: AttachExitInput): void {
  const resolved = input.exitReason == null ? null : resolveExitReasonCode(input.exitReason);
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET exit_order_id = ?, exit_submitted_at = ?, exit_reason = ?, exit_reason_code = ?,
          status = 'pending_exit', updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(
      input.exitOrderId,
      input.exitSubmittedAt,
      resolved?.label ?? null,
      input.exitReason ?? null,
      input.tradeId,
    );
  announceTradeWrite();
}

export interface CloseTradeInput {
  tradeId: number;
  exitPrice: number;
  /** Null when the engine couldn't resolve a real fill time from
   *  Trade/search at close time. The reconciler heal pass backfills it on
   *  a later tick once Topstep indexes the fills. */
  exitFilledAt: string | null;
  pnlTicks: number;
  /** Net of fees. Engine subtracts fees in resolveExitFromFills before passing here. */
  pnlDollars: number;
  /** Exchange fees, dollars (positive). Stored alongside pnlDollars so the
   * UI can show a fees breakdown without recomputing gross. */
  feesDollars?: number;
  /** Which bracket filled, if known. "tp"/"sl" populates the matching
   * slippage columns; "other" (manual close, session force-exit, engine
   * shouldExit) leaves them null since there's no meaningful "desired"
   * for a discretionary exit. */
  exitKind?: "tp" | "sl" | "other";
  /** True if exit_price/pnl came from the bar-close approximation fallback
   * (Trade/search hadn't indexed yet). Heal pass picks these up later. */
  exitApproximated?: boolean;
  /** Which reconciliation layer produced this exit
   *  (docs/proposals/userhub-trade-subscription.md). Defaults to 'rest'
   *  for back-compat — Layer 2 was historically the only path that called
   *  closeTrade with real fill data. The buffer-drain Layer 1 caller
   *  passes 'buffer' explicitly; the bar-close fallback passes
   *  'approximated' alongside `exitApproximated: true`. */
  exitResolutionSource?: "buffer" | "rest" | "approximated";
}

export function closeTrade(input: CloseTradeInput): void {
  const d = getDb();
  const fees = input.feesDollars ?? null;
  const approximated = input.exitApproximated ? 1 : 0;
  // Default to 'rest' so legacy callers retain identical behavior. The
  // 'approximated' / 'buffer' values must be passed explicitly.
  const resolutionSource = input.exitResolutionSource
    ?? (input.exitApproximated ? "approximated" : "rest");
  // Slippage signed: positive = worse than desired. For the TP leg that
  // means filled at a price less favorable than the target; for the SL
  // leg that means gapped through the stop. Computation is side-aware.
  const column = input.exitKind === "tp" ? "tp" : input.exitKind === "sl" ? "sl" : null;
  if (column) {
    d.prepare(`
      UPDATE strategy_trades
      SET exit_price = ?, exit_filled_at = ?, pnl_ticks = ?, pnl_dollars = ?,
          fees_dollars = ?,
          exit_approximated = ?,
          exit_resolution_source = ?,
          status = 'closed',
          ${column}_slippage_ticks = CASE
            WHEN desired_${column}_price IS NULL OR tick_size IS NULL OR tick_size = 0
              THEN NULL
            ELSE ((desired_${column}_price - ?) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size
          END,
          ${column}_slippage_dollars = CASE
            WHEN desired_${column}_price IS NULL OR tick_size IS NULL OR tick_size = 0
              OR tick_value IS NULL
              THEN NULL
            ELSE (((desired_${column}_price - ?) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size) * tick_value * size
          END,
          -- Write-once: a heal or a re-close must not move the session this
          -- trade belongs to.
          exit_detected_at = COALESCE(exit_detected_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.exitPrice, input.exitFilledAt, input.pnlTicks, input.pnlDollars, fees,
      approximated, resolutionSource,
      input.exitPrice, input.exitPrice, input.tradeId,
    );
  } else {
    d.prepare(`
      UPDATE strategy_trades
      SET exit_price = ?, exit_filled_at = ?, pnl_ticks = ?, pnl_dollars = ?,
          fees_dollars = ?,
          exit_approximated = ?,
          exit_resolution_source = ?,
          status = 'closed',
          -- Write-once; see the tp/sl arm above.
          exit_detected_at = COALESCE(exit_detected_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.exitPrice, input.exitFilledAt, input.pnlTicks, input.pnlDollars, fees,
      approximated, resolutionSource, input.tradeId,
    );
  }
  announceTradeWrite();
}

/**
 * Heal an approximated close: re-write exit price + PnL from the resolver
 * once Trade/search finally indexes the real fills, and clear the
 * exit_approximated flag. Slippage columns get repopulated when the
 * resolver could attribute the fill to a specific bracket order.
 *
 * Distinct from `closeTrade` because the row is already closed — we don't
 * want to thrash the status, only correct the PnL surface.
 */
export interface HealApproximatedExitInput {
  tradeId: number;
  exitPrice: number;
  exitFilledAt: string;
  pnlTicks: number;
  pnlDollars: number;
  feesDollars: number;
  exitKind: "tp" | "sl" | "other";
  /** Optional entry-price correction. The original heal pass never touches
   *  entry_price (the broker positions feed already stamped it), but the
   *  post-close price-validation pass uses this same write path to correct
   *  drift on the entry leg too. Pass undefined to leave entry_price alone. */
  entryPrice?: number;
}

/**
 * Dual-purpose write path:
 *
 *   1) Heal an approximated close — original use case. Re-resolves PnL/exit
 *      from Trade/search once Topstep finally indexes the fills.
 *
 *   2) Correct a closed row whose stored prices/PnL drifted from what
 *      Trade/search actually reports (post-close validation pass). Same
 *      columns need overwriting; the only difference is the `entryPrice`
 *      argument lets the validator fix entry-leg drift too.
 *
 * Either way: clears `exit_approximated`, repopulates slippage when the
 * exit can be attributed to a TP/SL leg, and bumps updated_at.
 */
export function healApproximatedExit(input: HealApproximatedExitInput): void {
  const d = getDb();
  const column = input.exitKind === "tp" ? "tp" : input.exitKind === "sl" ? "sl" : null;
  const updateEntry = input.entryPrice != null;
  const entrySetSql = updateEntry ? "entry_price = ?, " : "";
  if (column) {
    const sql = `
      UPDATE strategy_trades
      SET ${entrySetSql}exit_price = ?, exit_filled_at = ?, pnl_ticks = ?, pnl_dollars = ?,
          fees_dollars = ?,
          exit_approximated = 0,
          exit_resolution_source = 'rest',
          replay_result_json = NULL,
          ${column}_slippage_ticks = CASE
            WHEN desired_${column}_price IS NULL OR tick_size IS NULL OR tick_size = 0
              THEN NULL
            ELSE ((desired_${column}_price - ?) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size
          END,
          ${column}_slippage_dollars = CASE
            WHEN desired_${column}_price IS NULL OR tick_size IS NULL OR tick_size = 0
              OR tick_value IS NULL
              THEN NULL
            ELSE (((desired_${column}_price - ?) * (CASE WHEN side = 0 THEN 1 ELSE -1 END))
                 / tick_size) * tick_value * size
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `;
    const args: (number | string)[] = [];
    if (updateEntry) args.push(input.entryPrice as number);
    args.push(
      input.exitPrice, input.exitFilledAt, input.pnlTicks, input.pnlDollars,
      input.feesDollars,
      input.exitPrice, input.exitPrice, input.tradeId,
    );
    d.prepare(sql).run(...args);
  } else {
    const sql = `
      UPDATE strategy_trades
      SET ${entrySetSql}exit_price = ?, exit_filled_at = ?, pnl_ticks = ?, pnl_dollars = ?,
          fees_dollars = ?,
          exit_approximated = 0,
          exit_resolution_source = 'rest',
          replay_result_json = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `;
    const args: (number | string)[] = [];
    if (updateEntry) args.push(input.entryPrice as number);
    args.push(
      input.exitPrice, input.exitFilledAt, input.pnlTicks, input.pnlDollars,
      input.feesDollars, input.tradeId,
    );
    d.prepare(sql).run(...args);
  }
  announceTradeWrite();
  // Replay cache must be cleared (set to NULL above) because heal
  // mutates exit_price / exit_filled_at / pnl_* and optionally
  // entry_price post-close — a previously cached replay would have
  // been computed against the stale prices and would re-stamp those
  // numbers on the next read otherwise.
}

/** Trades closed within the last `sinceMs` window for this account. Used
 *  by the post-close price-validation sweep so Topstep's late-indexing
 *  Trade/search results catch any silent drift that slipped past the
 *  immediate-validation calls in handleUserPositionClose / reconcileOneTrade.
 *  Window is small (~10 min) — older rows are out of scope. */
export function getRecentlyClosedTrades(
  accountId: number,
  sinceMs: number,
): StrategyTrade[] {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ?
        AND status = 'closed'
        AND exit_filled_at IS NOT NULL
        AND exit_filled_at >= ?
      ORDER BY id
    `)
    .all(accountId, cutoff) as TradeRow[];
  return rows.map(rowToTrade);
}

/** Closed trades for this account whose exit_price/pnl came from the
 *  approximation fallback. Heal pass re-runs the resolver against these
 *  on every reconciler tick until the flag clears. Bounded to the same
 *  7-day window as the timestamp heal so we don't keep paging fills for
 *  ancient rows Topstep has already aged out. */
export function getApproximatedClosedTrades(accountId: number): StrategyTrade[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ?
        AND status = 'closed'
        AND exit_approximated = 1
        AND entry_submitted_at >= ?
      ORDER BY id
    `)
    .all(accountId, cutoff) as TradeRow[];
  return rows.map(rowToTrade);
}

/** Closed trades stuck on the residual `bracket_manual` reason. Run hourly
 *  by the relabel sweep — close-time bracket attribution can land here when
 *  Trade/search hasn't indexed the bracket fill AND the OCO survivor was
 *  already cancelled by the broker. The sweep retries the resolver +
 *  price-distance heuristic later when fills should be indexed and writes
 *  the correct chip.
 *  Includes both exit_approximated=1 and exit_approximated=0 rows
 *  because the residual reason can survive a successful PnL heal (the
 *  approximated heal previously didn't rewrite exit_reason). 7-day
 *  window mirrors getApproximatedClosedTrades.
 *
 *  **Matches the code, not the label.** The predicate used to be
 *  `exit_reason = 'Bracket/Manual'` against a value produced by a
 *  `default:` arm two modules away, so a wording change stopped the sweep
 *  finding rows with nothing failing. */
export function getBracketManualClosedTrades(accountId: number): StrategyTrade[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ?
        AND status = 'closed'
        AND exit_reason_code = ?
        AND entry_submitted_at >= ?
      ORDER BY id
    `)
    .all(accountId, EXIT_REASON_BRACKET_MANUAL, cutoff) as TradeRow[];
  return rows.map(rowToTrade);
}

/** Trades whose entry_filled_at or exit_filled_at is still null even
 *  though the corresponding state has advanced — i.e. open/closed trades
 *  that got stamped before Topstep's Trade/search had indexed the fill.
 *  The reconciler retries Trade/search for these so charts eventually
 *  align to the real fill bar instead of the wallclock detection time.
 *
 *  Scoped per-account so the reconciler only fetches fills for accounts
 *  it's already querying that tick.
 *
 *  Bounds entry_submitted_at to the last 7 days so we don't keep paging
 *  fills for ancient trades that Topstep has already aged out. */
export function getTradesNeedingTimestampHeal(accountId: number): StrategyTrade[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ?
        AND entry_submitted_at >= ?
        AND (
          (status = 'open' AND entry_filled_at IS NULL)
          OR (status = 'closed' AND (entry_filled_at IS NULL OR exit_filled_at IS NULL))
        )
      ORDER BY id
    `)
    .all(accountId, cutoff) as TradeRow[];
  return rows.map(rowToTrade);
}

/** Backfill entry_filled_at after the heal pass resolved the real fill
 *  timestamp from Trade/search. Doesn't touch entry_price (already
 *  stamped) or status (trade is already open/closed). */
export function backfillEntryFilledAt(tradeId: number, entryFilledAt: string): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET entry_filled_at = ?, updated_at = datetime('now')
      WHERE id = ? AND entry_filled_at IS NULL
    `)
    .run(entryFilledAt, tradeId);
  announceTradeWrite();
}

/** Backfill exit_filled_at the same way. */
export function backfillExitFilledAt(tradeId: number, exitFilledAt: string): void {
  getDb()
    .prepare(`
      UPDATE strategy_trades
      SET exit_filled_at = ?, updated_at = datetime('now')
      WHERE id = ? AND exit_filled_at IS NULL
    `)
    .run(exitFilledAt, tradeId);
  announceTradeWrite();
}

/** Distinct accounts that still have at least one closed trade stuck on
 *  the residual `bracket_manual` reason. Unioned into the reconciler's
 *  account loop so the hourly relabel sweep fires for accounts whose only
 *  open trade closed onto a wrong label (otherwise the account drops out
 *  of the loop the next tick and the relabel never runs). 7-day window and
 *  code-not-label predicate both mirror getBracketManualClosedTrades. */
export function listAccountsWithBracketManualClosedTrades(): number[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT account_id FROM strategy_trades
      WHERE status = 'closed'
        AND exit_reason_code = ?
        AND entry_submitted_at >= ?
    `)
    .all(EXIT_REASON_BRACKET_MANUAL, cutoff) as { account_id: number }[];
  return rows.map((r) => r.account_id);
}

/** Distinct account IDs that have at least one trade still marked
 * exit_approximated=1. Used for the startup heal pass. Same 7-day
 * cutoff as getApproximatedClosedTrades for consistency. */
export function listAllAccountsWithApproximatedTrades(): number[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT account_id FROM strategy_trades
      WHERE status = 'closed'
        AND exit_approximated = 1
        AND entry_submitted_at >= ?
    `)
    .all(cutoff) as { account_id: number }[];
  return rows.map((r) => r.account_id);
}

/** Distinct accounts with at least one heal-needing trade in the 7-day
 *  window. Unioned with listAccountsWithReconcilableTrades by the engine
 *  so the heal pass still runs for accounts whose only open trade has
 *  already closed. Includes closed-with-approximated-PnL rows so they
 *  self-correct once Trade/search indexes the real fill. */
export function listAccountsNeedingTimestampHeal(): number[] {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT account_id FROM strategy_trades
      WHERE entry_submitted_at >= ?
        AND (
          (status = 'open' AND entry_filled_at IS NULL)
          OR (status = 'closed' AND (entry_filled_at IS NULL OR exit_filled_at IS NULL))
          OR (status = 'closed' AND exit_approximated = 1)
        )
    `)
    .all(cutoff) as { account_id: number }[];
  return rows.map((r) => r.account_id);
}

/** Distinct account ids that still have at least one reconcilable trade
 * (pending_entry, open, or pending_exit). Used by the engine to keep
 * reconciling accounts whose only deployment got paused or deleted while
 * a trade was still in flight — without this, the row would sit stale
 * showing "open" forever even though Topstep already filled the bracket. */
export function listAccountsWithReconcilableTrades(): number[] {
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT account_id FROM strategy_trades
      WHERE status IN ('pending_entry', 'open', 'pending_exit')
    `)
    .all() as { account_id: number }[];
  return rows.map((r) => r.account_id);
}

/** Trades that still need reconciliation via polling. Includes `open` trades
 * so we can detect exogenous exits (bracket hit, manual close) where the
 * engine never submits a separate exit order. */
export function getReconcilableTrades(accountId?: number): StrategyTrade[] {
  const d = getDb();
  const sql = accountId == null
    ? `SELECT * FROM strategy_trades WHERE status IN ('pending_entry', 'open', 'pending_exit') ORDER BY id`
    : `SELECT * FROM strategy_trades WHERE account_id = ? AND status IN ('pending_entry', 'open', 'pending_exit') ORDER BY id`;
  const rows = (accountId == null ? d.prepare(sql).all() : d.prepare(sql).all(accountId)) as TradeRow[];
  return rows.map(rowToTrade);
}

/**
 * Most recent `entry_submitted_at` for a deployment where the entry actually
 * reached the broker (anything except `entry_failed`). Used to restore the
 * cooldown gate after a process restart — without this, restart lets the
 * strategy re-enter immediately even if we just submitted an entry moments
 * before crashing.
 *
 * Rejected entries (`entry_failed`) are excluded on purpose: the cooldown is
 * meant to space out *successful* fires, not rate-limit after a gateway
 * rejection. Letting a failed entry gate the next signal would silently
 * suppress the strategy for `cooldownSeconds` when the real fix is usually
 * already logged (bad bracket sign, oversized tag, etc.).
 */
export function getLastEntrySubmittedAt(deploymentId: string): string | null {
  const row = getDb()
    .prepare(`
      SELECT MAX(entry_submitted_at) AS ts
      FROM strategy_trades
      WHERE deployment_id = ? AND status != 'entry_failed'
    `)
    .get(deploymentId) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

/**
 * Gross realized P&L (no fees) for an **account** over a session window.
 * Sums `COALESCE(pnl_dollars, 0) + COALESCE(fees_dollars, 0)` for closed
 * trades whose `COALESCE(exit_filled_at, exit_detected_at) >= sessionStart`,
 * both sides normalised through `datetime()` — see below. `pnl_dollars` on rows
 * written after 2026-04-26 is net; older rows are gross with fees=null.
 * The COALESCE-then-add path produces gross in both cases.
 *
 * Both inputs to the addition are coalesced — without that, a transient
 * `status='closed'` row whose `pnl_dollars IS NULL` (the brief window
 * between exit-fill stamping and the heal pass; see classifier near
 * line 781) returns NULL for that addend and the row is silently dropped
 * from the SUM. During that window the gate would undercount a real
 * loss/profit and a fresh entry could sneak through above threshold.
 * Defense-in-depth: once heal completes, the value matches what it was
 * before; during the unhealed window, the row contributes 0 instead of
 * being silently excluded.
 *
 * **The window coalesces `exit_filled_at` to `exit_detected_at`, and both
 * sides go through `datetime()`.** Two separate defects live here, and the
 * first is the same failure the paragraph above guards against, one column
 * over: Layer 3 of the exit cascade — the bar-close approximation at
 * `engine-reconcile.ts` — writes a real `pnl_dollars` with a **null**
 * `exit_filled_at`, by design, and the heal pass fills the timestamp in later.
 * An `exit_filled_at IS NOT NULL` clause therefore made every approximated
 * loss invisible to this gate for as long as it stayed unhealed, and an
 * account that had already blown its daily limit kept taking entries.
 *
 * **`updated_at` cannot serve as the fallback, and `>=` on raw strings cannot
 * serve as the comparison.** `updated_at` means "any write": three healers
 * (`backfillEntryFilledAt`, `backfillExitOrderId`, `setExitReason`) bump it on
 * a closed, still-unhealed row over a 7-day window, so a week-old loss could
 * be restamped into today and trip today's limit — halting an account that
 * should be trading, which is the same gate failing in the opposite
 * direction. Hence `exit_detected_at`, which has one writer and is
 * COALESCE-guarded against a second write. And `datetime('now')` yields
 * `YYYY-MM-DD HH:MM:SS` while `sessionStart` is ISO-8601: compared as raw
 * text, `' '` (0x20) sorts before `'T'` (0x54), so **every row sharing the
 * session's UTC date was dropped** — which is every close in the Globex open,
 * for the whole session, since `sessionStart` does not roll at midnight UTC.
 * `datetime()` on both sides normalises them; it parses the `T` and the
 * trailing `Z`.
 *
 * Used by the daily-PnL entry gate. Persistence is implicit:
 * `strategy_trades` survives engine restarts, so the per-(accountId,
 * sessionDayKey) counter is just this query.
 *
 * **The scope is the account, not the deployment, since phase 1 of the
 * playbooks proposal**, because Topstep's daily loss is an account rule and two
 * playbooks on one account share the drawdown it is measured against. The
 * filter is `account_id`, so every closed row on the account counts whatever
 * deployment opened it — which is the whole point, and is also why a future row
 * with no `deployment_id` (`bucketCaseSql`'s `manual` arm, unreachable while
 * the column is `NOT NULL`) would be counted rather than skipped.
 */
export function getAccountRealizedSinceGross(
  accountId: number,
  sessionStart: string,
): number {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(SUM(COALESCE(pnl_dollars, 0) + COALESCE(fees_dollars, 0)), 0) AS gross
      FROM strategy_trades
      WHERE account_id = ?
        AND status = 'closed'
        AND datetime(COALESCE(exit_filled_at, exit_detected_at)) >= datetime(?)
    `)
    .get(accountId, sessionStart) as { gross: number } | undefined;
  return row?.gross ?? 0;
}

/**
 * Most recent `exit_filled_at` for a deployment. Used to seed the
 * exit-anchored cooldown after a process restart, so a deployment can't
 * re-enter immediately after a just-completed exit.
 */
export function getLastExitAt(deploymentId: string): string | null {
  const row = getDb()
    .prepare(`
      SELECT MAX(exit_filled_at) AS ts
      FROM strategy_trades
      WHERE deployment_id = ? AND status = 'closed'
    `)
    .get(deploymentId) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

/**
 * Most recent in-flight trade (pending_entry / open / pending_exit) for
 * an (account, contract) pair. Used by the user-hub position-event
 * handler to map a `GatewayUserPosition` event back to the row it
 * belongs to without requiring a deployment id (the broadcaster's
 * payload doesn't carry one). Returns null if no in-flight trade
 * exists — caller treats that as "not ours, ignore".
 *
 * Also used by the realtime exit re-reconcile path: when a position
 * closes for a row already marked `closed`, we still need the row to
 * decide whether re-resolution is worthwhile (status=closed branch in
 * the caller).
 */
export function findTradeByAccountContract(
  accountId: number,
  contractId: string,
): StrategyTrade | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ? AND contract_id = ?
        AND status IN ('pending_entry', 'open', 'pending_exit')
      ORDER BY id DESC LIMIT 1
    `)
    .get(accountId, contractId) as TradeRow | undefined;
  return row ? rowToTrade(row) : null;
}

/**
 * Most recent closed trade for an (account, contract) pair where the
 * exit data came from the approximation fallback or the timestamp
 * never got healed. Used by the realtime exit re-reconcile path so
 * Bug B's stuck-PnL row self-corrects the moment the user-hub fires
 * a position-close event (no need to wait for the next heal-pass tick).
 * Bounded to 24h so we never re-resolve ancient history.
 */
export function findRecentApproximatedTradeByAccountContract(
  accountId: number,
  contractId: string,
): StrategyTrade | null {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE account_id = ? AND contract_id = ?
        AND status = 'closed'
        AND (exit_approximated = 1 OR exit_filled_at IS NULL)
        AND entry_submitted_at >= ?
      ORDER BY id DESC LIMIT 1
    `)
    .get(accountId, contractId, cutoff) as TradeRow | undefined;
  return row ? rowToTrade(row) : null;
}

/**
 * The deployment's **latest live** trade row — not its open one. `pending_entry`
 * and `pending_exit` both count, which is the whole point at the route-level
 * `Paused`-vs-`Pausing` gates: a row is live from submission until `closeTrade`
 * runs, and `DeploymentState.position` is null for part of that span.
 *
 * `ORDER BY id DESC LIMIT 1` makes it *latest*, so it cannot answer "does an
 * `open` row exist" in general. Callers that need that — `placeExitOrderInner`'s
 * `EXIT_FLAT_MISMATCH` discriminator — narrow on `.status === "open"` and rely
 * on `contractLocks` to keep a deployment from holding two live rows at once.
 * See engine.md if that invariant changes.
 */
export function getOpenTradeForDeployment(deploymentId: string): StrategyTrade | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE deployment_id = ? AND status IN ('pending_entry', 'open', 'pending_exit')
      ORDER BY id DESC LIMIT 1
    `)
    .get(deploymentId) as TradeRow | undefined;
  return row ? rowToTrade(row) : null;
}

/** Every trade currently in the `open` status, across all deployments and
 *  accounts. Used at engine boot to rehydrate `state.position` for positions
 *  that were already on the books before the restart, so the realtime exit
 *  path (session force-exit, BE, strategy realtime exits) doesn't sit blind
 *  until the next bar-close evaluation rebuilds them. */
export function getAllOpenTrades(): StrategyTrade[] {
  const rows = getDb()
    .prepare(`SELECT * FROM strategy_trades WHERE status = 'open' ORDER BY id`)
    .all() as TradeRow[];
  return rows.map(rowToTrade);
}

/** One filled entry's claim on the engine's one-per-side latch. */
export interface SessionLatchedEntry {
  deploymentId: string;
  sessionKey: string;
  side: 0 | 1;
}

/**
 * Filled entries carrying a session key, for these deployments, submitted at
 * or after `sinceIso`, oldest first — what the engine rebuilds its
 * one-per-side latch from after a restart (bugs.md A92).
 *
 * **Filled means every status `markEntryFilled` moves a row into or past**,
 * because the live latch is set on exactly that call. `pending_entry` has not
 * filled and `entry_failed` never will, so neither latches — a rejected or
 * cancelled order must not cap the side. `entry_filled_at` is not the test:
 * the reconciler can promote a row to `open` before Trade/search has the fill
 * time, and that row latched live.
 */
export function listSessionLatchedEntries(
  deploymentIds: readonly string[],
  sinceIso: string,
): SessionLatchedEntry[] {
  const rows = getDb()
    .prepare(`
      SELECT deployment_id, session_key, side FROM strategy_trades
      WHERE ${inClause("deployment_id", deploymentIds)}
        AND session_key IS NOT NULL
        AND status IN ('open', 'pending_exit', 'closed')
        AND datetime(entry_submitted_at) >= datetime(?)
      ORDER BY id
    `)
    .all(...deploymentIds, sinceIso) as Array<{ deployment_id: string; session_key: string; side: number }>;
  return rows.map((r) => ({ deploymentId: r.deployment_id, sessionKey: r.session_key, side: r.side as 0 | 1 }));
}

export interface ListTradesOptions {
  accountId?: number;
  deploymentId?: string;
  /**
   * Several deployments at once — the drill-in's all-accounts view, where one
   * deployment's legs are N `deployments` rows.
   *
   * **It is a filter, not a union of single-deployment queries.** The `LIMIT`
   * then applies to the merged, id-ordered set, so the page's list and its
   * summary describe the same rows; N separate reads capped at N × limit
   * would put a client-side merge behind a server aggregate, which is the
   * disagreement `design-language.md` records as a React pitfall.
   *
   * An empty array matches nothing, deliberately: it means *these zero legs*,
   * not *no filter*. Ignoring it would answer with every trade in the
   * install.
   */
  deploymentIds?: readonly string[];
  /** Caps the newest rows (default 200). Open and pending rows the filters
   *  match are returned past it, so a list can run longer than `limit`. */
  limit?: number;
}

/** `IN (?, ?, ?)` for a non-empty list, `IN (NULL)` — which matches nothing —
 *  for an empty one. SQLite has no empty-list literal. */
function inClause(column: string, values: readonly string[]): string {
  if (values.length === 0) return `${column} IN (NULL)`;
  return `${column} IN (${values.map(() => "?").join(", ")})`;
}

/** Save the per-trade bar snapshot. Idempotent — a re-snapshot for the
 *  same trade overwrites bars + clears the retry counter. `matureAt`
 *  serves two roles: queues a future re-snapshot (snapshot_due_at) AND
 *  gates the replay route's snapshot-vs-live-fetch decision
 *  (bars_mature_at). Pass null when the post-exit window is already
 *  fully populated (re-snapshot fired post-maturityMs). */
export function saveTradeBars(
  tradeId: number,
  bars: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>,
  timeframe: string,
  matureAt: string | null = null,
): void {
  const json = JSON.stringify(bars);
  getDb()
    .prepare(`
      INSERT INTO strategy_trade_bars (trade_id, bars_json, timeframe, captured_at, snapshot_due_at, snapshot_retry_count, bars_mature_at)
      VALUES (?, ?, ?, datetime('now'), ?, 0, ?)
      ON CONFLICT(trade_id) DO UPDATE SET
        bars_json = excluded.bars_json,
        timeframe = excluded.timeframe,
        captured_at = excluded.captured_at,
        snapshot_due_at = excluded.snapshot_due_at,
        snapshot_retry_count = 0,
        bars_mature_at = excluded.bars_mature_at
    `)
    .run(tradeId, json, timeframe, matureAt, matureAt);
}

/** Snapshots whose maturity time has passed and which haven't exhausted
 *  their retry budget yet. Engine reconciler tick processes these on a
 *  cap'd concurrency (3 per tick) to avoid hammering /retrieveBars after
 *  a long offline window. */
export function listDueSnapshots(now: string, retryLimit: number, limit: number): Array<{
  tradeId: number;
  retryCount: number;
}> {
  const rows = getDb()
    .prepare(`
      SELECT trade_id, snapshot_retry_count
      FROM strategy_trade_bars
      WHERE snapshot_due_at IS NOT NULL
        AND snapshot_due_at <= ?
        AND snapshot_retry_count < ?
      ORDER BY snapshot_due_at ASC
      LIMIT ?
    `)
    .all(now, retryLimit, limit) as Array<{ trade_id: number; snapshot_retry_count: number }>;
  return rows.map((r) => ({ tradeId: r.trade_id, retryCount: r.snapshot_retry_count }));
}

/** Bump the retry counter after a failed re-snapshot attempt. Doesn't
 *  touch snapshot_due_at; the row stays eligible on the next
 *  listDueSnapshots call until retry_count hits the limit, after which
 *  it falls out of due-lists and the partial snapshot stays as the
 *  final state. */
export function incrementSnapshotRetry(tradeId: number): number {
  const row = getDb()
    .prepare(`
      UPDATE strategy_trade_bars
      SET snapshot_retry_count = snapshot_retry_count + 1
      WHERE trade_id = ?
      RETURNING snapshot_retry_count
    `)
    .get(tradeId) as { snapshot_retry_count: number } | undefined;
  return row?.snapshot_retry_count ?? 0;
}

/** Mark the snapshot as exhausted-no-more-retries by clearing the queue
 *  flag. The partial bars stay queryable; we just stop trying to
 *  upgrade them. */
export function abandonSnapshotQueue(tradeId: number): void {
  getDb()
    .prepare(`UPDATE strategy_trade_bars SET snapshot_due_at = NULL WHERE trade_id = ?`)
    .run(tradeId);
}

/** Batch read of bar snapshots for multiple trades. Returns only rows
 *  that exist + parse cleanly; trades with no snapshot row (or corrupt
 *  JSON) are simply omitted, and the caller treats absence as `bars: null`.
 *  Used by the deployment-trades export to zip bars into the JSON payload
 *  without N round-trips. `barsMatureAt` is null for mature snapshots
 *  (post-maturityMs re-snapshot, or pre-column rows); the export helper
 *  compares it against now() to flag truncated post-exit windows. */
export function getTradeBarsBatch(tradeIds: number[]): Array<{
  tradeId: number;
  bars: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  timeframe: string;
  barsMatureAt: string | null;
}> {
  if (tradeIds.length === 0) return [];
  const placeholders = tradeIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`
      SELECT trade_id, bars_json, timeframe, bars_mature_at
      FROM strategy_trade_bars
      WHERE trade_id IN (${placeholders})
    `)
    .all(...tradeIds) as Array<{ trade_id: number; bars_json: string; timeframe: string; bars_mature_at: string | null }>;
  const out: Array<{ tradeId: number; bars: ReturnType<typeof JSON.parse>; timeframe: string; barsMatureAt: string | null }> = [];
  for (const r of rows) {
    try {
      out.push({
        tradeId: r.trade_id,
        bars: JSON.parse(r.bars_json),
        timeframe: r.timeframe,
        barsMatureAt: r.bars_mature_at,
      });
    } catch {
      /* corrupt blob — skip; caller emits bars: null for this trade id */
    }
  }
  return out;
}

/** Fetch the snapshot if one exists. Caller falls back to live Topstep
 *  bars when null (open trades, or trades closed before this feature
 *  shipped). `matureAt` is null for mature snapshots (or pre-column rows);
 *  the replay route gates on it to avoid handing a still-filling window
 *  to runReplay. */
export function getTradeBars(tradeId: number): {
  bars: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  timeframe: string;
  capturedAt: string;
  matureAt: string | null;
} | null {
  const row = getDb()
    .prepare(`SELECT bars_json, timeframe, captured_at, bars_mature_at FROM strategy_trade_bars WHERE trade_id = ?`)
    .get(tradeId) as { bars_json: string; timeframe: string; captured_at: string; bars_mature_at: string | null } | undefined;
  if (!row) return null;
  try {
    return {
      bars: JSON.parse(row.bars_json),
      timeframe: row.timeframe,
      capturedAt: row.captured_at,
      matureAt: row.bars_mature_at,
    };
  } catch {
    // Corrupt JSON — treat as missing so the route falls through to live fetch.
    return null;
  }
}

export function getTradeById(id: number): StrategyTrade | null {
  const row = getDb()
    .prepare(`SELECT * FROM strategy_trades WHERE id = ?`)
    .get(id) as TradeRow | undefined;
  return row ? rowToTrade(row) : null;
}

/**
 * Cached feature-detect for the `tombstoned_at` column on deployments.
 * Older DBs don't have it, so referencing it directly in the
 * bucket-classification SQL would raise "no such column". The detect
 * runs once per process and yields the SQL fragment to use for the
 * column reference (real column or NULL literal).
 */
let tombstonedAtRefCache: string | null = null;
function tombstonedAtRef(): string {
  if (tombstonedAtRefCache != null) return tombstonedAtRefCache;
  const cols = getDb()
    .prepare(`PRAGMA table_info(deployments)`)
    .all() as Array<{ name: string }>;
  const exists = cols.some((c) => c.name === "tombstoned_at");
  tombstonedAtRefCache = exists ? "d.tombstoned_at" : "NULL";
  return tombstonedAtRefCache;
}

/**
 * Bucket-classification expression. Must mirror TradeBucket:
 *   - manual   : trade has no deployment_id (originated outside the engine)
 *   - retired  : deployment row missing (hard-deleted orphan) OR tombstoned
 *   - trashed  : deployment soft-deleted (deleted_at set)
 *   - active   : deployment exists, not deleted, not tombstoned
 *
 * The SQL inlines `tombstonedAtRef()` so pre-Track-4 deployments tables
 * (no column) get a NULL literal where post-Track-4 use d.tombstoned_at.
 * Behavior is identical until the column ships.
 *
 * Relies on `idx_trades_deployment` on strategy_trades(deployment_id) so
 * the LEFT JOIN doesn't degrade to a sequential scan as the trade table
 * grows; that index is created in the migration above.
 */
function bucketCaseSql(): string {
  const tomb = tombstonedAtRef();
  return `
    CASE
      WHEN strategy_trades.deployment_id IS NULL THEN 'manual'
      WHEN d.id IS NULL OR ${tomb} IS NOT NULL THEN 'retired'
      WHEN d.deleted_at IS NOT NULL THEN 'trashed'
      ELSE 'active'
    END
  `;
}

/**
 * A deployment's history is the rows on the account it points at now. A leg
 * re-pointed by `move-account` or an edit keeps its id, so its old account's
 * rows still carry it; they stay on the row (the account's own totals read
 * them by `account_id`) and drop out of the deployment's list and summary.
 * A row whose deployment is gone has no current account and keeps showing.
 * A subquery rather than the join so `getPnLSummary`, which has none, reads
 * the same predicate.
 */
const ON_DEPLOYMENTS_CURRENT_ACCOUNT_SQL = `NOT EXISTS (
  SELECT 1 FROM deployments cur
  WHERE cur.id = strategy_trades.deployment_id
    AND cur.account_id != strategy_trades.account_id
)`;

export function listTrades(opts: ListTradesOptions = {}): StrategyTrade[] {
  const d = getDb();
  // `entry_failed` rows are pre-inserted before placeOrder so the user-hub
  // fill event has a row to attribute to. On rejection the row is marked
  // failed but kept (FK targets, debugging). They have no fill, no exit,
  // no PnL — they must not appear in the trade list. Filtered here at the
  // source so every downstream consumer (deployment-trades, analytics,
  // strategies-pnl) stays consistent.
  const where: string[] = ["strategy_trades.status != 'entry_failed'"];
  const params: (string | number)[] = [];
  if (opts.accountId != null) {
    where.push("strategy_trades.account_id = ?");
    params.push(opts.accountId);
  }
  if (opts.deploymentId) {
    where.push("strategy_trades.deployment_id = ?");
    params.push(opts.deploymentId);
  }
  if (opts.deploymentIds) {
    where.push(inClause("strategy_trades.deployment_id", opts.deploymentIds));
    params.push(...opts.deploymentIds);
  }
  if (opts.deploymentId || opts.deploymentIds) where.push(ON_DEPLOYMENTS_CURRENT_ACCOUNT_SQL);
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const limit = opts.limit ?? 200;
  const select = `
    SELECT strategy_trades.*, ${bucketCaseSql()} AS bucket
    FROM strategy_trades
    LEFT JOIN deployments d ON strategy_trades.deployment_id = d.id
    ${whereSql}
  `;
  const newest = d
    .prepare(`${select} ORDER BY strategy_trades.id DESC LIMIT ?`)
    .all(...params, limit) as Array<TradeRow & { bucket: string }>;
  // Every unsettled row, past the limit too: the Dashboard reads position from
  // these rows alone, so an `open` trade older than the page would leave its
  // row looking at rest — and hideable.
  const onPage = new Set(newest.map((r) => r.id));
  const unsettled = (
    d
      .prepare(`${select} AND strategy_trades.status IN ('pending_entry', 'open', 'pending_exit') ORDER BY strategy_trades.id DESC`)
      .all(...params) as Array<TradeRow & { bucket: string }>
  ).filter((r) => !onPage.has(r.id));
  const rows = unsettled.length === 0 ? newest : [...newest, ...unsettled].sort((a, b) => b.id - a.id);
  return rows.map((r) => {
    const trade = rowToTrade(r);
    trade.bucket = r.bucket as StrategyTrade["bucket"];
    return trade;
  });
}

export interface ListTradesForExportOptions {
  /** Inclusive session-agnostic bounds on `entry_submitted_at`, `YYYY-MM-DD`. */
  from: string;
  to: string;
  ticker?: string;
  strategyKey?: string;
  /** Every status, not only `closed` — `parity-day` reports a failed or
   *  still-open row by its status rather than letting it read as no entry. */
  allStatuses?: boolean;
}

/**
 * Closed trades in a date range, oldest first — the monthly review's pull.
 *
 * **Bounded on `entry_submitted_at`, not on the exit.** The review compares
 * the month's *signals* against the same month's backtest entries, so a
 * trade that opened on the 30th and closed on the 1st belongs to the month
 * it opened in. `date()` on both sides because SQLite writes
 * `YYYY-MM-DD HH:MM:SS` while the engine writes ISO-8601 into this column —
 * a raw string comparison sorts `' '` before `'T'` and silently drops every
 * row sharing a boundary date. **The ordering parses the column for the
 * same reason** — raw text puts every ISO row after every SQLite-shaped one
 * regardless of instant, which is not "oldest first".
 *
 * No `LIMIT`: a month of one instrument is tens of rows, and a truncated
 * export would read as a month with fewer trades than it had.
 */
export function listTradesForExport(opts: ListTradesForExportOptions): StrategyTrade[] {
  const where = ["date(entry_submitted_at) >= date(?)", "date(entry_submitted_at) <= date(?)"];
  if (!opts.allStatuses) where.unshift("status = 'closed'");
  const params: string[] = [opts.from, opts.to];
  if (opts.ticker) {
    where.push("ticker = ?");
    params.push(opts.ticker);
  }
  if (opts.strategyKey) {
    where.push("strategy_key = ?");
    params.push(opts.strategyKey);
  }
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE ${where.join(" AND ")}
      ORDER BY datetime(entry_submitted_at) ASC, id ASC
    `)
    .all(...params) as TradeRow[];
  return rows.map(rowToTrade);
}

/**
 * Rolling slippage stats for a deployment over the last N closed trades.
 * "Worst" uses MAX on signed ticks, so a deployment with consistent price
 * improvement shows worst = negative (good). `totalSlippageDollars` sums
 * entry + tp + sl across the same window — negative means net cost to PnL.
 */
export function getSlippageStats(
  deploymentId: string,
  limit: number = 20,
): import("./trade-types").SlippageStats {
  const d = getDb();
  const rows = d.prepare(`
    SELECT
      entry_slippage_ticks,
      entry_slippage_dollars,
      tp_slippage_dollars,
      sl_slippage_dollars
    FROM strategy_trades
    WHERE deployment_id = ? AND status = 'closed'
    ORDER BY id DESC
    LIMIT ?
  `).all(deploymentId, limit) as Array<{
    entry_slippage_ticks: number | null;
    entry_slippage_dollars: number | null;
    tp_slippage_dollars: number | null;
    sl_slippage_dollars: number | null;
  }>;

  if (rows.length === 0) {
    return { sampleSize: 0, avgEntryTicks: 0, worstEntryTicks: 0, totalSlippageDollars: 0 };
  }

  const entryTicks = rows
    .map((r) => r.entry_slippage_ticks)
    .filter((v): v is number => v != null);
  const avgEntryTicks = entryTicks.length
    ? entryTicks.reduce((a, b) => a + b, 0) / entryTicks.length
    : 0;
  const worstEntryTicks = entryTicks.length ? Math.max(...entryTicks) : 0;

  const totalSlippageDollars = rows.reduce((sum, r) => {
    return sum + (r.entry_slippage_dollars ?? 0)
              + (r.tp_slippage_dollars ?? 0)
              + (r.sl_slippage_dollars ?? 0);
  }, 0);

  return {
    sampleSize: rows.length,
    avgEntryTicks,
    worstEntryTicks,
    totalSlippageDollars,
  };
}

/**
 * Wipe every row in `strategy_trades` (and the cascading bars in
 * `strategy_trade_bars`) and reset the autoincrement sequence so new
 * trades start at id=1. Refuses the wipe if any trade is mid-flight —
 * deleting an in-flight row would orphan the broker-side bracket the
 * reconciler is tracking, leaving phantom positions.
 *
 * Returns `{ deleted }` on success or throws with a stable code if blocked.
 * Dev-only — exposed via /api/dev/clear-trades and gated by DEV_TOOLS_ENABLED.
 */
export function clearAllTrades(): { deleted: number } {
  const d = getDb();
  const inflight = d
    .prepare(`
      SELECT COUNT(*) AS n FROM strategy_trades
      WHERE status IN ('pending_entry', 'open', 'pending_exit')
    `)
    .get() as { n: number };
  if (inflight.n > 0) {
    const err = new Error(
      `Refused: ${inflight.n} trade(s) still in-flight (pending_entry/open/pending_exit). ` +
      `Flatten or wait for them to close before wiping.`,
    );
    (err as Error & { code?: string }).code = "TRADES_IN_FLIGHT";
    throw err;
  }
  const result = d.prepare(`DELETE FROM strategy_trades`).run();
  // Reset AUTOINCREMENT counter so the next trade is id=1 again.
  // sqlite_sequence row only exists if the table has ever inserted rows;
  // ignore-fail in case the migration never created it.
  try { d.prepare(`DELETE FROM sqlite_sequence WHERE name = 'strategy_trades'`).run(); } catch { /* table empty */ }
  announceTradeWrite();
  return { deleted: Number(result.changes) };
}

export interface OrphanedTradeGroup {
  deploymentId: string;
  strategyKey: string | null;
  deploymentName: string | null;
  count: number;
  lastDate: string | null;
}

/** Trades belonging to tombstoned (retired) deployments, grouped by
 *  deployment_id. Also catches true orphans (hard-deleted row) via the
 *  LEFT JOIN + d.id IS NULL branch. */
export function getOrphanedTradeGroups(): OrphanedTradeGroup[] {
  const rows = getDb()
    .prepare(`
      SELECT t.deployment_id,
             d.strategy_key,
             d.name AS deployment_name,
             COUNT(*) AS cnt,
             MAX(t.entry_submitted_at) AS last_date
      FROM strategy_trades t
      LEFT JOIN deployments d ON t.deployment_id = d.id
      WHERE (d.id IS NULL OR d.tombstoned_at IS NOT NULL)
        AND t.deployment_id IS NOT NULL
        AND t.status != 'entry_failed'
      GROUP BY t.deployment_id
      ORDER BY last_date DESC
    `)
    .all() as Array<{ deployment_id: string; strategy_key: string | null; deployment_name: string | null; cnt: number; last_date: string | null }>;
  return rows.map((r) => ({
    deploymentId: r.deployment_id,
    strategyKey: r.strategy_key,
    deploymentName: r.deployment_name,
    count: r.cnt,
    lastDate: r.last_date,
  }));
}

export function listTradesByDeploymentId(deploymentId: string): StrategyTrade[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM strategy_trades
      WHERE deployment_id = ? AND status != 'entry_failed'
      ORDER BY id DESC
    `)
    .all(deploymentId) as TradeRow[];
  return rows.map(rowToTrade);
}

export function deleteTrade(id: number): boolean {
  const db = getDb();
  db.prepare("DELETE FROM strategy_trade_bars WHERE trade_id = ?").run(id);
  const result = db.prepare("DELETE FROM strategy_trades WHERE id = ?").run(id);
  announceTradeWrite();
  return result.changes > 0;
}

export function getPnLSummary(
  filter: { accountId?: number; deploymentId?: string; deploymentIds?: readonly string[] } = {},
): import("./trade-types").PnLSummary {
  const d = getDb();
  const clauses: string[] = ["status != 'entry_failed'"];
  const params: (string | number)[] = [];
  if (filter.accountId != null) {
    clauses.push("account_id = ?");
    params.push(filter.accountId);
  }
  if (filter.deploymentId) {
    clauses.push("deployment_id = ?");
    params.push(filter.deploymentId);
  }
  // Same filter as `listTrades`, so the summary and the list this page shows
  // beside it are aggregates over the same rows. An empty array matches
  // nothing rather than everything — see `ListTradesOptions.deploymentIds`.
  if (filter.deploymentIds) {
    clauses.push(inClause("deployment_id", filter.deploymentIds));
    params.push(...filter.deploymentIds);
  }
  if (filter.deploymentId || filter.deploymentIds) clauses.push(ON_DEPLOYMENTS_CURRENT_ACCOUNT_SQL);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totals = d
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN status IN ('pending_entry', 'open', 'pending_exit') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'closed' AND pnl_dollars > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN status = 'closed' AND pnl_dollars < 0 THEN 1 ELSE 0 END) AS losses,
        COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl_dollars ELSE 0 END), 0) AS pnl,
        COALESCE(SUM(CASE WHEN status = 'closed' THEN fees_dollars ELSE 0 END), 0) AS fees
      FROM strategy_trades ${where}
    `)
    .get(...params) as {
      total: number; closed: number; open: number;
      wins: number; losses: number; pnl: number; fees: number;
    };

  return {
    totalTrades: totals.total ?? 0,
    closedTrades: totals.closed ?? 0,
    openTrades: totals.open ?? 0,
    winCount: totals.wins ?? 0,
    lossCount: totals.losses ?? 0,
    totalPnlDollars: totals.pnl ?? 0,
    totalFeesDollars: totals.fees ?? 0,
  };
}
