"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BarData } from "@/lib/brokers/types";
import type { TickerSymbol, Timeframe } from "@/lib/trading/domain";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import {
  attachMarkerOverlay,
  autoscaleToTradeLevels,
  buildArrowMarkers,
  convertUtcToEtDisplay,
  type TradeMarker,
} from "@/components/chart/trade-markers";
import { chartWindowFor, initialLogicalRange } from "@/components/backtest/backtest-run-window";
import { TradeLegend } from "@/components/chart/chart-legend";
import { ChartZoomControls } from "@/components/chart/chart-zoom-controls";
import { crosshairTime12h, tickMark12h } from "@/components/chart/chart-time-format";
import { openingRangeLines } from "@/components/backtest/backtest-run-opening-range";

interface BacktestTradeChartProps {
  /**
   * The trade, already normalised.
   *
   * It took a `BacktestTrade` and called `backtestTradeToMarker` itself
   * until the run reader arrived with a third source shape
   * (`CliTradeRecord`, off `trades.jsonl`). Converting at the call site
   * keeps `trade-markers.ts` the sole place a domain type becomes a marker,
   * which is the extension-point rule — the alternative was a prop union
   * and a branch inside a chart component, which is marker logic in JSX
   * wearing a different hat.
   */
  marker: TradeMarker;
  ticker: TickerSymbol;
  timeframe: Timeframe;
  /** Bars in view before the entry bar. Defaults to 30. */
  preBars?: number;
  /** Bars in view after the exit bar. Defaults to 15. */
  postBars?: number;
  /** Load the trade's whole Globex session and open on all of it instead
   *  of the tight window. Off by default. */
  wholeDay?: boolean;
  /** The trade's session (`YYYY-MM-DD`), for the opening range lines. */
  sessionDate?: string;
  /** The trade's recorded opening range, used when the loaded bars do not
   *  reach back to 09:30. Plain numbers so the chart effect stays stable. */
  rangeHigh?: number | null;
  rangeLow?: number | null;
}

/** Thin blue dotted, semi-transparent — the operator's spec. */
const OPENING_RANGE_COLOR = "rgba(59, 130, 246, 0.55)";

/** Same 16:9 aspect ratio as the live per-trade chart. */
const ASPECT_RATIO = 9 / 16;

/** Bars loaded beyond the view on each side, so zooming out has
 *  somewhere to go. 240 one-minute bars is four hours. */
const CONTEXT_BARS = 240;

interface BarsResponse {
  bars: BarData[];
  timeframe: Timeframe;
}

interface Loaded {
  bars: BarData[];
}

/**
 * Per-trade chart for the backtest results table expand-row and the run
 * reader. Lazy-fetches a tight bar window around a single backtest trade —
 * or its whole session, with `wholeDay` (loaded, not opened on) — at whatever `timeframe` it is
 * given, which need not be the one the trade ran on, and renders the same
 * marker/overlay pipeline as the live `TradeChart`. Backtest trades are
 * always closed, so there's no live-quote streaming.
 */
