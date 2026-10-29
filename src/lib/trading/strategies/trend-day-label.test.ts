import { describe, expect, it } from "vitest";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { addCalendarDays } from "@/lib/trading/regime/session-dates";
import {
  TREND_DAY_CONSTANTS,
  TREND_DAY_DEFAULTS,
  buildReferenceDays,
  labelPreOpen,
  labelTrendDaySession,
  refRangeTicks,
  trendDayLabelAt,
  type ReferenceDay,
  type TrendDayParams,
  type TrendDaySession,
} from "./trend-day-label";

const DS = CONTRACT_SPECS.MNQ.daySession;
const TICK = CONTRACT_SPECS.MNQ.tickSize;
const DAY = "2025-01-15";

/** January 2025: ET is UTC−5. `minute` is ET minutes since midnight of `day` (negative reaches the prior evening). */
function stamp(day: number, minute: number): string {
  return new Date(Date.UTC(2025, 0, day, 5, 0) + minute * 60_000).toISOString();
}
const slotMinute = (slot: number) => 570 + 5 * (slot - 1);

function bar(slot: number, close: number, high = close, low = close, volume = 1, day = 15): BarData {
  return { timestamp: stamp(day, slotMinute(slot)), open: close, high, low, close, volume };
}

/** `h = l = c`, volume 1: VWAP is the running mean of the closes, exact when the mean is. `null` is a missing slot. */
function flat(closes: (number | null)[], from = 1): BarData[] {
  return closes.flatMap((c, i) => (c == null ? [] : [bar(from + i, c)]));
}

/** Close on the high, low four points under: each close sits above its own typical price. */
function wick(closes: (number | null)[], from = 1): BarData[] {
  return closes.flatMap((c, i) => (c == null ? [] : [bar(from + i, c, c, c - 4)]));
}

/** The flat green day: closes 100…106 over slots 1–7, OR 100–105, VWAP 103 at slot 7, range 24 ticks. */
const FLAT_GREEN = [100, 101, 102, 103, 104, 105, 106];
const FLAT_REF = 48;

function label(bars: BarData[], ref: number | null = FLAT_REF, over: Partial<TrendDayParams> = {}): TrendDaySession {
  return labelTrendDaySession(bars, ref, DS, TICK, { ...TREND_DAY_DEFAULTS, ...over });
}
const states = (s: TrendDaySession) => s.steps.map((x) => x.state);

/** Reflect every price about 200: the red mirror of a green fixture. */
function mirror(bars: BarData[]): BarData[] {
  return bars.map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
}

function refDays(n: number, before: string, rthRange: number, close = 100): ReferenceDay[] {
  const out: ReferenceDay[] = [];
  for (let i = n; i >= 1; i--) {
    out.push({
      sessionDate: addCalendarDays(before, -i),
      daySessionHigh: close,
      daySessionLow: close - rthRange * TICK,
      daySessionClose: close,
      rthTR: rthRange,
      rthRange,
      full: true,
    });
  }
  return out;
}

describe("TREND_DAY_CONSTANTS", () => {
  it("states decision 5's default and range for every constant", () => {
    const table = Object.fromEntries(
      Object.entries(TREND_DAY_CONSTANTS).map(([k, c]) => [k, [c.value, c.range]]),
    );
    expect(table).toEqual({
      orBars: [6, { kind: "range", min: 3, max: 12 }],
      holdBars: [6, { kind: "range", min: 3, max: 12 }],
      closePosMin: [0.75, { kind: "range", min: 0.6, max: 0.95 }],
      rangeMult: [0.5, { kind: "range", min: 0.25, max: 1 }],
      refRangeDays: [17, { kind: "range", min: 10, max: 60 }],
      revokeBars: [1, { kind: "range", min: 1, max: 3 }],
      gapMult: [0.3, { kind: "range", min: 0.1, max: 1 }],
      onPosMin: [0.75, { kind: "range", min: 0.6, max: 0.95 }],
      onMinBarsShare: [0.8, { kind: "range", min: 0.5, max: 1 }],
    });
    for (const k of Object.keys(TREND_DAY_CONSTANTS) as (keyof TrendDayParams)[]) {
      expect(TREND_DAY_DEFAULTS[k]).toBe(TREND_DAY_CONSTANTS[k].value);
    }
  });
});

