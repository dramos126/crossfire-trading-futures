/**
 * Unit tests for engine-exit.ts — placeExitOrder (latch + broker path),
 * cancelTrackedBrackets (staged bracket cancel), verifyExitClean
 * (ownership evidence gate), and bracketRecoveryEligibility (the
 * submission-to-fill gate the latch cannot cover).
 *
 * All external I/O is injected via the ExitOrderDeps interface or mocked
 * at the vi.mock boundary so no DB or network calls occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  getOpenTradeForDeployment: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  bracketRecoveryEligibility,
  placeExitOrder,
  cancelTrackedBrackets,
  forceCloseAfterBracketFailure,
  verifyExitClean,
  EXIT_FLAT_MISMATCH_WARN_MS,
  EXIT_LATCH_PAST_WINDOW_BAR_CLOSES_TOLERATED,
  noteExitLatchHeldPastWindow,
  type ExitOrderDeps,
} from "./engine-exit";
import { failedPreEntrySnapshot } from "./engine-order";
import { getStrategy } from "@/lib/trading/strategies";
import type { StrategyTrade } from "@/lib/db/trade-types";
import { EntryExitCode } from "../orders/entry-exit-codes";
import type { Contract } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { DeploymentState } from "./engine";
import type { OpenPosition } from "../strategy-types";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { EVENTS, type Severity } from "@/lib/logging/vocabulary";
import { armShutdownExit, orderRequestsInFlight, SHUTDOWN_DRAIN_MS, SHUTDOWN_EXIT_CAP_MS } from "@/lib/shutdown-drain";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeploymentState(overrides: Partial<DeploymentState> = {}): DeploymentState {
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
    exitDispatchWarnedAt: null,
    pendingEntrySessionKey: null,
    signalSuppressed: false,
    ...overrides,
  };
}

function makeContract(id = "CON.F.US.MNQ.M26"): Contract {
  return {
    id,
    name: "MNQM6",
    description: "Micro E-mini Nasdaq 100 June 2026",
    activeContract: true,
    symbolId: "/MNQ",
    tickSize: 0.25,
    tickValue: 1.25,
  };
}

function makeDeployment(id = "deploy-aaa"): Deployment {
  return {
    id,
    strategyKey: "test",
    accountId: 1001,
    ticker: "/MNQ",
    contractId: "CON.F.US.MNQ.M26",
    status: "Active",
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
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: 0,
    entryPrice: 20000,
    entryTimestamp: "2026-01-02T14:30:00Z",
    barsSinceEntry: 3,
    entryFilledAt: "2026-01-02T14:30:01Z",
    size: 1,
    slTicks: 10,
    ...overrides,
  };
}

/** Minimal StrategyModule stub for placeExitOrder calls that need a strategy. */
const stubStrategy = {
  version: "1.0.0",
  params: {},
  config: {
    name: "Test",
    description: "",
    timeframe: "1m" as const,
    size: 1,
    entryType: 2 as const,
    indicators: [],
  },
  shouldEnter: () => null,
  shouldExit: () => false,
};

/**
 * Build an ExitOrderDeps with all side-effectful fns stubbed. The `stateMap`
 * and broker fns are controllable per-test via overrides.
 */
function makeDeps(overrides: Partial<ExitOrderDeps> & {
  brokerSearchPositions?: ReturnType<typeof vi.fn>;
  brokerPlaceOrder?: ReturnType<typeof vi.fn>;
  brokerCancelOrder?: ReturnType<typeof vi.fn>;
  brokerSearchOrders?: ReturnType<typeof vi.fn>;
  stateMap?: Map<string, DeploymentState>;
} = {}): ExitOrderDeps & {
  logSpy: ReturnType<typeof vi.fn>;
  logEventSpy: ReturnType<typeof vi.fn>;
  brokerSearchPositions: ReturnType<typeof vi.fn>;
  brokerPlaceOrder: ReturnType<typeof vi.fn>;
  brokerCancelOrder: ReturnType<typeof vi.fn>;
  brokerSearchOrders: ReturnType<typeof vi.fn>;
} {
  const logSpy = vi.fn();
  const logEventSpy = vi.fn();
  const brokerSearchPositions = overrides.brokerSearchPositions ?? vi.fn().mockResolvedValue([]);
  const brokerPlaceOrder = overrides.brokerPlaceOrder ?? vi.fn().mockResolvedValue({ orderId: 9001 });
  const brokerCancelOrder = overrides.brokerCancelOrder ?? vi.fn().mockResolvedValue(undefined);
  const brokerSearchOrders = overrides.brokerSearchOrders ?? vi.fn().mockResolvedValue([]);
  const stateMap = overrides.stateMap ?? new Map<string, DeploymentState>();

  const broker = {
    searchOpenPositions: brokerSearchPositions,
    placeOrder: brokerPlaceOrder,
    cancelOrder: brokerCancelOrder,
    searchOpenOrders: brokerSearchOrders,
    getFillsForOrder: vi.fn().mockResolvedValue([]),
    searchTrades: vi.fn().mockResolvedValue([]),
    searchAccounts: vi.fn().mockResolvedValue([]),
    modifyOrder: vi.fn(),
    invalidateOpenOrders: vi.fn(),
  };

  const deps: ExitOrderDeps = {
    brokerFor: (_deployment) => broker as unknown as ReturnType<ExitOrderDeps["brokerFor"]>,
    getState: (deploymentId) => {
      if (!stateMap.has(deploymentId)) {
        stateMap.set(deploymentId, makeDeploymentState());
      }
      return stateMap.get(deploymentId)!;
    },
    log: logSpy,
    logEvent: logEventSpy,
    maybeOrphanFromBrokerError: vi.fn(),
    resolveContract: vi.fn().mockResolvedValue(makeContract()),
    notifyForceClose: vi.fn().mockResolvedValue(undefined),
    buildCustomTag: vi.fn().mockReturnValue("x_deployaaa_abc1"),
    stateMap,
    ...overrides,
  };

  return { ...deps, logSpy, logEventSpy, brokerSearchPositions, brokerPlaceOrder, brokerCancelOrder, brokerSearchOrders };
}

/**
 * Every message this cluster logged at a given severity, whichever seam
 * carried it.
 *
 * These assertions are about **tone** — is the operator being alarmed or
 * merely informed — and tone survives a site moving from the level-taking
 * seam to a named event. Merging both is what keeps them asserting the
 * property rather than the plumbing; the event half reads its severity from
 * the registry, which is the only place it lives.
 */
function messagesAt(
  deps: { logSpy: ReturnType<typeof vi.fn>; logEventSpy: ReturnType<typeof vi.fn> },
  severity: Severity,
): string[] {
  const levelled = deps.logSpy.mock.calls.filter((c) => c[1] === severity).map((c) => String(c[3]));
  const evented = deps.logEventSpy.mock.calls
    .filter((c) => EVENTS[String(c[0])]?.severity === severity)
    .map((c) => String(c[2]));
  return [...levelled, ...evented];
}

/** Whether any line at `severity` contained `fragment`. */
function said(
  deps: { logSpy: ReturnType<typeof vi.fn>; logEventSpy: ReturnType<typeof vi.fn> },
  severity: Severity,
  fragment: string,
): boolean {
  return messagesAt(deps, severity).some((m) => m.includes(fragment));
}

// ── placeExitOrder ────────────────────────────────────────────────────────────

