/**
 * Restart semantics — D-13's classification and D-14's flap counter, plus the
 * boot-time flatten that is the only place D-7's close can ever happen.
 *
 * `./strategies` is mocked because the strategy loader uses webpack's
 * `require.context`, which has no vitest equivalent (patterns.md). The two db
 * modules are mocked because the classification's rule is what is under test,
 * not SQLite — `db/engine-restart.test.ts` covers the storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    /** When set, the store below is the shipped one on this database. */
    memory: null as InstanceType<typeof BetterSqlite3> | null,
    migrations: [] as Array<(d: InstanceType<typeof BetterSqlite3>) => void>,
    lastSeenAt: null as number | null,
    cleanShutdownAt: null as number | null,
    heartbeatDegradedAt: null as number | null,
    resumeCycles: [] as number[],
    pendingFlatten: { entries: [] as OwedFlatten[], gapMs: 0 },
    recorded: [] as Array<[number, number]>,
    consumed: 0,
    degradedConsumed: 0,
  },
}));

vi.mock("@/lib/db/connection", () => ({
  registerPreCloseHook: vi.fn(),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof BetterSqlite3>) => void) => {
    dbState.migrations.push(fn);
  }),
  getDb: vi.fn(() => {
    if (dbState.memory) return dbState.memory;
    throw new Error("getDb() called in test — DB not available");
  }),
}));

vi.mock("@/lib/db/engine-logs", () => ({ flush: vi.fn(), flushBeforeExit: vi.fn() }));

// This process holds the engine lease, so the marker hook writes and the
// sweep flattens; the hook without it is pinned in
// `engine-restart.lease.test.ts`, and the gate's own rule in `db/lease.test.ts`.
const lease = vi.hoisted(() => ({ held: true, refusedAt: [] as string[] }));
vi.mock("@/lib/db/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/lease")>()),
  holdsLease: () => true,
  leaseGate: (door: string) => () => {
    if (lease.held) return true;
    lease.refusedAt.push(door);
    return false;
  },
}));

// The classification's rule is under test, so the store is a stand-in — except
// where `dbState.memory` is set, which runs the shipped store on SQLite.
vi.mock("@/lib/db/engine-restart", async (importOriginal) => {
  const shipped = await importOriginal<typeof import("@/lib/db/engine-restart")>();
  const onMemory = <A extends unknown[], R>(standIn: (...args: NoInfer<A>) => R, real: (...args: A) => R) =>
    vi.fn((...args: A) => (dbState.memory ? real(...args) : standIn(...args)));
  return {
    readEngineRestartState: onMemory(
      () => ({
        lastSeenAt: dbState.lastSeenAt,
        cleanShutdownAt: dbState.cleanShutdownAt,
        resumeCycles: dbState.resumeCycles,
        pendingFlatten: dbState.pendingFlatten,
      }),
      shipped.readEngineRestartState,
    ),
    consumeCleanShutdownMarker: onMemory(() => {
      dbState.consumed += 1;
      const marker = dbState.cleanShutdownAt;
      dbState.cleanShutdownAt = null;
      return marker;
    }, shipped.consumeCleanShutdownMarker),
    consumeHeartbeatDegradedMarker: onMemory(() => {
      dbState.degradedConsumed += 1;
      const marker = dbState.heartbeatDegradedAt;
      dbState.heartbeatDegradedAt = null;
      return marker;
    }, shipped.consumeHeartbeatDegradedMarker),
    markHeartbeatDegraded: onMemory(() => {}, shipped.markHeartbeatDegraded),
    setPendingFlatten: onMemory(() => {}, shipped.setPendingFlatten),
    markCleanShutdown: onMemory(() => {}, shipped.markCleanShutdown),
    recordUncleanResume: onMemory((nowMs: number, windowMs: number) => {
      dbState.recorded.push([nowMs, windowMs]);
      dbState.resumeCycles = [...dbState.resumeCycles, nowMs].filter((t) => nowMs - t <= windowMs);
      return dbState.resumeCycles.length;
    }, shipped.recordUncleanResume),
    stampEngineHeartbeat: onMemory(() => {}, shipped.stampEngineHeartbeat),
  };
});

import type { Contract } from "@/lib/brokers/types";
import type { OwedFlatten } from "@/lib/db/engine-restart";
import type { Deployment, DeploymentStatus } from "@/lib/trading/domain";
import type { DeploymentState } from "../engine";
import {
  classifyRestart,
  evaluateRestart,
  installCleanShutdownMarker,
  readOwedFlatten,
  formatGapDuration,
  RestartFlattenGuard,
  RESTART_FLATTEN_FAILURE_REPORT_MS,
  RESUME_FLAP_LIMIT,
  RESUME_FLAP_WINDOW_MS,
  UNMANAGED_FLATTEN_MS,
  ENGINE_DOWNTIME_EXIT_REASON,
  type RestartGuardDeps,
} from "./engine-restart";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { EVENTS } from "@/lib/logging/vocabulary";
import { FlattenCooldown, FLATTEN_COOLDOWN_MS } from "../engine-flatten-cooldown";
import { registerPreCloseHook } from "@/lib/db/connection";
import {
  consumeCleanShutdownMarker,
  markCleanShutdown,
  readEngineRestartState,
  recordUncleanResume,
  stampEngineHeartbeat,
} from "@/lib/db/engine-restart";

const DEPL = "depl-1";

