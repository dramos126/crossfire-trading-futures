import { describe, it, expect } from "vitest";

import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { LEGACY_DAY_SESSION, withCommonParams, type StrategyModule } from "@/lib/trading/strategy-types";
import { addCalendarDays, sessionDateOf } from "@/lib/trading/regime/session-dates";
import type { SessionDay } from "@/lib/trading/regime/session-days";
import { CliError } from "./cli-error";
import type { Bar, BarSource } from "@/lib/data/bar-source";
import { ChainedBarSource } from "@/lib/data/chained-bar-source";
import {
  calendarFrontMonth,
  completedRowsBefore,
  loadCacheBars,
  loadRunBars,
  resolveCacheSymbol,
  tailRecord,
  type LoadedBars,
} from "./bars";

const SPEC = CONTRACT_SPECS.MNQ;
const FROM = "2024-01-02";
const TO = "2024-06-28";
const CLASSIFIER_ROWS = 275;

const ARGS = {
  timeframe: "5m",
  from: FROM,
  to: TO,
  warmupDays: CLASSIFIER_ROWS,
  usesClassifier: true,
  perturb: false,
} as const;

function isWeekend(sessionDate: string): boolean {
  const dow = new Date(`${sessionDate}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function row(sessionDate: string): SessionDay {
  return {
    sessionDate,
    daySessionHigh: 100,
    daySessionLow: 90,
    daySessionClose: 95,
    rthTR: 40,
    rthRange: 40,
  };
}

/**
 * A synthetic exchange calendar: every weekday between the fetch's first
 * session and its last produces a row, except the holidays — which are the
 * whole point, because `shiftSessionDatesBack` counts weekdays and the
 * classifier counts rows.
 */
function calendar(isHoliday: (sessionDate: string) => boolean) {
  const calls: string[] = [];
  const load = async (fromUtc: Date, toUtc: Date): Promise<LoadedBars> => {
    const first = sessionDateOf(fromUtc);
    const last = sessionDateOf(toUtc);
    calls.push(first);
    const sessionDays: SessionDay[] = [];
    for (let cursor = first; cursor <= last; cursor = addCalendarDays(cursor, 1)) {
      if (!isWeekend(cursor) && !isHoliday(cursor)) sessionDays.push(row(cursor));
    }
    return {
      bars: [],
      sessionDays,
      cacheFiles: [],
      coverage: { minUtc: null, maxUtc: null },
      barTail: null,
    };
  };
  return { calls, load };
}

/** One holiday a month, which is roughly the CME's own count. */
const monthlyHoliday = (sessionDate: string) => sessionDate.endsWith("-15");
/** A calendar no extension can satisfy: a fifth of every week is shut. */
const everyMonday = (sessionDate: string) =>
  new Date(`${sessionDate}T00:00:00Z`).getUTCDay() === 1;

describe("resolveCacheSymbol", () => {
  it("resolves to the spec's own cache symbol when no override is given", () => {
    expect(resolveCacheSymbol(SPEC)).toBe(SPEC.cacheSymbol);
    expect(resolveCacheSymbol(SPEC, null)).toBe(SPEC.cacheSymbol);
    expect(resolveCacheSymbol(SPEC, undefined)).toBe(SPEC.cacheSymbol);
  });

  it("resolves to --bar-symbol's value when given, leaving spec untouched", () => {
    expect(resolveCacheSymbol(SPEC, "NQ.c.0")).toBe("NQ.c.0");
    expect(SPEC.cacheSymbol).toBe("MNQ.v.0");
  });
});

describe("loadCacheBars with and without the tail", () => {
  const NS = BigInt(1_000_000);
  const MINUTE_MS = 60_000;
  const minuteBars = (fromIso: string, count: number, symbol: string): Bar[] =>
    Array.from({ length: count }, (_, i) => ({
      tsUtc: BigInt(Date.parse(fromIso) + i * MINUTE_MS) * NS,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: BigInt(1),
      symbol,
    }));
  const source = (bars: Bar[]): BarSource => ({
    getBars: async (_s, from, to) =>
      bars.filter((b) => b.tsUtc >= BigInt(from.getTime()) * NS && b.tsUtc <= BigInt(to.getTime()) * NS),
    coverage: async () => ({
      minUtc: bars.length ? new Date(Number(bars[0].tsUtc / NS)) : null,
      maxUtc: bars.length ? new Date(Number(bars[bars.length - 1].tsUtc / NS)) : null,
    }),
  });
  const archive = minuteBars("2026-10-09T13:30:00.000Z", 60, "MNQ.c.0");
  const topstep = minuteBars("2026-10-09T14:00:00.000Z", 90, "MNQ.c.0");
  const base = {
    cacheSymbol: "MNQ.c.0",
    timeframe: "1m" as const,
    fromUtc: new Date("2026-10-09T13:30:00.000Z"),
    toUtc: new Date("2026-10-09T15:29:00.000Z"),
    daySession: SPEC.daySession,
    tickSize: SPEC.tickSize,
    cache: source(archive),
  };

  it("refuses a range past the archive when no tail was asked for", async () => {
    await expect(loadCacheBars(base)).rejects.toThrow(/Refusing a short run/);
  });

  it("splices the tail past the archive and records the range it served", async () => {
    const loaded = await loadCacheBars({
      ...base,
      tail: {
        contractId: "CON.F.US.MNQ.Z26",
        chain: (cache) => new ChainedBarSource(cache, source(topstep)),
      },
    });
    expect(loaded.bars).toHaveLength(120);
    expect(loaded.barTail).toEqual({
      source: "topstep",
      contractId: "CON.F.US.MNQ.Z26",
      cacheMaxUtc: "2026-10-09T14:29:00.000Z",
      fromUtc: "2026-10-09T14:30:00.000Z",
      toUtc: "2026-10-09T15:29:00.000Z",
      barCount: 60,
      // The tail's first open, 1, against the archive's last close, 1.5.
      seam: { cacheMonth: "Z2026", tailMonth: "Z2026", gapTicks: 2 },
    });
  });

  // A105: the backtest resolves a flatten inside a bar on these, and reads
  // nothing else. 2026-10-09 is EDT: 19:00Z is 15:00 ET.
  describe("subBars: only the 1m bars inside a bar the flatten falls in", () => {
    const leg = {
      strategy: {
        version: "1.0.0",
        key: "test-session-0930-1555",
        params: withCommonParams({}),
        config: {
          name: "Session fixture",
          description: "Test fixture.",
          timeframe: "30m",
          session: LEGACY_DAY_SESSION,
          entryType: 2,
          indicators: [],
        },
        shouldEnter: () => null,
        shouldExit: () => false,
      } satisfies StrategyModule,
    };
    const close = {
      ...base,
      cache: source(minuteBars("2026-10-09T19:00:00.000Z", 90, "MNQ.c.0")),
      fromUtc: new Date("2026-10-09T19:00:00.000Z"),
      toUtc: new Date("2026-10-09T20:29:00.000Z"),
    };

    it("keeps the 15:30 bar's 30 minutes on 30m, and drops the rest", async () => {
      const thirty = await loadCacheBars({ ...close, timeframe: "30m", straddleLegs: [leg] });
      expect(thirty.bars).toHaveLength(3);
      expect(thirty.subBars).toHaveLength(30);
      expect(thirty.subBars?.[0].timestamp).toBe("2026-10-09T19:30:00.000Z");
      expect(thirty.subBars?.at(-1)?.timestamp).toBe("2026-10-09T19:59:00.000Z");
    });

    it("carries none on 5m or 1m, where no bar holds the flatten, nor with no legs named", async () => {
      // The CLI's overrides always carry `timeframe`, which is what the leg's clock reads.
      const at = (timeframe: string) => [{ ...leg, paramOverrides: { timeframe } }];
      expect((await loadCacheBars({ ...close, timeframe: "5m", straddleLegs: at("5m") })).subBars).toBeUndefined();
      expect((await loadCacheBars({ ...close, straddleLegs: at("1m") })).subBars).toBeUndefined();
      expect((await loadCacheBars({ ...close, timeframe: "30m" })).subBars).toBeUndefined();
    });

    // 15:00–16:30 ET on 5m: the eleven 15:00–15:50 bars open in the 09:30–15:55 window.
    it("keeps every in-session minute on 5m for a leg that checks break-even intrabar, and only for it", async () => {
      const at5m = (overrides: Record<string, unknown>) => ({ ...leg, paramOverrides: { timeframe: "5m", ...overrides } });
      const intrabar = at5m({ breakEvenFilterEnabled: true, breakEvenFilterCheck: "intrabar" });
      const barClose = at5m({ breakEvenFilterEnabled: true, breakEvenFilterCheck: "barClose" });

      const run = await loadCacheBars({ ...close, timeframe: "5m", straddleLegs: [intrabar] });
      expect(run.subBars).toHaveLength(55);
      expect(run.subBars?.[0].timestamp).toBe("2026-10-09T19:00:00.000Z");
      expect(run.subBars?.at(-1)?.timestamp).toBe("2026-10-09T19:54:00.000Z");
      // A book names every cell on the series; the bar-close one adds nothing.
      const book = await loadCacheBars({ ...close, timeframe: "5m", straddleLegs: [barClose, intrabar] });
      expect(book.subBars).toEqual(run.subBars);
      expect((await loadCacheBars({ ...close, timeframe: "5m", straddleLegs: [barClose] })).subBars).toBeUndefined();
    });
  });
});

describe("calendarFrontMonth — the contract a .c.0 archive holds", () => {
  it("is the quarterly month whose third-Friday expiry has not passed in ET", () => {
    // Third Friday of December 2026 is the 18th.
    expect(calendarFrontMonth("MNQ.c.0", new Date("2026-10-09T19:59:00.000Z"))).toBe("Z2026");
    expect(calendarFrontMonth("MNQ.c.0", new Date("2026-12-18T15:00:00.000Z"))).toBe("Z2026");
    expect(calendarFrontMonth("MNQ.c.0", new Date("2026-12-19T15:00:00.000Z"))).toBe("H2027");
    // 2026-12-19 00:30Z is still the 18th in ET.
    expect(calendarFrontMonth("MES.c.0", new Date("2026-12-19T00:30:00.000Z"))).toBe("Z2026");
  });

  it("cannot tell a volume-rolled series", () => {
    expect(calendarFrontMonth("MGC.v.0", new Date("2026-10-09T19:59:00.000Z"))).toBeNull();
  });
});

describe("tailRecord's seam", () => {
  const NS = BigInt(1_000_000);
  const at = (iso: string, open: number, close: number): Bar => ({
    tsUtc: BigInt(Date.parse(iso)) * NS,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: BigInt(1),
    symbol: "MNQ.c.0",
  });

  it("names both contracts and the jump from the archive's last close to the tail's first open", () => {
    const record = tailRecord(
      [at("2026-12-14T15:00:00.000Z", 25000, 25000), at("2026-12-14T15:01:00.000Z", 25250, 25251)],
      new Date("2026-12-14T15:00:00.000Z"),
      "CON.F.US.MNQ.H27",
      { cacheSymbol: "MNQ.c.0", tickSize: SPEC.tickSize },
    );
    expect(record.seam).toEqual({ cacheMonth: "Z2026", tailMonth: "H2027", gapTicks: 1000 });
  });

  it("has no gap when the tail served nothing", () => {
    const record = tailRecord(
      [at("2026-12-14T15:00:00.000Z", 25000, 25000)],
      new Date("2026-12-14T15:00:00.000Z"),
      "CON.F.US.MNQ.Z26",
      { cacheSymbol: "MNQ.c.0", tickSize: SPEC.tickSize },
    );
    expect(record.seam.gapTicks).toBeNull();
  });
});

describe("loadRunBars", () => {
  it("extends the fetch when the weekday walk-back came up short on rows", async () => {
    const { calls, load } = calendar(monthlyHoliday);
    const result = await loadRunBars({ args: ARGS, spec: SPEC, load });

    expect(calls).toHaveLength(2);
    expect(calls[1] < calls[0]).toBe(true);
    expect(result.warmupFrom).toBe(calls[1]);
    expect(
      completedRowsBefore(result.loaded.sessionDays, FROM),
    ).toBeGreaterThanOrEqual(CLASSIFIER_ROWS);
  });

  it("fetches once when the first walk-back already carried the rows", async () => {
    const { calls, load } = calendar(() => false);
    const result = await loadRunBars({ args: ARGS, spec: SPEC, load });

    expect(calls).toHaveLength(1);
    expect(result.warmupFrom).toBe(calls[0]);
  });

  it("refuses with both counts rather than labelling on half a baseline", async () => {
    const { calls, load } = calendar(everyMonday);
    await expect(loadRunBars({ args: ARGS, spec: SPEC, load })).rejects.toThrow(CliError);
    await expect(loadRunBars({ args: ARGS, spec: SPEC, load })).rejects.toThrow(
      /needs 275 completed session days before 2024-01-02/,
    );
    expect(calls).toHaveLength(4);
  });

  it("applies no row floor to a run that computes no label", async () => {
    const { calls, load } = calendar(everyMonday);
    const result = await loadRunBars({
      args: { ...ARGS, usesClassifier: false },
      spec: SPEC,
      load,
    });

    expect(calls).toHaveLength(1);
    expect(result.loaded.sessionDays.length).toBeGreaterThan(0);
  });
});
