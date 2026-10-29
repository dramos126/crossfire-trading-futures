import type { OrderSide, BarData } from "@/lib/brokers/types";
import type { OpenPosition, ParamSchema } from "../strategy-types";
import { pnlTicksFromPrices, priceFromTicks } from "../orders/pnl-math";

/**
 * Breakeven exit filter — arms on R reached, or on time held in profit.
 *
 * Three arm modes (`breakEvenFilterArmMode`), all measured over the bars
 * after the entry bar:
 *  - **r** (default): MFE in price ≥ `breakEvenFilterAtR × slTicks × tickSize`.
 *    R-native, so it works the same whatever target the strategy emitted.
 *  - **timeOpen**: the position has been open ≥ `breakEvenFilterArmMinutes`
 *    and this bar closes in profit (long: close > entry; short: close < entry).
 *  - **timeInProfit**: every bar close in the last `breakEvenFilterArmMinutes`
 *    was in profit, and the position is at least that old. A close at or
 *    through entry restarts the clock from that close.
 * The time modes ignore `breakEvenFilterAtR` and arm without `slTicks`; only
 * an offset in R reads it there.
 *
 * **Time is bar timestamp minus the entry bar's timestamp, never
 * `position.entryTimestamp`.** That field is the signal bar's open stamp in the
 * backtest and a wall clock (submit or fill time) in the engine, so the same
 * trade would arm a bar apart on the two paths. The entry bar is found through
 * `barsSinceEntry`, which both paths count from the signal bar; its close is
 * the fill, so minutes held at bar `i` are `ts[i] − ts[entry]`. Timestamps,
 * not bar counts, so the minutes mean the same on any timeframe.
 *
 * **The `%-of-TP` mode was deleted with `CommonParams.riskRewardRatio`, and it
 * had to be.** It armed on `breakEvenFilterAtPct% × tpDistance` with
 * `tpDistance = slTicks × riskRewardRatio × tickSize`, and it existed only as a
 * byte-faithful landing place for the retired `breakEvenAtPct` CommonParam.
 * Nothing on `ExitFilterContext` can reconstruct that distance now — the target
 * is a number the *strategy* emits and `OpenPosition` does not carry it — so
 * the mode would have failed open on every bar, silently, on a path that moves
 * a stop. **Do not reintroduce it by threading `tpTicks` onto the position**;
 * `r` mode answers the same question without needing the target at all.
 *
 * Once armed, the filter requests an SL move to `entryPrice ± offset`, whatever
 * the mode. The offset's unit is `breakEvenFilterOffsetUnit`:
 *  - **ticks** (default): `breakEvenFilterOffsetTicks × tickSize`.
 *  - **r**: `breakEvenFilterOffsetR × slTicks × tickSize` — a multiple of the
 *    entry stop distance, so −0.5 pulls a −1R stop up to −0.5R.
 * Positive locks in profit; negative gives chop room past entry. Either way
 * the price is aligned to the tick grid away from the market (floor for a
 * long, ceil for a short): never closer to the market than the offset asks.
 * For a negative offset that is up to a tick more room than k × R, never less.
 * The request can sit beyond the market (an offset wider than
 * `atR × slTicks`, a time-mode close not yet past a +R lock, or a bar that
 * armed and closed back); the engine and backtest both refuse that move
 * through `isStopAtOrBeyondMarket` and retry on the next bar's close, so a
 * positive lock lands only once a close is beyond it.
 *
 * **Composition:** SL only ever moves favorably. The filter returns the
 * desired new SL price; the engine / backtest collect every firing filter's
 * request on a bar, take the tightest, and skip the modify if it would loosen
 * the current SL.
 *
 * **Arm-once latch:** load-bearing. The legacy %-of-TP path was retired in
 * step 4 of the exit-filter registry refactor. This filter is now the only
 * thing that moves the SL toward entry, so it must not refire once the
 * favorable ratchet has happened. The latch is implicit: `pickTightestFavorableSl`
 * rejects any candidate that would loosen the current SL, and once SL is at
 * or beyond entry the BE candidate (which sits at `entry ± offset`) can't
 * tighten further. No extra state is required — the SL itself is the latch.
 * The time modes keep this intact: they change only *when* the candidate is
 * offered, never *where* — it is the same fixed `entry ± offset` — so a time
 * condition that holds again on later bars, or stops holding after a reset,
 * offers a price that cannot tighten an SL already there, and never one that
 * loosens it. The R unit keeps it too: `slTicks` is fixed at entry, so the
 * candidate is still one fixed price. A negative R offset sits between the
 * entry stop and entry (the schema caps it at −0.9R), and should the tick
 * alignment or a stop already moved put the current SL tighter, the candidate
 * is not strictly tighter and `pickTightestFavorableSl` drops it — a negative
 * offset can never loosen a stop.
 *
 * **Null-fallback:** when `position.slTicks` is null (legacy rows), `r` mode
 * returns null — fail open per the EXIT_FILTER_REGISTRY contract. The time
 * modes do not need `slTicks` with a tick offset and arm as usual; they
 * return null on a bar timestamp that does not parse. **An R offset needs
 * `slTicks` in every arm mode**, so with it null (or not positive) the filter
 * returns null whatever the arm mode — no move rather than a guessed one.
 *
 * **When the entry bar is older than the bars held, the time modes start the
 * clock at the oldest bar held.** The engine reads a fixed window (~300 bars,
 * `MIN_WARMUP_BARS`) and keeps the true `barsSinceEntry` after the entry bar
 * scrolls out, so on a long 1m trade the entry index goes negative. The oldest
 * bar is no older than the entry bar, so a time mode arms late, never early.
 * The backtest holds every bar and never takes this path. `r` mode does not
 * clamp: its MFE window has no entry bar to start from and stays at 0.
 *
 * **When it is checked (`breakEvenFilterCheck`).** `barClose` (default) asks at
 * each bar's close, as every path always has. `intrabar` applies to `r` mode
 * only (`breakevenChecksIntrabar`): the backtest also asks inside the bar, on
 * each 1m bar in turn, through `computeIntrabarBreakevenSlPrice` — the same arm
 * test and the same target, over a bar still forming. The live engine does not
 * read the setting yet and stays on bar close (engine-exits.md).
 */

