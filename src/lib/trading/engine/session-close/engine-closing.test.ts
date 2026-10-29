/**
 * The closing guard: what actually drives a `Pausing` / `Destroying` row to
 * completion, and — the property the whole design exists for — what it
 * refuses to do before the position is confirmed flat.
 *
 * `./strategies` is mocked because the strategy loader uses webpack's
 * `require.context`, which has no vitest equivalent (patterns.md).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(() => ({ config: { timeframe: "1m" }, params: [] })),
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

import type { Contract, Order, Position } from "@/lib/brokers/types";
import type { Broker } from "../../broker-access/broker";
import { forceFlatDeployment, type ForceFlatDeps, type ForceFlatResult } from "../flatten/engine-force-flat";
import { FlattenCooldown } from "../engine-flatten-cooldown";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment, DeploymentStatus } from "@/lib/trading/domain";
import type { DeploymentState } from "../engine";
import {
  ALREADY_FLAT_REPORT_AFTER_MS,
  ClosingGuard,
  CLOSING_GUARD_FAILURE_REPORT_MS,
  CLOSING_GUARD_INTERVAL_MS,
  type ClosingGuardDeps,
} from "./engine-closing";
import { EVENTS } from "@/lib/logging/vocabulary";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import { getStrategy } from "../../strategies";

const DEPL = "depl-1";

function deployment(status: DeploymentStatus, over: Partial<Deployment> = {}): Deployment {
  return {
    id: DEPL,
    strategyKey: "test",
    accountId: 4242,
    ticker: "/MNQ",
    contractId: null,
    status,
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

type Harness = {
  guard: ClosingGuard;
  deps: ClosingGuardDeps;
  logs: Array<[string, string, string]>;
  setRow(next: Deployment | null): void;
  setState(next: DeploymentState | undefined): void;
  setOpenTrade(open: boolean): void;
  setTrade(next: StrategyTrade | null): void;
  /** Live rows behind the newest one, which `openTradeFor` does not show. */
  setOlderLiveTrades(rows: StrategyTrade[]): void;
  currentState(): DeploymentState | undefined;
  broker: {
    cancelOrder: ReturnType<typeof vi.fn>;
    searchOpenOrders: ReturnType<typeof vi.fn>;
    searchOpenPositions: ReturnType<typeof vi.fn>;
  };
};

const ENTRY_ORDER_ID = 5150;
const CONTRACT_ID = "CON.F.US.MNQ.M26";

function trade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    id: 77,
    deploymentId: DEPL,
    accountId: 4242,
    contractId: CONTRACT_ID,
    status: "open",
    entryOrderId: ENTRY_ORDER_ID,
    ...over,
  } as StrategyTrade;
}

/** What the deps double reads and writes; the harness setters mutate it. */
type World = {
  row: Deployment | null;
  deplState: DeploymentState | undefined;
  openTrade: StrategyTrade | null;
  olderLiveTrades: StrategyTrade[];
  logs: Array<[string, string, string]>;
  broker: Harness["broker"];
};

