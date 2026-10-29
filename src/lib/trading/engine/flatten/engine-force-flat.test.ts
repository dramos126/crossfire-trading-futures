/**
 * The per-deployment force flatten.
 *
 * Four of the cases here are the rules the primitive inherits rather than
 * decides — it bypasses the exit latch and only *reports* an in-flight exit,
 * it is never screened by the live-account block, it stamps a typed exit
 * reason code, and it leaves the deployment's status alone. Each is written
 * so that undoing the rule turns a test red rather than merely changing a
 * message.
 *
 * `@/lib/db/account-brokers` is mocked with a refusing screen even though
 * this module does not import it: that is the point. If the live-account
 * block is ever wired into this path, the happy-path assertions below go red
 * immediately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  getOpenTradeForDeployment: vi.fn(() => null),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  screenAccountsForAutoTrade: vi.fn(() => ({
    message: "live accounts may not be auto-traded",
    refused: [{ accountId: 9001, reason: "live accounts may not be auto-traded" }],
  })),
}));

import type { Broker } from "../../broker-access/broker";
import type { Contract, PlaceOrderRequest, PlaceOrderResponse, Position } from "@/lib/brokers/types";
import type { Deployment, DeploymentStatus } from "@/lib/trading/domain";
import type { DeploymentState } from "../engine";
import {
  forceFlatDeployment,
  FLATTEN_DEPLOYMENT_EXIT_REASON,
  type ForceFlatDeps,
} from "./engine-force-flat";
import { FlattenCooldown, FLATTEN_COOLDOWN_MS } from "../engine-flatten-cooldown";
import { attachPendingExit, getOpenTradeForDeployment } from "@/lib/db/trades";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { EVENTS } from "@/lib/logging/vocabulary";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";

const DEPL = "depl-1";
/** A funded (live) account id. The block's subject, and deliberately the
 *  default here — closing a live position is outside its scope. */
const LIVE_ACCOUNT = 9001;
const CONTRACT_ID = "CON.F.US.MNQ.M26";

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: DEPL,
    strategyKey: "test",
    accountId: LIVE_ACCOUNT,
    ticker: "/MNQ",
    contractId: null,
    status: "Active",
    paramValues: { size: 3 },
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
    position: {
      side: 0,
      entryPrice: 21000,
      entryTimestamp: "2026-01-01T14:00:00Z",
      barsSinceEntry: 3,
      entryFilledAt: "2026-01-01T14:00:01Z",
      size: 1,
      slTicks: 40,
    },
    activeTradeId: 77,
    breakEvenMoved: true,
    preEntryOrderIds: null,
    activeTpTicks: 20,
    activeSlTicks: 40,
    slMovedToBe: true,
    slCurrentPrice: 21000,
    tpCurrentPrice: 21050,
    exitInFlight: false,
    flatMismatchWarnedAt: { tradeId: 77, at: 1 },
    exitDispatchWarnedAt: null,
    pendingEntrySessionKey: null,
    signalSuppressed: false,
    ...over,
  };
}

/** A long of 2, so a correct close is a SELL 2 and a params-derived one
 *  would be 3 — the size assertion can tell them apart. */
function longPosition(size = 2): Position {
  return {
    id: 1,
    accountId: LIVE_ACCOUNT,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-01-01T14:00:00Z",
    type: 1,
    size,
    averagePrice: 21000,
  };
}

function shortPosition(size = 2): Position {
  return { ...longPosition(size), type: 2 };
}

interface Harness {
  deps: ForceFlatDeps;
  placeOrder: ReturnType<typeof vi.fn>;
  searchOpenPositions: ReturnType<typeof vi.fn>;
  cancelTrackedBrackets: ReturnType<typeof vi.fn>;
  verifyExitClean: ReturnType<typeof vi.fn>;
  resolveContract: ReturnType<typeof vi.fn>;
  brokerForAccount: ReturnType<typeof vi.fn>;
  getDeployment: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
  cooldown: FlattenCooldown;
  events: Array<{ event: string; severity: string; message: string }>;
  currentState(): DeploymentState | undefined;
  currentRow(): Deployment | null;
}

