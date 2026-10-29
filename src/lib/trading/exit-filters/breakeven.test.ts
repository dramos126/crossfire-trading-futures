/**
 * `computeBreakevenSlPrice` — the arming window and the arm modes.
 *
 * Both paths count `barsSinceEntry` from the signal bar, and the fill is at
 * (backtest) or after (engine) that bar's close, so the signal bar's range
 * traded before the position existed. It must not count toward the MFE that
 * arms the move, nor start a time mode's clock before the fill.
 */

import { describe, it, expect } from "vitest";
import type { BarData } from "@/lib/brokers/types";
import { MIN_WARMUP_BARS, type OpenPosition } from "../strategy-types";
import { pickTightestFavorableSl } from "../filters";
import {
  BREAKEVEN_FILTER_PARAMS,
  breakevenChecksIntrabar,
  computeBreakevenSlPrice,
  computeIntrabarBreakevenSlPrice,
  type BreakevenArmMode,
  type BreakevenFilterParams,
} from "./breakeven";

const TICK = 0.25;
const ENTRY = 20000;
const SL_TICKS = 80; // 1R = 20 points
const T0 = Date.parse("2025-01-02T14:30:00.000Z");
const MINUTE = 60_000;

function bar(high: number, low: number, close: number, minutesFromEntry = 0): BarData {
  return { timestamp: new Date(T0 + minutesFromEntry * MINUTE).toISOString(), open: close, high, low, close, volume: 100 };
}

function position(side: 0 | 1, barsSinceEntry: number, slTicks: number | null = SL_TICKS): OpenPosition {
  return {
    side,
    entryPrice: ENTRY,
    entryTimestamp: "2025-01-02T14:30:00.000Z",
    barsSinceEntry,
    entryFilledAt: "2025-01-02T14:30:00.000Z",
    size: 1,
    slTicks,
  };
}

const PARAMS: BreakevenFilterParams = {
  breakEvenFilterEnabled: true,
  breakEvenFilterArmMode: "r",
  breakEvenFilterAtR: 1,
  breakEvenFilterOffsetUnit: "ticks",
  breakEvenFilterOffsetTicks: 0,
  breakEvenFilterOffsetR: 0,
  breakEvenFilterArmMinutes: 120,
};

function slPrice(bars: BarData[], pos: OpenPosition, params: BreakevenFilterParams = PARAMS): number | null {
  return computeBreakevenSlPrice({ bars, barIndex: bars.length - 1, position: pos, tickSize: TICK, params });
}

describe("computeBreakevenSlPrice — the arming MFE starts after the fill", () => {
  it("ignores a long entry bar's high from before the fill", () => {
    const bars = [
      bar(ENTRY + 30, ENTRY - 1, ENTRY), // signal bar: ran +1.5R, then filled at its close
      bar(ENTRY + 5, ENTRY - 5, ENTRY + 2),
    ];
    expect(slPrice(bars, position(0, 1))).toBeNull();
  });

  it("ignores a short entry bar's low from before the fill", () => {
    const bars = [
      bar(ENTRY + 1, ENTRY - 30, ENTRY),
      bar(ENTRY + 5, ENTRY - 5, ENTRY - 2),
    ];
    expect(slPrice(bars, position(1, 1))).toBeNull();
  });

  it("does not arm on the entry bar itself", () => {
    expect(slPrice([bar(ENTRY + 30, ENTRY - 1, ENTRY)], position(0, 0))).toBeNull();
  });

  it("arms when a bar after the fill reaches the threshold — long", () => {
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 20, ENTRY - 1, ENTRY + 15)];
    expect(slPrice(bars, position(0, 1))).toBe(ENTRY);
  });

  it("arms when a bar after the fill reaches the threshold — short", () => {
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 1, ENTRY - 20, ENTRY - 15)];
    expect(slPrice(bars, position(1, 1))).toBe(ENTRY);
  });

  it("reads the arm threshold from breakEvenFilterAtR", () => {
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 12, ENTRY - 1, ENTRY + 10)];
    expect(slPrice(bars, position(0, 1))).toBeNull();
    expect(slPrice(bars, position(0, 1), { ...PARAMS, breakEvenFilterAtR: 0.5 })).toBe(ENTRY);
  });

  it("requests the offset lock even when it sits beyond the market — the caller refuses it", () => {
    // 80-tick stop, 105-tick offset: +1R is reached before entry+105.
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 21, ENTRY - 1, ENTRY + 15)];
    expect(slPrice(bars, position(0, 1), { ...PARAMS, breakEvenFilterOffsetTicks: 105 })).toBe(ENTRY + 26.25);
  });
});

