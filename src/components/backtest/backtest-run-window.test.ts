/**
 * The run reader's chart window and timeframe.
 *
 * The session-window cases are the ones a fixed UTC offset or a calendar-day
 * anchor gets wrong while still drawing a plausible chart: a Sunday-evening
 * open belongs to Monday's session, and the two DST Sundays move every
 * boundary by an hour.
 */
import { describe, expect, it } from "vitest";
import {
  chartWindowFor,
  choiceFor,
  initialLogicalRange,
  parseStoredWholeDay,
  parseTimeframe,
  resolveChartTimeframe,
  sessionWindowFor,
  timeframeOptions,
} from "./backtest-run-window";

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function bars(startIso: string, count: number, minutes: number): { timestamp: string }[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => ({ timestamp: iso(start + i * minutes * MIN) }));
}

describe("sessionWindowFor", () => {
  it("runs 18:00 ET the evening before to 17:00 ET (EST, mid-week)", () => {
    const w = sessionWindowFor("2026-03-04T15:00:00.000Z"); // Wed 10:00 EST
    expect(w.sessionDate).toBe("2026-03-04");
    expect(iso(w.fromMs)).toBe("2026-03-03T23:00:00.000Z");
    expect(iso(w.toMs)).toBe("2026-03-04T22:00:00.000Z");
  });

  it("files a Sunday-evening entry under Monday's session, opened Sunday 18:00 ET", () => {
    const w = sessionWindowFor("2026-01-12T00:30:00.000Z"); // Sun 2026-01-11 19:30 EST
    expect(w.sessionDate).toBe("2026-01-12");
    expect(iso(w.fromMs)).toBe("2026-01-11T23:00:00.000Z");
    expect(iso(w.toMs)).toBe("2026-01-12T22:00:00.000Z");
  });

  it("opens on EDT when the session's Sunday open is the spring-forward day", () => {
    // DST began 02:00 ET Sunday 2026-03-08; that evening's 18:00 open is EDT.
    const w = sessionWindowFor("2026-03-08T23:00:00.000Z"); // Sun 19:00 EDT
    expect(w.sessionDate).toBe("2026-03-09");
    expect(iso(w.fromMs)).toBe("2026-03-08T22:00:00.000Z");
    expect(iso(w.toMs)).toBe("2026-03-09T21:00:00.000Z");
  });

  it("opens on EST when the session's Sunday open is the fall-back day", () => {
    // DST ended 02:00 ET Sunday 2026-11-01.
    const w = sessionWindowFor("2026-11-02T15:00:00.000Z"); // Mon 10:00 EST
    expect(w.sessionDate).toBe("2026-11-02");
    expect(iso(w.fromMs)).toBe("2026-11-01T23:00:00.000Z");
    expect(iso(w.toMs)).toBe("2026-11-02T22:00:00.000Z");
  });
});

describe("chartWindowFor", () => {
  const base = { preBars: 40, postBars: 15, contextBars: 240 };

  it("pads the tight window in bars of the chart's timeframe, not the run's", () => {
    const w = chartWindowFor({
      ...base,
      entryIso: "2026-03-04T15:00:00.000Z",
      exitIso: "2026-03-04T16:00:00.000Z",
      timeframe: "15m",
      wholeDay: false,
    });
    expect(w.fromIso).toBe(iso(new Date("2026-03-04T15:00:00.000Z").getTime() - 280 * 15 * MIN));
    expect(w.toIso).toBe(iso(new Date("2026-03-04T16:00:00.000Z").getTime() + 255 * 15 * MIN));
  });

  it("loads the whole session when it is wider than the tight window on both sides", () => {
    // At 1m the tight window is 280 bars back and 255 on: inside the session.
    const w = chartWindowFor({
      ...base,
      entryIso: "2026-03-04T15:00:00.000Z",
      exitIso: "2026-03-04T16:00:00.000Z",
      timeframe: "1m",
      wholeDay: true,
    });
    expect(w.fromIso).toBe("2026-03-03T23:00:00.000Z");
    expect(w.toIso).toBe("2026-03-04T22:00:00.000Z");
  });

  it("extends the fetch past a trade that exits after the session close", () => {
    const w = chartWindowFor({
      ...base,
      entryIso: "2026-03-04T20:00:00.000Z",
      exitIso: "2026-03-05T00:00:00.000Z",
      timeframe: "5m",
      wholeDay: true,
    });
    expect(w.toIso).toBe(iso(new Date("2026-03-05T00:00:00.000Z").getTime() + 255 * 5 * MIN));
  });

  it("is never narrower than the tight window, on either side", () => {
    // `orb-confluence-capped/no-trade-days-*` rows: entry 10:30 ET, exit 15:59 ET.
    // At 15m the tight window reaches days past the session in both directions.
    const trade = { ...base, entryIso: "2022-07-06T14:30:00.000Z", exitIso: "2022-07-06T19:59:00.000Z" };
    const whole = chartWindowFor({ ...trade, timeframe: "15m", wholeDay: true });
    const tight = chartWindowFor({ ...trade, timeframe: "15m", wholeDay: false });
    expect(whole).toEqual(tight);
  });
});

describe("initialLogicalRange", () => {
  it("counts the tight view from the bars containing a 1m entry and exit on a 5m chart", () => {
    const b = bars("2026-03-04T14:00:00.000Z", 40, 5);
    // 14:37 sits in the 14:35 bar (index 7), 15:02 in the 15:00 bar (index 12).
    const r = initialLogicalRange(b, "2026-03-04T14:37:00.000Z", "2026-03-04T15:02:00.000Z", 3, 2);
    expect(r).toEqual({ from: 4, to: 14 });
  });
});

