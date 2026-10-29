/**
 * `modifyStopLossToPrice` refuses a stop that would sit at or past the market.
 *
 * A protective stop rests on the far side of the market — below it for a long,
 * above it for a short. The break-even filter arms off the MFE of the bars
 * since entry, so it fires on a bar whose *extreme* reached the trigger even
 * when that bar closed back through entry; the stop it then asks for would
 * trigger the instant it landed, and Topstep rejects it as `Invalid stop
 * price`. Observed 2026-04-26 19:36 NY on a /MNQ short, in docs/bugs.md as
 * "BE modify-stop fails with 'Invalid stop price'". The cost was the full stop
 * instead of a scratch, once per bar, for as long as price stayed there.
 *
 * These exercise the shipped private method through the real `brokerFor` and
 * the real tick alignment. The refusal is a **throw**, not a return value,
 * because the caller stamps `markBreakEvenMoved` and `slCurrentPrice` on the
 * lines after the await — a discriminant it could ignore would let a ratchet
 * that never reached the wire be recorded as one that did.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// The order gate in `brokerForAccount` asks this; held unless a test says not.
const LEASE = vi.hoisted(() => ({ held: true }));
vi.mock("@/lib/db/lease", () => ({
  holdsLease: () => LEASE.held,
  leaseGate: () => () => LEASE.held,
  reportLeaseRefused: vi.fn(),
}));

vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  sendOrphanAlert: vi.fn().mockResolvedValue(undefined),
  formatNyTime: vi.fn().mockReturnValue(""),
  formatAccountLabel: vi.fn().mockReturnValue(""),
  COLOR_ENTRY_LONG: 0,
  COLOR_ENTRY_SHORT: 0,
  COLOR_EXIT_WIN: 0,
  COLOR_EXIT_LOSS: 0,
  COLOR_EXIT_FLAT: 0,
  COLOR_EXIT_BE: 0,
  COLOR_EXIT_TRAIL: 0,
  COLOR_EXIT_STRATEGY: 0,
  COLOR_EXIT_MANUAL: 0,
  COLOR_BRACKET_FAILURE: 0,
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
  ansiGreen: (s: string) => s,
  ansiRed: (s: string) => s,
  ansiBlue: (s: string) => s,
  ansiGray: (s: string) => s,
  ANSI_LINE_WIDTH: 80,
  padAnsiLine: (s: string) => s,
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(),
  listClosingDeployments: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  listManagedDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn().mockReturnValue([]),
  reapDestroyingDeployment: vi.fn(),
  settlePausingDeployment: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  abandonSnapshotQueue: vi.fn(),
  backfillEntryFilledAt: vi.fn(),
  backfillExitFilledAt: vi.fn(),
  backfillExitOrderId: vi.fn(),
  closeTrade: vi.fn(),
  findRecentApproximatedTradeByAccountContract: vi.fn(),
  findTradeByAccountContract: vi.fn().mockReturnValue(null),
  getAllOpenTrades: vi.fn().mockReturnValue([]),
  getApproximatedClosedTrades: vi.fn().mockReturnValue([]),
  getBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  getAccountRealizedSinceGross: vi.fn().mockReturnValue(0),
  getLastExitAt: vi.fn(),
  getOpenTradeForDeployment: vi.fn(),
  getReconcilableTrades: vi.fn().mockReturnValue([]),
  getRecentlyClosedTrades: vi.fn().mockReturnValue([]),
  getTradeById: vi.fn(),
  getTradesNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  healApproximatedExit: vi.fn(),
  incrementSnapshotRetry: vi.fn(),
  insertPendingEntry: vi.fn(),
  listAccountsNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  listAccountsWithBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  listAccountsWithReconcilableTrades: vi.fn().mockReturnValue([]),
  listAllAccountsWithApproximatedTrades: vi.fn().mockReturnValue([]),
  listDueSnapshots: vi.fn().mockReturnValue([]),
  markBreakEvenMoved: vi.fn(),
  markSlTrailEngaged: vi.fn(),
  markEntryFailed: vi.fn(),
  markEntryFilled: vi.fn(),
  saveTradeBars: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
  setExitReason: vi.fn(),
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(),
  listGroups: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

// `BrokerKind` is a string const enum that does not inline under this
// transpiler — engine code reads it off this module (patterns.md).
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
  toAccountBrokerSeeds: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  getNotificationsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/engine-logs", () => ({
  appendLog: vi.fn(),
  getRecentLogs: vi.fn().mockReturnValue([]),
}));

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md).
vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

import { TradingEngine } from "./engine";
import { LeaseLostError } from "./lease-gated-broker";
import type { LogRecord } from "@/lib/logging/pipe";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { resetLogBursts } from "@/lib/logging/pipe";
import type { Broker } from "../broker-access/broker";
import type { BarData, Contract, Order, Position } from "@/lib/brokers/types";
import { pickTightestFavorableSl } from "../filters";
import { computeBreakevenSlPrice, type BreakevenFilterParams } from "../exit-filters/breakeven";
import { computeTrailSlPrice, type TrailFilterParams } from "../exit-filters/trail";
import { priceFromTicks } from "../orders/pnl-math";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { OpenPosition } from "../strategy-types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT = 90063379;
const DEPLOYMENT_ID = "depl-mnq";
const CONTRACT_ID = "CON.F.US.MNQ.U26";
const TRADE_ID = 391;
const SL_ORDER_ID = 3451803258;

/** /MNQ, the instrument the 2026-04-26 rejection was observed on. */
const TICK_SIZE = 0.25;
const ENTRY = 18_000;

