/**
 * Trade marker rendering — shared between the multi-trade backtest chart
 * and the single-trade chart on the deployments page. Pure helpers, no
 * React. Consumers convert their domain types (BacktestTrade,
 * StrategyTrade) to the common TradeMarker shape and hand off.
 */

import {
  LineSeries,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ITimeScaleApi,
  type LineData,
  type Logical,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BarData } from "@/lib/brokers/types";
import { chipForExitReason } from "@/components/exit-reason-chips";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";

/** Threshold above which the chart switches from verbose (text labels)
 *  to compact (custom shapes only) marker rendering. Tuned by feel —
 *  see PR 4 in docs/punchlist.md. Hysteresis can be added later if
 *  zoom-induced flicker becomes a problem. */
export const COMPACT_DENSITY_THRESHOLD = 15;

// ── ET-display time conversion (DST-aware, per-day cached) ─────────
//
// Lightweight-charts renders timestamps as UTC, so to make NY wall-clock
// time appear on axes we project each UTC instant through ET and re-emit
// the wall-clock as if it were UTC. formatToParts is ~100-200µs per call —
// fine for one trade, catastrophic for 375k bars (3Y × 1m). We cache the
// UTC→ET offset per UTC calendar day. DST transitions happen at 2am ET
// and are captured because we recompute the offset at the exact ms of
// each new UTC day boundary. Within a day the offset is stable, so a
// single formatToParts per day covers all intraday bars.

const etPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Keyed by UTC date string "YYYY-MM-DD". Value = ET offset in ms relative
// to UTC at the start of that UTC day (negative for ET which is UTC-4 or UTC-5).
const etOffsetCache = new Map<string, number>();

function getEtOffsetMs(utcDayKey: string, sampleMs: number): number {
  const cached = etOffsetCache.get(utcDayKey);
  if (cached !== undefined) return cached;

  const parts = etPartsFormatter.formatToParts(new Date(sampleMs));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") mo = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
    else if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") mi = Number(p.value);
    else if (p.type === "second") s = Number(p.value);
  }
  if (h === 24) h = 0;
  const etWallMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = etWallMs - sampleMs;
  etOffsetCache.set(utcDayKey, offset);
  return offset;
}

export function convertUtcToEtDisplay(iso: string): UTCTimestamp {
  const ms = new Date(iso).getTime();
  // "YYYY-MM-DD" slice avoids allocating a Date just for the key.
  const dayKey = iso.slice(0, 10);
  const offset = getEtOffsetMs(dayKey, ms);
  return Math.floor((ms + offset) / 1000) as UTCTimestamp;
}

// ── Public types ───────────────────────────────────────────────────

/** Reason a trade exited. Determines the exit-marker label + color. */
export type TradeMarkerExitReason = "tp" | "sl" | "signal" | "time" | "manual" | null;

/** Normalized trade for chart rendering. Both BacktestTrade (multi-trade
 *  backtest chart) and StrategyTrade (per-trade live chart) convert to
 *  this shape so the rendering helpers stay decoupled from data sources. */
export interface TradeMarker {
  side: 0 | 1;
  /** ISO timestamp of the bar where the entry filled. */
  entryTime: string;
  entryPrice: number;
  /** ISO timestamp of the exit bar. Null for still-open trades. */
  exitTime: string | null;
  /** Actual exit fill price. Null for still-open trades. */
  exitPrice: number | null;
  exitReason: TradeMarkerExitReason;
  /** Win/loss classification — drives exit-tick color. Null for open trades. */
  isWin: boolean | null;
  /** Optional PnL in ticks for the exit label. */
  pnlTicks?: number | null;
  /** Take-profit price for the finite-bracket renderer. Null when the
   *  trade lacks bracket info (older backtest serializations). */
  tpPrice?: number | null;
  /** Stop-loss price for the finite-bracket renderer. If breakEvenMoved,
   *  this is the post-BE level — matches the line that actually got hit. */
  slPrice?: number | null;
  /** True when BE fired during the trade. Drives the SL-line color +
   *  legend treatment for the finite bracket. */
  breakEvenMoved?: boolean;
  /**
   * The *precise* exit reason, as the producing side wrote it — an
   * `ExitReason` off a backtest or a run artifact, an `ExitReasonCode` off
   * a live row, or a rendered label from a row that predates the code
   * column. Optional and never load-bearing: `exitReason` above stays the
   * five-value normalisation that decides colour and glyph, and this only
   * sharpens the marker's *text*.
   *
   * It exists because `EXIT` was rendered over four different endings — a
   * strategy signal, a time stop, a session close and a run hitting the end
   * of its bars — and those are the distinctions a trader reads a chart to
   * make. See `exitLabel`.
   */
  exitCode?: string | null;
  /**
   * The best and worst prices the trade reached between entry and exit.
   *
   * Prices rather than the `mfeTicks` / `maeTicks` the artifact records,
   * because every other level on this type is a price and the overlay
   * speaks `priceToCoordinate`. The adapter that has a tick size does the
   * conversion; one that does not leaves these null and no excursion is
   * drawn, which is the honest render of a quantity nothing measured.
   */
  mfePrice?: number | null;
  maePrice?: number | null;
}

/** Live "current price" for an open trade. Drives the dashed
 *  would-exit-here line on the per-trade chart. Optional — multi-trade
 *  backtest charts don't provide one because all backtest trades are
 *  closed by definition. */
export interface OpenTradeContext {
  /** Current market price (typically last bar's close). */
  currentPrice: number;
  /** ISO of the most-recent bar; the dashed line stops here. */
  currentBarTime: string;
}

// ── Colors (single source of truth) ────────────────────────────────
//
// Marker taxonomy (PR 4):
//   Entry (long + short): blue — both directions share the same entry color
//   TP exit:              green (profit-side outcome)
//   SL exit:              red   (loss-side outcome)
//   Break-even / other:   muted gray (neutral / scratch)
//
// COLOR_LONG / COLOR_SHORT are kept as named aliases so palette reads
// remain self-documenting, but they now resolve to the same blue so the
// taxonomy is enforced at the constant level, not the call site.

export const COLOR_LONG = "#3b82f6";       // blue — long entry
export const COLOR_SHORT = "#3b82f6";      // blue — short entry (same as long per taxonomy)
export const COLOR_WIN = "#10b981";        // green — TP / win
export const COLOR_LOSS = "#ef4444";       // red   — SL / loss
export const COLOR_FLAT_EXIT = "#9ca3af";  // gray  — BE / scratch / signal / time / manual
export const COLOR_OPEN_NEUTRAL = "#9ca3af";