function makeDeps(world: World, overrides: Partial<ClosingGuardDeps> = {}): ClosingGuardDeps {
  // The guard reaches only these three broker methods.
  const broker = world.broker as unknown as Broker;
  const deps = {
    log: vi.fn((d: string, severity: string, _category: string, m: string) => {
      world.logs.push([d, severity, m]);
    }),
    // Recorded under the *registry's* severity, not an argument: every line
    // this guard emits names an event, and the point of an event is that
    // its severity is settled in one place. `EVENTS` is that place.
    logEvent: vi.fn((event: string, d: string, m: string) => {
      world.logs.push([d, EVENTS[event]?.severity ?? "info", m]);
    }),
    listClosing: vi.fn(() => (world.row && world.row.status !== "Paused" ? [world.row] : [])),
    getDeployment: vi.fn(() => world.row),
    openTradeFor: vi.fn(() => world.openTrade),
    liveTradesFor: vi.fn(() =>
      world.openTrade ? [...world.olderLiveTrades, world.openTrade] : world.olderLiveTrades,
    ),
    brokerForAccount: vi.fn(() => broker),
    stateFor: vi.fn(() => world.deplState),
    resolveContract: vi.fn(
      async (): Promise<Contract> =>
        ({ id: "CON.F.US.MNQ.M26", name: "MNQ", tickSize: 0.25, tickValue: 0.5 }) as Contract,
    ),
    placeExitOrder: vi.fn(async () => {}),
    forceFlat: vi.fn(async (id: string): Promise<ForceFlatResult> => {
      world.deplState = world.deplState ? { ...world.deplState, position: null } : world.deplState;
      return { deploymentId: id, accountId: 4242, contractId: "CON.F.US.MNQ.M26", status: "closed", size: 1, orderId: 9 };
    }),
    settlePausing: vi.fn(() => {
      if (world.row) world.row = { ...world.row, status: "Paused" };
      return true;
    }),
    reapDestroying: vi.fn(() => {
      if (world.row) world.row = { ...world.row, status: "Paused", deletedAt: "2026-01-01T15:00:00Z" };
      return { groupId: null };
    }),
    onSettled: vi.fn(),
  } satisfies ClosingGuardDeps;
  return { ...deps, ...overrides };
}

function makeGuard(opts: {
  status?: DeploymentStatus;
  openTrade?: boolean;
  /** The open row itself; overrides `openTrade`. */
  trade?: StrategyTrade | null;
  state?: DeploymentState;
  over?: Partial<ClosingGuardDeps>;
} = {}): Harness {
  const world: World = {
    row: deployment(opts.status ?? "Pausing"),
    deplState: opts.state ?? withPosition(),
    openTrade: opts.trade !== undefined ? opts.trade : (opts.openTrade ?? true) ? trade() : null,
    olderLiveTrades: [],
    logs: [],
    broker: {
      cancelOrder: vi.fn(async () => {}),
      searchOpenOrders: vi.fn(async (): Promise<Order[]> => []),
      searchOpenPositions: vi.fn(async (): Promise<Position[]> => []),
    },
  };
  const deps = makeDeps(world, opts.over);

  return {
    guard: new ClosingGuard(deps),
    deps,
    logs: world.logs,
    setRow(next) {
      world.row = next;
    },
    setState(next) {
      world.deplState = next;
    },
    setOpenTrade(open) {
      world.openTrade = open ? trade() : null;
    },
    setTrade(next) {
      world.openTrade = next;
    },
    setOlderLiveTrades(rows) {
      world.olderLiveTrades = rows;
    },
    broker: world.broker,
    currentState() {
      return world.deplState;
    },
  };
}

beforeEach(() => {
  vi.mocked(getStrategy).mockReturnValue({
    config: { timeframe: "1m" },
    params: [],
  } as unknown as ReturnType<typeof getStrategy>);
  lease.held = true;
  lease.refusedAt = [];
});