beforeEach(() => {
  lease.held = true;
  lease.refusedAt = [];
  dbState.memory = null;
  dbState.lastSeenAt = null;
  dbState.cleanShutdownAt = null;
  dbState.heartbeatDegradedAt = null;
  dbState.resumeCycles = [];
  dbState.pendingFlatten = { entries: [], gapMs: 0 };
  dbState.recorded = [];
  dbState.consumed = 0;
  dbState.degradedConsumed = 0;
  vi.clearAllMocks();
});

// ── D-13's table ───────────────────────────────────────────────────────────

describe("classifyRestart", () => {
  const NOW = 10_000_000;

  it("does not flatten and does not alarm on a marker plus a short gap", () => {
    const v = classifyRestart({
      lastSeenAt: NOW - 20_000,
      cleanShutdownAt: NOW - 19_000,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v).toEqual({
      gapMs: 20_000,
      clean: true,
      flatten: false,
      alarm: false,
      heartbeatDegraded: false,
    });
  });

  it("alarms but does not flatten on no marker plus a short gap", () => {
    // A crash the position survived: brackets were live at the broker, and
    // flattening would realize a P&L nobody asked for. Reliability signal,
    // not a position-safety one.
    const v = classifyRestart({
      lastSeenAt: NOW - 20_000,
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v).toEqual({
      gapMs: 20_000,
      clean: false,
      flatten: false,
      alarm: true,
      heartbeatDegraded: false,
    });
  });

  it("flattens and alarms on a long gap after a clean shutdown", () => {
    const v = classifyRestart({
      lastSeenAt: NOW - (UNMANAGED_FLATTEN_MS + 1),
      cleanShutdownAt: NOW - UNMANAGED_FLATTEN_MS,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v.clean).toBe(true);
    expect(v.flatten).toBe(true);
    expect(v.alarm).toBe(true);
  });

  it("flattens and alarms on a long gap after a crash", () => {
    const v = classifyRestart({
      lastSeenAt: NOW - (UNMANAGED_FLATTEN_MS + 1),
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v).toMatchObject({ clean: false, flatten: true, alarm: true });
  });

  it("does not flatten exactly at the threshold", () => {
    const v = classifyRestart({
      lastSeenAt: NOW - UNMANAGED_FLATTEN_MS,
      cleanShutdownAt: NOW,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v.gapMs).toBe(UNMANAGED_FLATTEN_MS);
    expect(v.flatten).toBe(false);
  });

  it("takes the threshold from its argument, not from the shipped constant", () => {
    const short = classifyRestart({
      lastSeenAt: NOW - 30_000,
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
      unmanagedFlattenMs: 20_000,
    });
    expect(short.flatten).toBe(true);
    const long = classifyRestart({
      lastSeenAt: NOW - 30_000,
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
      unmanagedFlattenMs: 40_000,
    });
    expect(long.flatten).toBe(false);
  });

  it("reports no gap at all on a first boot rather than a zero-length one", () => {
    const v = classifyRestart({
      lastSeenAt: null,
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v).toEqual({
      gapMs: null,
      clean: false,
      flatten: false,
      alarm: false,
      heartbeatDegraded: false,
    });
  });

  it("clamps a backwards clock to zero instead of reading it as a long outage", () => {
    const v = classifyRestart({
      lastSeenAt: NOW + 60_000,
      cleanShutdownAt: null,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v.gapMs).toBe(0);
    expect(v.flatten).toBe(false);
  });
});

// ── The degraded-heartbeat downgrade ───────────────────────────────────────

describe("classifyRestart — a heartbeat that could not be written", () => {
  const NOW = 10_000_000;
  const LONG = NOW - (UNMANAGED_FLATTEN_MS + 60_000);

  it("refuses to flatten a long gap the previous process spent trading", () => {
    // Twelve minutes of failed writes on a healthy engine is indistinguishable
    // here from twelve minutes of absence, and the two want opposite
    // responses. A reading the rule cannot trust must fail toward leaving the
    // position alone.
    const v = classifyRestart({
      lastSeenAt: LONG,
      cleanShutdownAt: NOW - 1_000,
      heartbeatDegradedAt: NOW - 30_000,
      nowMs: NOW,
    });
    expect(v.flatten).toBe(false);
    expect(v.heartbeatDegraded).toBe(true);
  });

  it("still alarms on that gap rather than passing it off as healthy", () => {
    // The downgrade is to alarm-only, not to silence: a database the engine
    // could not write for twelve minutes is an incident whether or not it
    // closed a position.
    const v = classifyRestart({
      lastSeenAt: LONG,
      cleanShutdownAt: NOW - 1_000,
      heartbeatDegradedAt: NOW - 30_000,
      nowMs: NOW,
    });
    expect(v.alarm).toBe(true);
  });

  it("would have flattened the same gap without the marker", () => {
    // The negative above is only evidence if the identical input flattens
    // when the marker is absent — otherwise it would keep passing against a
    // gap that was never past the threshold.
    const v = classifyRestart({
      lastSeenAt: LONG,
      cleanShutdownAt: NOW - 1_000,
      heartbeatDegradedAt: null,
      nowMs: NOW,
    });
    expect(v.flatten).toBe(true);
  });

  it("alarms on a clean short gap that would otherwise be silent", () => {
    const v = classifyRestart({
      lastSeenAt: NOW - 20_000,
      cleanShutdownAt: NOW - 19_000,
      heartbeatDegradedAt: NOW - 25_000,
      nowMs: NOW,
    });
    expect(v).toEqual({
      gapMs: 20_000,
      clean: true,
      flatten: false,
      alarm: true,
      heartbeatDegraded: true,
    });
  });

  it("reports it on a first boot too, where there is no gap to downgrade", () => {
    const v = classifyRestart({
      lastSeenAt: null,
      cleanShutdownAt: null,
      heartbeatDegradedAt: NOW - 1_000,
      nowMs: NOW,
    });
    expect(v).toEqual({
      gapMs: null,
      clean: false,
      flatten: false,
      alarm: true,
      heartbeatDegraded: true,
    });
  });
});

// ── D-14's flap counter ────────────────────────────────────────────────────

describe("evaluateRestart", () => {
  const NOW = 10_000_000;

  it("consumes the marker exactly once", () => {
    dbState.lastSeenAt = NOW - 1_000;
    dbState.cleanShutdownAt = NOW - 500;
    const v = evaluateRestart(NOW);
    expect(v.clean).toBe(true);
    expect(dbState.consumed).toBe(1);
  });

  it("records a cycle for a crash resume and not for a clean one", () => {
    dbState.lastSeenAt = NOW - 1_000;
    dbState.cleanShutdownAt = NOW - 500;
    evaluateRestart(NOW);
    expect(recordUncleanResume).not.toHaveBeenCalled();

    dbState.lastSeenAt = NOW - 1_000;
    dbState.cleanShutdownAt = null;
    evaluateRestart(NOW);
    expect(recordUncleanResume).toHaveBeenCalledWith(NOW, RESUME_FLAP_WINDOW_MS);
  });

  it("records nothing on a first boot", () => {
    dbState.lastSeenAt = null;
    evaluateRestart(NOW);
    expect(recordUncleanResume).not.toHaveBeenCalled();
  });

  it("suspends entries once the cycle count reaches the limit", () => {
    dbState.lastSeenAt = NOW - 1_000;
    dbState.resumeCycles = Array.from({ length: RESUME_FLAP_LIMIT - 1 }, (_, i) => NOW - i * 1_000);
    const v = evaluateRestart(NOW);
    expect(v.flapCycles).toBe(RESUME_FLAP_LIMIT);
    expect(v.entriesSuspended).toBe(true);
  });

  it("does not suspend entries below the limit", () => {
    dbState.lastSeenAt = NOW - 1_000;
    dbState.resumeCycles = Array.from({ length: RESUME_FLAP_LIMIT - 2 }, (_, i) => NOW - i * 1_000);
    const v = evaluateRestart(NOW);
    expect(v.flapCycles).toBe(RESUME_FLAP_LIMIT - 1);
    expect(v.entriesSuspended).toBe(false);
  });

  it("consumes the degraded-heartbeat marker, so it can only downgrade one boot", () => {
    dbState.lastSeenAt = NOW - (UNMANAGED_FLATTEN_MS + 60_000);
    dbState.heartbeatDegradedAt = NOW - 30_000;
    const first = evaluateRestart(NOW);
    expect(first.flatten).toBe(false);
    expect(first.heartbeatDegraded).toBe(true);
    expect(dbState.degradedConsumed).toBe(1);

    // Same durable gap on the next boot, marker now gone: the duration rule
    // is back. Without the consume, one bad database window would disable the
    // flatten for every boot after it.
    dbState.lastSeenAt = NOW - (UNMANAGED_FLATTEN_MS + 60_000);
    const second = evaluateRestart(NOW);
    expect(second.flatten).toBe(true);
    expect(second.heartbeatDegraded).toBe(false);
  });

  it("counts only cycles still inside the window on a clean boot", () => {
    dbState.lastSeenAt = NOW - 1_000;
    dbState.cleanShutdownAt = NOW - 500;
    dbState.resumeCycles = [NOW - RESUME_FLAP_WINDOW_MS - 1, NOW - 1_000];
    const v = evaluateRestart(NOW);
    expect(v.flapCycles).toBe(1);
  });
});

/**
 * Three pushes in an afternoon are an ordinary day, and each planned stop
 * writes the clean-shutdown marker, so none of them is a crash-resume.
 * Zero-downtime deploys, step 1 case 3 — on the shipped store, because the
 * marker's consume and the counter's prune are what the answer rests on.
 */
describe("three restarts inside the flap window, on the shipped store", () => {
  const T0 = 1_800_000_000_000;
  /** Marker on SIGTERM to the next boot, as measured on prod (~35 s). */
  const DEPLOY_GAP_MS = 35_000;
  const BETWEEN_PUSHES_MS = 4 * 60_000;

  beforeEach(() => {
    dbState.memory = new BetterSqlite3(":memory:");
    for (const migrate of dbState.migrations) migrate(dbState.memory);
  });

  /** A process that ran from `bootAt` and stopped `BETWEEN_PUSHES_MS` later; the next boot's verdict. */
  function cycle(bootAt: number, stop: "sigterm" | "crash") {
    const verdict = evaluateRestart(bootAt);
    const stoppedAt = bootAt + BETWEEN_PUSHES_MS;
    stampEngineHeartbeat(stoppedAt);
    if (stop === "sigterm") markCleanShutdown(stoppedAt);
    return { verdict, nextBootAt: stoppedAt + DEPLOY_GAP_MS };
  }

  function threeRestarts(stop: "sigterm" | "crash") {
    // The process that was running before the first push.
    stampEngineHeartbeat(T0);
    if (stop === "sigterm") markCleanShutdown(T0);
    let bootAt = T0 + DEPLOY_GAP_MS;
    const verdicts = [];
    for (let i = 0; i < RESUME_FLAP_LIMIT; i++) {
      const { verdict, nextBootAt } = cycle(bootAt, stop);
      verdicts.push(verdict);
      bootAt = nextBootAt;
    }
    expect(bootAt - T0).toBeLessThan(RESUME_FLAP_WINDOW_MS);
    return verdicts;
  }

  it("does not suspend entries when each boot follows a clean-shutdown marker", () => {
    const verdicts = threeRestarts("sigterm");

    expect(verdicts.map((v) => v.clean)).toEqual([true, true, true]);
    expect(verdicts.map((v) => v.entriesSuspended)).toEqual([false, false, false]);
    expect(verdicts.map((v) => v.flapCycles)).toEqual([0, 0, 0]);
    expect(readEngineRestartState().resumeCycles).toEqual([]);
  });

  it("suspends entries on the third boot when none of them had a marker", () => {
    const verdicts = threeRestarts("crash");

    expect(verdicts.map((v) => v.clean)).toEqual([false, false, false]);
    expect(verdicts.map((v) => v.flapCycles)).toEqual([1, 2, 3]);
    expect(verdicts.map((v) => v.entriesSuspended)).toEqual([false, false, true]);
    // Counted by the shipped store, not the stand-in.
    expect(readEngineRestartState().resumeCycles).toHaveLength(RESUME_FLAP_LIMIT);
    expect(dbState.recorded).toEqual([]);
  });
});

describe("installCleanShutdownMarker", () => {
  it("registers the marker write as a DB pre-close hook, not as its own signal handler", () => {
    // The ordering the marker needs — write, then close — is structural only
    // if it hangs off the close path. A second `process.once("SIGTERM")` would
    // run after `connection.ts`'s, against a closed database.
    installCleanShutdownMarker();
    expect(registerPreCloseHook).toHaveBeenCalledTimes(1);
    installCleanShutdownMarker();
    expect(registerPreCloseHook).toHaveBeenCalledTimes(1);
  });

  it("says the process was told to stop, writes the marker, then flushes both lines before the close", async () => {
    // `shutdown_signal` is the deploy measurement's first boundary. It is only
    // a queued log line, so the marker is still the hook's first write; the
    // flush is what gets both lines to disk, because the log store's own
    // SIGTERM flush runs ahead of every pre-close hook.
    vi.resetModules();
    const connection = await import("@/lib/db/connection");
    const store = await import("@/lib/db/engine-restart");
    const engineLogs = await import("@/lib/db/engine-logs");
    const { log } = await import("@/lib/logger");
    const fresh = await import("./engine-restart");
    const order: string[] = [];
    const eventSpy = vi.spyOn(log, "event").mockImplementation((event: string) => {
      order.push(event);
    });
    vi.mocked(store.markCleanShutdown).mockImplementation(() => {
      order.push("marker");
    });
    vi.mocked(engineLogs.flush).mockImplementation(() => {
      order.push("flush");
    });

    fresh.installCleanShutdownMarker();
    const hook = vi.mocked(connection.registerPreCloseHook).mock.calls[0][0];
    hook("SIGTERM");

    expect(order).toEqual(["shutdown_signal", "marker", "shutdown_marker_written", "flush"]);
    expect(EVENTS.shutdown_signal).toMatchObject({ severity: "info", category: "lifecycle" });
    eventSpy.mockRestore();
  });

  it("raises the draining latch with the signal, so the engine takes no new entry while the drain runs", async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__crossfireShutdownDraining;
    const connection = await import("@/lib/db/connection");
    const drain = await import("@/lib/shutdown-drain");
    const fresh = await import("./engine-restart");
    const eventSpy = vi.spyOn((await import("@/lib/logger")).log, "event").mockImplementation(() => {});

    fresh.installCleanShutdownMarker();
    expect(drain.isShutdownDraining()).toBe(false);
    vi.mocked(connection.registerPreCloseHook).mock.calls[0][0]("SIGTERM");

    expect(drain.isShutdownDraining()).toBe(true);
    eventSpy.mockRestore();
    delete (globalThis as Record<string, unknown>).__crossfireShutdownDraining;
  });
});

// ── The boot-time flatten ──────────────────────────────────────────────────

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: DEPL,
    strategyKey: "test",
    accountId: 4242,
    ticker: "/MNQ",
    contractId: null,
    status: "Active" as DeploymentStatus,
    paramValues: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "parent-1",
    enabledSnapshot: null,
    ...over,
  };
}

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return {
    lastBarTimestamp: null,
    cooldownAnchorAt: null,
    position: null,
    activeTradeId: null,
    breakEvenMoved: false,
    preEntryOrderIds: null,
    activeTpTicks: null,
    activeSlTicks: null,
    slMovedToBe: false,
    slCurrentPrice: null,
    tpCurrentPrice: null,
    exitInFlight: false,
    flatMismatchWarnedAt: null,
    pendingEntrySessionKey: null,
    signalSuppressed: false,
    ...over,
  } as DeploymentState;
}

function withPosition(): DeploymentState {
  return state({
    activeTradeId: 77,
    position: {
      side: 0,
      entryPrice: 21000,
      entryTimestamp: "2026-01-01T14:00:00Z",
      barsSinceEntry: 3,
      entryFilledAt: "2026-01-01T14:00:01Z",
      size: 1,
      slTicks: 40,
    },
  });
}

const CONTRACT = { id: "CON.F.US.MNQ.Z26", tickSize: 0.25 } as Contract;

/** When the sweep was seeded, and two trade-start instants either side of it.
 *  A carried obligation is by construction about a position that predates the
 *  boot carrying it, so `AFTER_SEED` is a *different* trade. */
const SEEDED_AT = Date.parse("2026-05-15T09:00:00.000Z");
const BEFORE_SEED = SEEDED_AT - 4 * 60 * 60_000;
const AFTER_SEED = SEEDED_AT + 5_000;

/** One owed deployment, against the instant its own obligation was taken on. */
function owed(deploymentId: string, seededAt: number = SEEDED_AT): OwedFlatten {
  return { deploymentId, seededAt };
}

/** The account and contract every flatten actor keys the shared cooldown on.
 *  `CONTRACT` carries no `executionContractId`, so `id` is the key. */
const ACCT = 4242;
const CONTRACT_ID = "CON.F.US.MNQ.Z26";

interface Harness {
  guard: RestartFlattenGuard;
  deps: { [K in keyof Omit<RestartGuardDeps, "flattenCooldown">]: ReturnType<typeof vi.fn> };
  flattenCooldown: FlattenCooldown;
  logs: Array<[string, string, string]>;
  setRow(next: Deployment | null): void;
  setOpenTrade(open: boolean): void;
  setStartedAt(startedAt: number | null): void;
  setState(next: DeploymentState | undefined): void;
  currentState(): DeploymentState | undefined;
}

function makeGuard(
  opts: {
    row?: Deployment | null;
    openTrade?: boolean;
    startedAt?: number | null;
    state?: DeploymentState;
    flattenCooldown?: FlattenCooldown;
    over?: Partial<Record<keyof RestartGuardDeps, unknown>>;
  } = {},
): Harness {
  let row: Deployment | null = opts.row === undefined ? deployment() : opts.row;
  let openTrade = opts.openTrade ?? true;
  let startedAt: number | null = opts.startedAt === undefined ? BEFORE_SEED : opts.startedAt;
  let deplState: DeploymentState | undefined = opts.state ?? withPosition();
  const logs: Array<[string, string, string]> = [];

  const deps = {
    log: vi.fn((d: string, severity: string, _category: string, m: string) => {
      logs.push([d, severity, m]);
    }),
    // Recorded under the registry's severity, not an argument. Every line
    // this guard emits names an event, and the event is where its severity
    // is settled — so a hand-changed severity fails this file.
    logEvent: vi.fn((event: string, d: string, m: string) => {
      logs.push([d, EVENTS[event]?.severity ?? "info", m]);
    }),
    getDeployment: vi.fn(() => row),
    hasOpenTrade: vi.fn(() => openTrade),
    openTradeStartedAt: vi.fn(() => startedAt),
    stateFor: vi.fn(() => deplState),
    persistPending: vi.fn(),
    resolveContract: vi.fn(async () => CONTRACT),
    placeExitOrder: vi.fn(async () => {}),
    ...(opts.over ?? {}),
  } as unknown as { [K in keyof Omit<RestartGuardDeps, "flattenCooldown">]: ReturnType<typeof vi.fn> };

  const flattenCooldown = opts.flattenCooldown ?? new FlattenCooldown();

  return {
    guard: new RestartFlattenGuard({ ...deps, flattenCooldown } as unknown as RestartGuardDeps),
    deps,
    flattenCooldown,
    logs,
    setRow: (next) => {
      row = next;
    },
    setOpenTrade: (open) => {
      openTrade = open;
    },
    setStartedAt: (next) => {
      startedAt = next;
    },
    setState: (next) => {
      deplState = next;
    },
    currentState: () => deplState,
  };
}

describe("RestartFlattenGuard", () => {
  it("does nothing at all when nothing was seeded", async () => {
    const h = makeGuard();
    await h.guard.runRestartFlatten();
    expect(h.deps.getDeployment).not.toHaveBeenCalled();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("force-exits a seeded deployment under the downtime reason", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.placeExitOrder.mock.calls[0][5]).toBe(ENGINE_DOWNTIME_EXIT_REASON);
  });

  it("clears the position mirror after a submitted exit", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.currentState()?.position).toBeNull();
    expect(h.currentState()?.cooldownAnchorAt).not.toBeNull();
  });

  it("flattens nothing without the engine lease, keeps the obligation, and asks at its own door", async () => {
    // It survives `stop()`, so a lost lease does not disarm it; the obligation
    // is durable and the holder's boot re-seeds it.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    lease.held = false;

    await h.guard.runRestartFlatten();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(1);
    expect(h.currentState()?.position).not.toBeNull();
    expect(lease.refusedAt).toEqual(["the downtime flatten sweep"]);
  });

  it("stays pending after a submitted exit — the latch covers submission, not fill", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.guard.pendingCount()).toBe(1);
  });

  it("drains only when the trade row is gone", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    h.setOpenTrade(false);
    await h.guard.runRestartFlatten();
    expect(h.guard.pendingCount()).toBe(0);
  });

  it("retries on the next pass when the exit is rejected", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error("broker unreachable");
        }),
      },
    });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    // The position is deliberately kept, which is what makes the retry work.
    expect(h.currentState()?.position).not.toBeNull();
    await h.guard.runRestartFlatten();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
    expect(h.logs.some(([, level]) => level === "error")).toBe(true);
  });

  it("treats EXIT_IN_FLIGHT as already happening, never as a failure", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error(EntryExitCode.EXIT_IN_FLIGHT);
        }),
      },
    });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.logs.some(([, level]) => level === "error")).toBe(false);
    // The exit already on the wire owns the teardown; this pass must not
    // clear a position for an exit it did not place.
    expect(h.currentState()?.position).not.toBeNull();
    expect(h.guard.pendingCount()).toBe(1);
  });

  it("hands a row that is no longer Active to the closing guard instead of acting", async () => {
    const h = makeGuard({ row: deployment({ status: "Pausing" }) });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(0);
  });

  it("drops a deployment whose row has gone", async () => {
    const h = makeGuard({ row: null });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(0);
  });

  it("costs no broker call for a deployment that came back flat", async () => {
    // Asserting "no exit fired" would keep passing if the trade-row check were
    // moved below the resolve, which would put a contract resolve per pending
    // deployment per 15s on a boot that owes nothing.
    const h = makeGuard({ openTrade: false });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(0);
  });

  it("waits rather than acting when the position mirror is not rehydrated yet", async () => {
    const h = makeGuard({ state: state() });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(1);
  });

  it("re-reads the position after the resolve and abandons the dispatch if it vanished", async () => {
    const h = makeGuard();
    h.deps.resolveContract.mockImplementation(async () => {
      // A close event landing during the resolve nulls `position`;
      // `placeExitOrderInner` would read `.side` off null.
      h.setState(state());
      return CONTRACT;
    });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("reports a missing strategy rather than skipping silently", async () => {
    const { getStrategy } = await import("../../strategies");
    vi.mocked(getStrategy).mockReturnValueOnce(undefined as never);
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await h.guard.runRestartFlatten();
    expect(h.logs.some(([, level]) => level === "error")).toBe(true);
    expect(h.guard.pendingCount()).toBe(1);
  });
});

