/**
 * The engine lease's runtime half: the 5s renew, what a lost lease does, and
 * where the SIGTERM marker hook releases it. The store is real over
 * `:memory:` — both migrations captured from `registerMigration` and replayed
 * — so a release that clears the wrong row or a renew that reads its own
 * release as a loss shows up in the column the next process reads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
}));

const H = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
  preCloseHooks: [] as Array<(signal: string) => void>,
  stopSequences: [] as string[],
  logWarn: vi.fn(),
  logEvent: vi.fn(),
  failWrites: false,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    if (H.failWrites) throw new Error("database is locked");
    return db;
  }),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    H.migrations.push(fn);
  }),
  registerPreCloseHook: vi.fn((fn: (signal: string) => void) => {
    H.preCloseHooks.push(fn);
  }),
  // The stop sequence a signal runs, which the yield runs with its own
  // trigger: here its pre-close half, which is all that writes.
  runShutdownSequence: vi.fn((trigger: string) => {
    H.stopSequences.push(trigger);
    for (const hook of H.preCloseHooks) hook(trigger);
  }),
  isClosedForShutdown: vi.fn(() => false),
}));

vi.mock("@/lib/db/engine-logs", () => ({ flush: vi.fn(), flushBeforeExit: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: H.logWarn, error: vi.fn(), event: H.logEvent },
}));

import {
  leaseHolderId,
  readLease,
  requestHandoff,
  tryAcquireLease,
  withdrawHandoff,
  HANDOFF_REQUEST_FRESH_MS,
  LEASE_FRESH_MS,
  LEASE_RENEW_MS,
} from "@/lib/db/lease";
import { readEngineRestartState } from "@/lib/db/engine-restart";
import { EVENTS } from "@/lib/logging/vocabulary";
import { isShutdownDraining } from "@/lib/shutdown-drain";
import {
  installCleanShutdownMarker,
  releaseLeaseAtExit,
  startLeaseRenewal,
  startProcessLiveness,
  stopLeaseRenewal,
  stopProcessLiveness,
  PROCESS_LIVENESS_INTERVAL_MS,
} from "./engine-restart";

const OTHER = "other-host:7:cafef00d";
const RELEASED_FOR_EXIT_KEY = "__crossfireEngineLeaseReleasedForExit";
const originalRole = process.env.CROSSFIRE_ROLE;

let markerHook: ((signal: string) => void) | null = null;

/** The marker hook, which `installCleanShutdownMarker` registers once per
 *  module however many tests ask for it. */
function installMarker(): (signal: string) => void {
  const before = H.preCloseHooks.length;
  installCleanShutdownMarker();
  if (H.preCloseHooks.length > before) markerHook = H.preCloseHooks[H.preCloseHooks.length - 1];
  if (!markerHook) throw new Error("the marker hook was never registered");
  return markerHook;
}

function eventsNamed(event: string): unknown[][] {
  return H.logEvent.mock.calls.filter((c: unknown[]) => c[0] === event);
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of H.migrations) fn(db);
  H.failWrites = false;
  H.stopSequences = [];
  H.logWarn.mockClear();
  H.logEvent.mockClear();
  vi.useFakeTimers();
  tryAcquireLease(leaseHolderId(), Date.now());
});

afterEach(() => {
  stopLeaseRenewal();
  stopProcessLiveness();
  delete (globalThis as Record<string, unknown>).__crossfireShutdownDraining;
  delete (globalThis as Record<string, unknown>)[RELEASED_FOR_EXIT_KEY];
  if (originalRole === undefined) delete process.env.CROSSFIRE_ROLE;
  else process.env.CROSSFIRE_ROLE = originalRole;
  vi.useRealTimers();
});

