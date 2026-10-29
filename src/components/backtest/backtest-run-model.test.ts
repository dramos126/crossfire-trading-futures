/**
 * The run-reader's decisions.
 *
 * Each test states the obvious wrong way and asserts against it: bucketing
 * on dollars rather than ticks, clamping the stepper at the render instead
 * of in the state, grouping runs by folder name, and printing an excursion
 * magnitude with a sign it does not have.
 */

import { describe, it, expect } from "vitest";
import {
  barWindowFor,
  countOutcomes,
  displayLabels,
  filterTrades,
  flattenMeta,
  formatR,
  formatTicks,
  groupRuns,
  isCrossInstrument,
  resolveStep,
  runsForPlaybook,
} from "./backtest-run-model";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { RunSummary } from "@/lib/trading/backtest-artifacts";

function trade(overrides: Partial<CliTradeRecord> = {}): CliTradeRecord {
  return {
    tradeId: 1,
    foldId: 0,
    sample: "test",
    sessionDate: "2022-07-04",
    regime: null,
    signalBarTs: "2022-07-04T14:05:00.000Z",
    entryTs: "2022-07-04T14:05:00.000Z",
    entryBarIndex: 10,
    side: 0,
    entryPrice: 11540,
    slPrice: 11500,
    tpPrice: 11620,
    slTicks: 160,
    tpTicks: 320,
    contracts: 1,
    exitTs: "2022-07-04T16:25:00.000Z",
    exitBarIndex: 38,
    exitPrice: 11620,
    exitReason: "take_profit",
    pnlTicks: 320,
    pnlGrossDollars: 160,
    feesDollars: 1.24,
    pnlNetDollars: 158.76,
    rMultiple: 2,
    mfeTicks: 340,
    mfeBarIndex: 20,
    maeTicks: 20,
    maeBarIndex: 6,
    barsHeld: 28,
    slMoved: { breakeven: false, trail: false },
    entryMeta: null,
    exitMeta: null,
    entryHourEt: 10,
    weekday: 1,
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runPath: "orb/risk1200-5m",
    label: "risk1200-5m",
    playbookKey: "opening-range-breakout-v2",
    playbookVersion: "5.0.0",
    ticker: "MNQ",
    timeframe: "5m",
    from: "2021-01-01",
    to: "2026-06-30",
    calibratedFor: "MNQ",
    tickSize: 0.25,
    kind: "walk-forward",
    modifiedMs: 1_000,
    tradeCount: 412,
    resolvedParams: null,
    sizing: null,
    feePerSide: null,
    ...overrides,
  };
}

describe("outcome buckets", () => {
  it("buckets on the sign of pnlTicks, not on net dollars", () => {
    // One tick of profit eaten by fees. `computeStats` calls this a win, so
    // this surface must too — otherwise a trade filtered into "losers"
    // shows a chart of price reaching the target.
    const feeEaten = trade({ pnlTicks: 1, pnlNetDollars: -0.74 });
    expect(filterTrades([feeEaten], "winners")).toHaveLength(1);
    expect(filterTrades([feeEaten], "losers")).toHaveLength(0);
  });

  it("does not bucket on exit reason — a trail stop that locked in ticks is a win", () => {
    const trailed = trade({ exitReason: "trail_stop", pnlTicks: 200 });
    expect(filterTrades([trailed], "winners")).toHaveLength(1);
  });

  it("leaves a scratch trade out of both populations and keeps it in all", () => {
    const scratch = trade({ pnlTicks: 0 });
    expect(filterTrades([scratch], "winners")).toHaveLength(0);
    expect(filterTrades([scratch], "losers")).toHaveLength(0);
    expect(filterTrades([scratch], "all")).toHaveLength(1);
  });

  it("counts over the whole run, so the control's own numbers do not move when used", () => {
    const trades = [trade({ pnlTicks: 10 }), trade({ pnlTicks: -10 }), trade({ pnlTicks: 0 })];
    expect(countOutcomes(trades)).toEqual({ all: 3, winners: 1, losers: 1, scratch: 1 });
    // The residual is what explains w + l < all rather than a dropped row.
    const counts = countOutcomes(trades);
    expect(counts.winners + counts.losers + counts.scratch).toBe(counts.all);
  });
});