function makeHarness(opts: {
  row?: Deployment | null;
  state?: DeploymentState | undefined;
  positions?: Position[] | Position[][];
  placeOrder?: ReturnType<typeof vi.fn>;
  cooldown?: FlattenCooldown;
} = {}): Harness {
  const row = opts.row === undefined ? deployment() : opts.row;
  const deplState = "state" in opts ? opts.state : state();
  const events: Array<{ event: string; severity: string; message: string }> = [];
  const cooldown = opts.cooldown ?? new FlattenCooldown();

  // A single array is the same answer on both reads; an array of arrays lets
  // a test make the post-cancel read differ from the pre-check.
  const reads: Position[][] = Array.isArray(opts.positions?.[0])
    ? (opts.positions as Position[][])
    : [
        (opts.positions as Position[] | undefined) ?? [longPosition()],
        (opts.positions as Position[] | undefined) ?? [longPosition()],
      ];
  let readIdx = 0;

  const searchOpenPositions = vi.fn(async () => reads[Math.min(readIdx++, reads.length - 1)]);
  const placeOrder =
    opts.placeOrder ??
    vi.fn(
      async (): Promise<PlaceOrderResponse> => ({
        orderId: 5150,
        success: true,
        errorCode: 0,
        errorMessage: null,
      }),
    );
  const broker = { searchOpenPositions, placeOrder } as unknown as Broker;

  const resolveContract = vi.fn(
    async (): Promise<Contract> =>
      ({ id: CONTRACT_ID, name: "MNQ", tickSize: 0.25, tickValue: 0.5 }) as Contract,
  );
  const cancelTrackedBrackets = vi.fn(async () => "clean" as const);
  const verifyExitClean = vi.fn(async () => {});

  const logEvent = vi.fn((event: string, _d: string, message: string) => {
    events.push({ event, severity: EVENTS[event]?.severity ?? "info", message });
  });
  const getDeployment = vi.fn(() => row);
  const brokerForAccount = vi.fn(() => broker);

  const deps = {
    logEvent,
    getDeployment,
    stateFor: vi.fn(() => deplState),
    brokerForAccount,
    resolveContract,
    maybeOrphanFromBrokerError: vi.fn(),
    buildCustomTag: vi.fn((prefix: string, identity: string) => `${prefix}_${identity}`),
    cancelTrackedBrackets,
    verifyExitClean,
    flattenCooldown: cooldown,
  } satisfies ForceFlatDeps;

  return {
    deps,
    placeOrder,
    searchOpenPositions,
    cancelTrackedBrackets,
    verifyExitClean,
    resolveContract,
    brokerForAccount,
    getDeployment,
    logEvent,
    cooldown,
    events,
    currentState: () => deplState,
    currentRow: () => row,
  };
}

function submittedOrder(placeOrder: ReturnType<typeof vi.fn>): PlaceOrderRequest {
  return placeOrder.mock.calls[0][0] as PlaceOrderRequest;
}

beforeEach(() => {
  vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 77 } as ReturnType<
    typeof getOpenTradeForDeployment
  >);
  vi.mocked(attachPendingExit).mockClear();
  vi.mocked(screenAccountsForAutoTrade).mockClear();
});

describe("the happy path", () => {
  it("closes the broker's position with a market order on the closing side", async () => {
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result).toMatchObject({
      deploymentId: DEPL,
      accountId: LIVE_ACCOUNT,
      contractId: CONTRACT_ID,
      status: "closed",
      size: 2,
      orderId: 5150,
    });
    const order = submittedOrder(h.placeOrder);
    expect(order.type).toBe(2);
    expect(order.side).toBe(1);
    expect(order.contractId).toBe(CONTRACT_ID);
  });

  it("sizes off the broker, not off paramValues", async () => {
    // `paramValues.size` is 3 and the broker holds 2. Sizing a market exit
    // off intent is the over-sell bug the post-entry rule exists to prevent,
    // and a partial fill makes the two disagree routinely.
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(submittedOrder(h.placeOrder).size).toBe(2);
  });

  it("buys to close a short", async () => {
    const h = makeHarness({ positions: [shortPosition()] });

    await forceFlatDeployment(h.deps, DEPL);

    expect(submittedOrder(h.placeOrder).side).toBe(0);
  });

  it("stamps the typed reason code on the trade row, never a label", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(attachPendingExit).toHaveBeenCalledTimes(1);
    const stamped = vi.mocked(attachPendingExit).mock.calls[0][0];
    expect(stamped.exitReason).toBe(FLATTEN_DEPLOYMENT_EXIT_REASON);
    expect(stamped.exitReason).toBe("flatten_deployment");
    expect(stamped.exitOrderId).toBe(5150);
    expect(stamped.tradeId).toBe(77);
  });

  it("cancels the brackets before the market order, then re-reads the size", async () => {
    // An OCO leg surviving the close sits on the *closing* side, so filling
    // one opens an unbracketed reverse. The re-read after it is what keeps
    // the submitted size from being one cancel round-trip stale.
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    const cancelledAt = h.cancelTrackedBrackets.mock.invocationCallOrder[0];
    expect(cancelledAt).toBeLessThan(h.placeOrder.mock.invocationCallOrder[0]);
    expect(h.searchOpenPositions).toHaveBeenCalledTimes(2);
    expect(h.searchOpenPositions.mock.invocationCallOrder[1]).toBeGreaterThan(cancelledAt);
  });

  it("tears the position mirror down so the tick path cannot fire a second exit", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    const st = h.currentState();
    expect(st?.position).toBeNull();
    expect(st?.slCurrentPrice).toBeNull();
    expect(st?.tpCurrentPrice).toBeNull();
    expect(st?.breakEvenMoved).toBe(false);
    expect(st?.flatMismatchWarnedAt).toBeNull();
    expect(st?.cooldownAnchorAt).not.toBeNull();
  });

  it("hands the post-exit verification the cancel verdict it measured", async () => {
    const h = makeHarness();
    h.cancelTrackedBrackets.mockResolvedValueOnce("degraded");

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.verifyExitClean).toHaveBeenCalledTimes(1);
    expect(h.verifyExitClean.mock.calls[0][5]).toBe("degraded");
  });

  it("announces the close under a trade-category event", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    const line = h.events.find((e) => e.event === "deployment_flatten");
    expect(line).toBeDefined();
    expect(EVENTS.deployment_flatten.category).toBe("trade");
  });
});