describe("labelTrendDaySession — green and its mirror", () => {
  it("labels green first at the 10:05 ET close (bar 7) at defaults, neither on bars 1–6", () => {
    const s = label(flat(FLAT_GREEN));
    expect(states(s)).toEqual(["neither", "neither", "neither", "neither", "neither", "neither", "green"]);
    expect(s.first).toEqual({ label: "green", slot: 7, closeTs: "2025-01-15T15:05:00.000Z" });
    expect(s.final).toBe("green");
    expect(s.structural).toBeNull();
  });

  it("labels red as the exact mirror, bar for bar", () => {
    const up = flat([...FLAT_GREEN, 107, 103.25, 103, 108]);
    const down = label(mirror(up));
    expect(states(down)).toEqual(states(label(up)).map((x) => (x === "green" ? "red" : x)));
    expect(down.first).toMatchObject({ label: "red", slot: 7 });
  });

  it("first possible label is bar max(orBars + 1, holdBars)", () => {
    const trend = wick([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
    expect(label(trend, 40).first?.slot).toBe(7);
    expect(label(trend, 40, { orBars: 3, holdBars: 3 }).first?.slot).toBe(4);
    expect(label(trend, 40, { orBars: 3, holdBars: 8 }).first?.slot).toBe(8);
  });
});

describe("labelTrendDaySession — each green condition", () => {
  it("a close exactly on ORHigh is not a break; a tick above is", () => {
    // OR 96–101 (wick bars); bar 7 closes on 101, range 20 ticks against a ref of 40.
    const or = wick([100, 101, 100, 101, 100, 101]);
    expect(label([...or, bar(7, 101, 101, 97)], 40).first).toBeNull();
    expect(label([...or, bar(7, 101.25, 101.25, 97)], 40).first?.slot).toBe(7);
  });

  it("close position: exactly closePosMin of the range labels, a tick under does not, and the param moves it", () => {
    // OR 96–101; bar 7 high 112 → range 64 ticks, 0.75 × 64 = 48 ticks above 96 is 108.
    const or = wick([100, 101, 100, 101, 100, 101]);
    expect(label([...or, bar(7, 108, 112, 104)], 128).first?.slot).toBe(7);
    expect(label([...or, bar(7, 107.75, 112, 104)], 128).first).toBeNull();
    expect(label([...or, bar(7, 107.75, 112, 104)], 128, { closePosMin: 0.6 }).first?.slot).toBe(7);
  });

  it("range: exactly rangeMult × refRange labels, above it does not, and the param moves it", () => {
    // Flat green: range 24 ticks at bar 7.
    expect(label(flat(FLAT_GREEN), 48).first?.slot).toBe(7);
    expect(label(flat(FLAT_GREEN), 49).first).toBeNull();
    expect(label(flat(FLAT_GREEN), 49, { rangeMult: 0.25 }).first?.slot).toBe(7);
  });

  it("VWAP hold: a close exactly on VWAP inside the run is not a hold", () => {
    // Flat bar 1 closes on its own VWAP; holdBars 7 puts it in the run.
    expect(label(flat([...FLAT_GREEN, 107]), FLAT_REF, { holdBars: 7 }).first?.slot).toBe(8);
    const aboveFirst = [bar(1, 100, 100, 96), ...flat(FLAT_GREEN.slice(1), 2)];
    expect(label(aboveFirst, FLAT_REF, { holdBars: 7 }).first?.slot).toBe(7);
  });

  it("VWAP hold: one close under VWAP delays the label until holdBars clean closes follow", () => {
    const dip = [bar(1, 100, 100, 96), bar(2, 97, 101, 97), ...wick([100, 101, 100, 101, 106, 107, 108], 3)];
    expect(label(dip, 40).first?.slot).toBe(8);
  });
});

describe("labelTrendDaySession — the update rule", () => {
  it("keeps the colour while closes hold VWAP, even back inside the OR and low in the range", () => {
    // VWAP 103 at bar 7; bar 8 closes 104: inside the OR (≤ 105), 4/6 of the range, above VWAP.
    expect(states(label(flat([...FLAT_GREEN, 104]))).at(-1)).toBe("green");
  });

  it("revokes on a close exactly on VWAP, keeps it a tick above", () => {
    // Mean of 100…106 is 103; a close of 103 leaves the mean at 103 exactly.
    const revoked = label(flat([...FLAT_GREEN, 103]));
    expect(revoked.steps.at(-1)).toMatchObject({ state: "neither", event: "revoke" });
    expect(label(flat([...FLAT_GREEN, 103.25])).final).toBe("green");
  });

  it("revokeBars counts consecutive closes through VWAP", () => {
    const s = label(flat([...FLAT_GREEN, 103, 103]), FLAT_REF, { revokeBars: 2 });
    expect(states(s).slice(6)).toEqual(["green", "green", "neither"]);
  });

  it("relabels the same colour only by passing the full condition again", () => {
    const s = label(flat([...FLAT_GREEN, 103, 107, 108, 109, 110, 111, 112]));
    expect(states(s).slice(6)).toEqual([
      "green", "neither", "neither", "neither", "neither", "neither", "neither", "green",
    ]);
    expect(s.steps.filter((x) => x.event === "label").map((x) => x.slot)).toEqual([7, 14]);
    expect(s.first?.label).toBe("green");
  });

  it("relabels the opposite colour only through neither", () => {
    const s = label(flat([...FLAT_GREEN, 90, 89, 88, 87, 86, 85]));
    expect(states(s).slice(6)).toEqual(["green", "neither", "neither", "neither", "neither", "neither", "red"]);
    expect(s.first?.label).toBe("green");
    expect(s.final).toBe("red");
  });

  it("never steps green → red on one close, even when the revoking close also meets red (holdBars = revokeBars = 3)", () => {
    const params = { holdBars: 3, revokeBars: 3 };
    const s = label(flat([...FLAT_GREEN, 90, 89, 88, 87]), FLAT_REF, params);
    expect(s.steps.slice(6).map((x) => [x.state, x.event])).toEqual([
      ["green", "label"],
      ["green", null],
      ["green", null],
      ["neither", "revoke"],
      ["red", "label"],
    ]);
  });

  it("never steps directly between green and red across a random walk", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let day = 0; day < 200; day++) {
      let p = 100;
      const bars: BarData[] = [];
      for (let slot = 1; slot <= 78; slot++) {
        p += Math.round((rand() - 0.5) * 12) * TICK;
        bars.push(bar(slot, p, p + Math.round(rand() * 8) * TICK, p - Math.round(rand() * 8) * TICK, 1 + Math.round(rand() * 9)));
      }
      const st = states(label(bars, 40, { holdBars: 3, revokeBars: 3 }));
      for (let i = 1; i < st.length; i++) {
        expect(st[i - 1] !== "neither" && st[i] !== "neither" && st[i - 1] !== st[i]).toBe(false);
      }
    }
  });
});