describe("computeBreakevenSlPrice — r mode is today's filter", () => {
  it("a saved blob with no arm mode arms on R exactly as before", () => {
    const legacy = { breakEvenFilterEnabled: true, breakEvenFilterAtR: 1, breakEvenFilterOffsetTicks: 0 } as unknown as BreakevenFilterParams;
    const reached = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 20, ENTRY - 1, ENTRY + 15)];
    const short = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 19, ENTRY - 1, ENTRY + 15)];
    expect(slPrice(reached, position(0, 1), legacy)).toBe(ENTRY);
    expect(slPrice(short, position(0, 1), legacy)).toBeNull();
  });

  it("ignores the minutes: a trade in profit for hours does not arm short of R", () => {
    const bars = [bar(ENTRY, ENTRY, ENTRY), bar(ENTRY + 5, ENTRY + 1, ENTRY + 4, 300)];
    expect(slPrice(bars, position(0, 1), { ...PARAMS, breakEvenFilterArmMinutes: 1 })).toBeNull();
  });

  it("fails open on a null slTicks", () => {
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 40, ENTRY - 1, ENTRY + 30)];
    expect(slPrice(bars, position(0, 1, null))).toBeNull();
  });

  it("an arm mode off the list arms nothing", () => {
    const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 40, ENTRY - 1, ENTRY + 30, 500)];
    const bogus = { ...PARAMS, breakEvenFilterArmMode: "bars" } as unknown as BreakevenFilterParams;
    expect(slPrice(bars, position(0, 1), bogus)).toBeNull();
  });
});

const timed = (mode: BreakevenArmMode, minutes: number, offsetTicks = 0): BreakevenFilterParams => ({
  ...PARAMS,
  breakEvenFilterArmMode: mode,
  breakEvenFilterArmMinutes: minutes,
  breakEvenFilterOffsetTicks: offsetTicks,
});

/** 1m bars: the entry bar at minute 0, then one per minute closing at `closes[i]` (points from entry, signed for the side). */
function path(side: 0 | 1, closes: number[]): BarData[] {
  const dir = side === 0 ? 1 : -1;
  return [bar(ENTRY, ENTRY, ENTRY), ...closes.map((c, i) => {
    const close = ENTRY + dir * c;
    return bar(Math.max(close, ENTRY), Math.min(close, ENTRY), close, i + 1);
  })];
}

/** The SL request at each bar from 1 to the last, as the bar loop would ask it. */
function walk(bars: BarData[], side: 0 | 1, params: BreakevenFilterParams): (number | null)[] {
  return bars.slice(1).map((_, k) => slPrice(bars.slice(0, k + 2), position(side, k + 1), params));
}

const inProfit = (n: number) => Array.from({ length: n }, () => 2);

describe.each([0, 1] as const)("timeOpen — side %i", (side) => {
  it("does not arm before N minutes and arms at N on an in-profit close", () => {
    const got = walk(path(side, inProfit(60)), side, timed("timeOpen", 60));
    expect(got.slice(0, 59).every((p) => p == null)).toBe(true);
    expect(got[59]).toBe(ENTRY);
  });

  it("does not arm at N on a losing close, then arms on the next in-profit close", () => {
    const closes = [...inProfit(59), -1, -0.5, 1];
    const got = walk(path(side, closes), side, timed("timeOpen", 60));
    expect(got[59]).toBeNull();
    expect(got[60]).toBeNull();
    expect(got[61]).toBe(ENTRY);
  });

  it("a close exactly at entry is not in profit", () => {
    const got = walk(path(side, [...inProfit(59), 0]), side, timed("timeOpen", 60));
    expect(got[59]).toBeNull();
  });

  it("losing closes earlier in the trade do not matter", () => {
    const closes = [-5, -5, ...inProfit(58)];
    expect(walk(path(side, closes), side, timed("timeOpen", 60))[59]).toBe(ENTRY);
  });

  it("ignores the R threshold, and arms with no slTicks", () => {
    const bars = path(side, inProfit(60));
    expect(slPrice(bars, position(side, 60), { ...timed("timeOpen", 60), breakEvenFilterAtR: 100 })).toBe(ENTRY);
    expect(slPrice(bars, position(side, 60, null), timed("timeOpen", 60))).toBe(ENTRY);
  });
});

