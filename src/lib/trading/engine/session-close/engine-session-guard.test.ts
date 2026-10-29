/**
 * The clock-driven session-end force-flat.
 *
 * Everything here is about *when* the flatten fires. Both pre-existing
 * callers of `isInAnySessionWindow` are market-data-triggered — one needs
 * SignalR trade frames, the other sits behind `latestBar.timestamp ===
 * lastBarTimestamp`, which is the normal state between bar closes — so in
 * passive mode session-end force-flat was late by up to one timeframe, an
 * hour on a 1h deployment. Being past a prop firm's stated flat-by time is a
 * rule violation, not a bad fill. See docs/bugs.md.
 *
 * The predicate is deliberately untouched, so these tests assert the trigger
 * and nothing about the rule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// The guard reads exactly these two per pass, to union DB-open trades into
// its candidate set. Enumerated rather than spread — neither module is a leaf.
vi.mock("@/lib/db/trades", () => ({
  getAllOpenTrades: vi.fn(() => []),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
}));

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(),
}));

// The gate's own rule — held passes, a loss is said once — is pinned in
// `db/lease.test.ts`; here it is a switch, held unless a test drops it.
const lease = vi.hoisted(() => ({ held: true, refusedAt: [] as string[] }));
vi.mock("@/lib/db/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/lease")>()),
  leaseGate: (door: string) => () => {
    if (lease.held) return true;
    lease.refusedAt.push(door);
    return false;
  },
}));

import type { Contract } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { OpenPosition, StrategyModule } from "../../strategy-types";
import type { DeploymentState } from "../engine";
import { getAllOpenTrades } from "@/lib/db/trades";
import { getDeployment } from "@/lib/db/deployments";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { FlattenCooldown, FLATTEN_COOLDOWN_MS } from "../engine-flatten-cooldown";
import {
  SessionEndGuard,
  SESSION_END_GUARD_FAILURE_REPORT_MS,
  SESSION_END_GUARD_INTERVAL_MS,
  type SessionGuardDeps,
} from "./engine-session-guard";

const DEPLOY = "deploy-aaa";
const ACCT = 4242;
const CONTRACT_ID = "CON.F.US.MNQ.U26";

/** 2026-08-24 is a Monday. 21:30 UTC = 17:30 ET, past a 09:30–16:00 window. */
const OUT_OF_WINDOW = new Date("2026-08-24T21:30:00.000Z");
/** 14:30 UTC = 10:30 ET, inside it. */
const IN_WINDOW = new Date("2026-08-24T14:30:00.000Z");

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: DEPLOY,
    accountId: ACCT,
    ticker: "MNQ",
    strategyKey: "test-strategy",
    enabled: true,
    paramValues: {},
    groupId: null,
    ...over,
  } as unknown as Deployment;
}

function position(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: 0,
    entryPrice: 21000,
    entryTimestamp: "2026-08-24T13:35:00.000Z",
    barsSinceEntry: 4,
    entryFilledAt: "2026-08-24T13:35:02.000Z",
    size: 2,
    slTicks: 40,
    ...over,
  } as OpenPosition;
}

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return {
    lastBarTimestamp: null,
    cooldownAnchorAt: null,
    position: position(),
    activeTradeId: 77,
    breakEvenMoved: false,
    preEntryOrderIds: null,
    activeTpTicks: 80,
    activeSlTicks: 40,
    slMovedToBe: false,
    slCurrentPrice: 20990,
    tpCurrentPrice: 21020,
    ...over,
  } as DeploymentState;
}

const CONTRACT = { id: CONTRACT_ID, tickSize: 0.25 } as unknown as Contract;
/** The window every fixture deployment here trades. It is the playbook's, so
 *  it lives on the module rather than in the row's `paramValues`. */
const STRATEGY = {
  params: {},
  config: { session: { start: "09:30", end: "16:00", timezone: "America/New_York" } },
} as unknown as StrategyModule;

/** One DB-open trade row for `deploymentId`. Only the two fields the
 *  candidate set reads are supplied; the guard never touches the rest. */
function openTradeRow(deploymentId: string, contractId = CONTRACT_ID) {
  return [{ deploymentId, contractId }] as unknown as ReturnType<typeof getAllOpenTrades>;
}

