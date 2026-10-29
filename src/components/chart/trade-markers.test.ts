// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoscaleInfo, Coordinate, ISeriesPrimitive, Logical, Time } from "lightweight-charts";
import {
  attachMarkerOverlay,
  autoscaleToTradeLevels,
  buildArrowMarkers,
  containingBarIndex,
  convertUtcToEtDisplay,
  strategyTradeToMarker,
  type OverlayChart,
  type OverlaySeries,
  type OverlayTimeScale,
  type TradeMarker,
} from "@/components/chart/trade-markers";
import type { BarData } from "@/lib/brokers/types";

const short: TradeMarker = {
  side: 1,
  entryTime: "2026-08-14T14:24:00Z",
  entryPrice: 30160,
  exitTime: "2026-08-14T19:55:00Z",
  exitPrice: 30126,
  exitReason: "manual",
  isWin: true,
  tpPrice: 29941,
  slPrice: 30269.5,
  mfePrice: 30025,
  maePrice: 30176.25,
};

const candles = (min: number, max: number) => (): AutoscaleInfo => ({
  priceRange: { minValue: min, maxValue: max },
});

describe("autoscaleToTradeLevels", () => {
  it("widens the axis to a TP and SL the candles never reached", () => {
    // The 2026-08-14 short: candles 30025–30195, target and stop outside.
    const range = autoscaleToTradeLevels([short])(candles(30025, 30195))?.priceRange;
    expect(range).toEqual({ minValue: 29941, maxValue: 30269.5 });
  });

  it("leaves the axis alone when every level is already inside it", () => {
    const range = autoscaleToTradeLevels([short])(candles(29900, 30300))?.priceRange;
    expect(range).toEqual({ minValue: 29900, maxValue: 30300 });
  });

  it("ignores levels the trade did not record", () => {
    const bare = { ...short, tpPrice: null, slPrice: null, mfePrice: null, maePrice: null };
    const range = autoscaleToTradeLevels([bare])(candles(30100, 30200))?.priceRange;
    expect(range).toEqual({ minValue: 30100, maxValue: 30200 });
  });

  it("passes through a null base range", () => {
    expect(autoscaleToTradeLevels([short])(() => null)).toBeNull();
  });
});

