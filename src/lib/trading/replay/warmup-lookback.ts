import type { IndicatorConfig } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";
import { ENTRY_FILTER_REGISTRY, type AllFilterParams } from "../filters";

/**
 * The lookback the backtest and the replay/snapshot windows both read, so the
 * two cannot disagree on what a strategy needs. Kept out of `replay-bars.ts`
 * because that file pulls the market-data registry, and the backtest runs in
 * workers that must not.
 */

/** Bars one indicator config reads back: `period`, or MACD's `slow`. */
export function indicatorLookbackBars(cfg: IndicatorConfig): number {
  return cfg.params.period ?? cfg.params.slow ?? 0;
}

/** The longest warmup any enabled entry filter declares for these params. */
export function entryFilterWarmupBars(params: ParamValues): number {
  // The filter params ride in the merged param blob; each hook reads only its
  // own keys and returns 0 when its enable flag is off.
  const filterParams = params as unknown as AllFilterParams;
  let max = 0;
  for (const filter of Object.values(ENTRY_FILTER_REGISTRY)) {
    const n = filter.warmupBars?.(filterParams) ?? 0;
    if (n > max) max = n;
  }
  return max;
}