describe("placeExitOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, so the trade-row lookup has to be
    // re-armed per test or the flat-mismatch cases below leak into the ones
    // that expect a quiet already-flat return.
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  it("throws EXIT_IN_FLIGHT immediately when exitInFlight is already set", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ exitInFlight: true })],
    ]);
    const deps = makeDeps({ stateMap });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "test_reason"),
    ).rejects.toThrow(EntryExitCode.EXIT_IN_FLIGHT);

    // Broker must not have been called at all.
    expect(deps.brokerSearchPositions).not.toHaveBeenCalled();
    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  it("logs the in-flight skip before throwing EXIT_IN_FLIGHT", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ exitInFlight: true })],
    ]);
    const deps = makeDeps({ stateMap });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "session_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_IN_FLIGHT);

    expect(said(deps, "info", "another exit already in flight")).toBe(true);
  });

  it("sets exitInFlight=true before the first await and resets it to false after resolve", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>();
    let capturedDuringExecution = false;

    const brokerSearchPositions = vi.fn().mockImplementation(async () => {
      // At this point we are inside the first await of placeExitOrderInner;
      // the latch must already be set.
      capturedDuringExecution = stateMap.get(deployment.id)?.exitInFlight ?? false;
      return [{ contractId: "CON.F.US.MNQ.M26", size: 1, id: 1, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" }];
    });
    const brokerPlaceOrder = vi.fn().mockResolvedValue({ orderId: 9001, success: true, errorCode: 0, errorMessage: null });

    const deps = makeDeps({ stateMap, brokerSearchPositions, brokerPlaceOrder });
    await placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "test");

    expect(capturedDuringExecution).toBe(true);
    expect(stateMap.get(deployment.id)?.exitInFlight).toBe(false);
  });

  it("resets exitInFlight=false even when an error is thrown mid-execution", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>();
    const brokerSearchPositions = vi.fn().mockRejectedValue(new Error("network timeout"));

    const deps = makeDeps({ stateMap, brokerSearchPositions });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "test"),
    ).rejects.toThrow("network timeout");

    // Latch must be cleared in finally.
    expect(stateMap.get(deployment.id)?.exitInFlight).toBe(false);
  });

  describe("the exit latch held past the session window (session-end Mechanism A)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Takes the latch with an exit whose position read never answers until released. */
    function holdLatch(deps: ReturnType<typeof makeDeps>, deployment: Deployment, reason: string) {
      let release!: () => void;
      deps.brokerSearchPositions.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve([]); }),
      );
      const held = placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 7, reason);
      return { held, release: async () => { release(); await held; } };
    }

    function errorsAbout(deps: ReturnType<typeof makeDeps>): string[] {
      return messagesAt(deps, "error").filter((m) => m.includes("Session-end close blocked"));
    }

    it("records the holder's reason with the latch and clears it on release", async () => {
      const deployment = makeDeployment();
      const deps = makeDeps();
      const latch = holdLatch(deps, deployment, "strategy_signal");
      expect(deps.getState(deployment.id).exitLatchHolder).toMatchObject({ reason: "strategy_signal", pastWindowBarCloses: 0 });
      await latch.release();
      expect(deps.getState(deployment.id).exitLatchHolder).toBeNull();
    });

    it("says it at error once, with the holder's reason and how long it has held, past the tolerated bar closes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-25T18:39:50.000Z"));
      const deployment = makeDeployment();
      const deps = makeDeps();
      const latch = holdLatch(deps, deployment, "time_window_close");

      for (let close = 1; close <= EXIT_LATCH_PAST_WINDOW_BAR_CLOSES_TOLERATED; close++) {
        noteExitLatchHeldPastWindow(deps, deployment, 7);
      }
      expect(errorsAbout(deps)).toEqual([]);

      vi.setSystemTime(new Date("2026-08-25T18:45:00.000Z"));
      noteExitLatchHeldPastWindow(deps, deployment, 7);
      noteExitLatchHeldPastWindow(deps, deployment, 7);

      const errors = errorsAbout(deps);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("(time_window_close)");
      expect(errors[0]).toContain("310s ago");
      const errorCall = deps.logSpy.mock.calls.find((c) => c[1] === "error");
      expect(errorCall?.[4]).toMatchObject({ accountId: deployment.accountId, tradeId: 7 });
      await latch.release();
    });

    it("says nothing above info when the latch is released within the tolerance", async () => {
      const deployment = makeDeployment();
      const deps = makeDeps();
      const first = holdLatch(deps, deployment, "time_window_close");
      noteExitLatchHeldPastWindow(deps, deployment, 7);
      await first.release();

      // A new hold starts its own count.
      const second = holdLatch(deps, deployment, "time_window_close");
      noteExitLatchHeldPastWindow(deps, deployment, 7);
      await second.release();
      noteExitLatchHeldPastWindow(deps, deployment, 7);

      expect(messagesAt(deps, "error")).toEqual([]);
      expect(messagesAt(deps, "warn")).toEqual([]);
    });
  });

  it("returns without placing an order when broker reports no open position (already flat)", async () => {
    const deployment = makeDeployment();
    // searchOpenPositions returns [] — no live position.
    const deps = makeDeps();

    await placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "session_close");

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
    expect(said(deps, "info", "broker reports no open position")).toBe(true);
  });

  // The 2026-08-26 incident (docs/bugs.md): an exit that resolved the *other*
  // broker's contract asked about a contract the account does not hold, got
  // "no position", and returned normally — so the caller nulled the position
  // mirror over an exit that never reached the wire, stranding a trade row
  // marked `open` where no clock-driven guard could reach it.
  it("throws EXIT_FLAT_MISMATCH when the broker is flat but the deployment still has an open trade row", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  it("names the open trade row on the mismatch, at warn", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(said(deps, "warn", "#6876")).toBe(true);
  });

  // The common, legitimate case and the reason this is not an error: a
  // tick-driven exit that already fired leaves the broker flat with the row
  // sitting at `pending_exit` until its fill resolves.
  it("stays a quiet no-op when the row is already pending_exit", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "pending_exit", contractId: "CON.F.US.MNQ.M26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "session_close");

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
    expect(messagesAt(deps, "warn")).toHaveLength(0);
  });

  // `handleTradeImpl` fires `evaluateRealtimeExits` on every price change and
  // nothing throttles it, so a stranded leg re-enters this arm until the
  // reconciler closes the row. The throw must survive every pass; the line
  // must not.
  it("logs the mismatch once per stranded trade instead of once per price change", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    for (let i = 0; i < 6; i++) {
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
    }

    const warns = messagesAt(deps, "warn");
    expect(warns).toHaveLength(1);
    // Throttling the throw would re-open the over-sell shape the latch exists
    // to prevent — every pass still re-reads the broker and still refuses.
    expect(deps.brokerSearchPositions).toHaveBeenCalledTimes(6);
  });

  it("re-arms the mismatch line for the next stranded trade", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 7001, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    const warns = messagesAt(deps, "warn");
    expect(warns).toHaveLength(2);
  });

  // The throttle is a quiet period, not a mute. `EXIT_FLAT_MISMATCH` is a
  // standing condition — an exogenous exit leaves it in place until the
  // reconciler closes the row — so the operator has to hear about it again if
  // it is still true, or a leg stranded for an hour has one line an hour old.
  it("re-announces a still-stranded trade once the throttle window has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const deployment = makeDeployment();
      vi.mocked(getOpenTradeForDeployment).mockReturnValue(
        { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
      );
      const deps = makeDeps();

      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

      // Just short of the window: still the same quiet period.
      vi.advanceTimersByTime(EXIT_FLAT_MISMATCH_WARN_MS - 1);
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
      expect(messagesAt(deps, "warn")).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

      expect(messagesAt(deps, "warn")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The anchor lives on `DeploymentState`, so it is per-leg by construction —
  // but a group is several legs on one strategy failing for one reason, and a
  // throttle that collapsed them would report the first leg and hide the rest.
  it("does not let one deployment's anchor silence another's stranded trade", async () => {
    const first = makeDeployment("deploy-aaa");
    const second = makeDeployment("deploy-bbb");
    vi.mocked(getOpenTradeForDeployment).mockImplementation((deploymentId) =>
      ({
        id: deploymentId === first.id ? 6876 : 7001,
        status: "open",
        contractId: "CON.F.US.ENQ.U26",
      }) as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    for (const deployment of [first, second]) {
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
    }

    const warned = deps.logEventSpy.mock.calls
      .filter((c) => EVENTS[String(c[0])]?.severity === "warn")
      .map((c) => c[1]);
    expect(warned).toEqual([first.id, second.id]);
  });

  // Both anchors, because both are cleared here and only one was pinned. The
  // catch-arm anchor is stamped one frame up in `logExitDispatchFailure`, so
  // the test stands it up by hand — an exit reaching the wire is what ends the
  // stranding both were suppressing, and a clear that silently stopped
  // happening would leave a stale key throttling the *next* incident.
  it("clears both throttle anchors once an exit reaches the wire", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const brokerSearchPositions = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ stateMap, brokerSearchPositions });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
    expect(stateMap.get(deployment.id)?.flatMismatchWarnedAt).not.toBeNull();
    const state = stateMap.get(deployment.id);
    if (state) state.exitDispatchWarnedAt = { key: "6876|realtime_exit|Error|exit_flat_mismatch", at: Date.now() };

    brokerSearchPositions.mockResolvedValue([
      { contractId: "CON.F.US.MNQ.M26", size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ]);
    await placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "realtime_exit");

    expect(stateMap.get(deployment.id)?.flatMismatchWarnedAt).toBeNull();
    expect(stateMap.get(deployment.id)?.exitDispatchWarnedAt).toBeNull();
  });

  it("releases the exit latch after a flat mismatch", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 6876, status: "open", contractId: "CON.F.US.ENQ.U26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({ stateMap });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), null, "test"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(stateMap.get(deployment.id)?.exitInFlight).toBe(false);
  });

  // A71. The brackets' ids come off the trade row and name no month, so a
  // cancel in front of the position read strips the cover off a position the
  // refusal below then declines to close — on a contract-flip day, once per
  // pass, for as long as the position is held. The read is first for the same
  // reason `attemptForceFlat` reads first.
  it("cancels nothing when the caller's contract is flat and the row's month still holds the position", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: "CON.F.US.MNQ.U26", size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder).not.toHaveBeenCalled();
    expect(deps.brokerSearchOrders).not.toHaveBeenCalled();
    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  // A73. A71's read-first order left a hand-flattened leg's OSO resting on a
  // flat book: the refusal cancelled nothing and nothing else sweeps it. Flat
  // on the row's month too means the legs cover nothing — on the closing side
  // they are an armed reverse — so they go ahead of the refusal. Must not
  // regress: the A71 case above (position on the row's month) keeps them.
  it("A73 — cancels the row's brackets when the book is flat on the caller's and the row's contract, and still refuses", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([501, 502]);
    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  it("A73 — the flat-book cancel runs once per stranded trade, not on every price change", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", contractId: "CON.F.US.MNQ.M26", tpOrderId: 501, slOrderId: null } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({ stateMap });

    for (let i = 0; i < 3; i++) {
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
      ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
    }

    expect(deps.brokerCancelOrder).toHaveBeenCalledTimes(1);
  });

  /**
   * Review of A73, finding 1. Tradovate's position translator answers a
   * stringified numeric contract id until its symbol lookup warms, so a live
   * long on the row's month can read back under an id that matches neither
   * contract. Absence on an id is not flat (A71's lesson): the cancel needs
   * the read to hold nothing that could be the row's product.
   */
  it("A73 — cancels nothing when the read holds a position whose contract id will not parse", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", side: 0, contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: "4012345", size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder).not.toHaveBeenCalled();
  });

  it("A73 — cancels nothing when the read holds the row's product on another id", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", side: 0, contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: "CON.F.US.MNQ.Z26", size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder).not.toHaveBeenCalled();
  });

  it("A73 — still cancels when the only position is another product", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", side: 0, contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: "CON.F.US.GCE.Z26", size: 1, id: 5, accountId: 1001, averagePrice: 2000, type: 1, creationTimestamp: "" },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([501, 502]);
  });

  /** Review of A73, finding 5: the row's legs close the row's side, not the
   *  side of whatever position the caller passed (the hand-position close passes a hand one). */
  it("A73 — narrows the no-ids cancel to the row's closing side, not the caller's position", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", side: 1, contractId: contract.id, tpOrderId: null, slOrderId: null } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchOrders: vi.fn().mockResolvedValue([
        { id: 7001, contractId: contract.id, status: 1, type: 4, side: 0 }, // the short row's SL — a buy
        { id: 7002, contractId: contract.id, status: 1, type: 4, side: 1 },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition({ side: 0 }), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerCancelOrder.mock.calls.map((c) => c[0])).toEqual([7001]);
  });

  /**
   * Review finding 3. The market side came from the mirror, which past the
   * window is seeded from the row, and was never checked against the broker:
   * a stale long row over a broker short sold the short's size and doubled
   * it. The exit refuses instead, before any cancel, as force-flat takes its
   * side from the broker.
   */
  it("refuses a stale long against a broker short, before cancelling anything", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", side: 0, contractId: contract.id, tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: contract.id, size: 2, id: 5, accountId: 1001, averagePrice: 20000, type: 2, creationTimestamp: "" },
      ]),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition({ side: 0 }), 42, "time_window_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_SIDE_MISMATCH);

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
    expect(deps.brokerCancelOrder).not.toHaveBeenCalled();
    expect(said(deps, "error", "holds SHORT 2")).toBe(true);
  });

  it("refuses when the broker's side flips inside the cancel round-trips", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const at = (type: number) => [{ contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type, creationTimestamp: "" }];
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValueOnce(at(1)).mockResolvedValue(at(2)),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition({ side: 0 }), null, "strategy_exit"),
    ).rejects.toThrow(EntryExitCode.EXIT_SIDE_MISMATCH);

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  it("logs the side refusal once per trade per window, and throws every time", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const stateMap = new Map<string, DeploymentState>();
    const deps = makeDeps({
      stateMap,
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 2, creationTimestamp: "" },
      ]),
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition({ side: 0 }), 42, "strategy_exit"),
      ).rejects.toThrow(EntryExitCode.EXIT_SIDE_MISMATCH);
    }

    expect(messagesAt(deps, "error").filter((m) => m.includes("Exit refused"))).toHaveLength(1);
  });

  it("cancels nothing on the quiet already-flat return either", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "pending_exit", contractId: "CON.F.US.MNQ.U26", tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const deps = makeDeps();

    await placeExitOrder(deps, stubStrategy as never, deployment, makeContract(), makePosition(), 42, "session_close");

    expect(deps.brokerCancelOrder).not.toHaveBeenCalled();
    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
  });

  it("reads the position, cancels the brackets, re-reads, then submits", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const seen: string[] = [];
    const live = [{ contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" }];
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", contractId: contract.id, tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const brokerSearchPositions = vi.fn().mockImplementation(async () => {
      seen.push("read");
      return live;
    });
    const brokerCancelOrder = vi.fn().mockImplementation(async () => {
      seen.push("cancel");
    });
    const brokerPlaceOrder = vi.fn().mockImplementation(async () => {
      seen.push("place");
      return { orderId: 9001, success: true, errorCode: 0, errorMessage: null };
    });
    const deps = makeDeps({ brokerSearchPositions, brokerCancelOrder, brokerPlaceOrder });

    await placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition(), 42, "strategy_exit");

    expect(seen).toEqual(["read", "cancel", "cancel", "read", "place"]);
  });

  it("sizes the exit from the re-read, not from the read before the cancel", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const position = (size: number) => [
      { contractId: contract.id, size, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ];
    const brokerSearchPositions = vi
      .fn()
      .mockResolvedValueOnce(position(3))
      .mockResolvedValue(position(1));
    const brokerPlaceOrder = vi.fn().mockResolvedValue({ orderId: 9001, success: true, errorCode: 0, errorMessage: null });
    const deps = makeDeps({ brokerSearchPositions, brokerPlaceOrder });

    await placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition(), null, "strategy_exit");

    const orderArg = brokerPlaceOrder.mock.calls[0][0] as Record<string, unknown>;
    expect(orderArg.size).toBe(1);
  });

  // A bracket filling inside the cancel round-trips is exactly what the
  // re-read exists to see: the book is flat and the exit must not go.
  it("refuses after the cancel when the position closed inside it", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 42, status: "open", contractId: contract.id, tpOrderId: 501, slOrderId: 502 } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    const brokerSearchPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
      ])
      .mockResolvedValue([]);
    const deps = makeDeps({ brokerSearchPositions });

    await expect(
      placeExitOrder(deps, stubStrategy as never, deployment, contract, makePosition(), 42, "strategy_exit"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);

    expect(deps.brokerPlaceOrder).not.toHaveBeenCalled();
    expect(deps.brokerCancelOrder).toHaveBeenCalledTimes(2);
  });

  it("places a market exit order on the closing side when a live position exists", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const brokerSearchPositions = vi.fn().mockResolvedValue([
      { contractId: contract.id, size: 2, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ]);
    const brokerPlaceOrder = vi.fn().mockResolvedValue({ orderId: 9001, success: true, errorCode: 0, errorMessage: null });
    const deps = makeDeps({ brokerSearchPositions, brokerPlaceOrder });

    const longPosition = makePosition({ side: 0, size: 1 }); // long

    await placeExitOrder(deps, stubStrategy as never, deployment, contract, longPosition, null, "strategy_exit");

    expect(brokerPlaceOrder).toHaveBeenCalledTimes(1);
    const orderArg = brokerPlaceOrder.mock.calls[0][0] as unknown as Record<string, unknown>;
    // Long exits by selling (side 1).
    expect(orderArg.side).toBe(1);
    expect(orderArg.type).toBe(2); // Market
    expect(orderArg.contractId).toBe(contract.id);
    expect(orderArg.accountId).toBe(deployment.accountId);
    // Size comes from broker position, not strategy params.
    expect(orderArg.size).toBe(2);
  });

  it("uses broker position size (not strategy size) for the exit order", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const brokerSearchPositions = vi.fn().mockResolvedValue([
      { contractId: contract.id, size: 3, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ]);
    const brokerPlaceOrder = vi.fn().mockResolvedValue({ orderId: 9001, success: true, errorCode: 0, errorMessage: null });
    const deps = makeDeps({ brokerSearchPositions, brokerPlaceOrder });

    // Strategy position says size=1, broker says size=3.
    const position = makePosition({ size: 1 });
    await placeExitOrder(deps, stubStrategy as never, deployment, contract, position, null, "test");

    const orderArg = brokerPlaceOrder.mock.calls[0][0] as Record<string, unknown>;
    expect(orderArg.size).toBe(3); // broker truth wins
  });

  it("short position exits by buying (side 0)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const brokerSearchPositions = vi.fn().mockResolvedValue([
      { contractId: contract.id, size: 1, id: 6, accountId: 1001, averagePrice: 20100, type: 2, creationTimestamp: "" },
    ]);
    const brokerPlaceOrder = vi.fn().mockResolvedValue({ orderId: 9002, success: true, errorCode: 0, errorMessage: null });
    const deps = makeDeps({ brokerSearchPositions, brokerPlaceOrder });

    const shortPosition = makePosition({ side: 1 }); // short
    await placeExitOrder(deps, stubStrategy as never, deployment, contract, shortPosition, null, "test");

    const orderArg = brokerPlaceOrder.mock.calls[0][0] as Record<string, unknown>;
    expect(orderArg.side).toBe(0); // buy to close short
  });
});