/** Exit color from reason — pure taxonomy, reason-first. TP is always
 *  green; SL is always red; everything else (signal/time/manual/be) is
 *  muted gray regardless of the win/loss outcome. The old win/loss
 *  fallback created inconsistency when a signal exit happened to be
 *  profitable — it colored it green like a TP, misleading the reader. */
export function exitColor(reason: TradeMarkerExitReason, _isWin: boolean | null): string {
  if (reason === "tp") return COLOR_WIN;
  if (reason === "sl") return COLOR_LOSS;
  return COLOR_FLAT_EXIT;
}

/**
 * Short label shown on the exit marker.
 *
 * **The code comes from `exit-reason-chips.ts`, which is the same table the
 * trades table's chip reads.** One vocabulary: a `TWC` on a chart and a
 * `TWC` on a row are the same ending, and a second table of three-letter
 * codes here would be free to drift from that one. It renders text only —
 * colour and glyph still come from `exitColor` and the taxonomy, so this
 * cannot introduce a state the palette does not have.
 *
 * The bare-`reason` arm survives for a marker with no `exitCode` **and for
 * one whose code nothing recognises**: the multi-trade path and older
 * serializations carry the normalised five-value reason and nothing finer,
 * and `EXIT` is the honest label when the specific ending was never
 * recorded. That is why this reads `chipForExitReason`, which answers null,
 * rather than the residual-arm variant — stamping `STR` on an unrecognised
 * string would claim the strategy called an exit it may not have.
 */
export function exitLabel(
  reason: TradeMarkerExitReason,
  pnlTicks: number | null | undefined,
  exitCode?: string | null,
): string {
  const ticksSuffix = pnlTicks != null
    ? ` ${pnlTicks >= 0 ? "+" : ""}${Math.round(pnlTicks)}t`
    : "";
  const chip = chipForExitReason(exitCode);
  if (chip != null) return `${chip.code}${ticksSuffix}`;
  if (reason === "tp") return `TP${ticksSuffix}`;
  if (reason === "sl") return `SL${ticksSuffix}`;
  return `EXIT${ticksSuffix}`;
}

// ── Marker construction ────────────────────────────────────────────

/**
 * Build the arrow markers (entry BUY/SELL above/below bar, exit
 * label above/below bar) from a list of normalized trades. Caller is
 * responsible for sorting markers by time before handing to
 * `createSeriesMarkers`.
 *
 * `convertTime` is the same NY-aware UTC-display converter the chart uses
 * to align candle times with markers. Passed in so the helper module
 * stays pure and doesn't duplicate the timezone logic.
 *
 * Markers snap to the bar that *contains* the fill so a fill at 13:39:58
 * lands on the 13:35 bar (its containing 5-min bucket), not the 13:40 bar
 * that lightweight-charts would otherwise round to.
 */
export function buildArrowMarkers(
  trades: TradeMarker[],
  bars: BarData[],
  convertTime: (iso: string) => UTCTimestamp,
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];
  for (const t of trades) {
    const isLong = t.side === 0;

    // Entry arrow — below bar for longs (arrowUp points into upward move),
    // above bar for shorts (arrowDown points into downward move).
    markers.push({
      time: convertTime(snapToContainingBar(bars, t.entryTime)),
      position: isLong ? "belowBar" : "aboveBar",
      color: COLOR_LONG, // both long + short entries use the same blue per taxonomy
      shape: isLong ? "arrowUp" : "arrowDown",
      text: isLong ? "BUY" : "SELL",
    });

    // Exit marker — shape and color follow the marker taxonomy:
    //   TP:         arrowUp/arrowDown in the profit direction  → green
    //   SL:         arrowDown/arrowUp against the trade        → red
    //   BE/other:   circle (nearest native to ◆ diamond)       → muted gray
    // Position is opposite the entry side so they don't overlap on tight ranges.
    if (t.exitTime != null && t.exitPrice != null) {
      const color = exitColor(t.exitReason, t.isWin);
      // TP points in the direction of profit (same as entry arrow).
      // SL points opposite the trade (same shape as entry but flipped).
      // BE / other use circle — lightweight-charts has no diamond native.
      const shape: SeriesMarker<Time>["shape"] =
        t.exitReason === "tp"
          ? isLong ? "arrowUp" : "arrowDown"
          : t.exitReason === "sl"
            ? isLong ? "arrowDown" : "arrowUp"
            : "circle";
      markers.push({
        time: convertTime(snapToContainingBar(bars, t.exitTime)),
        position: isLong ? "aboveBar" : "belowBar",
        color,
        shape,
        text: exitLabel(t.exitReason, t.pnlTicks ?? null, t.exitCode),
      });
    }
  }
  return markers;
}

/**
 * A candle-series `autoscaleInfoProvider` that widens the price axis to
 * hold every level the trades draw — entry, TP, SL, best and worst.
 *
 * For per-trade charts only. Without it the axis fits the candles alone,
 * so a TP or SL that price never reached is drawn off-screen and the
 * chart silently hides the risk and the target. A multi-trade chart
 * would stretch to every trade's levels at once, so it does not use this.
 */
export function autoscaleToTradeLevels(trades: TradeMarker[]) {
  const levels = trades
    .flatMap((t) => [t.entryPrice, t.tpPrice, t.slPrice, t.mfePrice, t.maePrice])
    .filter((p): p is number => p != null && Number.isFinite(p));
  return (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const info = base();
    if (info?.priceRange == null || levels.length === 0) return info;
    return {
      ...info,
      priceRange: {
        minValue: Math.min(info.priceRange.minValue, ...levels),
        maxValue: Math.max(info.priceRange.maxValue, ...levels),
      },
    };
  };
}

/** Index of the bar containing `iso`: the largest `bar.timestamp ≤ iso`, so
 *  a fill anywhere inside a bucket lands on the bucket's start — a 1m fill
 *  on a 15m chart included. -1 when no bar precedes it. Bars ascending. */
