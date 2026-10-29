import type { BarData } from "@/lib/brokers/types";
import type { ParamSchema } from "../strategy-types";

export interface VolumeFilterParams {
  volumeFilterEnabled: boolean;
  volumeLookback: number;
  volumeMultiplier: number;
}

export const VOLUME_FILTER_PARAMS: Record<keyof VolumeFilterParams, ParamSchema> = {
  volumeFilterEnabled: {
    type: "boolean",
    label: "Volume surge",
    default: false,
    group: "Entry Filters",
    description:
      "Only take the trade when the signal bar prints heavier volume than recent bars. Heavy volume on a signal bar means real money is showing up; a quiet bar usually means nobody cares about that level.",
  },
  volumeLookback: {
    type: "integer",
    label: "Volume lookback (bars)",
    default: 10,
    min: 2,
    max: 100,
    group: "Entry Filters",
    description: "How many bars back the filter averages to set the volume baseline. Longer means a steadier read; shorter means it tracks recent activity more closely. 10 bars is a sensible default on a 5m chart.",
  },
  volumeMultiplier: {
    type: "number",
    label: "Volume multiplier (× avg)",
    default: 1.3,
    min: 1,
    step: 0.1,
    group: "Entry Filters",
    description: "Signal bar volume has to clear the average times this number. 1.3 means 30% over average. Crank it up to filter harder, drop to 1.0 to let any normal bar through.\n\nNote: the signal bar is excluded from the average, so this fires a touch more often than a 1.3× line on a TradingView chart would suggest.",
  },
};

/**
 * Bars of warmup needed before the rolling-average volume baseline is
 * meaningful. The filter averages the prior `volumeLookback` bars (current
 * bar excluded), so it needs that many bars of history. Returns 0 when
 * disabled.
 */
export function volumeWarmupBars(params: VolumeFilterParams): number {
  return params.volumeFilterEnabled ? params.volumeLookback : 0;
}

/**
 * True when the bar at `barIndex` has volume ≥ multiplier × average of the
 * `volumeLookback` bars **before** it (current bar excluded so we're not
 * diluting the signal we're measuring). Returns true when disabled.
 */
export function passesVolumeFilter(
  bars: BarData[],
  barIndex: number,
  params: VolumeFilterParams,
): boolean {
  if (!params.volumeFilterEnabled) return true;

  const lookback = params.volumeLookback;
  const start = barIndex - lookback;
  if (start < 0) return false;

  const currentVolume = bars[barIndex]?.volume;
  if (currentVolume == null || !isFinite(currentVolume)) return false;

  let sum = 0;
  let count = 0;
  for (let j = start; j < barIndex; j++) {
    const v = bars[j]?.volume;
    if (v != null && isFinite(v)) {
      sum += v;
      count++;
    }
  }
  if (count === 0) return false;

  const avg = sum / count;
  if (avg <= 0) return false;
  return currentVolume >= avg * params.volumeMultiplier;
}
