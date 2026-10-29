/**
 * The renderings the Activity lane shares with the Discord entry/exit
 * embeds. They are one implementation on purpose: a log line and the alert
 * about the same fill disagreeing about the price is worse than either
 * being wrong alone.
 *
 * These moved out of `engine-notify.test.ts` with the functions. The file
 * they came from needs two `vi.mock`s to exist at all — `db/deployments`
 * and the strategy loader — and the point of the leaf is that these
 * assertions need none.
 */

import { describe, it, expect } from "vitest";

import {
  bracketPricesFromFill,
  entryFillValues,
  fmtSignedDollars,
} from "./engine-fill-format";

describe("the shared renderings", () => {
  const LONG = { side: 0 as const, size: 1, tickSize: 0.25, desiredTpTicks: 400, desiredSlTicks: 200 };

  it("prices the brackets off the fill, per side", () => {
    expect(bracketPricesFromFill(LONG, 29246.25)).toEqual({ tpPrice: 29346.25, slPrice: 29196.25 });
    expect(bracketPricesFromFill({ ...LONG, side: 1 }, 29246.25)).toEqual({
      tpPrice: 29146.25,
      slPrice: 29296.25,
    });
  });

  it("answers null for a leg with no tick distance, rather than a price of zero", () => {
    expect(bracketPricesFromFill({ ...LONG, desiredSlTicks: null }, 100).slPrice).toBeNull();
    expect(bracketPricesFromFill({ ...LONG, tickSize: null }, 100)).toEqual({
      tpPrice: null,
      slPrice: null,
    });
  });

  it("builds the entry_filled slots, with the direction the fill had", () => {
    expect(entryFillValues(LONG, 29246.25)).toEqual({
      side: "Bought",
      size: 1,
      price: "29246.25",
      sl: "29196.25",
      tp: "29346.25",
    });
    expect(entryFillValues({ ...LONG, side: 1, size: 3 }, 29246.25).side).toBe("Sold");
  });

  // A withheld slot is what makes the lane fall back to the call site’s own
  // prose. A `—` in the slot would be a sentence claiming a stop at nothing.
  it("omits a bracket slot it has no price for instead of filling it", () => {
    const values = entryFillValues({ ...LONG, desiredSlTicks: null }, 29246.25);
    expect("sl" in values).toBe(false);
    expect(values.tp).toBe("29346.25");
  });

  // `{size}` is the quantity the sentence says changed hands. Announcing a
  // 1-lot partial as "Bought 2 MNQ" is a false claim about a real position,
  // and both sites that observe one hold the broker's number already.
  it("names the filled quantity when the caller has one, and the row's when it does not", () => {
    expect(entryFillValues({ ...LONG, size: 2 }, 29246.25, 1).size).toBe(1);
    expect(entryFillValues({ ...LONG, size: 2 }, 29246.25).size).toBe(2);
  });

  it("signs a P&L the way the exit embed does, including flat", () => {
    expect(fmtSignedDollars(32.25)).toBe("+$32.25");
    expect(fmtSignedDollars(-18)).toBe("−$18.00");
    expect(fmtSignedDollars(0)).toBe("$0.00");
  });
});
