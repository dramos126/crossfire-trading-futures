/**
 * `sizing` as it arrives in a backtest route's body — user input, so checked
 * here at the boundary and nowhere downstream.
 *
 * Absent is `undefined`, which `runBacktest` reads as one contract: the R
 * basis, and what every in-browser run sized at before the field existed.
 */
import type { BacktestSizing } from "@/lib/trading/backtest";
import { feePerSideFor } from "@/lib/trading/orders/fees";

/**
 * Why a risk-sized run needs fees on. The CLI refuses the same pair for the
 * same reason (`--risk-usd` with `--fees off`): the budget is divided by one
 * contract's loss at the stop **including the round-trip fee**, so a fee-free
 * run sizes more contracts and skips fewer entries than the engine would.
 */
export const RISK_SIZING_NEEDS_FEES =
  "A run sized by risk per trade needs fees on. The budget is sized on one contract's loss at " +
  "the stop including fees, so without them the run would size more contracts than the engine " +
  "places. Turn fees on, or size by a fixed contract count.";

/**
 * The fee per side a backtest route will actually charge. A numeric
 * `override` wins over `includeFees` (the eval route's cached-bars body
 * carries one), so the fees refusal reads this rather than the flag:
 * `includeFees: true` with an override of 0 charges nothing.
 */
export function chargedFeePerSide(ticker: string, includeFees: boolean, override?: unknown): number {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return includeFees ? feePerSideFor(ticker) : 0;
}

export type SizingInput =
  | { ok: true; sizing: BacktestSizing | undefined }
  | { ok: false; error: string };

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** `feePerSideUsd` is `chargedFeePerSide`'s answer — risk sizing is refused
 *  whenever it is not above zero, whatever `includeFees` said. */
export function parseSizingInput(raw: unknown, feePerSideUsd: number): SizingInput {
  if (raw == null) return { ok: true, sizing: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "sizing must be an object" };
  }
  const s = raw as Record<string, unknown>;
  if (s.mode === "fixed") {
    if (!isPositiveInt(s.contracts)) {
      return { ok: false, error: "sizing.contracts must be a positive whole number" };
    }
    return { ok: true, sizing: { mode: "fixed", contracts: s.contracts } };
  }
  if (s.mode === "risk") {
    if (!isPositiveNumber(s.maxRiskPerTradeUsd)) {
      return { ok: false, error: "sizing.maxRiskPerTradeUsd must be a positive number" };
    }
    if (!isPositiveInt(s.maxContracts)) {
      return { ok: false, error: "sizing.maxContracts must be a positive whole number" };
    }
    if (!(feePerSideUsd > 0)) return { ok: false, error: RISK_SIZING_NEEDS_FEES };
    return {
      ok: true,
      sizing: { mode: "risk", maxRiskPerTradeUsd: s.maxRiskPerTradeUsd, maxContracts: s.maxContracts },
    };
  }
  return { ok: false, error: 'sizing.mode must be "fixed" or "risk"' };
}