/**
 * The guard's compliance alarm, and only that.
 *
 * `logEvent` now also carries the flatten announcement and the cooldown
 * deferral, so a bare call count answers "did the guard say anything"
 * rather than "did the guard escalate" — which is the question every
 * throttle assertion in this file is asking.
 */
function stranded(logEvent: ReturnType<typeof vi.fn>): unknown[][] {
  return logEvent.mock.calls.filter((c) => c[0] === "session_exit_stranded");
}

function makeGuard(over: Partial<SessionGuardDeps> = {}) {
  const depl = deployment();
  const st = state();
  const log = vi.fn();
  const logEvent = vi.fn();
  const placeExitOrder = vi.fn().mockResolvedValue(undefined);
  const flattenCooldown = over.flattenCooldown ?? new FlattenCooldown();
  const deps: SessionGuardDeps = {
    log,
    logEvent,
    realtimeDeployments: () => [depl],
    isLegInExitLoop: () => true,
    stateFor: () => st,
    resolveContract: vi.fn().mockResolvedValue(CONTRACT),
    placeExitOrder,
    flattenCooldown,
    ...over,
  };
  return { guard: new SessionEndGuard(deps), deps, log, logEvent, placeExitOrder, depl, st, flattenCooldown };
}

// One clock for the whole file. Every assertion here is about *when* the
// flatten fires, so the system time is the input under test; swapping timer
// implementations mid-test would strand it.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(getStrategy).mockReturnValue(STRATEGY);
  vi.mocked(getAllOpenTrades).mockReturnValue([]);
  vi.mocked(getDeployment).mockReturnValue(null);
  lease.held = true;
  lease.refusedAt = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionEndGuard — without the engine lease", () => {
  // It survives `stop()`, so a lost lease does not disarm it.
  it("flattens nothing past the window and asks at its own door", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, placeExitOrder, st } = makeGuard();
    lease.held = false;

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(st.position).not.toBeNull();
    expect(lease.refusedAt).toEqual(["the session-end guard"]);
  });
});

describe("SessionEndGuard — the trigger", () => {
  it("force-exits an open position outside its session window with no bar and no tick", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, placeExitOrder, depl, st } = makeGuard();

    await guard.runSessionEndGuard();

    // Nothing bar-shaped was supplied and no trade frame arrived — the pass
    // is driven entirely by the wall clock. That is the whole fix.
    expect(placeExitOrder).toHaveBeenCalledTimes(1);
    expect(placeExitOrder).toHaveBeenCalledWith(
      STRATEGY,
      depl,
      CONTRACT,
      expect.objectContaining({ size: 2 }),
      77,
      "time_window_close",
    );
    expect(st.position).toBeNull();
  });

  /**
   * The Activity lane's `{time}` slot. The guard is one of two sites that
   * emit `session_end_flatten`, and the value it hands over is the end of
   * the window that most recently closed — *"Session ended at 16:00 NY —
   * closed the MNQ position"*. The message is unchanged and still names the
   * whole window list, which is what the diagnostics lane and every grep
   * have always read.
   */
  it("names the window that closed, without moving the message", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, logEvent } = makeGuard();

    await guard.runSessionEndGuard();

    expect(logEvent).toHaveBeenCalledWith(
      "session_end_flatten",
      DEPLOY,
      "[SESSION] Clock guard: outside all session windows (09:30–16:00 NY) — force-exiting",
      expect.objectContaining({ values: { time: "at 16:00 NY" } }),
    );
  });

  it("does nothing when the position is inside its session window", async () => {
    vi.setSystemTime(IN_WINDOW);
    const resolveContract = vi.fn().mockResolvedValue(CONTRACT);
    const { guard, placeExitOrder } = makeGuard({ resolveContract });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    // The property that matters for "inert in normal operation" is that an
    // in-window position costs zero broker calls — which holds only while the
    // window check precedes the resolve. Asserting the exit alone would still
    // pass if someone hoisted the resolve above it.
    expect(resolveContract).not.toHaveBeenCalled();
  });

  it("does nothing when the tick-driven path already flattened — zero behaviour change in realtime mode", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    // `evaluateRealtimeExits` fires on the boundary tick and nulls `position`.
    // The guard's next pass must find nothing to do, and must not reach the
    // broker to discover that.
    const resolveContract = vi.fn().mockResolvedValue(CONTRACT);
    const { guard, placeExitOrder } = makeGuard({
      stateFor: () => state({ position: null }),
      resolveContract,
    });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(resolveContract).not.toHaveBeenCalled();
  });

  it("clears the full position state block, matching the other force-exit sites", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, st } = makeGuard();

    await guard.runSessionEndGuard();

    expect(st.position).toBeNull();
    expect(st.breakEvenMoved).toBe(false);
    expect(st.activeTpTicks).toBeNull();
    expect(st.activeSlTicks).toBeNull();
    expect(st.slMovedToBe).toBe(false);
    expect(st.slCurrentPrice).toBeNull();
    expect(st.tpCurrentPrice).toBeNull();
    expect(st.cooldownAnchorAt).toBe(OUT_OF_WINDOW.toISOString());
  });

  it("re-reads position after the contract resolve and skips a close that landed during it", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const live = state();
    const closed = state({ position: null });
    let call = 0;
    // First read is the pre-check that decides the resolve is worth paying
    // for; the second is the one whose value reaches placeExitOrder. A
    // user-hub close event landing in between must win.
    const { guard, placeExitOrder } = makeGuard({
      stateFor: () => (call++ === 0 ? live : closed),
    });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
  });
});