// ── A SIGTERM's exit and an engine exit in flight ─────────────────────────────

describe("a SIGTERM's exit waits for an engine exit in flight", () => {
  // SIGTERM does not stop the engine. An exit cancels the brackets before its
  // market order, so cut between the two it leaves a position with no stop;
  // before the drain it had until SIGKILL at ~30s.
  let exit: MockInstance<typeof process.exit>;
  /** `verifyExitClean`'s sleep before its broker read. */
  const VERIFY_SLEEP_MS = 1_500;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  });

  afterEach(() => {
    exit.mockRestore();
    vi.useRealTimers();
  });

  /** An exit whose market order is on the wire. Boxed, or awaiting the
   *  helper would await the exit itself. */
  async function exitOnTheWire(placeOrder: ReturnType<typeof vi.fn>): Promise<{ exiting: Promise<void> }> {
    const contract = makeContract();
    const deps = makeDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue([
        { contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
      ]),
      brokerPlaceOrder: placeOrder,
    });
    const exiting = placeExitOrder(deps, stubStrategy as never, makeDeployment(), contract, makePosition(), null, "strategy_exit");
    await vi.advanceTimersByTimeAsync(0);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    return { exiting };
  }

  it("holds the exit past the 5s drain until the market order returns", async () => {
    let land!: (r: unknown) => void;
    const { exiting } = await exitOnTheWire(vi.fn(() => new Promise((r) => (land = r))));
    const flush = vi.fn();

    armShutdownExit("SIGTERM", flush, true);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS + 7_000);
    expect(exit).not.toHaveBeenCalled();

    land({ orderId: 9001, success: true, errorCode: 0, errorMessage: null });
    await exiting;
    // The post-exit check's 1.5s sleep is order work too.
    await vi.advanceTimersByTimeAsync(VERIFY_SLEEP_MS);
    expect(flush).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("holds the exit while the post-exit check's broker read is outstanding", async () => {
    // The check is dispatched without awaiting; cut inside it, a bracket leg
    // left resting on the flat position is never swept.
    const contract = makeContract();
    const open = [
      { contractId: contract.id, size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ];
    let checking = false;
    let read!: (r: unknown[]) => void;
    const search = vi.fn(() => (checking ? new Promise((r) => (read = r)) : Promise.resolve(open)));
    const deps = makeDeps({
      brokerSearchPositions: search,
      brokerPlaceOrder: vi.fn().mockResolvedValue({ orderId: 9001, success: true, errorCode: 0, errorMessage: null }),
    });
    const exiting = placeExitOrder(deps, stubStrategy as never, makeDeployment(), contract, makePosition(), null, "strategy_exit");
    await vi.advanceTimersByTimeAsync(0);
    await exiting;
    checking = true;
    const readsBeforeCheck = search.mock.calls.length;
    expect(orderRequestsInFlight()).toBe(1);

    armShutdownExit("SIGTERM", () => {}, true);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS + 7_000);
    expect(search).toHaveBeenCalledTimes(readsBeforeCheck + 1);
    expect(exit).not.toHaveBeenCalled();

    read([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(orderRequestsInFlight()).toBe(0);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("still exits at the cap when the market order never returns", async () => {
    await exitOnTheWire(vi.fn(() => new Promise(() => {})));

    armShutdownExit("SIGTERM", () => {}, true);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_EXIT_CAP_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(143);
  });
});

// ── cancelTrackedBrackets ─────────────────────────────────────────────────────

describe("cancelTrackedBrackets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels tpOrderId and slOrderId when trade row has them attributed", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();

    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 42,
      tpOrderId: 8001,
      slOrderId: 8002,
    } as ReturnType<typeof getOpenTradeForDeployment>);

    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, 42, 1);

    expect(brokerCancelOrder).toHaveBeenCalledWith(8001, deployment.accountId);
    expect(brokerCancelOrder).toHaveBeenCalledWith(8002, deployment.accountId);
    expect(brokerCancelOrder).toHaveBeenCalledTimes(2);
  });

  it("does not call searchOpenOrders when trade row has attributed ids", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 42,
      tpOrderId: 8001,
      slOrderId: 8002,
    } as ReturnType<typeof getOpenTradeForDeployment>);

    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const brokerSearchOrders = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ brokerCancelOrder, brokerSearchOrders });

    await cancelTrackedBrackets(deps, deployment, makeContract(), 42, 1);

    expect(brokerSearchOrders).not.toHaveBeenCalled();
  });

  it("falls back to open-order diff when trade has no attributed bracket ids", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    // Trade exists but no bracket ids.
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 99,
      tpOrderId: null,
      slOrderId: null,
    } as ReturnType<typeof getOpenTradeForDeployment>);

    const openOrders = [
      { id: 7001, contractId: contract.id, status: 1, type: 4, side: 1 },
      { id: 7002, contractId: "OTHER.CONTRACT", status: 1, type: 1, side: 1 },
    ];
    const brokerSearchOrders = vi.fn().mockResolvedValue(openOrders);
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerSearchOrders, brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, 99, 1);

    // Only the order on the matching contractId is cancelled.
    expect(brokerCancelOrder).toHaveBeenCalledWith(7001, deployment.accountId);
    expect(brokerCancelOrder).not.toHaveBeenCalledWith(7002, expect.anything());
  });

  it("does not cancel orders that are in the preEntryOrderIds snapshot (pre-existing orders)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 99,
      tpOrderId: null,
      slOrderId: null,
    } as ReturnType<typeof getOpenTradeForDeployment>);

    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ preEntryOrderIds: [5000] })],
    ]);
    const openOrders = [
      { id: 5000, contractId: contract.id, status: 1, type: 4, side: 1 }, // in pre-entry snapshot
      { id: 7001, contractId: contract.id, status: 1, type: 4, side: 1 }, // new — cancel this
    ];
    const brokerSearchOrders = vi.fn().mockResolvedValue(openOrders);
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ stateMap, brokerSearchOrders, brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, 99, 1);

    expect(brokerCancelOrder).toHaveBeenCalledWith(7001, deployment.accountId);
    expect(brokerCancelOrder).not.toHaveBeenCalledWith(5000, expect.anything());
  });

  /**
   * A11 — Stage 2 over-cancelled. On an engine trade whose row carries no
   * bracket ids and whose pre-entry snapshot is gone (attribution released
   * it, or a restart lost it), the diff had nothing to exclude and took every
   * working order on the contract. It now takes what `verifyExitClean`'s
   * primary sweep takes on the same evidence: Working Limit/Stop orders on
   * the protective side. Must not regress: with a snapshot the diff is
   * unchanged, and with no trade row (force-flat on a hand position)
   * Stage 2 still cancels every working order on the contract — the tests
   * either side of this one.
   */
  it("A11 — on an engine trade with no snapshot and no attributed ids, cancels only protective-side Working Limit/Stop orders", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 99,
      tpOrderId: null,
      slOrderId: null,
    } as ReturnType<typeof getOpenTradeForDeployment>);
    const openOrders = [
      { id: 7001, contractId: contract.id, status: 1, type: 4, side: 1 }, // SL — protective
      { id: 7002, contractId: contract.id, status: 1, type: 1, side: 1 }, // TP — protective
      { id: 7003, contractId: contract.id, status: 1, type: 1, side: 0 }, // a buy limit — not this trade's cover
      { id: 7004, contractId: contract.id, status: 1, type: 5, side: 1 }, // trailing stop — not a bracket leg
    ];
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerSearchOrders: vi.fn().mockResolvedValue(openOrders), brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, 99, 1);

    expect(brokerCancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([7001, 7002]);
  });

  /** Review of A11, finding 2: Tradovate maps PendingReplace and Unknown to
   *  Pending (5), so a stop caught mid-ratchet was skipped by the narrowing
   *  and survived the exit on the closing side. */
  it("A11 — the narrowing takes a Pending protective leg as well as a Working one", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 99,
      tpOrderId: null,
      slOrderId: null,
    } as ReturnType<typeof getOpenTradeForDeployment>);
    const openOrders = [
      { id: 7001, contractId: contract.id, status: 5, type: 4, side: 1 }, // SL mid-replace
      { id: 7002, contractId: contract.id, status: 2, type: 1, side: 1 }, // filled — gone
    ];
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerSearchOrders: vi.fn().mockResolvedValue(openOrders), brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, 99, 1);

    expect(brokerCancelOrder.mock.calls.map((c) => c[0])).toEqual([7001]);
  });

  /** A119: a pre-entry read that threw stores an empty snapshot, which used to
   *  read as an empty book and took the whole-contract diff. */
  describe("A119 — a failed pre-entry snapshot against a genuinely empty one", () => {
    const mixedBook = (contractId: string) => [
      { id: 7001, contractId, status: 1, type: 4, side: 1 }, // SL — protective
      { id: 7003, contractId, status: 1, type: 1, side: 0 }, // a buy limit — not this trade's cover
    ];

    async function cancelWith(snapshot: number[]): Promise<number[]> {
      const deployment = makeDeployment();
      const contract = makeContract();
      vi.mocked(getOpenTradeForDeployment).mockReturnValue({
        id: 99,
        tpOrderId: null,
        slOrderId: null,
      } as ReturnType<typeof getOpenTradeForDeployment>);
      const stateMap = new Map<string, DeploymentState>([
        [deployment.id, makeDeploymentState({ preEntryOrderIds: snapshot })],
      ]);
      const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        stateMap,
        brokerSearchOrders: vi.fn().mockResolvedValue(mixedBook(contract.id)),
        brokerCancelOrder,
      });
      await cancelTrackedBrackets(deps, deployment, contract, 99, 1);
      return brokerCancelOrder.mock.calls.map((c) => c[0] as number).sort();
    }

    it("a failed snapshot takes the no-snapshot path: protective legs only", async () => {
      expect(await cancelWith(failedPreEntrySnapshot())).toEqual([7001]);
    });

    it("a genuinely empty snapshot keeps the diff: every working order on the contract", async () => {
      expect(await cancelWith([])).toEqual([7001, 7003]);
    });
  });

  it("with no trade row, Stage 2 still cancels every working order on the contract (the hand-position close)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const openOrders = [
      { id: 7001, contractId: contract.id, status: 1, type: 4, side: 1 },
      { id: 7003, contractId: contract.id, status: 1, type: 1, side: 0 },
    ];
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerSearchOrders: vi.fn().mockResolvedValue(openOrders), brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, contract, null, 1);

    expect(brokerCancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([7001, 7003]);
  });

  it("returns without calling cancelOrder when no orders to cancel", async () => {
    const deployment = makeDeployment();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const brokerSearchOrders = vi.fn().mockResolvedValue([]);
    const brokerCancelOrder = vi.fn();
    const deps = makeDeps({ brokerSearchOrders, brokerCancelOrder });

    await cancelTrackedBrackets(deps, deployment, makeContract(), null, 1);

    expect(brokerCancelOrder).not.toHaveBeenCalled();
  });

  it("logs a warning and continues when cancelOrder throws (best-effort behavior)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 42,
      tpOrderId: 8001,
      slOrderId: null,
    } as ReturnType<typeof getOpenTradeForDeployment>);

    const brokerCancelOrder = vi.fn().mockRejectedValue(new Error("already cancelled"));
    const deps = makeDeps({ brokerCancelOrder });

    // Must not throw — cancel is best-effort. The verdict is how the caller
    // finds out anyway.
    await expect(cancelTrackedBrackets(deps, deployment, contract, 42, 1)).resolves.toBe("degraded");
    expect(said(deps, "warn", "Cancel bracket #8001 failed")).toBe(true);
  });

  /**
   * Every arm of this function proceeds on failure, so "it ran" and
   * "the working orders are gone" are different statements — and the
   * unmanaged arm of `verifyExitClean` was making the second one out loud
   * without being told which had happened.
   */
  describe("the verdict reports what the pass could actually prove", () => {
    it("is clean when every attributed bracket cancelled", async () => {
      const deployment = makeDeployment();
      vi.mocked(getOpenTradeForDeployment).mockReturnValue({
        id: 42,
        tpOrderId: 8001,
        slOrderId: 8002,
      } as ReturnType<typeof getOpenTradeForDeployment>);
      const deps = makeDeps({ brokerCancelOrder: vi.fn().mockResolvedValue(undefined) });

      await expect(cancelTrackedBrackets(deps, deployment, makeContract(), 42, 1)).resolves.toBe("clean");
    });

    it("is clean when there was nothing resting to cancel", async () => {
      const deployment = makeDeployment();
      vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
      const deps = makeDeps({ brokerSearchOrders: vi.fn().mockResolvedValue([]) });

      await expect(cancelTrackedBrackets(deps, deployment, makeContract(), null, 1)).resolves.toBe("clean");
    });

    it("is degraded when the Stage 2 lookup throws — the D-2 shape, where Stage 2 is the whole cancel", async () => {
      // `activeTradeId` null means no attributed ids, so a thrown
      // `searchOpenOrders` leaves `idsToCancel` empty and the pass returns
      // having cancelled nothing at all.
      const deployment = makeDeployment();
      vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
      const brokerCancelOrder = vi.fn();
      const deps = makeDeps({
        brokerSearchOrders: vi.fn().mockRejectedValue(new Error("gateway timeout")),
        brokerCancelOrder,
      });

      await expect(cancelTrackedBrackets(deps, deployment, makeContract(), null, 1)).resolves.toBe("degraded");
      expect(brokerCancelOrder).not.toHaveBeenCalled();
    });
  });
});

