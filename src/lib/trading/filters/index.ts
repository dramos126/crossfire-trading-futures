/**
 * Filter Registries
 *
 * Two separate registries — entry filters and exit filters — each keyed
 * by filter id. Membership is encoded structurally (which registry the
 * entry lives in) rather than by a runtime `category` discriminator.
 *
 * - ENTRY_FILTER_REGISTRY: AND-ed gates evaluated before placing an
 *   entry. Each entry declares a `pass(ctx) => boolean`.
 * - EXIT_FILTER_REGISTRY: OR-ed triggers evaluated against an open
 *   position. Each entry declares a `trigger(ctx) => boolean`.
 *
 * Strategies that spread `AllFilterParams` and call `passesAllEntryFilters` /
 * `anyExitFilterTriggered` pick up every registered filter automatically.
 *
 * ── Null-fallback contract for OpenPosition.slTicks ─────────────────
 * Step 2b will introduce break-even / time-stop / trailing-stop exit
 * filters that read `OpenPosition.slTicks`. Legacy trade rows persisted
 * before SL was tracked may surface `slTicks: null`. The agreed contract
 * for every exit filter that consumes `slTicks` is **fail open**: if
 * `slTicks` is null, the filter does not trigger (returns `false` from
 * its `trigger` function). Legacy positions simply do not get BE / time-
 * stop / trail applied. No degraded-mode fallback, no deployment
 * rejection — keep it consistent across all three new modules.
 */

import type { ExitReason, OpenPosition, ParamSchema } from "../strategy-types";
import type { BarData, OrderSide } from "@/lib/brokers/types";
import type { IndicatorConfig, Timeframe } from "@/lib/trading/domain";
import type { IndicatorResult } from "@/lib/trading/indicators";

import {
    ADX_FILTER_PARAMS,
    ADX_INDICATOR_ID,
    adxIndicatorConfig,
    adxWarmupBars,
    passesAdxFilter,
    type AdxFilterParams,
} from "./adx";

import {
    SLOPE_FILTER_PARAMS,
    SLOPE_INDICATOR_ID,
    slopeIndicatorConfig,
    slopeWarmupBars,
    passesSlopeFilter,
    type SlopeFilterParams,
} from "./slope";

import {
    PULLBACK_DEPTH_FILTER_PARAMS,
    PULLBACK_EMA_INDICATOR_ID,
    pullbackDepthIndicatorConfig,
    pullbackDepthWarmupBars,
    passesPullbackDepthFilter,
    type PullbackDepthFilterParams,
} from "./pullback-depth";

import {
    VOLUME_FILTER_PARAMS,
    passesVolumeFilter,
    volumeWarmupBars,
    type VolumeFilterParams,
} from "./volume";

import {
    RSI_EXTREME_FILTER_PARAMS,
    RSI_EXTREME_INDICATOR_ID,
    rsiExtremeIndicatorConfig,
    rsiExtremeWarmupBars,
    passesRsiExtremeFilter,
    type RsiExtremeFilterParams,
} from "./rsi-extreme";

import {
    REJECTION_BAR_FILTER_PARAMS,
    rejectionBarWarmupBars,
    passesRejectionBarFilter,
    type RejectionBarFilterParams,
} from "./rejection-bar";

import {
    TIME_WINDOW_FILTER_PARAMS,
    timeWindowWarmupBars,
    passesTimeWindowFilter,
    type TimeWindowFilterParams,
} from "./time-window";

import {
    EMA_EXIT_FILTER_PARAMS,
    EMA_EXIT_INDICATOR_ID,
    emaExitIndicatorConfig,
    triggeredEmaExit,
    type EmaExitFilterParams,
} from "../exit-filters/ema-exit";

import {
    BREAKEVEN_FILTER_PARAMS,
    computeBreakevenSlPrice,
    type BreakevenFilterParams,
} from "../exit-filters/breakeven";

import {
    TIME_STOP_FILTER_PARAMS,
    checkTimeStopExit,
    type TimeStopFilterParams,
} from "../exit-filters/time-stop";