describe("SessionEndGuard — the exit latch", () => {
  it("treats EXIT_IN_FLIGHT as already-happening, not as a failure", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, log, logEvent, st } = makeGuard({
      placeExitOrder: vi.fn().mockRejectedValue(new Error(EntryExitCode.EXIT_IN_FLIGHT)),
    });

    await guard.runSessionEndGuard();

    // The exit the guard wanted is on the wire. Raising a compliance alarm
    // here would alarm about the flatten at the moment it is succeeding.
    expect(stranded(logEvent)).toHaveLength(0);
    // And the other caller owns the state teardown — the guard must not
    // clobber it out from under an exit it did not place.
    expect(st.position).not.toBeNull();
  });

  // The 2026-08-26 incident (docs/bugs.md): the exit resolved the *other*
  // broker's contract, the broker answered "no position" for a contract that
  // account never held, and the skip returned normally — so the guard nulled
  // the mirror over an exit that placed nothing, and every later pass gated on
  // that null and could not act.
  it("keeps the mirror when the exit submitted nothing against an open trade row", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, log, logEvent, st } = makeGuard({
      placeExitOrder: vi.fn().mockRejectedValue(new Error(EntryExitCode.EXIT_FLAT_MISMATCH)),
    });

    await guard.runSessionEndGuard();

    expect(st.position).not.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "session_exit_stranded",
      DEPLOY,
      expect.stringContaining("could not force-flat past session close"),
      expect.objectContaining({ accountId: ACCT }),
    );
  });

  // The other arm, and the common one: an exit that reached the wire — or a
  // genuinely flat book with no open row behind it — still settles the mirror.
  it("clears the mirror when the exit returns normally", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, log, logEvent, st } = makeGuard();

    await guard.runSessionEndGuard();

    expect(st.position).toBeNull();
    expect(stranded(logEvent)).toHaveLength(0);
  });
});

describe("SessionEndGuard — an unreachable broker", () => {
  it("keeps the position for retry and reports at error rather than giving up", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, log, logEvent, st } = makeGuard({
      placeExitOrder: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    await guard.runSessionEndGuard();

    expect(st.position).not.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "session_exit_stranded",
      DEPLOY,
      expect.stringContaining("could not force-flat past session close"),
      expect.objectContaining({ accountId: ACCT }),
    );
  });

  it("reports a contract-resolve failure without attempting an exit", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const placeExitOrder = vi.fn();
    const { guard, log, logEvent } = makeGuard({
      resolveContract: vi.fn().mockRejectedValue(new Error("resolver down")),
      placeExitOrder,
    });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "session_exit_stranded",
      DEPLOY,
      expect.stringContaining("contract resolve failed"),
      expect.objectContaining({ accountId: ACCT }),
    );
  });

  it("throttles a persistent failure to one report per window while still retrying every pass", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const placeExitOrder = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { guard, log, logEvent } = makeGuard({ placeExitOrder });

    await guard.runSessionEndGuard();
    vi.setSystemTime(new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_INTERVAL_MS));
    await guard.runSessionEndGuard();

    const errors = () => stranded(logEvent);
    expect(placeExitOrder).toHaveBeenCalledTimes(2);
    expect(errors()).toHaveLength(1);

    vi.setSystemTime(new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_FAILURE_REPORT_MS + 1));
    await guard.runSessionEndGuard();

    // Still failing minutes later — the operator hears about it again, and
    // the line says how long the position has been stranded.
    expect(errors()).toHaveLength(2);
    expect(errors()[1][2]).toContain("outside its session window for 300s");
  });
});