function contract(): Contract {
  return {
    id: CONTRACT_ID,
    name: "MNQU6",
    description: "Micro E-mini Nasdaq",
    tickSize: TICK_SIZE,
    tickValue: 0.5,
    activeContract: true,
    symbolId: "F.US.MNQ",
  };
}

function deployment(): Deployment {
  return {
    id: DEPLOYMENT_ID,
    accountId: ACCOUNT,
    ticker: "/MNQ" as TickerSymbol,
    strategyKey: "test",
    status: "Active",
    groupId: "parent-1",
    paramValues: {},
  } as Deployment;
}

/** `side` is `OrderSide`: 0 buy (long), 1 sell (short). */
function position(side: 0 | 1): OpenPosition {
  return {
    side,
    entryPrice: ENTRY,
    entryTimestamp: "2026-04-26T23:30:00.000Z",
    barsSinceEntry: 2,
    entryFilledAt: "2026-04-26T23:30:01.000Z",
    size: 1,
    slTicks: 40,
  } as OpenPosition;
}

/**
 * Far enough behind entry that every move the cases below ask for tightens it,
 * so only the non-tightening cases meet that refusal.
 */
const RESTING_STOP_DISTANCE = 100;

/** The resting protective stop, on the closing side of the position. */
function slOrder(side: 0 | 1, stopPrice: number | null): Order {
  return {
    id: SL_ORDER_ID,
    contractId: CONTRACT_ID,
    type: 4,
    side: side === 0 ? 1 : 0,
    size: 1,
    stopPrice,
  } as Order;
}

type EnginePrivates = {
  modifyStopLossToPrice(
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    tradeId: number | null,
    targetPrice: number,
    marketPrice: number | null,
    storedStopPrice: number | null,
    label: string,
  ): Promise<number>;
  brokerRegistry: { get(accountId: number): Broker | null };
};