import {
    TRAIL_FILTER_PARAMS,
    TRAIL_ATR_INDICATOR_ID,
    trailIndicatorConfig,
    computeTrailSlPrice,
    type TrailFilterParams,
} from "../exit-filters/trail";

// ── Filter param types ────────────────────────────────────────────

/** Union of every entry-filter's params. */
export type EntryFilterParams = AdxFilterParams &
    SlopeFilterParams &
    PullbackDepthFilterParams &
    VolumeFilterParams &
    RsiExtremeFilterParams &
    RejectionBarFilterParams &
    TimeWindowFilterParams;

/** Union of every exit-filter's params. */
export type ExitFilterParams = EmaExitFilterParams &
    BreakevenFilterParams &
    TimeStopFilterParams &
    TrailFilterParams;

/**
 * Combined filter params. Strategies spread this into their `Params`
 * type so they receive every filter's keys regardless of category.
 * Retained as the intersection so existing strategy `Params` types
 * (which extend `AllFilterParams`) keep compiling unchanged.
 */
export type AllFilterParams = EntryFilterParams & ExitFilterParams;

// ── Filter contexts ───────────────────────────────────────────────

/**
 * Uniform context handed to every entry filter's `pass` function.
 * Filters that need their own indicator declare it via `indicatorConfig`
 * and read the result from `indicators` keyed by their own indicator id.
 */
export interface FilterPassContext {
    bars: BarData[];
    barIndex: number;
    indicators: Map<string, IndicatorResult>;
    side: OrderSide;
    params: AllFilterParams;
    tickSize: number;
}

/**
 * Context for exit filters. Shares most fields with entry filters, but
 * `side` is the CURRENT position's direction (not a would-be entry
 * direction). Exit filters use their own dedicated indicators registered
 * via `indicatorConfig`.
 *
 * `crossTimeframeBars` is a map of pre-fetched bars keyed by timeframe.
 * The engine populates it before calling `shouldExit` based on what each
 * enabled exit filter declared it needs via `neededTimeframes`. Filters
 * running on the strategy's own timeframe don't touch this map.
 */
export interface ExitFilterTriggerContext {
    bars: BarData[];
    barIndex: number;
    indicators: Map<string, IndicatorResult>;
    side: OrderSide;
    params: AllFilterParams;
    tickSize: number;
    crossTimeframeBars: Map<string, BarData[]>;
    /**
     * The current open position. Required by R-based exit filters
     * (breakeven, time-stop, trail) that compute MFE / progress from
     * `position.barsSinceEntry` and `position.slTicks`. Pre-step-2b
     * filters (ema-exit) ignore this field. Strategies that call
     * `anyExitFilterTriggered` from inside `shouldExit` already have
     * the position in scope (it's how they know they're in one) — pass
     * it through. May be null only on theoretical paths where no
     * position exists; the new R-based filters short-circuit to null in
     * that case.
     */
    position: OpenPosition | null;
}

// ── Filter metadata ───────────────────────────────────────────────

/**
 * Common metadata shared by entry and exit filter registry entries.
 * Membership in `ENTRY_FILTER_REGISTRY` vs `EXIT_FILTER_REGISTRY`
 * encodes the filter's role; there is no runtime `category` field.
 */
interface FilterMetadataBase {
    /** Unique filter key */
    key: string;
    /** Display name (human-readable) */
    name: string;
    /** Parameter schemas for UI */
    paramSchema: Record<string, ParamSchema>;
    /** Enable flag key (e.g., "adxFilterEnabled") */
    enableKey: string;
    /** Generate indicator config (if this filter needs indicators) */
    indicatorConfig?: (params: AllFilterParams) => IndicatorConfig | null;
}

