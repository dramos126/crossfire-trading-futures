/**
 * The arithmetic that turns fills into money, in one place.
 *
 * Six sites in `engine-reconcile.ts` and one in the browser's live-P&L hook
 * each wrote the same two expressions inline in IEEE 754 doubles, and both
 * of them drift ([bugs.md](../../../../docs/bugs.md) A8):
 *
 *   pnlTicks   = (exitPrice - entryPrice) * direction / tickSize
 *   pnlDollars = pnlTicks * tickValue * size - fees
 *
 * **The division is the one that bites, and only on some products.** A tick
 * size of `0.25` is a binary fraction, so an /NQ delta divides exactly and
 * the shape looks fine wherever it was checked. `0.1` is not: /MGC at
 * 2650.7 − 2648.3 gives `2.400000000000091`, and over 0.1 that is
 * `24.000000000000913` ticks rather than 24. Everything downstream inherits
 * it — the dollar figure, the reverse-derived tick count on the heal path,
 * and `use-live-pnl`'s session rollups, which sum it.
 *
 * **The fix is a unit, not a rounding pass.** Prices and tick sizes are
 * decimals with a handful of places, so scaling both to integers before
 * dividing makes the quotient the correctly-rounded value of an exact
 * rational instead of a division of two approximations; and money is cents,
 * which is what the reconciler's own `PNL_DRIFT_TOLERANCE_DOLLARS` comment
 * already says (*"the Topstep API reports profitAndLoss to 2 decimals"*).
 * Rounding at the boundary is what makes two trades at the same prices
 * produce byte-identical rows, which is the property the entry asks for.
 *
 * **Ticks are deliberately not rounded to integers.** A multi-lot entry
 * whose fills landed at different prices has a genuinely fractional average,
 * so `pnlTicks` of 57.5 is a real number and snapping it would be a second,
 * worse defect. Only the money is quantised.
 *
 * Pure, dependency-free and shared with the browser bundle — keep it that
 * way. Owned by docs/modules/trading/engine.md, beside `fees.ts`.
 */

/**
 * Fixed-point scale for price arithmetic. 1e8 covers every futures tick size
 * this platform trades — the finest is /6E at 0.00005 — with five orders of
 * magnitude to spare, and a scaled index price is ~1e13, comfortably inside
 * the 2^53 range where integers are exact.
 */
const PRICE_SCALE = 1e8;

/** Money is cents. Everything this module returns as dollars is quantised
 *  to this before it leaves. */
const CENTS_PER_DOLLAR = 100;

/** Round a dollar figure to whole cents. Exported because a caller that
 *  assembles money from a source this module cannot see — a broker's own
 *  `profitAndLoss`, summed across fills — still owes the same unit. */
export function roundToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * CENTS_PER_DOLLAR) / CENTS_PER_DOLLAR;
}

/**
 * Signed tick distance between an entry and an exit.
 *
 * `direction` is `+1` for a long and `-1` for a short, so the result is
 * positive on a winner either way. Returns 0 for a non-positive or
 * non-finite `tickSize` rather than `Infinity` / `NaN`: every caller guards
 * that case already and a poisoned number that reaches a trade row is worse
 * than a zero the guard above it was going to log about.
 */
export function pnlTicksFromPrices(
  entryPrice: number,
  exitPrice: number,
  direction: 1 | -1,
  tickSize: number,
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return 0;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 0;
  // Scale first, subtract second. Subtracting in float and scaling after
  // would keep the representation error the scaling exists to remove.
  const delta = Math.round(exitPrice * PRICE_SCALE) - Math.round(entryPrice * PRICE_SCALE);
  return (delta * direction) / Math.round(tickSize * PRICE_SCALE);
}

/**
 * The price `ticks` away from `reference`, on the tick grid.
 *
 * `ticks` is **signed** and carries the direction: a long's stop is
 * `-slTicks`, its target `+tpTicks`, and a short's are the mirror. Scaling
 * both operands to integers before adding is the same unit argument
 * `pnlTicksFromPrices` makes in reverse — `2650.7 - 100 * 0.1` is
 * `2640.6999999999998` in doubles, which is a bracket price off the grid
 * and a broker rejection rather than a rounding curiosity.
 *
 * Returns `reference` unchanged for a non-positive or non-finite
 * `tickSize`, matching this module's other guards: the caller already has
 * to handle a missing tick size, and a poisoned price on an order body is
 * worse than the no-op it was going to log about.
 */