function makeHarness(
  side: 0 | 1,
  grid: { tickSize: number; entry: number } = { tickSize: TICK_SIZE, entry: ENTRY },
  restingStop: number | null = side === 0 ? grid.entry - RESTING_STOP_DISTANCE : grid.entry + RESTING_STOP_DISTANCE,
) {
  const engine = new TradingEngine(
    new TopstepClient("http://localhost:0"),
    new TradovateClient("http://localhost:0"),
    null,
  );
  const priv = engine as unknown as EnginePrivates;
  const logs: LogRecord[] = [];
  engine.setLogHandler((entry) => logs.push(entry));

  const searchOpenOrders = vi.fn(async (): Promise<Order[]> => [slOrder(side, restingStop)]);
  const searchOpenPositions = vi.fn(
    async (): Promise<Position[]> => [{ contractId: CONTRACT_ID, size: 1 } as Position],
  );
  const modifyOrder = vi.fn(async () => undefined);
  const broker = { searchOpenOrders, searchOpenPositions, modifyOrder } as unknown as Broker;

  // The real `brokerFor` / `brokerForAccount` still run; only the registry
  // lookup they end in is stood in for.
  priv.brokerRegistry = { get: () => broker };

  vi.mocked(getOpenTradeForDeployment).mockReturnValue({
    id: TRADE_ID,
    slOrderId: SL_ORDER_ID,
  } as ReturnType<typeof getOpenTradeForDeployment>);

  /** `storedStop` is the mirror's `slCurrentPrice`. */
  const move = (
    targetPrice: number,
    marketPrice: number | null,
    storedStop: number | null = null,
    tradeId: number = TRADE_ID,
  ) =>
    priv.modifyStopLossToPrice(
      deployment(),
      { ...contract(), tickSize: grid.tickSize },
      { ...position(side), entryPrice: grid.entry },
      tradeId,
      targetPrice,
      marketPrice,
      storedStop,
      "Exit-filter SL modify",
    );

  return { engine, logs, move, searchOpenOrders, searchOpenPositions, modifyOrder };
}

const wrongSideLines = (logs: LogRecord[]) =>
  logs.filter((l) => l.message.includes("wrong side of"));

beforeEach(() => {
  vi.clearAllMocks();
  // The pipe collapses identical causes inside a 30s window in process-wide
  // state, so a line asserted here that an earlier test already emitted would
  // never reach the handler (patterns.md).
  resetLogBursts();
  LEASE.held = true;
});

describe("modifyStopLossToPrice — the engine lease", () => {
  it("refuses the modify at the broker accessor once this process has lost the lease, and sends nothing", async () => {
    // The real `brokerForAccount` hands back the gated broker: a stop move
    // from a process another engine took over never reaches the wire.
    const { move, modifyOrder } = makeHarness(0);
    LEASE.held = false;
    await expect(move(ENTRY, ENTRY + 4 * TICK_SIZE)).rejects.toThrow(LeaseLostError);
    expect(modifyOrder).not.toHaveBeenCalled();
  });
});