describe("the stepper", () => {
  it("returns the clamped index rather than leaving it to the render", () => {
    // The defect: state holds 40, the render clamps to 2, the label says
    // 41 and the next press steps from 40.
    const trades = [trade({ tradeId: 1 }), trade({ tradeId: 2 }), trade({ tradeId: 3 })];
    const step = resolveStep(trades, 40);
    expect(step.index).toBe(2);
    expect(step.position).toBe(3);
    // The label, the index and the trade all describe the same row.
    expect(step.trade?.tradeId).toBe(3);
    expect(step.canNext).toBe(false);
  });

  it("names the trade its label is about", () => {
    const trades = [trade({ tradeId: 7 }), trade({ tradeId: 8 })];
    const step = resolveStep(trades, 1);
    expect(step.position).toBe(2);
    expect(step.trade?.tradeId).toBe(8);
  });

  it("answers null for an empty population instead of a zeroth trade", () => {
    const step = resolveStep([], 0);
    expect(step.index).toBeNull();
    expect(step.position).toBeNull();
    expect(step.trade).toBeNull();
    expect(step.total).toBe(0);
    expect(step.canPrev).toBe(false);
    expect(step.canNext).toBe(false);
  });

  it("disables the ends", () => {
    const trades = [trade(), trade()];
    expect(resolveStep(trades, 0).canPrev).toBe(false);
    expect(resolveStep(trades, 0).canNext).toBe(true);
    expect(resolveStep(trades, 1).canPrev).toBe(true);
    expect(resolveStep(trades, 1).canNext).toBe(false);
  });

  it("clamps a negative request rather than reading off the end", () => {
    expect(resolveStep([trade(), trade()], -5).index).toBe(0);
  });
});