/**
 * A prod build registers six playbooks (strategies/prod-playbooks.ts). A row of
 * any other key holding a position has no window to read and no module to
 * build an exit from, so the guard cannot flatten it — and must not go quiet.
 */
describe("SessionEndGuard — a position on a playbook this build does not register", () => {
  const unmanaged = (logEvent: ReturnType<typeof vi.fn>) =>
    logEvent.mock.calls.filter((c) => c[0] === "deployment_playbook_unavailable_in_position");

  it("reports it at error, throttled, and submits nothing", async () => {
    vi.setSystemTime(IN_WINDOW);
    vi.mocked(getStrategy).mockReturnValue(undefined);
    const { guard, logEvent, placeExitOrder, deps } = makeGuard();

    await guard.runSessionEndGuard();
    vi.setSystemTime(new Date(IN_WINDOW.getTime() + SESSION_END_GUARD_INTERVAL_MS));
    await guard.runSessionEndGuard();

    expect(unmanaged(logEvent)).toHaveLength(1);
    expect(unmanaged(logEvent)[0][1]).toBe(DEPLOY);
    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(deps.resolveContract).not.toHaveBeenCalled();
    // It cannot know the window, so it does not claim the session ended.
    expect(stranded(logEvent)).toEqual([]);

    vi.setSystemTime(new Date(IN_WINDOW.getTime() + SESSION_END_GUARD_FAILURE_REPORT_MS + 1));
    await guard.runSessionEndGuard();

    expect(unmanaged(logEvent)).toHaveLength(2);
    expect(unmanaged(logEvent)[1][2]).toContain("for 300s");
  });

  // The lost-mirror case: no window to test, so it cannot wait for the close
  // the way a registered leg's null mirror does — and must not go silent.
  it("reports a null mirror over an open trade row as unregistered on the second sighting, and submits nothing", async () => {
    vi.setSystemTime(IN_WINDOW);
    vi.mocked(getStrategy).mockReturnValue(undefined);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, logEvent, placeExitOrder, deps } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();
    vi.setSystemTime(new Date(IN_WINDOW.getTime() + SESSION_END_GUARD_INTERVAL_MS));
    await guard.runSessionEndGuard();

    expect(unmanaged(logEvent)).toHaveLength(1);
    expect(unmanaged(logEvent)[0][1]).toBe(DEPLOY);
    expect(stranded(logEvent)).toEqual([]);
    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(deps.resolveContract).not.toHaveBeenCalled();
  });

  // The ghost sweep nulls the mirror while a bracket fill has not yet reached
  // the row, so one sighting is an ordinary bracket exit, not an alarm.
  it("says nothing on a single null-mirror pass over an open row", async () => {
    vi.setSystemTime(IN_WINDOW);
    vi.mocked(getStrategy).mockReturnValue(undefined);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();

    expect(logEvent).not.toHaveBeenCalled();
  });

  it("starts over once the row is no longer open between sightings", async () => {
    vi.setSystemTime(IN_WINDOW);
    vi.mocked(getStrategy).mockReturnValue(undefined);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();
    // The bracket fill reached the row: closed, so no longer a candidate.
    vi.mocked(getAllOpenTrades).mockReturnValue([]);
    await guard.runSessionEndGuard();
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    await guard.runSessionEndGuard();

    expect(unmanaged(logEvent)).toEqual([]);
  });
});

