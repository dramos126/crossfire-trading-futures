"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type LineData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BarData } from "@/lib/brokers/types";
import type { BacktestTrade, IndicatorSeries } from "@/lib/trading/backtest";
import {
  attachMarkerOverlay,
  backtestTradeToMarker,
  buildArrowMarkers,
  convertUtcToEtDisplay,
} from "@/components/chart/trade-markers";
import { LegendSwatch, MultiTradeLegend } from "@/components/chart/chart-legend";

interface BacktestChartProps {
  bars: BarData[];
  trades: BacktestTrade[];
  indicators: IndicatorSeries[];
  height?: number;
}

// Line colors cycled through for indicator overlays
const INDICATOR_COLORS = [
  "#4c9aff", // blue
  "#f59e0b", // amber
  "#a855f7", // purple
  "#14b8a6", // teal
  "#ec4899", // pink
];

export function BacktestChart({ bars, trades, indicators, height = 420 }: BacktestChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    // Bars from Topstep may come newest-first and can contain duplicates.
    // Build an ascending, unique-by-time index map so candles + indicator
    // lines + markers all share the same ordering.
    const sortedIndices = bars
      .map((b, i) => ({ t: new Date(b.timestamp).getTime(), i }))
      .sort((a, b) => a.t - b.t);

    const orderedBars: BarData[] = [];
    const originalToOrdered = new Map<number, number>();
    let lastTime = -Infinity;
    for (const { t, i } of sortedIndices) {
      if (t === lastTime) continue; // skip duplicate timestamps
      originalToOrdered.set(i, orderedBars.length);
      orderedBars.push(bars[i]);
      lastTime = t;
    }

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { color: "#000000" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    // ── Candles ─────────────────────────────────────────────────────
    const candleSeries: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    const candleData: CandlestickData<UTCTimestamp>[] = orderedBars.map((b) => ({
      time: convertUtcToEtDisplay(b.timestamp),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candleSeries.setData(candleData);

    // ── Indicator overlays (price-scale indicators only; RSI/MACD need panes) ──
    const overlayable = indicators.filter((ind) =>
      ["EMA", "SMA", "VWAP", "BOLL"].includes(ind.type),
    );

    const remap = (arr: (number | null)[]): (number | null)[] => {
      const out = new Array<number | null>(orderedBars.length).fill(null);
      for (const [orig, ord] of originalToOrdered) {
        const v = arr[orig];
        out[ord] = v == null || !Number.isFinite(v) ? null : v;
      }
      return out;
    };

    overlayable.forEach((ind, i) => {
      const color = INDICATOR_COLORS[i % INDICATOR_COLORS.length];

      addLineSeries(chart, orderedBars, remap(ind.values), color, `${ind.type} ${ind.id}`);

      if (ind.type === "BOLL" && ind.extra) {
        if (ind.extra.upper) {
          addLineSeries(chart, orderedBars, remap(ind.extra.upper), color, `${ind.id} upper`, true);
        }
        if (ind.extra.lower) {
          addLineSeries(chart, orderedBars, remap(ind.extra.lower), color, `${ind.id} lower`, true);
        }
      }
    });

    // ── Trade markers ───────────────────────────────────────────────
    // Build the normalized TradeMarker list once, then hand off to the
    // shared helper module (used here + by the per-trade chart on the
    // deployments page). Reusing one marker pipeline means the visual
    // language stays consistent across the app.
    const tradeMarkers = trades
      .filter((t) => {
        // Drop trades whose bars aren't in the rendered window.
        const e = originalToOrdered.get(t.entryBarIndex);
        const x = originalToOrdered.get(t.exitBarIndex);
        return e != null && x != null;
      })
      .map(backtestTradeToMarker);

    // Verbose-mode (sparse) renders text-labeled arrows via the library;
    // compact-mode renders custom shapes via the overlay. The overlay
    // calls onModeChange whenever the visible range crosses the density
    // threshold, and we toggle the library markers in response so the
    // two layers don't double-render.
    const arrowMarkers = buildArrowMarkers(tradeMarkers, bars, convertUtcToEtDisplay);
    arrowMarkers.sort((a, b) => (a.time as number) - (b.time as number));
    let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
    const setVerbose = (verbose: boolean) => {
      if (verbose) {
        if (!markersPlugin) markersPlugin = createSeriesMarkers(candleSeries, arrowMarkers);
        else markersPlugin.setMarkers(arrowMarkers);
      } else if (markersPlugin) {
        markersPlugin.setMarkers([]);
      }
    };
    // Default to verbose until the overlay tells us otherwise — most
    // backtests are sparse, and showing labels first matches the prior
    // behavior on cold render.
    setVerbose(true);

    const detachOverlay = attachMarkerOverlay(
      chart,
      candleSeries,
      containerRef.current,
      orderedBars,
      tradeMarkers,
      convertUtcToEtDisplay,
      (mode) => setVerbose(mode === "verbose"),
    );

    // Fill ticks dropped in favor of the finite-bracket envelope (overlay).
    // drawFillTicks stays exported for a future hover-gesture revival.

    chart.timeScale().fitContent();

    // Resize handler
    const resize = () => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
    };
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      detachOverlay();
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, trades, indicators, height]);

  if (bars.length === 0) {
    return (
      <div className="rounded-md border border-[var(--card-border)] bg-[var(--background)] p-6 text-center text-sm text-[var(--muted)]">
        No bars returned.
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} className="w-full" style={{ height }} />

      <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-[var(--muted)]">
        <MultiTradeLegend />
        {indicators
          .filter((i) => ["EMA", "SMA", "VWAP", "BOLL"].includes(i.type))
          .map((ind, i) => (
            <LegendSwatch
              key={ind.id}
              color={INDICATOR_COLORS[i % INDICATOR_COLORS.length]}
              label={`${ind.type} ${ind.id}`}
            />
          ))}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function addLineSeries(
  chart: IChartApi,
  bars: BarData[],
  values: (number | null)[],
  color: string,
  title: string,
  dashed = false,
) {
  const line = chart.addSeries(LineSeries, {
    color,
    lineWidth: 2,
    lineStyle: dashed ? 2 : 0, // 0 = solid, 2 = dashed
    priceLineVisible: false,
    lastValueVisible: false,
    title,
  });

  const data: LineData<UTCTimestamp>[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    data.push({
      time: convertUtcToEtDisplay(bars[i].timestamp),
      value: v,
    });
  }
  line.setData(data);
}