describe("labelTrendDaySession — edge cases", () => {
  it("a missing bar inside the OR leaves the day neither throughout", () => {
    const s = label(wick([100, 110, null, 130, 140, 150, 160, 170, 180]), 40);
    expect(s.structural).toBe("or-undefined");
    expect(new Set(states(s))).toEqual(new Set(["neither"]));
    expect(s.first).toBeNull();
  });

  it("an OR still forming is not undefined", () => {
    expect(label(wick([100, 110, 120]), 40).structural).toBeNull();
  });

  it("a missing bar resets the VWAP run", () => {
    const params = { orBars: 3, holdBars: 6 };
    expect(label(wick([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]), 40, params).first?.slot).toBe(6);
    expect(label(wick([100, 110, 120, 130, null, 150, 160, 170, 180, 190, 200]), 40, params).first?.slot).toBe(11);
  });

  it("a missing bar resets the revoke run", () => {
    const params = { revokeBars: 2 };
    // Bar 8 sits on VWAP (103); bar 9 is missing; bar 10 (100) is under VWAP but restarts the run.
    const gapped = label(flat([...FLAT_GREEN, 103, null, 100, 99]), FLAT_REF, params);
    expect(gapped.steps.map((x) => [x.slot, x.state]).slice(6)).toEqual([
      [7, "green"], [8, "green"], [10, "green"], [11, "neither"],
    ]);
    expect(states(label(flat([...FLAT_GREEN, 103, 103]), FLAT_REF, params)).at(-1)).toBe("neither");
  });

  it("a short reference window is neither throughout", () => {
    const s = label(flat(FLAT_GREEN), null);
    expect(s.structural).toBe("ref-short");
    expect(s.final).toBe("neither");
    expect(s.first).toBeNull();
  });

  it("an early close reads final at its last bar (the 13:00 close)", () => {
    const closes = Array.from({ length: 42 }, (_, i) => 100 + i);
    const s = label(flat(closes), FLAT_REF);
    expect(s.steps).toHaveLength(42);
    expect(s.steps.at(-1)?.closeTs).toBe("2025-01-15T18:00:00.000Z");
    expect(s.final).toBe("green");
  });

  it("refuses bars off the 5m grid rather than labelling a 1m series", () => {
    const oneMinute = { ...bar(1, 100), timestamp: stamp(15, 571) };
    expect(() => label([oneMinute])).toThrow(/5m grid/);
  });
});

