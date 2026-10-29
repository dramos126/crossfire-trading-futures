import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bookCommand, parseBookArgs } from "./book-command";
import { CliError } from "../cli-error";
import type { CpuThrottle } from "../throttle";

const THROTTLE = {
  onProgress: async () => {},
  report: () => ({ targetPct: 40, workers: 1, achievedPct: 0 }),
} satisfies CpuThrottle;

const ARGV = ["--account", "90063379", "--from", "2026-09-01", "--to", "2026-09-30"];

let dir: string;
const savedDb = process.env.TRADING_DB_PATH;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "book-command-test-"));
});

afterEach(() => {
  if (savedDb == null) delete process.env.TRADING_DB_PATH;
  else process.env.TRADING_DB_PATH = savedDb;
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = "secret-topstep-api-key-value";

/** The tables the reader and the scrub name; credentials and tokens in each. */
function buildSnapshot(file: string, groupParams = "{}"): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE auth_token (token TEXT);
    CREATE TABLE engine_auth_token (token TEXT);
    CREATE TABLE app_session (id TEXT);
    CREATE TABLE account_brokers (
      account_id INTEGER PRIMARY KEY, broker TEXT, max_risk_per_trade_usd REAL, max_contracts INTEGER,
      daily_max_loss_usd REAL, daily_max_profit_usd REAL, daily_pnl_include_unrealized INTEGER,
      risk_phase TEXT, mll_usd REAL, start_balance_usd REAL, eod_balance_usd REAL, eod_peak_usd REAL
    );
    CREATE TABLE deployment_groups (id TEXT PRIMARY KEY, param_values TEXT, enabled INTEGER, deleted_at TEXT);
    CREATE TABLE deployments (
      id TEXT PRIMARY KEY, account_id INTEGER, strategy_key TEXT, ticker TEXT, status TEXT,
      group_id TEXT, created_at TEXT, deleted_at TEXT
    );
    CREATE TABLE strategy_trades (
      id INTEGER PRIMARY KEY, deployment_id TEXT, account_id INTEGER, signal_bar_ts TEXT,
      entry_submitted_at TEXT, created_at TEXT, param_snapshot TEXT
    );
    CREATE TABLE skipped_signals (id INTEGER PRIMARY KEY, deployment_id TEXT, account_id INTEGER, signal_bar_ts TEXT);
  `);
  db.prepare(`INSERT INTO app_settings VALUES ('topstep_api_key', ?), ('theme', 'dark')`).run(SECRET);
  db.prepare(`INSERT INTO auth_token VALUES ('jwt')`).run();
  db.prepare(`INSERT INTO app_session VALUES ('s1')`).run();
  db.prepare(`INSERT INTO deployment_groups VALUES ('g', ?, 1, NULL)`).run(groupParams);
  db.prepare(
    `INSERT INTO deployments VALUES ('dep-a', 90063379, 'orb', '/MNQ', 'Paused', 'g', '2026-08-01T00:00:00.000Z', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO strategy_trades VALUES (1, 'dep-a', 90063379, ?, ?, NULL, NULL)`,
  ).run("2026-09-10T14:00:00.000Z", "2026-09-10T14:00:02.000Z");
  db.close();
}

describe("bookCommand — the snapshot", () => {
  it("refuses when TRADING_DB_PATH is not set, before anything is written", async () => {
    delete process.env.TRADING_DB_PATH;
    const out = path.join(dir, "out");

    await expect(bookCommand(parseBookArgs([...ARGV, "--out", out]), THROTTLE)).rejects.toThrow(
      /TRADING_DB_PATH is not set; book reads the trading database snapshot/,
    );
  });

  it("refuses a TRADING_DB_PATH that names no file", async () => {
    process.env.TRADING_DB_PATH = path.join(dir, "missing.db");

    await expect(bookCommand(parseBookArgs(ARGV), THROTTLE)).rejects.toThrow(CliError);
    await expect(bookCommand(parseBookArgs(ARGV), THROTTLE)).rejects.toThrow(/which is not a file/);
  });

  it("reads a scrubbed copy: the source untouched, TRADING_DB_PATH on the copy, no credential in its bytes", async () => {
    const source = path.join(dir, "trading.db");
    // Bad group params stop the run right after the read, before any bar.
    buildSnapshot(source, "{oops");
    const before = createHash("sha256").update(readFileSync(source)).digest("hex");
    process.env.TRADING_DB_PATH = source;

    await expect(bookCommand(parseBookArgs(ARGV), THROTTLE)).rejects.toThrow(CliError);

    expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(before);
    const copyPath = process.env.TRADING_DB_PATH;
    expect(copyPath).not.toBe(source);
    const copy = new Database(copyPath, { readonly: true });
    try {
      expect(copy.prepare(`SELECT key FROM app_settings`).all()).toEqual([{ key: "theme" }]);
      for (const table of ["auth_token", "engine_auth_token", "app_session"]) {
        expect(copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      copy.close();
    }
    // secure_delete: the deleted row's bytes are gone from the file, not just unlinked.
    expect(readFileSync(copyPath ?? "").includes(SECRET)).toBe(false);
  });

  it("refuses bad group params in the snapshot as an operator-facing refusal, naming the deployment", async () => {
    const source = path.join(dir, "trading.db");
    buildSnapshot(source, "[1]");
    process.env.TRADING_DB_PATH = source;

    await expect(bookCommand(parseBookArgs(ARGV), THROTTLE)).rejects.toThrow(
      new CliError("Deployment dep-a's group params in the snapshot are not an object."),
    );
  });
});

describe("parseBookArgs", () => {
  it("takes the account, the session range, the tail and the order", () => {
    expect(parseBookArgs([...ARGV, "--topstep-tail", "--order", "permute"])).toMatchObject({
      accountId: 90063379,
      from: "2026-09-01",
      to: "2026-09-30",
      topstepTail: true,
      order: "permute",
      cpuTarget: 100,
      out: null,
    });
    expect(parseBookArgs(ARGV)).toMatchObject({ topstepTail: false, order: "created_at" });
  });

  it("refuses a missing account, a reversed range, an unknown order and a run flag", () => {
    expect(() => parseBookArgs(ARGV.slice(2))).toThrow(/Missing required flag --account/);
    expect(() => parseBookArgs(["--account", "1", "--from", "2026-09-30", "--to", "2026-09-01"])).toThrow(/after --to/);
    expect(() => parseBookArgs([...ARGV, "--order", "random"])).toThrow(/--order must be one of created_at, permute/);
    expect(() => parseBookArgs([...ARGV, "--playbook", "orb"])).toThrow(/Unknown flag "--playbook"/);
  });
});