// ── verifyExitClean ───────────────────────────────────────────────────────────

describe("verifyExitClean", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips primary orphan sweep when no ownership evidence (no preEntryOrderIds, no activeTradeId)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const stateMap = new Map<string, DeploymentState>([
      // No preEntryOrderIds — ownership evidence absent.
      [deployment.id, makeDeploymentState({ preEntryOrderIds: null })],
    ]);

    const brokerSearchPositions = vi.fn().mockResolvedValue([]); // flat
    const openOrders = [
      { id: 9000, contractId: contract.id, status: 1, type: 4, side: 1, customTag: null },
    ];
    const brokerSearchOrders = vi.fn().mockResolvedValue(openOrders);
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ stateMap, brokerSearchPositions, brokerSearchOrders, brokerCancelOrder });

    const verifyPromise = verifyExitClean(deps, deployment, contract, 9001, 1, null, "engine_exit", "clean");
    await vi.runAllTimersAsync();
    await verifyPromise;

    // Primary sweep skipped — no cancel for order 9000 via the primary predicate.
    // Secondary (customTag) branch also misses since order has no matching tag.
    expect(brokerCancelOrder).not.toHaveBeenCalled();
    expect(said(deps, "warn", "primary sweep skipped")).toBe(true);
  });

  it("logs error and returns when residual position remains after exit", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const stateMap = new Map<string, DeploymentState>();

    const brokerSearchPositions = vi.fn().mockResolvedValue([
      { contractId: contract.id, size: 1, id: 1, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ]);
    const deps = makeDeps({ stateMap, brokerSearchPositions });

    const verifyPromise = verifyExitClean(deps, deployment, contract, 9001, 1, 42, "engine_exit", "clean");
    await vi.runAllTimersAsync();
    await verifyPromise;

    // Named event rather than a bare level: this is one of the three the
    // ladder escalates, so the subject columns have to be populated for the
    // alert's fields to say which account and contract.
    expect(deps.logEventSpy).toHaveBeenCalledWith(
      "exit_verification_residual",
      deployment.id,
      expect.stringContaining("residual position size=1"),
      expect.objectContaining({ accountId: deployment.accountId, contractId: contract.id }),
    );
  });

  it("cancels primary sweep orphans when ownership evidence is present", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ preEntryOrderIds: [1000] })],
    ]);

    const brokerSearchPositions = vi.fn().mockResolvedValue([]); // flat
    const openOrders = [
      // Matches contract, status=Working(1), type=Stop(4), side=1 (protective for long exit), not in preIds.
      { id: 2001, contractId: contract.id, status: 1, type: 4, side: 1, customTag: null },
      // In preIds — must not be cancelled.
      { id: 1000, contractId: contract.id, status: 1, type: 4, side: 1, customTag: null },
    ];
    const brokerSearchOrders = vi.fn().mockResolvedValue(openOrders);
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ stateMap, brokerSearchPositions, brokerSearchOrders, brokerCancelOrder });

    const verifyPromise = verifyExitClean(deps, deployment, contract, 9001, 1, 42, "engine_exit", "clean");
    await vi.runAllTimersAsync();
    await verifyPromise;

    expect(brokerCancelOrder).toHaveBeenCalledWith(2001, deployment.accountId);
    expect(brokerCancelOrder).not.toHaveBeenCalledWith(1000, expect.anything());
  });

  it("the primary sweep takes a Pending protective leg, as the pre-exit cancel does (review of A11, finding 2)", async () => {
    const deployment = makeDeployment();
    const contract = makeContract();
    const openOrders = [
      { id: 2001, contractId: contract.id, status: 5, type: 4, side: 1, customTag: null },
      { id: 2002, contractId: contract.id, status: 3, type: 4, side: 1, customTag: null }, // cancelled
    ];
    const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ brokerSearchOrders: vi.fn().mockResolvedValue(openOrders), brokerCancelOrder });

    const verifyPromise = verifyExitClean(deps, deployment, contract, 9001, 1, 42, "engine_exit", "clean");
    await vi.runAllTimersAsync();
    await verifyPromise;

    expect(brokerCancelOrder.mock.calls.map((c) => c[0])).toEqual([2001]);
  });

  /**
   * A49. The no-evidence arm is reached by two callers that are not the
   * same situation. A D-2 close has no trade row **by construction** — that
   * is its defining predicate — so both operands of `hasOwnershipEvidence`
   * are false on every one of them, and the warn fired one line per leg
   * directly under a trade line saying the contract's working orders had
   * been cancelled first. A genuine engine exit reaching the same arm has
   * *lost* a snapshot it should have had, which is the case the warn was
   * written for.
   */
  describe("A49 — the no-evidence arm splits on the caller's intent", () => {
    /** Flat broker, one working stop the sweep is not scoped to reach. */
    function noEvidenceDeps() {
      const deployment = makeDeployment();
      const contract = makeContract();
      const stateMap = new Map<string, DeploymentState>([
        [deployment.id, makeDeploymentState({ preEntryOrderIds: null })],
      ]);
      const brokerCancelOrder = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        stateMap,
        brokerSearchPositions: vi.fn().mockResolvedValue([]),
        brokerSearchOrders: vi.fn().mockResolvedValue([
          { id: 9000, contractId: contract.id, status: 1, type: 4, side: 1, customTag: null },
        ]),
        brokerCancelOrder,
      });
      return { deployment, contract, deps, brokerCancelOrder };
    }

    it("says nothing about a skipped sweep on an unmanaged-position close, and does not warn", async () => {
      const { deployment, contract, deps } = noEvidenceDeps();

      const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, "unmanaged_position", "clean");
      await vi.runAllTimersAsync();
      await p;

      expect(said(deps, "warn", "primary sweep skipped")).toBe(false);
      expect(deps.logEventSpy).toHaveBeenCalledWith(
        "unmanaged_exit_verified",
        deployment.id,
        expect.stringContaining("no primary sweep"),
        expect.objectContaining({ accountId: deployment.accountId, contractId: contract.id }),
      );
    });

    it("agrees with the trade line above it about the orders having been cancelled", async () => {
      // The contradiction was the defect: two lines about one event, and
      // the one written later lost. This is the claim it now makes.
      const { deployment, contract, deps } = noEvidenceDeps();

      const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, "unmanaged_position", "clean");
      await vi.runAllTimersAsync();
      await p;

      const message = deps.logEventSpy.mock.calls[0][2] as string;
      expect(message).toContain("cancelled before the exit");
      expect(message).toContain("engine-tag branch still runs");
    });

    /**
     * The sentence above is a claim about a pass that proceeds on every
     * failure it can hit, and on a D-2 close — `activeTradeId` null — Stage 2
     * of `cancelTrackedBrackets` *is* the whole cancel, so a thrown
     * `searchOpenOrders` cancels nothing and says nothing. Both texts are
     * pinned because both are what an operator reads on their phone.
     */
    it("does not claim the cancel happened when the cancel pass reported a failure", async () => {
      const { deployment, contract, deps } = noEvidenceDeps();

      const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, "unmanaged_position", "degraded");
      await vi.runAllTimersAsync();
      await p;

      const message = deps.logEventSpy.mock.calls[0][2] as string;
      expect(message).toBe(
        `Post-exit check on ${contract.id}: no primary sweep, because the engine holds no trade row for this position ` +
          "— that is what makes it an unmanaged close. The pre-exit cancel pass reported a failure (see the warning " +
          "above), so working orders may still be resting; the engine-tag branch still runs.",
      );
      expect(message).not.toContain("were cancelled before the exit");
    });

    it("keeps the clean text byte-for-byte when the cancel pass proved it", async () => {
      const { deployment, contract, deps } = noEvidenceDeps();

      const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, "unmanaged_position", "clean");
      await vi.runAllTimersAsync();
      await p;

      expect(deps.logEventSpy.mock.calls[0][2]).toBe(
        `Post-exit check on ${contract.id}: no primary sweep, because the engine holds no trade row for this position ` +
          "— that is what makes it an unmanaged close. Its working orders were cancelled before the exit and the " +
          "engine-tag branch still runs.",
      );
    });

    it("keeps the warn verbatim for a genuine engine exit that lost its snapshot", async () => {
      const { deployment, contract, deps } = noEvidenceDeps();

      const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, "engine_exit", "clean");
      await vi.runAllTimersAsync();
      await p;

      expect(said(deps, "warn", "primary sweep skipped")).toBe(true);
      // The quiet arm is the *other* caller's. This one keeps the warn.
      expect(
        deps.logEventSpy.mock.calls.filter((c) => c[0] === "unmanaged_exit_verified"),
      ).toHaveLength(0);
    });

    /**
     * The threading, not the wording. `placeExitOrderInner` is the only
     * production caller, so a verdict that stops at its local is a fix that
     * ships as a green test and a wrong line.
     */
    it("carries a real failed cancel from placeExitOrder through to the line", async () => {
      const deployment = makeDeployment();
      const contract = makeContract();
      const stateMap = new Map<string, DeploymentState>([
        [deployment.id, makeDeploymentState({ preEntryOrderIds: null })],
      ]);
      vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
      const deps = makeDeps({
        stateMap,
        // Pre-exit lookup throws (the whole cancel on a D-2 close), then the
        // post-exit sweep's own lookup answers so verification gets that far.
        brokerSearchOrders: vi
          .fn()
          .mockRejectedValueOnce(new Error("gateway timeout"))
          .mockResolvedValue([]),
        // Live for both position reads — the one before the cancel and the
        // re-read after it — then flat for the post-exit sweep's own read.
        brokerSearchPositions: vi
          .fn()
          .mockResolvedValueOnce([{ contractId: contract.id, size: 1, type: 1 }])
          .mockResolvedValueOnce([{ contractId: contract.id, size: 1, type: 1 }])
          .mockResolvedValue([]),
      });

      await placeExitOrder(
        deps,
        stubStrategy as never,
        deployment,
        contract,
        makePosition(),
        null,
        "manual_position_close",
        "unmanaged_position",
      );
      await vi.runAllTimersAsync();

      expect(deps.logEventSpy).toHaveBeenCalledWith(
        "unmanaged_exit_verified",
        deployment.id,
        expect.stringContaining("The pre-exit cancel pass reported a failure"),
        expect.anything(),
      );
    });

    it("does not widen the gate — neither arm cancels an order it cannot prove is the engine's", async () => {
      // The one wrong fix the bug entry names. Without ownership evidence
      // the sweep cannot tell an orphaned engine bracket from the
      // operator's own resting order, so both arms must still cancel
      // nothing here; only the wording differs.
      for (const intent of ["unmanaged_position", "engine_exit"] as const) {
        const { deployment, contract, deps, brokerCancelOrder } = noEvidenceDeps();
        const p = verifyExitClean(deps, deployment, contract, 9001, 1, null, intent, "clean");
        await vi.runAllTimersAsync();
        await p;
        expect(brokerCancelOrder, intent).not.toHaveBeenCalled();
      }
    });
  });
});

