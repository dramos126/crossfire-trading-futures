/**
 * D-2 enforcement — the engine force-closes positions it did not open.
 *
 * This is the only engine sweep that closes a position the *operator*
 * opened, so most of what is asserted here is what it refuses to touch. Each
 * refusal is a separate arm and each one has been verified by injecting the
 * mutation that removes it — see the phase report; a guard read from intent
 * guards the author's imagination rather than the code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("../../strategies", () => ({
  getStrategy: vi.fn(),
}));

import type { Contract, Position } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment } from "@/lib/trading/domain";
import type { StrategyModule } from "../../strategy-types";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";
import {
  ManualPositionGuard,
  MANUAL_POSITION_EXIT_REASON,
  MANUAL_POSITION_GUARD_INTERVAL_MS,
  contractForClaimedMonth,
  nextWindowStartNy,
  type ManualPositionGuardDeps,
} from "./engine-manual-position";
import { FlattenCooldown, FLATTEN_COOLDOWN_MS } from "../engine-flatten-cooldown";
import {
  ACCOUNT_VIEW_MAX_AGE_MS,
  applyPositionEvent,
  freshPositions,
  recordPositions,
  resetAccountViewForTests,
} from "../realtime/account-view";
import { EVENTS } from "@/lib/logging/vocabulary";

/** The registry's severity for an event, which is the only place it lives. */
function severityOf(event: unknown): string | undefined {
  return EVENTS[String(event)]?.severity;
}

const ACCT = 4242;
const DEPLOY = "deploy-mgc";
/** The deployment's own front month. */
const MGC_Z26 = "CON.F.US.MGC.Z26";
/** A later month of the same product — D-2 claims this too. */
const MGC_G27 = "CON.F.US.MGC.G27";
/** A product no deployment here trades. */
const MNQ_U26 = "CON.F.US.MNQ.U26";

/** 2026-08-24 is a Monday. 14:30 UTC = 10:30 ET, inside 09:30–16:00. */
const IN_WINDOW = new Date("2026-08-24T14:30:00.000Z");
/** 12:00 UTC = 08:00 ET, before the window opens. */
const BEFORE_WINDOW = new Date("2026-08-24T12:00:00.000Z");

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: DEPLOY,
    accountId: ACCT,
    ticker: "/MGC",
    strategyKey: "test-strategy",
    status: "Active",
    groupId: null,
    paramValues: {},
    ...over,
  } as unknown as Deployment;
}

/** The registered playbook's declared window — where the trading session lives
 *  now. `mockStrategySession` is how a test moves it, because a deployment
 *  carries none. */
function mockStrategySession(start: string, end: string): void {
  vi.mocked(getStrategy).mockReturnValue({
    params: {},
    config: { session: { start, end, timezone: "America/New_York" } },
  } as unknown as StrategyModule);
}

function contract(id = MGC_Z26): Contract {
  return {
    id,
    name: id,
    description: "Micro Gold",
    tickSize: 0.1,
    tickValue: 1,
    activeContract: true,
    symbolId: "F.US.MGC",
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: 1,
    accountId: ACCT,
    contractId: MGC_G27,
    creationTimestamp: "2026-08-24T13:00:00.000Z",
    type: 1,
    size: 2,
    averagePrice: 3100,
    ...over,
  };
}

function trade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    deploymentId: DEPLOY,
    accountId: ACCT,
    contractId: MGC_Z26,
    side: 0,
    size: 1,
    status: "open",
    ...over,
  } as unknown as StrategyTrade;
}

type MockedDeps = { [K in keyof Omit<ManualPositionGuardDeps, "flattenCooldown">]: ReturnType<typeof vi.fn> };

interface Harness {
  guard: ManualPositionGuard;
  deps: MockedDeps;
  searchOpenPositions: ReturnType<typeof vi.fn>;
  flattenCooldown: FlattenCooldown;
}