// ── The obligation outlives the process — C1 / D-7 ─────────────────────────

describe("RestartFlattenGuard — durability of the pending set", () => {
  it("records the set, its gap and each seed instant the moment it is seeded", () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL), owed("depl-2")], 20 * 60_000);
    expect(h.deps.persistPending).toHaveBeenCalledWith(
      [owed(DEPL), owed("depl-2")],
      20 * 60_000,
    );
  });

  it("keeps the record intact across a submitted exit that has not confirmed flat", async () => {
    // The single most important arm: this is the state the process dies in
    // when the operator restarts the container to clear the broker connection
    // the sweep is failing against.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    // Either nothing was written, or what was written still owes this
    // deployment. Both are correct; "the row now says nothing is owed" is not.
    for (const [entries] of h.deps.persistPending.mock.calls) {
      expect(entries).toContainEqual(owed(DEPL));
    }
    expect(h.guard.pendingCount()).toBe(1);
  });

  it("keeps the record intact across a rejected exit", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error("broker unreachable");
        }),
      },
    });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    for (const [entries] of h.deps.persistPending.mock.calls) {
      expect(entries).toContainEqual(owed(DEPL));
    }
  });

  it("clears the record only once the trade row is gone", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    h.setOpenTrade(false);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    expect(h.deps.persistPending).toHaveBeenCalledWith([], 0);
  });

  it("lets the gap and the seed instants go with the last member of the set", async () => {
    // The gap describes the set. Written beside an *empty* set it is adopted
    // by whatever the next boot owes — and since `collectOwedFlatten` returns
    // early on an empty carried set, nothing ever writes it back down. An
    // eleven-minute outage then reports itself as four hours on every
    // incident surface there is. The instants ride on the entries, so an empty
    // set carries none by construction.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    h.setOpenTrade(false);
    await h.guard.runRestartFlatten();
    const last = h.deps.persistPending.mock.calls.at(-1);
    expect(last).toEqual([[], 0]);
  });

  it("drops only the deployment that confirmed flat, leaving the rest recorded", async () => {
    let openFor = new Set([DEPL, "depl-2"]);
    const h = makeGuard({
      over: { hasOpenTrade: vi.fn((id: string) => openFor.has(id)) },
    });
    h.guard.markUnmanaged([owed(DEPL), owed("depl-2")], 20 * 60_000);
    openFor = new Set(["depl-2"]);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    expect(h.deps.persistPending).toHaveBeenCalledWith([owed("depl-2")], 20 * 60_000);
  });

  it("records the drop of a row that is no longer Active", async () => {
    const h = makeGuard({ row: deployment({ status: "Pausing" }) });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    expect(h.deps.persistPending).toHaveBeenCalledWith([], 0);
  });
});