describe("the lease renew", () => {
  it("re-stamps the lease every LEASE_RENEW_MS while it is ours", async () => {
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    const before = readLease().renewedAt ?? 0;

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);

    expect(readLease().holder).toBe(leaseHolderId());
    expect(readLease().renewedAt).toBe(before + LEASE_RENEW_MS);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops the engine once, at error and flagged, when another process has taken it", async () => {
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    db.prepare(`UPDATE engine_lease SET holder = ?, generation = generation + 1 WHERE id = 1`).run(OTHER);

    await vi.advanceTimersByTimeAsync(3 * LEASE_RENEW_MS);

    expect(onLost).toHaveBeenCalledTimes(1);
    const lost = eventsNamed("engine_lease_lost");
    expect(lost).toHaveLength(1);
    expect(String(lost[0][2])).toContain(OTHER);
    expect(EVENTS.engine_lease_lost).toMatchObject({
      severity: "error",
      category: "safety",
      escalates: true,
    });
    // The other process's claim is left exactly as it was.
    expect(readLease().holder).toBe(OTHER);
  });

  it("stops the liveness stamp too, so the column keeps measuring the real engine's absence", async () => {
    // A stopped engine with no open rows still passes the liveness gate, and
    // its stamp would hide the new holder's crash from the duration rule.
    startProcessLiveness({ engineRunning: () => false, openTradesExist: () => false });
    startLeaseRenewal({ onLost: vi.fn() });
    db.prepare(`UPDATE engine_lease SET holder = ?, generation = generation + 1 WHERE id = 1`).run(OTHER);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
    const frozen = readEngineRestartState().lastSeenAt;

    await vi.advanceTimersByTimeAsync(3 * PROCESS_LIVENESS_INTERVAL_MS);

    expect(eventsNamed("engine_lease_lost")).toHaveLength(1);
    expect(readEngineRestartState().lastSeenAt).toBe(frozen);
  });

  it("warns rather than stopping when the renew cannot reach the database", async () => {
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    H.failWrites = true;

    await vi.advanceTimersByTimeAsync(2 * LEASE_RENEW_MS);

    expect(onLost).not.toHaveBeenCalled();
    expect(eventsNamed("engine_lease_lost")).toEqual([]);
    expect(H.logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("the lease on SIGTERM", () => {
  it("is held and renewed through the drain, and released by the exit: marker, latch, drain, release", async () => {
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    const markerHook = installMarker();
    const order: string[] = [];
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("clean_shutdown_at") && !/^\s*SELECT/i.test(sql)) order.push("marker");
      if (sql.includes("SET renewed_at = ?") && sql.includes("holder = ?")) order.push("renew");
      if (sql.includes("holder = NULL")) order.push("release");
      return realPrepare(sql);
    });

    markerHook("SIGTERM");
    expect(isShutdownDraining()).toBe(true);
    expect(readEngineRestartState().cleanShutdownAt).not.toBeNull();
    // Past the freshness window: a drain that outlasts it must not leave a
    // lease another process could take while this one still places exits.
    await vi.advanceTimersByTimeAsync(LEASE_FRESH_MS + LEASE_RENEW_MS);
    expect(readLease().holder).toBe(leaseHolderId());
    expect(tryAcquireLease(OTHER, Date.now()).acquired).toBe(false);

    releaseLeaseAtExit();

    expect(order[0]).toBe("marker");
    expect(order.slice(1, -1).every((step) => step === "renew")).toBe(true);
    expect(order.slice(1, -1).length).toBeGreaterThan(0);
    expect(order[order.length - 1]).toBe("release");
    // The next process takes it at once, not LEASE_FRESH_MS later.
    expect(tryAcquireLease(OTHER, Date.now()).acquired).toBe(true);

    await vi.advanceTimersByTimeAsync(3 * LEASE_RENEW_MS);
    expect(onLost).not.toHaveBeenCalled();
    expect(eventsNamed("engine_lease_lost")).toEqual([]);
  });

  it("writes no marker from a process that lost the lease, and says why", () => {
    // Its stop is not the engine's: a marker here would tell the real
    // engine's next boot that a crash was a planned stop.
    const markerHook = installMarker();
    db.prepare(`UPDATE engine_lease SET holder = ?, generation = generation + 1 WHERE id = 1`).run(OTHER);

    markerHook("SIGTERM");

    expect(readEngineRestartState().cleanShutdownAt).toBeNull();
    expect(eventsNamed("shutdown_marker_written")).toEqual([]);
    expect(H.logWarn).toHaveBeenCalledWith("engine", expect.stringContaining("does not hold the engine lease"));
    expect(readLease().holder).toBe(OTHER);
  });

  it("is never released at exit from a process that lost it", () => {
    db.prepare(`UPDATE engine_lease SET holder = ?, generation = generation + 1 WHERE id = 1`).run(OTHER);
    releaseLeaseAtExit();
    expect(readLease().holder).toBe(OTHER);
  });
});

describe("the yield to a standby", () => {
  beforeEach(() => {
    process.env.CROSSFIRE_ROLE = "engine";
  });

  it("runs the stop sequence with the hand-off as its trigger, and the exit hands the lease over", async () => {
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    installMarker();
    const before = readLease().generation;
    expect(requestHandoff(OTHER, Date.now())).toMatchObject({ kind: "requested" });

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);

    expect(H.stopSequences).toEqual(["handoff"]);
    // The SIGTERM path's own steps: the latch and the marker.
    expect(isShutdownDraining()).toBe(true);
    expect(readEngineRestartState().cleanShutdownAt).not.toBeNull();
    // Accepted, and still ours through the drain.
    expect(readLease()).toMatchObject({ holder: leaseHolderId(), handoffRequestedBy: null });
    expect(tryAcquireLease(OTHER, Date.now()).acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(3 * LEASE_RENEW_MS);
    expect(H.stopSequences).toEqual(["handoff"]);

    releaseLeaseAtExit();

    expect(tryAcquireLease(OTHER, Date.now())).toMatchObject({ acquired: true, generation: before + 1 });
    const yielded = eventsNamed("handoff_yielded");
    expect(yielded).toHaveLength(1);
    expect(String(yielded[0][2])).toContain(OTHER);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops nothing and places nothing: the only action is the stop sequence", async () => {
    // `onLost` is the one door from here to the engine's `stop()`; the yield
    // never takes it, and nothing else on this path reaches a broker.
    const onLost = vi.fn();
    startLeaseRenewal({ onLost });
    requestHandoff(OTHER, Date.now());

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);

    expect(H.stopSequences).toEqual(["handoff"]);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("does not yield to a standby that withdrew at its bound", async () => {
    startLeaseRenewal({ onLost: vi.fn() });
    requestHandoff(OTHER, Date.now());
    withdrawHandoff(OTHER);

    await vi.advanceTimersByTimeAsync(2 * LEASE_RENEW_MS);

    expect(H.stopSequences).toEqual([]);
    expect(readLease().holder).toBe(leaseHolderId());
  });

  it("does not yield to a standby that stopped asking — killed mid-wait, its request left behind", async () => {
    requestHandoff(OTHER, Date.now());
    vi.advanceTimersByTime(LEASE_FRESH_MS + 1);
    startLeaseRenewal({ onLost: vi.fn() });

    await vi.advanceTimersByTimeAsync(2 * LEASE_RENEW_MS);

    expect(H.stopSequences).toEqual([]);
    expect(readLease().holder).toBe(leaseHolderId());
  });

  it("does not yield to a request last refreshed more than the request window ago, though the lease is still fresh", async () => {
    // A standby killed within this window of its last refresh can still be
    // yielded to; past it, never — the window is what bounds a yield to nobody.
    requestHandoff(OTHER, Date.now());
    vi.advanceTimersByTime(HANDOFF_REQUEST_FRESH_MS + 1);
    startLeaseRenewal({ onLost: vi.fn() });

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);

    expect(HANDOFF_REQUEST_FRESH_MS + 1 + LEASE_RENEW_MS).toBeLessThan(LEASE_FRESH_MS);
    expect(H.stopSequences).toEqual([]);
    expect(readLease()).toMatchObject({ holder: leaseHolderId(), handoffRequestedBy: OTHER });
  });

  it("does not yield from an all-role process, which serves the UI as well", async () => {
    process.env.CROSSFIRE_ROLE = "all";
    startLeaseRenewal({ onLost: vi.fn() });
    requestHandoff(OTHER, Date.now());

    await vi.advanceTimersByTimeAsync(2 * LEASE_RENEW_MS);

    expect(H.stopSequences).toEqual([]);
    expect(readLease()).toMatchObject({ holder: leaseHolderId(), handoffRequestedBy: OTHER });
  });
});