describe("modifyStopLossToPrice — wrong-side-of-market refusal", () => {
  it("refuses a long's break-even stop when the bar closed back through entry", async () => {
    // The 2026-04-26 shape with the sides swapped: BE armed off a bar whose
    // high ran past the trigger, and the close is a tick under entry — so a
    // sell-stop at entry sits above the market and fires on arrival.
    const { move, modifyOrder } = makeHarness(0);
    await expect(move(ENTRY, ENTRY - TICK_SIZE)).rejects.toThrow(/wrong side of the market/i);
    expect(modifyOrder).not.toHaveBeenCalled();
  });

  it("refuses a short's break-even stop when the bar closed back through entry", async () => {
    // The observed case. Short from 18000, price ran down, then closed a tick
    // above entry — a buy-stop at entry is at or below the market.
    const { move, modifyOrder } = makeHarness(1);
    await expect(move(ENTRY, ENTRY + TICK_SIZE)).rejects.toThrow(/wrong side of the market/i);
    expect(modifyOrder).not.toHaveBeenCalled();
  });

  it("refuses a stop exactly at the market, on both sides", async () => {
    // The boundary is `<=` / `>=`, not `<` / `>`: a stop sitting on the last
    // print is immediately triggerable, which is the condition being refused.
    const long = makeHarness(0);
    await expect(long.move(ENTRY, ENTRY)).rejects.toThrow(/wrong side of the market/i);
    const short = makeHarness(1);
    await expect(short.move(ENTRY, ENTRY)).rejects.toThrow(/wrong side of the market/i);
  });

  it("refuses before spending a broker round trip", async () => {
    // The refusal is a function of the target and the tick grid alone, so it
    // sits ahead of the order lookup. Asserting the cost is what stops the
    // guard being moved below `searchOpenOrders` for tidiness — the reason it
    // is cheap is that a stranded ratchet re-proposes on every bar.
    const { move, searchOpenOrders, searchOpenPositions } = makeHarness(0);
    await expect(move(ENTRY, ENTRY - TICK_SIZE)).rejects.toThrow();
    expect(searchOpenOrders).not.toHaveBeenCalled();
    expect(searchOpenPositions).not.toHaveBeenCalled();
  });

  it("logs the refusal once, naming both prices", async () => {
    const { move, logs } = makeHarness(1);
    await expect(move(ENTRY, ENTRY + TICK_SIZE)).rejects.toThrow();
    const lines = wrongSideLines(logs);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain(String(ENTRY));
    expect(lines[0].message).toContain(String(ENTRY + TICK_SIZE));
  });

  it("sends the modify when the market is still on the far side — long", async () => {
    const { move, modifyOrder, logs } = makeHarness(0);
    await expect(move(ENTRY, ENTRY + 4 * TICK_SIZE)).resolves.toBe(ENTRY);
    expect(modifyOrder).toHaveBeenCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: ENTRY });
    expect(wrongSideLines(logs)).toHaveLength(0);
  });

  it("sends the modify when the market is still on the far side — short", async () => {
    const { move, modifyOrder } = makeHarness(1);
    await expect(move(ENTRY, ENTRY - 4 * TICK_SIZE)).resolves.toBe(ENTRY);
    expect(modifyOrder).toHaveBeenCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: ENTRY });
  });

  it("sends the modify when the caller has no mark, rather than guessing", async () => {
    // Fail-open is deliberate and it is the direction that keeps the old
    // behaviour: with no mark the worst case is the broker rejection this
    // guard exists to avoid, which is already handled. Failing closed would
    // silently retire break-even whenever the price source went quiet.
    const { move, modifyOrder } = makeHarness(0);
    await expect(move(ENTRY, null)).resolves.toBe(ENTRY);
    expect(modifyOrder).toHaveBeenCalledTimes(1);
  });

  it("compares the market against the tick-aligned stop, not the raw target", async () => {
    // A long's target rounds DOWN to the grid, so a target between two ticks
    // lands below the market that would have refused the unaligned value.
    // Asserting the aligned price reaches the broker is what pins the order:
    // align, then compare.
    const { move, modifyOrder } = makeHarness(0);
    const target = ENTRY + 0.1;
    await expect(move(target, ENTRY + 0.05)).resolves.toBe(ENTRY);
    expect(modifyOrder).toHaveBeenCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: ENTRY });
  });
});

/**
 * The caller picks its candidate against `slCurrentPrice`, which is null on a
 * position rebuilt from its trade row, so the resting stop the broker holds is
 * the only reference that says which way a move goes. A trail ratcheted before
 * the rebuild and a pullback bar's trail candidate after it would otherwise
 * move the stop back down.
 */
