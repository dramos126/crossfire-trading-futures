"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BarData } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";
import type { StrategyTrade } from "@/lib/db/trade-types";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import {
  COLOR_LONG,
  attachMarkerOverlay,
  autoscaleToTradeLevels,
  backtestReplayToMarker,
  buildArrowMarkers,
  convertUtcToEtDisplay,
  strategyTradeToMarker,
  type BacktestReplayResult,
  type TradeMarker,
} from "@/components/chart/trade-markers";
import { LegendSwatch, TradeLegend } from "@/components/chart/chart-legend";
import { ChartZoomControls } from "@/components/chart/chart-zoom-controls";
import { crosshairTime12h, liveBarTime, tickMark12h } from "@/components/chart/chart-time-format";

interface TradeChartProps {
  tradeId: number;
  /** Backtest replay result for this trade. When non-null and non-
   *  no_signal the chart paints hollow ghosted markers + brackets at
   *  --bt-bracket-alpha. Drives the conditional second/third legend
   *  rows. */
  btTrade?: BacktestReplayResult | null;
}

/** Chart height as a fraction of container width — 16:9 keeps candles
 *  readable across the app's 1152px content area without dominating
 *  the row. */
const ASPECT_RATIO = 9 / 16;

/** Minutes per bar for each timeframe. Used to bucket incoming live
 *  quotes into either "update the in-progress bar" or "push a new bar
 *  because the previous bucket closed." */
const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

interface ChartResponse {
  trade: StrategyTrade;
  bars: BarData[];
  timeframe: Timeframe;
}

/**
 * Per-trade chart for the deployments page expand-row. Lazy-fetches
 * bars for a tight window around the trade and renders entry + exit
 * markers + fill ticks via the shared trade-markers helpers. Open
 * trades show a dashed "current price" line so the user can see where
 * they'd close right now.
 */