describe("a deployment that is already flat", () => {
  it("reports already_flat and places nothing", async () => {
    const h = makeHarness({ positions: [] });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("already_flat");
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("does not touch the deployment's working orders", async () => {
    // The pre-check exists for this: stripping the orders off a flat
    // deployment is not what "flatten this deployment" asked for, and
    // `cancelTrackedBrackets` falls through to an open-order sweep of the
    // whole contract when there is no live trade row to name ids from.
    const h = makeHarness({ positions: [] });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.cancelTrackedBrackets).not.toHaveBeenCalled();
    expect(h.searchOpenPositions).toHaveBeenCalledTimes(1);
  });

  it("reports already_flat when the position closes inside the cancel window", async () => {
    const h = makeHarness({ positions: [[longPosition()], []] });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("already_flat");
    expect(h.cancelTrackedBrackets).toHaveBeenCalledTimes(1);
    expect(h.placeOrder).not.toHaveBeenCalled();
  });
});

describe("a broker rejection", () => {
  it("reports the failure rather than throwing it", async () => {
    // Attempt-then-report: a caller flattening N deployments must not lose
    // the other N−1 to one refusal.
    const placeOrder = vi.fn(async () => {
      throw new Error("Account is not active");
    });
    const h = makeHarness({ placeOrder });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("error");
    expect(result.reason).toContain("Account is not active");
  });

  it("keeps the position mirror, because nothing was closed", async () => {
    const placeOrder = vi.fn(async () => {
      throw new Error("Account is not active");
    });
    const h = makeHarness({ placeOrder });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.currentState()?.position).not.toBeNull();
    expect(attachPendingExit).not.toHaveBeenCalled();
  });

  it("releases the cooldown stamp it made, so the sweeps are not held off for nothing", async () => {
    const placeOrder = vi.fn(async () => {
      throw new Error("Account is not active");
    });
    const h = makeHarness({ placeOrder });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.cooldown.active(LIVE_ACCOUNT, CONTRACT_ID)).toBe(false);
  });

  it("reports at error and routes the throw to the orphan classifier", async () => {
    const placeOrder = vi.fn(async () => {
      throw new Error("Account is not active");
    });
    const h = makeHarness({ placeOrder });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.events.some((e) => e.event === "deployment_flatten_failed" && e.severity === "error")).toBe(
      true,
    );
    expect(h.deps.maybeOrphanFromBrokerError).toHaveBeenCalledTimes(1);
  });

  it("reports rather than throwing when the positions read fails", async () => {
    const h = makeHarness();
    h.searchOpenPositions.mockRejectedValueOnce(new Error("gateway timeout"));

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("error");
    expect(result.reason).toContain("gateway timeout");
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("reports rather than throwing when the contract will not resolve", async () => {
    const h = makeHarness();
    h.resolveContract.mockRejectedValueOnce(new Error("no front month"));

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result).toMatchObject({ status: "error", contractId: null });
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("reports rather than throwing for an id no deployment carries", async () => {
    const h = makeHarness({ row: null });

    const result = await forceFlatDeployment(h.deps, "no-such-deployment");

    expect(result).toMatchObject({ deploymentId: "no-such-deployment", status: "error", accountId: null });
    expect(h.placeOrder).not.toHaveBeenCalled();
  });
});

describe("an in-flight engine exit is reported, never deferred to", () => {
  it("flattens anyway and says so on the result", async () => {
    // The rule `flatten-all` already carries. Promoting this read to a gate
    // makes the last-resort path refusable by the machinery it exists to
    // work around.
    const h = makeHarness({ state: state({ exitInFlight: true }) });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(result.exitInFlight).toBe(true);
    expect(h.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("warns so a doubled fill count has an explanation", async () => {
    const h = makeHarness({ state: state({ exitInFlight: true }) });

    await forceFlatDeployment(h.deps, DEPL);

    const line = h.events.find((e) => e.event === "deployment_flatten_exit_in_flight");
    expect(line?.severity).toBe("warn");
  });

  it("omits the flag entirely when no exit was latched", async () => {
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.exitInFlight).toBeUndefined();
  });
});

describe("the live-account block does not reach this path", () => {
  it("closes a position on a funded account", async () => {
    // Refusing to *close* on a live account inverts the rule the block
    // exists to serve. The mocked screen refuses everything; a flatten that
    // consulted it would fail here.
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(screenAccountsForAutoTrade).not.toHaveBeenCalled();
  });

  it("closes a position on a deployment the engine holds no state for", async () => {
    // The row is read from the database rather than from the engine's
    // deployment set, so a withheld live-account row — which has no state
    // entry, because the engine never managed it — is still closeable.
    const h = makeHarness({ state: undefined });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
  });
});

describe("deployment status is not the subject", () => {
  it("leaves an Active deployment Active", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.currentRow()?.status).toBe("Active");
  });

  it.each<DeploymentStatus>(["Active", "Pausing", "Paused", "Destroying"])(
    "closes the position of a %s deployment without rewriting the row",
    async (status) => {
      const row = deployment({ status });
      const h = makeHarness({ row });

      const result = await forceFlatDeployment(h.deps, DEPL);

      expect(result.status).toBe("closed");
      expect(h.currentRow()?.status).toBe(status);
    },
  );
});

describe("the shared flatten cooldown", () => {
  it("stands down when another actor's market order may still be unbooked", async () => {
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "watchdog");
    const h = makeHarness({ cooldown });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("deferred");
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("stands down before the brackets are cancelled, not after", async () => {
    // Cancelling and then deferring strips the cover off a position this
    // pass has decided not to close.
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "session");
    const h = makeHarness({ cooldown });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.cancelTrackedBrackets).not.toHaveBeenCalled();
  });

  it("stamps before the submit, so the other four actors see it while the order is on the wire", async () => {
    // The window this closes is the round trip itself, so a sequential test
    // cannot tell the two orderings apart — the submit is parked and the
    // cooldown read happens while it is still open.
    let release: (r: PlaceOrderResponse) => void = () => {};
    const parked = new Promise<PlaceOrderResponse>((resolve) => {
      release = resolve;
    });
    const placeOrder = vi.fn(() => parked);
    const h = makeHarness({ placeOrder });

    const pending = forceFlatDeployment(h.deps, DEPL);
    // One macrotask boundary drains every microtask in front of the submit —
    // the resolve, both position reads and the bracket cancel — and leaves
    // the parked `placeOrder` outstanding.
    await new Promise((r) => setTimeout(r, 0));

    expect(h.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.cooldown.active(LIVE_ACCOUNT, CONTRACT_ID)).toBe(true);

    release({ orderId: 5150, success: true, errorCode: 0, errorMessage: null });
    await pending;
  });

  it("keeps the stamp after a successful submit", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.cooldown.active(LIVE_ACCOUNT, CONTRACT_ID)).toBe(true);
  });

  /**
   * The check at the top of the function is two broker round trips from the
   * stamp — a contract resolve, a bracket cancel and a second positions read
   * — so on its own it is a *pre-check*, not a mutex. The mutex is the
   * re-check immediately before `note()`, and what makes it one is that no
   * `await` sits between the two.
   *
   * This is the test that goes red if one is reintroduced: two passes with
   * identical await counts park at the same points, so an await anywhere
   * between the re-check and the stamp lets both pass the re-check before
   * either stamps — and two market orders into one position is the
   * unbracketed reverse the cooldown exists to prevent. It is also the one
   * actor a human can fire twice.
   */
  it("refuses to let two concurrent presses both reach the wire", async () => {
    const h = makeHarness();

    const [first, second] = await Promise.all([
      forceFlatDeployment(h.deps, DEPL),
      forceFlatDeployment(h.deps, DEPL),
    ]);

    expect(h.placeOrder).toHaveBeenCalledTimes(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["closed", "deferred"]);
    const stoodDown = first.status === "deferred" ? first : second;
    expect(stoodDown.deferredTo).toBe("force_flat");
  });

  it("announces the close only on the pass that submits it", async () => {
    // The announcement used to sit ahead of the re-check, so a stood-down
    // pass said it was closing a position it never submitted for.
    const h = makeHarness();

    const [first, second] = await Promise.all([
      forceFlatDeployment(h.deps, DEPL),
      forceFlatDeployment(h.deps, DEPL),
    ]);

    expect([first.status, second.status].sort()).toEqual(["closed", "deferred"]);
    expect(h.events.filter((e) => e.event === "deployment_flatten")).toHaveLength(1);
  });

  it("stays deferred when the stand-down line itself throws", async () => {
    // Otherwise a throwing log handler turns a stand-down into `error` with
    // `positionMayStillBeOpen` and an unsilenceable page, when the truth is
    // that another actor is closing the position.
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "watchdog");
    const h = makeHarness({ cooldown });
    h.logEvent.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("deferred");
    expect(result.deferredTo).toBe("watchdog");
  });
});