describe("modifyStopLossToPrice — a move that does not tighten the resting stop", () => {
  const lines = (logs: LogRecord[]) => logs.filter((l) => l.message.includes("would not tighten"));

  it.each([
    ["long, below the resting stop", 0, ENTRY + 5, ENTRY + 4],
    ["long, at the resting stop", 0, ENTRY + 5, ENTRY + 5],
    ["short, above the resting stop", 1, ENTRY - 5, ENTRY - 4],
    ["short, at the resting stop", 1, ENTRY - 5, ENTRY - 5],
  ] as const)("refuses a %s before the write, and says so once", async (_label, side, resting, target) => {
    const { move, modifyOrder, logs } = makeHarness(side, undefined, resting);
    await expect(move(target, null)).rejects.toThrow(/would not tighten/i);
    expect(modifyOrder).not.toHaveBeenCalled();
    const said = lines(logs);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ event: "stop_move_not_tighter", severity: "info" });
    expect(said[0].message).toContain(String(resting));
    expect(said[0].message).toContain(String(target));
    // The Activity sentence names the stop that was compared: the broker's.
    expect(said[0].values?.reason).toBe(
      "the stop resting at the broker is already at or tighter than the new one would be",
    );
  });

  it.each([
    ["long", 0, ENTRY + 4, ENTRY + 5],
    ["short", 1, ENTRY - 4, ENTRY - 5],
    ["long, one tick tighter", 0, ENTRY + 5, ENTRY + 5 + TICK_SIZE],
    ["short, one tick tighter", 1, ENTRY - 5, ENTRY - 5 - TICK_SIZE],
  ] as const)("sends a %s move that tightens the resting stop", async (_label, side, resting, target) => {
    const { move, modifyOrder, logs } = makeHarness(side, undefined, resting);
    await expect(move(target, null)).resolves.toBe(target);
    expect(modifyOrder).toHaveBeenCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: target });
    expect(lines(logs)).toEqual([]);
  });

  it("compares the tick-aligned stop, so a target that rounds onto the resting stop is refused", async () => {
    // A long rounds down: ENTRY + 5.1 is sent as ENTRY + 5, the price already resting.
    const { move, modifyOrder } = makeHarness(0, undefined, ENTRY + 5);
    await expect(move(ENTRY + 5.1, null)).rejects.toThrow(/would not tighten/i);
    expect(modifyOrder).not.toHaveBeenCalled();
  });

  it("compares against the resting stop, not the mirror, when the broker carries one", async () => {
    // The mirror says ENTRY + 6, the broker ENTRY + 4: ENTRY + 5 tightens the broker's stop.
    const { move, modifyOrder } = makeHarness(0, undefined, ENTRY + 4);
    await expect(move(ENTRY + 5, null, ENTRY + 6)).resolves.toBe(ENTRY + 5);
    expect(modifyOrder).toHaveBeenCalledTimes(1);
  });

  // Tradovate's `/order/list` likely carries no `stopPrice`, so the resting
  // order can read back with none.
  describe("a resting stop order that carries no price", () => {
    it.each([0, 1] as const)("side %i: with no stored stop either, the move is refused before the write", async (side) => {
      const { move, modifyOrder, searchOpenPositions, logs } = makeHarness(side, undefined, null);
      await expect(move(side === 0 ? ENTRY + 5 : ENTRY - 5, null, null)).rejects.toThrow(/no reference stop/i);
      expect(modifyOrder).not.toHaveBeenCalled();
      expect(searchOpenPositions).not.toHaveBeenCalled();
      const said = logs.filter((l) => l.event === "stop_move_unknown_stop");
      expect(said.map((l) => l.severity)).toEqual(["warn"]);
    });

    // The candidate is re-offered every bar, and logging/README.md's Hard rule
    // says a `warn` is never per-tick: one per trade per window, repeats at `info`.
    describe("the unknown-stop warn is throttled per trade", () => {
      const BAR_MS = 5 * 60_000;
      const unknownLines = (logs: LogRecord[]) =>
        logs.filter((l) => l.message.includes("carries no stop price")).map((l) => [l.event, l.severity]);

      afterEach(() => {
        vi.useRealTimers();
      });

      it("two bars on one trade: one warn, then one info", async () => {
        vi.useFakeTimers({ now: Date.parse("2026-10-24T14:00:00.000Z"), toFake: ["Date"] });
        const { move, logs } = makeHarness(0, undefined, null);
        await expect(move(ENTRY + 5, null)).rejects.toThrow(/no reference stop/i);
        vi.advanceTimersByTime(BAR_MS);
        await expect(move(ENTRY + 5, null)).rejects.toThrow(/no reference stop/i);
        expect(unknownLines(logs)).toEqual([
          ["stop_move_unknown_stop", "warn"],
          [null, "info"],
        ]);
      });

      it("a new trade warns at once", async () => {
        vi.useFakeTimers({ now: Date.parse("2026-10-24T14:00:00.000Z"), toFake: ["Date"] });
        const { move, logs } = makeHarness(0, undefined, null);
        await expect(move(ENTRY + 5, null, null, TRADE_ID)).rejects.toThrow();
        vi.advanceTimersByTime(BAR_MS);
        vi.mocked(getOpenTradeForDeployment).mockReturnValue({
          id: TRADE_ID + 1,
          slOrderId: SL_ORDER_ID,
        } as ReturnType<typeof getOpenTradeForDeployment>);
        await expect(move(ENTRY + 5, null, null, TRADE_ID + 1)).rejects.toThrow(/no reference stop/i);
        expect(unknownLines(logs).map(([, severity]) => severity)).toEqual(["warn", "warn"]);
      });

      it("a standing fault warns again once the window has passed", async () => {
        vi.useFakeTimers({ now: Date.parse("2026-10-24T14:00:00.000Z"), toFake: ["Date"] });
        const { move, logs } = makeHarness(0, undefined, null);
        await expect(move(ENTRY + 5, null)).rejects.toThrow();
        vi.advanceTimersByTime(30 * 60_000);
        await expect(move(ENTRY + 5, null)).rejects.toThrow();
        expect(unknownLines(logs).map(([, severity]) => severity)).toEqual(["warn", "warn"]);
      });
    });

    it.each([
      ["long", 0, ENTRY + 4, ENTRY + 4 + TICK_SIZE],
      ["short", 1, ENTRY - 4, ENTRY - 4 - TICK_SIZE],
    ] as const)("a %s move that tightens the stored stop is sent", async (_label, side, stored, target) => {
      const { move, modifyOrder } = makeHarness(side, undefined, null);
      await expect(move(target, null, stored)).resolves.toBe(target);
      expect(modifyOrder).toHaveBeenCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: target });
    });

    it.each([
      ["long, looser", 0, ENTRY + 4, ENTRY + 3],
      ["long, equal", 0, ENTRY + 4, ENTRY + 4],
      ["short, looser", 1, ENTRY - 4, ENTRY - 3],
      ["short, equal", 1, ENTRY - 4, ENTRY - 4],
    ] as const)("a %s move against the stored stop is refused", async (_label, side, stored, target) => {
      const { move, modifyOrder, logs } = makeHarness(side, undefined, null);
      await expect(move(target, null, stored)).rejects.toThrow(/would not tighten/i);
      expect(modifyOrder).not.toHaveBeenCalled();
      const said = lines(logs);
      expect(said).toHaveLength(1);
      expect(said[0].event).toBe("stop_move_not_tighter");
      expect(said[0].message).toContain(String(stored));
      // No broker price, so the sentence must not claim the broker's stop was read.
      expect(said[0].values?.reason).toBe(
        "the stop the engine last set is already at or tighter than the new one would be",
      );
    });
  });
});

