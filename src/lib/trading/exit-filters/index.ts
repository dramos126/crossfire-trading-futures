/**
 * Exit-filter modules barrel.
 *
 * Re-exports the registry-shaped exit filters consumed by EXIT_FILTER_REGISTRY.
 * The legacy CommonParam-driven `break-even.ts` and `trailing-stop.ts` modules
 * were retired in step 4 of the exit-filter registry refactor — registry
 * filters (`breakeven`, `trail`, `time-stop`) are now the only path for BE,
 * trail, and time-stop behavior.
 */

export {
  EMA_EXIT_FILTER_PARAMS,
  EMA_EXIT_INDICATOR_ID,
  emaExitIndicatorConfig,
  triggeredEmaExit,
  type EmaExitFilterParams,
  type EmaExitTimeframe,
} from "./ema-exit";

export {
  BREAKEVEN_FILTER_PARAMS,
  computeBreakevenSlPrice,
  type BreakevenArmMode,
  type BreakevenOffsetUnit,
  type BreakevenFilterParams,
  type BreakevenTriggerArgs,
} from "./breakeven";

export {
  TIME_STOP_FILTER_PARAMS,
  checkTimeStopExit,
  type TimeStopFilterParams,
  type TimeStopProgressMode,
  type TimeStopTriggerArgs,
} from "./time-stop";

export {
  TRAIL_FILTER_PARAMS,
  TRAIL_ATR_INDICATOR_ID,
  trailIndicatorConfig,
  computeTrailSlPrice,
  type TrailFilterParams,
  type TrailMode,
  type TrailTriggerArgs,
} from "./trail";
