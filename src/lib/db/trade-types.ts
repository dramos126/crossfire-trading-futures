// Client-safe types for strategy_trades. Keep this file free of node
// built-ins and native deps (better-sqlite3) so it can be imported by
// both server code and client components.

export type TradeStatus =
  | "pending_entry"
  | "open"
  | "pending_exit"
  | "closed"
  | "entry_failed"
  | "exit_failed";

/**
 * Presentation bucket for the All-Time card subtitle. Computed at query
 * time via LEFT JOIN against the deployments table:
 *   - active   : trade has deployment_id, deployment exists, NOT soft-deleted, NOT tombstoned
 *   - trashed  : deployment soft-deleted (deleted_at set), NOT tombstoned
 *   - retired  : deployment hard-deleted (orphan, no row) OR tombstoned
 *   - manual   : deployment_id IS NULL (trade originated outside the engine)
 *
 * `tombstoned_at` is referenced as if it already exists; pre-Track-4 the
 * column is absent and the SQL feature-detects it with a NULL fallback,
 * so the retired branch only catches orphans until that ships.
 */
export type TradeBucket = "active" | "trashed" | "retired" | "manual";

export interface StrategyTrade {
  id: number;
  deploymentId: string;
  strategyKey: string;
  accountId: number;
  ticker: string;
  contractId: string;
  side: 0 | 1;
  size: number;

  entryOrderId: number | null;
  entryPrice: number | null;
  entryFilledAt: string | null;
  entrySubmittedAt: string;

  /** Timestamp of the bar whose close produced the entry signal. The join
   *  key between a live trade and its backtest counterpart — `entrySubmittedAt`
   *  is a wallclock and cannot serve. Null on rows written before the
   *  column existed. */
  signalBarTs: string | null;

  /** The regime label in force for the signal bar's session day, and the
   *  classifier version that produced it. **A record, never a lookup** — a
   *  label recomputed later is a label under whatever classifier is on disk
   *  then, not the one this trade was taken under. Both null on rows written
   *  before the columns existed and on a session the classifier could not
   *  label; `"unknown"` is a label and is stored as one. */
  regimeLabel: string | null;
  regimeClassifierVersion: string | null;

  /** `EntrySignal.sessionKey`, the one-per-side latch's key. A fill path
   *  latches from it when the in-memory stash is gone — an entry pending
   *  across a restart. Null when the strategy emits no key (it opts out of
   *  the latch) and on rows written before the column. */
  sessionKey: string | null;

  /** Topstep's bracket order ids — captured after entry fills by diffing
   * pre-entry vs post-fill open orders on the account/contract. Null
   * until the post-fill reconcile tick resolves them. */
  tpOrderId: number | null;
  slOrderId: number | null;
  breakEvenMoved: boolean;

  /** Set by the engine the moment BE-move logic shifts the SL bracket to
   *  entry (or +offset). Authoritative source-of-truth for the
   *  "Breakeven Stop" label — does not depend on the slCurrentPrice
   *  mirror being current at fill time. Mirrors break_even_moved (which
   *  also gates "don't fire BE twice") but kept distinct so the two
   *  semantics can diverge if the gating logic ever changes. */
  slMovedToBreakeven: boolean;
  /** The stop price the break-even move set at the broker: entry ± the
   *  filter's offset ticks, not entry. Written beside the flag by
   *  `markBreakEvenMoved`; null when break-even never moved the stop, and
   *  on rows from before the column (bugs-fixed.md A20). Optional only
   *  because two engine test fixtures build a `StrategyTrade` literal;
   *  `rowToTrade` always sets it. */
  breakEvenSlPrice?: number | null;
  /** Set by the engine when a trail-ratchet path moves the SL bracket
   *  past breakeven. No engine site sets this today (current trail logic
   *  issues a market exit), so all values are 0 in practice — wired for a
   *  future bracket-modify-style trail. When set, an SL bracket fill
   *  promotes to "Trail Stop". */
  slTrailEngaged: boolean;

  exitOrderId: number | null;
  exitPrice: number | null;
  exitFilledAt: string | null;
  exitSubmittedAt: string | null;
  /** The rendered label — *"Take Profit"*, *"Strategy Exit · EMA
   *  close-through"*. A rendering of `exitReasonCode`, kept as a column
   *  because it is what the chip's tooltip, the CSV export and every row
   *  written before the code column existed carry. Nothing matches on it. */
  exitReason: string | null;
  /** The owner: a `ExitReasonCode` from `@/lib/logging/exit-reasons`, plus
   *  an optional `:detail` suffix on the two strategy codes that carry
   *  prose. Written by the actor that submits the exit and by the
   *  close-time bracket resolution; this is what SQL matches. Null on rows
   *  the migration's label backfill could not classify. */
  exitReasonCode: string | null;

  pnlTicks: number | null;
  /** Net of fees as of 2026-04-26. Older rows (pre-migration) are gross.
   * Use feesDollars to recover gross if needed: gross = pnlDollars + feesDollars. */
  pnlDollars: number | null;
  /** Exchange fees recorded at exit-fill reconcile time, dollars (positive).
   * Null on rows closed before this column existed. */
  feesDollars: number | null;
  tickSize: number | null;
  tickValue: number | null;

  status: TradeStatus;
  createdAt: string;
  updatedAt: string;