describe("SessionEndGuard — the candidate set", () => {
  it("covers a deployment the engine no longer lists but that holds a DB-open trade", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const orphan = deployment({ id: "deploy-orphan" });
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow("deploy-orphan"));
    vi.mocked(getDeployment).mockReturnValue(orphan);

    // `stop()` clears `realtimeDeployments` but not `this.state`. Without the
    // DB half of the union, a guard armed past a fatal-auth stop would have
    // nothing to sweep — which is the lifetime property it exists for.
    const { guard, placeExitOrder } = makeGuard({ realtimeDeployments: () => [] });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).toHaveBeenCalledWith(
      STRATEGY,
      orphan,
      CONTRACT,
      expect.anything(),
      77,
      "time_window_close",
    );
  });

  it("sweeps the in-memory set when the DB read throws", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    vi.mocked(getAllOpenTrades).mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { guard, placeExitOrder } = makeGuard();

    await guard.runSessionEndGuard();

    expect(placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("skips a leg outside the exit loop", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, placeExitOrder } = makeGuard({ isLegInExitLoop: () => false });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
  });
});

describe("SessionEndGuard — a null position mirror", () => {
  it("stays silent when the leg is genuinely flat — no open row, nothing to say", async () => {
    // The common case in realtime mode: a tick-driven exit fired on the
    // boundary and retired the row. If this ever logs, the alarm below is
    // noise and will be ignored the day it matters.
    vi.setSystemTime(OUT_OF_WINDOW);
    const { guard, log, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();

    expect(log).not.toHaveBeenCalled();
  });

  it("reports at error when a DB-open row exists past the window and the mirror is null", async () => {
    // The 2026-08-25 incident: a Topstep leg held a position past its 14:40
    // cutoff, the mirror was null, this arm skipped it, and the log showed
    // ERROR (0). The union that exists to catch that leg discarded it here.
    vi.setSystemTime(OUT_OF_WINDOW);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, log, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();

    const errors = logEvent.mock.calls;
    expect(errors).toHaveLength(1);
    // The escalation carries its event now, which is what routes it to
    // Discord; the deployment id moved into the second slot with it.
    expect(errors[0][0]).toBe("session_exit_stranded");
    expect(errors[0][1]).toBe(DEPLOY);
    expect(errors[0][2]).toContain(CONTRACT_ID);
    expect(errors[0][2]).toContain("may still be open at the broker");
  });

  it("stays silent on an open row while the window is still open", async () => {
    // A null mirror in-window is not the guard's business at all — it has no
    // opinion about a position it is not yet allowed to close.
    vi.setSystemTime(IN_WINDOW);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, log, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();

    expect(log).not.toHaveBeenCalled();
  });

  it("is a smoke alarm, not a flatten — it reaches neither the resolver nor the broker", async () => {
    // The underlying null-mirror bug is not root-caused, so this arm must not
    // grow an exit path. There is no position to hand `placeExitOrder`.
    vi.setSystemTime(OUT_OF_WINDOW);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const resolveContract = vi.fn().mockResolvedValue(CONTRACT);
    const { guard, placeExitOrder } = makeGuard({
      stateFor: () => state({ position: null }),
      resolveContract,
    });

    await guard.runSessionEndGuard();

    expect(resolveContract).not.toHaveBeenCalled();
    expect(placeExitOrder).not.toHaveBeenCalled();
  });

  it("throttles the alarm so a stranded leg does not put four lines a minute in the log", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    vi.mocked(getAllOpenTrades).mockReturnValue(openTradeRow(DEPLOY));
    const { guard, log, logEvent } = makeGuard({ stateFor: () => state({ position: null }) });

    await guard.runSessionEndGuard();
    vi.setSystemTime(new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_INTERVAL_MS));
    await guard.runSessionEndGuard();

    const errors = () => stranded(logEvent);
    expect(errors()).toHaveLength(1);

    vi.setSystemTime(new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_FAILURE_REPORT_MS + 1));
    await guard.runSessionEndGuard();

    expect(errors()).toHaveLength(2);
    expect(errors()[1][2]).toContain("outside its session window for 300s");
  });
});