export type BreakevenArmMode = "r" | "timeOpen" | "timeInProfit";
export type BreakevenOffsetUnit = "ticks" | "r";
export type BreakevenCheck = "barClose" | "intrabar";

export interface BreakevenFilterParams {
  breakEvenFilterEnabled: boolean;
  breakEvenFilterArmMode: BreakevenArmMode;
  breakEvenFilterOffsetUnit: BreakevenOffsetUnit;
  breakEvenFilterOffsetTicks: number;
  breakEvenFilterOffsetR: number;
  breakEvenFilterAtR: number;
  /** Absent on a blob saved before the setting existed: bar close. */
  breakEvenFilterCheck?: BreakevenCheck;
  breakEvenFilterArmMinutes: number;
}

const MS_PER_MINUTE = 60_000;

export const BREAKEVEN_FILTER_PARAMS: Record<keyof BreakevenFilterParams, ParamSchema> = {
  breakEvenFilterEnabled: {
    type: "boolean",
    label: "Move stop to break-even",
    default: false,
    group: "Exit Filters",
    description: "Once price has moved this far in your favor, pull the stop up to entry. Locks in the trade as a scratch instead of letting it walk back to the original SL.",
  },
  breakEvenFilterArmMode: {
    type: "select",
    label: "Arm when",
    default: "r",
    options: [
      { value: "r", label: "Price runs an R multiple" },
      { value: "timeOpen", label: "Open N minutes, closing in profit" },
      { value: "timeInProfit", label: "In profit at every close for N minutes" },
    ],
    group: "Exit Filters",
    description: "What has to happen before the stop moves.\n\nR multiple: price has run that far in your favor at some point since entry.\n\nOpen N minutes: the trade has been on for that long and the latest bar closed in profit.\n\nIn profit for N minutes: every bar closed in profit for that long. A close at or through entry starts the count again.",
  },
  breakEvenFilterOffsetUnit: {
    type: "select",
    label: "Offset in",
    default: "ticks",
    options: [
      { value: "ticks", label: "Ticks from entry" },
      { value: "r", label: "R multiple of the entry stop" },
    ],
    group: "Exit Filters",
    description: "How the stop's distance from entry is measured.\n\nTicks: a fixed number of ticks, the same on every trade.\n\nR multiple: a share of this trade's own stop distance, so a wide-stop trade moves further than a tight one.",
  },
  breakEvenFilterOffsetTicks: {
    type: "integer",
    label: "BE offset (ticks)",
    default: 0,
    group: "Exit Filters",
    description: "Signed offset from entry the BE stop sits at. Positive locks in profit; negative gives the trade more room past entry; 0 sits exactly at entry.",
    visibleWhen: { key: "breakEvenFilterOffsetUnit", value: "ticks" },
  },
  breakEvenFilterOffsetR: {
    type: "number",
    label: "BE offset (R)",
    default: 0,
    min: -0.9,
    max: 1,
    step: 0.05,
    group: "Exit Filters",
    description: "Where the stop moves, as a multiple of the entry stop distance. 0.25 locks a quarter R of profit; −0.5 pulls the stop up from a full R of risk to half; 0 sits at entry.\n\nA profit lock moves only once a bar closes past it.",
    visibleWhen: { key: "breakEvenFilterOffsetUnit", value: "r" },
  },
  breakEvenFilterAtR: {
    type: "number",
    label: "Arm at R multiple",
    default: 1.0,
    min: 0.1,
    step: 0.1,
    group: "Exit Filters",
    description: "How far the trade has to run in your favor before BE arms, expressed as a multiple of the entry SL distance. 1.0 = full R, 0.5 = half R.",
    visibleWhen: { key: "breakEvenFilterArmMode", value: "r" },
  },
  breakEvenFilterCheck: {
    type: "select",
    label: "Check when",
    default: "barClose",
    options: [
      { value: "barClose", label: "At each bar's close" },
      { value: "intrabar", label: "Minute by minute (backtest only)" },
    ],
    group: "Exit Filters",
    description: "At each bar's close: the stop moves only once a bar has closed.\n\nMinute by minute: a backtest checks each minute inside the bar, so a bar that runs far enough and then falls back through the stop is a scratch, not a full loss. Live trading still checks at the bar's close.",
    visibleWhen: { key: "breakEvenFilterArmMode", value: "r" },
  },
  breakEvenFilterArmMinutes: {
    type: "integer",
    label: "Arm after (minutes)",
    default: 120,
    min: 1,
    max: 240,
    group: "Exit Filters",
    description: "How long the trade has to hold before the stop moves. Raise it to give a slow trade more room before it is held to a scratch.",
    visibleWhen: { key: "breakEvenFilterArmMode", values: ["timeOpen", "timeInProfit"] },
  },
};

