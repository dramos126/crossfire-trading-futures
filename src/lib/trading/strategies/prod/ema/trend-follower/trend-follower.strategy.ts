import type { OrderSide } from "@/lib/brokers/types";
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { CommonParams, EntrySignal, StrategyModule } from "../../../../strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "../../../../strategy-types";
import { resolveEffectiveTpTicks } from "../../../../orders/brackets";
import {
  ENTRY_FILTER_REGISTRY,
  EXIT_FILTER_REGISTRY,
  buildAllFilterIndicators,
  passesAllEntryFilters,
  anyExitFilterTriggered,
  type AllFilterParams,
} from "../../../../filters";

type Params = CommonParams &
  AllFilterParams & {
    // Trend identification
    fastEmaPeriod: number;
    midEmaPeriod: number;
    slowEmaPeriod: number;
    slopeLookback: number;
    adxPeriod: number;
    adxMinimum: number;
    // Entry trigger
    pullbackArmWindow: number;
    requirePriorBarHighBreak: boolean;
    // Stop sizing
    atrPeriod: number;
    atrStopMultiple: number;
    structuralBufferTicks: number;
    // VWAP filter
    vwapSlopeLookback: number;
    vwapMaxAtrDistance: number;
    vwapGates: VwapGates;
  };

const VWAP_GATES_ALL = "all";
const VWAP_GATES_NONE = "none";
type VwapGates = typeof VWAP_GATES_ALL | typeof VWAP_GATES_NONE;

/** The reward multiple this module's target is, carried verbatim from the
 *  retired `riskRewardRatio` param's default — the 2R bracket every number in
 *  this module's CHANGELOG was measured on. */
const TARGET_R = 2;

const EMA_FAST_ID = "tf_ema_fast";
const EMA_MID_ID = "tf_ema_mid";
const EMA_SLOW_ID = "tf_ema_slow";
const ATR_ID = "tf_atr";
const ADX_ID = "tf_adx";
const VWAP_ID = "tf_vwap";

