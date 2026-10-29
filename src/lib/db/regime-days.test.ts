/**
 * `regime_days` against a real in-memory database, with the **shipped**
 * migration replayed rather than a restated schema — a hand-copied
 * `CREATE TABLE` here would drift from the one the engine writes into.
 *
 * The rule this file exists for is the overwrite rule: a settled label is
 * immutable and an `unknown` heals. Nothing else in the repo fails when it is
 * reversed, and the failure is a label a trade was stamped against being
 * quietly rewritten under it.
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

import { getRegimeDay, listRegimeDaysForSession, upsertRegimeDay } from "./regime-days";
import type { RegimeResult } from "@/lib/trading/regime/classify-regime";

const KNOWN: RegimeResult = {
  label: "active.compressed",
  vol: "active",
  range: "compressed",
  classifierVersion: "1",
  features: { vol5: 412.4, vol5Pct: 78, rthRange: 380, rangeRatio: 0.82 },
};

const UNKNOWN: RegimeResult = {
  label: "unknown",
  vol: null,
  range: null,
  classifierVersion: "1",
  features: null,
};

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

describe("regime_days", () => {
  it("round-trips a label with its features and splits the pair back into axes", () => {
    upsertRegimeDay({
      ticker: "MNQ",
      sessionDate: "2026-09-08",
      result: KNOWN,
      source: "nightly",
    });

    expect(getRegimeDay("MNQ", "2026-09-08", "1")).toMatchObject({
      ticker: "MNQ",
      sessionDate: "2026-09-08",
      classifierVersion: "1",
      label: "active.compressed",
      vol: "active",
      range: "compressed",
      features: { vol5: 412.4, vol5Pct: 78, rthRange: 380, rangeRatio: 0.82 },
      source: "nightly",
    });
  });

  it("stores unknown as a label with no features and no axes", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: UNKNOWN, source: "lazy" });

    const row = getRegimeDay("MNQ", "2026-09-08", "1");
    expect(row?.label).toBe("unknown");
    expect(row?.features).toBeNull();
    expect(row?.vol).toBeNull();
    expect(row?.range).toBeNull();
  });

  it("heals an unknown row when a later fill produces a real label", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: UNKNOWN, source: "nightly" });
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: KNOWN, source: "lazy" });

    expect(getRegimeDay("MNQ", "2026-09-08", "1")).toMatchObject({
      label: "active.compressed",
      source: "lazy",
    });
  });

  it("refuses to rewrite a settled label, including back to unknown", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: KNOWN, source: "nightly" });
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: UNKNOWN, source: "lazy" });
    upsertRegimeDay({
      ticker: "MNQ",
      sessionDate: "2026-09-08",
      result: { ...KNOWN, label: "quiet.expanded", vol: "quiet", range: "expanded" },
      source: "lazy",
    });

    expect(getRegimeDay("MNQ", "2026-09-08", "1")).toMatchObject({
      label: "active.compressed",
      source: "nightly",
    });
  });

  it("keeps a second classifier version beside the first rather than over it", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: KNOWN, source: "nightly" });
    upsertRegimeDay({
      ticker: "MNQ",
      sessionDate: "2026-09-08",
      result: { ...KNOWN, label: "quiet.expanded", classifierVersion: "2" },
      source: "nightly",
    });

    expect(getRegimeDay("MNQ", "2026-09-08", "1")?.label).toBe("active.compressed");
    expect(getRegimeDay("MNQ", "2026-09-08", "2")?.label).toBe("quiet.expanded");
  });

  it("lists one session's tickers under one version, ordered", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: KNOWN, source: "nightly" });
    upsertRegimeDay({ ticker: "MES", sessionDate: "2026-09-08", result: UNKNOWN, source: "nightly" });
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-09", result: KNOWN, source: "nightly" });
    upsertRegimeDay({
      ticker: "MGC",
      sessionDate: "2026-09-08",
      result: { ...KNOWN, classifierVersion: "2" },
      source: "nightly",
    });

    expect(listRegimeDaysForSession("2026-09-08", "1").map((d) => d.ticker)).toEqual(["MES", "MNQ"]);
  });

  it("reads a hand-edited feature blob as no features rather than as a partial one", () => {
    upsertRegimeDay({ ticker: "MNQ", sessionDate: "2026-09-08", result: KNOWN, source: "nightly" });
    db.prepare(`UPDATE regime_days SET features_json = ? WHERE ticker = 'MNQ'`).run('{"vol5": 12}');

    expect(getRegimeDay("MNQ", "2026-09-08", "1")?.features).toBeNull();
    expect(getRegimeDay("MNQ", "2026-09-08", "1")?.label).toBe("active.compressed");
  });
});