describe("SessionEndGuard — the shared flatten cooldown", () => {
  it("defers rather than dispatching while another actor's flatten may be unbooked", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const flattenCooldown = new FlattenCooldown();
    flattenCooldown.note(ACCT, CONTRACT_ID, "watchdog");
    const { guard, placeExitOrder, logEvent } = makeGuard({ flattenCooldown });

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "flatten_deferred",
      DEPLOY,
      expect.stringContaining("deferring this pass"),
      expect.anything(),
    );
  });

  it("keeps the failure anchor across a deferral, so a leg deferred repeatedly still escalates", async () => {
    // The obligation is the point. A cooldown hit costs one pass; clearing the
    // anchor would restart the stranded-for-Ns clock every 15s and the
    // operator would never see a duration worth acting on.
    vi.setSystemTime(OUT_OF_WINDOW);
    const flattenCooldown = new FlattenCooldown();
    const { guard, log, logEvent } = makeGuard({
      flattenCooldown,
      placeExitOrder: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    await guard.runSessionEndGuard();
    const errors = () => stranded(logEvent);
    expect(errors()).toHaveLength(1);

    // A rival actor stamps, so the pass that would have re-reported defers.
    vi.setSystemTime(new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_FAILURE_REPORT_MS + 1));
    flattenCooldown.note(ACCT, CONTRACT_ID, "watchdog");
    await guard.runSessionEndGuard();
    expect(errors()).toHaveLength(1);

    vi.setSystemTime(
      new Date(OUT_OF_WINDOW.getTime() + SESSION_END_GUARD_FAILURE_REPORT_MS + FLATTEN_COOLDOWN_MS + 2),
    );
    await guard.runSessionEndGuard();

    // Counted from the first failure, not from the deferral.
    expect(errors()).toHaveLength(2);
    expect(errors()[1][2]).toContain("outside its session window for 330s");
  });

  it("stamps before the submit and releases when nothing reached the wire", async () => {
    vi.setSystemTime(OUT_OF_WINDOW);
    const flattenCooldown = new FlattenCooldown();
    const { guard } = makeGuard({
      flattenCooldown,
      placeExitOrder: vi.fn().mockRejectedValue(new Error("order rejected")),
    });

    await guard.runSessionEndGuard();

    // `placeExitOrderInner` cannot throw past a successful `placeOrder`, so a
    // throw means nothing is on the book and holding the stamp would only cost
    // the compliance path its next retry.
    expect(flattenCooldown.active(ACCT, CONTRACT_ID)).toBe(false);
  });

  it("keeps the stamp on EXIT_IN_FLIGHT — an exit really is on the wire for this contract", async () => {
    // Unlike D-2, whose EXIT_IN_FLIGHT comes from a different position's exit.
    // The tick-driven exit path stamps nothing of its own, so dropping this
    // would leave the watchdog unguarded for that exit's whole fill latency.
    vi.setSystemTime(OUT_OF_WINDOW);
    const flattenCooldown = new FlattenCooldown();
    const { guard } = makeGuard({
      flattenCooldown,
      placeExitOrder: vi.fn().mockRejectedValue(new Error(EntryExitCode.EXIT_IN_FLIGHT)),
    });

    await guard.runSessionEndGuard();

    expect(flattenCooldown.active(ACCT, CONTRACT_ID)).toBe(true);
  });
});

describe("SESSION_END_GUARD_INTERVAL_MS", () => {
  it("is decisively faster than the smallest supported timeframe", () => {
    // The guard exists to bound how late a flatten can be. A cadence at or
    // near the 1m bar it backstops would reproduce the defect.
    expect(SESSION_END_GUARD_INTERVAL_MS).toBeLessThanOrEqual(60_000 / 4);
  });
});

/**
 * A63's live half. The guard evaluated a fixed `HH:MM` pair with no
 * exchange-calendar term, so on a 13:00 ET close it took the in-window branch
 * for ~700 consecutive passes and then, at 15:55, submitted a market order
 * into a market that had shut three hours earlier. The branch where the
 * broker *accepts* it is the worse one: the guard nulls `position` and the
 * engine believes it is flat while an unfilled order rests against a live one.
 *
 * 2026-11-26 is Thanksgiving Day — a 13:00 ET halt, so the effective end is
 * 12:55 once the flatten cushion is applied. EST, so ET = UTC−5.
 */