export function containingBarIndex(
  bars: readonly Pick<BarData, "timestamp">[],
  iso: string,
): number {
  const target = new Date(iso).getTime();
  let lo = 0;
  let hi = bars.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(bars[mid].timestamp).getTime() <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Falls back to the raw iso if no bar precedes it (a fill before the
 *  fetched window — the chart clips the marker out anyway). */
function snapToContainingBar(bars: BarData[], iso: string): string {
  const idx = containingBarIndex(bars, iso);
  return idx >= 0 ? bars[idx].timestamp : iso;
}

// ── Fill-price ticks ───────────────────────────────────────────────

/**
 * Find the index of the bar closest to (or matching) an ISO timestamp.
 * Returns -1 if bars is empty. Used to position fill ticks since they
 * extend forward N bars from the trade bar.
 */
function findBarIndex(bars: BarData[], iso: string): number {
  if (bars.length === 0) return -1;
  const target = new Date(iso).getTime();
  // Bars are pre-sorted ascending; binary-search would be nice but linear
  // is fine for typical N (per-trade chart: ~40 bars; backtest: ~thousands
  // but only called per trade).
  let best = 0;
  let bestDelta = Math.abs(new Date(bars[0].timestamp).getTime() - target);
  for (let i = 1; i < bars.length; i++) {
    const d = Math.abs(new Date(bars[i].timestamp).getTime() - target);
    if (d < bestDelta) {
      best = i;
      bestDelta = d;
    }
  }
  return best;
}

/**
 * Draw a short horizontal "tick" at a specific price level, spanning
 * `widthBars` bars starting at the given bar index. Implemented as a
 * dedicated LineSeries with two points so it sits *above* the candles
 * (markers are bound to bar tops/bottoms; LineSeries can sit at any price).
 */
function drawFillTick(
  chart: IChartApi,
  bars: BarData[],
  startBarIndex: number,
  widthBars: number,
  price: number,
  color: string,
  convertTime: (iso: string) => UTCTimestamp,
): ISeriesApi<"Line"> | null {
  if (startBarIndex < 0 || startBarIndex >= bars.length) return null;
  const endBarIndex = Math.min(startBarIndex + widthBars, bars.length - 1);
  if (endBarIndex <= startBarIndex) return null;

  const series = chart.addSeries(LineSeries, {
    color,
    lineWidth: 2,
    lineStyle: 0,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    // Title intentionally omitted — lightweight-charts renders titles in
    // the right-side gutter, which would push the chart's width past
    // its container and trigger a horizontal scrollbar. The legend
    // beneath the chart already documents what each color means.
  });

  const data: LineData<UTCTimestamp>[] = [
    { time: convertTime(bars[startBarIndex].timestamp), value: price },
    { time: convertTime(bars[endBarIndex].timestamp), value: price },
  ];
  series.setData(data);
  return series;
}

/**
 * Draw entry + exit fill ticks for every closed trade, plus an optional
 * "live" dashed line at current price for any open trade.
 *
 * Returns the created LineSeries handles so the caller can dispose them
 * if it ever needs to reset markers without tearing down the whole chart.
 * In typical use the chart is recreated on prop changes (today's pattern)
 * so the handles can be ignored.
 */
export function drawFillTicks(
  chart: IChartApi,
  bars: BarData[],
  trades: TradeMarker[],
  convertTime: (iso: string) => UTCTimestamp,
  openContext: OpenTradeContext | null = null,
  widthBars = 3,
): ISeriesApi<"Line">[] {
  const created: ISeriesApi<"Line">[] = [];

  for (const t of trades) {
    const isLong = t.side === 0;
    const entryColor = isLong ? COLOR_LONG : COLOR_SHORT;

    // Entry tick: starts at the entry bar, runs forward 3 bars.
    const entryIdx = findBarIndex(bars, t.entryTime);
    const entryTick = drawFillTick(
      chart, bars, entryIdx, widthBars, t.entryPrice, entryColor,
      convertTime,
    );
    if (entryTick) created.push(entryTick);

    // Exit tick: same width, color reflects win/loss/exit-reason.
    if (t.exitTime != null && t.exitPrice != null) {
      const exitIdx = findBarIndex(bars, t.exitTime);
      const color = exitColor(t.exitReason, t.isWin);
      const exitTick = drawFillTick(
        chart, bars, exitIdx, widthBars, t.exitPrice, color,
        convertTime,
      );
      if (exitTick) created.push(exitTick);
    }
  }

  // Open-trade indicator: dashed line at current price, runs from the
  // entry bar of the open trade(s) to the most recent bar. Helps the
  // user see where the trade would close right now relative to entry.
  if (openContext) {
    const openTrades = trades.filter((t) => t.exitTime == null);
    for (const t of openTrades) {
      const entryIdx = findBarIndex(bars, t.entryTime);
      const endIdx = findBarIndex(bars, openContext.currentBarTime);
      if (entryIdx < 0 || endIdx < 0 || endIdx <= entryIdx) continue;
      const series = chart.addSeries(LineSeries, {
        color: COLOR_OPEN_NEUTRAL,
        lineWidth: 1,
        lineStyle: 2, // dashed
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        // Title omitted to avoid right-gutter labels causing
        // horizontal scroll inside narrow containers.
      });
      series.setData([
        { time: convertTime(bars[entryIdx].timestamp), value: openContext.currentPrice },
        { time: convertTime(bars[endIdx].timestamp), value: openContext.currentPrice },
      ]);
      created.push(series);
    }
  }

  return created;
}

// ── Conversion helpers (data-source → TradeMarker) ─────────────────

/**
 * Normalize a free-form exit-reason string into the marker enum. The
 * backtest emits a typed ExitReason union; the live engine writes
 * free-form text into the DB. Both flow through this single function so
 * the substring fallback can't drift away from the typed match. Anything
 * unrecognized returns null — caller decides whether that's "manual" or
 * "still open."
 *
 * Substring order matters: "breakeven_stop" must match before "stop"
 * triggers the SL branch (which it intentionally does — a BE stop hit
 * is visually still an SL hit, just at the BE-moved level).
 */
function normalizeExitReason(raw: string | null | undefined): TradeMarkerExitReason {
  if (raw == null) return null;
  const text = raw.toLowerCase();
  if (text === "take_profit" || text.includes("tp") || text.includes("take")) return "tp";
  if (text === "stop_loss" || text === "breakeven_stop" || text.includes("sl") || text.includes("stop")) return "sl";
  if (text.includes("signal")) return "signal";
  if (text === "time_window_close" || text === "end_of_data" || text.includes("time") || text.includes("session")) return "time";
  if (text.includes("manual") || text.includes("flatten")) return "manual";
  return null;
}

// ── Unified marker assembly ────────────────────────────────────────
//
// Both adapters below normalize their domain-specific input fields into
// the common TradeMarker shape, then hand off to assembleTradeMarker.
// PRs 4 and 5 (density modes, new taxonomy, tethering) should make their
// changes HERE — one place, both chart paths pick it up automatically.

/**
 * Single assembly point for the TradeMarker pipeline. Receives an already-
 * normalized TradeMarker and returns the final marker object. Both
 * backtestTradeToMarker and strategyTradeToMarker funnel through here so
 * PRs 4+ only need to extend one function.
 *
 * Currently a passthrough — behavior is added in subsequent PRs.
 */
function assembleTradeMarker(m: TradeMarker): TradeMarker {
  return m;
}

/**
 * BacktestTrade → TradeMarker. Backtest trades are always closed and
 * carry pnlTicks; isWin derives from sign.
 */
export function backtestTradeToMarker(t: {
  side: 0 | 1;
  entryTimestamp: string;
  entryPrice: number;
  exitTimestamp: string;
  exitPrice: number;
  exitReason: string;
  pnlTicks: number;
  tpPrice?: number;
  slPrice?: number;
  breakEvenMoved?: boolean;
}): TradeMarker {
  // Backtest reasons always map cleanly via normalizeExitReason; an
  // unrecognized string falls back to "manual" so the chart still draws
  // a generic exit instead of dropping the marker.
  const reason = normalizeExitReason(t.exitReason) ?? "manual";
  return assembleTradeMarker({
    side: t.side,
    entryTime: t.entryTimestamp,
    entryPrice: t.entryPrice,
    exitTime: t.exitTimestamp,
    exitPrice: t.exitPrice,
    exitReason: reason,
    isWin: t.pnlTicks > 0,
    pnlTicks: t.pnlTicks,
    tpPrice: t.tpPrice ?? null,
    slPrice: t.slPrice ?? null,
    breakEvenMoved: t.breakEvenMoved ?? false,
    exitCode: t.exitReason,
  });
}

/**
 * `CliTradeRecord` (a `trades.jsonl` row) → `TradeMarker`.
 *
 * The third adapter, and the first whose input never went through
 * `runBacktest` in this process — it is a line of JSON some earlier build
 * of the CLI wrote, so every field is read as given and none is recomputed.
 *
 * `tickSize` comes from the run header's contract block and is what turns
 * the recorded `mfeTicks` / `maeTicks` into the prices the overlay draws.
 * A run whose header carries no tick size passes `null` and gets a marker
 * with no excursion rather than one with an invented distance.
 *
 * **`slPrice` is the level active at exit, not the entry stop** — the same
 * caveat `BacktestTrade.slPrice` carries, and the reason the facts strip
 * shows `slTicks` beside it rather than deriving risk from the drawn line.
 */
export function cliTradeToMarker(t: CliTradeRecord, tickSize: number | null): TradeMarker {
  const reason = normalizeExitReason(t.exitReason) ?? "manual";
  const isLong = t.side === 0;
  const excursion = (ticks: number | null | undefined, favourable: boolean): number | null => {
    if (tickSize == null || ticks == null || !Number.isFinite(ticks)) return null;
    // Both magnitudes are recorded positive; the direction is the trade's.
    const signed = (isLong === favourable ? 1 : -1) * Math.abs(ticks) * tickSize;
    return t.entryPrice + signed;
  };
  return assembleTradeMarker({
    side: t.side,
    entryTime: t.entryTs,
    entryPrice: t.entryPrice,
    exitTime: t.exitTs,
    exitPrice: t.exitPrice,
    exitReason: reason,
    isWin: t.pnlTicks > 0,
    pnlTicks: t.pnlTicks,
    tpPrice: t.tpPrice,
    slPrice: t.slPrice,
    breakEvenMoved: t.slMoved?.breakeven ?? false,
    exitCode: t.exitReason,
    mfePrice: excursion(t.mfeTicks, true),
    maePrice: excursion(t.maeTicks, false),
  });
}

/**
 * StrategyTrade (live, from DB) → TradeMarker. Open trades have null
 * exit fields; exit reason comes from the engine's exit_reason column
 * (free-form text but follows known conventions — see normalizeExitReason).
 */
export function strategyTradeToMarker(t: {
  side: 0 | 1;
  entryPrice: number | null;
  entryFilledAt: string | null;
  entrySubmittedAt: string;
  exitPrice: number | null;
  exitFilledAt: string | null;
  exitReason: string | null;
  /** The row's `exit_reason_code`. Preferred over the label for the
   *  marker's text, and absent on a row written before the column. */
  exitReasonCode?: string | null;
  pnlTicks: number | null;
  pnlDollars: number | null;
  desiredTpPrice?: number | null;
  desiredSlPrice?: number | null;
  breakEvenMoved?: boolean;
  /** The row's `break_even_sl_price`: where the break-even move put the
   *  stop. Absent on a row from before the column. */
  breakEvenSlPrice?: number | null;
}): TradeMarker | null {
  if (t.entryPrice == null) return null; // pending_entry: no fill yet
  const entryTime = t.entryFilledAt ?? t.entrySubmittedAt;
  // If the trade has filled an exit but the reason is unrecognized, fall
  // back to "manual" so it still renders. Open trades stay null.
  const reason = normalizeExitReason(t.exitReason) ?? (t.exitFilledAt ? "manual" : null);
  return assembleTradeMarker({
    side: t.side,
    entryTime,
    entryPrice: t.entryPrice,
    exitTime: t.exitFilledAt,
    exitPrice: t.exitPrice,
    exitReason: reason,
    // Code first, label second: an open trade has neither and renders no
    // exit marker at all, so a null here costs nothing.
    exitCode: t.exitReasonCode ?? t.exitReason,
    isWin: t.pnlDollars != null ? t.pnlDollars > 0 : null,
    pnlTicks: t.pnlTicks,
    tpPrice: t.desiredTpPrice ?? null,
    // `desiredSlPrice` is the bracket as placed. After a break-even move the
    // stop sits at entry ± the offset, which the row stores; a row from
    // before that column only says the stop moved, so it draws at entry.
    slPrice: t.breakEvenMoved ? (t.breakEvenSlPrice ?? t.entryPrice) : (t.desiredSlPrice ?? null),
    breakEvenMoved: t.breakEvenMoved ?? false,
  });
}

// ── Backtest replay → TradeMarker ──────────────────────────────────

/** Result of replaying a closed live trade against the strategy's
 *  backtest engine on the same bar window. Drives both the comparison
 *  strip's BACKTEST row and the chart's hollow-marker overlay.
 *
 *  Status taxonomy:
 *  - `match` — both triggered, fills within tick tolerance
 *  - `exec_drift` — both triggered, fills/exits differ (slippage)
 *  - `signal_drift` — live triggered, backtest didn't (or vice versa)
 *  - `no_signal` — backtest produced nothing on this bar window;
 *    `noSignalReason` carries the human-readable reason (filter blocked,
 *    indicator differed, etc).
 */
export interface BacktestReplayResult {
  status: "match" | "exec_drift" | "signal_drift" | "no_signal";
  noSignalReason?: string;
  trigger?: number;
  fill?: number;
  tpPrice?: number;
  slPrice?: number;
  exit?: number;
  exitReason?: string;
  pnlDollars?: number;
  pnlTicks?: number;
  entryTime?: string;
  exitTime?: string;
  /** Filter that vetoed the entry. Set when `noSignalReason` starts with
   *  "filter blocked: <key>"; absent on indicator/session/strategy-side
   *  rejections. v1.1+ — older cached blobs lack this field. */
  blockedByFilter?: string;
  /** Indicator reading at the trigger bar that fed the blocked filter's
   *  decision. v1.1+ — undefined for filters whose attribution is non-
   *  numeric (e.g. session windows). */
  blockedIndicatorValue?: number;
  /** Threshold from `paramSnapshot` the indicator value was compared
   *  against. v1.1+ — same semantics as `blockedIndicatorValue`. */
  blockedThreshold?: number;
  /** High of the bar where the entry fired (replay-side). Drives the
   *  Phase-6 EXEC DRIFT volatility + containment sub-blocks. v1.1+. */
  triggerBarHigh?: number;
  /** Low of the bar where the entry fired (replay-side). v1.1+. */
  triggerBarLow?: number;
}

/** Convert a replay result into a TradeMarker for the chart overlay.
 *  Caller pairs this with the live trade's side (replay always uses the
 *  same side as the live trade — the strategy's signal is direction-
 *  pinned by the bar window). Returns null when the replay didn't
 *  trigger an entry (no_signal, or signal_drift where the bt didn't
 *  enter). */
export function backtestReplayToMarker(
  bt: BacktestReplayResult,
  side: 0 | 1,
): TradeMarker | null {
  if (bt.status === "no_signal") return null;
  if (bt.fill == null || bt.entryTime == null) return null;
  const reason = normalizeExitReason(bt.exitReason) ?? (bt.exitTime ? "manual" : null);
  return {
    side,
    entryTime: bt.entryTime,
    entryPrice: bt.fill,
    exitTime: bt.exitTime ?? null,
    exitPrice: bt.exit ?? null,
    exitReason: reason,
    isWin: bt.pnlDollars != null ? bt.pnlDollars > 0 : null,
    pnlTicks: bt.pnlTicks ?? null,
    tpPrice: bt.tpPrice ?? null,
    slPrice: bt.slPrice ?? null,
    breakEvenMoved: false,
  };
}

// ── Adaptive marker overlay (PR 4) ─────────────────────────────────

/** A normalized point ready for overlay rendering. Mirrors
 *  buildArrowMarkers' output but carries the bar high/low so we can
 *  draw a tether stem from the marker tip to the bar edge. */
interface OverlayPoint {
  time: UTCTimestamp;
  /** Bar index in the rendered bars array. Lets the draw loop skip
   *  off-screen points with a single int compare instead of paying for
   *  timeToCoordinate on every point every frame. */
  barIndex: number;
  /** Price at which the marker anchors. Used by `priceToCoordinate`. */
  price: number;
  /** Bar high (for above-bar markers) or low (for below-bar markers).
   *  Where the tether stem terminates. */
  tetherTo: number;
  position: "aboveBar" | "belowBar";
  kind: "entry" | "tp" | "sl" | "be" | "exit-other";
  side: 0 | 1;
}

/** A single trade's finite-bracket envelope. Three dashed horizontal
 *  segments — entry, TP, SL — each spanning the trade's lifetime, each in
 *  its own role colour: entry blue, TP green, SL red. How the trade ended
 *  is the exit marker's job, not the lines'. */
interface OverlayBracket {
  /** Bar indices the segments span. For closed trades exitIndex is the
   *  exit bar; for open trades it's null and the renderer clips to the
   *  most recent bar. */
  entryIndex: number;
  exitIndex: number | null;
  entryTime: UTCTimestamp;
  /** Same time as entry for closed trades; the most recent bar for open
   *  trades (recomputed each draw since "now" advances). */
  exitTime: UTCTimestamp | null;
  entryPrice: number;
  tpPrice: number | null;
  slPrice: number | null;
  /** The SL line's label says it was moved to break-even. */
  breakEvenMoved: boolean;
  /**
   * The excursion pair — the best and worst prices reached inside the
   * trade's own lifetime. Drawn dotted at the dim tokens, over exactly the
   * same `entryBar → exitBar` span as the dashed trio. Null when the
   * producing side recorded no excursion.
   */
  mfePrice: number | null;
  maePrice: number | null;
  /** Open trades render at 50% opacity to signal "in flight." Closed
   *  trades render at 100% — outcome locked in. */
  isOpen: boolean;
}

/**
 * Resolve a CSS variable to a concrete color string at draw time. Reads
 * `getComputedStyle(document.documentElement)` so theme changes (or
 * future `@media (prefers-color-scheme)` switches) propagate without a
 * code change. Falls back to the supplied default when SSR or the var
 * isn't defined yet.
 */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

interface OverlayPalette {
  entryLong: string;
  entryShort: string;
  tp: string;
  sl: string;
  be: string;
  /** Excursion segments. The dim variants, so the line that says how far
   *  price ran never out-weighs the bracket line that says what actually
   *  happened. */
  mfe: string;
  mae: string;
  tether: string;
}

/** Resolved once per draw so palette stays in sync with --tokens. */
function resolvePalette(): OverlayPalette {
  return {
    // Both entry directions resolve to --accent-blue per the marker
    // taxonomy (PR 4). Falls back to COLOR_LONG hex for SSR.
    entryLong: readVar("--accent-blue", COLOR_LONG),
    entryShort: readVar("--accent-blue", COLOR_SHORT),
    tp: readVar("--success", "#4ADE80"),
    sl: readVar("--danger", "#F87171"),
    be: readVar("--muted", "#94A3B8"),
    mfe: readVar("--success-dim", "#5CBF7E"),
    mae: readVar("--danger-dim", "#C96A62"),
    tether: "rgba(255, 255, 255, 0.2)",
  };
}

/** Map a TradeMarker into the 1-or-2 OverlayPoints it produces (entry +
 *  optional exit). Caller passes pre-resolved bar indices so we don't
 *  re-scan the bars array per trade on every attach. */
function tradeToOverlayPoints(
  t: TradeMarker,
  bars: BarData[],
  convertTime: (iso: string) => UTCTimestamp,
  entryIdx: number,
  exitIdx: number,
): OverlayPoint[] {
  const pts: OverlayPoint[] = [];
  const isLong = t.side === 0;
  if (entryIdx >= 0) {
    const entryBar = bars[entryIdx];
    pts.push({
      time: convertTime(entryBar.timestamp),
      barIndex: entryIdx,
      price: t.entryPrice,
      // Tether to the bar edge that's *away* from the marker tip so the
      // stem reads as anchoring the marker to the candle.
      tetherTo: isLong ? entryBar.low : entryBar.high,
      position: isLong ? "belowBar" : "aboveBar",
      kind: "entry",
      side: t.side,
    });
  }
  if (t.exitTime != null && t.exitPrice != null && exitIdx >= 0) {
    const exitBar = bars[exitIdx];
    // Reason → glyph:
    //   tp        → green triangle (TP).
    //   sl + true loss (isWin === false, nonzero ticks) → red triangle (SL).
    //   sl + scratch (isWin null, or pnlTicks === 0)    → diamond (BE-stop).
    //   anything else → diamond as a generic "exit happened" marker.
    // The sl-vs-be split exists because backtest tags BE-stop hits as
    // exitReason "sl" but they're visually distinct from real losses.
    const isRealLoss = t.isWin === false && t.pnlTicks !== 0;
    const kind: OverlayPoint["kind"] =
      t.exitReason === "tp" ? "tp"
      : t.exitReason === "sl" ? (isRealLoss ? "sl" : "be")
      : "exit-other";
    pts.push({
      time: convertTime(exitBar.timestamp),
      barIndex: exitIdx,
      price: t.exitPrice,
      // Exit position flips to the side opposite the entry so they
      // don't stack on the same edge of the bar.
      tetherTo: isLong ? exitBar.high : exitBar.low,
      position: isLong ? "aboveBar" : "belowBar",
      kind,
      side: t.side,
    });
  }
  return pts;
}

/** Resolve a TradeMarker into its bracket envelope. Its ends are the
 *  resolved bars' own times: `timeToCoordinate` finds no point for a time
 *  that is not a bar, which a 1m fill on a 5m chart is not. */
function tradeToOverlayBracket(
  t: TradeMarker,
  bars: BarData[],
  convertTime: (iso: string) => UTCTimestamp,
  entryIdx: number,
  exitIdx: number,
): OverlayBracket | null {
  if (entryIdx < 0) return null;
  const isOpen = t.exitTime == null;
  return {
    entryIndex: entryIdx,
    exitIndex: exitIdx >= 0 ? exitIdx : null,
    entryTime: convertTime(bars[entryIdx].timestamp),
    exitTime:
      exitIdx >= 0 && t.exitTime != null
        ? convertTime(bars[exitIdx].timestamp)
        : t.exitTime != null
          ? convertTime(t.exitTime)
          : null,
    entryPrice: t.entryPrice,
    tpPrice: t.tpPrice ?? null,
    slPrice: t.slPrice ?? null,
    breakEvenMoved: t.breakEvenMoved ?? false,
    mfePrice: t.mfePrice ?? null,
    maePrice: t.maePrice ?? null,
    isOpen,
  };
}

/** The slices of the chart the overlay reads and hooks — named so a test
 *  can stand a double in without impersonating the whole chart API. */
export type OverlayTimeScale = Pick<
  ITimeScaleApi<Time>,
  "getVisibleLogicalRange" | "timeToCoordinate" | "logicalToCoordinate"
>;
export interface OverlayChart {
  timeScale(): OverlayTimeScale;
}
export type OverlaySeries = Pick<
  ISeriesApi<"Candlestick">,
  "priceToCoordinate" | "attachPrimitive" | "detachPrimitive"
>;

/**
 * Mount an adaptive-density marker overlay onto a chart. Returns a
 * disposer the caller invokes in the effect cleanup. The overlay sits
 * absolutely-positioned over the chart's container so the chart's own
 * canvas (candles, grid, indicators) renders unmodified beneath.
 *
 * Two render modes, switched by visible trade count:
 * - Verbose (≤ COMPACT_DENSITY_THRESHOLD): overlay clears itself; caller
 *   is expected to render text-labeled arrows via `buildArrowMarkers` +
 *   `createSeriesMarkers` as before. Mode reported via onModeChange.
 * - Compact (> threshold): overlay draws custom triangles (TP/SL),
 *   diamonds (BE), and entry arrows + 0.5px tethers. Caller suppresses
 *   library markers in this mode.
 *
 * The mode is recomputed on every chart paint so zooming into a 20-bar
 * slice of a 200-trade chart restores verbose mode automatically.
 */
export function attachMarkerOverlay(
  chart: OverlayChart,
  candleSeries: OverlaySeries,
  container: HTMLElement,
  bars: BarData[],
  trades: TradeMarker[],
  convertTime: (iso: string) => UTCTimestamp,
  onModeChange: (mode: "verbose" | "compact") => void,
  btTrades: TradeMarker[] = [],
): () => void {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  // Chart canvas owns pointer events for crosshair/zoom; the overlay is
  // purely decorative so it must let events through to the chart below.
  canvas.style.pointerEvents = "none";
  // z-index above chart content but below any future floating UI.
  canvas.style.zIndex = "2";
  // Container needs to be positioned for absolute children to anchor.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  container.appendChild(canvas);

  // Pre-compute entry/exit bar indices ONCE at mount. Without this the
  // visible-count loop ran findBarIndex (O(bars)) per trade per
  // range-change event — on a 200-trade × 2000-bar chart that's 400k
  // comparisons firing 60×/sec during a drag. Hot-loop killer; cached
  // here, the per-frame visible-count scan is O(trades) over a small
  // int array, and the draw loop also uses these indices to skip
  // off-screen points without paying for timeToCoordinate.
  //
  // Containing bar, not nearest: the arrow markers already snap that way,
  // and on a coarser chart than the trade's own (a 1m fill on 15m bars) the
  // nearest bar can be the next one, so the bracket would start a bar after
  // the arrow.
  const entryBarIndices: number[] = trades.map((t) => containingBarIndex(bars, t.entryTime));
  const exitBarIndices: number[] = trades.map((t) =>
    t.exitTime != null ? containingBarIndex(bars, t.exitTime) : -1,
  );
  const points: OverlayPoint[] = trades.flatMap((t, i) =>
    tradeToOverlayPoints(t, bars, convertTime, entryBarIndices[i], exitBarIndices[i]),
  );
  const brackets: OverlayBracket[] = trades
    .map((t, i) => tradeToOverlayBracket(t, bars, convertTime, entryBarIndices[i], exitBarIndices[i]))
    .filter((b): b is OverlayBracket => b != null);

  // Backtest overlay — same precompute pipeline, separate arrays so the
  // draw loop can z-order them (live brackets → bt brackets → live
  // glyphs → bt glyphs).
  const btEntryIdx: number[] = btTrades.map((t) => findBarIndex(bars, t.entryTime));
  const btExitIdx: number[] = btTrades.map((t) =>
    t.exitTime != null ? findBarIndex(bars, t.exitTime) : -1,
  );
  const btPoints: OverlayPoint[] = btTrades.flatMap((t, i) =>
    tradeToOverlayPoints(t, bars, convertTime, btEntryIdx[i], btExitIdx[i]),
  );
  const btBrackets: OverlayBracket[] = btTrades
    .map((t, i) => tradeToOverlayBracket(t, bars, convertTime, btEntryIdx[i], btExitIdx[i]))
    .filter((b): b is OverlayBracket => b != null);

  function countVisibleEntries(range: { from: number; to: number } | null): number {
    if (!range) return trades.length;
    let count = 0;
    for (const idx of entryBarIndices) {
      if (idx < 0) continue;
      if (idx >= range.from && idx <= range.to) count++;
    }
    return count;
  }

  let lastMode: "verbose" | "compact" | null = null;
  let scheduled = 0;
  function draw() {
    scheduled = 0;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const range = chart.timeScale().getVisibleLogicalRange();
    const visible = countVisibleEntries(range);
    const mode: "verbose" | "compact" = visible > COMPACT_DENSITY_THRESHOLD ? "compact" : "verbose";
    if (mode !== lastMode) {
      lastMode = mode;
      onModeChange(mode);
    }

    const palette = resolvePalette();
    const timeScale = chart.timeScale();
    // Add a small padding so points right at the edges don't pop in/out
    // mid-pan. Cheap — just an int compare per point.
    const fromIdx = range != null ? Math.floor(range.from) - 1 : -Infinity;
    const toIdx = range != null ? Math.ceil(range.to) + 1 : Infinity;

    // Brackets render in BOTH modes — they're the strategy's intent
    // envelope, not density-sensitive; only their text labels are. Draw
    // them first so markers paint on top (z-order: live brackets → bt
    // brackets → live glyphs → bt glyphs).
    drawBrackets(ctx, brackets, timeScale, candleSeries, palette, fromIdx, toIdx, bars, 1, mode === "verbose");
    if (btBrackets.length > 0) {
      const btAlpha = parseFloat(readVar("--bt-bracket-alpha", "0.4")) || 0.4;
      drawBrackets(ctx, btBrackets, timeScale, candleSeries, palette, fromIdx, toIdx, bars, btAlpha);
    }

    // Live glyphs paint via canvas only in compact mode — verbose mode
    // delegates to the library markers via createSeriesMarkers.
    if (mode === "compact") {
      for (const p of points) {
        // Skip off-screen points before paying for chart-API calls — the
        // big perf win on dense backtests where most markers aren't visible.
        if (p.barIndex < fromIdx || p.barIndex > toIdx) continue;
        const x = timeScale.timeToCoordinate(p.time);
        const yPrice = candleSeries.priceToCoordinate(p.price);
        const yBar = candleSeries.priceToCoordinate(p.tetherTo);
        if (x == null || yPrice == null || yBar == null) continue;

        // Tether stem — drawn first so the marker glyph paints over the
        // tether's intersection at the marker tip.
        ctx.strokeStyle = palette.tether;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, yPrice);
        ctx.lineTo(x, yBar);
        ctx.stroke();

        drawGlyph(ctx, p, x, yPrice, palette, true);
      }
    }

    // Backtest glyphs always paint via canvas regardless of mode —
    // lightweight-charts' library markers can't render hollow shapes
    // and the bt overlay is the diagnostic surface, so it has to land
    // on the chart even when the live trade is verbose-mode (which is
    // every per-trade chart, since N=1).
    if (btPoints.length > 0) {
      const prevAlpha = ctx.globalAlpha;
      const btMarkerAlpha = parseFloat(readVar("--bt-marker-alpha", "0.75")) || 0.75;
      ctx.globalAlpha = btMarkerAlpha;
      for (const p of btPoints) {
        if (p.barIndex < fromIdx || p.barIndex > toIdx) continue;
        const x = timeScale.timeToCoordinate(p.time);
        const yPrice = candleSeries.priceToCoordinate(p.price);
        if (x == null || yPrice == null) continue;
        drawGlyph(ctx, p, x, yPrice, palette, false);
      }
      ctx.globalAlpha = prevAlpha;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(draw);
  }

  // Initial draw on mount, then one on every chart paint: the chart calls a
  // series primitive's `updateAllViews` whenever it recalculates its price
  // scales, which is every paint above the crosshair's. That covers zoom,
  // pan, resize and a data update that re-autoscales — and the price-only
  // moves: an axis drag, and *Fit candles*' `setVisibleRange`. The overlay
  // used to redraw on `subscribeVisibleLogicalRangeChange` alone, which the
  // library fires only when the *time* axis moves, so after *Fit candles*
  // the brackets stayed at the pixel rows of the previous price scale while
  // the candles under them rescaled (2026-10-28). The primitive draws
  // nothing itself; the canvas below is the renderer.
  const repaint: ISeriesPrimitive<Time> = { updateAllViews: schedule };
  candleSeries.attachPrimitive(repaint);
  schedule();

  // Container resize: lightweight-charts already recomputes its own
  // canvas on the parent's resize callback, but our overlay needs its
  // own observer. ResizeObserver fires on every layout change.
  const ro = new ResizeObserver(() => schedule());
  ro.observe(container);

  return () => {
    candleSeries.detachPrimitive(repaint);
    ro.disconnect();
    if (scheduled) cancelAnimationFrame(scheduled);
    canvas.remove();
  };
}

/** Dispatch a single overlay point to the right glyph drawer. Used by
 *  both the live (filled) and backtest (hollow) passes; the only
 *  difference between them is the `filled` flag. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  p: OverlayPoint,
  x: number,
  y: number,
  palette: OverlayPalette,
  filled: boolean,
) {
  const aboveBar = p.position === "aboveBar";
  switch (p.kind) {
    case "entry":
      drawArrow(ctx, x, y, p.side === 0 ? palette.entryLong : palette.entryShort, !aboveBar, filled);
      break;
    case "tp":
      drawTriangle(ctx, x, y, palette.tp, aboveBar, filled);
      break;
    case "sl":
      drawTriangle(ctx, x, y, palette.sl, aboveBar, filled);
      break;
    case "be":
      drawDiamond(ctx, x, y, palette.be, filled);
      break;
    case "exit-other":
      drawDiamond(ctx, x, y, palette.be, filled);
      break;
  }
}

// ── Glyphs ─────────────────────────────────────────────────────────

/** Equilateral triangle. Live (filled=true) renders at 7px; backtest
 *  (filled=false) renders at 5.5px so the hollow outline doesn't fully
 *  occlude a filled live marker landing on the same bar. */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  pointDown: boolean,
  filled: boolean,
) {
  const size = filled ? 7 : 5.5;
  const h = (size * Math.sqrt(3)) / 2;
  ctx.beginPath();
  if (pointDown) {
    ctx.moveTo(x - size / 2, y - h);
    ctx.lineTo(x + size / 2, y - h);
    ctx.lineTo(x, y);
  } else {
    ctx.moveTo(x - size / 2, y + h);
    ctx.lineTo(x + size / 2, y + h);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Square rotated 45°, 6px wide. Centered on (x, y). Hollow when
 *  `filled = false`. */
function drawDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  filled: boolean,
) {
  const r = filled ? 4 : 3.2;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Arrow glyph. Live (filled=true) is 6px wide; backtest (filled=false)
 *  is 5px wide and stroke-only. `pointUp` = ▲ (below-bar long entry);
 *  pointDown = ▼ (above-bar short entry). */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  pointUp: boolean,
  filled: boolean,
) {
  const size = filled ? 6 : 5;
  ctx.beginPath();
  if (pointUp) {
    ctx.moveTo(x - size, y + size);
    ctx.lineTo(x + size, y + size);
    ctx.lineTo(x, y);
  } else {
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ── Finite brackets (PR 5) ─────────────────────────────────────────

/** The intent envelope's dash, and the excursion's. Two patterns rather
 *  than one pattern at two alphas: an open bracket already renders at 50%
 *  alpha, so alpha alone would have made an open trade's stop and a closed
 *  trade's excursion the same stroke. */
const BRACKET_DASH: number[] = [4, 4];
const EXCURSION_DASH: number[] = [1, 3];

/** Label text size and the gap kept between two stacked labels. */
const LABEL_FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
const LABEL_LINE_PX = 12;

/** One horizontal segment of a bracket, in its role colour. */
interface BracketLine {
  price: number;
  color: string;
  dash: number[];
  label: string;
}

/**
 * The lines one bracket draws. Each line carries its role's colour — entry
 * blue, TP green, SL red, the excursion pair at the dim tokens — so a TP
 * line is green on every trade and the chart never asks the reader to
 * decode a colour from how the trade ended. The exit marker says that.
 */
function bracketLines(b: OverlayBracket, palette: OverlayPalette): BracketLine[] {
  const lines: BracketLine[] = [
    { price: b.entryPrice, color: palette.entryLong, dash: BRACKET_DASH, label: "Entry" },
  ];
  // TP / SL are null on serializations that pre-date the fields. Skip
  // rather than guess. For BE-stop trades slPrice is the post-BE level.
  if (b.tpPrice != null) lines.push({ price: b.tpPrice, color: palette.tp, dash: BRACKET_DASH, label: "TP" });
  if (b.slPrice != null) {
    lines.push({
      price: b.slPrice,
      color: palette.sl,
      dash: BRACKET_DASH,
      label: b.breakEvenMoved ? "SL (BE)" : "SL",
    });
  }
  // Excursion pair — dotted and dim, so it annotates rather than competes.
  if (b.mfePrice != null) lines.push({ price: b.mfePrice, color: palette.mfe, dash: EXCURSION_DASH, label: "Best" });
  if (b.maePrice != null) lines.push({ price: b.maePrice, color: palette.mae, dash: EXCURSION_DASH, label: "Worst" });
  return lines;
}

/**
 * Render the finite-bracket envelope for every visible trade: entry, TP
 * and SL dashed, best/worst dotted, each spanning entryBar → exitBar (or
 * entryBar → most-recent-bar for open trades).
 *
 * With `labels`, each line also gets its name and price at its left end,
 * nudged apart when two lines sit closer than a text line. Only the
 * verbose (sparse) mode asks for them; a dense chart of labels is noise.
 */
function drawBrackets(
  ctx: CanvasRenderingContext2D,
  brackets: OverlayBracket[],
  timeScale: OverlayTimeScale,
  candleSeries: OverlaySeries,
  palette: OverlayPalette,
  fromIdx: number,
  toIdx: number,
  bars: BarData[],
  /** Multiplier on the per-bracket alpha. 1.0 for the live pass; 0.4
   *  for the backtest pass so MATCH reads as a faint twin behind the
   *  bright live envelope. */
  alphaScale: number = 1,
  labels: boolean = false,
): void {
  if (brackets.length === 0) return;
  ctx.lineWidth = 1;
  const prevAlpha = ctx.globalAlpha;
  // Open-trade segment terminus = the most recent bar. Resolved via the
  // bar's logical index since open trades have null exitTime.
  const lastIdx = bars.length - 1;
  const nowX = lastIdx >= 0 ? timeScale.logicalToCoordinate(lastIdx as Logical) : null;

  for (const b of brackets) {
    // Viewport cull — same int compare pattern as markers.
    const exitOrNow = b.exitIndex ?? bars.length - 1;
    if (exitOrNow < fromIdx || b.entryIndex > toIdx) continue;

    const xEntry = timeScale.timeToCoordinate(b.entryTime);
    const xExit = b.exitTime != null
      ? timeScale.timeToCoordinate(b.exitTime)
      : nowX;
    if (xEntry == null || xExit == null) continue;

    // Open trades render at 50% opacity to signal "in flight." Backtest
    // pass scales the whole envelope down via alphaScale.
    ctx.globalAlpha = (b.isOpen ? 0.5 : 1.0) * alphaScale;

    const placed: { y: number; line: BracketLine }[] = [];
    for (const line of bracketLines(b, palette)) {
      const y = candleSeries.priceToCoordinate(line.price);
      if (y == null) continue;
      ctx.setLineDash(line.dash);
      ctx.strokeStyle = line.color;
      ctx.beginPath();
      ctx.moveTo(xEntry, y);
      ctx.lineTo(xExit, y);
      ctx.stroke();
      placed.push({ y, line });
    }

    if (labels) drawLineLabels(ctx, placed, Math.max(xEntry, 0) + 3);
  }

  // Restore canvas state so the marker pass below paints with solid
  // strokes + full alpha.
  ctx.setLineDash([]);
  ctx.globalAlpha = prevAlpha;
}

/** Name + price just above each line, top to bottom, pushed down when the
 *  one above would overlap it. A dark plate keeps the text legible over
 *  candles. */
function drawLineLabels(
  ctx: CanvasRenderingContext2D,
  placed: { y: number; line: BracketLine }[],
  x: number,
): void {
  ctx.setLineDash([]);
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "bottom";
  let floor = -Infinity;
  for (const { y, line } of [...placed].sort((a, b) => a.y - b.y)) {
    const baseline = Math.max(y - 2, floor + LABEL_LINE_PX);
    floor = baseline;
    const text = `${line.label} ${line.price.toFixed(2)}`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(x - 2, baseline - LABEL_LINE_PX + 1, w + 4, LABEL_LINE_PX);
    ctx.fillStyle = line.color;
    ctx.fillText(text, x, baseline);
  }
}
