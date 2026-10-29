/**
 * The book backtest's inputs, read off a trading-DB snapshot.
 *
 * Opened read-only and never through `getDb()`: the snapshot is a copy the
 * scrub has already rewritten, not the app's database, and nothing here may
 * write to either. The deployment set and the thresholds are the snapshot's,
 * not history's, which is why the header names the file and its mtime.
 *
 * **"Was Active" is never read off `deployments.status`.** The scrub pauses
 * every row of a database copy, so on a snapshot that column is
 * `Paused` everywhere. A scrub that knows better saves the pre-scrub state into
 * `snapshot_prior_*` first. Either way a leg that wrote a trade or a skip
 * inside the range was evaluated in it, so it is a cell; on an older copy with
 * no prior table that is the only evidence, and the header says which answered
 * — a quiet leg is invisible to the fallback, and that is exactly the leg a
 * missed entry hides in.
 *
 * **No live-account screen.** A backtest places no orders, and on a non-prod
 * box the one predicate narrows to practice accounts — it would refuse the
 * Combine accounts prod books trade, which are the books worth simulating.
 */
import Database from "better-sqlite3";
import { statSync } from "node:fs";

import type { DailyPnlLimits } from "./daily-pnl-gate";
import {
  parseAccountRiskPhase,
  type SessionBudgetRow,
} from "./orders/account-phase-sizer";
import { currentCmeSessionStart } from "./session/session";
import { addCalendarDays, sessionStartUtc } from "./regime/session-dates";
import { RENAMED_KEYS } from "./strategies/renamed-keys";
import type { ParamValues } from "./strategy-types";
import type { BookAccountInput, BookCellInput } from "./backtest-book";

/** A group's saved params in the snapshot are not settings a hook can read:
 *  a refusal of that account's book, not a defect of the reader. */
export class SnapshotParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotParamsError";
  }
}

/**
 * Sessions `from` through `to` as the reader's instant range: exactly the
 * instants `sessionDateOf` files under those dates, 18:00 ET before `from` to
 * 18:00 ET on `to`. `parity-day`'s `findLiveLegs` buckets rows by
 * `sessionDateOf`, so a reader handed this range and that function agree on
 * which rows a session holds.
 */
export function sessionRangeUtc(from: string, to: string): { from: Date; to: Date } {
  return { from: sessionStartUtc(from), to: sessionStartUtc(addCalendarDays(to, 1)) };
}

/** Where the "was Active" answer came from. */
export type BookActiveSource = "prior_state" | "session_activity";

/** Where the first simulated session's close and peak came from. */
export type BookPhaseSeedSource = "first_live_trade" | "account_row" | "none";

export interface BookSnapshotHeader {
  snapshotPath: string;
  snapshotMtime: string;
  /** `snapshot_meta.taken_at` on a copy that records it, else null. */
  snapshotTakenAt: string | null;
  accountId: number;
  from: string;
  to: string;
  activeSource: BookActiveSource;
  phaseSeedSource: BookPhaseSeedSource;
}

export interface BookSnapshot {
  header: BookSnapshotHeader;
  /** `created_at ASC`, the engine's evaluation order after a server sync. */
  cells: BookCellInput[];
  account: BookAccountInput;
}

const PRIOR_DEPLOYMENTS_TABLE = "snapshot_prior_deployments";
const PRIOR_GROUPS_TABLE = "snapshot_prior_groups";
const SNAPSHOT_META_TABLE = "snapshot_meta";
const ACTIVE_STATUS = "Active";
const STALE_FLOOR_BASIS = "stale_floor";
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** A deployment the snapshot recorded as engine-enabled before the scrub. */
export interface PriorActiveDeploymentRow {
  id: string;
  account_id: number;
  strategy_key: string;
  ticker: string;
  created_at: string;
  parent_param_values: string | null;
}

interface AccountRow {
  broker: string;
  max_risk_per_trade_usd: number | null;
  max_contracts: number | null;
  daily_max_loss_usd: number | null;
  daily_max_profit_usd: number | null;
  daily_pnl_include_unrealized: number | null;
  risk_phase: string | null;
  mll_usd: number | null;
  start_balance_usd: number | null;
  press_at_usd: number | null;
  eod_balance_usd: number | null;
  eod_peak_usd: number | null;
}