function barsEvery(minutes: number, startIso: string, count: number): BarData[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(start + i * minutes * 60_000).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

describe("containingBarIndex", () => {
  const fifteen = barsEvery(15, "2026-08-14T14:00:00.000Z", 8);

  it("lands a 1m timestamp on the 15m bar containing it, not the nearest", () => {
    // 14:44 is one minute from the 14:45 bar and inside the 14:30 one.
    expect(fifteen[containingBarIndex(fifteen, "2026-08-14T14:44:00.000Z")].timestamp).toBe(
      "2026-08-14T14:30:00.000Z",
    );
  });

  it("lands a timestamp on a bar's own open on that bar", () => {
    expect(containingBarIndex(fifteen, "2026-08-14T14:45:00.000Z")).toBe(3);
  });

  it("answers -1 before the first bar and the last bar after it", () => {
    expect(containingBarIndex(fifteen, "2026-08-14T13:59:00.000Z")).toBe(-1);
    expect(containingBarIndex(fifteen, "2026-08-14T23:00:00.000Z")).toBe(7);
  });
});

describe("buildArrowMarkers on a coarser chart than the trade's", () => {
  const trade: TradeMarker = {
    side: 0,
    entryTime: "2026-08-14T14:37:00.000Z",
    entryPrice: 30100,
    exitTime: "2026-08-14T15:13:00.000Z",
    exitPrice: 30150,
    exitReason: "tp",
    isWin: true,
    pnlTicks: 200,
  };

  it.each([
    [5, "2026-08-14T14:35:00.000Z", "2026-08-14T15:10:00.000Z"],
    [15, "2026-08-14T14:30:00.000Z", "2026-08-14T15:00:00.000Z"],
  ])("snaps entry and exit to their containing %im bars", (minutes, entryBar, exitBar) => {
    const bars = barsEvery(minutes, "2026-08-14T14:00:00.000Z", 120 / minutes);
    const [entry, exit] = buildArrowMarkers([trade], bars, convertUtcToEtDisplay);
    expect(entry.time).toBe(convertUtcToEtDisplay(entryBar));
    expect(exit.time).toBe(convertUtcToEtDisplay(exitBar));
  });
});

// bugs.md A20: the post-break-even SL line drew at entry while the broker's
// stop sat at entry ± the offset ticks.
describe("strategyTradeToMarker — the stop after break-even", () => {
  const closedLong = {
    side: 0 as const,
    entryPrice: 21000,
    entryFilledAt: "2026-10-20T14:00:00.000Z",
    entrySubmittedAt: "2026-10-20T14:00:00.000Z",
    exitPrice: 21000.5,
    exitFilledAt: "2026-10-20T15:00:00.000Z",
    exitReason: "Breakeven Stop",
    exitReasonCode: "breakeven_stop",
    pnlTicks: 2,
    pnlDollars: 1,
    desiredTpPrice: 21050,
    desiredSlPrice: 20990,
  };

  it("draws the SL at the stored break-even stop when the row has one", () => {
    const marker = strategyTradeToMarker({ ...closedLong, breakEvenMoved: true, breakEvenSlPrice: 21000.5 });
    expect(marker?.slPrice).toBe(21000.5);
  });

  it("draws the SL at entry when the row moved the stop but stored no price", () => {
    const marker = strategyTradeToMarker({ ...closedLong, breakEvenMoved: true, breakEvenSlPrice: null });
    expect(marker?.slPrice).toBe(21000);
  });

  it("draws the bracket as placed when break-even never moved the stop", () => {
    const marker = strategyTradeToMarker({ ...closedLong, breakEvenMoved: false, breakEvenSlPrice: null });
    expect(marker?.slPrice).toBe(20990);
  });
});

describe("attachMarkerOverlay — a paint that moves only the price axis", () => {
  // *Fit candles* and an axis drag change the price scale and not the time
  // range, so the time scale's range event never fires for them; the overlay
  // learns of every paint through a series primitive instead. Left on the
  // range event alone, the lines kept the pixel rows of the previous scale.
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    for (const cb of frames.splice(0)) cb(0);
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    // jsdom has no canvas. Every method the draw calls is a no-op except
    // the one whose answer it reads.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      new Proxy({}, {
        get: (_, key) => (key === "measureText" ? () => ({ width: 0 }) : () => undefined),
      }) as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redraws the lines from the new scale, and stops when detached", () => {
    const timeScale = {
      getVisibleLogicalRange: () => ({ from: 0 as Logical, to: 20 as Logical }),
      timeToCoordinate: () => 50 as Coordinate,
      logicalToCoordinate: () => 90 as Coordinate,
    } satisfies OverlayTimeScale;
    const chart = { timeScale: () => timeScale } satisfies OverlayChart;
    let primitive: ISeriesPrimitive<Time> | null = null;
    const priceToCoordinate = vi.fn(() => 40 as Coordinate);
    const series = {
      priceToCoordinate,
      attachPrimitive: (p: ISeriesPrimitive<Time>) => { primitive = p; },
      detachPrimitive: () => { primitive = null; },
    } satisfies OverlaySeries;
    const bars = barsEvery(5, "2026-08-14T13:30:00Z", 100);

    const detach = attachMarkerOverlay(chart, series, document.createElement("div"), bars, [short], convertUtcToEtDisplay, () => {});
    flushFrames();
    const linesPerDraw = priceToCoordinate.mock.calls.length;
    expect(linesPerDraw).toBeGreaterThan(0);

    // What the chart does on every paint — Fit candles included.
    primitive!.updateAllViews!();
    flushFrames();
    expect(priceToCoordinate.mock.calls.length).toBe(linesPerDraw * 2);

    detach();
    expect(primitive).toBeNull();
  });
});