describe("SessionEndGuard — exchange early close", () => {
  const HALF_DAY_1255 = new Date("2026-11-26T17:55:00.000Z");
  const HALF_DAY_1250 = new Date("2026-11-26T17:50:00.000Z");
  /** Same wall clock, the Wednesday before — a full session. */
  const FULL_DAY_1255 = new Date("2026-11-25T17:55:00.000Z");
  /** The hour the guard used to fire at, on the same half-day. */
  const HALF_DAY_1555 = new Date("2026-11-26T20:55:00.000Z");

  it("force-exits at 12:55 ET on a 13:00-close session, hours before the declared window ends", async () => {
    vi.setSystemTime(HALF_DAY_1255);
    const { guard, placeExitOrder, st } = makeGuard();

    await guard.runSessionEndGuard();

    expect(placeExitOrder).toHaveBeenCalledTimes(1);
    expect(placeExitOrder).toHaveBeenCalledWith(
      STRATEGY,
      expect.anything(),
      CONTRACT,
      expect.objectContaining({ size: 2 }),
      77,
      "time_window_close",
    );
    expect(st.position).toBeNull();
  });

  it("is still inert five minutes earlier, and has not paid for a contract resolve", async () => {
    vi.setSystemTime(HALF_DAY_1250);
    const { guard, placeExitOrder, deps } = makeGuard();

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
    // The calendar term sits behind the window check, not in front of it —
    // asserting only "no exit fired" would keep passing if the resolve were
    // hoisted above either one.
    expect(deps.resolveContract).not.toHaveBeenCalled();
  });

  it("leaves a full session alone at the same wall clock", async () => {
    vi.setSystemTime(FULL_DAY_1255);
    const { guard, placeExitOrder } = makeGuard();

    await guard.runSessionEndGuard();

    expect(placeExitOrder).not.toHaveBeenCalled();
  });

  /**
   * The Globex reopen is 18:00 ET, so 15:55 on a half-day is still inside the
   * halt — and by then the position was flattened three hours ago anyway.
   * What this pins is that the flatten did not merely *move*: the guard must
   * not decide the halt is over at the declared window end.
   */
  it("does not treat the declared window end as a reopen", async () => {
    vi.setSystemTime(HALF_DAY_1555);
    const { guard, logEvent } = makeGuard();

    await guard.runSessionEndGuard();

    const flattens = logEvent.mock.calls.filter((c) => c[0] === "session_end_flatten");
    expect(flattens).toHaveLength(1);
  });
});

/**
 * Past the far end of the calendar the platform cannot tell an early close
 * from a normal one, and *"absent from the table"* silently means *"trades a
 * full session"* — which is the A63 assumption. It escalates rather than
 * standing the account down: the table is a ten-minute edit and standing down
 * costs every session until someone makes it.
 */
describe("SessionEndGuard — the calendar horizon", () => {
  /** Inside the window on a full session, so nothing else in the pass fires. */
  function atEtDate(etDate: string): Date {
    return new Date(`${etDate}T15:30:00.000Z`); // 10:30 ET
  }

  it("says nothing while the calendar has more than a quarter left", async () => {
    vi.setSystemTime(atEtDate("2027-06-01"));
    const { guard, logEvent, log } = makeGuard();

    await guard.runSessionEndGuard();

    expect(logEvent.mock.calls.filter((c) => c[0] === "session_calendar_stale")).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("warns as the horizon approaches, without escalating yet", async () => {
    vi.setSystemTime(atEtDate("2027-11-02")); // 59 days out
    const { guard, logEvent, log } = makeGuard();

    await guard.runSessionEndGuard();

    expect(logEvent.mock.calls.filter((c) => c[0] === "session_calendar_stale")).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      "warn",
      "safety",
      expect.stringContaining("early-close calendar"),
    );
  });

  it("escalates a month before the horizon, not after it", async () => {
    vi.setSystemTime(atEtDate("2027-12-10")); // 21 days out
    const { guard, logEvent } = makeGuard();

    await guard.runSessionEndGuard();

    expect(logEvent.mock.calls.filter((c) => c[0] === "session_calendar_stale")).toHaveLength(1);
  });

  it("keeps escalating past the horizon, once a day rather than every pass", async () => {
    vi.setSystemTime(atEtDate("2028-03-06"));
    const { guard, logEvent } = makeGuard();

    await guard.runSessionEndGuard();
    await vi.advanceTimersByTimeAsync(SESSION_END_GUARD_INTERVAL_MS);
    await guard.runSessionEndGuard();

    expect(logEvent.mock.calls.filter((c) => c[0] === "session_calendar_stale")).toHaveLength(1);
  });

  it("says nothing at all when no deployment could be holding a position", async () => {
    vi.setSystemTime(atEtDate("2028-03-06"));
    const { guard, logEvent, log } = makeGuard({ realtimeDeployments: () => [] });

    await guard.runSessionEndGuard();

    expect(logEvent).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