  /** Price the backtest would have assumed for the entry fill (bar close
   * at signal time). Captured at order submit. Compared against entryPrice
   * after reconciliation to produce the slippage columns below. */
  desiredEntryPrice: number | null;
  /** `(actual - desired) * sideSign / tickSize`. Positive = worse than
   * the backtest model; negative = price improvement. */
  entrySlippageTicks: number | null;
  entrySlippageDollars: number | null;
  /** Bracket target price computed at entry submit: entry ± tp_ticks * tickSize. */
  desiredTpPrice: number | null;
  /** Only populated when the TP actually filled. */
  tpSlippageTicks: number | null;
  tpSlippageDollars: number | null;
  desiredSlPrice: number | null;
  /** Only populated when the SL actually filled. Usually negative (worse)
   * on fast-moving markets where price gaps through the stop. */
  slSlippageTicks: number | null;
  slSlippageDollars: number | null;
  /** Bracket tick offsets at submit time. Mirror desiredTpPrice/desiredSlPrice
   * but in ticks, so the UI can show "+125t" without recomputing. Null on
   * trades created before this column existed. */
  desiredTpTicks: number | null;
  desiredSlTicks: number | null;

  /** True when closeTrade() resolved exit_price/pnl via the bar-close
   * approximation fallback (Trade/search hadn't indexed the real fill yet).
   * The heal pass re-runs the resolver on these rows and clears the flag
   * when the real fill data lands. Cleared rows have authoritative PnL. */
  exitApproximated: boolean;

  /** Which reconciliation layer produced the persisted exit values
   *  (docs/proposals/userhub-trade-subscription.md §Call sites that change
   *  item 11). Three layers, in priority order:
   *    - 'buffer'       — Layer 1 user-hub fill drain (hub-first path)
   *    - 'rest'         — Layer 2 /Trade/search REST attribution
   *    - 'approximated' — Layer 3 bar-close fallback
   *  Kept in lockstep with `exitApproximated`: 'approximated' ↔ true,
   *  otherwise false. Null on rows that predate this column or on
   *  non-closed rows (open / pending_entry / pending_exit). */
  exitResolutionSource: "buffer" | "rest" | "approximated" | null;

  /** When this trade was first seen to be closed — **written once, by
   *  `closeTrade`, and never moved.**
   *
   *  The session window needs a close time for a row whose `exitFilledAt` is
   *  still null, which is every Layer 3 approximated exit until the heal pass
   *  lands. `updatedAt` cannot serve: three healers bump it on a closed,
   *  unhealed row over a 7-day window, so an old trade would be restamped into
   *  the current session. Null only on rows predating the column and on
   *  non-closed rows. Format is SQLite's `datetime('now')`
   *  (`YYYY-MM-DD HH:MM:SS`, UTC), **not** ISO-8601 — compare it by parsing,
   *  never as a raw string against an ISO timestamp. */
  exitDetectedAt: string | null;

  /** Snapshot of the merged deployment params at order-placement time.
   * Pinned here so the live-vs-backtest replay engine can rehydrate the
   * exact params the live trade fired with — replaying against the
   * deployment's *current* params is dishonest the moment an edit lands.
   * Null for trades created before snapshotting shipped; the replay
   * engine short-circuits to "no_signal: no param snapshot" in that
   * case rather than silently falling back to current params. */
  paramSnapshot: Record<string, unknown> | null;

  /** Snapshot of runtime gates that couldn't be re-derived from bars +
   * params alone — e.g. cooldown anchor, contract held by another
   * deployment. Drives faithful replay of the engine's pre-entry
   * decision tree. Null for pre-snapshotting rows. */
  filterSnapshot: Record<string, unknown> | null;

  /** Raw JSON blob of the cached BacktestReplayResult (replay_result_json).
   *  Carried on every row so the analytics tab can aggregate replay outcomes
   *  client-side without an extra fetch per trade. Null until the row's
   *  /replay endpoint has been hit (lazy-cached on first request).
   *
   *  Note — this inflates every /api/trades poll by N × blob (~40KB at
   *  low hundreds of trades). The tradeoff was deliberate: it avoids a
   *  second fan-out fetch from the analytics panel and keeps the trade
   *  list as the single source of truth. Reconsider if the row count
   *  stops fitting in one polled response. */
  replayResultJson: string | null;

  /** Engine session UUID stamped at trade entry. Lifetime = engine
   *  process; rebuilds on restart. Analytics exclude trades whose value
   *  doesn't match the current engine session. Null on rows that predate
   *  this column — null-as-include semantics: treat as "predates session
   *  tracking, include in analytics." */
  engineSessionId: string | null;
  /** Deployment `version` (stringified) stamped at trade entry. Increments
   *  on every successful deployment PATCH. Analytics exclude trades whose
   *  stamped version doesn't match the deployment's current version.
   *  Null on rows that predate this column — same null-as-include semantics. */
  deploymentVersionId: string | null;

  /** Computed at query time via LEFT JOIN against deployments. Drives the
   *  All-Time card's bucket subtitle (Active / Retired / Trashed / Manual).
   *  See TradeBucket for the classification. Optional because most engine
   *  paths read trades via reducers that don't need the join — only
   *  presentation surfaces (the /api/trades endpoint, useTrades) populate it. */
  bucket?: TradeBucket;
}

export interface SlippageStats {
  /** Count of closed trades used in the rollup. */
  sampleSize: number;
  /** Average entry slippage across sample (ticks). */
  avgEntryTicks: number;
  /** Worst entry slippage in the sample (ticks). */
  worstEntryTicks: number;
  /** Sum of all entry + tp + sl slippage dollars across sample. Negative
   * when slippage consistently worked against us. */
  totalSlippageDollars: number;
}

export interface PnLSummary {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  winCount: number;
  lossCount: number;
  /** Net of fees (matches the per-row pnlDollars semantics). */
  totalPnlDollars: number;
  /** Sum of fees on closed trades. Positive. */
  totalFeesDollars: number;
}
