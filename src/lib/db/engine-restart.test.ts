/**
 * Durable restart state — D-13's two signals and D-14's flap counter.
 *
 * Real in-memory better-sqlite3, the pattern `db/auth.test.ts` established, so
 * the transaction and upsert semantics under test are the shipped ones. The
 * migration is captured from the mocked `registerMigration` and replayed
 * rather than restated, or the schema here drifts from the schema that ships.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
  registerPreCloseHook: vi.fn(),
}));

import {
  consumeCleanShutdownMarker,
  consumeHeartbeatDegradedMarker,
  markCleanShutdown,
  markHeartbeatDegraded,
  readEngineRestartState,
  recordUncleanResume,
  setPendingFlatten,
  stampEngineHeartbeat,
} from "./engine-restart";

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

describe("engine restart state", () => {
  it("reads as empty before anything has been written", () => {
    expect(readEngineRestartState()).toEqual({
      lastSeenAt: null,
      cleanShutdownAt: null,
      resumeCycles: [],
      pendingFlatten: { entries: [], gapMs: 0 },
    });
  });

  it("stamps the heartbeat and overwrites it in place rather than appending", () => {
    stampEngineHeartbeat(1_000);
    stampEngineHeartbeat(16_000);
    expect(readEngineRestartState().lastSeenAt).toBe(16_000);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM engine_restart`).get()).toEqual({ n: 1 });
  });

  it("keeps the heartbeat and the marker independent", () => {
    stampEngineHeartbeat(1_000);
    markCleanShutdown(2_000);
    expect(readEngineRestartState()).toMatchObject({ lastSeenAt: 1_000, cleanShutdownAt: 2_000 });
    stampEngineHeartbeat(3_000);
    expect(readEngineRestartState().cleanShutdownAt).toBe(2_000);
  });

  it("consumes the marker so a second read cannot see it", () => {
    markCleanShutdown(2_000);
    expect(consumeCleanShutdownMarker()).toBe(2_000);
    // Without the clear, one clean shutdown would make every later crash read
    // as intentional.
    expect(consumeCleanShutdownMarker()).toBeNull();
    expect(readEngineRestartState().cleanShutdownAt).toBeNull();
  });

  it("consuming a marker that was never written is a no-op, not a row", () => {
    expect(consumeCleanShutdownMarker()).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM engine_restart`).get()).toEqual({ n: 0 });
  });

  it("consuming the marker leaves the heartbeat alone", () => {
    stampEngineHeartbeat(1_000);
    markCleanShutdown(2_000);
    consumeCleanShutdownMarker();
    expect(readEngineRestartState().lastSeenAt).toBe(1_000);
  });
});

describe("flap counter", () => {
  const WINDOW = 15 * 60_000;

  it("counts cycles inside the window", () => {
    expect(recordUncleanResume(0, WINDOW)).toBe(1);
    expect(recordUncleanResume(60_000, WINDOW)).toBe(2);
    expect(recordUncleanResume(120_000, WINDOW)).toBe(3);
  });

  it("prunes cycles that fell out of the window, so a stable run decays to zero", () => {
    recordUncleanResume(0, WINDOW);
    recordUncleanResume(60_000, WINDOW);
    expect(recordUncleanResume(WINDOW + 120_000, WINDOW)).toBe(1);
    expect(readEngineRestartState().resumeCycles).toEqual([WINDOW + 120_000]);
  });

  it("survives the process it counts", () => {
    recordUncleanResume(0, WINDOW);
    recordUncleanResume(60_000, WINDOW);
    // A fresh read is what the next boot does; an in-memory tally would be
    // reset by the very event it exists to count.
    expect(readEngineRestartState().resumeCycles).toEqual([0, 60_000]);
  });

  it("reads an unparseable counter as empty rather than throwing", () => {
    db.prepare(
      `INSERT INTO engine_restart (id, resume_cycles) VALUES (1, 'not json')`,
    ).run();
    expect(readEngineRestartState().resumeCycles).toEqual([]);
    expect(recordUncleanResume(5_000, WINDOW)).toBe(1);
  });

  it("drops non-numeric entries rather than letting them reach the comparison", () => {
    db.prepare(
      `INSERT INTO engine_restart (id, resume_cycles) VALUES (1, '[1000,"x",null]')`,
    ).run();
    expect(readEngineRestartState().resumeCycles).toEqual([1000]);
  });
});

describe("epoch columns are validated, not trusted", () => {
  // `NaN > threshold` is false, so the arithmetic already fails toward not
  // flattening — but the value reaches an operator-facing Discord embed on the
  // way, and `Unmanaged for: NaN s` is the field an incident is read from.
  it("reads a non-numeric heartbeat as absent rather than as NaN", () => {
    db.prepare(`INSERT INTO engine_restart (id, last_seen_at) VALUES (1, 'yesterday')`).run();
    expect(readEngineRestartState().lastSeenAt).toBeNull();
  });

  it("reads a non-numeric shutdown marker as absent", () => {
    db.prepare(`INSERT INTO engine_restart (id, clean_shutdown_at) VALUES (1, 'nope')`).run();
    expect(readEngineRestartState().cleanShutdownAt).toBeNull();
  });

  it("still clears a garbage marker on consume, so it cannot be re-read forever", () => {
    db.prepare(`INSERT INTO engine_restart (id, clean_shutdown_at) VALUES (1, 'nope')`).run();
    expect(consumeCleanShutdownMarker()).toBeNull();
    expect(
      db.prepare(`SELECT clean_shutdown_at AS v FROM engine_restart WHERE id = 1`).get(),
    ).toEqual({ v: null });
  });
});

describe("the degraded-heartbeat marker", () => {
  it("round-trips and consumes exactly once", () => {
    markHeartbeatDegraded(9_000);
    expect(consumeHeartbeatDegradedMarker()).toBe(9_000);
    expect(consumeHeartbeatDegradedMarker()).toBeNull();
  });

  it("does not disturb the heartbeat it is reporting on", () => {
    stampEngineHeartbeat(1_000);
    markHeartbeatDegraded(2_000);
    consumeHeartbeatDegradedMarker();
    expect(readEngineRestartState().lastSeenAt).toBe(1_000);
  });

  it("consuming one that was never written creates no row", () => {
    expect(consumeHeartbeatDegradedMarker()).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM engine_restart`).get()).toEqual({ n: 0 });
  });
});

const SEEDED_AT = Date.parse("2026-05-15T09:00:00.000Z");

/** A second obligation, taken on hours after the first. The two travel in one
 *  set and each keeps its own instant. */
