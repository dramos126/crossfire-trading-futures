/**
 * `placeEntryOrder`'s pre-entry open-order snapshot (A98). The snapshot is the
 * whole basis of bracket attribution, so it must bypass the 1s open-order
 * cache: a cached read that predates an order already working on the contract
 * would count that order as one of this entry's brackets.
 *
 * The broker reports a live position on the contract, so the call aborts at the
 * position check — after the snapshot, before any row is written or order sent.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// `db/trades` registers a migration at import time, so it is enumerated.
vi.mock("@/lib/db/trades", () => ({
  insertPendingEntry: vi.fn(),
  markEntryFailed: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
}));

import {
  isFailedPreEntrySnapshot,
  placeEntryOrder,
  type EntryRiskFacts,
  type PlaceEntryOrderDeps,
} from "./engine-order";
import { insertPendingEntry, setBracketOrderIds } from "@/lib/db/trades";
import type { Broker } from "../broker-access/broker";
import type { BrokerPlugin } from "@/lib/brokers/plugin";
import { translatePlaceOrder } from "@/lib/brokers/tradovate/order-mapping";
import type { TradovateOSOBody } from "@/lib/brokers/tradovate/types";
import type { Contract, PlaceOrderRequest } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { CommonParams, StrategyModule } from "../strategy-types";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";

const CONTRACT = { id: "CON.F.US.MNQ.Z26", tickSize: 0.25, tickValue: 0.5 } as Contract;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("placeEntryOrder — the pre-entry order snapshot", () => {
  it("reads open orders fresh, bypassing the cache, before the position check", async () => {
    const searchOpenOrders = vi.fn().mockResolvedValue([]);
    const broker = {
      searchOpenOrders,
      searchOpenPositions: vi.fn().mockResolvedValue([
        { contractId: CONTRACT.id, size: 1, type: 1 },
      ]),
    } as unknown as Broker;
    const deps = {
      brokerFor: () => broker,
      log: vi.fn(),
      logEvent: vi.fn(),
      releaseContractLock: vi.fn(),
      maybeOrphanFromBrokerError: vi.fn(),
    } as unknown as PlaceEntryOrderDeps;

    await expect(
      placeEntryOrder(
        deps,
        { config: { entryType: 2 } } as StrategyModule,
        { id: "dep-1", accountId: 7 } as Deployment,
        CONTRACT,
        0,
        {} as CommonParams,
        40,
        20,
        21_000,
        null,
        1,
        {} as EntryRiskFacts,
        "2026-10-19T14:00:00.000Z",
        null,
        undefined,
      ),
    ).rejects.toThrow("broker position conflict");

    expect(searchOpenOrders).toHaveBeenCalledWith(7, { forceFresh: true });
    expect(insertPendingEntry).not.toHaveBeenCalled();
  });

  /** A119: a failed read and an empty book both store `[]`; only the failed
   *  one is marked, so the stage-2 cancel can tell them apart. */
  describe("A119 — a failed snapshot is marked, an empty one is not", () => {
    async function snapshotWhen(searchOpenOrders: Broker["searchOpenOrders"]): Promise<number[]> {
      const broker = {
        searchOpenOrders,
        searchOpenPositions: vi.fn().mockResolvedValue([]),
      } as unknown as Broker;
      const deps = {
        brokerFor: () => broker,
        brokerKindFor: vi.fn(),
        pluginFor: vi.fn(),
        log: vi.fn(),
        logEvent: vi.fn(),
        releaseContractLock: vi.fn(),
        acquireContractLock: vi.fn(),
        openBufferSlot: vi.fn(),
        maybeOrphanFromBrokerError: vi.fn(),
        noteEntryRejected: vi.fn(),
        buildCustomTag: () => "e-dep-1",
        engineSessionId: "s1",
      } satisfies PlaceEntryOrderDeps;
      // The insert-failure return hands back the snapshot without an order.
      vi.mocked(insertPendingEntry).mockImplementation(() => {
        throw new Error("stop here");
      });
      const result = await placeEntryOrder(
        deps,
        { config: { entryType: 2 } } as StrategyModule,
        { id: "dep-1", accountId: 7, ticker: "/MNQ", strategyKey: "test" } as Deployment,
        CONTRACT,
        0,
        {} as CommonParams,
        40,
        20,
        21_000,
        null,
        1,
        {} as EntryRiskFacts,
        "2026-10-19T14:00:00.000Z",
        null,
        undefined,
      );
      return result.preEntryOrderIds;
    }

    it("a read that throws stores an empty snapshot marked as failed", async () => {
      const ids = await snapshotWhen(vi.fn().mockRejectedValue(new Error("HTTP 503")));
      expect(ids).toEqual([]);
      expect(isFailedPreEntrySnapshot(ids)).toBe(true);
    });

    it("a read that answers an empty book stores an unmarked empty snapshot", async () => {
      const ids = await snapshotWhen(vi.fn().mockResolvedValue([]));
      expect(ids).toEqual([]);
      expect(isFailedPreEntrySnapshot(ids)).toBe(false);
    });
  });
});

