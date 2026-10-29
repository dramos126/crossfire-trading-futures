import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

/**
 * The `exit_reason_code` migration and the two writers that keep the code
 * column and the label column in step.
 *
 * The interesting half is the backfill, because the old column meant two
 * different things depending on status: a `pending_exit` row's `exit_reason`
 * *is* the raw submitted code, and a `closed` row's is a rendered label. A
 * backfill that treated them alike would either invent codes from prose or
 * strand every trade that was in flight when the migration ran.
 *
 * Built on the `engine-logs.migration` pattern — `registerMigration` is
 * captured so the real migration function runs against a database this test
 * owns, rather than being reimplemented here.
 */

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: Database.Database) => void>,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

import {
  attachPendingExit,
  getBracketManualClosedTrades,
  listAccountsWithBracketManualClosedTrades,
  setExitReason,
  EXIT_REASON_LABEL_BACKFILL_PAIRS,
} from "./trades";
import {
  EXIT_REASONS,
  exitReasonCodeForLabel,
  exitReasonCodeOf,
  resolveExitReason,
} from "@/lib/logging/exit-reasons";

/** The table as it stood before the code column, with only the columns
 *  these assertions read. The migration's `ALTER TABLE` adds the rest. */
const LEGACY_SCHEMA = `
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
`;

const ACCOUNT = 4469;
const RECENT = new Date(Date.now() - 60_000).toISOString();

function insert(row: {
  id: number;
  status: string;
  exitReason: string | null;
  accountId?: number;
  submittedAt?: string;
}): void {
  db.prepare(`
    INSERT INTO strategy_trades
      (id, deployment_id, strategy_key, account_id, ticker, contract_id, side, size,
       entry_submitted_at, exit_reason, status)
    VALUES (?, 'd1', 'ema', ?, '/MNQ', 'CON.F.US.MNQ.U26', 0, 1, ?, ?, ?)
  `).run(
    row.id,
    row.accountId ?? ACCOUNT,
    row.submittedAt ?? RECENT,
    row.exitReason,
    row.status,
  );
}

function codeOf(id: number): string | null {
  return (
    db.prepare("SELECT exit_reason_code FROM strategy_trades WHERE id = ?").get(id) as
      | { exit_reason_code: string | null }
      | undefined
  )?.exit_reason_code ?? null;
}

function labelOf(id: number): string | null {
  return (
    db.prepare("SELECT exit_reason FROM strategy_trades WHERE id = ?").get(id) as
      | { exit_reason: string | null }
      | undefined
  )?.exit_reason ?? null;
}

function migrate(): void {
  for (const fn of migrations) fn(db);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(LEGACY_SCHEMA);
});

describe("the exit_reason_code migration", () => {
  it("backfills a closed row's code from the label it already rendered", () => {
    insert({ id: 1, status: "closed", exitReason: "Take Profit" });
    insert({ id: 2, status: "closed", exitReason: "Bracket/Manual" });
    insert({ id: 3, status: "closed", exitReason: "Force Close (bracket failure)" });
    migrate();
    expect(codeOf(1)).toBe("take_profit");
    expect(codeOf(2)).toBe("bracket_manual");
    expect(codeOf(3)).toBe("bracket_failure_force_close");
  });

  it("moves a pending_exit row's raw code across verbatim", () => {
    // This row's `exit_reason` is what `attachPendingExit` wrote — a code,
    // not a label. Mapping it through the label table would find nothing and
    // the trade would close onto the residual reason mid-flight.
    insert({ id: 4, status: "pending_exit", exitReason: "deployment_close" });
    insert({ id: 5, status: "pending_exit", exitReason: "strategy_signal:EMA close-through" });
    migrate();
    expect(codeOf(4)).toBe("deployment_close");
    expect(codeOf(5)).toBe("strategy_signal:EMA close-through");
  });

  it("repairs the one label a submission site wrote into the code slot", () => {
    // `/api/deployments/flatten-all` passed the *display label* to
    // `attachPendingExit`, which stores its argument verbatim. Copied across
    // unrepaired, `Flatten All` sits in the code column resolving to the
    // residual reason forever — the relabel sweep looks for the residual
    // *code*, which this row does not carry either.
    insert({ id: 9, status: "pending_exit", exitReason: "Flatten All" });
    migrate();
    expect(codeOf(9)).toBe("flatten_all");
  });

  it("leaves an entry_failed row alone, because that column holds a rejection", () => {
    // `markEntryFailed` stores the broker's rejection text in `exit_reason`.
    // It is not an exit reason and must not become one.
    insert({ id: 6, status: "entry_failed", exitReason: "Invalid stop price" });
    migrate();
    expect(codeOf(6)).toBeNull();
  });

  it("leaves a label the table does not carry unclassified rather than guessing", () => {
    insert({ id: 7, status: "closed", exitReason: "Some Old Wording" });
    migrate();
    expect(codeOf(7)).toBeNull();
  });

  it("is idempotent, and a second run does not overwrite a healed code", () => {
    insert({ id: 8, status: "closed", exitReason: "Bracket/Manual" });
    migrate();
    setExitReason(8, resolveExitReason("take_profit"));
    migrate();
    expect(codeOf(8)).toBe("take_profit");
    expect(labelOf(8)).toBe("Take Profit");
  });
});