// ── bracketRecoveryEligibility ────────────────────────────────────────────────

describe("bracketRecoveryEligibility", () => {
  function makeTradeRow(
    overrides: Partial<Pick<StrategyTrade, "status" | "exitOrderId">> = {},
  ): Pick<StrategyTrade, "status" | "exitOrderId"> {
    return { status: "open", exitOrderId: null, ...overrides };
  }

  it("admits an open trade with no exit in flight", () => {
    expect(bracketRecoveryEligibility(makeTradeRow(), false)).toEqual({ eligible: true });
  });

  it("refuses a pending_exit trade — the exit is submitted and unfilled", () => {
    const result = bracketRecoveryEligibility(
      makeTradeRow({ status: "pending_exit", exitOrderId: 7734 }),
      false,
    );
    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.reason).toContain("#7734");
  });

  it("names the pending exit order id even when the row has not stamped one yet", () => {
    const result = bracketRecoveryEligibility(
      makeTradeRow({ status: "pending_exit", exitOrderId: null }),
      false,
    );
    expect(result.eligible === false && result.reason).toContain("unknown");
  });

  it("refuses pending_exit regardless of the exitInFlight latch", () => {
    // The latch is released at submission; pending_exit is the window after
    // it. Neither flag alone can be relied on to catch this.
    expect(
      bracketRecoveryEligibility(makeTradeRow({ status: "pending_exit", exitOrderId: 1 }), true)
        .eligible,
    ).toBe(false);
    expect(
      bracketRecoveryEligibility(makeTradeRow({ status: "pending_exit", exitOrderId: 1 }), false)
        .eligible,
    ).toBe(false);
  });

  it("refuses an open trade while an exit is mid-submission", () => {
    const result = bracketRecoveryEligibility(makeTradeRow(), true);
    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.reason).toContain("mid-submission");
  });

  it("refuses every non-open terminal status", () => {
    for (const status of ["closed", "entry_failed", "exit_failed", "pending_entry"] as const) {
      const result = bracketRecoveryEligibility(makeTradeRow({ status }), false);
      expect(result.eligible).toBe(false);
      expect(result.eligible === false && result.reason).toContain(status);
    }
  });

  it("refuses a missing trade row", () => {
    expect(bracketRecoveryEligibility(null, false).eligible).toBe(false);
    expect(bracketRecoveryEligibility(undefined, false).eligible).toBe(false);
  });
});