/**
 * `force_flat` is the one actor with no interval, so a deferral to its own
 * stamp defers to nobody. On a partial fill or an accepted-then-rejected
 * order `verifyExitClean` logs the residual and never re-fires, and the
 * mirror is already torn down — so the second press inside the window used
 * to return `deferred` with a message promising a close that was not coming.
 *
 * The refusal itself stands: overriding it risks doubling into an
 * unbracketed reverse, which is worse than a visible wait. What is asserted
 * here is that it stops lying about what happens next.
 */
describe("deferring to its own stamp", () => {
  it("says that nothing retries this one and to press again", async () => {
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "force_flat");
    const h = makeHarness({ cooldown });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("deferred");
    expect(result.deferredTo).toBe("force_flat");
    expect(result.reason).toContain("nothing retries it");
    expect(result.reason).toContain("press again");
    const line = h.events.find((e) => e.event === "flatten_deferred");
    expect(line?.message).toContain("Nothing retries this one");
    // The claim that was false: no promise that another actor is finishing.
    expect(line?.message).not.toContain("finishing the close");
  });

  it("carries the remaining window, so a surface can count it down", async () => {
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "force_flat");
    const h = makeHarness({ cooldown });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(FLATTEN_COOLDOWN_MS);
  });

  // The stamp's holder already tore the mirror down, so the guard's next pass
  // skips the row: promising it would look again is a retry nothing performs.
  it("tells the closing guard the row settles when the close books, promising no retry or press", async () => {
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "force_flat");
    const h = makeHarness({ cooldown });

    const result = await forceFlatDeployment(h.deps, DEPL, { caller: "closing_guard" });

    expect(result.status).toBe("deferred");
    expect(result.reason).toContain("the row settles when the submitted close books");
    expect(result.reason).not.toContain("press again");
    expect(result.reason).not.toContain("looks again");
    const line = h.events.find((e) => e.event === "flatten_deferred");
    expect(line?.message).toContain("the row settles when the submitted close books");
    expect(line?.message).not.toContain("press flatten again");
    expect(line?.message).not.toContain("looks again");
  });

  it("keeps the old message when it defers to an actor that does retry", async () => {
    // True of the other four: each has an interval, so the actor that
    // stamped really is the one finishing the close.
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "session");
    const h = makeHarness({ cooldown });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.deferredTo).toBe("session");
    expect(result.reason).toContain("another close of this position was submitted");
    expect(h.events.find((e) => e.event === "flatten_deferred")?.message).toContain(
      "finishing the close",
    );
  });
});