describe("without the engine lease", () => {
  // The guard survives `stop()`, so a lost lease does not disarm it.
  it("flattens, cancels and settles nothing, and asks at its own door", async () => {
    const open = makeGuard();
    const pendingEntry = makeGuard({ trade: trade({ status: "pending_entry", entryOrderId: 501 }), state: state() });
    const flat = makeGuard({ openTrade: false, state: state() });
    lease.held = false;

    await open.guard.runClosingGuard();
    await pendingEntry.guard.runClosingGuard();
    await flat.guard.runClosingGuard();

    expect(open.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(open.deps.forceFlat).not.toHaveBeenCalled();
    expect(pendingEntry.broker.cancelOrder).not.toHaveBeenCalled();
    expect(flat.deps.settlePausing).not.toHaveBeenCalled();
    expect(lease.refusedAt).toEqual(["the closing guard", "the closing guard", "the closing guard"]);
  });
});

describe("a Pause with an open position does not complete before the position is flat", () => {
  it("submits the exit and leaves the row Pausing", async () => {
    const h = makeGuard();

    await h.guard.runClosingGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.deps.onSettled).not.toHaveBeenCalled();
  });

  it("does not settle on submission — the trade row is still open", async () => {
    // The property D-5 exists for. `placeExitOrder` returns at *submission*
    // and its callers null `deplState.position` immediately, so the
    // in-memory half now says flat while the fill has not landed. Settling
    // here would report "Paused" over a live position.
    const h = makeGuard();
    await h.guard.runClosingGuard();
    expect(h.currentState()?.position).toBeNull();

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.deps.onSettled).not.toHaveBeenCalled();
  });

  it("does not settle on the prompt path either, while the trade row is open", async () => {
    const h = makeGuard({ state: state() });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("does not settle while the position is still in memory, trade row or not", () => {
    const h = makeGuard({ openTrade: false });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("settles only once both halves agree the deployment holds nothing", () => {
    const h = makeGuard({ openTrade: false, state: state() });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
    expect(h.deps.onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: DEPL }), "Pausing");
  });

  it("does not re-submit an exit once the position is gone from memory", async () => {
    const h = makeGuard({ state: state() });

    await h.guard.runClosingGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
  });
});

describe("EXIT_IN_FLIGHT is 'already happening', never a failure", () => {
  it("does not log an error when the latch refuses", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error(EntryExitCode.EXIT_IN_FLIGHT);
        }),
      },
    });

    await h.guard.runClosingGuard();

    expect(h.logs.filter(([, level]) => level === "error")).toEqual([]);
  });

  it("keeps the position so the next pass can still act", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error(EntryExitCode.EXIT_IN_FLIGHT);
        }),
      },
    });

    await h.guard.runClosingGuard();

    expect(h.currentState()?.position).not.toBeNull();
  });
});

describe("a position that vanishes during the contract resolve", () => {
  it("re-reads after the await and does not dispatch against a null position", async () => {
    // `handleUserPositionEvent` is void-dispatched with no `ticking` gate, so
    // a close landing inside `resolveContract` nulls `position` underneath the
    // guard. Without the re-read, `placeExitOrderInner` reads `.side` off null.
    // The pre-resolve check cannot catch this — it already passed.
    const h = makeGuard();
    h.deps.resolveContract = vi.fn(async () => {
      h.setState(undefined);
      return { id: "CON.F.US.MNQ.M26", name: "MNQ", tickSize: 0.25, tickValue: 0.5 } as Contract;
    });

    await h.guard.runClosingGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });
});

describe("a close that cannot be submitted", () => {
  it("reports an error and leaves the row closing", async () => {
    const h = makeGuard({
      over: {
        resolveContract: vi.fn(async () => {
          throw new Error("broker unreachable");
        }),
      },
    });

    await h.guard.runClosingGuard();

    expect(h.logs.some(([, level]) => level === "error")).toBe(true);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("keeps the position so the next pass retries", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error("rejected");
        }),
      },
    });

    await h.guard.runClosingGuard();

    expect(h.currentState()?.position).not.toBeNull();
  });

  it("throttles a repeated failure to one report", async () => {
    const h = makeGuard({
      over: {
        placeExitOrder: vi.fn(async () => {
          throw new Error("rejected");
        }),
      },
    });

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();

    expect(h.logs.filter(([, level]) => level === "error")).toHaveLength(1);
  });

});

/**
 * A prod build registers six playbooks (strategies/prod-playbooks.ts), so a
 * Pause on a row of any other key has no module to build an exit from.
 * `forceFlatDeployment` needs none; without it the row sat `Pausing` forever.
 */
