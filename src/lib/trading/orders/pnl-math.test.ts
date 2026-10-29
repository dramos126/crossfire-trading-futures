/**
 * The money primitive, and the drift it exists to remove.
 *
 * A8 in docs/bugs.md: `pnlDollars` was assembled inline in doubles at six
 * reconciler sites and one browser hook. The headline case is the one that
 * made it invisible for so long — on a quarter-tick instrument the
 * arithmetic is *exact*, so anyone who checked it on /NQ or /MNQ saw clean
 * numbers. It is the products whose tick size is not a binary fraction that
 * drift, and /MGC at 0.1 is the one the platform actually trades.
 *
 * Every "old way" figure below is the literal expression this module
 * replaced, evaluated here rather than quoted, so a test cannot claim a
 * defect the old code did not have.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  closePnl,
  pnlDollarsFromTicks,
  pnlTicksFromDollars,
  pnlTicksFromPrices,
  priceFromTicks,
  roundToCents,
} from "./pnl-math";

/** /MGC — COMEX micro gold. tickSize 0.1, tickValue $1.00. */
const MGC = { tickSize: 0.1, tickValue: 1.0 };
/** /MNQ. tickSize 0.25, tickValue $0.50 — the exact-arithmetic control. */
const MNQ = { tickSize: 0.25, tickValue: 0.5 };

describe("pnlTicksFromPrices", () => {
  it("is exact on a tick size that is not a binary fraction", () => {
    // The defect, stated as the difference between the two expressions.
    const oldWay = (2650.7 - 2648.3) / MGC.tickSize;
    expect(oldWay).not.toBe(24);
    expect(Number.isInteger(oldWay)).toBe(false);

    expect(pnlTicksFromPrices(2648.3, 2650.7, 1, MGC.tickSize)).toBe(24);
  });

  it("agrees with the old expression where the old expression was already exact", () => {
    // /MNQ is the control: 0.25 and these prices are all binary fractions,
    // so nothing here should move. A change that "fixed" the exact case too
    // would be changing recorded history rather than removing drift.
    const oldWay = (18014.25 - 18000) / MNQ.tickSize;
    expect(pnlTicksFromPrices(18000, 18014.25, 1, MNQ.tickSize)).toBe(oldWay);
  });

  it("signs a short the same way it signs a long", () => {
    expect(pnlTicksFromPrices(2650.7, 2648.3, -1, MGC.tickSize)).toBe(24);
    expect(pnlTicksFromPrices(2648.3, 2650.7, -1, MGC.tickSize)).toBe(-24);
  });

  it("keeps a genuinely fractional tick count fractional", () => {
    // A two-lot entry filled at 18000.00 and 18000.25 averages 18000.125,
    // which is half a tick off the grid. Snapping to an integer would be a
    // second defect, so the half survives.
    expect(pnlTicksFromPrices(18000.125, 18000.375, 1, MNQ.tickSize)).toBe(1);
    expect(pnlTicksFromPrices(18000, 18000.125, 1, MNQ.tickSize)).toBe(0.5);
  });

  it("is exact at the finest tick size the platform trades", () => {
    // /6E, 0.00005. Five decimal places is where a naive scale would start
    // losing the operands rather than the quotient.
    expect(pnlTicksFromPrices(1.08355, 1.0841, 1, 0.00005)).toBe(11);
  });

  it("answers 0 rather than Infinity or NaN on unusable inputs", () => {
    // Every caller guards these and logs; a poisoned number written to a
    // trade row would outlive the log line.
    expect(pnlTicksFromPrices(100, 110, 1, 0)).toBe(0);
    expect(pnlTicksFromPrices(100, 110, 1, Number.NaN)).toBe(0);
    expect(pnlTicksFromPrices(Number.NaN, 110, 1, 0.25)).toBe(0);
  });
});

describe("priceFromTicks", () => {
  it("lands on the tick grid where the inline expression does not", () => {
    // A bracket price, not a P&L figure: the 403-tick stop from A69, on a
    // /MGC-shaped tick size. The inline form is 2610.3999999999996, which is
    // a stop price the broker has no grid slot for.
    const oldWay = 2650.7 - 403 * MGC.tickSize;
    expect(oldWay).not.toBe(2610.4);

    expect(priceFromTicks(2650.7, -403, MGC.tickSize)).toBe(2610.4);
    expect(priceFromTicks(2650.7, 806, MGC.tickSize)).toBe(2731.3);
  });

  it("agrees with the inline expression on a binary tick size", () => {
    expect(priceFromTicks(29517.75, -403, MNQ.tickSize)).toBe(29517.75 - 403 * 0.25);
    expect(priceFromTicks(29517.75, -403, MNQ.tickSize)).toBe(29417);
  });

  it("returns the reference unchanged on an unusable tick size", () => {
    expect(priceFromTicks(2650.7, -100, 0)).toBe(2650.7);
    expect(priceFromTicks(2650.7, -100, Number.NaN)).toBe(2650.7);
  });
});