const strategy: StrategyModule<Params> = {
  version: "4.2.1",

  params: withCommonParams({
    // ── Trend identification ─────────────────────────────────────────
    fastEmaPeriod: {
      type: "integer",
      label: "Fast EMA Period",
      default: 9,
      min: 2,
      max: 200,
      group: "Trend",
      description:
        "Lookback for the fast EMA. Shorter = more reactive to recent price, more frequent pullback signals. 9 is the practitioner-standard intraday fast EMA.",
    },
    midEmaPeriod: {
      type: "integer",
      label: "Mid EMA Period",
      default: 21,
      min: 2,
      max: 300,
      group: "Trend",
      description:
        "Lookback for the mid EMA. The pullback-tolerance baseline that sits between the fast and slow trend references.",
    },
    slowEmaPeriod: {
      type: "integer",
      label: "Slow EMA Period",
      default: 55,
      min: 2,
      max: 400,
      group: "Trend",
      description:
        "Lookback for the slow EMA. The session-trend reference — the slowest of the three stacked EMAs.",
    },
    slopeLookback: {
      type: "integer",
      label: "EMA Slope Lookback (bars)",
      default: 5,
      min: 1,
      max: 100,
      group: "Trend",
      description:
        "How many bars back to compare each EMA against for the slope-positive check. Longer = fewer whipsaws but more lag. The slope check is what distinguishes a real trend from a flat stack drifting through chop.",
    },
    adxPeriod: {
      type: "integer",
      label: "ADX Period",
      default: 14,
      min: 2,
      max: 100,
      group: "Trend",
      description:
        "Lookback for ADX. 14 is Wilder's original spec and the convention.",
    },

    // ── Entry trigger ────────────────────────────────────────────────
    pullbackArmWindow: {
      type: "integer",
      label: "Pullback Arm Window (bars)",
      default: 5,
      min: 1,
      max: 50,
      group: "Entry",
      description:
        "How many bars back (inclusive of the current bar) to scan for a touch of the fast EMA. A pullback within this window arms the entry; the trigger fires when price closes back above the fast EMA and optionally breaks the prior bar's high.",
    },
    requirePriorBarHighBreak: {
      type: "boolean",
      label: "Require Prior-Bar High Break",
      default: false,
      group: "Entry",
      description:
        "When on, the trigger bar must take out the prior bar's high (or low for shorts) in addition to closing above the fast EMA. Disabling reverts to a pure EMA-recovery trigger (T2). A/B on 5y /NQ: T2 (off) adds +163 trades and +$9,355 net P&L vs T1 at same PF — default off.",
    },

    // ── Stop sizing ──────────────────────────────────────────────────
    atrPeriod: {
      type: "integer",
      label: "ATR Period",
      default: 14,
      min: 2,
      max: 100,
      group: "Stop",
      description:
        "Lookback for the ATR used to size the stop and to normalize VWAP distance. 14 is Wilder's original.",
    },
    atrStopMultiple: {
      type: "number",
      label: "ATR Stop Multiple",
      default: 2.0,
      min: 0.1,
      step: 0.1,
      group: "Stop",
      description:
        "Stop distance equals this multiplied by ATR, floored at the pullback structural low. 2.0 is conservative; 2.5 is the upper practitioner range.",
    },
    structuralBufferTicks: {
      type: "integer",
      label: "Structural Stop Buffer (ticks)",
      default: 4,
      min: 0,
      max: 200,
      group: "Stop",
      description:
        "Additional ticks below the pullback low (or above for shorts) when the structural stop wins over the ATR stop. 4 ticks is roughly 1 point on NQ.",
    },

    // ── VWAP filter ──────────────────────────────────────────────────
    vwapSlopeLookback: {
      type: "integer",
      label: "VWAP Slope Lookback (bars)",
      default: 5,
      min: 1,
      max: 100,
      group: "VWAP",
      description:
        "How many bars back to compare VWAP for the slope-positive check. Longs require VWAP rising over this window; shorts require it falling.",
    },
    vwapMaxAtrDistance: {
      type: "number",
      label: "Max VWAP Distance (ATR)",
      default: 2.0,
      min: 0.1,
      step: 0.1,
      group: "VWAP",
      description:
        "Blocks entries when price is more than this many ATRs from VWAP. Prevents chasing into mean-reversion zones where the trend is overextended.",
    },
    vwapGates: {
      type: "select",
      label: "VWAP gates",
      default: VWAP_GATES_ALL,
      options: [
        { value: VWAP_GATES_ALL, label: "On: side, slope and distance" },
        { value: VWAP_GATES_NONE, label: "Off: VWAP blocks nothing" },
      ],
      group: "VWAP",
      description:
        "On, an entry needs price on the trend's side of VWAP, VWAP sloping with the trend, and price within the distance cap.\n\nOff turns all three off at once. A research setting for measuring the entry without VWAP; leave it on for a deployment.",
    },

    // Registry filter spread. A key declared above loses to a filter key of
    // the same name; overrides go after the spread.
    ...Object.values(ENTRY_FILTER_REGISTRY).reduce(
      (acc, filter) => ({ ...acc, ...filter.paramSchema }),
      {},
    ),
    ...Object.values(EXIT_FILTER_REGISTRY).reduce(
      (acc, filter) => ({ ...acc, ...filter.paramSchema }),
      {},
    ),

    // Shares its key with the ADX filter's threshold, so it is declared after
    // the spread. Default, type and bounds are the filter's, which won the
    // collision before 4.2.1: every number on record was measured at 20 (A109).
    adxMinimum: {
      type: "integer",
      label: "ADX Minimum",
      default: 20,
      min: 0,
      max: 100,
      group: "Trend",
      description:
        "Minimum ADX for entries. Below this the regime is treated as ranging and entries are blocked. 0 turns the check off. 20 is conservative; 25 is the stricter common threshold. The ADX entry filter reads the same value when it is on.",
    },

    // Override registry defaults: this strategy expects the trail and
    // time-stop filters configured by default per the README.
    trailFilterEnabled: {
      type: "boolean",
      label: "Trailing stop",
      default: true,
      group: "Exit Filters",
      description:
        "Once the trade has run far enough, ratchet the broker stop-loss tighter on every bar close. Locks in profit progressively without a market exit. Enabled by default for this strategy — configure as chandelier (ATR mode, multiple 2.5–3.0) per the README.",
    },
    timeStopFilterEnabled: {
      type: "boolean",
      label: "Time stop",
      default: true,
      group: "Exit Filters",
      description:
        "Cut the trade if it hasn't reached the minimum favorable progress after N bars. Frees capital and risk-budget for the next setup. Enabled by default for this strategy — configure with MFE progress mode at 1.0R per the README.",
    },
  }),

  config: {
    name: "Trend Follower",
    description:
      "Pullback-continuation trend-follower for 5m intraday futures. Identifies directional regime via an aligned EMA stack (fast > mid > slow, positive slopes) with VWAP-side alignment. Enters on pullbacks to the fast EMA that close back above it (pure EMA-recovery trigger by default; optionally requires prior-bar high break). The VWAP side, slope and distance gates are on unless the research setting turns all three off. Stop is ATR-based with a structural floor at the pullback low. Exits via a 2R target or chandelier trailing stop (configure via registry trail filter).",
    timeframe: "5m",
    // The window every deployment of this module ran on. **Not** the
    // 18:30–01:00 ET anchor its README describes: this module is retired, its
    // hooks take no entry outside the cash session anyway (pre-open and
    // post-close `SESSION_VWAP` bars are NaN), and declaring the README's
    // window here would change behaviour on a module nobody is calibrating.
    session: LEGACY_DAY_SESSION,
    // Its one measured verdict is an MNQ walk-forward (CHANGELOG 2026-09-06).
    calibratedFor: "MNQ",
    entryType: 2, // Market
    indicators: [],
    // Not a playbook. Off the picker, still loadable by key and by the CLI.
    hidden: true,
  },

  exportWindow: { preBars: 30, postBars: 15 },

  buildIndicators(params) {
    const indicators: IndicatorConfig[] = [
      { id: EMA_FAST_ID, type: "EMA", params: { period: params.fastEmaPeriod } },
      { id: EMA_MID_ID, type: "EMA", params: { period: params.midEmaPeriod } },
      { id: EMA_SLOW_ID, type: "EMA", params: { period: params.slowEmaPeriod } },
      { id: ATR_ID, type: "ATR", params: { period: params.atrPeriod } },
      { id: ADX_ID, type: "ADX", params: { period: params.adxPeriod } },
      { id: VWAP_ID, type: "SESSION_VWAP", params: {} },
    ];
    indicators.push(...buildAllFilterIndicators(params));
    return indicators;
  },

  shouldEnter(ctx): EntrySignal | null {
    const { bars, barIndex, indicators, params, tickSize } = ctx;
    const bar = bars[barIndex];
    if (!bar) return null;

    const emaFast = indicators.get(EMA_FAST_ID)?.values;
    const emaMid = indicators.get(EMA_MID_ID)?.values;
    const emaSlow = indicators.get(EMA_SLOW_ID)?.values;
    const atrSeries = indicators.get(ATR_ID)?.values;
    const adxSeries = indicators.get(ADX_ID)?.values;
    const vwapSeries = indicators.get(VWAP_ID)?.values;
    if (!emaFast || !emaMid || !emaSlow || !atrSeries || !adxSeries || !vwapSeries) {
      return null;
    }

    const slopeLookback = Math.max(1, Math.floor(params.slopeLookback));
    const pullbackArmWindow = Math.max(1, Math.floor(params.pullbackArmWindow));
    const vwapSlopeLookback = Math.max(1, Math.floor(params.vwapSlopeLookback));
    const minRequiredBack = Math.max(slopeLookback, vwapSlopeLookback, pullbackArmWindow - 1, 1);
    if (barIndex < minRequiredBack) return null;

    const fastNow = emaFast[barIndex];
    const midNow = emaMid[barIndex];
    const slowNow = emaSlow[barIndex];
    const fastPast = emaFast[barIndex - slopeLookback];
    const midPast = emaMid[barIndex - slopeLookback];
    const slowPast = emaSlow[barIndex - slopeLookback];
    const atrNow = atrSeries[barIndex];
    const adxNow = adxSeries[barIndex];
    const vwapNow = vwapSeries[barIndex];
    const vwapPast = vwapSeries[barIndex - vwapSlopeLookback];

    // Anything but an exact "none" keeps the gates on. Off also drops the
    // finite-VWAP requirement: the series is NaN before the open and its past
    // value is NaN for the session's first slope-lookback bars, so keeping it
    // would leave VWAP blocking the open.
    const vwapGatesOn = params.vwapGates !== VWAP_GATES_NONE;

    if (
      !isFinite(fastNow) || !isFinite(midNow) || !isFinite(slowNow) ||
      !isFinite(fastPast) || !isFinite(midPast) || !isFinite(slowPast) ||
      !isFinite(atrNow) || atrNow <= 0 ||
      !isFinite(adxNow) ||
      (vwapGatesOn && (!isFinite(vwapNow) || !isFinite(vwapPast)))
    ) {
      return null;
    }

    if (tickSize <= 0) return null;
    if (adxNow < params.adxMinimum) return null;

    const priorBar = bars[barIndex - 1];

    // Detect side via EMA stack + slope alignment.
    const stackedLong = fastNow > midNow && midNow > slowNow;
    const stackedShort = fastNow < midNow && midNow < slowNow;
    const slopesLong = fastNow > fastPast && midNow > midPast && slowNow > slowPast;
    const slopesShort = fastNow < fastPast && midNow < midPast && slowNow < slowPast;

    let side: OrderSide | null = null;
    if (stackedLong && slopesLong) side = 0;
    else if (stackedShort && slopesShort) side = 1;
    if (side === null) return null;

    // VWAP side, slope, and distance gates.
    if (vwapGatesOn) {
      if (side === 0) {
        if (!(bar.close > vwapNow)) return null;
        if (!(vwapNow > vwapPast)) return null;
        if ((bar.close - vwapNow) / atrNow > params.vwapMaxAtrDistance) return null;
      } else {
        if (!(bar.close < vwapNow)) return null;
        if (!(vwapNow < vwapPast)) return null;
        if ((vwapNow - bar.close) / atrNow > params.vwapMaxAtrDistance) return null;
      }
    }

    // Pullback condition: within the last `pullbackArmWindow` bars
    // (inclusive of current), at least one bar had low <= emaFast (long)
    // or high >= emaFast (short). Track the structural extreme across the
    // qualifying bars for the stop floor.
    let pullbackArmed = false;
    let pullbackExtreme = side === 0 ? Infinity : -Infinity;
    for (let k = 0; k < pullbackArmWindow; k++) {
      const idx = barIndex - k;
      if (idx < 0) break;
      const b = bars[idx];
      const fast = emaFast[idx];
      if (!b || !isFinite(fast)) continue;
      if (side === 0) {
        if (b.low <= fast) {
          pullbackArmed = true;
          if (b.low < pullbackExtreme) pullbackExtreme = b.low;
        }
      } else {
        if (b.high >= fast) {
          pullbackArmed = true;
          if (b.high > pullbackExtreme) pullbackExtreme = b.high;
        }
      }
    }
    if (!pullbackArmed) return null;
    if (!isFinite(pullbackExtreme)) return null;

    // Trigger: close back across the fast EMA, optionally taking out the
    // prior bar's high (long) / low (short).
    if (side === 0) {
      if (!(bar.close > fastNow)) return null;
      if (params.requirePriorBarHighBreak) {
        if (!priorBar) return null;
        if (!(bar.high > priorBar.high)) return null;
      }
    } else {
      if (!(bar.close < fastNow)) return null;
      if (params.requirePriorBarHighBreak) {
        if (!priorBar) return null;
        if (!(bar.low < priorBar.low)) return null;
      }
    }

    if (
      !passesAllEntryFilters({
        bars,
        barIndex,
        indicators,
        side,
        params,
        tickSize,
      })
    ) {
      return null;
    }

    // Stop sizing — max(ATR stop, structural-floor stop).
    const entryPrice = bar.close;
    const atrStopTicks = (atrNow / tickSize) * params.atrStopMultiple;
    const bufferPrice = params.structuralBufferTicks * tickSize;
    const structuralStopTicks =
      side === 0
        ? (entryPrice - (pullbackExtreme - bufferPrice)) / tickSize
        : ((pullbackExtreme + bufferPrice) - entryPrice) / tickSize;

    if (!isFinite(atrStopTicks) || !isFinite(structuralStopTicks)) return null;

    const slTicks = Math.max(1, Math.round(Math.max(atrStopTicks, structuralStopTicks)));

    return {
      side,
      slTicks,
      tpTicks: resolveEffectiveTpTicks(slTicks, TARGET_R),
      meta: {
        atr: atrNow,
        adx: adxNow,
        vwap: vwapNow,
        emaFast: fastNow,
        emaMid: midNow,
        emaSlow: slowNow,
        pullbackExtreme,
        atrStopTicks: Math.round(atrStopTicks),
        structuralStopTicks: Math.round(structuralStopTicks),
        rawSlTicks: slTicks,
      },
    };
  },

  shouldExit(ctx) {
    const { bars, barIndex, indicators, position, params, tickSize, crossTimeframeBars } = ctx;
    if (!position) return false;

    return anyExitFilterTriggered({
      bars,
      barIndex,
      indicators,
      side: position.side,
      params,
      tickSize,
      crossTimeframeBars,
      position,
    });
  },
};

export default strategy;
