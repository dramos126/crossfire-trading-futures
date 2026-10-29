/**
 * Bar Close Pulse — a two-bar continuation entry on 5-minute bars, and the
 * smallest complete strategy module in the tree: params, config, indicators,
 * an entry hook that emits its own stop, and an exit hook that defers to the
 * shared exit filters. A test fixture (it lives under `test/`), not a strategy
 * with an edge — read it as the template for writing one.
 *
 * The trigger bar's close sets the direction; the next bar enters if it closes
 * the same colour and breaks the trigger's extreme by `breakBufferTicks`, the
 * trigger is at least `minTriggerAtrMultiple` ATRs tall, and the confirm bar's
 * body is at least `minConfirmBodyPct` of its range. The stop sits past the
 * wider of the two bars' extremes and the anchor EMA, each with an ATR-aware
 * buffer; the target is `TARGET_R` times the stop.
 */
import type { IndicatorConfig } from "@/lib/trading/domain";
import type { CommonParams, EntrySignal, StrategyMeta, StrategyModule } from "../../../../strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "../../../../strategy-types";
import { isInSessionWindow } from "../../../../session/session";
import { resolveEffectiveTpTicks } from "../../../../orders/brackets";
import {
  ENTRY_FILTER_REGISTRY,
  EXIT_FILTER_REGISTRY,
  buildAllFilterIndicators,
  passesAllEntryFilters,
  anyExitFilterTriggered,
  type AllFilterParams,
} from "../../../../filters";
import { SLOPE_INDICATOR_ID } from "../../../../filters/slope";
import { PULLBACK_EMA_INDICATOR_ID } from "../../../../filters/pullback-depth";

/** The module's own window, read by `config.session` and by the trigger-bar
 *  gate in `shouldEnter`. One constant so the two cannot disagree. */
const PULSE_SESSION = LEGACY_DAY_SESSION;

type Params = CommonParams & AllFilterParams & {
  minTriggerAtrMultiple: number;
  atrPeriod: number;
  minConfirmBodyPct: number;
  breakBufferTicks: number;
  slEmaAnchorEnabled: boolean;
  slBarExtremeBufferTicks: number;
  slEmaBufferTicks: number;
  slEmaAnchorPeriod: number;
  slUseFurtherEma: boolean;
  slAtrFraction: number;
};

/** The reward multiple this module's target is, carried verbatim from the
 *  retired `riskRewardRatio` param's default — the 2R bracket its measurements
 *  were taken on. */
const TARGET_R = 2;

const PULSE_SL_EMA_ID = "__pulse_sl_ema";
const PULSE_SL_EMA21_ID = "__pulse_sl_ema21";