/**
 * Two of the four statuses mean the position may still be open, and a
 * surface that renders on the status string alone shows a deferral as a
 * completed close. The flag is what a caller reads instead.
 */
describe("what the result says about the position", () => {
  it("marks a deferral and an error, and neither of the other two", async () => {
    const cooldown = new FlattenCooldown();
    cooldown.note(LIVE_ACCOUNT, CONTRACT_ID, "watchdog");

    const failing = makeHarness();
    failing.searchOpenPositions.mockRejectedValueOnce(new Error("gateway timeout"));

    const deferred = await forceFlatDeployment(makeHarness({ cooldown }).deps, DEPL);
    const errored = await forceFlatDeployment(failing.deps, DEPL);
    const closed = await forceFlatDeployment(makeHarness().deps, DEPL);
    const flat = await forceFlatDeployment(makeHarness({ positions: [] }).deps, DEPL);

    expect(deferred.positionMayStillBeOpen).toBe(true);
    expect(errored.positionMayStillBeOpen).toBe(true);
    expect(closed.positionMayStillBeOpen).toBeUndefined();
    expect(flat.positionMayStillBeOpen).toBeUndefined();
  });

  /**
   * The stale-id arm is the one `error` that does not carry the flag, and
   * that is the point of splitting it out: no row has ever existed, so no
   * position was identified. A board reading the flag instead of the status
   * string would otherwise warn that a position may be open and offer a
   * retry against an id that will never resolve.
   */
  it("does not claim an open position on the arm that identified none", async () => {
    const errored = await forceFlatDeployment(makeHarness({ row: null }).deps, DEPL);

    expect(errored.status).toBe("error");
    expect(errored.positionMayStillBeOpen).toBeUndefined();
  });
});

