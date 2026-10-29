import { describe, it, expect } from "vitest";

import type { BarData } from "@/lib/brokers/types";
import {
  daySessionMinutes,
  etDateKey,
  isInDaySession,
  markFixedSeries,
  memoiseByUtcMinute,
  minutesInTradingTz,
  priorDaySessionProfiles,
  priorDaySessionStats,
  priorRthSessionRangeAtr,
  VALUE_AREA_FRACTION,
} from "./session-utils";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { TRADING_TIMEZONE } from "../strategy-types";

/** Deliberately not the module's own formatter: the point is that the cache
 *  answers what an uncached format would have. */
const freshFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRADING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const INSTANTS = [
  // Spring forward: 01:59 EST, then 03:00 EDT the same minute-pair.
  "2024-03-10T06:59:00Z",
  "2024-03-10T07:00:00Z",
  // Fall back: 01:00 EDT and 01:00 EST — one wall clock, two instants.
  "2024-11-03T05:00:00Z",
  "2024-11-03T06:00:00Z",
  // Midnight ET, where the calendar date the key reports rolls over.
  "2024-06-14T03:59:00Z",
  "2024-06-14T04:00:00Z",
].map((iso) => new Date(iso));

describe("etDateKey", () => {
  it("matches a fresh formatter on the first call and on the cached second", () => {
    for (const instant of INSTANTS) {
      expect(etDateKey(instant)).toBe(freshFormatter.format(instant));
      expect(etDateKey(instant)).toBe(freshFormatter.format(instant));
    }
  });

  it("keys on the instant, not on the Date object", () => {
    const at = new Date("2024-11-03T06:00:00Z");
    expect(etDateKey(new Date(at.getTime()))).toBe(freshFormatter.format(at));
  });
});

describe("daySessionMinutes", () => {
  it("parses the contract table's bounds", () => {
    expect(daySessionMinutes(CONTRACT_SPECS.MNQ.daySession)).toEqual({ start: 570, end: 960 });
    expect(daySessionMinutes(CONTRACT_SPECS.MGC.daySession)).toEqual({ start: 500, end: 810 });
  });

  // A silent NaN makes every comparison in `isInDaySession` false, which is a
  // day-session strategy that takes no trades and says nothing about why.
  it("throws on a malformed bound rather than yielding NaN", () => {
    expect(() => daySessionMinutes({ start: "9:3O", end: "16:00" })).toThrow(/Malformed/);
    expect(() => daySessionMinutes({ start: "09:30", end: "" })).toThrow(/Malformed/);
    expect(() => daySessionMinutes({ start: "24:00", end: "16:00" })).toThrow(/Malformed/);
    expect(() => isInDaySession(new Date("2025-01-02T14:30:00Z"), { start: "", end: "" })).toThrow(
      /Malformed/,
    );
  });
});

describe("priorRthSessionRangeAtr", () => {
  /** ET is UTC-5 in January, so 09:30 ET is 14:30 UTC. */
  function bar(utcHour: number, utcMinute: number, day: number, high: number, low: number): BarData {
    return {
      timestamp: new Date(Date.UTC(2025, 0, day, utcHour, utcMinute, 0)).toISOString(),
      open: low,
      high,
      low,
      close: high,
      volume: 100,
    };
  }

  it("measures a prior session over its day-session bars, ignoring a wider overnight range", () => {
    const bars: BarData[] = [
      // 2025-01-02, 03:00 and 04:00 ET — overnight, 200 points wide.
      bar(8, 0, 2, 20100, 19900),
      bar(9, 0, 2, 20080, 19920),
      // 2025-01-02, 09:30 → 15:30 ET — the day session, 50 points wide.
      bar(14, 30, 2, 20030, 20000),
      bar(17, 0, 2, 20050, 20010),
      bar(20, 30, 2, 20040, 20005),
      // 2025-01-02, 17:00 ET — after the cash close, wide again.
      bar(22, 0, 2, 20300, 20200),
      // 2025-01-03, 09:30 ET — the session under evaluation.
      bar(14, 30, 3, 20020, 20000),
    ];

    const atr = priorRthSessionRangeAtr(
      bars,
      bars.length - 1,
      1,
      "2025-01-03",
      CONTRACT_SPECS.MNQ.daySession,
    );

    expect(atr).toBe(50);
  });

  it("reads MGC's own window rather than the index-futures one", () => {
    const bars: BarData[] = [
      // 2025-01-02, 08:20 → 13:00 ET — inside MGC's day session (08:20–13:30).
      bar(13, 20, 2, 2410, 2400),
      bar(18, 0, 2, 2420, 2405),
      // 2025-01-02, 14:00 ET — inside MNQ's session, past MGC's close.
      bar(19, 0, 2, 2500, 2300),
      bar(14, 30, 3, 2415, 2410),
    ];

    const atr = priorRthSessionRangeAtr(
      bars,
      bars.length - 1,
      1,
      "2025-01-03",
      CONTRACT_SPECS.MGC.daySession,
    );

    expect(atr).toBe(20);
  });
});