// ── The obligation is about one position, not about a deployment ───────────

describe("RestartFlattenGuard — the owed set names a position", () => {
  it("does not force-close a position that opened after the sweep was seeded", async () => {
    // Every step ordinary. A four-hour outage owes DEPL; the broker is still
    // unreachable — the module's own stated common case — so the sweep
    // retries. The outage-era position closes at the broker on its own
    // bracket, unseen; the priming tick retires that row; a genuine signal
    // opens a *new* position seconds later. `hasOpenTrade` is true again and
    // `stateFor().position` is populated again, both about a different trade.
    // Force-closing here is the failure the application latch was built to
    // stop, arriving through the durable path instead of the in-process one.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    h.setStartedAt(AFTER_SEED);

    await h.guard.runRestartFlatten();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.guard.pendingCount()).toBe(0);
  });

  it("says the owed position is gone and that what is open now is newer", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    h.setStartedAt(AFTER_SEED);

    await h.guard.runRestartFlatten();

    const line = h.logs.find(([, , m]) => m.includes("[RESTART]"));
    expect(line).toBeDefined();
    expect(line![2]).toMatch(/after/i);
    expect(line![2]).not.toContain("force-exiting");
  });

  it("still force-closes the position the obligation was actually about", async () => {
    // The negative above is only evidence beside this one: a row that predates
    // the seed is the owed position and is flattened exactly as before.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    h.setStartedAt(BEFORE_SEED);

    await h.guard.runRestartFlatten();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.placeExitOrder.mock.calls[0][5]).toBe(ENGINE_DOWNTIME_EXIT_REASON);
  });

  it("judges each deployment against its own instant, not the set's earliest", async () => {
    // Two obligations in one set, taken on four hours apart. `depl-2`'s
    // position opened after the *carried* obligation's instant and before its
    // own, so it is exactly what `depl-2` is owed — and the earlier instant,
    // applied set-wide, reads it as younger than the sweep and discards it.
    //
    // The two legs are on *different* contracts, which is the only shape the
    // engine can produce: `contractLocks` admits one deployment per (account,
    // contract), so two owed a flatten on one contract is unreachable — and
    // the shared flatten cooldown is keyed on exactly that pair, so a fixture
    // that collides them has the second leg correctly deferred a pass and
    // tests nothing about seed instants.
    const later = SEEDED_AT + 4 * 60 * 60_000;
    const states = new Map([
      [DEPL, withPosition()],
      ["depl-2", withPosition()],
    ]);
    const h = makeGuard({
      over: {
        getDeployment: vi.fn((id: string) =>
          deployment({ id, ticker: id === DEPL ? "/MNQ" : "/MES" }),
        ),
        resolveContract: vi.fn(async (ticker: string) =>
          ticker === "/MNQ" ? CONTRACT : ({ id: "CON.F.US.MES.Z26", tickSize: 0.25 } as Contract),
        ),
        openTradeStartedAt: vi.fn((id: string) => (id === DEPL ? BEFORE_SEED : AFTER_SEED)),
        stateFor: vi.fn((id: string) => states.get(id)),
      },
    });
    h.guard.markUnmanaged([owed(DEPL), owed("depl-2", later)], 4 * 60 * 60_000);

    await h.guard.runRestartFlatten();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
  });

  it("carries its seed instant into the durable record rather than re-stamping it", async () => {
    // A re-seed that reset the instant would reopen the same hole one boot
    // later: the next boot would read every row older than *its* start as
    // owed, including one this process opened.
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    h.deps.persistPending.mockClear();
    await h.guard.runRestartFlatten();
    for (const [entries] of h.deps.persistPending.mock.calls) {
      expect(entries).toEqual([owed(DEPL)]);
    }
  });

  it("round-trips a set whose members were seeded at different instants", async () => {
    // A merged set is the normal case, not a curiosity: a carried obligation
    // and one this boot computed arrive together and were taken on hours
    // apart. Persisting one instant for both is what discards a real flatten.
    const later = SEEDED_AT + 4 * 60 * 60_000;
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL), owed("depl-2", later)], 20 * 60_000);
    expect(h.deps.persistPending).toHaveBeenCalledWith(
      [owed(DEPL), owed("depl-2", later)],
      20 * 60_000,
    );
  });
});