function harness(over: {
  deployments?: Deployment[];
  positions?: Position[];
  trades?: StrategyTrade[];
  engineEnabled?: boolean;
  locked?: boolean;
  contractId?: string;
  flattenCooldown?: FlattenCooldown;
} = {}): Harness {
  const searchOpenPositions = vi.fn(async () => over.positions ?? []);
  const flattenCooldown = over.flattenCooldown ?? new FlattenCooldown();
  const deps = {
    log: vi.fn(),
    realtimeDeployments: vi.fn(() => over.deployments ?? [deployment()]),
    isLegEngineEnabled: vi.fn(() => over.engineEnabled ?? true),
    isAccountRegistered: vi.fn(() => true),
    brokerForAccount: vi.fn(() => ({ searchOpenPositions })),
    resolveContract: vi.fn(async () => contract(over.contractId ?? MGC_Z26)),
    reconcilableTrades: vi.fn(() => over.trades ?? []),
    isContractLocked: vi.fn(() => over.locked ?? false),
    placeExitOrder: vi.fn(async () => {}),
    logEvent: vi.fn(),
  };
  return {
    guard: new ManualPositionGuard({ ...deps, flattenCooldown } as unknown as ManualPositionGuardDeps),
    deps,
    searchOpenPositions,
    flattenCooldown,
  };
}

beforeEach(() => {
  // The account view is process state: a sweep test's write would otherwise
  // answer a later preview test's read.
  resetAccountViewForTests();
  vi.useFakeTimers();
  vi.setSystemTime(IN_WINDOW);
  mockStrategySession("09:30", "16:00");
});

