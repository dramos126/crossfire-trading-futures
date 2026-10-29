/**
 * `productRootFromContractId` — D-2's "instrument is the product root, in any
 * month" equality.
 *
 * The interesting cases are the two failure directions, because they have
 * opposite costs: a root that comes back wrong makes the engine claim a
 * product it does not trade, and a `null` that a caller reads as "no match"
 * makes it flatten a position it cannot identify.
 */

import { describe, it, expect } from "vitest";
import {
  contractMonthKey,
  productRootFromContractId,
  sameContractMonth,
} from "./contract-pairing";

describe("productRootFromContractId", () => {
  it("reads the root out of a Topstep dotted contract id", () => {
    expect(productRootFromContractId("CON.F.US.MGC.Z26")).toBe("MGC");
  });

  it("reads the root out of a Tradovate dated symbol", () => {
    expect(productRootFromContractId("MESU2025")).toBe("MES");
  });

  it("gives one root for two months of the same product, which is the rule", () => {
    expect(productRootFromContractId("CON.F.US.MGC.Z26")).toBe(
      productRootFromContractId("CON.F.US.MGC.G27"),
    );
  });

  it("separates two products whose roots share a prefix", () => {
    expect(productRootFromContractId("CON.F.US.ENQ.U26")).toBe("ENQ");
    expect(productRootFromContractId("CON.F.US.MNQ.U26")).toBe("MNQ");
  });

  it("does not mistake a digit-bearing root's tail for the month code", () => {
    // `M2KZ26` back-tracks past `M2` + `K` (a real month code) before
    // landing on `M2K` + `Z26`. Observed root, from TICKER_CONTRACT_MAP.
    expect(productRootFromContractId("CON.F.US.M2K.Z26")).toBe("M2K");
  });

  it("answers null for a Tradovate numeric contract id, which arrives before the symbol lookup warms", () => {
    // `resolveContractIdString` in tradovate/fill-mapping.ts falls back to
    // `String(numericContractId)` on a lookup miss — normal operation, not
    // corrupt data.
    expect(productRootFromContractId("2749342")).toBeNull();
  });

  it("answers null for an identifier with no month/year tail", () => {
    expect(productRootFromContractId("CON.F.US.MGC")).toBeNull();
    expect(productRootFromContractId("MGC")).toBeNull();
    expect(productRootFromContractId("")).toBeNull();
  });
});

describe("sameContractMonth", () => {
  it("pairs a Topstep contract id with the Tradovate symbol for the same expiry", () => {
    expect(sameContractMonth("CON.F.US.MNQ.M26", "MNQM6")).toBe(true);
    expect(sameContractMonth("CON.F.US.MES.U25", "MESU2025")).toBe(true);
  });

  it("pairs across the roots that differ per broker namespace", () => {
    // Topstep names gold `GCE`, Tradovate names it `GC` — comparing roots
    // here would read one live product as two, which is why this compares
    // the expiry only.
    expect(sameContractMonth("CON.F.US.GCE.Z26", "GCZ6")).toBe(true);
    expect(sameContractMonth("CON.F.US.MCLE.Z26", "MCLZ26")).toBe(true);
  });

  it("separates two months of one product, which is the case it exists for", () => {
    // A position on the back month must not be marked off the front one.
    expect(sameContractMonth("CON.F.US.MNQ.M26", "MNQU6")).toBe(false);
    expect(sameContractMonth("CON.F.US.MNQ.M26", "MNQM7")).toBe(false);
  });

  it("answers false when either side cannot be read, which callers treat as a refusal", () => {
    expect(sameContractMonth("CON.F.US.MNQ.M26", "4799969")).toBe(false);
    expect(sameContractMonth("", "MNQM6")).toBe(false);
  });
});

describe("contractMonthKey", () => {
  it("renders the same month for both identifier shapes", () => {
    expect(contractMonthKey("CON.F.US.MNQ.U26")).toBe("U2026");
    expect(contractMonthKey("MNQU6")).toBe("U2026");
    expect(contractMonthKey("MESU2025")).toBe("U2025");
  });

  it("answers null when the identifier cannot be read", () => {
    expect(contractMonthKey("4799969")).toBeNull();
    expect(contractMonthKey("CON.F.US.MNQ")).toBeNull();
    expect(contractMonthKey("")).toBeNull();
  });
});