describe.each([0, 1] as const)("timeInProfit — side %i", (side) => {
  it("arms once every close for N minutes was in profit, not before", () => {
    const got = walk(path(side, inProfit(60)), side, timed("timeInProfit", 60));
    expect(got.slice(0, 59).every((p) => p == null)).toBe(true);
    expect(got[59]).toBe(ENTRY);
  });

  it("a close at entry restarts the clock from that close", () => {
    const closes = [...inProfit(9), 0, ...inProfit(70)]; // minute 10 closes at entry
    const got = walk(path(side, closes), side, timed("timeInProfit", 60));
    expect(got[59]).toBeNull(); // minute 60: timeOpen would arm here
    expect(got[68]).toBeNull(); // minute 69
    expect(got[69]).toBe(ENTRY); // minute 70 = 60 minutes after minute 10's close
  });

  it("a close through entry restarts the clock too", () => {
    const closes = [...inProfit(29), -3, ...inProfit(70)]; // minute 30 closes at a loss
    const got = walk(path(side, closes), side, timed("timeInProfit", 60));
    expect(got[88]).toBeNull();
    expect(got[89]).toBe(ENTRY);
  });

  it("measures minutes from timestamps, so 5m bars arm at the same clock time", () => {
    const dir = side === 0 ? 1 : -1;
    const bars = [bar(ENTRY, ENTRY, ENTRY), ...Array.from({ length: 12 }, (_, i) => {
      const close = ENTRY + dir * 2;
      return bar(Math.max(close, ENTRY), Math.min(close, ENTRY), close, (i + 1) * 5);
    })];
    const got = walk(bars, side, timed("timeInProfit", 60));
    expect(got[10]).toBeNull(); // 55 minutes
    expect(got[11]).toBe(ENTRY); // 60 minutes
  });
});

describe("time modes — the entry bar and the offset", () => {
  it("does not arm on the entry bar itself", () => {
    const bars = [bar(ENTRY + 30, ENTRY - 1, ENTRY + 5)];
    expect(slPrice(bars, position(0, 0), timed("timeOpen", 1))).toBeNull();
    expect(slPrice(bars, position(0, 0), timed("timeInProfit", 1))).toBeNull();
  });

  it("starts the clock at the entry bar, not at earlier history", () => {
    const bars = [
      bar(ENTRY + 3, ENTRY + 1, ENTRY + 2, -120), // pre-entry history, two hours back
      bar(ENTRY, ENTRY, ENTRY, 0), // the entry bar
      bar(ENTRY + 3, ENTRY + 1, ENTRY + 2, 30),
    ];
    for (const mode of ["timeOpen", "timeInProfit"] as const) {
      expect(slPrice(bars, position(0, 1), timed(mode, 60))).toBeNull();
      expect(slPrice(bars, position(0, 1), timed(mode, 30))).toBe(ENTRY);
    }
  });

  describe("the engine's window, once the entry bar has scrolled out", () => {
    // Bars at minutes 31..330, all closing in profit; the true count from the entry bar is 330.
    const held = 330;
    const window = path(0, inProfit(held)).slice(-MIN_WARMUP_BARS);
    const engine = position(0, held);

    it("the time modes start the clock at the oldest bar held and arm", () => {
      expect(window.length - 1 - held).toBeLessThan(0);
      for (const mode of ["timeOpen", "timeInProfit"] as const) {
        expect(slPrice(window, engine, timed(mode, 240))).toBe(ENTRY);
      }
    });

    it("arms late, never early: the oldest bar is 299 minutes back, not 330", () => {
      for (const mode of ["timeOpen", "timeInProfit"] as const) {
        expect(slPrice(window, engine, timed(mode, 299))).toBe(ENTRY);
        expect(slPrice(window, engine, timed(mode, 300))).toBeNull();
      }
    });

    it("timeInProfit still restarts at a losing close inside the window", () => {
      const closes = inProfit(held);
      closes[200] = -1; // minute 201
      const bars = path(0, closes).slice(-MIN_WARMUP_BARS);
      expect(slPrice(bars, engine, timed("timeInProfit", 129))).toBe(ENTRY); // 330 − 201
      expect(slPrice(bars, engine, timed("timeInProfit", 130))).toBeNull();
    });

    it("r mode is unchanged: no entry bar in the window, no MFE", () => {
      const bars = [...window.slice(0, -1), bar(ENTRY + 40, ENTRY + 1, ENTRY + 30, held)];
      expect(slPrice(bars, engine)).toBeNull();
    });
  });

  it("the arm minutes are bounded 1 to 240 in the schema", () => {
    expect(BREAKEVEN_FILTER_PARAMS.breakEvenFilterArmMinutes).toMatchObject({ type: "integer", min: 1, max: 240 });
  });

  it("the offset locks profit on both sides", () => {
    const params = timed("timeOpen", 60, 5);
    expect(walk(path(0, inProfit(60)), 0, params)[59]).toBe(ENTRY + 1.25);
    expect(walk(path(1, inProfit(60)), 1, params)[59]).toBe(ENTRY - 1.25);
  });
});