describe("ManualPositionGuard — what it closes", () => {
  it("force-closes a wholly manual position on a claimed instrument", async () => {
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    const [, depl, ctr, pos, activeTradeId, reason] = h.deps.placeExitOrder.mock.calls[0];
    expect((depl as Deployment).id).toBe(DEPLOY);
    expect((ctr as Contract).executionContractId).toBe(MGC_G27);
    expect(pos).toMatchObject({ side: 0, size: 2 });
    expect(activeTradeId).toBeNull();
    expect(reason).toBe(MANUAL_POSITION_EXIT_REASON);
  });

  it("claims a different contract month of the same product", async () => {
    // The deployment resolves MGC Z26; the hand position sits on G27. D-2's
    // instrument is the product root, because different months of one product
    // are the same economic exposure against one account's drawdown limit.
    const h = harness({ positions: [position({ contractId: MGC_G27 })] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("closes a manual short with the entry side a Sell, never a cast from PositionType", async () => {
    // `PositionType` 2 is Short; `OrderSide` 1 is Sell. They collide at the
    // literal 1 with opposite meanings, so a short read through a cast places
    // the wrong side.
    const h = harness({ positions: [position({ type: 2, size: 3 })] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder.mock.calls[0][3]).toMatchObject({ side: 1, size: 3 });
  });

  it("passes activeTradeId null so the bracket cancel takes its whole-contract arm", async () => {
    // Null is what makes `cancelTrackedBrackets` cancel every working order on
    // the contract — D-2's "cancel its non-engine working orders" — and it is
    // only safe because the contract is wholly manual.
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder.mock.calls[0][4]).toBeNull();
  });
});

describe("ManualPositionGuard — the carve-out and its expiry", () => {
  it("leaves a hand position alone when no deployment on that instrument is Active", async () => {
    const h = harness({ positions: [position()], engineEnabled: false });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.searchOpenPositions).not.toHaveBeenCalled();
  });

  it("leaves it alone while the deployment is Active but outside its session window", async () => {
    // D-11 narrows D-2: the carve-out ends when the deployment is Active
    // **and in-window**, not when it merely goes Active.
    vi.setSystemTime(BEFORE_WINDOW);
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("does not resolve a contract or ask the broker while out of window", async () => {
    // Asserts the cost, not just the outcome. The session gate precedes the
    // resolve, so an out-of-window pass is free; hoisting the resolve above
    // it would turn that into a broker round trip per deployment per 15s and
    // "no exit fired" would keep passing.
    vi.setSystemTime(BEFORE_WINDOW);
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.resolveContract).not.toHaveBeenCalled();
    expect(h.searchOpenPositions).not.toHaveBeenCalled();
  });

  it("leaves a position on a product no Active deployment trades alone", async () => {
    const h = harness({ positions: [position({ contractId: MNQ_U26 })] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("claims nothing when the claiming deployment's own contract will not resolve", async () => {
    const h = harness({ positions: [position()] });
    h.deps.resolveContract.mockRejectedValue(new Error("contract search failed"));
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });
});

describe("ManualPositionGuard — what the arithmetic refuses", () => {
  it("never acts on a shortfall: an entry that filled 1 of 2 is not the operator's", async () => {
    // The operand is the trade row's intended size, not the broker mirror.
    // With `DeploymentState.position` this row reads expected-flat — there is
    // no in-memory position for a `pending_entry` — and the engine's own
    // partial fill would be force-closed as manual.
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 1 })],
      trades: [trade({ contractId: MGC_Z26, side: 0, size: 2, status: "pending_entry" })],
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.logEvent.mock.calls.some(([, , m]) => String(m).includes("shortfall"))).toBe(true);
  });

  it("does not act on an excess netted into an engine position", async () => {
    // Engine long 1, operator bought 1 alongside: broker nets +2. Reducing
    // that means an order sized below the broker's position, which no engine
    // path can place.
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 2 })],
      trades: [trade({ contractId: MGC_Z26, side: 0, size: 1 })],
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.logEvent.mock.calls.some(([, , m]) => String(m).includes("netted into an engine position"))).toBe(true);
  });

  it("does nothing when the broker agrees with the engine's own trade row", async () => {
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 1 })],
      trades: [trade({ contractId: MGC_Z26, side: 0, size: 1 })],
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.log).not.toHaveBeenCalled();
  });

  it("sums every reconcilable row on a contract rather than reading one", async () => {
    // A `pending_exit` row and its replacement can briefly coexist; reading
    // either alone understates the claim and the remainder reads as manual.
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 2 })],
      trades: [
        trade({ contractId: MGC_Z26, side: 0, size: 1, status: "pending_exit" }),
        trade({ contractId: MGC_Z26, side: 0, size: 1, status: "pending_entry" }),
      ],
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("skips the account when the trade rows cannot be read, rather than reading its positions as manual", async () => {
    const h = harness({ positions: [position()] });
    h.deps.reconcilableTrades.mockImplementation(() => {
      throw new Error("database is locked");
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.logEvent.mock.calls.some(([, , m]) => String(m).includes("trade-row read failed"))).toBe(true);
  });

  it("does not claim a position whose contract id will not parse, and says so", async () => {
    const h = harness({ positions: [position({ contractId: "2749342" })] });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    const line = h.deps.logEvent.mock.calls.find(([, , m]) => String(m).includes("2749342"));
    expect(line).toBeDefined();
    expect(String(line?.[2])).toContain("will not be closed");
  });

  it("refuses while the contract lock is held, because an entry is on the wire", async () => {
    const h = harness({ positions: [position()], locked: true });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("refuses when the lock is taken during the position lookup, not only when it was already held", async () => {
    // `placeEntryOrder` takes the lock synchronously before its own
    // `placeOrder`, so a lock appearing during the position lookup means the
    // engine is entering on this contract. A gate evaluated before an await
    // is stale at the far side of it — this pins the read past the position
    // lookup, which is the last await in the path.
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockImplementation(async () => {
      h.deps.isContractLocked.mockReturnValue(true);
      return [position()];
    });
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("skips an account the broker registry does not know", async () => {
    const h = harness({ positions: [position()] });
    h.deps.isAccountRegistered.mockReturnValue(false);
    await h.guard.runManualPositionGuard();
    expect(h.searchOpenPositions).not.toHaveBeenCalled();
  });

  it("makes no broker call at all when nothing is deployed", async () => {
    // `stop()` empties `realtimeDeployments`, which is how a stopped engine
    // stops claiming instruments.
    const h = harness({ deployments: [], positions: [position()] });
    await h.guard.runManualPositionGuard();
    expect(h.searchOpenPositions).not.toHaveBeenCalled();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });
});

/**
 * The authority and the action are two different questions, and only the
 * second one moved: the sweep still claims the instrument on the operator's
 * declared window, but its close is a market order, and no market order fills
 * into a closed exchange (bugs.md A63). The claim is held, never dropped.
 */
describe("ManualPositionGuard — the exchange early close", () => {
  /** Thanksgiving 2026, a 13:00 ET halt. 18:00 UTC is 13:00 ET (EST). */
  const IN_HALT = new Date("2026-11-26T18:00:00.000Z");
  /** The Wednesday before, same wall clock: a full session. */
  const FULL_SESSION = new Date("2026-11-25T18:00:00.000Z");

  it("holds the close while the exchange is shut, and says so without calling it a failure", async () => {
    vi.setSystemTime(IN_HALT);
    const h = harness({ positions: [position()] });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    const held = h.deps.logEvent.mock.calls.find(
      (c) => c[0] === "manual_position_exchange_closed",
    );
    expect(held).toBeDefined();
    expect(severityOf(held?.[0])).toBe("warn");
  });

  it("stamps no cooldown for a close it never submitted", async () => {
    vi.setSystemTime(IN_HALT);
    const h = harness({ positions: [position()] });

    await h.guard.runManualPositionGuard();

    expect(h.flattenCooldown.active(ACCT, MGC_G27)).toBe(false);
  });

  /** The control: the same claim, the same wall clock, one day earlier. If
   *  this fails the hold is reading the clock rather than the calendar. */
  it("closes the same position on the same wall clock when the exchange is open", async () => {
    vi.setSystemTime(FULL_SESSION);
    const h = harness({ positions: [position()] });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
  });
});

describe("ManualPositionGuard — submission, not fill", () => {
  it("does not submit a second close on the next pass while the first is unfilled", async () => {
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
  });

  it("reconsiders once the cooldown has passed and the position is still there", async () => {
    // `FLATTEN_COOLDOWN_MS`, not this sweep's own 15s interval: the cooldown
    // is shared with the naked-position watchdog and is the longer of the two
    // periods, so D-2 sits out one pass it would otherwise have taken.
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    vi.setSystemTime(new Date(IN_WINDOW.getTime() + MANUAL_POSITION_GUARD_INTERVAL_MS + 1));
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(IN_WINDOW.getTime() + FLATTEN_COOLDOWN_MS + 1));
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
  });

  it("treats EXIT_IN_FLIGHT as already-happening, and does not report it", async () => {
    const h = harness({ positions: [position()] });
    h.deps.placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_IN_FLIGHT));
    await h.guard.runManualPositionGuard();
    expect(h.deps.logEvent.mock.calls.some(([event]) => severityOf(event) === "error")).toBe(false);
  });

  it("retries on the next pass when the exit was refused by the latch, rather than sitting out a cooldown it never used", async () => {
    const h = harness({ positions: [position()] });
    h.deps.placeExitOrder.mockRejectedValueOnce(new Error(EntryExitCode.EXIT_IN_FLIGHT));
    await h.guard.runManualPositionGuard();
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
  });

  // `EXIT_FLAT_MISMATCH`'s discriminator is deployment-scoped, and D-2 is the
  // one caller whose target contract is by construction not the deployment's
  // own: the deployment holds an `open` row on MGC Z26 while the operator's
  // hand position sits on G27. Close the hand position during the
  // cancel-brackets round-trip and the discriminator answers a question this
  // sweep never asked — a warn naming a healthy row on another contract, and
  // an `error` saying the close failed. Nothing failed.
  it("treats EXIT_FLAT_MISMATCH as nothing-to-close, not as a failure", async () => {
    const h = harness({ positions: [position()], trades: [trade()] });
    h.deps.placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_FLAT_MISMATCH));
    await h.guard.runManualPositionGuard();
    expect(h.deps.logEvent.mock.calls.some(([event]) => severityOf(event) === "error")).toBe(false);
  });

  it("drops the cooldown it stamped for a close it never made", async () => {
    const h = harness({ positions: [position()], trades: [trade()] });
    h.deps.placeExitOrder.mockRejectedValueOnce(new Error(EntryExitCode.EXIT_FLAT_MISMATCH));
    await h.guard.runManualPositionGuard();
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected close at error and retries next pass", async () => {
    const h = harness({ positions: [position()] });
    h.deps.placeExitOrder.mockRejectedValueOnce(new Error("account not found"));
    await h.guard.runManualPositionGuard();
    // The one condition here an operator has to act on, so it is the one the
    // ladder escalates. Every arm of this sweep now names an event; what
    // makes this one different is that it is the only `error` among them —
    // the rest report states the sweep refuses to act on, which is the guard
    // working, and they are `warn`.
    expect(h.deps.logEvent).toHaveBeenCalledWith(
      "manual_position_close_failed",
      DEPLOY,
      expect.stringContaining("Could not close the manual position"),
      expect.objectContaining({ accountId: ACCT, contractId: MGC_G27 }),
    );
    expect(
      h.deps.logEvent.mock.calls
        .filter(([event]) => severityOf(event) === "error")
        .map(([event]) => event),
    ).toEqual(["manual_position_close_failed"]);
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(2);
  });

  it("carries on to the next account when a position lookup fails", async () => {
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockRejectedValue(new Error("gateway timeout"));
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(h.deps.logEvent.mock.calls.some(([, , m]) => String(m).includes("position lookup failed"))).toBe(true);
  });
});