/**
 * docs/bugs-fixed.md. A
 * Topstep account with a permanent violation rejected ~20 entries overnight,
 * one per signal, because nothing re-read the account between status checks.
 * A rejected entry now asks for one; the account entry gate refuses the next
 * signal off what that check stores.
 */
describe("engine keeps placing entries against non-tradable accounts", () => {
  it("asks for an account status check when the broker rejects an entry", async () => {
    const rejection = new Error("Account has a permanent violation.");
    const broker = {
      searchOpenOrders: vi.fn().mockResolvedValue([]),
      searchOpenPositions: vi.fn().mockResolvedValue([]),
      placeOrder: vi.fn().mockRejectedValue(rejection),
    } as unknown as Broker;
    const noteEntryRejected = vi.fn();
    const deps = {
      brokerFor: () => broker,
      log: vi.fn(),
      logEvent: vi.fn(),
      releaseContractLock: vi.fn(),
      acquireContractLock: vi.fn(),
      openBufferSlot: vi.fn(),
      maybeOrphanFromBrokerError: vi.fn(),
      noteEntryRejected,
      buildCustomTag: () => "e-dep-1",
      engineSessionId: "s1",
    } as unknown as PlaceEntryOrderDeps;
    vi.mocked(insertPendingEntry).mockReturnValue(41);

    await expect(
      placeEntryOrder(
        deps,
        { config: { entryType: 2 } } as StrategyModule,
        { id: "dep-1", accountId: 7, ticker: "/YM", strategyKey: "test" } as Deployment,
        CONTRACT,
        0,
        {} as CommonParams,
        40,
        20,
        21_000,
        null,
        1,
        {} as EntryRiskFacts,
        "2026-10-19T14:00:00.000Z",
        null,
        undefined,
      ),
    ).rejects.toBe(rejection);

    expect(noteEntryRejected).toHaveBeenCalledTimes(1);
    // The error itself, so the engine can ask its owning broker whether it
    // was a refusal or a 429/timeout, which must not start a check.
    expect(noteEntryRejected).toHaveBeenCalledWith(rejection, 7);
  });
});

describe("a SIGTERM's exit waits for an entry on the wire", () => {
  // Cut after `placeOrder` left, the fill is one no process saw placed until
  // the next one attributes it; the broker's own timeout is 20s, under the cap.
  it("is order work in flight until the broker answers", async () => {
    delete (globalThis as Record<string, unknown>).__crossfireInFlightOrderRequests;
    let answer!: (err: Error) => void;
    const placeOrder = vi.fn(() => new Promise((_resolve, reject) => (answer = reject)));
    const broker = {
      searchOpenOrders: vi.fn().mockResolvedValue([]),
      searchOpenPositions: vi.fn().mockResolvedValue([]),
      placeOrder,
    } as unknown as Broker;
    const deps = {
      brokerFor: () => broker,
      brokerKindFor: vi.fn(),
      pluginFor: vi.fn(),
      log: vi.fn(),
      logEvent: vi.fn(),
      releaseContractLock: vi.fn(),
      acquireContractLock: vi.fn(),
      openBufferSlot: vi.fn(),
      maybeOrphanFromBrokerError: vi.fn(),
      noteEntryRejected: vi.fn(),
      buildCustomTag: () => "e-dep-1",
      engineSessionId: "s1",
    } satisfies PlaceEntryOrderDeps;
    vi.mocked(insertPendingEntry).mockReturnValue(41);

    const entering = placeEntryOrder(
      deps,
      { config: { entryType: 2 } } as StrategyModule,
      { id: "dep-1", accountId: 7, ticker: "/MNQ", strategyKey: "test" } as Deployment,
      CONTRACT,
      0,
      {} as CommonParams,
      40,
      20,
      21_000,
      null,
      1,
      {} as EntryRiskFacts,
      "2026-10-19T14:00:00.000Z",
      null,
      undefined,
    );
    await vi.waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    expect(orderRequestsInFlight()).toBe(1);

    answer(new Error("rejected"));
    await expect(entering).rejects.toThrow("rejected");
    expect(orderRequestsInFlight()).toBe(0);
  });
});

/**
 * A `"sync"` broker (Tradovate's `placeOSO`) hands back the bracket ids, and the
 * reconciler then skips `attributeBrackets`, the only other seed of the stop
 * mirror; its `/order/list` likely carries no `stopPrice` either. Without the
 * price the engine itself asked for, `modifyStopLossToPrice` has no reference
 * and refuses every break-even and trail move for the trade's life.
 */
