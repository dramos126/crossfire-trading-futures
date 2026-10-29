import { getDb, registerMigration } from "./connection";
import type { SkippedSignal } from "@/lib/trading/skipped-signal";

/**
 * The negative half of the trade ledger: an entry the engine considered and
 * did not place, with the reason on the row.
 *
 * A playbook that fires five times a month leaves twenty quiet sessions whose
 * only question is *why didn't it trade*, and before this table a quiet
 * session left no row anywhere. The rows are the evidence for `orb`'s G1
 * session count and for the monthly review's `backtestOnly` classification.
 *
 * **What lands here is a *structured* skip, never every bar that failed to
 * enter.** A bar the strategy declined with a bare `null` carries no reason,
 * so a row for it would say only that the engine was running — which the
 * heartbeat already says, at one row per process rather than one per bar per
 * leg. The volume argument and what it costs are in
 * `docs/modules/persistence/README.md`.
 *
 * The row shape is built by `@/lib/trading/skipped-signal`, which the backtest
 * CLI also builds its `skips.jsonl` rows through — that shared constructor is
 * the whole of the engine↔backtest parity here.
 */
registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS skipped_signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at     TEXT NOT NULL,
      signal_bar_ts   TEXT NOT NULL,
      session_date    TEXT NOT NULL,
      deployment_id   TEXT NOT NULL,
      group_id        TEXT NOT NULL,
      account_id      INTEGER NOT NULL,
      strategy_key    TEXT NOT NULL,
      ticker          TEXT NOT NULL,
      source          TEXT NOT NULL,
      gate            TEXT NOT NULL,
      reason          TEXT NOT NULL,
      detail          TEXT
    );
    -- "why was this leg quiet on this day" is the only question asked of the
    -- table, and it is asked per leg and per session day.
    CREATE INDEX IF NOT EXISTS idx_skipped_signals_deployment_session
      ON skipped_signals(deployment_id, session_date);
    -- The read-side CLI pulls a window across every leg.
    CREATE INDEX IF NOT EXISTS idx_skipped_signals_session ON skipped_signals(session_date);
  `);

  // `(leg, signal bar, gate)` is the row's identity, because the engine has
  // no durable per-bar cursor: `DeploymentState.lastBarTimestamp` is memory,
  // so a restart mid-session re-evaluates the bar it was on and the same gate
  // refuses it a second time. One skip is one fact about one bar, and the
  // review counts rows.
  //
  // The index arrived after the table, so a build between the two could hold
  // duplicates — and `CREATE UNIQUE INDEX` throws on one, which inside a
  // migration is a boot failure. Fold them first, oldest row wins, and only
  // on the boot that creates the index.
  const hasIndex = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_skipped_signals_once'`)
    .get();
  if (hasIndex == null) {
    d.exec(`
      DELETE FROM skipped_signals WHERE id NOT IN (
        SELECT MIN(id) FROM skipped_signals GROUP BY deployment_id, signal_bar_ts, gate
      );
      CREATE UNIQUE INDEX idx_skipped_signals_once
        ON skipped_signals(deployment_id, signal_bar_ts, gate);
    `);
  }
});

/** Which deployment took the skip. Everything else is on `SkippedSignal`. */
export interface SkippedSignalLeg {
  deploymentId: string;
  /** `Deployment.groupId` verbatim, which is `""` for a deployment row that
   *  predates the parent model — the id of no parent, never null. */
  groupId: string;
  accountId: number;
  strategyKey: string;
  ticker: string;
}

export interface SkippedSignalRow extends SkippedSignalLeg, SkippedSignal {
  id: number;
  recordedAt: string;
}

interface DbRow {
  id: number;
  recorded_at: string;
  signal_bar_ts: string;
  session_date: string;
  deployment_id: string;
  group_id: string;
  account_id: number;
  strategy_key: string;
  ticker: string;
  source: string;
  gate: string;
  reason: string;
  detail: string | null;
}

/**
 * Persist one skip. Synchronous and unbatched, unlike `engine_logs`: this
 * fires a handful of times per session per leg rather than from a hot loop,
 * and a skip lost to an unflushed queue on a crash is the one session the
 * operator is most likely to be asking about.
 *
 * `OR IGNORE` against the unique index above, so a restart that re-evaluates
 * the bar it went down on writes the row once. It is the dedup, not a
 * tolerance for conflicting rows: nothing here updates.
 */
export function insertSkippedSignal(leg: SkippedSignalLeg, skip: SkippedSignal): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO skipped_signals
         (recorded_at, signal_bar_ts, session_date, deployment_id, group_id,
          account_id, strategy_key, ticker, source, gate, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      skip.signalBarTs,
      skip.sessionDate,
      leg.deploymentId,
      leg.groupId,
      leg.accountId,
      leg.strategyKey,
      leg.ticker,
      skip.source,
      skip.gate,
      skip.reason,
      skip.detail == null ? null : JSON.stringify(skip.detail),
    );
}

/**
 * Skips in a session-date range, oldest first. `deploymentId` narrows to one
 * leg; absent is every leg.
 *
 * The bounds are session dates (`YYYY-MM-DD`) and compare as plain text
 * because the column is written by `sessionDateOf`, which emits exactly that
 * — there is no second generation of this column to `datetime()` across.
 */
export function listSkippedSignals(args: {
  fromSessionDate: string;
  toSessionDate: string;
  deploymentId?: string;
}): SkippedSignalRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM skipped_signals
        WHERE session_date >= ? AND session_date <= ?
          ${args.deploymentId == null ? "" : "AND deployment_id = ?"}
        ORDER BY signal_bar_ts ASC, id ASC`,
    )
    .all(
      ...(args.deploymentId == null
        ? [args.fromSessionDate, args.toSessionDate]
        : [args.fromSessionDate, args.toSessionDate, args.deploymentId]),
    ) as DbRow[];

  return rows.map((r) => ({
    id: r.id,
    recordedAt: r.recorded_at,
    signalBarTs: r.signal_bar_ts,
    sessionDate: r.session_date,
    deploymentId: r.deployment_id,
    groupId: r.group_id,
    accountId: r.account_id,
    strategyKey: r.strategy_key,
    ticker: r.ticker,
    source: r.source === "platform" ? "platform" : "strategy",
    gate: r.gate,
    reason: r.reason,
    detail: parseDetail(r.detail),
  }));
}

/**
 * A hand-edited or truncated blob reads as "no detail" rather than throwing —
 * the row's reason and gate are the load-bearing part and a diagnostic read
 * must not fail on the optional half.
 *
 * The values are narrowed rather than asserted: this is a text column anyone
 * with the file can edit, so a nested object arriving typed as a `number` is
 * a reader that lies about its own return type to every consumer downstream.
 * A key whose value is not a scalar is dropped; a blob with none left reads
 * as no detail.
 */
function parseDetail(raw: string | null): SkippedSignal["detail"] {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      detail[key] = value;
    }
  }
  return Object.keys(detail).length > 0 ? detail : null;
}