/**
 * Every leg the engine would have evaluated for entry on `accountId`:
 * `Active` before the scrub, under a parent group that was enabled and not
 * deleted (`isLegEngineEnabled`), hand-made rows included — the lock and the
 * daily gate do not care whether a leg came from a book — plus every leg that
 * wrote a trade or a skip inside `[from, to)`.
 *
 * `usePriorState: false` ignores the prior table: the caller knows it was
 * taken at a moment that does not describe the range (`parity-day`'s
 * `judgeSnapshot`), so only the range's own rows count.
 */
export function readBookSnapshot(args: {
  dbPath: string;
  accountId: number;
  from: Date;
  to: Date;
  usePriorState?: boolean;
}): BookSnapshot {
  const { dbPath, accountId, from, to } = args;
  const mtime = statSync(dbPath).mtime.toISOString();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // A copy taken before the column existed reads it as unset, which no
    // phase but `combine_press` reads and that one refuses.
    const pressAt = columnExists(db, "account_brokers", "press_at_usd")
      ? "press_at_usd"
      : "NULL AS press_at_usd";
    const account = db
      .prepare(
        `SELECT broker, max_risk_per_trade_usd, max_contracts,
                daily_max_loss_usd, daily_max_profit_usd, daily_pnl_include_unrealized,
                risk_phase, mll_usd, start_balance_usd, ${pressAt}, eod_balance_usd, eod_peak_usd
           FROM account_brokers WHERE account_id = ?`,
      )
      .get(accountId) as AccountRow | undefined;

    const usePrior = (args.usePriorState ?? true) && tableExists(db, PRIOR_DEPLOYMENTS_TABLE);
    const byId = new Map<string, PriorActiveDeploymentRow>();
    for (const row of usePrior ? readPriorActiveDeployments(db, accountId) : []) byId.set(row.id, row);
    for (const row of readSessionActive(db, accountId, from, to)) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    const cells = [...byId.values()].sort(byCreatedThenId).map(toCell);

    const firstTradeSeed = readFirstTradeSeed(db, accountId, from, to);
    const rowSeed =
      account?.eod_balance_usd != null && account.eod_peak_usd != null
        ? { closeUsd: account.eod_balance_usd, peakUsd: account.eod_peak_usd }
        : null;
    const phaseSeed = firstTradeSeed ?? rowSeed;

    return {
      header: {
        snapshotPath: dbPath,
        snapshotMtime: mtime,
        snapshotTakenAt: readTakenAt(db),
        accountId,
        from: from.toISOString(),
        to: to.toISOString(),
        activeSource: usePrior ? "prior_state" : "session_activity",
        phaseSeedSource: firstTradeSeed ? "first_live_trade" : rowSeed ? "account_row" : "none",
      },
      cells,
      account: {
        accountId,
        dailyPnl: dailyLimitsOf(account),
        posture: account ? postureColumnsOf(account) : null,
        phaseSeed,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * The one reading of `snapshot_prior_deployments`: `Active` before the scrub,
 * not deleted, under an undeleted parent group that was enabled — the
 * engine's `isLegEngineEnabled`. `accountId` null reads every account.
 * Empty when the snapshot predates the table.
 */
export function readPriorActiveDeployments(
  db: Database.Database,
  accountId: number | null,
): PriorActiveDeploymentRow[] {
  if (!tableExists(db, PRIOR_DEPLOYMENTS_TABLE)) return [];
  // The groups table ships with the deployments one; a copy holding only the
  // first falls back to the group's present `deleted_at` alone.
  const groupClause = tableExists(db, PRIOR_GROUPS_TABLE)
    ? `AND EXISTS (SELECT 1 FROM ${PRIOR_GROUPS_TABLE} pg WHERE pg.id = d.group_id AND pg.enabled = 1)`
    : "";
  const accountClause = accountId == null ? "" : "AND d.account_id = ?";
  const params: Array<string | number> = accountId == null ? [ACTIVE_STATUS] : [ACTIVE_STATUS, accountId];
  return db
    .prepare(
      `SELECT d.id, d.account_id, d.strategy_key, d.ticker, d.created_at,
              g.param_values AS parent_param_values
         FROM deployments d
         JOIN ${PRIOR_DEPLOYMENTS_TABLE} p ON p.id = d.id
         JOIN deployment_groups g ON g.id = d.group_id
        WHERE p.status = ? AND d.deleted_at IS NULL AND g.deleted_at IS NULL
              ${accountClause} ${groupClause}
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(...params) as PriorActiveDeploymentRow[];
}

/** SQLite's `YYYY-MM-DD HH:MM:SS` is UTC with no zone; `Date.parse` would
 *  read it as local time. */
export function parseDbInstant(value: string): Date {
  return new Date(SQLITE_DATETIME.test(value) ? `${value.replace(" ", "T")}Z` : value);
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) != null
  );
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function byCreatedThenId(a: PriorActiveDeploymentRow, b: PriorActiveDeploymentRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function readSessionActive(
  db: Database.Database,
  accountId: number,
  from: Date,
  to: Date,
): PriorActiveDeploymentRow[] {
  const evidence = [
    ...(db
      .prepare(
        `SELECT deployment_id, COALESCE(signal_bar_ts, entry_submitted_at, created_at) AS at
           FROM strategy_trades WHERE account_id = ?`,
      )
      .all(accountId) as Array<{ deployment_id: string; at: string | null }>),
    ...(db
      .prepare(`SELECT deployment_id, signal_bar_ts AS at FROM skipped_signals WHERE account_id = ?`)
      .all(accountId) as Array<{ deployment_id: string; at: string | null }>),
  ];
  const live = new Set<string>();
  for (const row of evidence) {
    if (row.at == null) continue;
    const at = parseDbInstant(row.at).getTime();
    if (at >= from.getTime() && at < to.getTime()) live.add(row.deployment_id);
  }
  const rows = db
    .prepare(
      `SELECT d.id, d.account_id, d.strategy_key, d.ticker, d.created_at,
              g.param_values AS parent_param_values
         FROM deployments d
         LEFT JOIN deployment_groups g ON g.id = d.group_id
        WHERE d.account_id = ?
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(accountId) as PriorActiveDeploymentRow[];
  return rows.filter((r) => live.has(r.id));
}

/**
 * The close and peak the first live entry in the range was sized from — the
 * facts the engine stamped on its `paramSnapshot`. The account row's own
 * sample is the snapshot's latest close, which is the wrong end of the range.
 *
 * Only a sample that actually sized that trade's session is a seed: a
 * `stale_floor` basis, or a `sizesSessionStart` for another session, means
 * the engine had no current close and the numbers on the snapshot are older
 * than the session they would seed. Then the next source answers.
 */
function readFirstTradeSeed(
  db: Database.Database,
  accountId: number,
  from: Date,
  to: Date,
): { closeUsd: number; peakUsd: number } | null {
  const rows = db
    .prepare(
      `SELECT COALESCE(signal_bar_ts, entry_submitted_at, created_at) AS at, param_snapshot
         FROM strategy_trades WHERE account_id = ? AND param_snapshot IS NOT NULL`,
    )
    .all(accountId) as Array<{ at: string | null; param_snapshot: string }>;
  let first: { at: number; facts: SeedFacts } | null = null;
  for (const row of rows) {
    if (row.at == null) continue;
    const at = parseDbInstant(row.at).getTime();
    if (at < from.getTime() || at >= to.getTime()) continue;
    if (first != null && at >= first.at) continue;
    const facts = seedFactsOf(row.param_snapshot);
    if (facts != null) first = { at, facts };
  }
  if (first == null) return null;
  const { facts } = first;
  if (facts.riskBasis === STALE_FLOOR_BASIS) return null;
  if (facts.sizesSessionStart !== currentCmeSessionStart(new Date(first.at))) return null;
  return { closeUsd: facts.closeUsd, peakUsd: facts.peakUsd };
}

interface SeedFacts {
  closeUsd: number;
  peakUsd: number;
  riskBasis: string | null;
  sizesSessionStart: string | null;
}

function seedFactsOf(raw: string): SeedFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const record = parsed as Record<string, unknown>;
  const close = record.eodCloseUsd;
  const peak = record.eodPeakUsd;
  if (typeof close !== "number" || typeof peak !== "number") return null;
  if (!Number.isFinite(close) || !Number.isFinite(peak)) return null;
  return {
    closeUsd: close,
    peakUsd: peak,
    riskBasis: typeof record.riskBasis === "string" ? record.riskBasis : null,
    sizesSessionStart: typeof record.sizesSessionStart === "string" ? record.sizesSessionStart : null,
  };
}

function readTakenAt(db: Database.Database): string | null {
  if (!tableExists(db, SNAPSHOT_META_TABLE)) return null;
  const row = db.prepare(`SELECT taken_at FROM ${SNAPSHOT_META_TABLE} LIMIT 1`).get() as
    | { taken_at: string | null }
    | undefined;
  return row?.taken_at ?? null;
}

/** A copy taken before 2026-10-16 never ran the key rename, so a cell's key
 *  is read through the map — the key the copy would carry once migrated. */
function toCell(row: PriorActiveDeploymentRow): BookCellInput {
  return {
    deploymentId: row.id,
    strategyKey: RENAMED_KEYS[row.strategy_key] ?? row.strategy_key,
    ticker: row.ticker,
    createdAt: row.created_at,
    paramValues: row.parent_param_values == null ? {} : paramValuesOf(row.id, row.parent_param_values),
  };
}

/**
 * The parent group's saved params, checked: the snapshot is a file this
 * process did not write, and a blob that is not a flat object of scalars would
 * otherwise reach the strategy hooks as settings nobody chose.
 */
function paramValuesOf(deploymentId: string, raw: string): ParamValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotParamsError(`Deployment ${deploymentId}'s group params in the snapshot are not JSON.`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new SnapshotParamsError(`Deployment ${deploymentId}'s group params in the snapshot are not an object.`);
  }
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value) && value.every(isWindow)) {
      // `additionalSessions` / `pauseWindows`: both `{ start, end }` pairs.
      out[key] = value.map((w) => ({ start: w.start, end: w.end }));
    } else {
      throw new SnapshotParamsError(
        `Deployment ${deploymentId}'s group param "${key}" in the snapshot is not a number, flag, text ` +
          `or a list of time windows.`,
      );
    }
  }
  return out;
}

