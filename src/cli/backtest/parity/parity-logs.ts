/**
 * The engine's own record of the session, read off the snapshot so a parity
 * difference carries what live logged around its signal bar. `parity-day`
 * reads every non-heartbeat `engine_logs` row of the session, keeps the live
 * legs' deployments' lines plus the engine's own lines (`deployment_id` is
 * the engine sentinel) that name one of the legs' accounts or no account at
 * all — a broker frame the engine could not map names none, and is still
 * about these orders — and writes them to `logs.json`. The windows are cut when a page or summary is drawn,
 * so a single-mode re-run's differences and the carried-forward mode's both
 * find their lines in the one file, and `parity-report` needs no database.
 *
 * A snapshot that cannot answer — no table, a column missing, a read that
 * throws — is a sentence in the file, never a refusal of the day: the log
 * evidence explains a difference, it is not the comparison.
 */
import type Database from "better-sqlite3";

import {
  ACCOUNT_RISK_SETTINGS_CHANGED,
  accountRiskChangesOf,
  touchesDailyLimits,
} from "@/lib/db/account-risk-change";
import { ENGINE_SCOPE } from "@/lib/logging/vocabulary";
import type { AccountGateRefusal } from "@/lib/trading/backtest";
import { sessionRangeUtc } from "@/lib/trading/backtest-book-snapshot";
import { etParts } from "@/lib/trading/regime/session-dates";

export const LOGS_FILE = "logs.json";

export interface LogLeg {
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  /** As the database spells it, `/MNQ`. */
  ticker: string;
  /** The bar the deployment trades on; null when it could not be resolved,
   *  and the window then assumes `FALLBACK_BAR_MINUTES`. */
  barMinutes: number | null;
}

export interface LogRecord {
  /** ISO instant. */
  at: string;
  /** Null on an engine line. */
  deploymentId: string | null;
  /** Never printed — only used to put an account line beside its legs. Null
   *  on an engine line about no account, which belongs to every window. */
  accountId: number | null;
  /** `severity`, else the legacy `level` on a row written before the pipe. */
  severity: string;
  event: string | null;
  /** Scrubbed at write time by the log pipe. */
  message: string;
}

export interface ParityLogsFile {
  sessionDate: string;
  /** Why the snapshot's logs could not be read; null when they were. */
  unavailable: string | null;
  legs: LogLeg[];
  lines: LogRecord[];
}

const TABLE = "engine_logs";
/** The table's first shape; the envelope columns beside it are read when present. */
const REQUIRED_COLUMNS = ["timestamp", "deployment_id", "level", "message"];
const ENVELOPE_COLUMNS = ["account_id", "severity", "event"];
/** The heartbeat ring is thousands of lines a session and says nothing about an entry. */
const HEARTBEAT_LEVEL = "heartbeat";
const FALLBACK_BAR_MINUTES = 5;
/** Past the next bar's close: an order submitted on the close lands a few hundred ms later. */
const WINDOW_SLACK_MINUTES = 1;
const MS_PER_MINUTE = 60_000;
const IRREGULAR_SEVERITIES = new Set(["warn", "error"]);
/** Typed so a renamed refusal fails to compile here; the report reads gates as plain strings. */
const DAILY_PNL_GATE: AccountGateRefusal = "daily_pnl";

/** The session's lines as the snapshot holds them, before they are scoped to the legs. */
export interface SessionLogRead {
  unavailable: string | null;
  lines: LogRecord[];
}

export function logsUnavailable(why: string): SessionLogRead {
  return { unavailable: `Engine logs were unavailable: ${why}, so no difference carries what live logged.`, lines: [] };
}

/**
 * Every non-heartbeat line of the session, or the reason there are none.
 * `db` is the private copy, opened read-only by the caller **before anything
 * migrates it** — the app's migrations would create an empty `engine_logs`
 * on a snapshot without one, and an empty table reads as "live logged nothing".
 */