const strategy: StrategyModule<Params> = {
  version: "3.1.0",
  params: withCommonParams({
    // ── Trigger (added 2026-04-30) ──────────────────────────────────
    minTriggerAtrMultiple: {
      type: "number",
      label: "Min trigger bar size (× ATR)",
      default: 0.8,
      min: 0,
      max: 3,
      step: 0.1,
      group: "Trigger",
      zeroMeansDisabled: true,
      description: "Trigger bar's high-low must be at least this multiple of ATR. 0 disables. 0.8 rejects the bottom ~quintile of bars on /NQ 5m; raise to 1.0+ to demand visibly large trigger bars; lower to 0.5 to let more through during compressed sessions.",
    },
    minConfirmBodyPct: {
      type: "number",
      label: "Min confirm body (% of range)",
      default: 50,
      min: 0,
      max: 100,
      step: 5,
      group: "Trigger",
      zeroMeansDisabled: true,
      description: "Confirm bar's |close - open| / (high - low) must be at least this percent. 0 disables. 50 means the body is at least half the range — rejects shooting-star and hammer prints that close green/red but printed mostly opposite.",
    },
    breakBufferTicks: {
      type: "integer",
      label: "Break buffer (ticks)",
      default: 1,
      min: 0,
      max: 20,
      group: "Trigger",
      description: "Confirm bar must break the trigger's high (long) or low (short) by at least this many ticks. 0 = any overlap counts (baseline behavior). 1 = must clear by one full tick.",
    },
    atrPeriod: {
      type: "integer",
      label: "ATR period",
      default: 14,
      min: 5,
      max: 50,
      group: "Trigger",
      description: "Lookback for the ATR used by the trigger-size minimum and the SL anchor. Standard Wilder 14.",
    },
    // ── Stop (added 2026-05-01, SL-anchor change) ────────────────────
    slEmaAnchorEnabled: {
      type: "boolean",
      label: "EMA-anchored stop",
      default: true,
      group: "Stop",
      description: "Anchor the stop past the bar extreme AND past the nearer EMA, whichever is wider. Off = legacy behavior (stop right at the trigger/confirm extreme, no buffer). Turn off only to A/B against the old logic.",
    },
    slBarExtremeBufferTicks: {
      type: "integer",
      label: "Bar-extreme buffer (ticks)",
      default: 4,
      min: 0,
      max: 50,
      group: "Stop",
      description: "Minimum ticks past the trigger/confirm extreme. Acts as a floor — actual buffer is max(this, slAtrFraction × ATR). 4 ticks = 1 point on /NQ; raise on instruments where 1-tick wicks past the extreme are routine.",
    },
    slEmaBufferTicks: {
      type: "integer",
      label: "EMA buffer (ticks)",
      default: 8,
      min: 0,
      max: 100,
      group: "Stop",
      description: "Minimum ticks past the anchor EMA. Acts as a floor — actual buffer is max(this, slAtrFraction × ATR). 8 ticks = 2 points on /NQ; the EMA gets retested with more force than a random bar extreme, so the floor is wider.",
    },
    slEmaAnchorPeriod: {
      type: "integer",
      label: "EMA anchor period",
      default: 9,
      min: 2,
      max: 200,
      group: "Stop",
      description: "Which EMA to anchor against. 9 covers the routine pullback magnet on a 5m read. Set to 21 for swing-trend setups; set higher for longer holds. Single EMA only — see \"Use further EMA\" below if you want both 9 and 21 in play.",
    },
    slUseFurtherEma: {
      type: "boolean",
      label: "Use further of EMA9/EMA21",
      default: false,
      group: "Stop",
      description: "Anchor the stop against whichever of EMA9 / EMA21 sits further from entry in the stop direction.\n\nOff: anchor only against the EMA selected above.\n\nOn: stop sits past both EMAs.",
    },
    slAtrFraction: {
      type: "number",
      label: "ATR fraction",
      default: 0.25,
      min: 0,
      max: 1,
      step: 0.05,
      group: "Stop",
      description: "ATR fraction added to both buffers as a volatility floor. 0 = use the fixed-tick floors only. 0.25 means buffer is at least a quarter of one ATR. Range 0–1, step 0.05.",
    },
    // Bar Close Pulse's only other knobs are the registry filters. SL is
    // emitted by the trigger-bar low/high and TP is `TARGET_R` times it;
    // trigger logic itself isn't tunable.
    ...Object.values(ENTRY_FILTER_REGISTRY).reduce(
      (acc, filter) => ({ ...acc, ...filter.paramSchema }),
      {},
    ),
    ...Object.values(EXIT_FILTER_REGISTRY).reduce(
      (acc, filter) => ({ ...acc, ...filter.paramSchema }),
      {},
    ),
  }),

  config: {
    name: "Bar Close Pulse",
    description:
      "Trigger bar sets direction by close color.\n\nEnter on the next bar only if it pierces the trigger's extreme (with optional buffer), the trigger has size, and the confirm bar has body.\n\nTime-stop, breakeven, and trail are deployment-level via registry exit filters.\n\nSL anchors past the wider of the trigger/confirm extreme and the nearer EMA, with an ATR-aware buffer.",
    timeframe: "5m",
    session: PULSE_SESSION,
    // The defaults were measured on MNQ 5-minute bars.
    calibratedFor: "MNQ",
    entryType: 2,
    indicators: [
      { id: "__pulse_atr", type: "ATR", params: { period: 14 } },
      { id: PULSE_SL_EMA_ID, type: "EMA", params: { period: 9 } },
    ],
    // No `intent`: not admitted to any shelf, so it carries no admission badge.
  },

  exportWindow: { preBars: 12, postBars: 8 },

  buildIndicators(params) {
    const indicators: IndicatorConfig[] = [];
    const slAnchorWantsAtr =
      params.slEmaAnchorEnabled && params.slAtrFraction > 0;
    if (
      params.minTriggerAtrMultiple > 0 ||
      slAnchorWantsAtr
    ) {
      indicators.push({
        id: "__pulse_atr",
        type: "ATR",
        params: { period: params.atrPeriod },
      });
    }
    if (params.slEmaAnchorEnabled) {
      indicators.push({
        id: PULSE_SL_EMA_ID,
        type: "EMA",
        params: { period: params.slEmaAnchorPeriod },
      });
      if (params.slUseFurtherEma) {
        indicators.push({
          id: PULSE_SL_EMA21_ID,
          type: "EMA",
          params: { period: 21 },
        });
      }
    }
    indicators.push(...buildAllFilterIndicators(params));
    return indicators;
  },

  shouldEnter({ bars, barIndex, params, tickSize, indicators }): EntrySignal | null {
    const confirm = bars[barIndex];
    const trigger = bars[barIndex - 1];
    if (!confirm || !trigger) return null;

    // The trigger bar must itself have closed inside the session window.
    // Without this gate the very first in-session bar can use the prior
    // out-of-session bar as a trigger (e.g. 09:25 trigger → 09:30 entry when
    // the window opens at 09:30). Pause windows are intentionally ignored
    // here — we only care about the outer bound for trigger attribution; the
    // engine's `isInAnySessionWindow` check enforces the full active interval
    // upstream, which is also why this reads the module's own window rather
    // than `ctx.sessionWindows` (that is main-minus-pauses).
    const triggerInWindow = isInSessionWindow(
      new Date(trigger.timestamp),
      PULSE_SESSION.start,
      PULSE_SESSION.end,
    );
    if (!triggerInWindow) return null;

    const buffer = params.breakBufferTicks * tickSize;
    let side: 0 | 1;
    if (
      trigger.close > trigger.open &&
      confirm.close > confirm.open &&
      confirm.high > trigger.high + Math.max(0, buffer - tickSize)
    ) side = 0;
    else if (
      trigger.close < trigger.open &&
      confirm.close < confirm.open &&
      confirm.low < trigger.low - Math.max(0, buffer - tickSize)
    ) side = 1;
    else return null;

    const atrSeries = indicators.get("__pulse_atr")?.values;
    const atrVal = atrSeries?.[barIndex - 1];
    const triggerRange = trigger.high - trigger.low;
    const triggerAtrMultiple =
      atrVal != null && !isNaN(atrVal) && atrVal > 0
        ? triggerRange / atrVal
        : NaN;
    const confirmRange = confirm.high - confirm.low;
    const triggerBarBodyPct =
      confirmRange > 0
        ? (Math.abs(confirm.close - confirm.open) / confirmRange) * 100
        : NaN;

    if (params.minTriggerAtrMultiple > 0) {
      if (atrVal == null || isNaN(atrVal)) return null;
      if (triggerRange < params.minTriggerAtrMultiple * atrVal) return null;
    }

    if (params.minConfirmBodyPct > 0) {
      if (confirmRange <= 0) return null;
      if (triggerBarBodyPct < params.minConfirmBodyPct) return null;
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

    // SL placement.
    // Legacy (slEmaAnchorEnabled=false): stop sits at the wider of the two
    // bars' extremes, no buffer. New (default): stop sits past the wider of
    // (a) bar-extreme + bar buffer, (b) anchor EMA + ema buffer; both buffers
    // are floored at max(fixed-tick, slAtrFraction × ATR). EMA only widens —
    // if the EMA sits on the entry side of the bar-extreme stop, it's skipped.
    const entryPrice = confirm.close;
    const barExtremePrice =
      side === 0
        ? Math.min(trigger.low, confirm.low)
        : Math.max(trigger.high, confirm.high);

    let stopPrice: number;
    let slAnchoredBy: "bar" | "ema" | null = null;
    if (!params.slEmaAnchorEnabled) {
      stopPrice = barExtremePrice;
    } else {
      let atrBufferTicks = 0;
      if (params.slAtrFraction > 0) {
        if (atrVal == null || isNaN(atrVal)) return null;
        atrBufferTicks = (params.slAtrFraction * atrVal) / tickSize;
      }
      const barBufferTicks = Math.ceil(
        Math.max(params.slBarExtremeBufferTicks, atrBufferTicks),
      );
      const emaBufferTicks = Math.ceil(
        Math.max(params.slEmaBufferTicks, atrBufferTicks),
      );

      const barAnchorPrice =
        side === 0
          ? barExtremePrice - barBufferTicks * tickSize
          : barExtremePrice + barBufferTicks * tickSize;

      // Pick the EMA anchor value — single EMA, or the further of EMA9/EMA21
      // in the SL direction when slUseFurtherEma is on.
      const primaryEmaSeries = indicators.get(PULSE_SL_EMA_ID)?.values;
      const primaryEma = primaryEmaSeries?.[barIndex];
      let emaValue: number | null =
        primaryEma != null && !isNaN(primaryEma) ? primaryEma : null;
      if (params.slUseFurtherEma) {
        const ema21Series = indicators.get(PULSE_SL_EMA21_ID)?.values;
        const ema21 = ema21Series?.[barIndex];
        if (ema21 != null && !isNaN(ema21)) {
          if (emaValue == null) {
            emaValue = ema21;
          } else if (side === 0) {
            // Long: SL is below entry; "further" = lower EMA.
            emaValue = Math.min(emaValue, ema21);
          } else {
            // Short: SL is above entry; "further" = higher EMA.
            emaValue = Math.max(emaValue, ema21);
          }
        }
      }

      stopPrice = barAnchorPrice;
      slAnchoredBy = "bar";
      if (emaValue != null) {
        const emaAnchorPrice =
          side === 0
            ? emaValue - emaBufferTicks * tickSize
            : emaValue + emaBufferTicks * tickSize;
        // EMA only widens, never tightens.
        const emaWins =
          side === 0
            ? emaAnchorPrice < barAnchorPrice
            : emaAnchorPrice > barAnchorPrice;
        if (emaWins) {
          stopPrice = emaAnchorPrice;
          slAnchoredBy = "ema";
        }
      }
    }

    const stopDist = Math.abs(entryPrice - stopPrice);
    if (stopDist <= 0) return null;
    const slTicks = Math.max(1, Math.round(stopDist / tickSize));

    // `slCapped` went with `maxStopLossTicks` — nothing clamps this stop any
    // more, so the anchored distance *is* the placed distance.
    const meta: StrategyMeta = { anchoredSlTicks: slTicks };
    if (slAnchoredBy != null) meta.slAnchoredBy = slAnchoredBy;
    if (Number.isFinite(triggerBarBodyPct)) meta.triggerBarBodyPct = triggerBarBodyPct;
    if (Number.isFinite(triggerAtrMultiple)) meta.triggerAtrMultiple = triggerAtrMultiple;
    if (params.slopeFilterEnabled) {
      const slopeSeries = indicators.get(SLOPE_INDICATOR_ID)?.values;
      const back = barIndex - params.slopeLookback;
      const now = slopeSeries?.[barIndex];
      const prev = back >= 0 ? slopeSeries?.[back] : undefined;
      if (now != null && prev != null && !isNaN(now) && !isNaN(prev) && tickSize > 0) {
        meta.slopeTicks = (now - prev) / tickSize;
      }
    }
    if (params.pullbackDepthEnabled) {
      const pbSeries = indicators.get(PULLBACK_EMA_INDICATOR_ID)?.values;
      if (pbSeries && tickSize > 0) {
        const start = Math.max(0, barIndex - params.pullbackLookbackBars + 1);
        let closest = Infinity;
        for (let i = start; i <= barIndex; i++) {
          const ema = pbSeries[i];
          const b = bars[i];
          if (ema == null || isNaN(ema) || b == null) continue;
          const d = side === 0 ? (b.low - ema) / tickSize : (ema - b.high) / tickSize;
          if (d < closest) closest = d;
        }
        if (Number.isFinite(closest)) meta.pullbackTicksFromEma = closest;
      }
    }

    return {
      side,
      slTicks,
      tpTicks: resolveEffectiveTpTicks(slTicks, TARGET_R),
      meta,
    };
  },

  shouldExit({ bars, barIndex, indicators, position, params, tickSize, crossTimeframeBars }) {
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