describe("ManualPositionGuard.previewClaim — D-11's second prompt", () => {
  it("names the positions and says the close is immediate while in window", async () => {
    const h = harness({ positions: [position()] });
    const preview = await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now:IN_WINDOW,
    });
    expect(preview.inWindow).toBe(true);
    expect(preview.whenNy).toBeNull();
    expect(preview.positions).toEqual([{ contractId: MGC_G27, side: "LONG", size: 2 }]);
  });

  it("states *when* while the window is still closed, which is the half that matters", async () => {
    // Activate at 08:00 against a 09:30 window and a prompt that says only
    // *that* it will happen leaves the operator flattened ninety minutes
    // later while not watching.
    const h = harness({ positions: [position()] });
    const preview = await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now:BEFORE_WINDOW,
    });
    expect(preview.inWindow).toBe(false);
    expect(preview.whenNy).toBe("09:30");
    expect(preview.positions).toHaveLength(1);
  });

  it("excludes a contract the engine already holds a trade row on", async () => {
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 1 })],
      trades: [trade({ contractId: MGC_Z26, side: 0, size: 1 })],
    });
    const preview = await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now:IN_WINDOW,
    });
    expect(preview.positions).toEqual([]);
  });

  it("places no order — the preview is read-only", async () => {
    const h = harness({ positions: [position()] });
    await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now:IN_WINDOW,
    });
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  // A115: the board's strip probes once per armed leg every 15 s per tab, and
  // every probe used to be a live position search.
  it("makes no broker call when the account view is fresh, and answers from it", async () => {
    const h = harness({ positions: [] });
    recordPositions(ACCT, [position()], "sweep");
    vi.setSystemTime(new Date(IN_WINDOW.getTime() + ACCOUNT_VIEW_MAX_AGE_MS - 1));

    const preview = await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now: IN_WINDOW,
    });

    expect(h.searchOpenPositions).not.toHaveBeenCalled();
    expect(h.deps.brokerForAccount).not.toHaveBeenCalled();
    expect(preview.positions).toEqual([{ contractId: MGC_G27, side: "LONG", size: 2 }]);
  });

  it("reads live once for concurrent probes on a stale view, and stores the read", async () => {
    const h = harness({ positions: [position({ size: 1 })] });
    recordPositions(ACCT, [position()], "sweep");
    vi.setSystemTime(new Date(IN_WINDOW.getTime() + ACCOUNT_VIEW_MAX_AGE_MS));
    const input = { accountId: ACCT, ticker: "/MGC" as const, strategyKey: "test-strategy", paramValues: {}, now: IN_WINDOW };

    const previews = await Promise.all([h.guard.previewClaim(input), h.guard.previewClaim(input)]);

    expect(h.searchOpenPositions).toHaveBeenCalledTimes(1);
    for (const p of previews) expect(p.positions).toEqual([{ contractId: MGC_G27, side: "LONG", size: 1 }]);
    expect(freshPositions(ACCT)?.items).toEqual([position({ size: 1 })]);
  });

  // The activation prompt that warns about a hand position cannot be
  // suppressed, so it must read live: a hand position opened after
  // the last sweep is missing from a view under 60 s old, and a prompt read
  // from it would stay silent before the guard's next live pass closes it.
  it("with live, reads the broker even when the view is fresh, and writes the read into the view", async () => {
    const h = harness({ positions: [position()] });
    recordPositions(ACCT, [], "sweep");

    const preview = await h.guard.previewClaim({
      accountId: ACCT,
      ticker: "/MGC",
      strategyKey: "test-strategy",
      paramValues: {},
      now: IN_WINDOW,
      live: true,
    });

    expect(h.searchOpenPositions).toHaveBeenCalledTimes(1);
    expect(preview.positions).toEqual([{ contractId: MGC_G27, side: "LONG", size: 2 }]);
    expect(freshPositions(ACCT)?.items).toEqual([position()]);
  });

  it("with live, still reads the broker inside a remembered read-through failure", async () => {
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockRejectedValueOnce(new Error("429"));
    const input = { accountId: ACCT, ticker: "/MGC" as const, strategyKey: "test-strategy", paramValues: {}, now: IN_WINDOW };
    await h.guard.previewClaim(input);

    const preview = await h.guard.previewClaim({ ...input, live: true });

    expect(h.searchOpenPositions).toHaveBeenCalledTimes(2);
    expect(preview.positions).toHaveLength(1);
  });

  // A117. A failed live read answered `positions: []`, which the prompt reads
  // as "nothing to close" — so prompt 2 stayed silent and the next pass could
  // close a position the operator was never told about. It must answer
  // "could not answer" instead, which the preflight route turns into a non-OK
  // response and the client into `null`. Must not regress: the strip's read
  // (no `live`) still degrades to an empty preview, and a successful live
  // read still answers — the two tests above.
  it("A117 — with live, a failed position read rejects rather than answering no positions", async () => {
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockRejectedValue(new Error("429"));

    await expect(
      h.guard.previewClaim({ accountId: ACCT, ticker: "/MGC", strategyKey: "test-strategy", paramValues: {}, now: IN_WINDOW, live: true }),
    ).rejects.toThrow("429");
  });

  it("A117 — with live, a failed contract resolve rejects too", async () => {
    const h = harness({ positions: [position()] });
    vi.mocked(h.deps.resolveContract).mockRejectedValueOnce(new Error("resolver down"));

    await expect(
      h.guard.previewClaim({ accountId: ACCT, ticker: "/MGC", strategyKey: "test-strategy", paramValues: {}, now: IN_WINDOW, live: true }),
    ).rejects.toThrow("resolver down");
  });

  it("without live, a failed read still answers an empty preview for the strip", async () => {
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockRejectedValue(new Error("429"));

    const preview = await h.guard.previewClaim({ accountId: ACCT, ticker: "/MGC", strategyKey: "test-strategy", paramValues: {}, now: IN_WINDOW });

    expect(preview.positions).toEqual([]);
  });
});