describe("priorDaySessionStats", () => {
  /**
   * One day-session bar per hour, ET = UTC−5 in January. `dayClose` is the
   * 15:30 ET bar's close, which is the session's last in-window print; the
   * 17:00 ET bar after it is outside the cash session and must not be read as
   * one.
   */
  function session(day: number, high: number, low: number, dayClose: number): BarData[] {
    const at = (utcHour: number, h: number, l: number, c: number): BarData => ({
      timestamp: new Date(Date.UTC(2025, 0, day, utcHour, 30, 0)).toISOString(),
      open: l,
      high: h,
      low: l,
      close: c,
      volume: 100,
    });
    return [
      // 03:30 ET — overnight, far wider than the cash session.
      at(8, high + 500, low - 500, low),
      // 09:30 / 12:30 / 15:30 ET — the cash session.
      at(14, high, low, (high + low) / 2),
      at(17, high - 1, low + 1, (high + low) / 2),
      at(20, high - 2, low + 2, dayClose),
      // 17:30 ET — after the cash close, wider again.
      at(22, high + 900, low - 900, high + 800),
    ];
  }

  /** 2025-01-02 and 01-03 complete, 01-06 the session under evaluation. */
  const BARS: BarData[] = [
    ...session(2, 6100, 6000, 6042),
    ...session(3, 6120, 6000, 6111),
    {
      timestamp: new Date(Date.UTC(2025, 0, 6, 14, 30, 0)).toISOString(),
      open: 6111,
      high: 6130,
      low: 6105,
      close: 6125,
      volume: 100,
    },
  ];

  const AT = BARS.length - 1;

  it("answers the range mean, the prior close and the prior extremes from one walk", () => {
    const stats = priorDaySessionStats(BARS, AT, 2, "2025-01-06", CONTRACT_SPECS.MES.daySession);

    // (6120 − 6000) and (6100 − 6000), day-session bars only.
    expect(stats.rangeMean).toBe(110);
    expect(stats.sessions).toBe(2);
    // 2025-01-03's 15:30 ET close, not its 17:30 ET one.
    expect(stats.close).toBe(6111);
    expect(stats.high).toBe(6120);
    expect(stats.low).toBe(6000);
  });

  it("still answers the prior session when the range baseline is short", () => {
    const stats = priorDaySessionStats(BARS, AT, 14, "2025-01-06", CONTRACT_SPECS.MES.daySession);

    expect(stats.rangeMean).toBeNaN();
    expect(stats.sessions).toBe(2);
    expect(stats.close).toBe(6111);
  });

  it("reads MGC's own window rather than the index-futures one", () => {
    // 17:00 ET is inside MES's session and past MGC's 13:30 close, so the two
    // instruments must disagree about the prior session's high and close.
    const mgc = priorDaySessionStats(BARS, AT, 1, "2025-01-06", CONTRACT_SPECS.MGC.daySession);
    const mes = priorDaySessionStats(BARS, AT, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);

    expect(mgc.close).toBe((6120 + 6000) / 2);
    expect(mes.close).toBe(6111);
  });

  it("answers nothing when the series holds no prior session", () => {
    expect(priorDaySessionStats(BARS, 0, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession)).toEqual({
      rangeMean: NaN,
      close: NaN,
      high: NaN,
      low: NaN,
      sessions: 0,
      sessionsInSpan: 0,
    });
  });

  describe("on a series marked fixed", () => {
    it("answers what the walk answers, and keeps it frozen", () => {
      const fixed = [...BARS];
      markFixedSeries(fixed);
      const first = priorDaySessionStats(fixed, AT, 2, "2025-01-06", CONTRACT_SPECS.MES.daySession);

      expect(first).toEqual(priorDaySessionStats(BARS, AT, 2, "2025-01-06", CONTRACT_SPECS.MES.daySession));
      expect(priorDaySessionStats(fixed, AT, 2, "2025-01-06", CONTRACT_SPECS.MES.daySession)).toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
    });

    it("keeps one answer per question, not one per series", () => {
      const fixed = [...BARS];
      markFixedSeries(fixed);
      const mes = priorDaySessionStats(fixed, AT, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);
      const mgc = priorDaySessionStats(fixed, AT, 1, "2025-01-06", CONTRACT_SPECS.MGC.daySession);
      const wider = priorDaySessionStats(fixed, AT, 2, "2025-01-06", CONTRACT_SPECS.MES.daySession);

      expect(mes.close).toBe(6111);
      expect(mgc.close).toBe((6120 + 6000) / 2);
      expect(wider.sessions).toBe(2);
    });

    // The engine's series is live: an unmarked one must be walked every time,
    // or a bar rewritten in place would leave a stale answer behind.
    it("walks an unmarked series every time", () => {
      const live = [...BARS];
      const before = priorDaySessionStats(live, AT, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);
      // 2025-01-03's 15:30 ET bar, the prior session's closing print.
      live[AT - 2] = { ...live[AT - 2], close: 7000 };
      const after = priorDaySessionStats(live, AT, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);

      expect(before.close).toBe(6111);
      expect(after.close).toBe(7000);
    });
  });

  it("hands out a frozen degenerate answer, which every caller shares by reference", () => {
    const first = priorDaySessionStats(BARS, 0, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);
    const second = priorDaySessionStats(BARS, -1, 1, "2025-01-06", CONTRACT_SPECS.MES.daySession);

    // Same object, so an unfrozen one would let the first caller's write reach
    // every later call for the life of a 24/7 process.
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  describe("the reported recency span", () => {
    /**
     * 2024-12-01 sits 36 calendar days before the session under evaluation, so
     * a 28-day span excludes it; the other two prior sessions are inside it.
     * This is the shape the walk silently reaches across — `rangeMean` comes
     * back finite either way and reads as live.
     */
    const HOLED: BarData[] = [
      ...session(-30, 6400, 6100, 6200),
      ...session(2, 6100, 6000, 6042),
      ...session(3, 6120, 6000, 6111),
      {
        timestamp: new Date(Date.UTC(2025, 0, 6, 14, 30, 0)).toISOString(),
        open: 6111,
        high: 6130,
        low: 6105,
        close: 6125,
        volume: 100,
      },
    ];
    const HOLED_AT = HOLED.length - 1;
    const MES = CONTRACT_SPECS.MES.daySession;

    it("counts every session it found when no span is stated", () => {
      const stats = priorDaySessionStats(HOLED, HOLED_AT, 3, "2025-01-06", MES);

      expect(stats.sessions).toBe(3);
      expect(stats.sessionsInSpan).toBe(3);
    });

    it("reports how many fell inside the span, and moves no other field", () => {
      const unbounded = priorDaySessionStats(HOLED, HOLED_AT, 3, "2025-01-06", MES);
      const reported = priorDaySessionStats(HOLED, HOLED_AT, 3, "2025-01-06", MES, 28);

      expect(reported.sessionsInSpan).toBe(2);
      expect(reported.sessions).toBe(3);
      // The whole safety of the additive fix: the answer a caller already reads
      // is identical, so stating a span stands nobody down here.
      expect({ ...reported, sessionsInSpan: 3 }).toEqual(unbounded);
      expect(reported.rangeMean).toBe((300 + 100 + 120) / 3);
    });

    it("caps the in-span count at `period`, like the session count beside it", () => {
      const stats = priorDaySessionStats(HOLED, HOLED_AT, 2, "2025-01-06", MES, 28);

      expect(stats.sessions).toBe(2);
      expect(stats.sessionsInSpan).toBe(2);
    });

    /**
     * The densest four weeks the CME equity calendar produces in the window
     * the probes are measured over. Anchor 2025-01-21; Christmas, New Year,
     * the 2025-01-09 national day of mourning and MLK are all full closures
     * inside the preceding 28 days, so the fourteenth prior session is
     * 2024-12-27 — **24 days back against a 28-day budget**.
     *
     * Every other test here lays its prior sessions on consecutive calendar
     * days, which uses half the budget and can never show the margin. The
     * nine probes all gate on `sessionsInSpan >= 14` at `spanDays = 28`, and
     * a guard that fired here would stand down every mid-January session and
     * read as a thesis that does not fire — which is the failure this stack
     * has already been reviewed for once. Pin the margin, not the fixture.
     */
    it("holds 14 sessions in span across the worst real holiday fortnight", () => {
      // Jan day-numbers: negatives roll into December 2024. The gaps are the
      // closures — no 2025-01-01, no 01-09, no weekends.
      const TRADING_DAYS = [-4, -1, 0, 2, 3, 6, 7, 8, 10, 13, 14, 15, 16, 17];
      const compressed: BarData[] = [
        ...TRADING_DAYS.flatMap((d, i) => session(d, 6100 + i, 6000 + i, 6050 + i)),
        {
          timestamp: new Date(Date.UTC(2025, 0, 21, 14, 30, 0)).toISOString(),
          open: 6111,
          high: 6130,
          low: 6105,
          close: 6125,
          volume: 100,
        },
      ];
      const stats = priorDaySessionStats(
        compressed,
        compressed.length - 1,
        14,
        "2025-01-21",
        MES,
        28,
      );

      expect(stats.sessions).toBe(14);
      expect(stats.sessionsInSpan).toBe(14);
      expect(stats.rangeMean).toBeGreaterThan(0);
    });

    it("reports none in span when the anchor bar's timestamp cannot be read", () => {
      const bad = [...HOLED];
      bad[HOLED_AT] = { ...bad[HOLED_AT], timestamp: "not-a-date" };
      const stats = priorDaySessionStats(bad, HOLED_AT, 3, "2025-01-06", MES, 28);

      // Fail closed at the caller: no readable anchor means no recency claim.
      expect(stats.sessions).toBe(3);
      expect(stats.sessionsInSpan).toBe(0);
    });
  });

  it("is what priorRthSessionRangeAtr answers, so the two cannot drift", () => {
    for (const period of [1, 2, 3]) {
      expect(
        priorRthSessionRangeAtr(BARS, AT, period, "2025-01-06", CONTRACT_SPECS.MES.daySession),
      ).toEqual(
        priorDaySessionStats(BARS, AT, period, "2025-01-06", CONTRACT_SPECS.MES.daySession)
          .rangeMean,
      );
    }
  });
});

describe("priorDaySessionProfiles", () => {
  const MS_PER_MIN = 60_000;
  const MNQ = CONTRACT_SPECS.MNQ.daySession;

  /** 09:30 ET on 2025-01-`day`, in UTC ms — ET is UTC−5 for every January date here. */
  function openMs(day: number): number {
    return Date.UTC(2025, 0, day, 14, 30, 0);
  }

  interface BucketSpec {
    high: number;
    low: number;
  }

  function at(ms: number, high: number, low: number): BarData {
    return {
      timestamp: new Date(ms).toISOString(),
      open: low,
      high,
      low,
      close: low,
      volume: 100,
    };
  }

  /**
   * A cash session of 5m bars. `specs[k]` is the 30m bucket starting k×30
   * minutes after 09:30 ET, laid down as six 5m bars of which only the first
   * carries the bucket's extremes — so a profile built off 5m bars instead of
   * 30m buckets cannot produce these answers.
   */
  function tpoSession(day: number, specs: BucketSpec[]): BarData[] {
    const out: BarData[] = [];
    specs.forEach((spec, k) => {
      for (let s = 0; s < 6; s++) {
        const ms = openMs(day) + (k * 30 + s * 5) * MS_PER_MIN;
        out.push(at(ms, s === 0 ? spec.high : spec.low, spec.low));
      }
    });
    return out;
  }

  /** The bar the walk is anchored on: today's cash open, 2025-01-16. */
  const TODAY = at(openMs(16), 100, 100);
  const TODAY_DATE = "2025-01-16";

  /**
   * Three buckets nesting inward, so every count is hand-checkable on a
   * `levelSize` of 1: levels 100…104 carry counts 1, 2, 3, 2, 1 for a total of
   * 9 TPOs.
   */
  const NESTED: BucketSpec[] = [
    { high: 104, low: 100 },
    { high: 103, low: 101 },
    { high: 102, low: 102 },
  ];

  /**
   * A bucket spanning the whole range, then one at each end — so levels 103…107
   * are printed exactly once by the first bucket and by nothing else. That run
   * is an interior single-print band; the extremes are not, which is what
   * separates a zone from a tail.
   */
  /**
   * One bucket over the whole range and one on a single level, so every level
   * but the POC carries the same count: counts 1,1,1,1,1,1,1,1,**2**,1,1 over
   * levels 100…110, 12 TPOs. The expansion is one long tie, which is what makes
   * the direction it resolves ties in the only thing deciding where the band
   * sits.
   */
  const PLATEAU: BucketSpec[] = [
    { high: 110, low: 100 },
    { high: 108, low: 108 },
  ];

  const GAPPED: BucketSpec[] = [
    { high: 110, low: 100 },
    { high: 102, low: 100 },
    { high: 110, low: 108 },
  ];

  function profilesOf(
    bars: BarData[],
    sessions = 1,
    levelSize = 1,
    spanDays?: number,
  ): ReturnType<typeof priorDaySessionProfiles> {
    return priorDaySessionProfiles(
      bars,
      bars.length - 1,
      sessions,
      TODAY_DATE,
      MNQ,
      levelSize,
      spanDays,
    );
  }

  describe("the profile itself", () => {
    it("counts one TPO per 30m bucket per level and finds the point of control", () => {
      const p = profilesOf([...tpoSession(15, NESTED), TODAY]).profiles[0];

      expect(p.sessionDate).toBe("2025-01-15");
      expect(p.high).toBe(104);
      expect(p.low).toBe(100);
      expect(p.tpos).toBe(9);
      expect(p.poc).toBe(102);
      expect(p.buckets).toBe(3);
      expect(p.levelSize).toBe(1);
    });

    it("expands the value area from the POC to 70% of the count, one level at a time", () => {
      const p = profilesOf([...tpoSession(15, NESTED), TODAY]).profiles[0];

      // Target 6.3 of 9. From the POC (3) the two candidates are equidistant
      // from the 102 midpoint and tied at 2, so 103 joins first (7); still
      // short, and 101 then wins on its count (9), where the expansion stops.
      expect(VALUE_AREA_FRACTION).toBe(0.7);
      expect(p.vah).toBe(103);
      expect(p.val).toBe(101);
    });

    it("breaks a value-area tie toward the session midpoint, not upward", () => {
      const p = profilesOf([...tpoSession(15, PLATEAU), TODAY]).profiles[0];

      // POC 108 (the only 2), target 8.4 of 12, midpoint level 105. Every step
      // is a tie on the count, so each one takes the candidate nearer 105: six
      // steps down to 102 (included 8), then the seventh finds 109 and 101
      // equidistant and takes the level above, reaching 9. Resolving ties
      // upward instead gives the same **width** — eight levels — translated one
      // level up, at 103…110.
      expect(p.tpos).toBe(12);
      expect(p.poc).toBe(108);
      expect(p.vah).toBe(109);
      expect(p.val).toBe(102);
    });

    it("breaks a POC tie toward the session midpoint", () => {
      // Counts 2,2,2,1,1,1,1,1,2,2,2 over levels 100…110: five levels tie at
      // the top count and the one nearest the 105 midpoint is 102.
      const p = profilesOf([...tpoSession(15, GAPPED), TODAY]).profiles[0];

      expect(p.poc).toBe(102);
      expect(p.tpos).toBe(17);
      expect(p.vah).toBe(108);
      expect(p.val).toBe(100);
    });

    it("reports an interior single-print run and does not call it a tail", () => {
      const p = profilesOf([...tpoSession(15, GAPPED), TODAY]).profiles[0];

      expect(p.singlePrints).toEqual([
        { low: 103, high: 107, levels: 5, touchesLow: false, touchesHigh: false },
      ]);
    });

    it("flags the runs that reach the session's extremes, because those are tails", () => {
      const p = profilesOf([...tpoSession(15, NESTED), TODAY]).profiles[0];

      expect(p.singlePrints).toEqual([
        { low: 100, high: 100, levels: 1, touchesLow: true, touchesHigh: false },
        { low: 104, high: 104, levels: 1, touchesLow: false, touchesHigh: true },
      ]);
    });

    it("never reports a level no bucket printed as a single print", () => {
      // 100–101 and 109–110, with 102…108 printed by nothing at all.
      const p = profilesOf([
        ...tpoSession(15, [
          { high: 101, low: 100 },
          { high: 110, low: 109 },
        ]),
        TODAY,
      ]).profiles[0];

      expect(p.singlePrints).toEqual([
        { low: 100, high: 101, levels: 2, touchesLow: true, touchesHigh: false },
        { low: 109, high: 110, levels: 2, touchesLow: false, touchesHigh: true },
      ]);
    });

    it("works on a 0.25 grid, which is the one the modules use", () => {
      const p = profilesOf(
        [
          ...tpoSession(15, [
            { high: 21001, low: 21000 },
            { high: 21000.75, low: 21000.25 },
          ]),
          TODAY,
        ],
        1,
        0.25,
      ).profiles[0];

      // Levels 21000 … 21001 at a 0.25 step: counts 1, 2, 2, 2, 1 → 8 TPOs,
      // POC the midpoint tie at 21000.5, VA 21000.25 … 21000.75 (6 of 8).
      expect(p.tpos).toBe(8);
      expect(p.poc).toBe(21000.5);
      expect(p.vah).toBe(21000.75);
      expect(p.val).toBe(21000.25);
      expect(p.singlePrints).toEqual([
        { low: 21000, high: 21000, levels: 1, touchesLow: true, touchesHigh: false },
        { low: 21001, high: 21001, levels: 1, touchesLow: false, touchesHigh: true },
      ]);
    });

    it("refuses a grid wider than the work cap without dropping the session", () => {
      const p = profilesOf(
        [...tpoSession(15, [{ high: 24000, low: 21000 }]), TODAY],
        1,
        0.25,
      ).profiles[0];

      // 12,001 levels against a cap of 8,192. The session is still a row — a
      // missing one would read as one fewer prior session — and every level the
      // caller gates on is NaN, so its own isFinite clause stands it down.
      expect(p.buckets).toBe(1);
      expect(p.high).toBe(24000);
      expect(p.low).toBe(21000);
      expect(p.poc).toBeNaN();
      expect(p.vah).toBeNaN();
      expect(p.val).toBeNaN();
      expect(p.tpos).toBe(0);
      expect(p.singlePrints).toEqual([]);
    });
  });

  describe("what the walk is measured over", () => {
    it("buckets day-session bars alone, ignoring a far wider overnight", () => {
      const overnight = [
        at(Date.UTC(2025, 0, 15, 8, 0, 0), 9000, 1000),
        at(Date.UTC(2025, 0, 15, 22, 0, 0), 9000, 1000),
      ];
      const p = profilesOf([overnight[0], ...tpoSession(15, NESTED), overnight[1], TODAY])
        .profiles[0];

      expect(p.high).toBe(104);
      expect(p.low).toBe(100);
      expect(p.buckets).toBe(3);
    });

    it("splits buckets on the absolute half-hour, not on a bar count", () => {
      // 09:55 closes the 09:30 bucket and 10:00 opens the next; a walk counting
      // six bars from wherever the session started would put them together.
      const bars = [
        at(openMs(15), 105, 100),
        at(openMs(15) + 25 * MS_PER_MIN, 101, 100),
        at(openMs(15) + 30 * MS_PER_MIN, 200, 190),
        TODAY,
      ];
      const p = profilesOf(bars).profiles[0];

      expect(p.buckets).toBe(2);
      expect(p.high).toBe(200);
      expect(p.low).toBe(100);
    });

    it("reports how many buckets a session held, and gates on none of it", () => {
      const short = profilesOf([...tpoSession(15, NESTED), TODAY]);
      const full = profilesOf([...tpoSession(15, Array(13).fill({ high: 104, low: 100 })), TODAY]);

      expect(short.expectedBuckets).toBe(13);
      expect(short.profiles[0].buckets).toBe(3);
      expect(full.profiles[0].buckets).toBe(13);
      // Both are returned: the completeness verdict is the caller's.
      expect(short.sessions).toBe(1);
    });

    it("counts MGC's own day session, which is not a whole number of buckets", () => {
      // 08:20–13:30 ET straddles eleven absolute half-hours; the 08:00 one is
      // entered ten minutes late and the 13:00 one left half an hour early.
      expect(
        priorDaySessionProfiles([TODAY], 0, 1, TODAY_DATE, CONTRACT_SPECS.MGC.daySession, 0.25)
          .expectedBuckets,
      ).toBe(11);
    });

    it("never reads the session under evaluation", () => {
      const bars = [...tpoSession(15, NESTED), ...tpoSession(16, GAPPED)];
      const p = priorDaySessionProfiles(
        bars,
        bars.length - 1,
        1,
        TODAY_DATE,
        MNQ,
        1,
      ).profiles[0];

      expect(p.sessionDate).toBe("2025-01-15");
    });

    it("reads no bar at or after the anchor index", () => {
      const prior = tpoSession(14, NESTED);
      const bars = [...prior, ...tpoSession(15, GAPPED), TODAY];
      const p = priorDaySessionProfiles(bars, prior.length, 1, "2025-01-15", MNQ, 1).profiles[0];

      // The anchor is 2025-01-15's first bar; every GAPPED bucket sits at or
      // after it and none of them reaches the answer.
      expect(p.sessionDate).toBe("2025-01-14");
      expect(p.high).toBe(104);
      expect(p.singlePrints).toHaveLength(2);
    });
  });

  describe("several sessions, newest first", () => {
    const FIVE = [13, 14, 15].map((d) => tpoSession(d, d === 14 ? GAPPED : NESTED)).flat();

    it("returns them newest first and stops at the count asked for", () => {
      const got = profilesOf([...FIVE, TODAY], 2);

      expect(got.sessions).toBe(2);
      expect(got.profiles.map((p) => p.sessionDate)).toEqual(["2025-01-15", "2025-01-14"]);
      expect(got.profiles[1].poc).toBe(102);
      expect(got.profiles[1].singlePrints).toHaveLength(1);
    });

    it("answers with what it found when the series is short of the count", () => {
      const got = profilesOf([...tpoSession(15, NESTED), TODAY], 5);

      expect(got.sessions).toBe(1);
      expect(got.profiles).toHaveLength(1);
    });

    it("answers nothing when the anchor is the start of the series", () => {
      const got = priorDaySessionProfiles([TODAY], 0, 5, TODAY_DATE, MNQ, 1);

      expect(got).toEqual({ profiles: [], sessions: 0, sessionsInSpan: 0, expectedBuckets: 13 });
    });

    it("records each session's last in-window bar, which is where a naked walk stops", () => {
      const p = profilesOf([...FIVE, TODAY], 1).profiles[0];

      // 15:30 would be the last bucket of a full session; this fixture stops
      // three buckets in, so the newest in-window bar is 10:55 on 2025-01-15.
      expect(p.lastBarMs).toBe(openMs(15) + 85 * MS_PER_MIN);
    });
  });

  describe("the reported recency span", () => {
    /** 2024-12-06 is 41 days before the anchor; the other two sit inside 28. */
    const HOLED = [
      ...tpoSession(-25, NESTED),
      ...tpoSession(14, NESTED),
      ...tpoSession(15, NESTED),
      TODAY,
    ];

    it("counts every session it profiled when no span is stated", () => {
      const got = profilesOf(HOLED, 3);

      expect(got.sessions).toBe(3);
      expect(got.sessionsInSpan).toBe(3);
    });

    it("reports how many fell inside the span, and moves no other field", () => {
      const unbounded = profilesOf(HOLED, 3);
      const reported = profilesOf(HOLED, 3, 1, 28);

      expect(reported.sessionsInSpan).toBe(2);
      expect(reported.sessions).toBe(3);
      expect({ ...reported, sessionsInSpan: 3 }).toEqual(unbounded);
    });

    it("reports none in span when the anchor bar's timestamp cannot be read", () => {
      const bad = [...HOLED];
      bad[bad.length - 1] = { ...TODAY, timestamp: "not-a-date" };
      const got = profilesOf(bad, 3, 1, 28);

      // Fail closed at the caller: no readable anchor means no recency claim.
      expect(got.sessions).toBe(3);
      expect(got.sessionsInSpan).toBe(0);
    });

    /**
     * The margin the two profile modules' spans buy them, against the densest
     * real closure cluster in the CME equity calendar. `profile-traversal`
     * declares `warmupDaySessions` 6, which the engine converts to 16 calendar
     * days, and requires five prior sessions inside it; `profile-rotation` declares
     * 2 → 10 days and requires one. Anchor 2025-01-13, with New Year's Day and
     * the 2025-01-09 day of mourning both inside the window — so the fifth
     * prior session is 2025-01-03, **10 days back against a 16-day budget**.
     *
     * Every other fixture here lays its sessions on consecutive calendar days,
     * which uses half the budget and can never show the margin. A guard that
     * fired here would stand down every mid-January session and read as a
     * thesis that does not fire.
     */
    it("holds five sessions in a 16-day span across the worst real holiday stretch", () => {
      const TRADING_DAYS = [2, 3, 6, 7, 8, 10];
      const bars = [
        ...TRADING_DAYS.flatMap((d) => tpoSession(d, NESTED)),
        at(Date.UTC(2025, 0, 13, 14, 30, 0), 100, 100),
      ];
      const got = priorDaySessionProfiles(bars, bars.length - 1, 5, "2025-01-13", MNQ, 1, 16);

      expect(got.sessions).toBe(5);
      expect(got.sessionsInSpan).toBe(5);
      expect(got.profiles[4].sessionDate).toBe("2025-01-03");
    });
  });
});

describe("memoiseByUtcMinute", () => {
  it("computes once per UTC minute, not once per millisecond", () => {
    let calls = 0;
    const memo = memoiseByUtcMinute((d: Date) => `${d.getTime()}-${++calls}`, 4);
    const at = new Date("2024-06-14T04:00:00.000Z");
    expect(memo(at)).toBe(memo(new Date("2024-06-14T04:00:59.999Z")));
    expect(calls).toBe(1);
  });

  it("computes again on the other side of a minute boundary", () => {
    let calls = 0;
    const memo = memoiseByUtcMinute(() => ++calls, 4);
    memo(new Date("2024-06-14T04:00:59.999Z"));
    memo(new Date("2024-06-14T04:01:00.000Z"));
    expect(calls).toBe(2);
  });

  it("clears at the cap rather than growing without bound", () => {
    let calls = 0;
    const memo = memoiseByUtcMinute((d: Date) => {
      calls++;
      return d.getTime();
    }, 3);
    const minutes = [0, 1, 2].map((n) => new Date(n * 60_000));
    for (const at of minutes) memo(at);
    expect(calls).toBe(3);

    // The fourth distinct minute finds the cache full and empties it.
    memo(new Date(3 * 60_000));
    expect(calls).toBe(4);
    expect(memo(minutes[0])).toBe(0);
    expect(calls).toBe(5);
  });
});

describe("the minute key against the boundaries that could break it", () => {
  it("keeps the ET date right across ET midnight, which is a whole-hour offset from UTC", () => {
    const before = new Date("2024-06-14T03:59:00Z");
    const after = new Date("2024-06-14T04:00:00Z");
    expect(etDateKey(before)).toBe(freshFormatter.format(before));
    expect(etDateKey(after)).toBe(freshFormatter.format(after));
    expect(etDateKey(before)).not.toBe(etDateKey(after));
  });

  it("keeps both readings right across spring-forward", () => {
    // 01:59 EST, then 03:00 EDT — one minute apart in UTC, an hour apart on
    // the ET wall clock.
    const est = new Date("2024-03-10T06:59:00Z");
    const edt = new Date("2024-03-10T07:00:00Z");
    expect(minutesInTradingTz(est)).toBe(1 * 60 + 59);
    expect(minutesInTradingTz(edt)).toBe(3 * 60);
    expect(minutesInTradingTz(new Date("2024-03-10T06:59:30Z"))).toBe(1 * 60 + 59);
  });

  it("keeps both readings right across fall-back, where one wall clock is two instants", () => {
    const edt = new Date("2024-11-03T05:00:00Z");
    const est = new Date("2024-11-03T06:00:00Z");
    expect(minutesInTradingTz(edt)).toBe(60);
    expect(minutesInTradingTz(est)).toBe(60);
    expect(etDateKey(edt)).toBe(freshFormatter.format(edt));
    expect(etDateKey(est)).toBe(freshFormatter.format(est));
  });
});