export interface EntryFilterMetadata extends FilterMetadataBase {
    /**
     * Bars of warmup this filter contributes to the entry-evaluation start
     * line. The backtest skips `shouldEnter` until the longest such window
     * has elapsed so filters aren't gated on NaN/garbage indicator values.
     * MUST guard on the filter's own enable flag and return 0 when disabled.
     * Only entry filters declare this — exit filters can't fire before a
     * position exists, so they don't shift the entry warmup.
     */
    warmupBars?: (params: AllFilterParams) => number;
    /**
     * Normalized pass function. Strategies call `passesAllEntryFilters(ctx)`
     * and never reference individual filters.
     */
    pass: (ctx: FilterPassContext) => boolean;
    /**
     * Capture any runtime state the filter relies on that *isn't* derivable
     * from bars + params at replay time (e.g. an internal counter, last-fired
     * timestamp). Today's filters are pure functions of (bars, params,
     * indicators) so they all omit this — the snapshot stays empty and
     * replay reconstructs filter behavior exactly. The hook exists so a
     * future stateful filter can declare its state without forcing every
     * other filter to also implement it.
     *
     * Called at entry-placement time on every registered filter (not just
     * enabled ones — a filter that gets enabled mid-deployment may need
     * state from before its toggle flipped). Return `undefined` for "no
     * state to capture".
     */
    snapshot?: (ctx: FilterPassContext) => Record<string, unknown> | undefined;
}

/**
 * Discriminated result an exit-filter trigger can return.
 *
 * - `{type: "exit"}` — flatten the position with the given reason. The
 *   engine flattens via market exit at the next bar; the backtest closes
 *   at bar.close of the firing bar.
 * - `{type: "modifySl", newSlPrice}` — request a stop-loss modify to
 *   `newSlPrice`. Composition is "tightest favorable wins": the engine /
 *   backtest collects every modifySl across firing filters on a bar,
 *   picks the tightest, and rejects the modify entirely if it would
 *   loosen the current SL.
 * - `null` — filter did not trigger this evaluation.
 *
 * Step 2b of the exit-filter registry refactor introduced the structured
 * shape; previously the trigger returned `boolean`. Existing exit filters
 * (ema-exit) wrap their boolean fire as `{type: "exit", reason}`.
 */
export type ExitFilterResult =
    | { type: "exit"; reason: string }
    | { type: "modifySl"; newSlPrice: number }
    | null;

/**
 * Lightweight context the engine threads into the structured-result
 * trigger path so SL-modify filters can see the live SL price (for the
 * "tightest favorable wins" composition that the trigger function itself
 * doesn't perform).
 */
export interface ExitFilterEvaluateExtras {
    /** Current SL price after any prior moves (BE seed, prior trail
     *  ratchet). Null when unknown — filters that need it should bail. */
    currentSlPrice: number | null;
}

export interface ExitFilterMetadata extends FilterMetadataBase {
    /**
     * Normalized trigger function. Strategies (or the engine, via
     * `anyExitFilterTriggered`) call this to decide whether the filter
     * wants to exit the current position.
     *
     * Semantics: entry filters are AND-ed (all must pass to enter), exit
     * filters are OR-ed (any one triggers an exit).
     *
     * As of step 2b the trigger returns a discriminated `ExitFilterResult`
     * (`{type: "exit", reason}` to close, `{type: "modifySl", newSlPrice}`
     * to ratchet the broker SL bracket, or `null` for no-op). Pre-step-2b
     * filters that returned boolean wrap their fire path as
     * `{type: "exit", reason: "<filter-name>"}` at the registry boundary.
     */
    trigger: (ctx: ExitFilterTriggerContext) => ExitFilterResult;
    /**
     * Only for exit filters that operate on a timeframe other than the
     * strategy's own. Declares which timeframes the filter needs the
     * engine to pre-fetch before calling `trigger`. Return `null` when
     * no cross-timeframe fetch is required (including when the filter's
     * timeframe is set to "same as strategy"). The engine merges these
     * across all enabled exit filters so each timeframe is fetched once
     * per deployment per tick.
     */
    neededTimeframes?: (params: AllFilterParams) => Timeframe[] | null;
}

/**
 * Generic alias kept so consumers that hold a heterogeneous reference
 * (e.g. `FilterSelector` rendering either entry or exit cards) have a
 * single type to lean on. Callers that need callback-specific fields
 * should narrow to `EntryFilterMetadata` or `ExitFilterMetadata`.
 */
export type FilterMetadata = EntryFilterMetadata | ExitFilterMetadata;

// ── Registries ────────────────────────────────────────────────────

/**
 * Registry of entry filters (AND-ed). Add a new entry filter here.
 */