/**
 * The contract is *no throw*, and it is held by an outer catch around the
 * whole body rather than by each arm being individually safe — three of the
 * deps throw by design and an arm added later will reach a fourth.
 */
describe("a dep that throws is still a result", () => {
  it("reports rather than throwing when the registry has lost the account", async () => {
    // `brokerForAccount` throws for an account the registry no longer knows,
    // which is the combine → XFA orphan this path exists to be able to
    // reach. The result still names the account.
    const h = makeHarness();
    h.brokerForAccount.mockImplementation(() => {
      throw new Error("No broker registered for account 9001");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result).toMatchObject({ status: "error", accountId: LIVE_ACCOUNT, contractId: null });
    expect(result.reason).toContain("No broker registered");
    expect(h.events.some((e) => e.event === "deployment_flatten_failed")).toBe(true);
    expect(h.resolveContract).not.toHaveBeenCalled();
  });

  it("reports rather than throwing when the deployment read hits a locked database", async () => {
    const h = makeHarness();
    h.getDeployment.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result).toMatchObject({ status: "error", deploymentId: DEPL });
    expect(result.reason).toContain("SQLITE_BUSY");
  });

  it("reports rather than throwing when the trade-row read hits a locked database", async () => {
    vi.mocked(getOpenTradeForDeployment).mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("error");
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("does not turn a submitted close into an error when the bookkeeping throws", async () => {
    // The order is on the wire by then, so `error` — *the position may still
    // be open* — is the one lie this path must not tell.
    const h = makeHarness();
    h.verifyExitClean.mockImplementation(() => {
      throw new Error("exit deps blew up");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result).toMatchObject({ status: "closed", orderId: 5150 });
  });

  it("still reports when the log line itself throws", async () => {
    // `logEvent` reaches a database-backed display cache. The failure
    // reporter is the one site whose whole job is to not throw.
    const h = makeHarness({ row: null });
    h.logEvent.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("error");
  });

  it("flags the failure for Discord, because nothing else reads the result", async () => {
    // Nothing renders a `ForceFlatResult` today — the engine method has no
    // caller — so without the flag a failed emergency close reaches `/logs`
    // and nobody else.
    expect(EVENTS.deployment_flatten_failed.escalates).toBe(true);
    expect(EVENTS.deployment_flatten_failed.severity).toBe("error");
  });
});

/**
 * `getDeployment` does not filter `deleted_at`, so a null row means no row
 * has ever existed under that id — a stale board id rather than a failed
 * close. It stays an `error` result and it still logs, and it must **not**
 * page: the escalating event is exempt from the notifications kill-switch
 * and its throttle keys on the deployment id, so N stale ids were N
 * unsilenceable alerts about a position this arm never identified.
 */
describe("an id with no deployment row", () => {
  it("reports error without reaching for the escalating event", async () => {
    const h = makeHarness({ row: null });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("error");
    expect(h.events.some((e) => e.event === "deployment_flatten_failed")).toBe(false);
    expect(h.events.some((e) => e.event === "deployment_flatten_no_row")).toBe(true);
  });

  it("takes an event the kill-switch can silence, at warn", () => {
    expect(EVENTS.deployment_flatten_no_row.severity).toBe("warn");
    expect(EVENTS.deployment_flatten_no_row.category).toBe("safety");
    expect(EVENTS.deployment_flatten_no_row.escalates).toBeUndefined();
  });

  it("asserts nothing was left open, which is what the paging line could not", async () => {
    const h = makeHarness({ row: null });

    await forceFlatDeployment(h.deps, DEPL);

    const line = h.events.find((e) => e.event === "deployment_flatten_no_row");
    expect(line?.message).toContain("nothing has been left open");
    expect(line?.message).not.toContain("may still be open");
  });

  it("keeps the escalating event for an arm that did reach a broker", async () => {
    const placeOrder = vi.fn(async () => {
      throw new Error("Account is not active");
    });
    const h = makeHarness({ placeOrder });

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.events.some((e) => e.event === "deployment_flatten_failed")).toBe(true);
  });
});

/**
 * The closing guard calls this every 15s for a closing row with no registered
 * playbook, and reports a failure itself on its own throttle. The paging line
 * from here on every pass would be an alert the kill-switch cannot silence.
 */
describe("when the closing guard is the caller", () => {
  /** The events the registry escalates, whatever they are named. */
  const paging = (h: Harness) => new Set(h.events.filter((e) => EVENTS[e.event]?.escalates).map((e) => e.event));

  const failingArms: Array<[string, () => Harness]> = [
    [
      "the registry has lost the account",
      () => {
        const h = makeHarness();
        h.brokerForAccount.mockImplementation(() => {
          throw new Error("No broker registered for account 9001");
        });
        return h;
      },
    ],
    [
      "the contract will not resolve",
      () => {
        const h = makeHarness();
        h.resolveContract.mockRejectedValue(new Error("broker unreachable"));
        return h;
      },
    ],
    [
      "the positions read fails",
      () => {
        const h = makeHarness();
        h.searchOpenPositions.mockRejectedValue(new Error("gateway timeout"));
        return h;
      },
    ],
    [
      "the broker refuses the closing order",
      () =>
        makeHarness({
          placeOrder: vi.fn(async () => {
            throw new Error("Account is not active");
          }),
        }),
    ],
    [
      "the deployment read hits a locked database",
      () => {
        const h = makeHarness();
        h.getDeployment.mockImplementation(() => {
          throw new Error("SQLITE_BUSY: database is locked");
        });
        return h;
      },
    ],
  ];

  it.each(failingArms)("leaves the report to the guard when %s", async (_arm, build) => {
    const h = build();

    const result = await forceFlatDeployment(h.deps, DEPL, { caller: "closing_guard" });

    expect(result.status).toBe("error");
    expect(result.positionMayStillBeOpen).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(paging(h)).toEqual(new Set());
  });

  // The control that keeps the empty set above from passing vacuously: the
  // same failure under the default caller pages, by the registry's flag.
  it("still pages for the same failure when an operator pressed", async () => {
    const h = makeHarness();
    h.resolveContract.mockRejectedValue(new Error("broker unreachable"));

    await forceFlatDeployment(h.deps, DEPL);

    expect(paging(h)).toEqual(new Set(["deployment_flatten_failed"]));
  });
});

/**
 * The cancel runs on **every** pass that found a position, including the one
 * where the engine holds no trade row.
 *
 * That case was narrowed away once, on the grounds that Stage 2 would sweep
 * an operator's own hand stop. These are the tests that keep it from being
 * narrowed again: nothing covers the tail if the cancel is skipped —
 * `verifyExitClean`'s primary sweep is gated on ownership evidence that is
 * false by construction here — and the hand position is being closed by this
 * flatten regardless, because the closing order is sized off a
 * contract-scoped position read.
 */
describe("the bracket cancel does not need a row to name ids from", () => {
  it("still cancels when there is no live trade row", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(h.cancelTrackedBrackets).toHaveBeenCalledWith(expect.anything(), expect.anything(), null, expect.anything());
    expect(result.status).toBe("closed");
  });

  it("hands the verification whatever verdict the cancel actually measured", async () => {
    // Not a synthesised `degraded`: the skipped-cancel version reported one
    // without a cancel having run, which is the claim the verdict exists to
    // keep checkable.
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.verifyExitClean.mock.calls[0][5]).toBe("clean");
  });

  // A11: with a row and no snapshot, the cancel keeps to the legs on the
  // closing side, so it has to be told which side that is — from the broker.
  it("A11 — hands the cancel the closing side of the position the broker reported", async () => {
    const long = makeHarness();
    await forceFlatDeployment(long.deps, DEPL);
    expect(long.cancelTrackedBrackets.mock.calls[0][3]).toBe(1);

    const short = makeHarness({ positions: [shortPosition()] });
    await forceFlatDeployment(short.deps, DEPL);
    expect(short.cancelTrackedBrackets.mock.calls[0][3]).toBe(0);
  });

  it("passes the row's trade id when there is one", async () => {
    const h = makeHarness();

    await forceFlatDeployment(h.deps, DEPL);

    expect(h.cancelTrackedBrackets).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      77,
      expect.anything(),
    );
  });
});

