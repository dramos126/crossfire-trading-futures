import type { IndicatorConfig } from "@/lib/trading/domain";
import type { CommonParams, StrategyModule } from "../../../../strategy-types";
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

/** The reward multiple this module's target is, carried verbatim from the
 *  retired `riskRewardRatio` param's default — the 2R bracket every number in
 *  this module's CHANGELOG was measured on. */
const TARGET_R = 2;

type Params = CommonParams &
  AllFilterParams & {
    fastPeriod: number;
    slowPeriod: number;
  };

const strategy: StrategyModule<Params> = {
  version: "3.1.0",
  params: withCommonParams({
    fastPeriod: {
      type: "integer",
      label: "Fast EMA Period",
      default: 9,
      min: 2,
      max: 200,
      group: "Indicators",
    },
    slowPeriod: {
      type: "integer",
      label: "Slow EMA Period",
      default: 21,
      min: 2,
      max: 400,
      group: "Indicators",
    },
    // Spread all available filter params
    ...Object.values(ENTRY_FILTER_REGISTRY).reduce((acc, filter) => ({ ...acc, ...filter.paramSchema }), {}),
    ...Object.values(EXIT_FILTER_REGISTRY).reduce((acc, filter) => ({ ...acc, ...filter.paramSchema }), {}),
  }),

  config: {
    name: "EMA Crossover",
    description: "Enter long when fast EMA crosses above slow EMA; short on the opposite cross.",
    timeframe: "5m",
    // The window every deployment of this module ran on before the session
    // became a playbook constant. Retired module; the value is preserved, not
    // chosen.
    session: LEGACY_DAY_SESSION,
    // Its one measured verdict is an MNQ walk-forward (CHANGELOG 2026-09-06).
    calibratedFor: "MNQ",
    entryType: 2, // Market
    indicators: [
      { id: "fast", type: "EMA", params: { period: 9 } },
      { id: "slow", type: "EMA", params: { period: 21 } },
    ],
    // Not a playbook. Off the picker, still loadable by key and by the CLI.
    hidden: true,
  },

  exportWindow: { preBars: 25, postBars: 12 },

  buildIndicators(params) {
    const indicators: IndicatorConfig[] = [
      { id: "fast", type: "EMA", params: { period: params.fastPeriod } },
      { id: "slow", type: "EMA", params: { period: params.slowPeriod } },
    ];
    // Gather all indicator configs from enabled filters
    indicators.push(...buildAllFilterIndicators(params));
    return indicators;
  },

  shouldEnter({ indicators, barIndex, params, tickSize, bars }) {
    const fast = indicators.get("fast")?.values;
    const slow = indicators.get("slow")?.values;
    if (!fast || !slow) return null;

    const i = barIndex;
    if (i < 1) return null;

    const fPrev = fast[i - 1], fNow = fast[i];
    const sPrev = slow[i - 1], sNow = slow[i];
    if (isNaN(fPrev) || isNaN(fNow) || isNaN(sPrev) || isNaN(sNow)) return null;

    let side: 0 | 1 | null = null;
    if (fPrev <= sPrev && fNow > sNow) side = 0;
    else if (fPrev >= sPrev && fNow < sNow) side = 1;
    if (side === null) return null;

    if (
      !passesAllEntryFilters({
        bars,
        barIndex: i,
        indicators,
        side,
        params,
        tickSize,
      })
    ) {
      return null;
    }

    // SL at the entry bar's opposite extreme — the deepest probe through
    // the trend line on the bar that confirmed the cross. Cleaner than
    // the slow EMA value itself, which collapses to ~0 ticks at fast/slow
    // crossover bars. Distance measured from entry bar close.
    const entryBar = bars[i];
    if (!entryBar) return null;
    const entryPrice = entryBar.close;
    const stopPrice = side === 0 ? entryBar.low : entryBar.high;
    const stopDist = Math.abs(entryPrice - stopPrice);
    if (stopDist <= 0) return null;
    const slTicks = Math.max(1, Math.round(stopDist / tickSize));

    return { side, slTicks, tpTicks: resolveEffectiveTpTicks(slTicks, TARGET_R) };
  },

  shouldExit({ bars, barIndex, indicators, position, params, tickSize, crossTimeframeBars }) {
    // Bracket TP/SL + engine-enforced session window handle exits by default.
    // Exit-filter registry lets users opt into close-through exits (e.g. the
    // EMA close-through filter) without strategy edits.
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
