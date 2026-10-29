/**
 * `tickerForContractId` — the rendered symbol an Activity sentence names,
 * derived from a broker contract identifier.
 *
 * The two failure directions have opposite costs and both are here. A wrong
 * symbol is the worse one: an operator reading *"Closing a GC position that
 * has no stop"* about an MGC position acts on the wrong instrument, so the
 * per-namespace roots (`GCE` is `/GC`, `MCLE` is `/MCL`) are asserted rather
 * than assumed. A `null` costs a withheld slot and a line that falls back to
 * its own prose, which is the safe direction.
 */

import { describe, it, expect } from "vitest";
import { tickerForContractId, tickerSymbolForContractId } from "./contract-resolver";

describe("tickerForContractId", () => {
  it("reads a Topstep contract id whose root is not the ticker", () => {
    // The three that would be wrong if the root were rendered directly.
    expect(tickerForContractId("CON.F.US.ENQ.U26")).toBe("NQ");
    expect(tickerForContractId("CON.F.US.EP.U26")).toBe("ES");
    expect(tickerForContractId("CON.F.US.GCE.Z26")).toBe("GC");
    expect(tickerForContractId("CON.F.US.MCLE.Z26")).toBe("MCL");
  });

  it("reads a Topstep contract id whose root is the ticker", () => {
    expect(tickerForContractId("CON.F.US.MNQ.U26")).toBe("MNQ");
    expect(tickerForContractId("CON.F.US.MES.Z25")).toBe("MES");
  });

  it("reads a Tradovate dated symbol, where the root is the ticker", () => {
    expect(tickerForContractId("MNQU6")).toBe("MNQ");
    expect(tickerForContractId("MESU2025")).toBe("MES");
    // Tradovate names gold `GC` where Topstep's root is `GCE`; both must
    // land on the same rendered symbol or one broker's safety line reads
    // as a different product from the other's.
    expect(tickerForContractId("GCZ26")).toBe("GC");
    expect(tickerForContractId("MCLZ26")).toBe("MCL");
  });

  it("gives one symbol for two months of one product", () => {
    expect(tickerForContractId("CON.F.US.MNQ.U26")).toBe(tickerForContractId("CON.F.US.MNQ.Z26"));
  });

  it("answers null rather than guessing, which withholds the slot", () => {
    // A numeric Tradovate id before its symbol lookup warms, a product this
    // install does not map, and a shape the parser does not read.
    expect(tickerForContractId("4799969")).toBeNull();
    expect(tickerForContractId("CON.F.US.ZZZ.U26")).toBeNull();
    expect(tickerForContractId("")).toBeNull();
  });
});

describe("tickerSymbolForContractId", () => {
  it("answers the deployment ticker, slash and all, so it can be resolved with", () => {
    expect(tickerSymbolForContractId("MNQM6")).toBe("/MNQ");
    expect(tickerSymbolForContractId("CON.F.US.ENQ.U26")).toBe("/NQ");
    expect(tickerSymbolForContractId("GCZ6")).toBe("/GC");
  });

  it("answers null for a product no ticker maps", () => {
    expect(tickerSymbolForContractId("CON.F.US.ZZZ.U26")).toBeNull();
  });
});