/**
 * A resting protective leg after the position goes flat is what opens an
 * unbracketed reverse, so "the cancel was not confirmed" is an actionable
 * fact — a typed field, not a sentence a surface has to substring-match out
 * of `reason`.
 */
describe("working orders that may have survived the cancel", () => {
  it("says so when the position closed and the cancel was not confirmed", async () => {
    // This arm returns before `verifyExitClean`, so the verdict has nowhere
    // else to go: working orders may survive on a contract the operator
    // now believes is settled.
    const h = makeHarness({ positions: [[longPosition()], []] });
    h.cancelTrackedBrackets.mockResolvedValueOnce("degraded");

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("already_flat");
    expect(result.workingOrdersMayRemain).toBe(true);
    expect(h.verifyExitClean).not.toHaveBeenCalled();
  });

  it("flags a submitted close whose bracket cancel degraded", async () => {
    const h = makeHarness();
    h.cancelTrackedBrackets.mockResolvedValueOnce("degraded");

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(result.workingOrdersMayRemain).toBe(true);
  });

  it("omits the flag when the cancel was clean, and when none was attempted", async () => {
    const closed = await forceFlatDeployment(makeHarness().deps, DEPL);
    // Already flat before the cancel: nothing was touched, so there is
    // nothing to warn about.
    const flat = await forceFlatDeployment(makeHarness({ positions: [] }).deps, DEPL);

    expect(closed.workingOrdersMayRemain).toBeUndefined();
    expect(flat.workingOrdersMayRemain).toBeUndefined();
  });
});

