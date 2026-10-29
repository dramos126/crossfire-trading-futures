import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

/**
 * The L0 acceptance criteria, one named test each, asserted end to end
 * through the real store rather than against a stub of it.
 *
 * These are the gate the phase was allowed to build against
 * (docs/proposals/logging-rework.md, "L0 acceptance criteria"). They are
 * here rather than spread across the unit files so that removing one is
 * visible as removing a criterion.
 */

const { migrations, handle, env } = vi.hoisted(() => ({
  migrations: [] as Array<(d: Database.Database) => void>,
  handle: { db: null as Database.Database | null },
  env: { isStagingEnv: vi.fn(() => false) },
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    if (!handle.db) throw new Error("no database open");
    return handle.db;
  }),
  isClosedForShutdown: () => false,
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/env", () => ({
  isStagingEnv: env.isStagingEnv,
  isProductionEnv: () => !env.isStagingEnv(),
}));

import {
  EVENTS,
  LEGACY_LEVEL_LADDER,
  SUBJECT_LESS_TEMPLATES,
  type LegacyLevel,
  type LogCategory,
  type Severity,
} from "./vocabulary";

/** The canonical jwt.io sample token — a real JWT by structure, and not a
 *  credential of this install. */
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const MANAGED_ACCOUNT = 11444469;

const ALL_LEGACY_LEVELS: LegacyLevel[] = [
  "info",
  "warn",
  "error",
  "trade",
  "connection",
  "heartbeat",
  "trade-skip",
];

const ALL_CATEGORIES: LogCategory[] = [
  "trade",
  "order",
  "connection",
  "lifecycle",
  "safety",
  "broker",
  "system",
  "heartbeat",
];

const ALL_SEVERITIES: Severity[] = ["debug", "info", "warn", "error"];

