/**
 * What a trade's stop was worth when it was sized, against what it was
 * worth once the fill landed.
 *
 * Both brokers anchor a bracket to the **trigger** — the level the signal
 * named — so the distance from the fill to the stop is the fill's own
 * accident and the realised risk varies with it. That is a deliberate,
 * operator-owned trade ([bugs.md](../../../docs/bugs.md) A69), which makes
 * it something to measure rather than something to cap: the monthly review
 * asks whether the divergence drifts one way or evens out, per broker.
 *
 * **Derived, not stored.** Every input is already a column on the trade
 * row, and the same three columns reconstruct the intent even if the price
 * columns are corrected to a leg that could not be re-anchored. A stored
 * copy would be a fourth number that can disagree with the other three.
 *
 * Fees are excluded on both sides. The sizer's own denominator includes a
 * round trip of them (`riskPerContractCents`), and the budget it divided is
 * on the row's `paramSnapshot` beside this — so a reader comparing intended
 * against realised is comparing like with like, and a reader comparing
 * either against the budget has the fee-inclusive figure to hand.
 */
import { pnlDollarsFromTicks, pnlTicksFromPrices } from "./orders/pnl-math";

export interface RiskAnchor {
  /** The stop distance the sizer divided the budget by, in ticks. */
  intendedRiskTicks: number | null;
  /** `intendedRiskTicks` over the contracts actually filled. */
  intendedRiskDollars: number | null;
  /** Fill to resting stop, in ticks — what the trade can actually lose. */
  realisedRiskTicks: number | null;
  realisedRiskDollars: number | null;
  /**
   * The fill's distance from the trigger, **signed in the trade's own
   * direction**: positive means the fill was worse than the trigger and the
   * stop is further away than intended, negative means price improvement
   * and a tighter stop. Same convention and same arithmetic as the row's
   * `entry_slippage_ticks`.
   */
  fillMinusTriggerTicks: number | null;
}

/** The trade-row fields this reads. Structural so both a `StrategyTrade`
 *  and a backtest-shaped record satisfy it. */
export interface RiskAnchorInput {
  side: 0 | 1;
  size: number;
  tickSize: number | null;
  tickValue: number | null;
  desiredEntryPrice: number | null;
  entryPrice: number | null;
  desiredSlTicks: number | null;
  desiredSlPrice: number | null;
}

const EMPTY: RiskAnchor = {
  intendedRiskTicks: null,
  intendedRiskDollars: null,
  realisedRiskTicks: null,
  realisedRiskDollars: null,
  fillMinusTriggerTicks: null,
};

export function riskAnchorOf(t: RiskAnchorInput): RiskAnchor {
  const tickSize = t.tickSize ?? 0;
  const tickValue = t.tickValue ?? 0;
  if (tickSize <= 0 || tickValue <= 0) return EMPTY;

  const direction: 1 | -1 = t.side === 0 ? 1 : -1;
  const intendedRiskTicks = t.desiredSlTicks;

  // Fill to stop, measured off the two prices rather than off
  // `intendedRiskTicks + slippage`, so a leg the broker would not let the
  // engine re-anchor reports the distance that is really resting.
  const realisedRiskTicks =
    t.entryPrice != null && t.desiredSlPrice != null
      ? pnlTicksFromPrices(t.desiredSlPrice, t.entryPrice, direction, tickSize)
      : null;

  const fillMinusTriggerTicks =
    t.entryPrice != null && t.desiredEntryPrice != null
      ? pnlTicksFromPrices(t.desiredEntryPrice, t.entryPrice, direction, tickSize)
      : null;

  return {
    intendedRiskTicks,
    intendedRiskDollars:
      intendedRiskTicks != null
        ? pnlDollarsFromTicks(intendedRiskTicks, tickValue, t.size)
        : null,
    realisedRiskTicks,
    realisedRiskDollars:
      realisedRiskTicks != null
        ? pnlDollarsFromTicks(realisedRiskTicks, tickValue, t.size)
        : null,
    fillMinusTriggerTicks,
  };
}