describe("refRangeTicks and buildReferenceDays", () => {
  it("takes the median of the last refRangeDays full days strictly before the session", () => {
    const days = refDays(25, DAY, 80);
    days[24] = { ...days[24], rthRange: 400 };
    days[23] = { ...days[23], rthRange: 400 };
    expect(refRangeTicks(days, DAY, 3)).toBe(400);
    expect(refRangeTicks(days, DAY, 20)).toBe(80);
    const withToday = [...days, { ...days[0], sessionDate: DAY, rthRange: 4000 }];
    expect(refRangeTicks(withToday, DAY, 3)).toBe(400);
  });

  it("skips early closes and reaches back until the window is full; short is null", () => {
    const days = refDays(21, DAY, 80);
    days[20] = { ...days[20], rthRange: 10, full: false };
    expect(refRangeTicks(days, DAY, 20)).toBe(80);
    expect(refRangeTicks(days.slice(1), DAY, 20)).toBeNull();
  });

  it("marks a session whose last cash bar is before 15:55 ET as not full", () => {
    const full = flat(Array.from({ length: 78 }, () => 100));
    const early = flat(Array.from({ length: 42 }, () => 100)).map((b) => ({
      ...b,
      timestamp: new Date(Date.parse(b.timestamp) + 86_400_000).toISOString(),
    }));
    const rows = buildReferenceDays([...full, ...early], DS, TICK);
    expect(rows.map((r) => [r.sessionDate, r.full])).toEqual([["2025-01-15", true], ["2025-01-16", false]]);
  });
});

describe("trendDayLabelAt", () => {
  const reference = refDays(TREND_DAY_DEFAULTS.refRangeDays, DAY, FLAT_REF);
  const night = [
    { timestamp: stamp(15, 9 * 60), open: 50, high: 500, low: 1, close: 50, volume: 1_000 },
  ];
  const day = flat([...FLAT_GREEN, 107, 103, 90, 89, 88, 87, 86, 85]);
  const at = (bars: BarData[], index: number, refs = reference) =>
    trendDayLabelAt({ bars, index, referenceDays: refs, daySession: DS, tickSize: TICK });

  it("answers from the session's cash bars only — overnight bars move neither the OR nor VWAP", () => {
    const bars = [...night, ...day];
    expect(at(bars, 0)).toBeNull();
    expect(at(bars, 7)).toMatchObject({ label: "green", first: { slot: 7 } });
  });

  it("gives the same answer with or without later bars, at every index", () => {
    const bars = [...night, ...day];
    const later = [...bars, ...flat([200, 10, 300], 16)];
    const scrambled = [...bars.slice(0, 4), ...bars.slice(4).map((b) => ({ ...b, close: b.close + 50 }))];
    for (let i = 0; i < bars.length; i++) {
      const now = at(bars.slice(0, i + 1), i);
      expect(at(bars, i)).toEqual(now);
      expect(at(later, i)).toEqual(now);
      if (i < 4) expect(at(scrambled, i)).toEqual(now);
    }
  });

  it("ignores reference rows on or after today's session", () => {
    const poisoned = [...reference, ...refDays(1, addCalendarDays(DAY, 1), 10_000).map((r) => ({ ...r, sessionDate: DAY }))];
    expect(at(day, 6)).toEqual(at(day, 6, poisoned));
  });

  it("is neither with structural ref-short when fewer than refRangeDays full days precede it", () => {
    expect(at(day, 6, reference.slice(1))).toMatchObject({ label: "neither", structural: "ref-short" });
  });
});

