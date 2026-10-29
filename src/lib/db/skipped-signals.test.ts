/**
 * `skipped_signals` against a real in-memory database, with the **shipped**
 * migration replayed rather than a restated schema — a hand-copied
 * `CREATE TABLE` here would drift from the one the engine writes into and the
 * drift is exactly what a column test cannot see.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

import { insertSkippedSignal, listSkippedSignals } from "./skipped-signals";
import { riskBudgetSkip, strategySkip } from "@/lib/trading/skipped-signal";

const LEG = {
  deploymentId: "dep-1",
  groupId: "grp-1",
  accountId: 4242,
  strategyKey: "orb",
  ticker: "MNQ",
};

/** 09:45 ET on 2025-06-04, i.e. inside that session date's cash open. */
const BAR = {
  timestamp: "2025-06-04T13:45:00.000Z",
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: 10,
};

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

describe("skipped_signals", () => {
  it("round-trips a strategy skip with its gate, prose and detail", () => {
    insertSkippedSignal(
      LEG,
      strategySkip(
        { skip: "long break below session VWAP", gate: "vwap", detail: { vwap: 100.75 } },
        BAR,
      ),
    );

    const [row] = listSkippedSignals({
      fromSessionDate: "2025-06-04",
      toSessionDate: "2025-06-04",
    });
    expect(row).toMatchObject({
      deploymentId: "dep-1",
      groupId: "grp-1",
      accountId: 4242,
      strategyKey: "orb",
      ticker: "MNQ",
      signalBarTs: BAR.timestamp,
      sessionDate: "2025-06-04",
      source: "strategy",
      gate: "vwap",
      reason: "long break below session VWAP",
    });
    expect(row.detail).toEqual({ vwap: 100.75 });
  });

  it("stores the platform's budget refusal under the gate the backtest counts", () => {
    insertSkippedSignal(
      LEG,
      riskBudgetSkip(BAR, {
        slTicks: 40,
        riskPerContractUsd: 81.48,
        maxRiskPerTradeUsd: 75,
      }),
    );

    const [row] = listSkippedSignals({
      fromSessionDate: "2025-06-04",
      toSessionDate: "2025-06-04",
    });
    expect(row.source).toBe("platform");
    expect(row.gate).toBe("risk_budget");
    expect(row.detail).toEqual({
      slTicks: 40,
      riskPerContractUsd: 81.48,
      maxRiskPerTradeUsd: 75,
    });
  });

  it("buckets a bar after 18:00 ET onto the next session date", () => {
    // 18:05 ET on 2025-06-04 is the Globex open of session date 2025-06-05.
    insertSkippedSignal(LEG, strategySkip({ skip: "s", gate: "g" }, {
      ...BAR,
      timestamp: "2025-06-04T22:05:00.000Z",
    }));

    expect(
      listSkippedSignals({ fromSessionDate: "2025-06-04", toSessionDate: "2025-06-04" }),
    ).toEqual([]);
    expect(
      listSkippedSignals({ fromSessionDate: "2025-06-05", toSessionDate: "2025-06-05" }),
    ).toHaveLength(1);
  });

  it("narrows to one leg when a deployment is named, and to none when it matches nothing", () => {
    insertSkippedSignal(LEG, strategySkip({ skip: "a", gate: "vwap" }, BAR));
    insertSkippedSignal(
      { ...LEG, deploymentId: "dep-2" },
      strategySkip({ skip: "b", gate: "vwap" }, BAR),
    );

    const range = { fromSessionDate: "2025-06-04", toSessionDate: "2025-06-04" };
    expect(listSkippedSignals(range)).toHaveLength(2);
    expect(listSkippedSignals({ ...range, deploymentId: "dep-2" }).map((r) => r.reason)).toEqual([
      "b",
    ]);
    expect(listSkippedSignals({ ...range, deploymentId: "dep-9" })).toEqual([]);
  });

  it("reads an unparseable detail blob as no detail rather than throwing", () => {
    insertSkippedSignal(LEG, strategySkip({ skip: "s", gate: "g" }, BAR));
    db.prepare(`UPDATE skipped_signals SET detail = ?`).run("{not json");

    expect(
      listSkippedSignals({ fromSessionDate: "2025-06-04", toSessionDate: "2025-06-04" })[0].detail,
    ).toBeNull();
  });

  it("drops a detail value that is not a scalar rather than typing it as one", () => {
    insertSkippedSignal(LEG, strategySkip({ skip: "s", gate: "g" }, BAR));
    db.prepare(`UPDATE skipped_signals SET detail = ?`).run(
      JSON.stringify({ vwap: 100.75, nested: { a: 1 }, list: [1, 2] }),
    );

    expect(
      listSkippedSignals({ fromSessionDate: "2025-06-04", toSessionDate: "2025-06-04" })[0].detail,
    ).toEqual({ vwap: 100.75 });
  });

  it("writes one row per (leg, signal bar, gate), so a restart cannot double it", () => {
    // `DeploymentState.lastBarTimestamp` is memory: a restart mid-session
    // re-evaluates the bar it went down on and the same gate refuses again.
    const skip = { skip: "long break below session VWAP", gate: "vwap" };
    insertSkippedSignal(LEG, strategySkip(skip, BAR));
    insertSkippedSignal(LEG, strategySkip(skip, BAR));

    const range = { fromSessionDate: "2025-06-04", toSessionDate: "2025-06-04" };
    expect(listSkippedSignals(range)).toHaveLength(1);

    // A different gate on the same bar is a different fact, and a second leg
    // on the same bar is a different leg.
    insertSkippedSignal(LEG, strategySkip({ skip: "b", gate: "atr" }, BAR));
    insertSkippedSignal({ ...LEG, deploymentId: "dep-2" }, strategySkip(skip, BAR));
    expect(listSkippedSignals(range)).toHaveLength(3);
  });

  it("folds pre-index duplicates instead of failing the boot that adds the index", () => {
    // The table shipped before the unique index, so a build between the two
    // could have written a duplicate pair — and `CREATE UNIQUE INDEX` throws
    // on one, which inside a migration is a boot failure.
    const fresh = new Database(":memory:");
    fresh.exec(`
      CREATE TABLE skipped_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
        signal_bar_ts TEXT NOT NULL, session_date TEXT NOT NULL,
        deployment_id TEXT NOT NULL, group_id TEXT NOT NULL, account_id INTEGER NOT NULL,
        strategy_key TEXT NOT NULL, ticker TEXT NOT NULL, source TEXT NOT NULL,
        gate TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT
      );
      INSERT INTO skipped_signals
        (recorded_at, signal_bar_ts, session_date, deployment_id, group_id, account_id,
         strategy_key, ticker, source, gate, reason, detail)
      VALUES ('t', 'b', '2025-06-04', 'dep-1', 'grp-1', 1, 'orb', 'MNQ', 'strategy', 'vwap', 'first', NULL),
             ('t', 'b', '2025-06-04', 'dep-1', 'grp-1', 1, 'orb', 'MNQ', 'strategy', 'vwap', 'second', NULL);
    `);

    expect(() => {
      for (const fn of migrations) fn(fresh);
    }).not.toThrow();

    const rows = fresh.prepare(`SELECT reason FROM skipped_signals`).all() as Array<{
      reason: string;
    }>;
    expect(rows.map((r) => r.reason)).toEqual(["first"]);
  });

  it("orders by signal bar, oldest first, across session days", () => {
    insertSkippedSignal(LEG, strategySkip({ skip: "later", gate: "g" }, {
      ...BAR,
      timestamp: "2025-06-05T13:45:00.000Z",
    }));
    insertSkippedSignal(LEG, strategySkip({ skip: "earlier", gate: "g" }, BAR));

    expect(
      listSkippedSignals({ fromSessionDate: "2025-06-04", toSessionDate: "2025-06-05" }).map(
        (r) => r.reason,
      ),
    ).toEqual(["earlier", "later"]);
  });
});