export const ENTRY_FILTER_REGISTRY: Record<string, EntryFilterMetadata> = {
    adx: {
        key: "adx",
        name: "ADX Filter",
        paramSchema: ADX_FILTER_PARAMS,
        enableKey: "adxFilterEnabled",
        indicatorConfig: adxIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        warmupBars: adxWarmupBars,
        pass: (ctx) =>
            passesAdxFilter(ctx.indicators.get(ADX_INDICATOR_ID)?.values, ctx.barIndex, ctx.params),
    },

    slope: {
        key: "slope",
        name: "Trend Slope",
        paramSchema: SLOPE_FILTER_PARAMS,
        enableKey: "slopeFilterEnabled",
        indicatorConfig: slopeIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        warmupBars: slopeWarmupBars,
        pass: (ctx) =>
            passesSlopeFilter(
                ctx.indicators.get(SLOPE_INDICATOR_ID)?.values,
                ctx.barIndex,
                ctx.side,
                ctx.params,
                ctx.tickSize,
            ),
    },

    pullback_depth: {
        key: "pullback_depth",
        name: "Pullback Depth",
        paramSchema: PULLBACK_DEPTH_FILTER_PARAMS,
        enableKey: "pullbackDepthEnabled",
        indicatorConfig: pullbackDepthIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        warmupBars: pullbackDepthWarmupBars,
        pass: (ctx) =>
            passesPullbackDepthFilter(
                ctx.indicators.get(PULLBACK_EMA_INDICATOR_ID)?.values,
                ctx.bars,
                ctx.barIndex,
                ctx.side,
                ctx.params,
                ctx.tickSize,
            ),
    },

    volume: {
        key: "volume",
        name: "Volume Surge",
        paramSchema: VOLUME_FILTER_PARAMS,
        enableKey: "volumeFilterEnabled",
        warmupBars: volumeWarmupBars,
        pass: (ctx) => passesVolumeFilter(ctx.bars, ctx.barIndex, ctx.params),
    },

    rsi_extreme: {
        key: "rsi_extreme",
        name: "RSI Extreme",
        paramSchema: RSI_EXTREME_FILTER_PARAMS,
        enableKey: "rsiExtremeEnabled",
        indicatorConfig: rsiExtremeIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        warmupBars: rsiExtremeWarmupBars,
        pass: (ctx) =>
            passesRsiExtremeFilter(
                ctx.indicators.get(RSI_EXTREME_INDICATOR_ID)?.values,
                ctx.barIndex,
                ctx.side,
                ctx.params,
            ),
    },

    rejection_bar: {
        key: "rejection_bar",
        name: "Rejection Bar",
        paramSchema: REJECTION_BAR_FILTER_PARAMS,
        enableKey: "rejectionBarEnabled",
        warmupBars: rejectionBarWarmupBars,
        pass: (ctx) =>
            passesRejectionBarFilter(ctx.bars, ctx.barIndex, ctx.side, ctx.params, ctx.tickSize),
    },

    time_window: {
        key: "time_window",
        name: "Entry Hours Gate",
        paramSchema: TIME_WINDOW_FILTER_PARAMS,
        enableKey: "timeWindowEnabled",
        warmupBars: timeWindowWarmupBars,
        pass: (ctx) => passesTimeWindowFilter(ctx.bars, ctx.barIndex, ctx.params),
    },
};

/**
 * Registry of exit filters (OR-ed). Add a new exit filter here.
 *
 * See null-fallback contract at the top of this file for the rule
 * exit filters must follow when `OpenPosition.slTicks` is null.
 */