describe("pnlDollarsFromTicks / roundToCents", () => {
  it("quantises to cents", () => {
    // 2.5 ticks of /MES ($1.25) is $3.125 — a real sub-cent figure off an
    // averaged multi-lot fill.
    expect(pnlDollarsFromTicks(2.5, 1.25, 1)).toBe(3.13);
  });

  it("makes two identical trades produce identical numbers", () => {
    // The property the entry asks for. Assembled two different ways — as
    // one 3-lot and as the sum of three 1-lots — which is how the same
    // economics reach the row from the resolver and from the heal pass.
    const asOneLot = pnlDollarsFromTicks(24, MGC.tickValue, 3);
    const asThree =
      pnlDollarsFromTicks(24, MGC.tickValue, 1) * 3;
    expect(asOneLot).toBe(asThree);
    expect(asOneLot).toBe(72);
  });

  it("leaves a whole-cent figure alone", () => {
    expect(roundToCents(45.26)).toBe(45.26);
    expect(roundToCents(-45.26)).toBe(-45.26);
  });

  it("removes the tail the division upstream leaves behind", () => {
    // The whole old chain for a 2-lot /MGC winner with the published
    // per-side fee, evaluated rather than quoted. The tail is inherited
    // from the tick division — subtracting the fee does not introduce one
    // and does not remove one either, which is why rounding has to happen
    // at the boundary rather than only at the end.
    const fees = 0.87 * 2;
    const oldNet = ((2650.7 - 2648.3) / MGC.tickSize) * MGC.tickValue * 2 - fees;
    expect(oldNet).not.toBe(46.26);

    expect(roundToCents(oldNet)).toBe(46.26);
  });

  it("answers 0 on a non-finite input", () => {
    expect(roundToCents(Number.NaN)).toBe(0);
    expect(pnlDollarsFromTicks(Number.POSITIVE_INFINITY, 1, 1)).toBe(0);
  });
});

describe("pnlTicksFromDollars", () => {
  it("round-trips a gross figure back to the tick count that produced it", () => {
    // The reverse derivation the heal and validation paths run: the broker
    // reports money, the row still owes a tick column comparable to
    // backtest output.
    const gross = pnlDollarsFromTicks(24, MGC.tickValue, 2);
    expect(pnlTicksFromDollars(gross, MGC.tickValue, 2)).toBe(24);
  });

  it("answers 0 rather than dividing by zero", () => {
    expect(pnlTicksFromDollars(100, 0, 2)).toBe(0);
    expect(pnlTicksFromDollars(100, 1, 0)).toBe(0);
  });
});

describe("closePnl", () => {
  it("returns ticks, gross and net that agree with each other", () => {
    const r = closePnl({
      entryPrice: 2648.3,
      exitPrice: 2650.7,
      side: 0,
      ...MGC,
      size: 2,
      feesDollars: 1.74,
    });
    expect(r.pnlTicks).toBe(24);
    expect(r.grossDollars).toBe(48);
    expect(r.netDollars).toBe(46.26);
    // The row's two money columns are one subtraction apart, in cents, in
    // both directions — which is what `validateClosedTradePrices` and the
    // daily-loss gate both assume when they add fees back on.
    expect(roundToCents(r.netDollars + 1.74)).toBe(r.grossDollars);
  });

  it("reads `side` as OrderSide — 0 long, 1 short", () => {
    const long = closePnl({
      entryPrice: 2648.3, exitPrice: 2650.7, side: 0, ...MGC, size: 1, feesDollars: 0,
    });
    const short = closePnl({
      entryPrice: 2648.3, exitPrice: 2650.7, side: 1, ...MGC, size: 1, feesDollars: 0,
    });
    expect(long.netDollars).toBe(24);
    expect(short.netDollars).toBe(-24);
  });

  it("nets a loss below the fee line correctly", () => {
    // A scratch that still pays commission — the shape the daily-loss gate
    // sums, where a float tail used to survive into the threshold compare.
    const r = closePnl({
      entryPrice: 2650.0, exitPrice: 2650.0, side: 0, ...MGC, size: 1, feesDollars: 1.74,
    });
    expect(r.pnlTicks).toBe(0);
    expect(r.netDollars).toBe(-1.74);
  });
});

/**
 * The failure this module has to survive is a **seventh** money site written
 * inline, not the six that were converted — and an import list cannot see a
 * call site that does not exist yet. So the guard is a source scan for the
 * shape rather than an assertion about who imports what.
 *
 * `x * tickValue` is the signature of assembling dollars from ticks. Every
 * file that still carries it is named below with the reason it is allowed
 * to; anything else is a site that should have gone through this module.
 */
describe("no site assembles dollars from ticks by hand", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

  /**
   * Files permitted to multiply by `tickValue` directly, each for a stated
   * reason. Counts are pinned rather than the file names alone, so a second
   * expression added to an already-listed file still fails.
   */
  const ALLOWED: Record<string, number> = {
    // Simulation, not a money row. The backtest and replay figures are
    // never written to `strategy_trades` and are already fee-approximate;
    // converting them changes recorded backtest output, which needs a
    // baseline re-run and a trader pass rather than a bug fix.
    "src/lib/trading/backtest.ts": 1,
    "src/lib/trading/replay/replay.ts": 1,
    // Display-only, and already quantised by the `.toFixed(2)` that renders
    // it: the entry embed's risk figure, from an integer SL tick count.
    "src/lib/trading/engine/engine-notify.ts": 1,
  };

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  }

  /** Comment lines carry the formula in prose in three places; a scan that
   *  counts those is a scan nobody can keep green. */
  function codeOnly(src: string): string {
    return src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  it("finds the three declared exceptions and nothing else", () => {
    const MONEY_FROM_TICKS = /\*\s*tickValue\b/g;
    const found: Record<string, number> = {};
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === "src/lib/trading/orders/pnl-math.ts") continue;
      const count = (codeOnly(readFileSync(file, "utf8")).match(MONEY_FROM_TICKS) ?? []).length;
      if (count > 0) found[rel] = count;
    }
    // Asserts the scan found something as well as what: a renamed field
    // makes this regex match nothing and pass everything.
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(ALLOWED);
  });
});
