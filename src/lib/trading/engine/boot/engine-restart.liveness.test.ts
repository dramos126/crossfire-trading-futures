/**
 * The process-liveness heartbeat — A57.
 *
 * Its own file rather than a block in `engine-restart.test.ts`, because that
 * file mocks `@/lib/db/engine-restart` away: the classification's *rule* is
 * what it tests, and a stubbed `stampEngineHeartbeat` cannot show that an idle
 * process's stamp reaches the column the next boot reads. Here the store is
 * real over `:memory:` — the pattern `db/engine-restart.test.ts` established,
 * with the migration captured from `registerMigration` and replayed rather
 * than restated — and only `db/connection`, the strategy loader and the logger
 * are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
}));

const { migrations, preCloseHooks, logWarn, logEvent } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
  preCloseHooks: [] as Array<(signal: string) => void>,
  logWarn: vi.fn(),
  logEvent: vi.fn(),
}));

let db: InstanceType<typeof Database>;
let heartbeatWritesFail = false;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => (heartbeatWritesFail ? refusingHeartbeatWrites(db) : db)),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
  registerPreCloseHook: vi.fn((fn: (signal: string) => void) => {
    preCloseHooks.push(fn);
  }),
}));

vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn(), event: logEvent },
}));

import {
  markCleanShutdown,
  readEngineRestartState,
  stampEngineHeartbeat,
} from "@/lib/db/engine-restart";
import {
  evaluateRestart,
  startProcessLiveness,
  stopProcessLiveness,
  PROCESS_LIVENESS_INTERVAL_MS,
  UNMANAGED_FLATTEN_MS,
  type LivenessGate,
} from "./engine-restart";

/**
 * The gate `classifyBoot` composes, with both answers under the test's
 * control. The default is the A57 shape — an idle process with nothing on
 * the books — so every assertion written before the gate existed reads
 * exactly as it did.
 */
function gate(over: Partial<LivenessGate> = {}): LivenessGate {
  return { engineRunning: () => false, openTradesExist: () => false, ...over };
}

/**
 * The database with the heartbeat upsert failing and everything else working
 * — a per-statement lock or a WAL stall on a healthy process, which is the
 * shape the degraded marker exists for. Keyed on the upsert's own clause, so
 * the reads and the degraded write both still land.
 */
function refusingHeartbeatWrites(
  real: InstanceType<typeof Database>,
): InstanceType<typeof Database> {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("last_seen_at = excluded.last_seen_at")) {
            throw new Error("database is locked");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Wednesday 09:45 ET, mid-session. Nothing here reads a calendar, but
 *  `Date.now()` decides every value under test, so the instant is pinned
 *  rather than inherited from whenever the suite happens to run. */
const T0 = Date.parse("2026-05-13T13:45:00.000Z");
const HOUR = 60 * 60_000;

function degradedMarker(): number | null {
  const row = db
    .prepare(`SELECT heartbeat_degraded_at AS at FROM engine_restart WHERE id = 1`)
    .get() as { at: number | null } | undefined;
  return row?.at ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The stamper is process-wide state, so a test that leaves it armed hands
  // the next one a `startProcessLiveness()` that returns without stamping.
  stopProcessLiveness();
  heartbeatWritesFail = false;
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  stopProcessLiveness();
  vi.useRealTimers();
});