export const EXIT_FILTER_REGISTRY: Record<string, ExitFilterMetadata> = {
    ema_exit: {
        key: "ema_exit",
        name: "EMA Close-Through",
        paramSchema: EMA_EXIT_FILTER_PARAMS,
        enableKey: "emaExitEnabled",
        indicatorConfig: emaExitIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        trigger: (ctx): ExitFilterResult => {
            const currentBar = ctx.bars[ctx.barIndex];
            const currentClose = currentBar?.close ?? NaN;
            const tf = ctx.params.emaExitTimeframe;
            const crossBars = tf !== "same" ? ctx.crossTimeframeBars.get(tf) : undefined;
            const fired = triggeredEmaExit(
                ctx.indicators.get(EMA_EXIT_INDICATOR_ID)?.values,
                currentClose,
                ctx.side,
                ctx.params,
                crossBars,
                ctx.barIndex,
            );
            return fired ? { type: "exit", reason: "EMA close-through" } : null;
        },
        neededTimeframes: (params) => {
            if (!params.emaExitEnabled) return null;
            if (params.emaExitTimeframe === "same") return null;
            return [params.emaExitTimeframe];
        },
    },

    breakeven: {
        key: "breakeven",
        name: "Breakeven",
        paramSchema: BREAKEVEN_FILTER_PARAMS,
        enableKey: "breakEvenFilterEnabled",
        trigger: (ctx): ExitFilterResult => {
            if (!ctx.position) return null;
            const newSlPrice = computeBreakevenSlPrice({
                bars: ctx.bars,
                barIndex: ctx.barIndex,
                position: ctx.position,
                tickSize: ctx.tickSize,
                params: ctx.params,
            });
            return newSlPrice == null ? null : { type: "modifySl", newSlPrice };
        },
    },

    time_stop: {
        key: "time_stop",
        name: "Time Stop (R-based)",
        paramSchema: TIME_STOP_FILTER_PARAMS,
        enableKey: "timeStopFilterEnabled",
        trigger: (ctx): ExitFilterResult => {
            if (!ctx.position) return null;
            const reason = checkTimeStopExit({
                bars: ctx.bars,
                barIndex: ctx.barIndex,
                position: ctx.position,
                tickSize: ctx.tickSize,
                params: ctx.params,
            });
            return reason == null ? null : { type: "exit", reason };
        },
    },

    trail: {
        key: "trail",
        name: "Trailing Stop (bracket-modify)",
        paramSchema: TRAIL_FILTER_PARAMS,
        enableKey: "trailFilterEnabled",
        indicatorConfig: trailIndicatorConfig as (params: AllFilterParams) => IndicatorConfig | null,
        trigger: (ctx): ExitFilterResult => {
            if (!ctx.position) return null;
            const newSlPrice = computeTrailSlPrice({
                bars: ctx.bars,
                barIndex: ctx.barIndex,
                position: ctx.position,
                tickSize: ctx.tickSize,
                params: ctx.params,
                atrSeries: ctx.indicators.get(TRAIL_ATR_INDICATOR_ID)?.values,
            });
            return newSlPrice == null ? null : { type: "modifySl", newSlPrice };
        },
    },
};

// ── Filter param keys ─────────────────────────────────────────────

/**
 * Module-load assertion: no two filters in either registry may share a
 * param key. It outlived the export it was written for because the reason
 * is the runtime's, not the file's: every filter reads its params out of one
 * flat `paramValues` blob, so two filters declaring the same key would read
 * one value, and the schema spread that builds a strategy's params
 * overwrites one declaration with the other without a word. See
 * docs/modules/trading/filters.md, "Param keys".
 */
(function assertNoFilterParamKeyCollisions(): void {
  const ownerByKey = new Map<string, string>();
  const check = (filterKey: string, schema: Record<string, ParamSchema>) => {
    for (const paramKey of Object.keys(schema)) {
      const prior = ownerByKey.get(paramKey);
      if (prior && prior !== filterKey) {
        throw new Error(
          `Filter param key collision: "${paramKey}" is declared by both ` +
            `"${prior}" and "${filterKey}". Filter param keys must be globally ` +
            `unique across ENTRY_FILTER_REGISTRY and EXIT_FILTER_REGISTRY, ` +
            `because every filter reads its params from one flat paramValues blob.`,
        );
      }
      ownerByKey.set(paramKey, filterKey);
    }
  };
  for (const f of Object.values(ENTRY_FILTER_REGISTRY)) check(f.key, f.paramSchema);
  for (const f of Object.values(EXIT_FILTER_REGISTRY)) check(f.key, f.paramSchema);
})();

// ── Discovery / iteration helpers ─────────────────────────────────