export function TradeChart({ tradeId, btTrade = null }: TradeChartProps) {
  const { token, quotes } = useTrading();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const fitRef = useRef<() => void>(() => {});
  // Refs for the live-update effect to mutate the in-progress bar
  // without rebuilding the chart on every tick.
  //
  // `lastBarRef` is safe across a `data` change for two reasons, both outside
  // this ref. The chart effect is declared before the live effect, so on a
  // commit that changes both the rebuild resets the ref before a quote reads
  // it; and every instance is one trade's — the trade table mounts this per
  // row, keyed by trade — so a `tradeId` change never re-renders an instance
  // holding another trade's bars. A refetch for the same trade (a re-minted
  // session) rebuilds from bars at least as fresh as the live ones it drops.
  // Rendering one instance across trades would break the second reason: key
  // it by `tradeId` or reset `data` when `tradeId` changes.
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBarRef = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const [data, setData] = useState<ChartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch bars on mount. Token may be null briefly during sidebar
  // reconnect; the effect re-runs when token settles so the chart
  // hydrates as soon as auth is back.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/trades/${tradeId}/chart`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          setData(null);
        } else {
          setData(body as ChartResponse);
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
  }, [tradeId, token]);

  // Render the chart whenever bars/trade change. Mirrors the backtest
  // chart's effect: tear down on each change rather than mutating in
  // place, since lightweight-charts series instances are tied to chart
  // lifecycle.
  useEffect(() => {
    if (!containerRef.current || !data || data.bars.length === 0) return;
    const { bars, trade } = data;

    const initialWidth = containerRef.current.clientWidth;
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

    const marker = strategyTradeToMarker(trade);
    // Backtest replay → hollow marker. Side mirrors the live trade
    // (replay always assumes the same direction; drift is in price/
    // time, not direction). Null when no_signal — overlay drops it.
    const btMarker = btTrade ? backtestReplayToMarker(btTrade, trade.side) : null;
    const btMarkers: TradeMarker[] = btMarker ? [btMarker] : [];

    const candleSeries: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      autoscaleInfoProvider: autoscaleToTradeLevels(marker ? [marker, ...btMarkers] : btMarkers),
    });
    candleSeriesRef.current = candleSeries;
    const candleData: CandlestickData<UTCTimestamp>[] = bars.map((b) => ({
      time: convertUtcToEtDisplay(b.timestamp),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candleSeries.setData(candleData);
    lastBarRef.current = candleData[candleData.length - 1] ?? null;

    let detachOverlay: (() => void) | null = null;
    if (marker && containerRef.current) {
      const arrows = buildArrowMarkers([marker], bars, convertUtcToEtDisplay);
      arrows.sort((a, b) => (a.time as number) - (b.time as number));
      // Single trade always sits well below the density threshold so the
      // overlay will report verbose mode and the library markers do the
      // visual work. Wiring it anyway keeps the rendering pipeline
      // identical between the per-trade and multi-trade charts.
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
        btMarkers,
      );

      // drawFillTicks dropped — the overlay's finite-bracket envelope
      // (entry/TP/SL, dashed, 50% on open trades) replaces it.
    }

    // Pad ~15 bars of empty space past the last bar so the most recent
    // candle (and the open-trade dashed line) aren't flush against the
    // right edge. "Fit trade" re-applies this and re-enables price
    // autoscale in case the operator dragged the price axis.
    const lastIdx = bars.length - 1;
    const fit = () => {
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: lastIdx + 15 });
      chart.priceScale("right").applyOptions({ autoScale: true });
    };
    fit();
    fitRef.current = fit;

    // Defer one frame so the wrapper has its final 16:9 height before
    // scrollIntoView measures — otherwise we scroll to a 0px stub.
    requestAnimationFrame(() => {
      wrapperRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

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
      lastBarRef.current = null;
    };
  }, [data, btTrade]);

  // Live-tick updates: stream the open trade's contract quote into the
  // in-progress (rightmost) candle. Closed trades stay frozen on their
  // snapshot — no point streaming into bars whose outcome is settled.
  // The handler bucket-aligns each quote: same bucket as last bar →
  // mutate close/high/low; new bucket → append a fresh bar.
  const liveContractId = data?.trade.contractId ?? null;
  const isOpenTrade = data?.trade.exitFilledAt == null;
  const liveQuote = liveContractId ? quotes[liveContractId] : null;
  const liveTimeframe = data?.timeframe ?? null;
  useEffect(() => {
    if (!isOpenTrade || !liveQuote || !liveTimeframe) return;
    const series = candleSeriesRef.current;
    const lastBar = lastBarRef.current;
    if (!series || !lastBar) return;
    const quoteBarTime = liveBarTime(liveQuote.lastUpdated, TIMEFRAME_MINUTES[liveTimeframe]);
    if (quoteBarTime === null) return;
    if (quoteBarTime > (lastBar.time as number)) {
      // New bucket — open a fresh bar at the quote's mark.
      const fresh: CandlestickData<UTCTimestamp> = {
        time: quoteBarTime,
        open: liveQuote.mark,
        high: liveQuote.mark,
        low: liveQuote.mark,
        close: liveQuote.mark,
      };
      series.update(fresh);
      lastBarRef.current = fresh;
    } else if (quoteBarTime === (lastBar.time as number)) {
      // Same bucket — extend the in-progress candle.
      const updated: CandlestickData<UTCTimestamp> = {
        time: lastBar.time,
        open: lastBar.open,
        high: Math.max(lastBar.high, liveQuote.mark),
        low: Math.min(lastBar.low, liveQuote.mark),
        close: liveQuote.mark,
      };
      series.update(updated);
      lastBarRef.current = updated;
    }
    // Quotes older than the last bar (rare — clock skew or replay) are
    // silently dropped: rewriting closed bars would mis-state history.
  }, [liveQuote, liveTimeframe, isOpenTrade]);

  if (loading) {
    return (
      <div className="px-4 py-6 text-center text-xs text-[var(--muted)]">
        Loading chart for trade #{tradeId}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-6 text-center text-xs text-[var(--danger)]">
        Chart error: {error}
      </div>
    );
  }
  if (!data || data.bars.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-[var(--muted)]">
        No bars available for this trade window.
      </div>
    );
  }

  // Backtest row only renders when the replay produced a triggered
  // signal — no_signal / signal_drift collapse the row since there are
  // no markers to label. Status-pill row only renders when comparison
  // data is present at all.
  const hasBtSignal =
    btTrade != null &&
    btTrade.status !== "no_signal" &&
    btTrade.status !== "signal_drift";
  const hasComparison = btTrade != null;
  const marker = strategyTradeToMarker(data.trade);

  return (
    <div ref={wrapperRef} className="px-4 py-3 overflow-hidden bg-black">
      <div ref={containerRef} className="w-full overflow-hidden" />
      <div className="flex flex-wrap items-center gap-3 mt-2 text-[10px] text-[var(--muted)]">
        {marker && <TradeLegend marker={marker} />}
        <div className="ml-auto">
          <ChartZoomControls chartRef={chartRef} seriesRef={candleSeriesRef} onFit={() => fitRef.current()} />
        </div>
      </div>
      {hasBtSignal && (
        <div className="flex flex-wrap items-center gap-3 mt-1 pt-1 border-t border-[var(--card-border)] text-[10px] text-[var(--muted)]">
          <LegendSwatch color={COLOR_LONG} hollow label="BT: Entry ▲▼" />
          <LegendSwatch color="var(--success)" dashed faded label="BT TP" />
          <LegendSwatch color="var(--danger)" dashed faded label="BT SL" />
        </div>
      )}
      {hasComparison && (
        <div className="flex flex-wrap items-center gap-3 mt-1 pt-1 border-t border-[var(--card-border)] text-[10px] text-[var(--muted)]">
          <LegendPill bg="rgb(74 222 128 / 0.15)" border="var(--success)" label="MATCH" />
          <LegendPill bg="rgb(251 191 36 / 0.15)" border="var(--warning)" label="EXEC DRIFT" />
          <LegendPill bg="rgb(56 189 248 / 0.15)" border="var(--accent)" label="SIGNAL DRIFT" />
          <LegendPill bg="rgb(148 163 184 / 0.15)" border="var(--muted)" label="NO BT" />
        </div>
      )}
    </div>
  );
}

function LegendPill({
  bg,
  border,
  label,
}: {
  bg: string;
  border: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-flex items-center px-1.5 py-px rounded-sm text-[9px] font-mono font-semibold leading-none border"
        style={{ backgroundColor: bg, borderColor: border, color: border }}
      >
        {label}
      </span>
    </span>
  );
}

