import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The `engine_logs` migration against a populated database, run twice.
 *
 * Built here rather than pointed at `data/trading.db`: the shipped file is
 * the operator's, and a migration test that opens it writes to it. The
 * populated fixture is created, copied, and the *copy* is migrated —
 * which is the shape the real thing has, a schema change arriving at rows
 * that were already there.
 */

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: Database.Database) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("this test opens its own handle");
  }),
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

/** The schema exactly as it stood before the envelope columns. */
const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS engine_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engine_logs_level_ts ON engine_logs(level, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_engine_logs_ts ON engine_logs(timestamp);
`;

const LEGACY_ROWS = [
  ["2026-08-01T12:00:00.000Z", "engine", "info", "Trading engine started (realtime bars)"],
  ["2026-08-01T12:00:01.000Z", "758d19dd-f18d-42b0-a15b-9b6dffd896d5", "trade", "Entry filled"],
  ["2026-08-01T12:00:02.000Z", "758d19dd-f18d-42b0-a15b-9b6dffd896d5", "trade-skip", "skip: gate"],
  ["2026-08-01T12:00:03.000Z", "engine", "heartbeat", "[heartbeat] 1 deployment"],
  ["2026-08-01T12:00:04.000Z", "engine", "connection", "Market hub connected"],
  ["2026-08-01T12:00:05.000Z", "engine", "warn", "hub degraded"],
  ["2026-08-01T12:00:06.000Z", "engine", "error", "boot: refusing to start"],
];

const ENVELOPE_COLUMN_NAMES = [
  "severity",
  "category",
  "event",
  "display",
  "account_id",
  "contract_id",
  "ticker",
  "trade_id",
  // The Activity template's value slots. `slot_values` rather than
  // `values`, which SQLite reserves — `ADD COLUMN values TEXT` is a syntax
  // error, and a migration that throws on a populated database is the one
  // failure this file exists to catch.
  "slot_values",
  "burst_key",
  "burst_count",
  "last_seen_at",
];

/**
 * The envelope as it stood *before* the value slots and the rendered ticker
 * — the shape every database this migration will actually meet is in, since
 * the ten below shipped and have been written to for a phase. Running the
 * current migration against this is the real arrival, and it is a different
 * test from running it against the legacy five-column table.
 */
const PRIOR_ENVELOPE_COLUMNS = ENVELOPE_COLUMN_NAMES.filter(
  (c) => c !== "slot_values" && c !== "ticker",
);

let dir: string;
let populatedPath: string;
let copyPath: string;
let db: Database.Database | null = null;

function columnNames(handle: Database.Database): string[] {
  return (handle.prepare(`PRAGMA table_info(engine_logs)`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function indexNames(handle: Database.Database): string[] {
  return (
    handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='engine_logs'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function runMigrations(handle: Database.Database): void {
  for (const fn of migrations) fn(handle);
}

beforeEach(async () => {
  migrations.length = 0;
  vi.resetModules();
  await import("./engine-logs");

  dir = mkdtempSync(join(tmpdir(), "engine-logs-migration-"));
  populatedPath = join(dir, "populated.db");
  copyPath = join(dir, "copy.db");

  const seed = new Database(populatedPath);
  seed.pragma("journal_mode = DELETE");
  seed.exec(LEGACY_SCHEMA);
  const insert = seed.prepare(
    `INSERT INTO engine_logs (timestamp, deployment_id, level, message) VALUES (?, ?, ?, ?)`,
  );
  for (const row of LEGACY_ROWS) insert.run(...row);
  seed.close();

  copyFileSync(populatedPath, copyPath);
  db = new Database(copyPath);
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("the engine_logs envelope migration", () => {
  it("registers exactly one migration", () => {
    expect(migrations.length).toBe(1);
  });

  it("adds every envelope column to a populated legacy table", () => {
    runMigrations(db!);
    const cols = columnNames(db!);
    for (const name of ENVELOPE_COLUMN_NAMES) expect(cols, name).toContain(name);
  });

  it("keeps level and every legacy column, because /logs still reads them", () => {
    runMigrations(db!);
    const cols = columnNames(db!);
    for (const name of ["id", "timestamp", "deployment_id", "level", "message"]) {
      expect(cols, name).toContain(name);
    }
  });

  it("adds the two new indexes and keeps the two that existed", () => {
    runMigrations(db!);
    const idx = indexNames(db!);
    expect(idx).toContain("idx_engine_logs_severity_ts");
    expect(idx).toContain("idx_engine_logs_trade");
    expect(idx).toContain("idx_engine_logs_level_ts");
    expect(idx).toContain("idx_engine_logs_ts");
  });

  it("leaves every existing row readable with its level intact", () => {
    runMigrations(db!);
    const rows = db!
      .prepare(`SELECT timestamp, deployment_id, level, message FROM engine_logs ORDER BY id`)
      .all() as Array<{ timestamp: string; deployment_id: string; level: string; message: string }>;
    expect(rows.length).toBe(LEGACY_ROWS.length);
    expect(rows.map((r) => r.level)).toEqual(LEGACY_ROWS.map((r) => r[2]));
    expect(rows[1].message).toBe("Entry filled");
  });

  it("leaves the new columns NULL on a legacy row rather than manufacturing a value", () => {
    runMigrations(db!);
    const row = db!.prepare(`SELECT * FROM engine_logs ORDER BY id LIMIT 1`).get() as Record<
      string,
      unknown
    >;
    for (const name of ENVELOPE_COLUMN_NAMES) expect(row[name], name).toBeNull();
  });

  it("is idempotent — a second pass on the same file changes nothing and does not throw", () => {
    runMigrations(db!);
    const colsAfterFirst = columnNames(db!);
    const idxAfterFirst = indexNames(db!).sort();
    const rowsAfterFirst = db!.prepare(`SELECT * FROM engine_logs ORDER BY id`).all();

    expect(() => runMigrations(db!)).not.toThrow();

    expect(columnNames(db!)).toEqual(colsAfterFirst);
    expect(indexNames(db!).sort()).toEqual(idxAfterFirst);
    expect(db!.prepare(`SELECT * FROM engine_logs ORDER BY id`).all()).toEqual(rowsAfterFirst);
  });

  it("adds the value-slot and ticker columns to a database carrying the earlier envelope", () => {
    // The shape a shipped install is in: the ten prior columns present and
    // populated, `slot_values` absent. Built by hand rather than by running
    // the migration first, so the assertion is about *arriving* at rows
    // written by the previous version rather than about running twice.
    const priorPath = join(dir, "prior.db");
    const prior = new Database(priorPath);
    try {
      prior.exec(LEGACY_SCHEMA);
      for (const name of PRIOR_ENVELOPE_COLUMNS) {
        const type = name.endsWith("_id") || name === "burst_count" ? "INTEGER" : "TEXT";
        prior.exec(`ALTER TABLE engine_logs ADD COLUMN ${name} ${type}`);
      }
      prior
        .prepare(
          `INSERT INTO engine_logs (timestamp, deployment_id, level, message, severity, category, event)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "2026-08-27T09:31:13.000Z",
          "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
          "trade",
          "Trade #4471 entry confirmed via user hub @ 29246.25",
          "info",
          "trade",
          "entry_filled",
        );

      expect(() => runMigrations(prior)).not.toThrow();
      expect(columnNames(prior)).toContain("slot_values");
      expect(columnNames(prior)).toContain("ticker");

      const row = prior.prepare(`SELECT * FROM engine_logs ORDER BY id`).get() as Record<
        string,
        unknown
      >;
      expect(row.slot_values).toBeNull();
      expect(row.ticker).toBeNull();
      expect(row.message).toBe("Trade #4471 entry confirmed via user hub @ 29246.25");
      expect(row.event).toBe("entry_filled");
    } finally {
      prior.close();
    }
  });

  it("runs on a fresh database with no table at all", () => {
    const freshPath = join(dir, "fresh.db");
    const fresh = new Database(freshPath);
    try {
      expect(() => runMigrations(fresh)).not.toThrow();
      const cols = columnNames(fresh);
      for (const name of ENVELOPE_COLUMN_NAMES) expect(cols, name).toContain(name);
      expect(cols).toContain("level");
    } finally {
      fresh.close();
    }
  });

  it("accepts an envelope row and reads it back", () => {
    runMigrations(db!);
    db!
      .prepare(
        `INSERT INTO engine_logs
           (timestamp, deployment_id, level, message, severity, category, event, display,
            account_id, contract_id, ticker, trade_id, slot_values, burst_key, burst_count, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "2026-08-01T12:00:07.000Z",
        "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
        "trade",
        "Bought 1 MNQ",
        "info",
        "trade",
        "entry_filled",
        "…4469-ema-x.MNQ",
        11444469,
        "CON.F.US.MNQ.Z25",
        "MNQ",
        4210,
        JSON.stringify({ size: 1, price: "29246.25", sl: "29196.25", tp: "29346.25" }),
        "entry_filled|758d19dd",
        1,
        "2026-08-01T12:00:07.000Z",
      );
    const row = db!
      .prepare(`SELECT * FROM engine_logs WHERE event = 'entry_filled'`)
      .get() as Record<string, unknown>;
    expect(row.severity).toBe("info");
    expect(row.category).toBe("trade");
    expect(row.trade_id).toBe(4210);
    expect(row.account_id).toBe(11444469);
    expect(row.ticker).toBe("MNQ");
    expect(row.level).toBe("trade");
    expect(JSON.parse(String(row.slot_values))).toEqual({
      size: 1,
      price: "29246.25",
      sl: "29196.25",
      tp: "29346.25",
    });
  });
});