let pipe: typeof import("./pipe");
let store: typeof import("@/lib/db/engine-logs");
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function consoleOutput(): string {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((c) => c.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

function persistedRows(): Array<Record<string, unknown>> {
  return handle.db!.prepare(`SELECT * FROM engine_logs ORDER BY id`).all() as Array<
    Record<string, unknown>
  >;
}

beforeEach(async () => {
  migrations.length = 0;
  vi.resetModules();
  env.isStagingEnv.mockReturnValue(false);
  handle.db = new Database(":memory:");

  pipe = await import("./pipe");
  // The real store, wired the way production wires it: importing it
  // installs the pipe's sink.
  store = await import("@/lib/db/engine-logs");
  // The real managed-account catalog, seeded through its own module — so
  // this exercises the production wiring rather than a hand-set source.
  const accounts = await import("@/lib/db/account-brokers");
  for (const fn of migrations) fn(handle.db);
  accounts.setAccountBroker({
    accountId: MANAGED_ACCOUNT,
    broker: accounts.BrokerKind.Topstep,
    name: "PRACTICEJUL2610144469",
    practice: true,
  });

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  store._stopEngineLogStoreForTest();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  handle.db?.close();
  handle.db = null;
  vi.unstubAllEnvs();
});

describe("L0 criterion 1 — every Activity template passes the phone test", () => {
  const activity = Object.entries(EVENTS).filter(([, s]) => s.template !== null);

  // An engine-scoped event may carry a subject-less template when its
  // sentence is complete without one. The list is `SUBJECT_LESS_TEMPLATES`,
  // beside the table; `vocabulary.test.ts` holds the equality pin that keeps
  // adding one deliberate. Forcing a slot onto a line that can never fill it
  // is what this criterion used to do.
  it("gives every Activity-eligible event a subject discriminator or names it as an exception", () => {
    for (const [name, spec] of activity) {
      if (SUBJECT_LESS_TEMPLATES.includes(name)) continue;
      expect(spec.template, name).toMatch(/\{(display|ticker)\}/);
    }
  });

  it("keeps internal shorthand out of every Activity template", () => {
    // The operator's literal complaint: "3 months down the line I won't
    // have any idea what D-2 or A-## means."
    for (const [name, spec] of activity) {
      expect(spec.template, name).not.toMatch(/\b[A-Z]{1,2}-\d+\b/);
    }
  });

  it("keeps event-name shorthand out of Activity prose", () => {
    for (const [name, spec] of activity) {
      const prose = spec.template!.replace(/\{[^}]*\}/g, "");
      expect(prose, name).not.toMatch(/\b[a-z]+(_[a-z0-9]+)+\b/);
    }
  });
});

describe("L0 criterion 2 — an `error` names a condition the emitting code checked", () => {
  // The per-site audit is L2's; what L1 can hold is that the pipe cannot
  // launder a severity, so `error` on the wire always means a call site
  // claimed it.
  it("never upgrades a severity the caller supplied", () => {
    pipe.emit({ event: null, severity: "info", category: "safety", deploymentId: "d1", message: "a" });
    pipe.emit({ event: null, severity: "warn", category: "safety", deploymentId: "d1", message: "b" });
    store.flush();
    expect(persistedRows().map((r) => r.severity)).toEqual(["info", "warn"]);
  });

  it("routes only the legacy `error` level to severity error", () => {
    const toError = ALL_LEGACY_LEVELS.filter((l) => LEGACY_LEVEL_LADDER[l].severity === "error");
    expect(toError).toEqual(["error"]);
  });

  it("takes an error event's severity from the vocabulary, not from the caller's optimism", () => {
    const record = pipe.emit({
      event: "bracket_place_failed",
      deploymentId: "d1",
      message: "stop rejected",
    });
    expect(record!.severity).toBe("error");
  });
});

describe("L0 criterion 3 — no rendered message carries a secret", () => {
  it("scrubs an account number and a token out of the row, the ring entry and the console", () => {
    const raw = `flatten ${MANAGED_ACCOUNT} rejected — Authorization: Bearer ${SAMPLE_JWT}`;

    // `TradingEngine.log()` calls exactly this and pushes the record it
    // returns at `onLog`, which is what the ring holds — so `record` here
    // *is* the ring entry.
    const record = pipe.emit({
      event: null,
      severity: "error",
      category: "system",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      message: raw,
    });
    store.flush();

    const row = persistedRows()[0];
    const console_ = consoleOutput();

    for (const [surface, text] of [
      ["persisted row", String(row.message)],
      ["ring entry", record!.message],
      ["console", console_],
    ] as const) {
      expect(text, surface).not.toContain(String(MANAGED_ACCOUNT));
      expect(text, surface).not.toContain(SAMPLE_JWT);
      expect(text, surface).not.toContain("dBjftJeZ4CVP");
    }

    expect(record!.message).toContain("…4469");
    expect(String(row.message)).toBe(record!.message);
    expect(console_).toContain(record!.message);
  });

  /**
   * The criterion, extended to the slot values — the field that made the
   * Activity lane's five best sentences renderable, and the one that could
   * put a number the operator owns into a durable column if nothing
   * scrubbed it.
   *
   * Four surfaces, because they are four different failure modes: the row
   * (what gets backed up), the ring entry (what `/logs` polls), the wire
   * (what reaches a browser) and the Activity sentence (what a reader
   * actually sees). The sentence is the one no other test covers — a value
   * is *composed into prose* there, so a leak arrives already dressed as an
   * English sentence rather than as a field a reviewer would spot.
   */
  it("scrubs an account number that reached a slot value, through row, ring, wire and sentence", async () => {
    const { projectLogRecord } = pipe;
    const { renderSentence } = await import("@/components/log-activity");

    const record = pipe.emit({
      event: "exit_filled",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      display: `${MANAGED_ACCOUNT}-ema-crossover.MNQ`,
      message: `Trade #4471 closed on account ${MANAGED_ACCOUNT}`,
      accountId: MANAGED_ACCOUNT,
      values: { pnl: "+$32.25", reason: `closed on account ${MANAGED_ACCOUNT}` },
    })!;
    store.flush();

    const wire = projectLogRecord(record, 0);
    const sentence = renderSentence(wire);

    for (const [surface, text] of [
      ["persisted row", String(persistedRows()[0].slot_values)],
      ["ring entry", JSON.stringify(record.values)],
      ["wire", JSON.stringify(wire)],
      ["activity sentence", sentence.text],
    ] as const) {
      expect(text, surface).not.toContain(String(MANAGED_ACCOUNT));
    }
    // And the sentence is the whole sentence — a scrub that ate the value
    // would show up here as a fallback to the diagnostics prose.
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe("Closed MNQ +$32.25 — closed on account …4469");
  });

  it("keeps the full account id in the structural column, where it is never rendered", () => {
    pipe.emit({
      event: "session_end_flatten",
      deploymentId: "d1",
      accountId: MANAGED_ACCOUNT,
      message: `closed the position on ${MANAGED_ACCOUNT}`,
    });
    store.flush();
    const row = persistedRows()[0];
    expect(row.account_id).toBe(MANAGED_ACCOUNT);
    expect(String(row.message)).not.toContain(String(MANAGED_ACCOUNT));
  });

  it("scrubs the same way in production, where the opt-out is ignored", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_REDACT", "off");
    pipe.emit({
      event: null,
      severity: "warn",
      category: "system",
      deploymentId: "d1",
      message: `token ${SAMPLE_JWT} for ${MANAGED_ACCOUNT}`,
    });
    store.flush();
    const message = String(persistedRows()[0].message);
    expect(message).not.toContain(SAMPLE_JWT);
    expect(message).not.toContain(String(MANAGED_ACCOUNT));
  });
});