/**
 * Get all enabled entry filters for a given params object.
 */
export function getEnabledEntryFilters(params: AllFilterParams): EntryFilterMetadata[] {
    return Object.values(ENTRY_FILTER_REGISTRY).filter(
        (filter) => (params as unknown as Record<string, unknown>)[filter.enableKey] === true,
    );
}

/**
 * Build all indicator configs from enabled filters across both
 * registries. Useful in strategy `buildIndicators()` to gather all
 * needed indicators in one pass.
 */
export function buildAllFilterIndicators(params: AllFilterParams): IndicatorConfig[] {
    const configs: IndicatorConfig[] = [];
    const collect = (filter: FilterMetadata) => {
        if (
            filter.indicatorConfig &&
            (params as unknown as Record<string, unknown>)[filter.enableKey] === true
        ) {
            const config = filter.indicatorConfig(params);
            if (config) configs.push(config);
        }
    };
    Object.values(ENTRY_FILTER_REGISTRY).forEach(collect);
    Object.values(EXIT_FILTER_REGISTRY).forEach(collect);
    return configs;
}

/**
 * Run every enabled entry filter. Returns true iff all pass.
 * Strategies should prefer this over calling individual `passesXFilter`
 * functions so new filters in the registry apply automatically without
 * strategy edits. Disabled filters short-circuit to true inside each
 * `pass` function, so the enable check isn't repeated here.
 */
export function passesAllEntryFilters(ctx: FilterPassContext): boolean {
    for (const filter of Object.values(ENTRY_FILTER_REGISTRY)) {
        if (!filter.pass(ctx)) return false;
    }
    return true;
}

/**
 * Same iteration as `passesAllEntryFilters`, but returns the key of the
 * first filter that rejected — or `null` if every filter passed. Used by
 * strategies that want to attribute a `trade-skip` to the specific gate
 * (e.g. `gate:filter:adx`) instead of a generic `registryFilter`.
 */
export function firstFailingEntryFilter(ctx: FilterPassContext): string | null {
    for (const filter of Object.values(ENTRY_FILTER_REGISTRY)) {
        if (!filter.pass(ctx)) return filter.key;
    }
    return null;
}

/**
 * Run every enabled exit filter. Returns the registry **key** of the first
 * filter that returns a `{type: "exit"}` result — `modifySl` results are
 * intentionally ignored here so strategies' `shouldExit` doesn't fire a
 * market exit on what is meant to be a stop-loss tighten. Returns `false`
 * when no filter fires.
 *
 * The truthy/falsy contract is preserved so strategies stay back-compat with
 * the boolean shape: any flow like `if (anyExitFilterTriggered(ctx)) return
 * true;` still treats a fired exit-type filter as a signal-style close. The
 * returned key lets callers that propagate the result directly (e.g.
 * `return anyExitFilterTriggered(ctx)`) attribute the exit to the specific
 * firing filter — backtest + engine consume the string and surface it as
 * the exit reason instead of a generic `"signal"`.
 *
 * The structured `modifySl` results live behind `collectExitFilterResults`
 * for the engine / backtest to consume on the bracket-modify pathway —
 * those callers do their own composition / tightest-wins selection.
 */
export function anyExitFilterTriggered(ctx: ExitFilterTriggerContext): ExitReason | false {
    for (const filter of Object.values(EXIT_FILTER_REGISTRY)) {
        const result = filter.trigger(ctx);
        // Filter keys must be members of ExitReason — add to the union in
        // strategy-types.ts when registering a new exit filter.
        if (result && result.type === "exit") return filter.key as ExitReason;
    }
    return false;
}

/**
 * Pick the tightest favorable SL price across modifySl candidates.
 *
 * "Favorable" is side-aware: longs want a higher SL price; shorts want a
 * lower one. The function takes the tightest (max for longs, min for
 * shorts) across all finite candidates, then gates it against
 * `currentSlPrice`.
 *
 * Edge-case contract:
 *  - `candidates` empty → returns `null`.
 *  - All candidates non-finite (NaN / ±Infinity) → returns `null`.
 *  - `currentSlPrice == null` (no SL recorded yet) → any finite candidate
 *    is accepted; the tightest one is returned. Treat null as "no current
 *    SL" rather than blocking the modify.
 *  - `currentSlPrice` finite → returns the tightest candidate only when
 *    it STRICTLY tightens vs `currentSlPrice` (long: best > current,
 *    short: best < current). A candidate exactly equal to `currentSlPrice`
 *    does NOT count as tighter and yields `null` — the engine / backtest
 *    skip the no-op modify.
 *
 * Used by both the engine and backtest when composing modifySl results
 * from multiple firing exit filters on a single bar.
 */