describe("the process-liveness heartbeat", () => {
  it("stamps last_seen_at on a process that has nothing deployed", () => {
    // The A57 shape exactly: no deployment, so no tick loop, so
    // `noteEngineAlive()` is never reached and the old stamp never moved.
    startProcessLiveness(gate());
    expect(readEngineRestartState().lastSeenAt).toBe(T0);
  });

  it("keeps stamping on the interval, so the stamp cannot freeze at the last tick", () => {
    startProcessLiveness(gate());
    vi.advanceTimersByTime(PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + PROCESS_LIVENESS_INTERVAL_MS);
    vi.advanceTimersByTime(3 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + 4 * PROCESS_LIVENESS_INTERVAL_MS);
  });

  it("stays well inside the duration rule between stamps", () => {
    // The cadence only has to keep the reading inside the threshold it feeds.
    expect(PROCESS_LIVENESS_INTERVAL_MS).toBeLessThan(UNMANAGED_FLATTEN_MS);
  });

  it("arms exactly one interval however many callers start it", () => {
    // A second interval would survive the single `clearInterval` and keep
    // stamping after the disarm, which is what this asserts rather than
    // counting timers: nothing must claim liveness for a process on its way
    // out.
    startProcessLiveness(gate());
    startProcessLiveness(gate());
    vi.advanceTimersByTime(PROCESS_LIVENESS_INTERVAL_MS);
    const atStop = readEngineRestartState().lastSeenAt;
    stopProcessLiveness();
    vi.advanceTimersByTime(5 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(atStop);
  });

  it("disarms through a pre-close hook rather than its own signal handler", () => {
    // Same reason the clean-shutdown marker does: `process.once` fires in
    // registration order, and the close handler is installed on the first
    // `getDb()`. A stamp that fires after `db.close()` reopens the connection
    // to claim liveness for a process that is exiting. One hook for the life
    // of the module, not one per start.
    startProcessLiveness(gate());
    expect(preCloseHooks).toHaveLength(1);

    for (const hook of preCloseHooks) hook("SIGTERM");
    const atClose = readEngineRestartState().lastSeenAt;
    vi.advanceTimersByTime(10 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(atClose);
  });

  it("leaves the degraded marker unset while the writes are landing", () => {
    // `heartbeatDegraded` means *the write failed*, and an idle process is not
    // a failed write. Folding idleness into it would undo the one distinction
    // the marker exists to make.
    startProcessLiveness(gate());
    vi.advanceTimersByTime(20 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(degradedMarker()).toBeNull();
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + 20 * PROCESS_LIVENESS_INTERVAL_MS);
  });

  it("records the degraded marker when the stamp itself throws", () => {
    heartbeatWritesFail = true;
    startProcessLiveness(gate());
    heartbeatWritesFail = false;
    expect(degradedMarker()).toBe(T0);
    // Nothing was written to the column the duration rule reads, which is the
    // whole reason the marker has to be there for the next boot.
    expect(readEngineRestartState().lastSeenAt).toBeNull();
  });

  it("warns once per window while the write keeps failing, never once per stamp", () => {
    // A day past T0 so the module-scope throttle carries nothing in from a
    // sibling test; `warn` is never emitted per-tick (logging/README).
    vi.setSystemTime(T0 + 24 * HOUR);
    heartbeatWritesFail = true;
    startProcessLiveness(gate());
    vi.advanceTimersByTime(4 * PROCESS_LIVENESS_INTERVAL_MS);
    heartbeatWritesFail = false;
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(String(logWarn.mock.calls[0][1])).toContain("liveness heartbeat write failed");
  });
});

/**
 * The gate, which is the narrowing A57 left behind and the rule that closes
 * it: **the stamper stamps unless the engine is stopped while open trade rows
 * exist.** A fatal-auth `stop()` on a live process kept claiming liveness all
 * night, so the next boot read seconds of gap for a position that had gone
 * unmanaged for hours and adopted it instead of flattening it.
 */
describe("what the liveness stamp is allowed to claim", () => {
  it("does not stamp for a stopped engine that is still holding rows", () => {
    stampEngineHeartbeat(T0);
    vi.setSystemTime(T0 + 60_000);
    startProcessLiveness(gate({ engineRunning: () => false, openTradesExist: () => true }));
    expect(readEngineRestartState().lastSeenAt).toBe(T0);
  });

  it("lets the gap accrue across the stopped process, exactly as it did before A57", () => {
    // The fatal-auth stop, overnight: the process is up and writable the whole
    // time, and the position on the books has nobody managing it.
    stampEngineHeartbeat(T0);
    startProcessLiveness(gate({ engineRunning: () => false, openTradesExist: () => true }));
    vi.advanceTimersByTime(11 * HOUR);
    stopProcessLiveness();

    vi.setSystemTime(T0 + 11 * HOUR + 45_000);
    const verdict = evaluateRestart();
    expect(verdict.gapMs).toBe(11 * HOUR + 45_000);
    expect(verdict.flatten).toBe(true);
  });

  it("stamps for a stopped engine with nothing on the books, so A57 stays fixed", () => {
    startProcessLiveness(gate({ engineRunning: () => false, openTradesExist: () => false }));
    vi.advanceTimersByTime(3 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + 3 * PROCESS_LIVENESS_INTERVAL_MS);
  });

  it("stamps for a running engine that is holding rows, which is the ordinary case", () => {
    // The tick loop stamps the same column from its own call; both landing is
    // one single-row UPDATE by integer primary key and is why the redundancy
    // is free.
    startProcessLiveness(gate({ engineRunning: () => true, openTradesExist: () => true }));
    vi.advanceTimersByTime(3 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + 3 * PROCESS_LIVENESS_INTERVAL_MS);
  });

  it("reads a throwing predicate as rows-may-exist and declines the stamp", () => {
    // The opposite bias from `heartbeatDegraded`'s, deliberately: a silent
    // non-stamp costs a flatten of a position that was probably fine, and a
    // silent stamp costs an unmanaged position nobody is ever told about. This
    // one fails toward measuring the gap.
    stampEngineHeartbeat(T0);
    vi.setSystemTime(T0 + 60_000);
    startProcessLiveness(
      gate({
        openTradesExist: () => {
          throw new Error("database is locked");
        },
      }),
    );
    expect(readEngineRestartState().lastSeenAt).toBe(T0);
  });

  it("falls through to the row check when engineRunning is the one that throws", () => {
    // The two throw arms are not the same claim. *Cannot say whether an engine
    // is running* is the pre-engine reading the gate already handles, so it
    // asks the half that decides; only the row predicate carries the
    // flatten-ward bias. Under one shared `try` this stamp was declined, and a
    // process with nothing on the books stopped stamping — A57 again, through
    // a predicate nobody expected to throw.
    startProcessLiveness(
      gate({
        engineRunning: () => {
          throw new Error("engine singleton unavailable");
        },
        openTradesExist: () => false,
      }),
    );
    expect(readEngineRestartState().lastSeenAt).toBe(T0);
  });

  it("says so when the row check is what could not answer, once per window", () => {
    // A standing `strategy_trades` read fault freezes `last_seen_at` for as
    // long as it lasts and the next boot force-flattens off a phantom gap. The
    // decline is correct; being silent about it is not. Well past T0 so the
    // module-scope anchor carries nothing in from the sibling tests above.
    vi.setSystemTime(T0 + 48 * HOUR);
    startProcessLiveness(
      gate({
        openTradesExist: () => {
          throw new Error("database is locked");
        },
      }),
    );
    vi.advanceTimersByTime(4 * PROCESS_LIVENESS_INTERVAL_MS);

    expect(readEngineRestartState().lastSeenAt).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toBe("liveness_gate_unreadable");
    expect(String(logEvent.mock.calls[0][2])).toContain("could not read the open trade rows");
  });

  it("does not call a declined stamp a degraded heartbeat", () => {
    // The marker means *the write failed*. Nothing was attempted here, so
    // there is nothing to report — and marking it would downgrade the very
    // flatten this gate exists to let happen.
    startProcessLiveness(gate({ openTradesExist: () => true }));
    vi.advanceTimersByTime(5 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(degradedMarker()).toBeNull();
  });

  it("re-opens the stamp when the engine starts, without a restart of the timer", () => {
    // `start()` after a stop is one process closing its own gap, which is the
    // property the gate had to keep: the interval is armed once for the life
    // of the process and the predicate is read per tick.
    let running = false;
    startProcessLiveness(gate({ engineRunning: () => running, openTradesExist: () => true }));
    vi.advanceTimersByTime(2 * PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBeNull();

    running = true;
    vi.advanceTimersByTime(PROCESS_LIVENESS_INTERVAL_MS);
    expect(readEngineRestartState().lastSeenAt).toBe(T0 + 3 * PROCESS_LIVENESS_INTERVAL_MS);
  });
});

/**
 * The ratchet on that decline. A read fault standing hours was a warn every
 * five minutes and no page, and the force-flatten it predicted arrived at the
 * next boot with no `error` anywhere in the record.
 */
describe("a run of declined stamps", () => {
  const MINUTE = 60_000;
  let rowsReadable = false;
  const flakyGate = gate({
    openTradesExist: () => {
      if (rowsReadable) return false;
      throw new Error("database is locked");
    },
  });
  const eventNames = () => logEvent.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    rowsReadable = false;
  });

  it("warns only while the run is under thirty minutes", () => {
    // Days past T0 so the module-scope anchor carries nothing in.
    vi.setSystemTime(T0 + 72 * HOUR);
    startProcessLiveness(flakyGate);
    vi.advanceTimersByTime(29 * MINUTE);
    // Stamps at 0..29 min, one report per five-minute window.
    expect(eventNames()).toEqual(Array(6).fill("liveness_gate_unreadable"));
  });

  it("past thirty minutes, sends the flagged error once per window in the warn's place", () => {
    vi.setSystemTime(T0 + 96 * HOUR);
    startProcessLiveness(flakyGate);
    vi.advanceTimersByTime(45 * MINUTE);
    // 0..30 min warn (thirty is not past the threshold); 35, 40, 45 escalate.
    expect(eventNames()).toEqual([
      ...Array(7).fill("liveness_gate_unreadable"),
      ...Array(3).fill("liveness_gate_unreadable_persistent"),
    ]);
    const escalated = logEvent.mock.calls.find((c) => c[0] === "liveness_gate_unreadable_persistent");
    expect(String(escalated?.[2])).toContain("force-flatten");
    // Still declined: the ratchet changes what is said, not what the gate does.
    expect(readEngineRestartState().lastSeenAt).toBeNull();
  });

  it("says once that the rows read again, and the next run starts from zero", () => {
    vi.setSystemTime(T0 + 120 * HOUR);
    startProcessLiveness(flakyGate);
    vi.advanceTimersByTime(40 * MINUTE);
    expect(eventNames()).toContain("liveness_gate_unreadable_persistent");

    logEvent.mockClear();
    rowsReadable = true;
    vi.advanceTimersByTime(3 * MINUTE);
    expect(eventNames()).toEqual(["liveness_gate_readable_again"]);
    expect(readEngineRestartState().lastSeenAt).toBe(Date.now());

    // A fresh fault, one window after the last report: back to the warn.
    logEvent.mockClear();
    rowsReadable = false;
    vi.advanceTimersByTime(20 * MINUTE);
    expect(eventNames().length).toBeGreaterThan(0);
    expect(eventNames().every((n) => n === "liveness_gate_unreadable")).toBe(true);
  });

  it("sets the degraded marker on neither the escalation nor the recovery", () => {
    // The marker would downgrade the flatten the decline exists to allow.
    vi.setSystemTime(T0 + 144 * HOUR);
    startProcessLiveness(flakyGate);
    vi.advanceTimersByTime(40 * MINUTE);
    rowsReadable = true;
    vi.advanceTimersByTime(MINUTE);
    expect(eventNames()).toContain("liveness_gate_unreadable_persistent");
    expect(eventNames()).toContain("liveness_gate_readable_again");
    expect(degradedMarker()).toBeNull();
  });
});

describe("the restart verdict on an idle-then-restarted process", () => {
  it("measures the stop-to-start window, not the hours the process sat idle", () => {
    // Staging, 2026-08-26: the last deployment ticked at 03:22 and two deploys
    // eight minutes apart both reported ~12.7h of "no engine activity" off
    // that one frozen stamp.
    stampEngineHeartbeat(T0);
    vi.setSystemTime(T0 + 12 * HOUR);
    startProcessLiveness(gate());

    // Eighteen hours of an idle box, and the process is alive for every one.
    vi.advanceTimersByTime(18 * HOUR);
    const redeployAt = Date.now();
    stopProcessLiveness();
    markCleanShutdown(redeployAt);

    // The redeploy: 45 seconds of container down-time and nothing else.
    vi.setSystemTime(redeployAt + 45_000);
    const verdict = evaluateRestart();

    expect(verdict.gapMs).toBe(45_000);
    expect(verdict.flatten).toBe(false);
    expect(verdict.clean).toBe(true);
  });

});

/** Both halves of the same fixture: a 45-minute outage, read in each order.
 *  What `classifyBoot` does with them is pinned in `boot-engine.test.ts`;
 *  these two say what is at stake if it stops. */
describe("why the boot path classifies before it stamps", () => {
  it("reports the real outage when the classification reads first", () => {
    stampEngineHeartbeat(T0);
    vi.setSystemTime(T0 + 45 * 60_000);

    const verdict = evaluateRestart();
    startProcessLiveness(gate());

    expect(verdict.gapMs).toBe(45 * 60_000);
    expect(verdict.flatten).toBe(true);
  });

  it("reports no outage at all when the stamp lands first", () => {
    // Not a supported ordering — the hazard, pinned. The stamp overwrites the
    // one column the duration rule measures, so a boot that started the
    // stamper first would report 0 for an outage of any length and flatten
    // nothing, silently.
    stampEngineHeartbeat(T0);
    vi.setSystemTime(T0 + 45 * 60_000);

    startProcessLiveness(gate());
    const verdict = evaluateRestart();

    expect(verdict.gapMs).toBe(0);
    expect(verdict.flatten).toBe(false);
  });
});