/** Operator decision 2026-10-07: Whole day changes what is loaded, never the
 *  opening view — the operator zooms out to see the rest. */
describe("whole day against the tight window, on Globex bars", () => {
  const PRE = 40;
  const POST = 15;
  const CONTEXT = 240;
  const etHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

  /** Every bar of `minutes` covering [fromIso, toIso), minus the 17:00 ET maintenance hour. */
  function globexBars(fromIso: string, toIso: string, minutes: number): { timestamp: string }[] {
    const step = minutes * MIN;
    const start = Math.ceil(new Date(fromIso).getTime() / step) * step;
    const out: { timestamp: string }[] = [];
    for (let t = start; t < new Date(toIso).getTime(); t += step) {
      if (etHour.format(new Date(t)) !== "17") out.push({ timestamp: iso(t) });
    }
    return out;
  }

  function opened(entryIso: string, exitIso: string, timeframe: "1m" | "5m" | "15m", wholeDay: boolean) {
    const w = chartWindowFor({ entryIso, exitIso, timeframe, wholeDay, preBars: PRE, postBars: POST, contextBars: CONTEXT });
    const b = globexBars(w.fromIso, w.toIso, Number.parseInt(timeframe, 10));
    const r = initialLogicalRange(b, entryIso, exitIso, PRE, POST);
    const idx = (iso: string) => b.findIndex((x) => x.timestamp === iso);
    return { r, bars: b, w, idx };
  }

  const trades = [
    { name: "an ORB morning trade", entry: "2026-03-04T14:47:00.000Z", exit: "2026-03-04T16:12:00.000Z" },
    // The session closes at 17:00 ET, so on 15m `postBars` after the exit bar
    // run past it: a session-only fetch ended before the last visible bar.
    { name: "a no-trade-day row held to 15:59", entry: "2022-07-06T14:30:00.000Z", exit: "2022-07-06T19:59:00.000Z" },
    // 18:05 ET, five minutes into the session: a session-only fetch had no
    // bars for `preBars` before the entry, so the chart opened on 18:00.
    { name: "an overnight entry at 18:05 ET", entry: "2026-03-04T23:05:00.000Z", exit: "2026-03-05T00:20:00.000Z" },
  ];

  for (const t of trades) {
    for (const tf of ["1m", "5m", "15m"] as const) {
      it(`loads at least the full session and opens on the same bars, for ${t.name} on ${tf}`, () => {
        const session = sessionWindowFor(t.entry);
        const whole = opened(t.entry, t.exit, tf, true);
        const tight = opened(t.entry, t.exit, tf, false);
        expect(Date.parse(whole.w.fromIso)).toBeLessThanOrEqual(session.fromMs);
        expect(Date.parse(whole.w.toIso)).toBeGreaterThanOrEqual(session.toMs);
        // The two fetches start at different bars, so the opening view is
        // compared by the timestamps it shows, which is what the operator sees.
        const firstVisible = (o: typeof whole) => o.bars[o.r.from]?.timestamp;
        const lastVisible = (o: typeof whole) => o.bars[o.r.to]?.timestamp;
        expect(lastVisible(tight)).toBeDefined();
        expect(firstVisible(whole)).toBe(firstVisible(tight));
        expect(lastVisible(whole)).toBe(lastVisible(tight));
        // And the tight view is the full `preBars` / `postBars`, not clipped.
        const step = Number.parseInt(tf, 10) * MIN;
        const barOf = (ms: number) => iso(Math.floor(ms / step) * step);
        expect(tight.r.from).toBe(tight.idx(barOf(new Date(t.entry).getTime())) - PRE);
      });
    }
  }
});

describe("the timeframe picker", () => {
  it("defaults to the run's own timeframe", () => {
    expect(resolveChartTimeframe(null, "5m")).toBe("5m");
    expect(resolveChartTimeframe(null, "15m")).toBe("15m");
  });

  it("keeps an explicit pick across runs on other timeframes", () => {
    expect(resolveChartTimeframe("15m", "5m")).toBe("15m");
    expect(resolveChartTimeframe("15m", "1m")).toBe("15m");
  });

  it("falls back to the run's own when the pick is not offered for this run", () => {
    expect(resolveChartTimeframe("3m", "5m")).toBe("5m");
  });

  it("falls back to 1m for a header whose timeframe it cannot read", () => {
    expect(resolveChartTimeframe(null, parseTimeframe("7m"))).toBe("1m");
  });

  it("offers 1m, 5m and 15m, plus the run's own when it is none of those", () => {
    expect(timeframeOptions("5m")).toEqual(["1m", "5m", "15m"]);
    expect(timeframeOptions("3m")).toEqual(["1m", "3m", "5m", "15m"]);
    expect(timeframeOptions("30m")).toEqual(["1m", "5m", "15m", "30m"]);
  });

  it("stores picking the run's own timeframe as no pick, so it follows the next run", () => {
    expect(choiceFor("5m", "5m")).toBeNull();
    expect(choiceFor("15m", "5m")).toBe("15m");
  });

  it("reads back only a timeframe it charts", () => {
    expect(parseTimeframe("15m")).toBe("15m");
    expect(parseTimeframe(null)).toBeNull();
    expect(parseTimeframe("toString")).toBeNull();
    expect(parseStoredWholeDay("true")).toBe(true);
    expect(parseStoredWholeDay(null)).toBe(false);
  });
});