describe("a closing row whose playbook this build does not register", () => {
  beforeEach(() => {
    vi.mocked(getStrategy).mockReturnValue(undefined as unknown as ReturnType<typeof getStrategy>);
  });

  it("flattens through forceFlatDeployment and leaves the row closing until flat", async () => {
    const h = makeGuard();

    await h.guard.runClosingGuard();

    expect(h.deps.forceFlat).toHaveBeenCalledWith(DEPL, { caller: "closing_guard" });
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.logs.filter(([, level]) => level === "error")).toEqual([]);
  });

  it("settles once the trade row and the mirror both say flat", async () => {
    const h = makeGuard();
    await h.guard.runClosingGuard();
    // `forceFlatDeployment` tears the mirror down; the reconciler closes the row.
    h.setState(state());
    h.setOpenTrade(false);

    await h.guard.runClosingGuard();

    expect(h.deps.forceFlat).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
  });

  it("reports a flatten that did not reach the wire, throttled, and retries every pass", async () => {
    const forceFlat = vi.fn(async () => ({
      deploymentId: DEPL,
      accountId: 4242,
      contractId: null,
      status: "error" as const,
      reason: "contract resolve failed: broker unreachable",
      positionMayStillBeOpen: true as const,
    }));
    const h = makeGuard({ over: { forceFlat } });

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();

    expect(forceFlat).toHaveBeenCalledTimes(2);
    const errors = h.logs.filter(([, level]) => level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0][2]).toContain("broker unreachable");
  });

  it("stands down without a report when another flatten actor holds the contract", async () => {
    const forceFlat = vi.fn(async () => ({
      deploymentId: DEPL,
      accountId: 4242,
      contractId: "CON.F.US.MNQ.M26",
      status: "deferred" as const,
      reason: "another flatten may still be unbooked",
      positionMayStillBeOpen: true as const,
      deferredTo: "session" as const,
    }));
    const h = makeGuard({ over: { forceFlat } });

    await h.guard.runClosingGuard();

    expect(h.logs.filter(([, level]) => level === "error")).toEqual([]);
  });

  /**
   * The real primitive behind the guard, with the broker down. Its default
   * failure line, `deployment_flatten_failed`, is the one alert the
   * notifications kill-switch does not silence; from a 15s loop that is an
   * alert nobody can stop. The guard's own throttled line is the only one.
   */
  it("alerts only through deployment_close_stranded, never deployment_flatten_failed, on any pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-10-27T15:00:00Z").getTime();
      vi.setSystemTime(t0);
      const events: string[] = [];
      const logEvent = vi.fn((event: string) => {
        events.push(event);
      });
      const row = deployment("Pausing");
      const ffDeps: ForceFlatDeps = {
        logEvent,
        getDeployment: () => row,
        stateFor: () => undefined,
        brokerForAccount: () => ({}) as unknown as Broker,
        resolveContract: vi.fn(async (): Promise<Contract> => {
          throw new Error("broker unreachable");
        }),
        maybeOrphanFromBrokerError: vi.fn(),
        buildCustomTag: (prefix, identity) => `${prefix}_${identity}`,
        cancelTrackedBrackets: vi.fn(async () => "clean" as const),
        verifyExitClean: vi.fn(async () => {}),
        flattenCooldown: new FlattenCooldown(),
      };
      const h = makeGuard({
        over: {
          logEvent,
          forceFlat: (id, options) => forceFlatDeployment(ffDeps, id, options),
        },
      });

      await h.guard.runClosingGuard();
      vi.setSystemTime(t0 + CLOSING_GUARD_INTERVAL_MS);
      await h.guard.runClosingGuard();
      vi.setSystemTime(t0 + CLOSING_GUARD_FAILURE_REPORT_MS + 1);
      await h.guard.runClosingGuard();

      expect(ffDeps.resolveContract).toHaveBeenCalledTimes(3);
      // The set of events that page, not the absence of one name: a rename
      // of the paging event cannot make this pass vacuously.
      expect(new Set(events.filter((e) => EVENTS[e]?.escalates))).toEqual(
        new Set(["deployment_close_stranded"]),
      );
      expect(events.filter((e) => e === "deployment_close_stranded")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The mirror holds a position, the broker has nothing on the front month.
   * The reconciler gets at least one tick to resolve it; past that it is a
   * back-month position after a roll, which `already_flat` answers forever.
   * Timed rather than counted: a nudge and the interval can run two passes
   * milliseconds apart.
   */
  describe("an already_flat while the mirror still holds a position", () => {
    const alreadyFlat = (): ForceFlatResult => ({
      deploymentId: DEPL,
      accountId: 4242,
      contractId: CONTRACT_ID,
      status: "already_flat",
      reason: "the broker holds no position on this contract",
    });
    const t0 = new Date("2026-10-27T15:00:00Z").getTime();
    const errors = (h: Harness) => h.logs.filter(([, level]) => level === "error");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(t0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("says nothing on two passes 1 ms apart, then reports once the window has passed", async () => {
      const h = makeGuard({ over: { forceFlat: vi.fn(async () => alreadyFlat()) } });

      await h.guard.runClosingGuard();
      vi.setSystemTime(t0 + 1);
      await h.guard.runClosingGuard();
      expect(errors(h)).toEqual([]);

      vi.setSystemTime(t0 + ALREADY_FLAT_REPORT_AFTER_MS);
      await h.guard.runClosingGuard();

      expect(errors(h)).toHaveLength(1);
      expect(errors(h)[0][2]).toContain(CONTRACT_ID);
      expect(errors(h)[0][2]).toContain("another contract month");
      expect(h.deps.settlePausing).not.toHaveBeenCalled();
    });

    it("starts the window again after another outcome interrupts it", async () => {
      const outcomes: ForceFlatResult[] = [
        alreadyFlat(),
        { deploymentId: DEPL, accountId: 4242, contractId: CONTRACT_ID, status: "deferred", positionMayStillBeOpen: true },
        alreadyFlat(),
      ];
      const forceFlat = vi.fn(async () => outcomes.shift() as ForceFlatResult);
      const h = makeGuard({ over: { forceFlat } });

      await h.guard.runClosingGuard();
      vi.setSystemTime(t0 + CLOSING_GUARD_INTERVAL_MS);
      await h.guard.runClosingGuard();
      vi.setSystemTime(t0 + ALREADY_FLAT_REPORT_AFTER_MS + 1);
      await h.guard.runClosingGuard();

      expect(forceFlat).toHaveBeenCalledTimes(3);
      expect(errors(h)).toEqual([]);
    });

    it("forgets the window when the row leaves the closing states without settling", async () => {
      const h = makeGuard({ over: { forceFlat: vi.fn(async () => alreadyFlat()) } });

      await h.guard.runClosingGuard();
      // Moved out of Pausing by a status write elsewhere, then paused again.
      h.setRow(deployment("Paused"));
      await h.guard.runClosingGuard();
      h.setRow(deployment("Pausing"));
      vi.setSystemTime(t0 + ALREADY_FLAT_REPORT_AFTER_MS + 1);
      await h.guard.runClosingGuard();

      expect(errors(h)).toEqual([]);
    });
  });
});