/**
 * Compute MFE in price units over the bars after the entry bar through the
 * current bar. Long: max(bar.high) over window minus entry. Short: entry
 * minus min(bar.low).
 *
 * The entry bar is excluded: both paths count `barsSinceEntry` from the
 * signal bar, and the fill is at (backtest) or after (engine) its close, so
 * its range traded before the position existed and must not arm the move.
 *
 * `formingBar`, when given, stands in for the current bar: its range so far.
 */
function computeMfePrice(
  bars: BarData[],
  entryBarIndex: number,
  currentBarIndex: number,
  entryPrice: number,
  side: OrderSide,
  formingBar?: FormingBar,
): number {
  if (entryBarIndex < 0 || currentBarIndex <= entryBarIndex) return 0;
  const firstPostFill = entryBarIndex + 1;
  const barAt = (i: number): FormingBar => (formingBar != null && i === currentBarIndex ? formingBar : bars[i]);
  if (side === 0) {
    let hi = -Infinity;
    for (let i = firstPostFill; i <= currentBarIndex; i++) {
      if (barAt(i).high > hi) hi = barAt(i).high;
    }
    return Number.isFinite(hi) ? hi - entryPrice : 0;
  }
  let lo = Infinity;
  for (let i = firstPostFill; i <= currentBarIndex; i++) {
    if (barAt(i).low < lo) lo = barAt(i).low;
  }
  return Number.isFinite(lo) ? entryPrice - lo : 0;
}

/** The part of a bar the `r` arm reads: its range, or its range so far. */
export type FormingBar = Pick<BarData, "high" | "low">;

export interface BreakevenTriggerArgs {
  bars: BarData[];
  barIndex: number;
  position: OpenPosition;
  tickSize: number;
  params: BreakevenFilterParams;
}

function armedOnR(args: BreakevenTriggerArgs, entryBarIndex: number, formingBar?: FormingBar): boolean {
  const { bars, barIndex, position, tickSize, params } = args;
  if (position.slTicks == null) return false;
  if (params.breakEvenFilterAtR <= 0) return false;
  const mfe = computeMfePrice(bars, entryBarIndex, barIndex, position.entryPrice, position.side, formingBar);
  return mfe >= params.breakEvenFilterAtR * position.slTicks * tickSize;
}

const closesInProfit = (bar: BarData, entryPrice: number, side: OrderSide) =>
  side === 0 ? bar.close > entryPrice : bar.close < entryPrice;

/**
 * The time modes. The clock starts at the entry bar's close (the fill); in
 * `timeInProfit` it restarts at the latest close at or through entry after it.
 */
function armedOnTime(args: BreakevenTriggerArgs, entryBarIndex: number, mode: Exclude<BreakevenArmMode, "r">): boolean {
  const { bars, barIndex, position, params } = args;
  if (barIndex <= entryBarIndex) return false;
  if (!(params.breakEvenFilterArmMinutes > 0)) return false;
  const { entryPrice, side } = position;
  if (!closesInProfit(bars[barIndex], entryPrice, side)) return false;

  // The engine holds a fixed window and keeps counting `barsSinceEntry` after
  // the entry bar scrolls out, so the entry bar can sit before index 0. The
  // oldest held bar is no older than it, so starting there arms late, never early.
  const clockStart = Math.max(entryBarIndex, 0);
  let clockFrom = clockStart;
  if (mode === "timeInProfit") {
    for (let i = barIndex - 1; i > clockStart; i--) {
      if (!closesInProfit(bars[i], entryPrice, side)) { clockFrom = i; break; }
    }
  }
  const heldMs = Date.parse(bars[barIndex].timestamp) - Date.parse(bars[clockFrom].timestamp);
  if (!Number.isFinite(heldMs)) return false;
  return heldMs >= params.breakEvenFilterArmMinutes * MS_PER_MINUTE;
}

