import type { OrderSide, BarData } from "@/lib/brokers/types";
import type { OpenPosition, ParamSchema } from "../strategy-types";

/**
 * Time-stop exit filter.
 *
 * Flatten a stalled trade after `timeStopBars` bars from entry. Three
 * mutually exclusive progress modes:
 *  - **closeBar**: pure polarity check. Fires iff `bars >= timeStopBars`
 *    and the current bar's close is non-favorable vs entry (long: close
 *    <= entry; short: close >= entry). No R math, no `slTicks`
 *    dependency, `minProgressR` unused. Faithful reproduction of the
 *    v2.0.1-prerefactor strategy-level time-stop predicate.
 *  - **mfe**: max favorable excursion since entry / R. Slow grind that
 *    briefly pokes the threshold counts.
 *  - **current**: most recent close vs entry / R. Strict — a runner that
 *    pulled back gets cut even if it tagged 0.8R earlier.
 *
 * **Hit action:** structured exit (`{type: "exit"}`) with reason
 * `"time stop ${N} bars"`. Engine flattens via market exit at next bar
 * open — never racing the bracket. Backtest fills at `bar.close` of the
 * triggering bar (matches `signal` bracket-vs-shouldExit semantics).
 *
 * **Null-fallback:** for the R-progress modes (`mfe` / `current`),
 * `position.slTicks == null` → fail open (returns null) per the
 * EXIT_FILTER_REGISTRY contract. `closeBar` does not consult `slTicks`
 * so it is unaffected.
 */

export type TimeStopProgressMode = "mfe" | "current" | "closeBar";

export interface TimeStopFilterParams {
  timeStopFilterEnabled: boolean;
  timeStopFilterProgressMode: TimeStopProgressMode;
  timeStopFilterBars: number;
  timeStopFilterMinProgressR: number;
}

export const TIME_STOP_FILTER_PARAMS: Record<keyof TimeStopFilterParams, ParamSchema> = {
  timeStopFilterEnabled: {
    type: "boolean",
    label: "Time stop",
    default: false,
    group: "Exit Filters",
    description: "Cut the trade if it hasn't earned its keep after N bars. Stops the engine from sitting in a position that's just chopping around entry.",
  },
  timeStopFilterProgressMode: {
    type: "select",
    label: "Progress mode",
    default: "closeBar",
    options: [
      { value: "closeBar", label: "Close vs entry (polarity)" },
      { value: "mfe", label: "MFE since entry (R)" },
      { value: "current", label: "Current close (R)" },
    ],
    group: "Exit Filters",
    description: "Which definition of \"progress\" the check uses.\n\nClose vs entry: pure polarity — the trade just needs to close on the right side of entry. No R math.\n\nMFE since entry: counts the best favorable close since entry as a fraction of R. A brief poke past the threshold qualifies.\n\nCurrent close: strict — only the latest close vs entry as a fraction of R. A trade that ran 0.8R and pulled back gets cut.",
  },
  timeStopFilterBars: {
    type: "integer",
    label: "Bars before checking",
    default: 6,
    min: 1,
    group: "Exit Filters",
    description: "Number of closed bars after entry before the progress check kicks in.",
  },
  timeStopFilterMinProgressR: {
    type: "number",
    label: "Min progress (R)",
    default: 0.5,
    min: 0,
    step: 0.1,
    group: "Exit Filters",
    description: "Minimum favorable progress required, expressed as a multiple of the entry SL distance. Below this, the trade gets flattened.",
    visibleWhen: { key: "timeStopFilterProgressMode", values: ["mfe", "current"] },
  },
};

function computeMfeRTicks(
  bars: BarData[],
  entryBarIndex: number,
  currentBarIndex: number,
  entryPrice: number,
  side: OrderSide,
  tickSize: number,
): number {
  if (tickSize <= 0 || entryBarIndex < 0 || currentBarIndex < entryBarIndex) return 0;
  if (side === 0) {
    let hi = -Infinity;
    for (let i = entryBarIndex; i <= currentBarIndex; i++) {
      if (bars[i].high > hi) hi = bars[i].high;
    }
    return Number.isFinite(hi) ? (hi - entryPrice) / tickSize : 0;
  }
  let lo = Infinity;
  for (let i = entryBarIndex; i <= currentBarIndex; i++) {
    if (bars[i].low < lo) lo = bars[i].low;
  }
  return Number.isFinite(lo) ? (entryPrice - lo) / tickSize : 0;
}

export interface TimeStopTriggerArgs {
  bars: BarData[];
  barIndex: number;
  position: OpenPosition;
  tickSize: number;
  params: TimeStopFilterParams;
}

/**
 * Returns a reason string when the filter wants to flatten this bar, else
 * null. Caller wraps the reason in `{type: "exit", reason}` at the
 * registry boundary.
 */
export function checkTimeStopExit(args: TimeStopTriggerArgs): string | null {
  const { bars, barIndex, position, tickSize, params } = args;
  if (!params.timeStopFilterEnabled) return null;
  if (params.timeStopFilterBars <= 0) return null;
  if (position.barsSinceEntry < params.timeStopFilterBars) return null;

  const isLong = position.side === 0;
  const mode = params.timeStopFilterProgressMode;

  if (mode === "closeBar") {
    const bar = bars[barIndex];
    if (!bar || !Number.isFinite(bar.close)) return null;
    const favorable = isLong
      ? bar.close - position.entryPrice
      : position.entryPrice - bar.close;
    if (favorable <= 0) {
      return `time stop after ${params.timeStopFilterBars} bars — close vs entry not favorable`;
    }
    return null;
  }

  if (position.slTicks == null) return null;
  if (tickSize <= 0) return null;
  const slTicks = position.slTicks;
  const entryBarIndex = barIndex - position.barsSinceEntry;

  let progressR: number;
  if (mode === "mfe") {
    progressR = computeMfeRTicks(bars, entryBarIndex, barIndex, position.entryPrice, position.side, tickSize) / slTicks;
  } else {
    const lastClose = bars[barIndex]?.close;
    if (lastClose == null || !Number.isFinite(lastClose)) return null;
    const progressTicks = isLong
      ? (lastClose - position.entryPrice) / tickSize
      : (position.entryPrice - lastClose) / tickSize;
    progressR = progressTicks / slTicks;
  }

  if (progressR < params.timeStopFilterMinProgressR) {
    const progressStr = progressR.toFixed(2);
    const requiredStr = params.timeStopFilterMinProgressR.toFixed(2);
    return `time stop after ${params.timeStopFilterBars} bars — progress ${progressStr}R < ${requiredStr}R required`;
  }
  return null;
}