export function pickTightestFavorableSl(
    side: OrderSide,
    currentSlPrice: number | null,
    candidates: number[],
): number | null {
    if (candidates.length === 0) return null;
    const isLong = side === 0;
    let best: number | null = null;
    for (const c of candidates) {
        if (!Number.isFinite(c)) continue;
        if (best == null) {
            best = c;
            continue;
        }
        best = isLong ? Math.max(best, c) : Math.min(best, c);
    }
    if (best == null) return null;
    if (currentSlPrice == null) return best;
    if (isLong ? best > currentSlPrice : best < currentSlPrice) return best;
    return null;
}

/**
 * True when a protective stop at `stopPrice` would sit at or past the market
 * — at or above it for a long, at or below it for a short — so it would
 * trigger on arrival. The engine refuses such a modify before any broker call
 * and the backtest refuses the same ratchet, both measured against the close
 * of the bar the filters decided on; this is the one predicate both ask.
 * An unknown mark answers false (fail open), which is the engine's contract.
 */
export function isStopAtOrBeyondMarket(
    side: OrderSide,
    stopPrice: number,
    marketPrice: number | null,
): boolean {
    if (marketPrice == null || !Number.isFinite(marketPrice)) return false;
    return side === 0 ? marketPrice <= stopPrice : marketPrice >= stopPrice;
}

/**
 * Which filter a taken SL ratchet is attributed to — the one rule both the
 * engine and the backtest flip their break-even / trail flags through, so a
 * close is labelled the same on both paths.
 *
 * Attribution goes to the filter(s) whose candidate *is* `tightest`, not to
 * every filter that fired: a break-even request the trail out-tightened did
 * not move the stop. Break-even additionally needs the stop at or beyond
 * entry — a negative offset that only tightens an underwater stop closes as a
 * plain stop loss. A tie credits both.
 */
export function attributeSlRatchet(
    side: OrderSide,
    entryPrice: number,
    tightest: number,
    results: ReadonlyArray<{ key: string; result: NonNullable<ExitFilterResult> }>,
): { breakEven: boolean; trail: boolean } {
    const winningKeys = new Set<string>();
    for (const r of results) {
        if (r.result.type === "modifySl" && r.result.newSlPrice === tightest) winningKeys.add(r.key);
    }
    const atOrBeyondEntry = side === 0 ? tightest >= entryPrice : tightest <= entryPrice;
    return {
        breakEven: winningKeys.has("breakeven") && atOrBeyondEntry,
        trail: winningKeys.has("trail"),
    };
}

/**
 * Collect every non-null exit-filter result on this evaluation. The
 * engine and backtest call this to drive the bracket-modify pathway
 * (collect `modifySl` candidates, take the tightest favorable one) and
 * to surface exit-type results for engine-side instrumentation.
 *
 * Strategies don't call this — they stay on `anyExitFilterTriggered`.
 */
export function collectExitFilterResults(ctx: ExitFilterTriggerContext): {
    key: string;
    result: NonNullable<ExitFilterResult>;
}[] {
    const out: { key: string; result: NonNullable<ExitFilterResult> }[] = [];
    for (const filter of Object.values(EXIT_FILTER_REGISTRY)) {
        const result = filter.trigger(ctx);
        if (result != null) out.push({ key: filter.key, result });
    }
    return out;
}

/**
 * Capture every entry filter's runtime state at entry-placement time.
 * Drives the live-vs-backtest replay engine — pinned alongside
 * paramSnapshot on the trade row so replay can reconstruct the exact
 * gate evaluation the live engine performed.
 *
 * Today's filters are stateless so this function returns an empty object
 * for every deployment. The plumbing exists so a future stateful filter
 * (e.g. daily trade counter, cooldown timer, session-stats accumulator)
 * can declare state without invasive refactor. Filters that omit the
 * `snapshot` hook contribute nothing to the returned object.
 */