describe("grouping runs", () => {
  it("groups on the header's playbookKey, never on the folder name", () => {
    // Both of these live under folders named for something other than the
    // playbook. Grouping by folder files one playbook's trades under
    // another's heading.
    const groups = groupRuns([
      run({ runPath: "tf-arm/control-5m", label: "control-5m" }),
      run({ runPath: "orb/risk1200-5m", label: "risk1200-5m" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].playbookKey).toBe("opening-range-breakout-v2");
    expect(groups[0].runs).toHaveLength(2);
  });

  it("selects a page's runs by header key", () => {
    const runs = [run(), run({ playbookKey: "pair-bar-pullback" })];
    expect(runsForPlaybook(runs, "pair-bar-pullback")).toHaveLength(1);
    expect(runsForPlaybook(runs, "nothing-registered")).toHaveLength(0);
  });

  it("stamps a cross-instrument run from the header, and answers false when the field predates it", () => {
    expect(isCrossInstrument(run({ ticker: "MES", calibratedFor: "MNQ" }))).toBe(true);
    expect(isCrossInstrument(run({ ticker: "MNQ", calibratedFor: "MNQ" }))).toBe(false);
    // Absent is not the same as equal — an older artifact must not be
    // stamped as cross-instrument on a missing field.
    expect(isCrossInstrument(run({ ticker: "MES", calibratedFor: null }))).toBe(false);
  });
});

describe("displayLabels", () => {
  it("leaves every label unchanged when the visible set has no duplicate", () => {
    const runs = [
      run({ runPath: "orb/risk1200-5m", label: "risk1200-5m" }),
      run({ runPath: "ema-bounce/control-5m", label: "control-5m" }),
    ];
    const labels = displayLabels(runs);
    expect(labels.get("orb/risk1200-5m")).toEqual({ label: "risk1200-5m", parent: null });
    expect(labels.get("ema-bounce/control-5m")).toEqual({ label: "control-5m", parent: null });
  });

  it("prefixes only the rows that share a label with the parent directory", () => {
    // opening-range-breakout-v2/risk1200-5m and tf-arm/risk1200-5m both
    // carry playbookKey: opening-range-breakout-v2 and land on the same
    // page — the exact case the punchlist entry names.
    const runs = [
      run({ runPath: "opening-range-breakout-v2/risk1200-5m", label: "risk1200-5m" }),
      run({ runPath: "tf-arm/risk1200-5m", label: "risk1200-5m" }),
      run({ runPath: "tf-arm/control-5m", label: "control-5m" }),
    ];
    const labels = displayLabels(runs);
    expect(labels.get("opening-range-breakout-v2/risk1200-5m")).toEqual({
      label: "risk1200-5m",
      parent: "opening-range-breakout-v2",
    });
    expect(labels.get("tf-arm/risk1200-5m")).toEqual({
      label: "risk1200-5m",
      parent: "tf-arm",
    });
    // The third run's label is unique in this set and stays bare.
    expect(labels.get("tf-arm/control-5m")).toEqual({ label: "control-5m", parent: null });
  });

  it("answers null for a parent when the colliding runPath has none to offer", () => {
    const runs = [
      run({ runPath: "risk1200-5m", label: "risk1200-5m" }),
      run({ runPath: "tf-arm/risk1200-5m", label: "risk1200-5m" }),
    ];
    const labels = displayLabels(runs);
    expect(labels.get("risk1200-5m")).toEqual({ label: "risk1200-5m", parent: null });
    expect(labels.get("tf-arm/risk1200-5m")).toEqual({ label: "risk1200-5m", parent: "tf-arm" });
  });
});

describe("the bar window", () => {
  it("pads in bars, so a 1m and a 15m run get the same readable context", () => {
    const t = trade({
      entryTs: "2022-07-04T14:00:00.000Z",
      exitTs: "2022-07-04T15:00:00.000Z",
    });
    const oneMin = barWindowFor(t, 1, 30, 15);
    const fifteenMin = barWindowFor(t, 15, 30, 15);
    expect(oneMin.fromIso).toBe("2022-07-04T13:30:00.000Z");
    expect(fifteenMin.fromIso).toBe("2022-07-04T06:30:00.000Z");
    expect(oneMin.toIso).toBe("2022-07-04T15:15:00.000Z");
    expect(fifteenMin.toIso).toBe("2022-07-04T18:45:00.000Z");
  });
});

describe("entryMeta", () => {
  it("renders every key it is given, including ones it has never seen", () => {
    const entries = flattenMeta({ rangeHigh: 11571, tier: "normal", somethingNew: true });
    expect(entries.map((e) => e.key)).toEqual(["rangeHigh", "tier", "somethingNew"]);
  });

  it("trims float noise from a divide without rounding an integer", () => {
    const entries = flattenMeta({ atr: 275.01785714285717, rawSlTicks: 124 });
    expect(entries[0].value).toBe("275.0179");
    expect(entries[1].value).toBe("124");
  });

  it("renders a nested value as JSON rather than [object Object]", () => {
    expect(flattenMeta({ slMoved: { breakeven: false } })[0].value).toBe('{"breakeven":false}');
  });

  it("answers an empty list for a null or non-object meta", () => {
    expect(flattenMeta(null)).toEqual([]);
    expect(flattenMeta([1, 2])).toEqual([]);
    expect(flattenMeta("nope")).toEqual([]);
  });
});

describe("number formatting", () => {
  it("states the sign the caller means for an excursion magnitude", () => {
    // Both excursions are recorded positive. An MAE printed "+139t" reads
    // as a gain, which is the opposite of what it is.
    expect(formatTicks(139, "-")).toBe("-139t");
    expect(formatTicks(35, "+")).toBe("+35t");
  });

  it("signs a P&L from its own value", () => {
    expect(formatTicks(-124)).toBe("-124t");
    expect(formatTicks(702)).toBe("+702t");
  });

  it("prints R with an explicit sign", () => {
    expect(formatR(2)).toBe("+2.00R");
    expect(formatR(-1)).toBe("-1.00R");
  });
});