describe("the bookkeeping half", () => {
  it("says so out loud when there is no live trade row to stamp", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(attachPendingExit).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.event === "deployment_flatten_unstamped")).toBe(true);
  });

  it("tears the mirror down even when the stamp's own log line throws", async () => {
    // Teardown runs first because it is the step whose omission is
    // dangerous: a live mirror lets the tick path dispatch a second exit
    // against a position already closing. The stamp's no-row arm logs
    // unguarded, so behind it teardown was reachable only when that line
    // succeeded.
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
    const h = makeHarness();
    h.logEvent.mockImplementation((event: string) => {
      if (event === "deployment_flatten_unstamped") throw new Error("SQLITE_BUSY");
    });

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(h.currentState()?.position).toBeNull();
  });

  it("handles a rejected verification rather than letting it kill the process", async () => {
    // A try/catch only catches synchronous throws; a rejected promise
    // escapes it, and an unhandled rejection terminates Node mid-position.
    const h = makeHarness();
    h.verifyExitClean.mockRejectedValueOnce(new Error("exit deps blew up"));

    const result = await forceFlatDeployment(h.deps, DEPL);
    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe("closed");
    // `exit_verify_failed`, not `deployment_flatten_unstamped` — the stamp
    // may have landed one statement earlier, and that event names a trade
    // row that could not be written. Filtering /logs for unstamped exits
    // must not return a verification that merely failed to run.
    expect(
      h.events.some(
        (e) => e.event === "exit_verify_failed" && e.message.includes("exit deps blew up"),
      ),
    ).toBe(true);
    expect(h.events.some((e) => e.event === "deployment_flatten_unstamped")).toBe(false);
  });

  it("does not fail the close when the stamp write throws", async () => {
    vi.mocked(attachPendingExit).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const h = makeHarness();

    const result = await forceFlatDeployment(h.deps, DEPL);

    expect(result.status).toBe("closed");
    expect(h.events.some((e) => e.event === "deployment_flatten_unstamped")).toBe(true);
  });
});

describe("a SIGTERM's exit waits for it", () => {
  // The closing guard reaches this with no route around it, and it cancels
  // the brackets before its market order: cut between the two, the position
  // has no stop.
  it("is order work in flight from the first read until the market order returns", async () => {
    delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
    let land!: (r: PlaceOrderResponse) => void;
    const h = makeHarness({ placeOrder: vi.fn(() => new Promise<PlaceOrderResponse>((r) => (land = r))) });

    const flattening = forceFlatDeployment(h.deps, DEPL);
    await vi.waitFor(() => expect(h.placeOrder).toHaveBeenCalledTimes(1));
    expect(h.cancelTrackedBrackets).toHaveBeenCalledTimes(1);
    expect(orderRequestsInFlight()).toBe(1);

    land({ orderId: 5150, success: true, errorCode: 0, errorMessage: null });
    expect((await flattening).status).toBe("closed");
    expect(orderRequestsInFlight()).toBe(0);
  });

  it("keeps the post-exit check in flight after it returns, until the check's broker work does", async () => {
    // Dispatched without awaiting; cut inside it, a bracket leg the degraded
    // cancel left resting on the flat position is never swept.
    delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
    const h = makeHarness({});
    let checked!: () => void;
    h.verifyExitClean.mockImplementation(() => new Promise<void>((r) => (checked = r)));

    expect((await forceFlatDeployment(h.deps, DEPL)).status).toBe("closed");
    expect(h.verifyExitClean).toHaveBeenCalledTimes(1);
    expect(orderRequestsInFlight()).toBe(1);

    checked();
    await vi.waitFor(() => expect(orderRequestsInFlight()).toBe(0));
  });
});