export function snapshotAllFilterState(ctx: FilterPassContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const filter of Object.values(ENTRY_FILTER_REGISTRY)) {
        if (!filter.snapshot) continue;
        const snap = filter.snapshot(ctx);
        if (snap !== undefined) out[filter.key] = snap;
    }
    return out;
}

/**
 * Unique set of timeframes the engine needs to fetch before calling
 * `shouldExit` — one per enabled exit filter that operates on a non-
 * strategy timeframe. Called once per tick per deployment so the engine
 * can parallel-fetch everything the exit filters need in a single round
 * trip per unique timeframe.
 */
export function getExitFilterTimeframes(params: AllFilterParams): Timeframe[] {
    const set = new Set<Timeframe>();
    for (const filter of Object.values(EXIT_FILTER_REGISTRY)) {
        if (!filter.neededTimeframes) continue;
        const tfs = filter.neededTimeframes(params);
        if (!tfs) continue;
        for (const tf of tfs) set.add(tf);
    }
    return Array.from(set);
}

/**
 * The one sentence every surface says about an **enabled** exit filter set to
 * a timeframe only the live engine serves — the create routes' 400, the group
 * PATCH's, the engine's activation line, `runBacktest`'s throw and the backtest
 * CLI's refusal all pass it through verbatim and append only their own
 * consequence (ui/copy.md, *A refusal the operator cannot retry*).
 *
 * Keyed on `neededTimeframes` rather than on `ema_exit` by name: the field is
 * the registry's own declaration that a filter reads bars the strategy's series
 * does not carry, and only the engine populates `crossTimeframeBars` — the
 * backtest and replay build their contexts with an empty map at every site, so
 * the filter is inert in every measurement and live on every tick. Any future
 * filter that declares a timeframe inherits the refusal without an edit here.
 *
 * Subject-neutral for the reason `instrumentRefusalFor` is: a deployment and a
 * backtest run are refused for the same reason, and a sentence naming one of
 * them cannot be reused by the other without being rewritten.
 *
 * Not permanent in the deploy flow's sense — the operator's move is one select
 * on a form they still have — which is why it names that control rather than
 * telling them to delete and recreate.
 */
export function crossTimeframeExitRefusalFor(params: AllFilterParams): string | null {
    const blob = params as unknown as Record<string, unknown>;
    const phrases: string[] = [];
    for (const filter of Object.values(EXIT_FILTER_REGISTRY)) {
        if (!blob[filter.enableKey]) continue;
        const tfs = filter.neededTimeframes?.(params);
        if (!tfs || tfs.length === 0) continue;
        phrases.push(`${filter.name} is set to read ${tfs.join(" and ")} bars`);
    }
    if (phrases.length === 0) return null;
    return (
        `${phrases.join(", and ")}, and only the live engine fetches those. ` +
        `The backtest and the replay run the strategy's own series alone, so the filter never fires ` +
        `in a measurement and always fires live — a result measured with it describes a strategy that ` +
        `would not be the one traded. Set the exit timeframe to "Same as strategy", or turn the filter off.`
    );
}

// ── Re-export param types ─────────────────────────────────────────

export type { AdxFilterParams } from "./adx";
export type { SlopeFilterParams } from "./slope";
export type { PullbackDepthFilterParams } from "./pullback-depth";
export type { VolumeFilterParams } from "./volume";
export type { RsiExtremeFilterParams } from "./rsi-extreme";
export type { RejectionBarFilterParams } from "./rejection-bar";
export type { TimeWindowFilterParams } from "./time-window";
export type { EmaExitFilterParams } from "../exit-filters/ema-exit";
export type { BreakevenFilterParams } from "../exit-filters/breakeven";
export type { TimeStopFilterParams, TimeStopProgressMode } from "../exit-filters/time-stop";
export type { TrailFilterParams, TrailMode } from "../exit-filters/trail";