describe("ManualPositionGuard — the sweep and the account view", () => {
  it("writes its read into the view, and still reads the broker live on every pass", async () => {
    // The sweep acts, so a fresh view must never stand in for its read
    // (engine.md, post-entry money paths read the live broker position).
    const h = harness({ positions: [position()] });
    await h.guard.runManualPositionGuard();
    expect(freshPositions(ACCT)?.items).toEqual([position()]);
    expect(freshPositions(ACCT)?.source).toBe("sweep");

    vi.setSystemTime(new Date(IN_WINDOW.getTime() + FLATTEN_COOLDOWN_MS + 1));
    await h.guard.runManualPositionGuard();
    expect(h.searchOpenPositions).toHaveBeenCalledTimes(2);
  });

  it("stamps its write with the ask time, so a hub frame landing during the read stands", async () => {
    const h = harness();
    recordPositions(ACCT, [position()], "sweep");
    let release!: (p: Position[]) => void;
    h.searchOpenPositions.mockImplementationOnce(() => new Promise<Position[]>((res) => (release = res)));

    const pass = h.guard.runManualPositionGuard();
    await vi.advanceTimersByTimeAsync(1_000);
    applyPositionEvent(ACCT, position({ size: 0 }));
    release([position()]);
    await pass;

    expect(freshPositions(ACCT)?.items).toEqual([]);
    expect(freshPositions(ACCT)?.source).toBe("hub");
  });
});

