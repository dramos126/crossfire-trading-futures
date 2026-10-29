/**
 * Tests for `isClosingFill` — the Layer 1 closing-fill discriminator.
 *
 * The point of these is the fork itself: since Phase E5 it is selected by
 * `capabilities.fillCarriesPnl`, not by the plugin's id, so the same
 * `deps.pluginFor` seam the engine uses is what gets exercised here. A
 * plugin whose capability is flipped must take the other arm.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

import { isClosingFill, type IsClosingFillDeps } from "./engine-fill";
import { BrokerKind } from "@/lib/db/account-brokers";
import type { BrokerCapabilities, BrokerPlugin } from "@/lib/brokers/plugin";
import type { TradeFill } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";

const BASE_CAPABILITIES: BrokerCapabilities = {
  fillCarriesPnl: false,
  historicalFillsRequireOrderLookup: false,
  bracketAttribution: "reconciler",
  bracketAnchor: "fill",
  positionCloseGraceMs: 0,
  stopCoverageSource: "open-orders",
  realtimeAccountScope: "traded",
  entryFillMayRacePlaceResponse: false,
  realtimeDrivesReconciliation: false,
  realtimeFeedOutlivesEngineStop: false,
  authFailureScope: "account",
};

function depsWith(fillCarriesPnl: boolean): IsClosingFillDeps {
  const plugin = {
    id: "stub",
    capabilities: { ...BASE_CAPABILITIES, fillCarriesPnl },
  } as unknown as BrokerPlugin;
  return { pluginFor: () => plugin };
}

const ENTRY_AT = "2026-06-01T14:30:00.000Z";

function makeTrade(overrides: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    id: 1,
    contractId: "NQ-2026",
    side: 0,
    entryOrderId: 900,
    entryFilledAt: ENTRY_AT,
    tpOrderId: null,
    slOrderId: null,
    exitOrderId: null,
    ...overrides,
  } as StrategyTrade;
}

function makeFill(overrides: Partial<TradeFill> = {}): TradeFill {
  return {
    id: 1,
    accountId: 1001,
    contractId: "NQ-2026",
    creationTimestamp: "2026-06-01T15:00:00.000Z",
    price: 20100,
    profitAndLoss: null,
    fees: 0,
    side: 1,
    size: 1,
    voided: false,
    orderId: 901,
    ...overrides,
  } as TradeFill;
}

describe("isClosingFill — shared clauses", () => {
  it("rejects a voided fill regardless of the discriminator", () => {
    const fill = makeFill({ voided: true, profitAndLoss: 250, orderId: 901 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(false);
    expect(isClosingFill(depsWith(false), BrokerKind.Tradovate, fill, makeTrade())).toBe(false);
  });

  it("rejects a fill on the same side as the entry", () => {
    const fill = makeFill({ side: 0, profitAndLoss: 250 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(false);
  });

  it("rejects a fill that predates entryFilledAt", () => {
    const fill = makeFill({
      creationTimestamp: "2026-06-01T14:00:00.000Z",
      profitAndLoss: 250,
    });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(false);
  });

  it("rejects a fill on a different contract", () => {
    const fill = makeFill({ contractId: "ES-2026", profitAndLoss: 250 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(false);
  });
});

describe("isClosingFill — fillCarriesPnl selects the discriminator", () => {
  it("with fillCarriesPnl, a null-PnL fill is not closing even when its orderId is a bracket id", () => {
    const fill = makeFill({ orderId: 777, profitAndLoss: null });
    const trade = makeTrade({ tpOrderId: 777 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, trade)).toBe(false);
  });

  it("without fillCarriesPnl, that same null-PnL bracket fill is closing", () => {
    const fill = makeFill({ orderId: 777, profitAndLoss: null });
    const trade = makeTrade({ tpOrderId: 777 });
    expect(isClosingFill(depsWith(false), BrokerKind.Tradovate, fill, trade)).toBe(true);
  });

  it("with fillCarriesPnl, a non-null-PnL fill from a non-entry order is closing", () => {
    const fill = makeFill({ orderId: 901, profitAndLoss: 250 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(true);
  });

  it("with fillCarriesPnl, the entry order's own fill is never closing", () => {
    const fill = makeFill({ orderId: 900, profitAndLoss: 250 });
    expect(isClosingFill(depsWith(true), BrokerKind.Topstep, fill, makeTrade())).toBe(false);
  });

  it("without fillCarriesPnl, a manual close on an unknown order id is still closing", () => {
    const fill = makeFill({ orderId: 4242 });
    expect(isClosingFill(depsWith(false), BrokerKind.Tradovate, fill, makeTrade())).toBe(true);
  });

  it("without fillCarriesPnl, the entry order's own fill is never closing", () => {
    const fill = makeFill({ orderId: 900 });
    expect(isClosingFill(depsWith(false), BrokerKind.Tradovate, fill, makeTrade())).toBe(false);
  });

  it("without fillCarriesPnl and no entry order id, an unmatched fill is not closing", () => {
    const fill = makeFill({ orderId: 4242 });
    const trade = makeTrade({ entryOrderId: null });
    expect(isClosingFill(depsWith(false), BrokerKind.Tradovate, fill, trade)).toBe(false);
  });
});