/**
 * The stop sent is the candidate's own grid price. A float re-floor of an
 * on-grid 0.1-tick price lands off the grid a tick out (2649.2 → 2649.1000000000004),
 * and since that is what the caller stores as `slCurrentPrice`, the same
 * candidate read as tighter on every later bar and was re-sent until the close.
 */
describe("modifyStopLossToPrice — tick-grid snap", () => {
  const MGC = 0.1;

  it.each([
    [MGC, 0, 2650.7], [MGC, 1, 2650.7], [TICK_SIZE, 0, ENTRY], [TICK_SIZE, 1, ENTRY],
  ] as const)("on a %s tick, side %i: every on-grid price is sent as itself", async (tickSize, side, entry) => {
    const { move, modifyOrder } = makeHarness(side, { tickSize, entry });
    for (let k = -300; k <= 300; k++) {
      const p = priceFromTicks(entry, k, tickSize);
      await expect(move(p, null)).resolves.toBe(p);
      expect(modifyOrder).toHaveBeenLastCalledWith(ACCOUNT, SL_ORDER_ID, { stopPrice: p });
    }
  });

  it("still aligns an off-grid price away from the market on a 0.1 tick", async () => {
    await expect(makeHarness(0, { tickSize: MGC, entry: 2650.7 }).move(2649.25, null)).resolves.toBe(2649.2);
    await expect(makeHarness(1, { tickSize: MGC, entry: 2650.7 }).move(2457.55, null)).resolves.toBe(2457.6);
  });

  const T0 = Date.parse("2026-10-23T14:30:00.000Z");
  const bar = (high: number, low: number, close: number, minutes: number): BarData =>
    ({ timestamp: new Date(T0 + minutes * 60_000).toISOString(), open: close, high, low, close, volume: 1 });
  const at = (side: 0 | 1, entry: number): OpenPosition =>
    ({ ...position(side), entryPrice: entry, barsSinceEntry: 1, slTicks: 30 });

  /** The caller's loop over two bars: pick against the stored stop, send, store what came back. */
  async function twoBars(side: 0 | 1, entry: number, candidate: number, mark: number) {
    const { move, modifyOrder } = makeHarness(side, { tickSize: MGC, entry });
    const first = pickTightestFavorableSl(side, null, [candidate]);
    if (first == null) throw new Error("the first bar took no candidate");
    const stored = await move(first, mark);
    return { stored, next: pickTightestFavorableSl(side, stored, [candidate]), sends: modifyOrder.mock.calls.length };
  }

  const R_OFFSET: BreakevenFilterParams = {
    breakEvenFilterEnabled: true,
    breakEvenFilterArmMode: "timeOpen",
    breakEvenFilterArmMinutes: 1,
    breakEvenFilterAtR: 1,
    breakEvenFilterOffsetUnit: "r",
    breakEvenFilterOffsetR: -0.5,
    breakEvenFilterOffsetTicks: 0,
  };

  it.each([
    // −0.5R of a 30-tick stop is 15 ticks: 2650.7 → 2649.2 long, 2456.1 → 2457.6 short.
    [0, 2650.7, 2649.2, 2651],
    [1, 2456.1, 2457.6, 2455.5],
  ] as const)("an MGC side-%i break-even at −0.5R is sent once, and the next bar does not re-send", async (side, entry, want, mark) => {
    const bars = [bar(entry, entry, entry, 0), bar(Math.max(entry, mark), Math.min(entry, mark), mark, 5)];
    const candidate = computeBreakevenSlPrice({ bars, barIndex: 1, position: at(side, entry), tickSize: MGC, params: R_OFFSET });
    expect(candidate).toBe(want);
    const { stored, next, sends } = await twoBars(side, entry, candidate ?? NaN, mark);
    expect(stored).toBe(want);
    expect(sends).toBe(1);
    expect(next).toBeNull();
  });

  const TRAIL: TrailFilterParams = {
    trailFilterEnabled: true,
    trailFilterMode: "ticks",
    trailFilterArmAtR: 0.1,
    trailFilterDistanceAtr: 1,
    trailFilterAtrPeriod: 14,
    trailFilterDistanceTicks: 3,
  };

  it.each([0, 1] as const)("an MGC side-%i trail candidate is on the grid, so the latch holds at every price", async (side) => {
    const entry = 2600;
    const dir = side === 0 ? 1 : -1;
    for (let k = 10; k <= 210; k++) {
      const extreme = priceFromTicks(entry, dir * k, MGC);
      const mark = priceFromTicks(extreme, -dir, MGC);
      const bars = [bar(entry, entry, entry, 0), bar(Math.max(entry, extreme), Math.min(entry, extreme), mark, 5)];
      const candidate = computeTrailSlPrice({ bars, barIndex: 1, position: at(side, entry), tickSize: MGC, params: TRAIL, atrSeries: undefined });
      if (candidate == null) throw new Error(`the trail did not arm at ${extreme}`);
      const { stored, next } = await twoBars(side, entry, candidate, mark);
      expect(stored).toBe(candidate);
      expect(next).toBeNull();
    }
  });
});