describe("RestartFlattenGuard — the shared flatten cooldown", () => {
  // The cooldown and the failure throttle are both clocks, and both are the
  // input under test here.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SEEDED_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers rather than dispatching while another actor's flatten may be unbooked", async () => {
    const flattenCooldown = new FlattenCooldown();
    flattenCooldown.note(ACCT, CONTRACT_ID, "watchdog");
    const h = makeGuard({ flattenCooldown });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);

    await h.guard.runRestartFlatten();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.logs.filter(([, level]) => level === "warn")[0][2]).toContain("deferring this pass");
  });

  it("does not drain the pending entry on a cooldown skip — the obligation is durable", async () => {
    // `drop()` is the only place the pending set shrinks and it is the only
    // place the durable record clears. A deferral is not a drain: nothing here
    // established confirmed flat.
    const flattenCooldown = new FlattenCooldown();
    flattenCooldown.note(ACCT, CONTRACT_ID, "watchdog");
    const h = makeGuard({ flattenCooldown });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    h.deps.persistPending.mockClear();

    await h.guard.runRestartFlatten();

    expect(h.guard.pendingCount()).toBe(1);
    expect(h.deps.persistPending).not.toHaveBeenCalled();
  });

  it("does not clear the failure anchor on a cooldown skip, so a repeatedly deferred flatten still escalates", async () => {
    const flattenCooldown = new FlattenCooldown();
    const h = makeGuard({
      flattenCooldown,
      over: { placeExitOrder: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) },
    });
    h.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);

    await h.guard.runRestartFlatten();
    const errors = () => h.logs.filter(([, level]) => level === "error");
    expect(errors()).toHaveLength(1);

    // A rival actor stamps, so the pass that would have re-reported defers.
    vi.setSystemTime(new Date(SEEDED_AT + RESTART_FLATTEN_FAILURE_REPORT_MS + 1));
    flattenCooldown.note(ACCT, CONTRACT_ID, "watchdog");
    await h.guard.runRestartFlatten();
    expect(errors()).toHaveLength(1);

    vi.setSystemTime(new Date(SEEDED_AT + RESTART_FLATTEN_FAILURE_REPORT_MS + FLATTEN_COOLDOWN_MS + 2));
    await h.guard.runRestartFlatten();

    // Counted from the first failure, not restarted by the deferral.
    expect(errors()).toHaveLength(2);
    expect(errors()[1][2]).toContain("failing for 330s so far");
  });

  it("releases the stamp when nothing reached the wire, and keeps it on EXIT_IN_FLIGHT", async () => {
    const rejected = makeGuard({
      over: { placeExitOrder: vi.fn(async () => { throw new Error("order rejected"); }) },
    });
    rejected.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await rejected.guard.runRestartFlatten();
    expect(rejected.flattenCooldown.active(ACCT, CONTRACT_ID)).toBe(false);

    // The latch refused, which means an exit really is in flight against this
    // (account, contract) — unlike D-2, whose refusal comes from a different
    // position's exit. Dropping it here would unguard the watchdog.
    const latched = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => { throw new Error(EntryExitCode.EXIT_IN_FLIGHT); }),
      },
    });
    latched.guard.markUnmanaged([owed(DEPL)], 20 * 60_000);
    await latched.guard.runRestartFlatten();
    expect(latched.flattenCooldown.active(ACCT, CONTRACT_ID)).toBe(true);
  });
});