describe("placeEntryOrder — the stop the fast path placed", () => {
  const ENTRY = 21_000;
  const SL_TICKS = 20;

  async function place(side: 0 | 1, bracketAttribution: "sync" | "reconciler") {
    const placeOrder = vi.fn().mockResolvedValue({ orderId: 900, tpOrderId: 901, slOrderId: 902 });
    const broker = {
      searchOpenOrders: vi.fn().mockResolvedValue([]),
      searchOpenPositions: vi.fn().mockResolvedValue([]),
      placeOrder,
    } as unknown as Broker;
    const deps = {
      brokerFor: () => broker,
      brokerKindFor: vi.fn(),
      pluginFor: () => ({ capabilities: { bracketAttribution } }) as unknown as BrokerPlugin,
      log: vi.fn(),
      logEvent: vi.fn(),
      releaseContractLock: vi.fn(),
      acquireContractLock: vi.fn(),
      openBufferSlot: vi.fn(),
      maybeOrphanFromBrokerError: vi.fn(),
      noteEntryRejected: vi.fn(),
      buildCustomTag: () => "e-dep-1",
      engineSessionId: "s1",
    } satisfies PlaceEntryOrderDeps;
    vi.mocked(insertPendingEntry).mockReturnValue(41);
    const result = await placeEntryOrder(
      deps,
      { config: { entryType: 2 } } as StrategyModule,
      { id: "dep-1", accountId: 7, ticker: "/MNQ", strategyKey: "test" } as Deployment,
      CONTRACT,
      side,
      {} as CommonParams,
      40,
      SL_TICKS,
      ENTRY,
      null,
      1,
      {} as EntryRiskFacts,
      "2026-10-19T14:00:00.000Z",
      null,
      undefined,
    );
    const request = placeOrder.mock.calls[0][0] as PlaceOrderRequest;
    return { result, request };
  }

  /** The SL price Tradovate's OSO body carries for this request. */
  function osoStopPrice(request: PlaceOrderRequest): number | undefined {
    const { body } = translatePlaceOrder(
      request,
      { accountSpec: "PRAC-1", accountId: 7, deviceId: "d" },
      { symbol: "MNQZ6", tickSize: CONTRACT.tickSize },
    );
    return (body as TradovateOSOBody).bracket1?.stopPrice;
  }

  it.each([
    ["long", 0, ENTRY - SL_TICKS * CONTRACT.tickSize],
    ["short", 1, ENTRY + SL_TICKS * CONTRACT.tickSize],
  ] as const)("a %s on a sync broker returns the stop the OSO carried", async (_label, side, expected) => {
    const { result, request } = await place(side, "sync");
    expect(result.slCurrentPrice).toBe(osoStopPrice(request));
    expect(result.slCurrentPrice).toBe(expected);
    expect(setBracketOrderIds).toHaveBeenCalledWith(41, 901, 902);
  });

  it("a reconciler broker returns no stop: attributeBrackets seeds it from the broker", async () => {
    const { result } = await place(0, "reconciler");
    expect(result.slCurrentPrice).toBeNull();
    expect(setBracketOrderIds).not.toHaveBeenCalled();
  });
});

describe("placeEntryOrder — the trade row's sizing snapshot", () => {
  it("records the playbook's cap, share and scaled budget beside the account's numbers", async () => {
    const broker = {
      searchOpenOrders: vi.fn().mockResolvedValue([]),
      searchOpenPositions: vi.fn().mockResolvedValue([]),
    } as unknown as Broker;
    const deps = {
      brokerFor: () => broker,
      log: vi.fn(),
      logEvent: vi.fn(),
      releaseContractLock: vi.fn(),
      maybeOrphanFromBrokerError: vi.fn(),
      buildCustomTag: () => "e-dep-1",
      engineSessionId: "s1",
    } as unknown as PlaceEntryOrderDeps;
    // Stop at the insert: what is asserted is what the row was given.
    vi.mocked(insertPendingEntry).mockImplementation(() => {
      throw new Error("stop here");
    });
    const risk: EntryRiskFacts = {
      maxRiskPerTradeUsd: 350,
      maxContracts: 3,
      riskPerContractUsd: 51.24,
      appliedPlaybookMaxContracts: null,
      appliedPlaybookRiskPercent: 50,
      playbookBudgetUsd: 175,
      phase: "off",
      basis: "flat",
      headroomUsd: null,
      floorUsd: null,
      closeUsd: null,
      peakUsd: null,
      sizesSessionStart: null,
    };

    await placeEntryOrder(
      deps,
      { config: { entryType: 2 } } as StrategyModule,
      { id: "dep-1", accountId: 7, ticker: "/MNQ", strategyKey: "test" } as Deployment,
      CONTRACT,
      0,
      // The stored settings ride the params spread; the applied values sit
      // beside them under their own keys rather than overwriting them.
      { playbookMaxContracts: 0, playbookRiskPercent: 50 } as unknown as CommonParams,
      40,
      20,
      21_000,
      null,
      1,
      risk,
      "2026-10-19T14:00:00.000Z",
      null,
      undefined,
    ).catch(() => undefined);

    expect(vi.mocked(insertPendingEntry).mock.calls[0][0].paramSnapshot).toMatchObject({
      size: 1,
      maxRiskPerTradeUsd: 350,
      maxContracts: 3,
      playbookMaxContracts: 0,
      playbookRiskPercent: 50,
      appliedPlaybookMaxContracts: null,
      appliedPlaybookRiskPercent: 50,
      playbookBudgetUsd: 175,
    });
  });
});