/**
 * Returns the desired new SL price when the filter wants to arm BE on this
 * bar, or null when it doesn't (filter disabled, the arm condition does not
 * hold, or `r` mode or an R offset with `slTicks` null per the fail-open
 * contract; an offset unit off the list moves nothing).
 *
 * The engine / backtest is responsible for the favorable-direction-only
 * ratchet — this function answers "where would I want the SL?" and lets
 * the caller compose the final SL across multiple firing filters.
 */
export function computeBreakevenSlPrice(args: BreakevenTriggerArgs): number | null {
  const { barIndex, position, tickSize, params } = args;
  if (!params.breakEvenFilterEnabled) return null;
  if (tickSize <= 0) return null;

  const entryBarIndex = barIndex - position.barsSinceEntry;
  // A blob saved before the mode existed carries no key, and it is `r`; a value
  // off the list arms nothing rather than being read as some other mode.
  const mode: unknown = params.breakEvenFilterArmMode ?? "r";
  const armed =
    mode === "r" ? armedOnR(args, entryBarIndex)
    : mode === "timeOpen" || mode === "timeInProfit" ? armedOnTime(args, entryBarIndex, mode)
    : false;
  if (!armed) return null;
  return breakevenTarget(position, tickSize, params);
}

/**
 * Whether the backtest also asks break-even inside each bar. Only `r` mode
 * can: the time modes count bar closes, which a minute inside a bar is not.
 * A blob saved before the setting existed carries no key, and it is bar close.
 * "On" is the truthy test `computeBreakevenSlPrice` asks, so a sweep's `1`
 * cannot run break-even at bar close while this path reads it as off.
 */
export function breakevenChecksIntrabar(params: BreakevenFilterParams): boolean {
  return (
    Boolean(params.breakEvenFilterEnabled) &&
    (params.breakEvenFilterArmMode ?? "r") === "r" &&
    params.breakEvenFilterCheck === "intrabar"
  );
}

/**
 * `computeBreakevenSlPrice` on bar `barIndex` while it is still forming:
 * `formingBar` is its range so far. The same arm test and the same target;
 * null unless `breakevenChecksIntrabar`.
 */
export function computeIntrabarBreakevenSlPrice(
  args: BreakevenTriggerArgs & { formingBar: FormingBar },
): number | null {
  const { barIndex, position, tickSize, params, formingBar } = args;
  if (!breakevenChecksIntrabar(params)) return null;
  if (tickSize <= 0) return null;
  if (!armedOnR(args, barIndex - position.barsSinceEntry, formingBar)) return null;
  return breakevenTarget(position, tickSize, params);
}

/** `entry ± offset`, in the offset's unit; null when the unit cannot be priced. */
function breakevenTarget(position: OpenPosition, tickSize: number, params: BreakevenFilterParams): number | null {
  const unit: unknown = params.breakEvenFilterOffsetUnit ?? "ticks";
  if (unit === "r") {
    const { slTicks } = position;
    if (slTicks == null || !(slTicks > 0) || !Number.isFinite(params.breakEvenFilterOffsetR)) return null;
    return offsetSlPrice(position, tickSize, params.breakEvenFilterOffsetR * slTicks);
  }
  if (unit !== "ticks" || !Number.isFinite(params.breakEvenFilterOffsetTicks)) return null;
  return offsetSlPrice(position, tickSize, params.breakEvenFilterOffsetTicks);
}

/**
 * `entry ± offsetTicks`, aligned to the grid away from the market, in
 * `pnl-math`'s fixed point. An R offset is a fraction of a tick; and a float
 * `floor(target / tickSize)` drops a whole tick when the quotient lands a hair
 * under the grid (0.1 tick: `2650.7 / 0.1` floors to 26506). On a binary
 * tick (0.25, 1) the float form was exact, so those prices are unchanged.
 */
function offsetSlPrice(position: OpenPosition, tickSize: number, offsetTicks: number): number {
  const isLong = position.side === 0;
  const target = priceFromTicks(position.entryPrice, isLong ? offsetTicks : -offsetTicks, tickSize);
  const gridTicks = pnlTicksFromPrices(0, target, 1, tickSize);
  return priceFromTicks(0, isLong ? Math.floor(gridTicks) : Math.ceil(gridTicks), tickSize);
}