describe("readOwedFlatten", () => {
  it("returns what the previous process was still owed", () => {
    dbState.pendingFlatten = { entries: [owed(DEPL)], gapMs: 4 * 60 * 60_000 };
    expect(readOwedFlatten()).toEqual({ entries: [owed(DEPL)], gapMs: 4 * 60 * 60_000 });
  });

  it("substitutes this read's instant for an entry that carries none", () => {
    // An id a legacy payload carried without an instant reads as 0, and 0
    // would refuse every open position — silently discarding a real
    // obligation. "Predates the boot carrying it" is the conservative reading,
    // and this is the only place the substitution happens.
    dbState.pendingFlatten = { entries: [owed(DEPL, 0)], gapMs: 600_000 };
    expect(readOwedFlatten(SEEDED_AT).entries).toEqual([owed(DEPL, SEEDED_AT)]);
  });

  it("substitutes per entry, leaving a sibling's recorded instant alone", () => {
    dbState.pendingFlatten = {
      entries: [owed(DEPL, 0), owed("depl-2", SEEDED_AT)],
      gapMs: 600_000,
    };
    expect(readOwedFlatten(SEEDED_AT + 60_000).entries).toEqual([
      owed(DEPL, SEEDED_AT + 60_000),
      owed("depl-2", SEEDED_AT),
    ]);
  });

  it("does not consult the restart classification to answer", () => {
    // The obligation is D-7's and outlives the verdict that created it. A
    // reader that asked "did *this* boot decide to flatten" would drop the set
    // on exactly the boot that follows an operator restart mid-sweep.
    dbState.pendingFlatten = { entries: [owed(DEPL)], gapMs: 4 * 60 * 60_000 };
    dbState.lastSeenAt = Date.now() - 30_000;
    dbState.cleanShutdownAt = Date.now() - 29_000;
    expect(readOwedFlatten().entries).toEqual([owed(DEPL)]);
    expect(consumeCleanShutdownMarker).not.toHaveBeenCalled();
  });
});