// ── forceCloseAfterBracketFailure ─────────────────────────────────────────────

/**
 * `recoverFailedBrackets` checks the position, then spends up to four broker
 * round-trips before reaching this force-close. A position that flattens inside
 * that window — a lingering bracket filling, an operator flattening by hand —
 * is not an emergency, and nothing will retry it: this path is only reachable
 * from `attributeBrackets`, whose `preEntryOrderIds` snapshot is already
 * released by then.
 */
describe("forceCloseAfterBracketFailure — the book went flat mid-recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStrategy).mockReturnValue(stubStrategy as never);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 4242, status: "open", contractId: "CON.F.US.MNQ.M26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
  });

  function makeTrade(): StrategyTrade {
    return {
      id: 4242,
      deploymentId: "deploy-aaa",
      strategyKey: "test",
      side: 0,
      size: 1,
      entrySubmittedAt: "2026-01-02T14:30:00Z",
      entryFilledAt: "2026-01-02T14:30:01Z",
      desiredSlTicks: 10,
    } as unknown as StrategyTrade;
  }

  it("does not claim the position is unprotected and does not fire the force-close alert", async () => {
    const deps = makeDeps();

    await forceCloseAfterBracketFailure(deps, makeTrade(), makeDeployment(), 20000, "tp boom", "sl boom");

    const errors = messagesAt(deps, "error");
    expect(errors.some((m) => m.includes("POSITION REMAINS UNPROTECTED"))).toBe(false);
    expect(deps.notifyForceClose).not.toHaveBeenCalled();
  });

  it("clears the mirror rather than leaving a live-looking position over a flat book", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ position: makePosition(), activeTradeId: 4242 })],
    ]);
    const deps = makeDeps({ stateMap });

    await forceCloseAfterBracketFailure(deps, makeTrade(), deployment, 20000, "tp boom", "sl boom");

    expect(stateMap.get(deployment.id)?.position).toBeNull();
  });

  it("leaves another trade's mirror alone", async () => {
    const deployment = makeDeployment();
    const stateMap = new Map<string, DeploymentState>([
      [deployment.id, makeDeploymentState({ position: makePosition(), activeTradeId: 9999 })],
    ]);
    const deps = makeDeps({ stateMap });

    await forceCloseAfterBracketFailure(deps, makeTrade(), deployment, 20000, "tp boom", "sl boom");

    expect(stateMap.get(deployment.id)?.position).not.toBeNull();
  });

  it("still reports a genuine submission failure at error and alerts", async () => {
    const brokerSearchPositions = vi.fn().mockResolvedValue([
      { contractId: "CON.F.US.MNQ.M26", size: 1, id: 5, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" },
    ]);
    const brokerPlaceOrder = vi.fn().mockRejectedValue(new Error("account is locked"));
    const deps = makeDeps({ brokerSearchPositions, brokerPlaceOrder });

    await forceCloseAfterBracketFailure(deps, makeTrade(), makeDeployment(), 20000, "tp boom", "sl boom");

    const errors = messagesAt(deps, "error");
    expect(errors.some((m) => m.includes("POSITION REMAINS UNPROTECTED"))).toBe(true);
    expect(deps.notifyForceClose).toHaveBeenCalledWith(expect.anything(), 20000, "tp boom", "sl boom", false);
  });
});

