/**
 * `translateOrder` is the seam the reconciler and the exit sweep read a
 * Tradovate resting bracket through: SL vs TP is told by `type` (4 vs 1),
 * the reconciler's `slCurrentPrice` and the tighten guard read `stopPrice`.
 * `/order/list` carries none of orderType/orderQty/price/stopPrice — the
 * client joins the order version onto the order first (bugs.md, demo-
 * confirmed 2026-10-24). These tests pin what the translator answers once
 * that join has filled the fields, and the fail-safe when it has not.
 */
import { describe, it, expect } from "vitest";
import { translateOrder } from "./fill-mapping";
import type { TradovateOrder } from "./types";

const ACCOUNT_ID = 90035646;
const NUMERIC_CONTRACT_ID = 4470324;

/** An `/order/list` item already joined with its order version. */
function order(overrides: Partial<TradovateOrder>): TradovateOrder {
  return {
    id: 633536665362,
    accountId: ACCOUNT_ID,
    contractId: NUMERIC_CONTRACT_ID,
    ordStatus: "Working",
    action: "Sell",
    ...overrides,
  };
}

describe("translateOrder — the order-version fields the exit path reads", () => {
  it("a resting stop answers type 4 (Stop) and the version's numeric stopPrice", () => {
    // The two fields the reconciler's slCurrentPrice and the tighten guard
    // read off a Tradovate SL leg.
    const o = translateOrder(order({ orderType: "Stop", orderQty: 1, stopPrice: 7697.75 }));

    expect(o.type).toBe(4);
    expect(o.stopPrice).toBe(7697.75);
    expect(o.limitPrice).toBeNull();
    expect(o.size).toBe(1);
  });

  it("a resting limit answers type 1 (Limit) and the version's numeric price", () => {
    const o = translateOrder(order({ orderType: "Limit", orderQty: 2, price: 7710.25 }));

    expect(o.type).toBe(1);
    expect(o.limitPrice).toBe(7710.25);
    expect(o.stopPrice).toBeNull();
    expect(o.size).toBe(2);
  });

  it("StopLimit buckets as Stop (type 4), matching the cancel/orphan sweep", () => {
    expect(translateOrder(order({ orderType: "StopLimit", stopPrice: 7697.75 })).type).toBe(4);
  });

  it("an absent orderType reads as Stop (4), never undefined — the fail-safe when the version join could not supply one", () => {
    // mapTradovateOrderType's absent/unknown arm, exercised through its only
    // consumer. Undefined read as "no bracket" on a Tradovate account.
    const o = translateOrder(order({ orderType: undefined, orderQty: undefined }));

    expect(o.type).toBe(4);
    expect(o.size).toBe(0);
  });
});