// ── The duration an operator actually reads ────────────────────────────────
//
// The helper lives here rather than in `boot-engine` because the four sweep
// lines below print the same gap into the same log stream minutes after the
// boot lines do, and one of them said `1314s` on a live restart test.

describe("formatGapDuration", () => {
  it("keeps a short gap in seconds", () => {
    expect(formatGapDuration(0)).toBe("0s");
    expect(formatGapDuration(98_000)).toBe("98s");
  });

  it("switches to minutes at two minutes, with no hole at the boundary", () => {
    expect(formatGapDuration(119_400)).toBe("119s");
    expect(formatGapDuration(119_600)).toBe("2m");
    expect(formatGapDuration(120_000)).toBe("2m");
  });

  it("truncates a minutes-scale gap to the whole minute", () => {
    expect(formatGapDuration(14 * 60_000 + 29_000)).toBe("14m");
    expect(formatGapDuration(59 * 60_000 + 59_000)).toBe("59m");
  });

  it("renders an hours-scale gap as hours and minutes", () => {
    expect(formatGapDuration(3_600_000)).toBe("1h");
    expect(formatGapDuration(45_640_000)).toBe("12h 40m");
    expect(formatGapDuration(25 * 60 * 60_000)).toBe("25h");
  });
});

// ── Every line the sweep prints reports the gap in those units ─────────────