describe("contractForClaimedMonth", () => {
  it("re-points both id fields so no caller can read the front month", () => {
    const out = contractForClaimedMonth(contract(MGC_Z26), MGC_G27);
    expect(out.id).toBe(MGC_G27);
    expect(out.executionContractId).toBe(MGC_G27);
  });

  it("keeps the tick parameters, which are a property of the product", () => {
    const out = contractForClaimedMonth(contract(MGC_Z26), MGC_G27);
    expect(out.tickSize).toBe(0.1);
    expect(out.tickValue).toBe(1);
  });
});

describe("nextWindowStartNy", () => {
  it("picks the soonest start ahead of now", () => {
    expect(
      nextWindowStartNy(BEFORE_WINDOW, [
        { start: "13:00", end: "16:00" },
        { start: "09:30", end: "11:00" },
      ]),
    ).toBe("09:30");
  });

  it("wraps past midnight rather than answering a start already gone", () => {
    // 17:30 ET, both windows behind us — the next one is tomorrow's 09:30.
    expect(
      nextWindowStartNy(new Date("2026-08-24T21:30:00.000Z"), [
        { start: "09:30", end: "11:00" },
        { start: "13:00", end: "16:00" },
      ]),
    ).toBe("09:30");
  });

  it("answers null when the deployment has no window at all", () => {
    expect(nextWindowStartNy(IN_WINDOW, [])).toBeNull();
  });
});