function isWindow(value: unknown): value is { start: string; end: string } {
  return (
    typeof value === "object" &&
    value != null &&
    typeof (value as Record<string, unknown>).start === "string" &&
    typeof (value as Record<string, unknown>).end === "string"
  );
}

/** `getAccountDailyPnlLimits`' reading: unset is off, not a refusal. */
function dailyLimitsOf(row: AccountRow | undefined): DailyPnlLimits {
  return {
    dailyMaxLossUsd: row?.daily_max_loss_usd ?? 0,
    dailyMaxProfitUsd: row?.daily_max_profit_usd ?? 0,
    dailyPnlIncludeUnrealized: row?.daily_pnl_include_unrealized === 1,
  };
}

/** `resolveSessionPosture`'s columns, without the sample the runner advances. */
function postureColumnsOf(
  row: AccountRow,
): Omit<SessionBudgetRow, "eodBalanceUsd" | "eodPeakUsd" | "eodSizesSessionStart"> {
  return {
    broker: row.broker === "tradovate" ? "tradovate" : "topstep",
    riskPhase: parseAccountRiskPhase(row.risk_phase),
    mllUsd: row.mll_usd,
    startBalanceUsd: row.start_balance_usd,
    pressAtUsd: row.press_at_usd,
    maxRiskPerTradeUsd: row.max_risk_per_trade_usd,
    maxContracts: row.max_contracts,
  };
}