/** The gap the operator watched print as `1314s` during a live restart test.
 *  Truncated to the minute by the helper's stated semantics, so `21m`. */
const INCIDENT_GAP_MS = 1_314_000;

describe("the sweep reports its gap in the same units as the boot lines", () => {
  function messages(h: Harness): string[] {
    return h.logs.map(([, , message]) => message);
  }

  it("says so on the confirmed-flat drain", async () => {
    const h = makeGuard({ openTrade: false });
    h.guard.markUnmanaged([owed(DEPL)], 4 * 60 * 60_000);
    await h.guard.runRestartFlatten();

    const line = messages(h).find((m) => m.includes("confirmed flat"));
    expect(line).toContain("confirmed flat after 4h unmanaged");
    expect(line).not.toContain("14400s");
  });

  it("says so when the owed position turns out to be gone", async () => {
    const h = makeGuard({ startedAt: AFTER_SEED });
    h.guard.markUnmanaged([owed(DEPL)], 45_640_000);
    await h.guard.runRestartFlatten();

    const line = messages(h).find((m) => m.includes("is gone"));
    expect(line).toContain("went unmanaged for 12h 40m is gone");
    expect(line).not.toContain("45640s");
  });

  it("says so on the force-exit — the line the operator read as 1314s", async () => {
    const h = makeGuard();
    h.guard.markUnmanaged([owed(DEPL)], INCIDENT_GAP_MS);
    await h.guard.runRestartFlatten();

    const line = messages(h).find((m) => m.includes("force-exiting"));
    expect(line).toContain("Position went unmanaged for 21m — force-exiting");
    expect(line).not.toContain("1314s");
  });

  it("says so when the force-flat cannot be placed, without touching the retry clock", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error("broker unreachable");
        }),
      },
    });
    h.guard.markUnmanaged([owed(DEPL)], INCIDENT_GAP_MS);
    await h.guard.runRestartFlatten();

    const line = messages(h).find((m) => m.includes("Could not force-flat"));
    expect(line).toContain("went unmanaged for 21m");
    expect(line).not.toContain("1314s");
    // How long the retry has been failing is a *different* quantity, seconds
    // old and still climbing — it stays in seconds.
    expect(line).toContain("failing for 0s so far");
  });
});