describe("the relabel sweep matches the code, not the label", () => {
  beforeEach(() => {
    migrate();
  });

  it("finds a row whose code is the residual reason", () => {
    insert({ id: 10, status: "closed", exitReason: "Bracket/Manual" });
    db.prepare("UPDATE strategy_trades SET exit_reason_code = 'bracket_manual' WHERE id = 10").run();
    expect(getBracketManualClosedTrades(ACCOUNT).map((t) => t.id)).toEqual([10]);
    expect(listAccountsWithBracketManualClosedTrades()).toEqual([ACCOUNT]);
  });

  it("stops finding it the moment the code is healed, label notwithstanding", () => {
    insert({ id: 11, status: "closed", exitReason: "Bracket/Manual" });
    db.prepare("UPDATE strategy_trades SET exit_reason_code = 'take_profit' WHERE id = 11").run();
    expect(getBracketManualClosedTrades(ACCOUNT)).toEqual([]);
    expect(listAccountsWithBracketManualClosedTrades()).toEqual([]);
  });

  it("ignores a row whose label says residual but whose code says otherwise", () => {
    // The point of the column: prose is a rendering and can be reworded
    // without the sweep silently changing what it matches.
    insert({ id: 12, status: "closed", exitReason: "Bracket/Manual" });
    db.prepare("UPDATE strategy_trades SET exit_reason_code = 'deployment_close' WHERE id = 12").run();
    expect(getBracketManualClosedTrades(ACCOUNT)).toEqual([]);
  });
});

describe("the two writers keep the code and its rendering in step", () => {
  beforeEach(() => {
    migrate();
  });

  it("stores the code and its label when an actor submits an exit", () => {
    insert({ id: 20, status: "open", exitReason: null });
    attachPendingExit({
      tradeId: 20,
      exitOrderId: 999,
      exitSubmittedAt: RECENT,
      exitReason: "deployment_close",
    });
    expect(codeOf(20)).toBe("deployment_close");
    // A pending row used to show the raw snake_case code in the UI.
    expect(labelOf(20)).toBe("Deployment Close");
  });

  it("stores the detail in both columns — the code keeps its `:detail` suffix, the label renders it", () => {
    // The two writers do not agree on the code column's shape and the name
    // used to claim otherwise. `attachPendingExit` stores its argument
    // verbatim, so a `code:detail` reason lands whole; `setExitReason` writes
    // `ResolvedExitReason.code`, which is bare. Every consumer therefore has
    // to go through `exitReasonCodeOf` rather than comparing the column.
    insert({ id: 21, status: "open", exitReason: null });
    attachPendingExit({
      tradeId: 21,
      exitOrderId: 998,
      exitSubmittedAt: RECENT,
      exitReason: "strategy_signal:EMA close-through",
    });
    expect(codeOf(21)).toBe("strategy_signal:EMA close-through");
    expect(exitReasonCodeOf(codeOf(21))).toBe("strategy_signal");
    expect(labelOf(21)).toBe("Strategy Exit · EMA close-through");
  });

  it("writes both columns from one resolution at close time", () => {
    insert({ id: 22, status: "pending_exit", exitReason: null });
    setExitReason(22, resolveExitReason("engine_downtime"));
    expect(codeOf(22)).toBe("engine_downtime");
    expect(labelOf(22)).toBe("Engine Downtime");
  });
});

/**
 * The backfill list is frozen at authorship rather than derived from
 * `EXIT_REASONS`, because a migration matches labels that *were written* and
 * the table renders labels that *are written now*. Deriving it meant a
 * reword silently changed what an un-migrated database backfilled and
 * stranded every row carrying the old wording at `exit_reason_code IS NULL`,
 * with nothing to heal it.
 *
 * Freezing moves the failure rather than removing it: the list can now go
 * stale against the table without anything noticing. These are what notice.
 */
describe("the frozen backfill list against the live exit-reason table", () => {
  it("every frozen pair still resolves through the live label index", () => {
    // A reword fails here, deliberately and by name. The fix is never to
    // edit the frozen pair — old rows still carry the old spelling — it is
    // to add the new pair beside it.
    for (const { label, code } of EXIT_REASON_LABEL_BACKFILL_PAIRS) {
      expect(exitReasonCodeForLabel(label), label).toBe(code);
    }
  });

  it("covers the label of every code the table carries", () => {
    // The other direction: a code added to the table without a pair here is
    // one whose rows a future migration cannot classify.
    const frozenLabels = new Set(EXIT_REASON_LABEL_BACKFILL_PAIRS.map((p) => p.label));
    for (const [code, spec] of Object.entries(EXIT_REASONS)) {
      expect(frozenLabels.has(spec.label), `${code} → ${spec.label}`).toBe(true);
    }
  });

  it("carries one pair per label, so no scan is spent on a row the previous one took", () => {
    const labels = EXIT_REASON_LABEL_BACKFILL_PAIRS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("skips both arms entirely once no row is left to backfill", () => {
    // The probe in front of the sixteen full-table UPDATEs. Every migration
    // block re-runs on every boot, so the steady state has to be one query.
    insert({ id: 30, status: "closed", exitReason: "Take Profit" });
    migrate();
    expect(codeOf(30)).toBe("take_profit");

    let updates = 0;
    const original = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/^\s*UPDATE\s+strategy_trades/i.test(sql)) updates += 1;
      return original(sql);
    }) as typeof db.prepare;
    migrate();
    db.prepare = original;

    expect(updates).toBe(0);
  });
});