/**
 * "`deps.log` and `deps.logEvent` are unguarded on every rejection-adjacent
 * path in `engine-exit.ts`" (bugs.md). Both end in the process's `onLog`
 * handler, which nothing guards. A throw from it must never change what an
 * exit did: an accepted market order reported as a throw is what callers read
 * as "nothing is on the book" and retry — a second order into a closing
 * position. Must not regress: the refusals keep their identity
 * (`EXIT_IN_FLIGHT`, `EXIT_FLAT_MISMATCH`, the broker's rejection) and the
 * lines are still emitted — the placeExitOrder tests above.
 */
describe("a throwing log handler never changes what the exit did", () => {
  const LIVE = [{ contractId: "CON.F.US.MNQ.M26", size: 1, id: 1, accountId: 1001, averagePrice: 20000, type: 1, creationTimestamp: "" }];

  function throwingDeps(over: Parameters<typeof makeDeps>[0] = {}) {
    const deps = makeDeps(over);
    const boom = () => { throw new Error("onLog handler threw"); };
    deps.logSpy.mockImplementation(boom);
    deps.logEventSpy.mockImplementation(boom);
    return deps;
  }

  let consoleError: MockInstance<typeof console.error>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it("an accepted exit returns normally", async () => {
    const deps = throwingDeps({ brokerSearchPositions: vi.fn().mockResolvedValue(LIVE) });

    await expect(
      placeExitOrder(deps, stubStrategy as never, makeDeployment(), makeContract(), makePosition(), 77, "session_close"),
    ).resolves.toBeUndefined();
    expect(deps.brokerPlaceOrder).toHaveBeenCalledTimes(1);
  });

  it("a failed bracket cancel does not abort the exit after the cover was stripped", async () => {
    const deps = throwingDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue(LIVE),
      brokerSearchOrders: vi.fn().mockResolvedValue([{ id: 5, contractId: "CON.F.US.MNQ.M26", status: 1, type: 4, side: 1 }]),
      brokerCancelOrder: vi.fn().mockRejectedValue(new Error("gateway timeout")),
    });

    await placeExitOrder(deps, stubStrategy as never, makeDeployment(), makeContract(), makePosition(), null, "session_close");

    expect(deps.brokerPlaceOrder).toHaveBeenCalledTimes(1);
  });

  it("a broker rejection still rethrows the broker's error and still reaches the orphan check", async () => {
    const rejection = new Error("account is locked");
    const deps = throwingDeps({
      brokerSearchPositions: vi.fn().mockResolvedValue(LIVE),
      brokerPlaceOrder: vi.fn().mockRejectedValue(rejection),
    });

    await expect(
      placeExitOrder(deps, stubStrategy as never, makeDeployment(), makeContract(), makePosition(), null, "session_close"),
    ).rejects.toBe(rejection);
    expect(deps.maybeOrphanFromBrokerError).toHaveBeenCalledWith(rejection, 1001);
  });

  it("the refusals keep their identity", async () => {
    const deployment = makeDeployment();
    const latched = throwingDeps({
      stateMap: new Map([[deployment.id, makeDeploymentState({ exitInFlight: true })]]),
    });
    await expect(
      placeExitOrder(latched, stubStrategy as never, deployment, makeContract(), makePosition(), null, "session_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_IN_FLIGHT);

    vi.mocked(getOpenTradeForDeployment).mockReturnValue(
      { id: 4242, status: "open", contractId: "CON.F.US.MNQ.M26" } as ReturnType<typeof getOpenTradeForDeployment>,
    );
    await expect(
      placeExitOrder(throwingDeps(), stubStrategy as never, deployment, makeContract(), makePosition(), 4242, "session_close"),
    ).rejects.toThrow(EntryExitCode.EXIT_FLAT_MISMATCH);
  });

  /** Review finding 7: a handler that always throws was invisible. Its first
   *  throw reaches the console, once per handler for the process. */
  it("reports each throwing handler to the console once, not once per call", async () => {
    vi.resetModules();
    const fresh = await import("./engine-exit");
    for (let i = 0; i < 3; i++) {
      const deps = throwingDeps({ brokerSearchPositions: vi.fn().mockResolvedValue(LIVE) });
      await fresh.placeExitOrder(deps, stubStrategy as never, makeDeployment(), makeContract(), makePosition(), 77, "session_close");
    }
    const handlers = consoleError.mock.calls.map((c) => String(c[0]));
    expect(handlers.filter((m) => m.includes(" logEvent threw"))).toHaveLength(1);
  });

  it("the quiet already-flat return stays quiet", async () => {
    await expect(
      placeExitOrder(throwingDeps(), stubStrategy as never, makeDeployment(), makeContract(), makePosition(), null, "session_close"),
    ).resolves.toBeUndefined();
  });

  it("verifyExitClean never rejects, even from its own catch arm", async () => {
    vi.useFakeTimers();
    try {
      const deps = throwingDeps({ brokerSearchPositions: vi.fn().mockRejectedValue(new Error("504")) });
      const verifying = verifyExitClean(deps, makeDeployment(), makeContract(), 9001, 1, 77, "engine_exit", "clean");
      await vi.runAllTimersAsync();
      await expect(verifying).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected force-close alert is handled, not left to terminate the process", async () => {
    vi.mocked(getStrategy).mockReturnValue(undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const deps = makeDeps({ notifyForceClose: vi.fn().mockRejectedValue(new Error("webhook threw")) });
      await forceCloseAfterBracketFailure(
        deps,
        { id: 1, deploymentId: "deploy-aaa", strategyKey: "missing" } as unknown as StrategyTrade,
        makeDeployment(),
        20000,
        "tp",
        "sl",
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