export function BacktestTradeChart({
  marker,
  ticker,
  timeframe,
  preBars = 30,
  postBars = 15,
  wholeDay = false,
  sessionDate,
  rangeHigh = null,
  rangeLow = null,
}: BacktestTradeChartProps) {
  // Both are non-null for every closed trade this chart is given; the
  // fallbacks keep the window arithmetic total rather than asserting.
  const entryTs = marker.entryTime;
  const exitTs = marker.exitTime ?? marker.entryTime;
  const { token } = useTrading();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const span = chartWindowFor({
      entryIso: entryTs,
      exitIso: exitTs,
      timeframe,
      wholeDay,
      preBars,
      postBars,
      contextBars: CONTEXT_BARS,
    });
    const params = new URLSearchParams({ ticker, timeframe, from: span.fromIso, to: span.toIso });
    fetch(`/api/backtest/bars?${params.toString()}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          setData(null);
        } else {
          setData({ bars: (body as BarsResponse).bars });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, ticker, timeframe, entryTs, exitTs, preBars, postBars, wholeDay]);

  // Render the chart on each data change. Mirrors trade-chart.tsx — tear
  // down on prop changes since lightweight-charts series instances are
  // chart-lifetime bound.
  useEffect(() => {
    if (!containerRef.current || !data || data.bars.length === 0) return;
    const { bars } = data;

    const initialWidth = containerRef.current.clientWidth || 800;
    const chart = createChart(containerRef.current, {
      width: initialWidth,
      height: Math.round(initialWidth * ASPECT_RATIO),
      layout: { background: { color: "#000000" }, textColor: "#9ca3af" },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: tickMark12h,
      },
      localization: { timeFormatter: crosshairTime12h },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const candleSeries: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      autoscaleInfoProvider: autoscaleToTradeLevels([marker]),
    });
    const candleData: CandlestickData<UTCTimestamp>[] = bars.map((b) => ({
      time: convertUtcToEtDisplay(b.timestamp),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candleSeries.setData(candleData);
    candleSeriesRef.current = candleSeries;

    // Built with the chart, not added later, so they can never rebuild it or
    // move the view: off the autoscale and the price axis.
    const orLines = sessionDate ? openingRangeLines(bars, sessionDate, { high: rangeHigh, low: rangeLow }) : null;
    if (orLines) {
      for (const price of [orLines.high, orLines.low]) {
        chart
          .addSeries(LineSeries, {
            color: OPENING_RANGE_COLOR,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
          })
          .setData([
            { time: orLines.from, value: price },
            { time: orLines.to, value: price },
          ]);
      }
    }

    let detachOverlay: (() => void) | null = null;
    if (containerRef.current) {
      const arrows = buildArrowMarkers([marker], bars, convertUtcToEtDisplay);
      arrows.sort((a, b) => (a.time as number) - (b.time as number));
      let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
      const setVerbose = (verbose: boolean) => {
        if (verbose) {
          if (!markersPlugin) markersPlugin = createSeriesMarkers(candleSeries, arrows);
          else markersPlugin.setMarkers(arrows);
        } else if (markersPlugin) {
          markersPlugin.setMarkers([]);
        }
      };
      setVerbose(true);
      detachOverlay = attachMarkerOverlay(
        chart,
        candleSeries,
        containerRef.current,
        bars,
        [marker],
        convertUtcToEtDisplay,
        (mode) => setVerbose(mode === "verbose"),
      );
    }

    // Always open on the trade, Whole day or not; the bars beyond stay
    // loaded for zooming out. "Fit trade" re-applies this
    // and re-enables price autoscale in case the operator dragged the axis.
    const range = initialLogicalRange(bars, entryTs, exitTs, preBars, postBars);
    const fit = () => {
      chart.timeScale().setVisibleLogicalRange(range);
      chart.priceScale("right").applyOptions({ autoScale: true });
    };
    fit();
    fitRef.current = fit;

    const resize = () => {
      if (!containerRef.current || !chartRef.current) return;
      const w = containerRef.current.clientWidth;
      chartRef.current.applyOptions({ width: w, height: Math.round(w * ASPECT_RATIO) });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      detachOverlay?.();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [data, marker, entryTs, exitTs, preBars, postBars, sessionDate, rangeHigh, rangeLow]);

  const showOverlay = loading || error || (!data || data.bars.length === 0);

  return (
    <div className="overflow-hidden bg-black">
      {/* Chart container always mounted so its width is measurable by the
          useEffect. Hidden behind the overlay while loading. */}
      <div
        ref={containerRef}
        className="w-full overflow-hidden aspect-video"
        style={{ display: showOverlay ? "none" : undefined }}
      />
      {showOverlay && (
        <div className="w-full aspect-video flex items-center justify-center text-xs bg-black">
          {loading && <span className="text-[var(--muted)]">Loading chart…</span>}
          {!loading && error && <span className="text-[var(--danger)]">Chart error: {error}</span>}
          {!loading && !error && <span className="text-[var(--muted)]">No bars available for this trade window.</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 mt-2 px-3 pb-2 text-xs text-[var(--muted)] bg-black">
        <TradeLegend marker={marker} />
        {!showOverlay && (
          <div className="ml-auto">
            <ChartZoomControls chartRef={chartRef} seriesRef={candleSeriesRef} onFit={() => fitRef.current()} />
          </div>
        )}
      </div>
    </div>
  );
}