describe("Destroy reaps rather than pausing", () => {
  it("reaps a Destroying row once it is confirmed flat", async () => {
    const h = makeGuard({ status: "Destroying", openTrade: false, state: state() });

    await h.guard.runClosingGuard();

    expect(h.deps.reapDestroying).toHaveBeenCalledWith(DEPL);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.deps.onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ id: DEPL }),
      "Destroying",
    );
  });

  it("flattens first, exactly as a Pause does", async () => {
    const h = makeGuard({ status: "Destroying" });

    await h.guard.runClosingGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.reapDestroying).not.toHaveBeenCalled();
  });
});

/**
 * A45. A Pause seconds after a signal finds the trade `pending_entry`: no
 * position to exit, and an entry order still working that can fill after the
 * operator was told the deployment is stopping. The mirror is seeded at entry
 * submission, so it is set here exactly as it is live.
 */
describe("A45 — a closing row whose trade is pending_entry", () => {
  const pendingEntry = () => trade({ status: "pending_entry" });

  it("cancels the entry order, then settles once the order reads cancelled", async () => {
    const h = makeGuard({ trade: pendingEntry() });

    await h.guard.runClosingGuard();

    expect(h.broker.cancelOrder).toHaveBeenCalledWith(ENTRY_ORDER_ID, 4242);
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
    expect(h.deps.onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: DEPL }), "Pausing");
    expect(h.currentState()?.position).toBeNull();
    expect(h.currentState()?.activeTradeId).toBeNull();
  });

  it("does not settle while the order still reads working, and settles on the pass it is gone", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenOrders.mockResolvedValueOnce([{ id: ENTRY_ORDER_ID } as Order]);

    await h.guard.runClosingGuard();
    expect(h.deps.settlePausing).not.toHaveBeenCalled();

    await h.guard.runClosingGuard();
    expect(h.broker.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
  });

  it("does not settle when a fill beat the cancel — the broker holds a position on the contract", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenPositions.mockResolvedValue([{ contractId: CONTRACT_ID, size: 1 } as Position]);

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.currentState()?.position).not.toBeNull();
  });

  it("a cancel that throws is sent again each pass, with one warn, and settles once one lands", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.cancelOrder.mockRejectedValueOnce(new Error("gateway unreachable"));
    h.broker.cancelOrder.mockRejectedValueOnce(new Error("gateway unreachable"));

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();

    expect(h.broker.cancelOrder).toHaveBeenCalledTimes(2);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    const warns = h.logs.filter(([, level]) => level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0][2]).toContain("gateway unreachable");
    expect(h.logs.filter(([, level]) => level === "error")).toEqual([]);

    await h.guard.runClosingGuard();

    expect(h.broker.cancelOrder).toHaveBeenCalledTimes(3);
    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
  });

  it("no cancel is sent once one was accepted, while the order still reads working", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenOrders.mockResolvedValue([{ id: ENTRY_ORDER_ID, status: 1, filledPrice: null } as Order]);

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();

    expect(h.broker.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  /**
   * Absence on an id is not flat (engine-exits.md): a Tradovate position reads
   * back under its numeric contract id until the symbol lookup warms, so a
   * fill that beat the cancel can arrive as "4093281".
   */
  it("a position under a numeric contract id blocks the settle", async () => {
    const h = makeGuard({ trade: trade({ status: "pending_entry", contractId: "MNQM6" }) });
    h.broker.searchOpenPositions.mockResolvedValue([{ contractId: "4093281", size: 1 } as Position]);

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.currentState()?.position).not.toBeNull();
  });

  it("a position on the row's root under another month blocks the settle", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenPositions.mockResolvedValue([{ contractId: "CON.F.US.MNQ.U26", size: 1 } as Position]);

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("a position on another product does not block the settle", async () => {
    const h = makeGuard({ trade: trade({ status: "pending_entry", contractId: "MNQM6" }) });
    h.broker.searchOpenPositions.mockResolvedValue([{ contractId: "MESM6", size: 1 } as Position]);

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
  });

  it("reads positions only after the order read answered, so a fill landing between them is seen", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    let filled = false;
    // The order leaves the open list because it filled, after the order read
    // was sent and before it answered.
    h.broker.searchOpenOrders.mockImplementation(async () => {
      await Promise.resolve();
      filled = true;
      return [];
    });
    h.broker.searchOpenPositions.mockImplementation(async () =>
      filled ? [{ contractId: CONTRACT_ID, size: 1 } as Position] : [],
    );

    await h.guard.runClosingGuard();

    expect(h.broker.searchOpenPositions).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("an entry order the read lists as Cancelled with nothing filled counts as gone", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenOrders.mockResolvedValue([{ id: ENTRY_ORDER_ID, status: 3, filledPrice: null } as Order]);

    await h.guard.runClosingGuard();

    expect(h.deps.settlePausing).toHaveBeenCalledWith(DEPL);
  });

  it("an entry order the read lists as Filled, or Cancelled with a fill price, does not", async () => {
    const filled = makeGuard({ trade: pendingEntry() });
    filled.broker.searchOpenOrders.mockResolvedValue([{ id: ENTRY_ORDER_ID, status: 2, filledPrice: 21000 } as Order]);
    await filled.guard.runClosingGuard();
    expect(filled.deps.settlePausing).not.toHaveBeenCalled();

    const partial = makeGuard({ trade: pendingEntry() });
    partial.broker.searchOpenOrders.mockResolvedValue([{ id: ENTRY_ORDER_ID, status: 3, filledPrice: 21000 } as Order]);
    await partial.guard.runClosingGuard();
    expect(partial.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("an older live row behind the confirmed pending_entry row prevents the settle", async () => {
    const h = makeGuard({ trade: trade({ id: 78, status: "pending_entry" }) });
    h.setOlderLiveTrades([trade({ id: 77, status: "open" })]);

    await h.guard.runClosingGuard();
    h.guard.settleIfFlat(DEPL);

    expect(h.broker.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.liveTradesFor).toHaveBeenCalledWith(DEPL);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("a row with no entry order id warns once, on the third pass, and cancels nothing", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.setTrade(trade({ status: "pending_entry", entryOrderId: null }));

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();
    expect(h.logs.filter(([, level]) => level === "warn")).toEqual([]);

    await h.guard.runClosingGuard();
    await h.guard.runClosingGuard();

    const warns = h.logs.filter(([, level]) => level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0][2]).toContain("no entry order id for 3 passes");
    expect(h.broker.cancelOrder).not.toHaveBeenCalled();
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("a throwing log handler does not escape the pass", async () => {
    const h = makeGuard({
      trade: pendingEntry(),
      over: {
        log: vi.fn(() => {
          throw new Error("log sink down");
        }),
      },
    });
    h.broker.cancelOrder.mockRejectedValue(new Error("gateway unreachable"));

    await expect(h.guard.runClosingGuard()).resolves.toBeUndefined();
  });

  it("an entry the reconciler promoted to open takes the exit path", async () => {
    const h = makeGuard({ trade: pendingEntry() });
    h.broker.searchOpenOrders.mockResolvedValueOnce([{ id: ENTRY_ORDER_ID } as Order]);
    await h.guard.runClosingGuard();

    h.setTrade(trade({ status: "open" }));
    await h.guard.runClosingGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("an open trade is unchanged: the exit path, no cancel", async () => {
    const h = makeGuard({ trade: trade({ status: "open" }) });

    await h.guard.runClosingGuard();

    expect(h.broker.cancelOrder).not.toHaveBeenCalled();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("the prompt path does not settle a pending entry the guard has not cancelled", () => {
    const h = makeGuard({ trade: pendingEntry(), state: state() });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });
});

describe("everything else is left alone", () => {
  it("does nothing for an Active deployment on the prompt path", () => {
    const h = makeGuard({ status: "Active", openTrade: false, state: state() });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
    expect(h.deps.reapDestroying).not.toHaveBeenCalled();
  });

  it("does nothing for a deployment that no longer exists", () => {
    const h = makeGuard();
    h.setRow(null);

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.settlePausing).not.toHaveBeenCalled();
  });

  it("makes no broker call when nothing is closing", async () => {
    const h = makeGuard({ over: { listClosing: vi.fn(() => []) } });

    await h.guard.runClosingGuard();

    expect(h.deps.stateFor).not.toHaveBeenCalled();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
  });

  it("does not fire onSettled when the row was resumed under it", () => {
    // `settlePausing` is conditional on the row still being `Pausing`; a
    // status written in the window returns false and the completion is
    // dropped rather than overwriting it. Defence in depth: no operator route
    // writes `Active` over a closing row any more.
    const h = makeGuard({
      openTrade: false,
      state: state(),
      over: { settlePausing: vi.fn(() => false) },
    });

    h.guard.settleIfFlat(DEPL);

    expect(h.deps.onSettled).not.toHaveBeenCalled();
  });
});