// ── An unreadable session window must not become a permanent claim ────
//
// `isInSessionWindow` fails *open* on an unparseable HH:MM — deliberate, and
// right for the trading path where a wrong `true` costs an entry. Here `true`
// means "close the operator's position", so the same fail-open makes the claim
// permanently live and flattens a hand position at any hour. The window is the
// playbook's `config.session` now, which narrows *who* can write a bad one to
// a module author rather than an operator — but a `MainSession` is still two
// `HH:MM` strings and nothing parses them at registration, so `{start:"",
// end:""}` and `{start:"9:3O"}` are both declarable and the guard still has to
// refuse them.

describe("an unreadable session window", () => {
  const MIDNIGHT_ET = new Date("2026-08-25T03:00:00.000Z"); // 23:00 ET, no window open

  for (const [label, session] of [
    ["empty strings", { start: "", end: "" }],
    ["a typo'd hour", { start: "9:3O", end: "16:00" }],
  ] as const) {
    it(`does not claim the instrument — ${label}`, async () => {
      vi.setSystemTime(MIDNIGHT_ET);
      mockStrategySession(session.start, session.end);
      const h = harness({
        deployments: [deployment()],
        positions: [position({ contractId: MGC_G27, type: 1, size: 2 })],
      });

      await h.guard.runManualPositionGuard();

      expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
      expect(
        h.deps.logEvent.mock.calls.some(
          (call) => severityOf(call[0]) === "warn" && String(call[2]).includes("unreadable session window"),
        ),
      ).toBe(true);
    });
  }

  it("still claims normally when the window parses", async () => {
    vi.setSystemTime(IN_WINDOW);
    const h = harness({
      positions: [position({ contractId: MGC_G27, type: 1, size: 2 })],
    });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
  });
});

// ── The three guards the P4 review found green under injection ────────
//
// patterns.md makes injection the standard, and these three named guards did
// not fail their own mutation. Each test below was written by first breaking
// the guard and confirming it goes red.

describe("guards that were unpinned", () => {
  it("refuses a contract whose opposing rows net to flat — the sum must not manufacture expected-flat", async () => {
    vi.setSystemTime(IN_WINDOW);
    // A pending_exit long 2 and a pending_entry short 2 sum to zero, which
    // reads as wholly manual. Unreachable in production only because the
    // contract lock covers any contract with a reconcilable row — so the lock
    // is the single barrier, and this pins that it is actually consulted.
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 2 })],
      trades: [
        trade({ contractId: MGC_Z26, side: 0, size: 2, status: "pending_exit" }),
        trade({ contractId: MGC_Z26, side: 1, size: 2, status: "pending_entry" }),
      ],
      locked: true,
    });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("skips a zero-size broker position rather than attributing it", async () => {
    vi.setSystemTime(IN_WINDOW);
    // A flat frame is not a manual position. Tradovate emits netPos:0 on the
    // WS path (bugs.md A41), and signedSize launders the bogus SHORT label to
    // 0 — which would attribute as excess-from-flat if it reached the rule.
    const h = harness({ positions: [position({ contractId: MGC_G27, type: 2, size: 0 })] });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("labels a shortfall as a shortfall, not as an entangled excess", async () => {
    vi.setSystemTime(IN_WINDOW);
    // The old assertion looked for the word "shortfall", which
    // describePositionAttribution also emits from the entangled-excess arm —
    // so deleting the shortfall branch left it green. Assert the arm's own
    // sentence instead.
    const h = harness({
      positions: [position({ contractId: MGC_Z26, type: 1, size: 1 })],
      trades: [trade({ contractId: MGC_Z26, side: 0, size: 2, status: "open" })],
    });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
    expect(
      h.deps.logEvent.mock.calls.some(
        (call) => String(call[2]).includes("Not acting on") || String(call[2]).includes("cannot say"),
      ),
    ).toBe(true);
  });
});

