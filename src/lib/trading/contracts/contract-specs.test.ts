import { describe, it, expect, vi } from "vitest";

// `cached-bars` binds the Topstep provider for the chained tail, which
// reaches `registry-singleton` and its `require.context` strategy loader.
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: vi.fn(() => null) },
}));

import { CONTRACT_SPECS, DEPLOYABLE_SPEC_TICKERS, SPEC_TICKERS, isSpecTicker } from "./contract-specs";
import { cacheSymbolForTicker } from "@/lib/data/cached-bars";
import { FEE_PER_SIDE_USD } from "@/lib/trading/orders/fees";
import { closePnl } from "@/lib/trading/orders/pnl-math";

describe("CONTRACT_SPECS", () => {
  it("agrees with the cache symbol table for every ticker it carries", () => {
    const mapped = Object.fromEntries(
      SPEC_TICKERS.map((t) => [t, CONTRACT_SPECS[t].cacheSymbol]),
    );
    const canonical = Object.fromEntries(
      SPEC_TICKERS.map((t) => [t, cacheSymbolForTicker(t)]),
    );
    expect(mapped).toEqual(canonical);
  });

  it("carries the fee the shared fee table carries, not a second copy", () => {
    for (const t of SPEC_TICKERS) {
      expect(CONTRACT_SPECS[t].feePerSide).toBe(FEE_PER_SIDE_USD[`/${t}`]);
    }
  });

  it("prices a micro index tick at tickSize x $2 per point and micro gold at $10 per point", () => {
    expect(CONTRACT_SPECS.MNQ.tickValue).toBeCloseTo(CONTRACT_SPECS.MNQ.tickSize * 2, 10);
    expect(CONTRACT_SPECS.MES.tickValue).toBeCloseTo(CONTRACT_SPECS.MES.tickSize * 5, 10);
    expect(CONTRACT_SPECS.MYM.tickValue).toBeCloseTo(CONTRACT_SPECS.MYM.tickSize * 0.5, 10);
    expect(CONTRACT_SPECS.MGC.tickValue).toBeCloseTo(CONTRACT_SPECS.MGC.tickSize * 10, 10);
  });

  it("rejects a ticker with no row", () => {
    expect(isSpecTicker("MNQ")).toBe(true);
    expect(isSpecTicker("NQ")).toBe(false);
    expect(isSpecTicker("YM")).toBe(false);
  });
});

describe("MYM, the micro Dow", () => {
  it("is a row the CLI accepts", () => {
    expect(SPEC_TICKERS).toContain("MYM");
    expect(isSpecTicker("MYM")).toBe(true);
  });

  it("trades in whole index points at $0.50 a point, billed like the other CME equity micros", () => {
    expect(CONTRACT_SPECS.MYM.tickSize).toBe(1);
    expect(CONTRACT_SPECS.MYM.tickValue).toBe(0.5);
    expect(CONTRACT_SPECS.MYM.cacheSymbol).toBe("MYM.v.0");
    expect(CONTRACT_SPECS.MYM.feePerSide).toBe(0.62);
    expect(CONTRACT_SPECS.MYM.feePerSide).toBe(CONTRACT_SPECS.MES.feePerSide);
  });

  it("prices a 10-point move on one contract at $5.00 gross through pnl-math", () => {
    const { tickSize, tickValue, feePerSide } = CONTRACT_SPECS.MYM;
    const r = closePnl({
      entryPrice: 42010,
      exitPrice: 42020,
      side: 0,
      tickSize,
      tickValue,
      size: 1,
      feesDollars: 2 * feePerSide,
    });
    expect(r.pnlTicks).toBe(10);
    expect(r.grossDollars).toBe(5);
    expect(r.netDollars).toBe(3.76);
  });

  // Operator, 2026-10-21: research-only from 2026-10-16 until this date.
  it("is offered to the deploy surfaces", () => {
    expect(DEPLOYABLE_SPEC_TICKERS).toContain("MYM");
    expect(DEPLOYABLE_SPEC_TICKERS.every((t) => SPEC_TICKERS.includes(t))).toBe(true);
  });

  it("keeps the equity-index cash session, 09:30–16:00 ET, which the Dow shares with ES and NQ", () => {
    expect(CONTRACT_SPECS.MYM.daySession).toEqual({ start: "09:30", end: "16:00" });
  });
});