describe("the offset in R", () => {
  const inR = (offsetR: number, mode: BreakevenArmMode = "timeOpen"): BreakevenFilterParams =>
    ({ ...timed(mode, 60), breakEvenFilterOffsetUnit: "r", breakEvenFilterOffsetR: offsetR });
  const armed = (side: 0 | 1, slTicks: number | null, params: BreakevenFilterParams) =>
    slPrice(path(side, inProfit(60)), position(side, 60, slTicks), params);

  it("the tick unit is unchanged: a blob with no unit reads ticks, and the R value is ignored", () => {
    const { breakEvenFilterOffsetUnit: _u, breakEvenFilterOffsetR: _r, ...legacy } = timed("timeOpen", 60, 5);
    expect(armed(0, SL_TICKS, legacy as BreakevenFilterParams)).toBe(ENTRY + 1.25);
    expect(armed(1, SL_TICKS, { ...timed("timeOpen", 60, 5), breakEvenFilterOffsetR: 0.5 })).toBe(ENTRY - 1.25);
  });

  // 81-tick stop: ±0.25R is 20.25 ticks and ±0.5R is 40.5, so every case rounds a fraction of a tick away from the market.
  it.each([
    [0, 0.25, ENTRY + 5], [0, 0.5, ENTRY + 10], [0, -0.25, ENTRY - 5.25], [0, -0.5, ENTRY - 10.25],
    [1, 0.25, ENTRY - 5], [1, 0.5, ENTRY - 10], [1, -0.25, ENTRY + 5.25], [1, -0.5, ENTRY + 10.25],
  ] as const)("side %i at %sR moves the stop to %s", (side, offsetR, want) => {
    expect(armed(side, 81, inR(offsetR))).toBe(want);
  });

  it("is exact on an 80-tick stop and on a 0.1 tick grid", () => {
    expect(armed(0, SL_TICKS, inR(-0.25))).toBe(ENTRY - 5);
    expect(armed(1, SL_TICKS, inR(0.5))).toBe(ENTRY - 10);
    const mgc = { ...position(0, 1, 30), entryPrice: 2650.7 };
    const bars = [bar(2650.7, 2650.7, 2650.7), bar(2651, 2650.8, 2650.9, 60)];
    const at = (offsetR: number) => computeBreakevenSlPrice({ bars, barIndex: 1, position: mgc, tickSize: 0.1, params: inR(offsetR) });
    expect([at(0), at(0.5), at(-0.5)]).toEqual([2650.7, 2652.2, 2649.2]);
  });

  // A float `floor(2650.7 / 0.1)` is 26506, a tick under entry; the tick unit
  // aligns in fixed point too, so an on-grid target is its own price.
  it("the tick unit is exact on a 0.1 tick grid, both sides", () => {
    const bars = [bar(2650.7, 2650.7, 2650.7), bar(2651, 2650.8, 2650.9, 60)];
    const at = (side: 0 | 1, offsetTicks: number) => computeBreakevenSlPrice({
      bars, barIndex: 1, position: { ...position(side, 1, 30), entryPrice: 2650.7 }, tickSize: 0.1,
      params: { ...timed("timeOpen", 1), breakEvenFilterOffsetTicks: offsetTicks },
    });
    expect([at(0, 0), at(0, 3), at(0, -5)]).toEqual([2650.7, 2651, 2650.2]);
    const shortBars = [bar(2650.7, 2650.7, 2650.7), bar(2650.6, 2650.4, 2650.5, 60)];
    const atShort = (offsetTicks: number) => computeBreakevenSlPrice({
      bars: shortBars, barIndex: 1, position: { ...position(1, 1, 30), entryPrice: 2650.7 }, tickSize: 0.1,
      params: { ...timed("timeOpen", 1), breakEvenFilterOffsetTicks: offsetTicks },
    });
    expect([atShort(0), atShort(3), atShort(-5)]).toEqual([2650.7, 2650.4, 2651.2]);
  });

  it("works in every arm mode", () => {
    const rBars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 21, ENTRY - 1, ENTRY + 15)];
    expect(slPrice(rBars, position(0, 1, 81), inR(0.25, "r"))).toBe(ENTRY + 5);
    expect(armed(0, 81, inR(0.25, "timeInProfit"))).toBe(ENTRY + 5);
  });

  it("fails open on a null or zero slTicks in every arm mode", () => {
    const rBars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 40, ENTRY - 1, ENTRY + 30, 60)];
    for (const mode of ["r", "timeOpen", "timeInProfit"] as const) {
      expect(slPrice(rBars, position(0, 1), inR(-0.5, mode))).toBe(ENTRY - 10); // the same bars arm with a stop
      for (const slTicks of [null, 0]) {
        expect(slPrice(rBars, position(0, 1, slTicks), inR(-0.5, mode))).toBeNull();
        expect(slPrice(rBars, position(0, 1, slTicks), inR(0.25, mode))).toBeNull();
      }
    }
  });

  it("a unit off the list moves nothing", () => {
    const bogus = { ...inR(0.25), breakEvenFilterOffsetUnit: "points" } as unknown as BreakevenFilterParams;
    expect(armed(0, 81, bogus)).toBeNull();
  });

  it("a negative-offset candidate never loosens a stop already tighter", () => {
    const long = armed(0, SL_TICKS, inR(-0.5)); // ENTRY − 10
    const short = armed(1, SL_TICKS, inR(-0.5)); // ENTRY + 10
    if (long == null || short == null) throw new Error("the R offset did not arm");
    expect(pickTightestFavorableSl(0, ENTRY - 20, [long])).toBe(ENTRY - 10); // from −1R it tightens
    expect(pickTightestFavorableSl(0, ENTRY - 2, [long])).toBeNull();
    expect(pickTightestFavorableSl(0, ENTRY - 10, [long])).toBeNull(); // already there: the latch
    expect(pickTightestFavorableSl(1, ENTRY + 20, [short])).toBe(ENTRY + 10);
    expect(pickTightestFavorableSl(1, ENTRY + 2, [short])).toBeNull();
    // A 1-tick stop at −0.9R rounds to the entry stop itself, which is not tighter.
    const oneTick = armed(0, 1, inR(-0.9));
    expect(oneTick).toBe(ENTRY - TICK);
    expect(pickTightestFavorableSl(0, ENTRY - TICK, [oneTick ?? NaN])).toBeNull();
  });

  it("the R offset is bounded −0.9 to 1 in steps of 0.05, default 0 in ticks", () => {
    expect(BREAKEVEN_FILTER_PARAMS.breakEvenFilterOffsetR).toMatchObject({ type: "number", default: 0, min: -0.9, max: 1, step: 0.05 });
    expect(BREAKEVEN_FILTER_PARAMS.breakEvenFilterOffsetUnit.default).toBe("ticks");
  });
});

