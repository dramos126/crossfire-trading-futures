import { describe, it, expect } from "vitest";

import { chargedFeePerSide, parseSizingInput, RISK_SIZING_NEEDS_FEES } from "./backtest-sizing-input";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import { REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";

const FEE = feePerSideFor("/MNQ");
const RISK = { mode: "risk", maxRiskPerTradeUsd: 225, maxContracts: 3 };

describe("parseSizingInput", () => {
  it("reads an absent field as no sizing, which runBacktest runs at one contract", () => {
    expect(parseSizingInput(undefined, FEE)).toEqual({ ok: true, sizing: undefined });
    expect(parseSizingInput(null, 0)).toEqual({ ok: true, sizing: undefined });
  });

  it("accepts a fixed count, with fees on or off", () => {
    expect(parseSizingInput({ mode: "fixed", contracts: 2 }, 0)).toEqual({
      ok: true,
      sizing: { mode: "fixed", contracts: 2 },
    });
  });

  it("accepts a risk budget when a fee is charged", () => {
    expect(parseSizingInput(RISK, FEE)).toEqual({
      ok: true,
      sizing: { mode: "risk", maxRiskPerTradeUsd: 225, maxContracts: 3 },
    });
  });

  it("refuses risk sizing when no fee is charged, with the sentence the form shows", () => {
    expect(parseSizingInput(RISK, 0)).toEqual({ ok: false, error: RISK_SIZING_NEEDS_FEES });
  });

  it("accepts a ceiling above the live one, as the backtest command's --max-contracts does", () => {
    // The live refusal of the same number is PUT /api/accounts/risk's, pinned
    // in its own route test; a backtest body is research and may exceed it.
    const maxContracts = REVIEWED_MAX_CONTRACTS + 7;
    expect(parseSizingInput({ mode: "risk", maxRiskPerTradeUsd: 1200, maxContracts }, FEE)).toEqual({
      ok: true,
      sizing: { mode: "risk", maxRiskPerTradeUsd: 1200, maxContracts },
    });
  });

  it.each([
    ["a non-object", "fixed"],
    ["an array", []],
    ["an unknown mode", { mode: "dollars" }],
    ["a fractional count", { mode: "fixed", contracts: 1.5 }],
    ["a zero count", { mode: "fixed", contracts: 0 }],
    ["a count sent as a string", { mode: "fixed", contracts: "2" }],
    ["a zero budget", { mode: "risk", maxRiskPerTradeUsd: 0, maxContracts: 3 }],
    ["a non-finite budget", { mode: "risk", maxRiskPerTradeUsd: Infinity, maxContracts: 3 }],
    ["a fractional ceiling", { mode: "risk", maxRiskPerTradeUsd: 225, maxContracts: 2.5 }],
    ["a missing ceiling", { mode: "risk", maxRiskPerTradeUsd: 225 }],
  ])("refuses %s", (_name, raw) => {
    expect(parseSizingInput(raw, FEE).ok).toBe(false);
  });
});

describe("chargedFeePerSide", () => {
  it("is the ticker's fee with fees on and 0 with them off", () => {
    expect(FEE).toBeGreaterThan(0);
    expect(chargedFeePerSide("/MNQ", true)).toBe(FEE);
    expect(chargedFeePerSide("/MNQ", false)).toBe(0);
  });

  it("takes a numeric override over the flag, as the eval route's cached-bars body sends", () => {
    expect(chargedFeePerSide("/MNQ", false, 1.5)).toBe(1.5);
    expect(chargedFeePerSide("/MNQ", true, "1.5")).toBe(FEE);
  });

  it("so fees on with a zero override charges nothing, and risk sizing is refused", () => {
    // The hole the flag-only check left: includeFees true, feePerSideUsd 0.
    const fee = chargedFeePerSide("/MNQ", true, 0);
    expect(fee).toBe(0);
    expect(parseSizingInput(RISK, fee)).toEqual({ ok: false, error: RISK_SIZING_NEEDS_FEES });
  });
});