const LATER_SEED = SEEDED_AT + 4 * 60 * 60_000;

describe("the durable downtime-flatten obligation", () => {
  it("survives the process that took it on", () => {
    setPendingFlatten(
      [
        { deploymentId: "depl-a", seededAt: SEEDED_AT },
        { deploymentId: "depl-b", seededAt: SEEDED_AT },
      ],
      4 * 60 * 60_000,
    );
    // A fresh read is what the next boot does, and the set is what D-7 says
    // must not die with the process holding it.
    expect(readEngineRestartState().pendingFlatten).toEqual({
      entries: [
        { deploymentId: "depl-a", seededAt: SEEDED_AT },
        { deploymentId: "depl-b", seededAt: SEEDED_AT },
      ],
      gapMs: 4 * 60 * 60_000,
    });
  });

  it("round-trips a per-deployment seed instant rather than one for the set", () => {
    // A merged set holds obligations taken on at different instants, and the
    // sweep refuses a trade row against the entry's own. One instant for the
    // set applies the earlier obligation's threshold to the later one's
    // position and drops a flatten that is genuinely owed.
    setPendingFlatten(
      [
        { deploymentId: "depl-a", seededAt: SEEDED_AT },
        { deploymentId: "depl-b", seededAt: LATER_SEED },
      ],
      4 * 60 * 60_000,
    );
    expect(readEngineRestartState().pendingFlatten.entries).toEqual([
      { deploymentId: "depl-a", seededAt: SEEDED_AT },
      { deploymentId: "depl-b", seededAt: LATER_SEED },
    ]);
  });

  it("replaces the whole set rather than merging, so a drain is a shrink", () => {
    setPendingFlatten(
      [
        { deploymentId: "depl-a", seededAt: SEEDED_AT },
        { deploymentId: "depl-b", seededAt: SEEDED_AT },
      ],
      60_000,
    );
    setPendingFlatten([{ deploymentId: "depl-b", seededAt: SEEDED_AT }], 60_000);
    expect(readEngineRestartState().pendingFlatten.entries).toEqual([
      { deploymentId: "depl-b", seededAt: SEEDED_AT },
    ]);
  });

  it("keeps the heartbeat, the marker and the flap counter independent of it", () => {
    stampEngineHeartbeat(1_000);
    markCleanShutdown(2_000);
    recordUncleanResume(3_000, 15 * 60_000);
    setPendingFlatten([{ deploymentId: "depl-a", seededAt: SEEDED_AT }], 60_000);
    expect(readEngineRestartState()).toMatchObject({
      lastSeenAt: 1_000,
      cleanShutdownAt: 2_000,
      resumeCycles: [3_000],
      pendingFlatten: {
        entries: [{ deploymentId: "depl-a", seededAt: SEEDED_AT }],
        gapMs: 60_000,
      },
    });
  });

  it("reads an unparseable obligation as empty rather than throwing", () => {
    db.prepare(`INSERT INTO engine_restart (id, pending_flatten) VALUES (1, 'not json')`).run();
    expect(readEngineRestartState().pendingFlatten).toEqual({ entries: [], gapMs: 0 });
  });

  it("reads an array where an object belongs as empty", () => {
    db.prepare(`INSERT INTO engine_restart (id, pending_flatten) VALUES (1, '["depl-a"]')`).run();
    expect(readEngineRestartState().pendingFlatten).toEqual({ entries: [], gapMs: 0 });
  });

  it("drops malformed entries and a non-numeric gap rather than carrying them", () => {
    db.prepare(
      `INSERT INTO engine_restart (id, pending_flatten)
       VALUES (1, '{"entries":[{"deploymentId":"depl-a","seededAt":1747299600000},{"deploymentId":7},{"seededAt":1},null,{"deploymentId":""}],"gapMs":"long"}')`,
    ).run();
    expect(readEngineRestartState().pendingFlatten).toEqual({
      entries: [{ deploymentId: "depl-a", seededAt: 1_747_299_600_000 }],
      gapMs: 0,
    });
  });

  it("reads a legacy payload's set-wide instant onto every id it named", () => {
    // The shape this process no longer writes. The boot that wrote it meant
    // that instant for every id in the set, so it is read that way rather than
    // discarded — dropping it would refuse the whole obligation.
    db.prepare(
      `INSERT INTO engine_restart (id, pending_flatten)
       VALUES (1, '{"deploymentIds":["depl-a","depl-b"],"gapMs":600000,"seededAt":1747299600000}')`,
    ).run();
    expect(readEngineRestartState().pendingFlatten).toEqual({
      entries: [
        { deploymentId: "depl-a", seededAt: 1_747_299_600_000 },
        { deploymentId: "depl-b", seededAt: 1_747_299_600_000 },
      ],
      gapMs: 600_000,
    });
  });

  it("reads a payload written before the seed instant existed as having none", () => {
    // Absent is 0, and the boot path substitutes its own instant for it. The
    // other direction — treating an unreadable seed as "everything open is
    // older than it" — is a licence to force-close whatever is on the books.
    db.prepare(
      `INSERT INTO engine_restart (id, pending_flatten)
       VALUES (1, '{"deploymentIds":["depl-a"],"gapMs":600000}')`,
    ).run();
    expect(readEngineRestartState().pendingFlatten).toEqual({
      entries: [{ deploymentId: "depl-a", seededAt: 0 }],
      gapMs: 600_000,
    });
  });

  it("refuses a hand-edited seed instant that is not a finite epoch", () => {
    db.prepare(
      `INSERT INTO engine_restart (id, pending_flatten)
       VALUES (1, '{"entries":[{"deploymentId":"depl-a","seededAt":"yesterday"}],"gapMs":600000}')`,
    ).run();
    expect(readEngineRestartState().pendingFlatten.entries).toEqual([
      { deploymentId: "depl-a", seededAt: 0 },
    ]);
  });
});
