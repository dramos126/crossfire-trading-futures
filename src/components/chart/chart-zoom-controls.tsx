"use client";

import type { RefObject } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";

/** How much one click widens or narrows the visible bar range. */
const ZOOM_STEP = 1.5;

/** Headroom above and below the candles, as a fraction of their range. */
const CANDLE_PAD = 0.08;

/**
 * Zoom out / zoom in / fit buttons for a per-trade chart. Mouse-wheel and
 * drag still work; these are for a trackpad, and for getting back to the
 * trade after panning away. `onFit` is the chart's own initial view.
 * *Fit candles* sizes the price axis to the candles in view alone — a
 * target or stop far from price otherwise squeezes them flat.
 */
export function ChartZoomControls({
  chartRef,
  seriesRef,
  onFit,
}: {
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<"Candlestick"> | null>;
  onFit: () => void;
}) {
  const fitCandles = () => {
    const range = chartRef.current?.timeScale().getVisibleLogicalRange();
    const series = seriesRef.current;
    if (!range || !series) return;
    const bars = series.data();
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length - 1, Math.ceil(range.to));
    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i <= to; i++) {
      const bar = bars[i];
      if (!("high" in bar)) continue;
      low = Math.min(low, bar.low);
      high = Math.max(high, bar.high);
    }
    if (!Number.isFinite(low)) return;
    const pad = (high - low) * CANDLE_PAD || 1;
    series.priceScale().setVisibleRange({ from: low - pad, to: high + pad });
  };
  const zoom = (factor: number) => {
    const timeScale = chartRef.current?.timeScale();
    const range = timeScale?.getVisibleLogicalRange();
    if (!timeScale || !range) return;
    const mid = (range.from + range.to) / 2;
    const half = ((range.to - range.from) / 2) * factor;
    timeScale.setVisibleLogicalRange({ from: mid - half, to: mid + half });
  };
  return (
    <div className="flex items-center gap-1">
      <ZoomButton label="−" title="Zoom out" onClick={() => zoom(ZOOM_STEP)} />
      <ZoomButton label="+" title="Zoom in" onClick={() => zoom(1 / ZOOM_STEP)} />
      <ZoomButton label="Fit candles" title="Fit the height to the candles in view" onClick={fitCandles} />
      <ZoomButton label="Fit trade" title="Back to the trade" onClick={onFit} />
    </div>
  );
}

function ZoomButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="px-2 py-0.5 rounded-md border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] font-mono"
    >
      {label}
    </button>
  );
}
