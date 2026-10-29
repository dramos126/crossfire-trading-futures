import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ACCOUNT_RISK_SETTINGS_CHANGED, accountRiskChangeMessage } from "@/lib/db/account-risk-change";
import {
  evidenceMarkdown,
  readEngineLogs,
  scopeLogs,
  settingsChangeNote,
  type LogLeg,
  type LogRecord,
  type ParityLogsFile,
} from "./parity-logs";

const SESSION = "2026-10-14";
const LEG: LogLeg = { deploymentId: "dep-a", accountId: 9820, strategyKey: "orb", ticker: "/MNQ", barMinutes: 1 };

describe("readEngineLogs", () => {
  it("is one sentence, not a throw, when a column it needs is missing", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE engine_logs (id INTEGER PRIMARY KEY, timestamp TEXT, deployment_id TEXT, level TEXT)`);

    const read = readEngineLogs(db, SESSION);

    expect(read.unavailable).toBe(
      "Engine logs were unavailable: the snapshot's engine_logs has no message column, " +
        "so no difference carries what live logged.",
    );
    expect(evidenceMarkdown(scopeLogs(read, SESSION, [LEG]), LEG, "2026-10-14T13:49:00.000Z")).toEqual([]);
    db.close();
  });

  it("reads a table that predates the envelope columns, taking the level as the severity", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE engine_logs (id INTEGER PRIMARY KEY, timestamp TEXT, deployment_id TEXT, level TEXT, message TEXT)`);
    db.prepare(`INSERT INTO engine_logs (timestamp, deployment_id, level, message) VALUES (?, 'dep-a', 'error', 'rejected')`).run(
      "2026-10-14T13:50:00.000Z",
    );

    const logs = scopeLogs(readEngineLogs(db, SESSION), SESSION, [LEG]);

    expect(logs.unavailable).toBeNull();
    expect(evidenceMarkdown(logs, LEG, "2026-10-14T13:49:00.000Z")).toEqual(["  - 09:50:00 ET error: rejected"]);
    db.close();
  });

  it("keeps an engine line that names no account, and drops one naming another account", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE engine_logs (id INTEGER PRIMARY KEY, timestamp TEXT, deployment_id TEXT, account_id INTEGER,
      level TEXT, severity TEXT, event TEXT, message TEXT)`);
    const insert = db.prepare(
      `INSERT INTO engine_logs (timestamp, deployment_id, account_id, level, severity, event, message) VALUES (?, 'engine', ?, 'warn', 'warn', 'broker_code_unknown', ?)`,
    );
    insert.run("2026-10-14T13:50:00.326Z", null, "unknown status=6");
    insert.run("2026-10-14T13:50:01.000Z", 2071, "another account");

    const logs = scopeLogs(readEngineLogs(db, SESSION), SESSION, [LEG]);

    expect(evidenceMarkdown(logs, LEG, "2026-10-14T13:49:00.000Z")).toEqual([
      "  - 09:50:00 ET broker_code_unknown (warn): unknown status=6",
    ]);
    db.close();
  });

  it("cuts a 1m leg's window from the signal bar's open to the next bar's close plus a minute", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE engine_logs (id INTEGER PRIMARY KEY, timestamp TEXT, deployment_id TEXT, account_id INTEGER,
      level TEXT, severity TEXT, event TEXT, message TEXT)`);
    const insert = db.prepare(
      `INSERT INTO engine_logs (timestamp, deployment_id, account_id, level, severity, event, message) VALUES (?, 'dep-a', 9820, 'trade', 'info', 'entry_submitted', ?)`,
    );
    insert.run("2026-10-14T13:48:59.000Z", "before the bar");
    insert.run("2026-10-14T13:50:00.255Z", "BUY 1 /MNQ");
    insert.run("2026-10-14T13:52:00.000Z", "at the edge");
    insert.run("2026-10-14T13:52:00.001Z", "after it");

    const logs = scopeLogs(readEngineLogs(db, SESSION), SESSION, [LEG]);

    expect(evidenceMarkdown(logs, LEG, "2026-10-14T13:49:00.000Z")).toEqual([
      "  - 09:50:00 ET entry_submitted: BUY 1 /MNQ",
      "  - 09:52:00 ET entry_submitted: at the edge",
    ]);
    // A deployment the file was not read for is unknown, never "logged nothing".
    expect(evidenceMarkdown(logs, { deploymentId: "dep-b", accountId: 9820 }, "2026-10-14T15:00:00.000Z")).toEqual([]);
    db.close();
  });
});

describe("settingsChangeNote", () => {
  /** The 2026-10-20 shape: a $750 profit limit set at 14:00 ET, after a 10:00 bar. */
  const change = (at: string, accountId: number, changes: string[]): LogRecord => ({
    at,
    deploymentId: null,
    accountId,
    severity: "info",
    event: ACCOUNT_RISK_SETTINGS_CHANGED,
    message: accountRiskChangeMessage(accountId, "saved in Settings", changes),
  });
  const logsWith = (...lines: LogRecord[]): ParityLogsFile => ({ sessionDate: SESSION, unavailable: null, legs: [LEG], lines });
  const BAR = "2026-10-14T14:00:00.000Z";
  const LATER = "2026-10-14T18:00:00.000Z";

  it("explains a daily-limit block when the limit was set after the bar", () => {
    const note = settingsChangeNote(logsWith(change(LATER, 9820, ["daily profit limit off → $750"])), 9820, BAR, "daily_pnl");
    expect(note).toBe(
      "Explained by a settings change: the account's daily limits were changed later in the session " +
        "(14:00 ET: daily profit limit off → $750), and the book applied the limits from the snapshot to the " +
        "whole day, so live did not have this limit at the time.",
    );
  });

  it("only says a posture change may explain a block, because it moves sizing, not the daily gate", () => {
    const note = settingsChangeNote(logsWith(change(LATER, 9820, ["risk per trade $350 → $300"])), 9820, BAR, "daily_pnl");
    expect(note).toMatch(/^The account's risk settings were changed later in the session \(14:00 ET: risk per trade \$350 → \$300\).*may explain this\.$/);
  });

  it("says nothing for a change before the bar, which both sides had, or one on another account", () => {
    const before = change("2026-10-14T13:00:00.000Z", 9820, ["daily profit limit off → $750"]);
    const elsewhere = change(LATER, 1234, ["daily profit limit off → $750"]);
    expect(settingsChangeNote(logsWith(before, elsewhere), 9820, BAR, "daily_pnl")).toBeNull();
  });

  it("says nothing when the logs could not be read", () => {
    const unread = { ...logsWith(change(LATER, 9820, ["daily profit limit off → $750"])), unavailable: "no table" };
    expect(settingsChangeNote(unread, 9820, BAR, "daily_pnl")).toBeNull();
  });
});