describe("labelPreOpen", () => {
  const NIGHT_FROM = -6 * 60; // 18:00 ET the prior evening
  /** The 186 overnight 5m bars, closes rising one tick a bar from 100, the 09:25 bar closing on `onClose`. */
  function night(onClose: number, skip: (i: number) => boolean = () => false): BarData[] {
    const out: BarData[] = [];
    for (let i = 0; i < 186; i++) {
      if (skip(i)) continue;
      const c = i === 185 ? onClose : 100 + i * TICK;
      out.push({ timestamp: stamp(15, NIGHT_FROM + 5 * i), open: c, high: c, low: c, close: c, volume: 1 });
    }
    return out;
  }
  // onHigh/onLow span 100 … 146 before the last bar; prior close 100; refRange 80 ticks → gap needs 24 ticks (6 pts).
  const reference = refDays(TREND_DAY_DEFAULTS.refRangeDays, DAY, 80, 100);
  const pre = (bars: BarData[], over: Partial<TrendDayParams> = {}, refs = reference) =>
    labelPreOpen({ bars, sessionDate: DAY, referenceDays: refs, daySession: DS, tickSize: TICK, params: { ...TREND_DAY_DEFAULTS, ...over } });

  it("labels green-pre when the night gaps up and the 09:25 close sits high in the overnight range", () => {
    expect(pre(night(146.5))).toEqual({ label: "green", structural: null, barsPresent: 186, expectedBars: 186 });
  });

  it("labels red-pre as the mirror", () => {
    const down = night(146.5).map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    expect(pre(down, {}, refDays(20, DAY, 80, 100)).label).toBe("red");
  });

  it("the gap test is ≥ gapMult × refRange, and the param moves it", () => {
    // Range 100 … 146; a close of 106 is 24 ticks up — exactly 0.3 × 80 — and low in the range.
    expect(pre(night(106), { onPosMin: 0.6 }).label).toBe("neither");
    const lowNight = night(106).map((b, i) => (i < 185 ? { ...b, high: 106, low: 100, close: 100 + (i % 2) } : b));
    expect(pre(lowNight).label).toBe("green");
    expect(pre(lowNight, { gapMult: 0.31 }).label).toBe("neither");
  });

  it("is neither on a short night: below onMinBarsShare × 186 bars present", () => {
    // 0.8 × 186 = 148.8: 149 bars pass, 148 do not.
    expect(pre(night(146.5, (i) => i < 37)).label).toBe("green");
    expect(pre(night(146.5, (i) => i < 38))).toMatchObject({ label: "neither", structural: "overnight-short", barsPresent: 148 });
    expect(pre(night(146.5, (i) => i < 38), { onMinBarsShare: 0.5 }).label).toBe("green");
  });

  it("is neither when the 09:25 bar is absent", () => {
    expect(pre(night(146.5, (i) => i === 185)).structural).toBe("no-open-bar");
  });

  it("is neither when the prior session row is more than 7 calendar days old", () => {
    const stale = refDays(20, addCalendarDays(DAY, -7), 80, 100);
    expect(pre(night(146.5), {}, stale).structural).toBe("no-prior-session");
    const sevenDays = refDays(20, addCalendarDays(DAY, -6), 80, 100);
    expect(pre(night(146.5), {}, sevenDays).label).toBe("green");
  });

  it("is neither with a short reference window", () => {
    expect(pre(night(146.5), {}, reference.slice(1)).structural).toBe("ref-short");
  });

  it("reads nothing at or after the cash open", () => {
    const after = [...night(146.5), ...flat([10, 10, 10]), { ...flat([10])[0], timestamp: stamp(16, NIGHT_FROM) }];
    expect(pre(after)).toEqual(pre(night(146.5)));
  });
});
