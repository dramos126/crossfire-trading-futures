import type { BarData } from "@/lib/brokers/types";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import type { IndicatorConfig } from "@/lib/trading/domain";
import { etDateKey, isInDaySession, requireDaySession } from "./session/session-utils";

/**
 * Calculated indicator values for a series of bars.
 * Each array is the same length as the input bars.
 * NaN values indicate insufficient data for that bar.
 */
export interface IndicatorResult {
  id: string;
  type: string;
  values: number[];
  // Extra series for multi-output indicators (e.g. MACD signal, histogram)
  extra?: Record<string, number[]>;
}

// ── Core calculations ───────────────────────────────────────────────

export function ema(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period) return result;

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function sma(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    result[i] = sum / period;
  }
  return result;
}

function rsi(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (delta > 0 ? delta : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (delta < 0 ? -delta : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function atr(bars: BarData[], period: number): number[] {
  const result = new Array<number>(bars.length).fill(NaN);
  if (bars.length < period + 1) return result;

  const tr = new Array<number>(bars.length);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  result[period - 1] = sum / period;

  for (let i = period; i < bars.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

function bollingerBands(closes: number[], period: number, stdDev: number): {
  upper: number[];
  middle: number[];
  lower: number[];
} {
  const middle = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - middle[i];
      sumSq += diff * diff;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + stdDev * sd;
    lower[i] = middle[i] - stdDev * sd;
  }

  return { upper, middle, lower };
}

function macd(closes: number[], fast: number, slow: number, signal: number): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);

  const macdLine = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  // Calculate signal line as EMA of MACD values (skip NaN prefix)
  const validStart = macdLine.findIndex((v) => !isNaN(v));
  const macdValid = validStart >= 0 ? macdLine.slice(validStart) : [];
  const signalValid = ema(macdValid, signal);

  const signalLine = new Array<number>(closes.length).fill(NaN);
  const histogram = new Array<number>(closes.length).fill(NaN);

  for (let i = 0; i < signalValid.length; i++) {
    const idx = validStart + i;
    signalLine[idx] = signalValid[i];
    if (!isNaN(signalValid[i]) && !isNaN(macdLine[idx])) {
      histogram[idx] = macdLine[idx] - signalValid[i];
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

function vwap(bars: BarData[]): number[] {
  const result = new Array<number>(bars.length).fill(NaN);
  let cumVolPrice = 0;
  let cumVol = 0;

  for (let i = 0; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumVolPrice += typical * bars[i].volume;
    cumVol += bars[i].volume;
    result[i] = cumVol > 0 ? cumVolPrice / cumVol : NaN;
  }
  return result;
}

/**
 * Cumulative volume-weighted mean over the instrument's day session, reset at
 * each session's open. A bar outside the window carries NaN rather than the
 * session's last value: the quantity is undefined before the open, and an
 * overnight bar quoting a line that stopped moving at 16:00 is a stale number
 * every consumer would read as live.
 */
function sessionVwap(bars: BarData[], daySession: DaySessionWindow): number[] {
  return sessionVwapBands(bars, daySession).vwap;
}

export interface SessionVwapBands {
  /** The session VWAP, exactly `SESSION_VWAP`'s series. */
  vwap: number[];
  /**
   * The volume-weighted standard deviation of typical price about the VWAP as
   * of each bar, `sqrt(Σ v·(tp − VWAP)² / Σ v)` over the session so far, in
   * price units. A band is `vwap ± k × sigma`; `k` is the caller's.
   */
  sigma: number[];
}

/**
 * Session VWAP and its σ, accumulated over the same day-session bars and reset
 * at the same open. NaN outside the window, for `SESSION_VWAP`'s reason.
 *
 * σ is taken from the moments about the session's first typical price rather
 * than about zero: the identity is exact either way, and the offset keeps the
 * subtraction away from two near-equal squares of a price in the thousands.
 * The first bar of a session has σ = 0 by construction.
 */
export function sessionVwapBands(bars: BarData[], daySession: DaySessionWindow): SessionVwapBands {
  const vwap = new Array<number>(bars.length).fill(NaN);
  const sigma = new Array<number>(bars.length).fill(NaN);
  let cumVolPrice = 0;
  let cumVol = 0;
  let origin = 0;
  let cumVolDev = 0;
  let cumVolDevSq = 0;
  let curDate: string | null = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const t = new Date(b.timestamp);
    if (isNaN(t.getTime())) continue;
    if (!isInDaySession(t, daySession)) continue;
    const d = etDateKey(t);
    const typical = (b.high + b.low + b.close) / 3;
    if (d !== curDate) {
      cumVolPrice = 0;
      cumVol = 0;
      cumVolDev = 0;
      cumVolDevSq = 0;
      origin = typical;
      curDate = d;
    }
    cumVolPrice += typical * b.volume;
    cumVol += b.volume;
    const dev = typical - origin;
    cumVolDev += dev * b.volume;
    cumVolDevSq += dev * dev * b.volume;
    if (cumVol > 0) {
      vwap[i] = cumVolPrice / cumVol;
      const meanDev = cumVolDev / cumVol;
      sigma[i] = Math.sqrt(Math.max(0, cumVolDevSq / cumVol - meanDev * meanDev));
    }
  }
  return { vwap, sigma };
}

/**
 * Indices of the confirmed swing points in `values`: `i` is a swing high when
 * `values[i]` is strictly above each of the `span` values either side of it
 * (a swing low, strictly below). A point is confirmed only once its last
 * right-hand neighbour exists, so the newest `span` indices are never swings —
 * the lag is the definition, not a defect. Ascending.
 */
export function confirmedSwings(values: readonly number[], kind: "high" | "low", span: number): number[] {
  const out: number[] = [];
  const beyond = kind === "high" ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  for (let i = span; i < values.length - span; i++) {
    let swing = Number.isFinite(values[i]);
    for (let k = 1; swing && k <= span; k++) {
      swing = beyond(values[i], values[i - k]) && beyond(values[i], values[i + k]);
    }
    if (swing) out.push(i);
  }
  return out;
}

function volumeMa(bars: BarData[], period: number): number[] {
  const volumes = bars.map((b) => b.volume);
  return sma(volumes, period);
}

/**
 * Wilder's ADX. Produces a single ADX series; +DI/-DI are intermediate.
 * Warmup: first valid ADX bar is at index (2*period - 1).
 */
function adx(bars: BarData[], period: number): number[] {
  const n = bars.length;
  const result = new Array<number>(n).fill(NaN);
  if (n < period * 2) return result;

  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }

  // Wilder smoothing: seed with period-length sum, then TR - TR/period + current.
  let smTR = 0, smPlusDM = 0, smMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smTR += tr[i];
    smPlusDM += plusDM[i];
    smMinusDM += minusDM[i];
  }

  const dx = new Array<number>(n).fill(NaN);
  const firstDxIdx = period;
  {
    const plusDI = smTR === 0 ? 0 : (100 * smPlusDM) / smTR;
    const minusDI = smTR === 0 ? 0 : (100 * smMinusDM) / smTR;
    const sum = plusDI + minusDI;
    dx[firstDxIdx] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }

  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + tr[i];
    smPlusDM = smPlusDM - smPlusDM / period + plusDM[i];
    smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];
    const plusDI = smTR === 0 ? 0 : (100 * smPlusDM) / smTR;
    const minusDI = smTR === 0 ? 0 : (100 * smMinusDM) / smTR;
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }

  // ADX = Wilder smoothing of DX over `period` bars.
  const firstAdxIdx = firstDxIdx + period - 1;
  if (firstAdxIdx >= n) return result;

  let adxSum = 0;
  for (let i = firstDxIdx; i < firstDxIdx + period; i++) adxSum += dx[i];
  result[firstAdxIdx] = adxSum / period;

  for (let i = firstAdxIdx + 1; i < n; i++) {
    result[i] = (result[i - 1] * (period - 1) + dx[i]) / period;
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────

export function calculateIndicator(
  config: IndicatorConfig,
  bars: BarData[],
  daySession: DaySessionWindow | null,
): IndicatorResult {
  const closes = bars.map((b) => b.close);

  switch (config.type) {
    case "EMA":
      return { id: config.id, type: "EMA", values: ema(closes, config.params.period) };

    case "SMA":
      return { id: config.id, type: "SMA", values: sma(closes, config.params.period) };

    case "RSI":
      return { id: config.id, type: "RSI", values: rsi(closes, config.params.period) };

    case "ATR":
      return { id: config.id, type: "ATR", values: atr(bars, config.params.period) };

    case "VWAP":
      return { id: config.id, type: "VWAP", values: vwap(bars) };

    case "SESSION_VWAP":
      return {
        id: config.id,
        type: "SESSION_VWAP",
        values: sessionVwap(bars, requireDaySession(daySession, "SESSION_VWAP")),
      };

    case "SESSION_VWAP_BANDS": {
      const bands = sessionVwapBands(bars, requireDaySession(daySession, "SESSION_VWAP_BANDS"));
      return { id: config.id, type: "SESSION_VWAP_BANDS", values: bands.vwap, extra: { sigma: bands.sigma } };
    }

    case "VOL":
      return { id: config.id, type: "VOL", values: volumeMa(bars, config.params.period) };

    case "ADX":
      return { id: config.id, type: "ADX", values: adx(bars, config.params.period) };

    case "BOLL": {
      const bb = bollingerBands(closes, config.params.period, config.params.stdDev);
      return {
        id: config.id,
        type: "BOLL",
        values: bb.middle,
        extra: { upper: bb.upper, lower: bb.lower },
      };
    }

    case "MACD": {
      const m = macd(closes, config.params.fast, config.params.slow, config.params.signal);
      return {
        id: config.id,
        type: "MACD",
        values: m.macd,
        extra: { signal: m.signal, histogram: m.histogram },
      };
    }

    default:
      return { id: config.id, type: config.type, values: new Array(bars.length).fill(NaN) };
  }
}

/**
 * Calculate all indicators for a strategy against a set of bars.
 *
 * `daySession` has no default on purpose: the one indicator that reads it
 * would otherwise fall back to a calendar-day anchor at any call site that
 * forgot it, which is indistinguishable from a correct session VWAP until
 * someone measures the overnight.
 */
export function calculateAll(
  configs: IndicatorConfig[],
  bars: BarData[],
  daySession: DaySessionWindow | null,
): Map<string, IndicatorResult> {
  const results = new Map<string, IndicatorResult>();
  for (const config of configs) {
    results.set(config.id, calculateIndicator(config, bars, daySession));
  }
  return results;
}