export function readEngineLogs(db: Database.Database, sessionDate: string): SessionLogRead {
  try {
    if (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TABLE) == null) {
      return logsUnavailable("the snapshot has no engine_logs table");
    }
    const columns = new Set((db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).map((c) => c.name));
    const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
    if (missing.length > 0) {
      return logsUnavailable(`the snapshot's engine_logs has no ${missing.join(", ")} column${missing.length === 1 ? "" : "s"}`);
    }
    const { from, to } = sessionRangeUtc(sessionDate, sessionDate);
    const envelope = ENVELOPE_COLUMNS.map((c) => (columns.has(c) ? c : `NULL AS ${c}`)).join(", ");
    const rows = db
      .prepare(
        `SELECT timestamp, deployment_id, level, message, ${envelope} FROM ${TABLE}
          WHERE timestamp >= ? AND timestamp < ? AND level <> ?
          ORDER BY timestamp, id`,
      )
      .all(from.toISOString(), to.toISOString(), HEARTBEAT_LEVEL) as Array<{
      timestamp: unknown;
      deployment_id: unknown;
      account_id: unknown;
      level: unknown;
      severity: unknown;
      event: unknown;
      message: unknown;
    }>;
    const lines: LogRecord[] = [];
    for (const row of rows) {
      const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      const deploymentId = typeof row.deployment_id === "string" && row.deployment_id !== ENGINE_SCOPE ? row.deployment_id : null;
      lines.push({
        at: new Date(at).toISOString(),
        deploymentId,
        accountId: typeof row.account_id === "number" ? row.account_id : null,
        severity: typeof row.severity === "string" ? row.severity : typeof row.level === "string" ? row.level : "info",
        event: typeof row.event === "string" ? row.event : null,
        message: typeof row.message === "string" ? row.message : String(row.message ?? ""),
      });
    }
    return { unavailable: null, lines };
  } catch (err) {
    return logsUnavailable(`reading them failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** `logs.json`: the legs' own lines, and the engine's lines about their
 *  accounts or about no account. */
export function scopeLogs(read: SessionLogRead, sessionDate: string, legs: readonly LogLeg[]): ParityLogsFile {
  const deployments = new Set(legs.map((l) => l.deploymentId));
  const accounts = new Set(legs.map((l) => l.accountId));
  return {
    sessionDate,
    unavailable: read.unavailable,
    legs: [...legs],
    lines: read.lines.filter((l) =>
      l.deploymentId == null ? l.accountId == null || accounts.has(l.accountId) : deployments.has(l.deploymentId),
    ),
  };
}

// ── Windows ──────────────────────────────────────────────────────────────

export interface LogWindow {
  deploymentId: string;
  accountId: number;
  fromMs: number;
  toMs: number;
}

/**
 * The signal bar's open through the next bar's close, plus a minute: the
 * decision is made on the signal bar's close and the order goes out at the
 * next bar's open, so this holds the entry, its rejection or fill, and a
 * skip logged one bar late.
 */
export function logWindow(
  logs: Pick<ParityLogsFile, "legs">,
  deploymentId: string,
  accountId: number,
  signalBarTs: string,
): LogWindow | null {
  const fromMs = Date.parse(signalBarTs);
  // A deployment the file was not read for has unknown lines, which must not
  // read as none.
  const leg = logs.legs.find((l) => l.deploymentId === deploymentId);
  if (!Number.isFinite(fromMs) || leg == null) return null;
  const minutes = leg.barMinutes ?? FALLBACK_BAR_MINUTES;
  return { deploymentId, accountId, fromMs, toMs: fromMs + (2 * minutes + WINDOW_SLACK_MINUTES) * MS_PER_MINUTE };
}

function inWindow(line: LogRecord, w: LogWindow): boolean {
  const at = Date.parse(line.at);
  if (at < w.fromMs || at > w.toMs) return false;
  if (line.deploymentId != null) return line.deploymentId === w.deploymentId;
  return line.accountId == null || line.accountId === w.accountId;
}

export interface LogEvidence {
  lines: string[];
  /** The one sentence for a window with no line; null when it has some. */
  empty: string | null;
}

/** What live logged in a difference's window; null when there is no window
 *  to cut — no logs saved, logs unavailable, no signal bar recorded, or a
 *  deployment the logs were not read for. */
export function evidenceFor(
  logs: ParityLogsFile | null,
  cell: { deploymentId: string; accountId: number },
  signalBarTs: string | null,
): { evidence: LogEvidence; window: LogWindow } | null {
  if (logs == null || logs.unavailable != null || signalBarTs == null) return null;
  const window = logWindow(logs, cell.deploymentId, cell.accountId, signalBarTs);
  if (window == null) return null;
  const lines = logs.lines.filter((l) => inWindow(l, window)).map((l) => logLineText(l));
  return {
    window,
    evidence: {
      lines,
      empty:
        lines.length > 0
          ? null
          : `Live logged nothing for this playbook from ${clock(window.fromMs)} to ${clock(window.toMs)} ET.`,
    },
  };
}

/** `summary.md`'s lines under a difference sentence. */
export function evidenceMarkdown(
  logs: ParityLogsFile | null,
  cell: { deploymentId: string; accountId: number },
  signalBarTs: string | null,
): string[] {
  const found = evidenceFor(logs, cell, signalBarTs);
  if (found == null) return [];
  const { lines, empty } = found.evidence;
  return (empty == null ? lines : [empty]).map((l) => `  - ${l}`);
}

/**
 * The sentence for a difference the account's own settings change can account
 * for, or null when no change was logged after its bar.
 *
 * **The book reads the account's limits off the snapshot, which is taken after
 * the close, and applies them to every bar of the session.** So a limit the
 * operator set at 14:00 is in force in the book at 10:30, where live had none —
 * the 2026-10-20 extra entry, which looked like a gate that failed after a
 * restart. Only a change *after* the bar matters: one before it was in force
 * on both sides. A `daily_pnl` block with a daily-limit change after it is
 * explained, because that gate reads nothing else; any other difference only
 * may be, because a posture or phase change moves sizing, not whether a bar enters.
 */
export function settingsChangeNote(
  logs: ParityLogsFile | null,
  accountId: number,
  signalBarTs: string | null,
  gate: string | null,
): string | null {
  if (logs == null || logs.unavailable != null || signalBarTs == null) return null;
  const barMs = Date.parse(signalBarTs);
  const later = logs.lines.filter(
    (l) => l.event === ACCOUNT_RISK_SETTINGS_CHANGED && l.accountId === accountId && Date.parse(l.at) > barMs,
  );
  if (later.length === 0) return null;
  const what = later
    .map((l) => `${clock(Date.parse(l.at))} ET: ${accountRiskChangesOf(l.message).join(", ")}`)
    .join("; ");
  const dailyChanged = later.some((l) => accountRiskChangesOf(l.message).some(touchesDailyLimits));
  return gate === DAILY_PNL_GATE && dailyChanged
    ? `Explained by a settings change: the account's daily limits were changed later in the session (${what}), ` +
        "and the book applied the limits from the snapshot to the whole day, so live did not have this limit at the time."
    : `The account's risk settings were changed later in the session (${what}), and the book applied the ` +
        "settings from the snapshot to the whole day, so the change may explain this.";
}

/** The warn and error lines no difference window holds: what the compare cannot see. */
export function irregularLines(logs: ParityLogsFile, windows: readonly LogWindow[]): LogRecord[] {
  return logs.lines.filter((l) => IRREGULAR_SEVERITIES.has(l.severity) && !windows.some((w) => inWindow(l, w)));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(ms: number, withSeconds = false): string {
  const p = etParts(new Date(ms));
  return `${pad2(p.hour)}:${pad2(p.minute)}${withSeconds ? `:${pad2(p.second)}` : ""}`;
}

/** `09:50:00 ET entry_order_rejected (error): Entry order rejected: …`, with
 *  `subject` after the time when the line stands outside its playbook's section. */
export function logLineText(line: LogRecord, subject: string | null = null): string {
  const tag = IRREGULAR_SEVERITIES.has(line.severity) && line.event != null ? ` (${line.severity})` : "";
  const who = subject == null ? "" : ` · ${subject} ·`;
  return `${clock(Date.parse(line.at), true)} ET${who} ${line.event ?? line.severity}${tag}: ${line.message}`;
}