// ── A stopped engine claims nothing, including mid-pass ───────────────
//
// `clearInterval` disarms the *next* pass. One already parked on
// `searchOpenPositions` captured `realtimeDeployments` before `stop()` emptied
// it, so without the armed flag it completes and submits against an operator's
// position on a stopped engine — which is the exact absolute both
// `startManualPositionGuard` and architecture.md state.

describe("ManualPositionGuard — arm/disarm", () => {
  it("makes no broker call at all while disarmed", async () => {
    const h = harness({ positions: [position()] });
    h.guard.disarm();

    await h.guard.runManualPositionGuard();

    expect(h.searchOpenPositions).not.toHaveBeenCalled();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("does not submit from a pass already parked on the position lookup when stop() lands", async () => {
    const h = harness({ positions: [position()] });
    let answer: (p: Position[]) => void = () => {};
    h.searchOpenPositions.mockImplementation(
      () => new Promise<Position[]>((res) => { answer = res; }),
    );

    const pass = h.guard.runManualPositionGuard();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.searchOpenPositions).toHaveBeenCalledTimes(1);

    h.guard.disarm();
    answer([position()]);
    await pass;

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("enforces again after arm(), so an in-process restart is not permanently inert", async () => {
    const h = harness({ positions: [position()] });
    h.guard.disarm();
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();

    h.guard.arm();
    await h.guard.runManualPositionGuard();
    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
  });
});

// ── Report anchors are cleared when the condition they date is over ───

describe("ManualPositionGuard — report anchors", () => {
  it("drops the account-level anchor once the account answers, so a later failure is not dated to the first", async () => {
    const h = harness({ positions: [position()] });
    h.searchOpenPositions.mockRejectedValueOnce(new Error("gateway timeout"));
    await h.guard.runManualPositionGuard();

    await h.guard.runManualPositionGuard();

    vi.setSystemTime(new Date(IN_WINDOW.getTime() + 3 * 24 * 60 * 60 * 1000));
    h.searchOpenPositions.mockRejectedValueOnce(new Error("gateway timeout"));
    await h.guard.runManualPositionGuard();

    const last = String(h.deps.logEvent.mock.calls.at(-1)?.[2] ?? "");
    expect(last).toContain("position lookup failed");
    expect(last).not.toContain("Standing for");
  });

  it("drops the session anchor once the window parses again", async () => {
    mockStrategySession("9:3O", "16:00");
    const h = harness({
      deployments: [deployment()],
      positions: [position()],
    });
    await h.guard.runManualPositionGuard();

    mockStrategySession("09:30", "16:00");
    await h.guard.runManualPositionGuard();

    vi.setSystemTime(new Date(IN_WINDOW.getTime() + 3 * 24 * 60 * 60 * 1000));
    mockStrategySession("9:3O", "16:00");
    await h.guard.runManualPositionGuard();

    const line = String(
      h.deps.logEvent.mock.calls.filter((c) => String(c[2]).includes("unreadable session window")).at(-1)?.[2] ?? "",
    );
    expect(line).not.toBe("");
    expect(line).not.toContain("Standing for");
  });
});

// ── The cooldown is shared, and this file must not be read as owning it ──
//
// Cross-actor behaviour lives in engine-flatten-cooldown.test.ts, where both
// controllers are driven against one instance. What is pinned here is only
// that this sweep reads and writes the injected one rather than a private map
// it might quietly grow back.

describe("ManualPositionGuard — the shared cooldown", () => {
  it("refuses to submit when the other actor has already stamped the contract", async () => {
    const flattenCooldown = new FlattenCooldown();
    flattenCooldown.note(ACCT, MGC_G27, "watchdog");
    const h = harness({ positions: [position()], flattenCooldown });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).not.toHaveBeenCalled();
  });

  it("stamps the shared instance on its own close", async () => {
    const flattenCooldown = new FlattenCooldown();
    const h = harness({ positions: [position()], flattenCooldown });

    await h.guard.runManualPositionGuard();

    expect(h.deps.placeExitOrder).toHaveBeenCalledTimes(1);
    expect(flattenCooldown.active(ACCT, MGC_G27)).toBe(true);
  });
});