export function priceFromTicks(
  reference: number,
  ticks: number,
  tickSize: number,
): number {
  if (!Number.isFinite(reference) || !Number.isFinite(ticks)) return reference;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return reference;
  const offset = Math.round(ticks * Math.round(tickSize * PRICE_SCALE));
  return (Math.round(reference * PRICE_SCALE) + offset) / PRICE_SCALE;
}

/** A dollar figure as whole cents. `0` for anything non-finite, matching
 *  `roundToCents`' own refusal — a caller that needs the distinction has to
 *  guard before it asks. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

/**
 * What one contract loses if the stop fills, fees included, **in whole
 * cents** — the risk sizer's denominator.
 *
 * It is here rather than in the sizer because it is the money-from-ticks
 * expression this module exists to own, and it returns cents rather than
 * dollars because the sizer divides a budget by it and floors: at a budget
 * that is an exact multiple of the loss, a float division lands on
 * `2.9999999999999996` and the operator gets two contracts where they asked
 * for three. Integers make the boundary decidable.
 *
 * The fee is doubled because a round trip pays both sides, which is the same
 * reading `FEE_PER_SIDE_USD` carries in `fees.ts` and the same one the
 * backtest's fee model uses.
 */
export function riskPerContractCents(
  slTicks: number,
  tickValue: number,
  feePerSideUsd: number,
): number {
  return toCents(slTicks * tickValue) + 2 * toCents(feePerSideUsd);
}

/**
 * Gross dollars for a signed tick distance over `size` contracts.
 *
 * Gross: fees are the caller's to subtract, because only the caller knows
 * whether the figure it holds is round-trip or per-side.
 */
export function pnlDollarsFromTicks(
  pnlTicks: number,
  tickValue: number,
  size: number,
): number {
  if (!Number.isFinite(pnlTicks)) return 0;
  if (!Number.isFinite(tickValue) || !Number.isFinite(size)) return 0;
  return roundToCents(pnlTicks * tickValue * size);
}

/**
 * Ticks back out of a **gross** dollar figure — the reverse derivation the
 * heal and validation paths use so a broker-reported P&L still lands in the
 * same tick column a price-math close would have written.
 *
 * Feed it gross, never net: every call site adds `feesDollars` back on
 * first, because the tick column is compared against backtest output, which
 * does not model fees.
 */
export function pnlTicksFromDollars(
  grossDollars: number,
  tickValue: number,
  size: number,
): number {
  if (!Number.isFinite(grossDollars)) return 0;
  if (!Number.isFinite(tickValue) || tickValue <= 0) return 0;
  if (!Number.isFinite(size) || size <= 0) return 0;
  return grossDollars / (tickValue * size);
}

/**
 * The whole close in one call: gross from price geometry, net after fees,
 * and the tick column, all agreeing by construction.
 *
 * The three used to be computed separately at each site and could disagree —
 * `resolveExitFromFills` derived ticks from a dollar figure it had just
 * derived from ticks, so the round trip through two divisions was where the
 * row's own two columns drifted apart.
 */
export function closePnl(args: {
  entryPrice: number;
  exitPrice: number;
  /** `0` = long, `1` = short — `OrderSide`, matching the trade row. */
  side: number;
  tickSize: number;
  tickValue: number;
  size: number;
  feesDollars: number;
}): { pnlTicks: number; grossDollars: number; netDollars: number } {
  const direction = args.side === 0 ? 1 : -1;
  const pnlTicks = pnlTicksFromPrices(
    args.entryPrice,
    args.exitPrice,
    direction,
    args.tickSize,
  );
  const grossDollars = pnlDollarsFromTicks(pnlTicks, args.tickValue, args.size);
  return {
    pnlTicks,
    grossDollars,
    netDollars: roundToCents(grossDollars - args.feesDollars),
  };
}