describe("when break-even is checked: bar close or intrabar", () => {
  const INTRABAR: BreakevenFilterParams = { ...PARAMS, breakEvenFilterCheck: "intrabar" };
  // The bar after the entry bar, still forming: its range so far is the forming bar.
  const bars = [bar(ENTRY + 1, ENTRY - 1, ENTRY), bar(ENTRY + 25, ENTRY - 25, ENTRY)];
  const intrabar = (formingBar: { high: number; low: number }, side: 0 | 1 = 0, params = INTRABAR) =>
    computeIntrabarBreakevenSlPrice({ bars, barIndex: 1, position: position(side, 1), tickSize: TICK, params, formingBar });

  it("defaults to bar close, shown only for the R arm", () => {
    expect(BREAKEVEN_FILTER_PARAMS.breakEvenFilterCheck).toMatchObject({
      type: "select",
      default: "barClose",
      visibleWhen: { key: "breakEvenFilterArmMode", value: "r" },
    });
    const schema = BREAKEVEN_FILTER_PARAMS.breakEvenFilterCheck;
    expect(schema.type === "select" ? schema.options.map((o) => o.value) : null).toEqual(["barClose", "intrabar"]);
  });

  it("checks intrabar only with the filter on, the R arm and the intrabar setting", () => {
    expect(breakevenChecksIntrabar(INTRABAR)).toBe(true);
    expect(breakevenChecksIntrabar(PARAMS)).toBe(false); // a blob with no key is bar close
    expect(breakevenChecksIntrabar({ ...INTRABAR, breakEvenFilterCheck: "barClose" })).toBe(false);
    expect(breakevenChecksIntrabar({ ...INTRABAR, breakEvenFilterEnabled: false })).toBe(false);
    for (const mode of ["timeOpen", "timeInProfit"] as const) {
      expect(breakevenChecksIntrabar({ ...INTRABAR, breakEvenFilterArmMode: mode })).toBe(false);
    }
  });

  it("reads 'the filter is on' as bar close does: a sweep's 1 is on, 0 is off", () => {
    // `--sweep breakEvenFilterEnabled=0:1:1` writes numbers, not booleans.
    const asSwept = (value: number) => ({ ...INTRABAR, breakEvenFilterEnabled: value as unknown as boolean });
    const armedBars = [bar(ENTRY, ENTRY, ENTRY), bar(ENTRY + 25, ENTRY - 1, ENTRY + 20, 5)];
    for (const value of [0, 1]) {
      const params = asSwept(value);
      const barClose = computeBreakevenSlPrice({ bars: armedBars, barIndex: 1, position: position(0, 1), tickSize: TICK, params });
      expect(breakevenChecksIntrabar(params)).toBe(barClose != null);
    }
    expect(breakevenChecksIntrabar(asSwept(1))).toBe(true);
  });

  it("arms on the range so far, not the finished bar's", () => {
    expect(intrabar({ high: ENTRY + 19.75, low: ENTRY - 1 })).toBeNull();
    expect(intrabar({ high: ENTRY + 20, low: ENTRY - 1 })).toBe(ENTRY);
    expect(intrabar({ high: ENTRY + 1, low: ENTRY - 20 }, 1)).toBe(ENTRY);
  });

  it("asks for the price bar close would, offset included", () => {
    const params = { ...INTRABAR, breakEvenFilterOffsetUnit: "r", breakEvenFilterOffsetR: 0.25 } as const;
    expect(intrabar({ high: ENTRY + 25, low: ENTRY - 1 }, 0, params)).toBe(
      computeBreakevenSlPrice({ bars, barIndex: 1, position: position(0, 1), tickSize: TICK, params }),
    );
  });

  it("asks nothing in a time mode or at bar close", () => {
    expect(intrabar({ high: ENTRY + 25, low: ENTRY - 1 }, 0, PARAMS)).toBeNull();
    expect(intrabar({ high: ENTRY + 25, low: ENTRY - 1 }, 0, { ...INTRABAR, breakEvenFilterArmMode: "timeOpen" })).toBeNull();
  });
});