/**
 * Emit a line that has to land on `level`, the way a migrated call site
 * does it: the ladder's pair, and the event for the one chip the pair
 * cannot express. Shim A used to carry the chip verbatim; this is what
 * replaced it, so this helper *is* criterion 4's subject.
 */
function emitAtLegacyLevel(level: LegacyLevel, message: string): void {
  const { severity, category } = LEGACY_LEVEL_LADDER[level];
  if (level === "trade-skip") {
    pipe.emit({ event: "entry_skipped", deploymentId: "d1", message });
    return;
  }
  pipe.emit({ event: null, severity, category, deploymentId: "d1", message });
}

describe("L0 criterion 4 — the seven-chip enum survives the model intact", () => {
  it("expresses every legacy level as a declared severity and category", () => {
    for (const level of ALL_LEGACY_LEVELS) {
      const ladder = LEGACY_LEVEL_LADDER[level];
      expect(ALL_SEVERITIES, level).toContain(ladder.severity);
      expect(ALL_CATEGORIES, level).toContain(ladder.category);
    }
  });

  it("round-trips all seven through emit, the row and the hydrated ring", () => {
    for (const level of ALL_LEGACY_LEVELS) emitAtLegacyLevel(level, `line at ${level}`);
    store.flush();

    expect(persistedRows().map((r) => r.level)).toEqual(ALL_LEGACY_LEVELS);

    const { main, heartbeat } = store.hydrateRings();
    expect([...main, ...heartbeat].map((e) => e.level).sort()).toEqual(
      [...ALL_LEGACY_LEVELS].sort(),
    );
  });

  it("keeps trade and trade-skip apart, which the pair alone cannot", () => {
    emitAtLegacyLevel("trade", "entry filled");
    emitAtLegacyLevel("trade-skip", "skip: gate");
    store.flush();
    const rows = persistedRows();
    expect(rows.map((r) => r.level)).toEqual(["trade", "trade-skip"]);
    expect(rows.map((r) => `${r.severity}/${r.category}`)).toEqual(["info/trade", "info/trade"]);
  });

  it("writes `level` on every row, so /logs renders exactly what it did before", () => {
    emitAtLegacyLevel("info", "a");
    pipe.emit({ event: "hub_reconnected", deploymentId: "d1", message: "b" });
    pipe.consoleLog("warn", "tradovate.realtime", "c");
    store.flush();
    for (const row of persistedRows()) {
      expect(row.level, String(row.message)).toBeTruthy();
      expect(ALL_LEGACY_LEVELS, String(row.message)).toContain(row.level as LegacyLevel);
    }
  });
});

describe("burst collapse — the boot the rework was written for", () => {
  it("lands 23 identical warnings as one row carrying a count of 23", () => {
    const line = "account 11444469: fill orderId=8811001 not in tradovate_order_map — dropping";
    for (let i = 0; i < 23; i++) pipe.consoleLog("warn", "tradovate.realtime", line);
    store.flush();

    const rows = persistedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].burst_count).toBe(23);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
