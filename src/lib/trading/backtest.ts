import { calculateAll } from "./indicators";
import { defaultParamValues, migrateLegacyParamOverrides, resolveTimeframe } from "./strategy-types";
import { collectSessionWindows, currentCmeSessionStart, parseHHMM } from "./session/session";
import {
  CME_EARLY_CLOSES,
  EARLY_CLOSE_CALENDAR_FROM,
  EARLY_CLOSE_CALENDAR_THROUGH,
  EARLY_CLOSE_FLATTEN_CUSHION_MIN,
  isInTradableBar,
  isInTradableSessionWindow,
  isOutsideCalendarSpan,
} from "./session/exchange-calendar";
import { etDateKey, markFixedSeries } from "./session/session-utils";
import { isValidBracketTicks } from "./orders/brackets";
import { pnlDollarsFromTicks, priceFromTicks } from "./orders/pnl-math";
import {
  resolveRiskSizedContracts,
  playbookSizingFrom,
  type AccountRiskPosture,
  type RiskSizeResult,
} from "./orders/risk-sizer";
import {
  evaluateDailyPnlGate,
  hasDailyPnlLimits,
  NO_DAILY_PNL_LIMITS,
  type DailyPnlLimits,
} from "./daily-pnl-gate";
import type {
  StrategyModule,
  ParamValues,
  CommonParams,
  EntrySkip,
  OpenPosition,
  StrategyMeta,
  ExitReason,
  SessionWindow,
} from "./strategy-types";
import type { BarData, OrderSide } from "@/lib/brokers/types";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import type { IndicatorConfig } from "@/lib/trading/domain";

// Mirror of the engine's session-entry latch bound for parity.
const BACKTEST_SESSION_LATCH_MAX_KEYS = 32;
import { entryFilterWarmupBars, indicatorLookbackBars } from "./replay/warmup-lookback";
import {
  collectExitFilterResults,
  attributeSlRatchet,
  crossTimeframeExitRefusalFor,
  isStopAtOrBeyondMarket,
  pickTightestFavorableSl,
  EXIT_FILTER_REGISTRY,
  type AllFilterParams,
  type ExitFilterResult,
} from "./filters";
import { breakevenChecksIntrabar, computeIntrabarBreakevenSlPrice } from "./exit-filters/breakeven";

// ── Types ───────────────────────────────────────────────────────────

export type { ExitReason } from "./strategy-types";

export interface BacktestTrade {
  side: OrderSide;
  entryBarIndex: number;
  entryTimestamp: string;
  /** Timestamp of the bar whose close produced the entry signal. The
   *  backtest fills at the close of the bar `shouldEnter` fired on, so this
   *  equals `entryTimestamp` — it is carried under its own name because it
   *  is the join key against a live trade's `signal_bar_ts`, and the live
   *  entry timestamp is a wallclock that does not match. */
  signalBarTs: string;
  entryPrice: number;
  exitBarIndex: number;
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ExitReason;
  /** Set on a session flatten booked at the exit bar's open (a bar that opens
   *  past the session end): the position held none of that bar's range, so
   *  `buildTradeRecord`'s excursion walk stops a bar earlier. Absent on every
   *  other exit. */
  exitAtBarOpen?: true;
  /** P&L in ticks (positive = profit for either direction) */
  pnlTicks: number;
  /** Net P&L in dollars after fees: pnlTicks * tickValue * size - feesDollars */
  pnlDollars: number;
  /** Gross P&L in dollars before fees: pnlTicks * tickValue * size */
  grossPnlDollars: number;
  /** Round-trip fee deducted from this trade (always >= 0). */
  feesDollars: number;
  size: number;
  /** Dollars the entry's stop put at risk, before fees:
   *  `slTicks × tickValue × size`. The denominator of net R. */
  riskDollars: number;
  /** Bracket distance in ticks resolved at entry, **before** any breakeven
   *  or trail ratchet. `slPrice` reflects the level active at exit and so
   *  cannot be used to recover the initial risk; R is `pnlTicks / slTicks`. */
  slTicks: number;
  tpTicks: number;
  /** Take-profit price the bracket sat at for this trade. Resolved at
   *  entry from the strategy's tpTicks and any per-signal override. */
  tpPrice: number;
  /** Stop-loss price the bracket sat at for this trade. If breakEvenMoved
   *  fired, this is the post-BE level; otherwise the original SL. The
   *  finite-bracket renderer uses this directly so a BE-stop hit shows
   *  its SL line at entry (or entry ± offset), not at the original SL. */
  slPrice: number;
  /** True when breakeven moved the stop during this trade's lifetime. */
  breakEvenMoved: boolean;
  /** True when the trail filter ratcheted the stop during this trade's
   *  lifetime. Not derivable from `exitReason` — a trailed stop that then
   *  hit TP exits as `take_profit` and still moved. */
  trailMoved: boolean;
  /** Optional strategy-owned diagnostic payload captured at entry time. Absent
   *  when the strategy didn't emit one. Keys are strategy-specific. */
  entryMeta?: StrategyMeta;
  /** Optional strategy-owned diagnostic payload captured when a strategy-emitted
   *  exit fires. Absent for bracket exits (TP/SL/BE-stop), trail exits,
   *  time-window force-exits, and end-of-data closes — none of those go
   *  through `shouldExit`. */
  exitMeta?: StrategyMeta;
}

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Trades that exited via the breakeven stop. Excluded from winRate. */
  breakEven: number;
  /** wins / (wins + losses) — break-evens excluded from denominator. */
  winRate: number; // 0..1
  totalPnlTicks: number;
  /** Net P&L (after fees). Equals totalGrossPnlDollars when feePerSideUsd=0. */
  totalPnlDollars: number;
  /** Gross P&L (before fees). Useful for showing the fee delta in the UI. */
  totalGrossPnlDollars: number;
  /** Sum of round-trip fees across all trades (always >= 0). */
  totalFeesDollars: number;
  avgWinTicks: number;
  avgLossTicks: number;
  largestWinTicks: number;
  largestLossTicks: number;
  maxDrawdownDollars: number;
  profitFactor: number; // sum(wins) / |sum(losses)|
}

export interface IndicatorSeries {
  id: string;
  type: string;
  values: (number | null)[]; // null where insufficient data
  extra?: Record<string, (number | null)[]>;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  stats: BacktestStats;
  /** Cumulative P&L in dollars after each trade (length = trades.length + 1, first is 0) */
  equityCurve: number[];
  barsProcessed: number;
  /** Params used, after merging defaults + overrides */
  params: ParamValues;
  /** Indicator values aligned to bars, NaN → null for JSON safety */
  indicators: IndicatorSeries[];
  /**
   * Backtest-only warnings — a run that produced numbers, with something
   * about them the reader has to know (a warmup longer than the bars
   * supplied, so no entry was evaluated). A configuration the backtest
   * cannot evaluate *at all* is not a warning: it throws, because a
   * warning leaves a divergent result in the reader's hands.
   */
  warnings?: string[];
  /** Starting balance passed by the caller, if any. */
  startingBalance?: number;
  /** Peak running balance across all trades. Only present when `startingBalance` is set. */
  highestBalance?: number;
  /** Lowest running balance across all trades. Only present when `startingBalance` is set. */
  lowestBalance?: number;
  /**
   * Index into `trades` (0-based) of the trade that first drove running
   * equity to zero or below. Only present when `startingBalance` is set
   * and a blowup occurred.
   */
  blowupTradeIndex?: number;
}

/**
 * How many contracts each simulated entry carries. Exported because the CLI
 * builds one from its flags and threads it through `run-window.ts`, and a
 * second copy of the union there is a shape that drifts.
 */
export type BacktestSizing =
  | { mode: "risk"; maxRiskPerTradeUsd: number; maxContracts: number }
  | { mode: "fixed"; contracts: number };

export interface BacktestOptions {
  strategy: StrategyModule;
  bars: BarData[];
  paramOverrides?: ParamValues;
  /** Tick size (price per tick) — used to translate ticks → dollars */
  tickSize: number;
  /** Dollar value per tick per contract */
  tickValue: number;
  /** ET bounds of the instrument's cash session, from `CONTRACT_SPECS`, or
   *  null when the ticker has no row. Reaches the strategy as
   *  `ctx.daySession` and the indicators as the session-VWAP anchor. No
   *  default: a run that silently anchored on the calendar day would report
   *  a different strategy from the one the engine runs. */
  daySession: DaySessionWindow | null;
  /** When a bar's range contains both TP and SL, assume which hit first. Default: "stop_loss" (conservative) */
  conflictResolution?: "stop_loss" | "take_profit";
  /** Per-side commission/fee in USD per contract. Round-trip cost subtracted
   *  from each trade is `feePerSideUsd * 2 * size`. Set to 0 to disable.
   *  Default 0 so callers that don't opt in keep gross numbers. Topstep on
   *  /NQ is roughly $0.74/side as of 2026 — caller passes the figure. */
  feePerSideUsd?: number;
  /** Optional progress callback fired at the same cadence as the
   *  setImmediate yield (every 500 bars). `processed` is the bar index just
   *  completed; `total` is `bars.length`. Used by the SSE backtest route
   *  to stream progress to the client, and by the CLI to sleep the loop
   *  down to its CPU target — which is why the loop awaits the result. */
  onProgress?: (processed: number, total: number) => void | Promise<void>;
  /**
   * Which of two questions the run answers.
   *
   * `fixed` takes the caller's contract count on every entry and measures
   * signal quality in R, which is what an admission pass wants. `risk` sizes
   * each entry off an account risk posture through `resolveRiskSizedContracts`
   * — the engine's own resolver — and measures account fit, whose
   * `onRiskBudgetSkip` count is half the answer. The CLI exposes the two as
   * `--contracts` and `--risk-usd` and refuses both at once.
   *
   * **The count is the caller's, never a param.** `paramValues.size` was the
   * fixed count's home until the operator stopped typing one anywhere; a
   * simulation input read out of the same blob the strategy reads is a
   * sizing path that looks like configuration. Absent is one contract — the
   * R basis, and the CLI's own `--contracts` default. **Do not default
   * `risk` on**: a run that silently sized by budget reports an expectancy
   * in dollars that is not the R the admission gate reads.
   */
  sizing?: BacktestSizing;
  /**
   * The daily P&L gate's three numbers. **The caller's, because the gate is
   * the account's and a backtest has no account** — the three
   * `CommonParams` keys it used to read off the param blob moved to
   * `account_brokers` with phase 1. The CLI's `--daily-loss-usd` is what
   * fills this in; absent is no gate at all, which is what an admission run
   * wants.
   *
   * **A run at these limits previews a single-playbook account and nothing
   * wider.** The engine counts every closed trade on the account, including
   * other playbooks' and the operator's own hand trades; the backtest counts
   * one playbook's. See the module comment in `daily-pnl-gate.ts`.
   */
  dailyPnl?: DailyPnlLimits;
  /**
   * Fired for an entry the risk posture could not fit even one contract on.
   * The bar is the one `shouldEnter` fired on, so a caller can drop skips
   * that land in its warmup window the way it drops warmup trades.
   *
   * The three numbers ride along because a run of these is a stop-geometry
   * problem and the geometry is what the trader moves — and because the
   * engine's own row carries them, so a caller building both from
   * `riskBudgetSkip` gets one shape.
   */
  onRiskBudgetSkip?: (
    bar: BarData,
    numbers: { slTicks: number; riskPerContractUsd: number; maxRiskPerTradeUsd: number },
  ) => void;
  /**
   * Fired for every `EntrySkip` the strategy returned. The backtest's own
   * handling is unchanged — a skip is still no entry — but the engine
   * persists these and a run that discarded them could not be compared
   * against a live session that did.
   *
   * **The skip crosses whole, not as a count.** The gate, the prose and the
   * `detail` blob are what split a quiet session into its causes, and a
   * counter answers only how many times something happened.
   */
  onEntrySkip?: (skip: EntrySkip, bar: BarData) => void;
  /**
   * The 1m bars the series was aggregated from, ascending. Read for a bar
   * the session flatten falls inside (a 30m bar opening 15:30 against a 15:55
   * window): the bracket is resolved on its 1m bars up to the flatten minute
   * and the flatten books the open of the 1m bar at that minute, which is the
   * engine's clock. Absent, that bar takes the approximate rule in
   * `resolveFlattenInsideBar`. And, when break-even is checked intrabar
   * (`breakevenChecksIntrabar`), for an in-session bar a position holds before
   * its stop has moved to break-even; absent there, that bar is decided at its
   * close. Only those 1m bars are read, so `straddleSubBars` is all a caller
   * needs to hand over.
   */
  subBars?: readonly BarData[];
  /**
   * Optional starting account balance in dollars. When set, the result
   * carries `startingBalance` and `blowupTradeIndex` (the first trade that
   * drives running equity to ≤ 0). The backtest always runs to completion
   * regardless. When absent, no balance tracking is performed.
   */
  startingBalance?: number;
}

/**
 * The cross-leg refusals the engine makes between the `EntrySkip` branch and
 * the bracket check (`processDeploymentBar`'s contract-held, stale-latch and
 * daily-gate block). Live persists none of them, which is why they are not
 * skips.
 */
export type AccountGateRefusal = "contract_held" | "stale_latch" | "daily_pnl";

/**
 * The account a cell trades on, as the book runner models it. Absent on a
 * single run, which has no account and no neighbours.
 */
export interface AccountGate {
  /** `shouldEnter` returned plain `null` on bar `i` — the only answer that
   *  clears the engine's stale-signal latch; an `EntrySkip` does not. */
  onNoSignal(i: number): void;
  /** An entry signal on bar `i` reached the cross-leg block. A refusal ends
   *  the bar for this cell; `not_deployed` is a bar that closed before the
   *  deployment existed, which live could not have evaluated. */
  check(i: number): AccountGateRefusal | "not_deployed" | null;
}

/** A stepper's options: a single run's, plus the two hooks only the book
 *  runner sets. With neither set the stepper is `runBacktest`'s loop body. */
export interface CellStepperOptions extends BacktestOptions {
  accountGate?: AccountGate;
  /**
   * The account's posture for an entry on `bar`, in place of `sizing`'s flat
   * pair — the book's phase budget moves with its simulated closes. When set,
   * every entry is risk-sized, and a posture or sizer throw becomes an
   * `onSizeResolutionSkip` as the engine's catch makes it, rather than ending
   * the run.
   */
  postureFor?: (bar: BarData) => AccountRiskPosture | null;
  onSizeResolutionSkip?: (bar: BarData, args: { slTicks: number; failure: string }) => void;
  /** The sizer's answer for an entry it sized, by entry bar index — what the
   *  book stamps on the trade row, as the engine stamps its `paramSnapshot`. */
  onEntrySized?: (entryBarIndex: number, sized: Extract<RiskSizeResult, { sized: true }>) => void;
}

// ── Main ────────────────────────────────────────────────────────────

export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const { strategy, bars, onProgress } = opts;

  if (bars.length === 0) {
    return emptyResult(defaultParamValues(strategy.params));
  }

  const stepper = createCellStepper(opts);

  for (let i = 0; i < bars.length; i++) {
    if (i % 500 === 0 && i > 0) {
      await onProgress?.(i, bars.length);
      await new Promise<void>((r) => setImmediate(r));
    }
    if (stepper.bracketPhase(i) === "flattened") continue;
    stepper.barPhase(i);
  }

  return stepper.finish();
}

/**
 * What bar `i`'s resting bracket did. After a fill the cell is flat for
 * `barPhase(i)`'s entry check, as the engine is flat by that close (A102).
 * `filled_at_close` is a fill this run cannot place before the bar's last
 * minute — every 1m fill, and a longer bar's with no 1m bars inside it — which
 * live may not have reconciled by the close. `flattened` is the session
 * flatten inside the bar (A105): live is out of session at that close, so
 * `barPhase(i)` is skipped.
 */
export type BracketOutcome = "none" | "filled" | "filled_at_close" | "flattened";

// ── Per-cell stepper ────────────────────────────────────────────────

/**
 * One playbook's simulation, advanced one bar at a time. `runBacktest` is one
 * of these in a loop; the book runner steps several against one account.
 *
 * A bar is two calls because the account sits between them: `bracketPhase`
 * is the resting TP/SL, filled intrabar and so before anything evaluates at
 * the close, and `barPhase` is everything decided at the close — ratchets,
 * the session flatten, `shouldExit`, then entry. A bar whose bracket filled
 * still takes `barPhase`, which finds the cell flat and checks for an entry.
 * A session flatten that falls *inside* the bar is intrabar too, so
 * `bracketPhase` makes it and the bar takes no `barPhase`; on a bar that opens
 * out of the session it resolves nothing and leaves the flatten to `barPhase`.
 */
export interface CellStepper {
  /** The caller skips `barPhase(i)` on `flattened` only. */
  bracketPhase(i: number): BracketOutcome;
  barPhase(i: number): void;
  /** Close anything still open at the last bar and build the result. */
  finish(): BacktestResult;
  hasPosition(): boolean;
  /** Closed so far, in close order. */
  readonly trades: readonly BacktestTrade[];
  /** One bar of this cell's timeframe; a bar closes at its timestamp plus this. */
  readonly barLengthMs: number;
}

/** `bars` must be non-empty; `runBacktest` answers the empty case itself. */
export function createCellStepper(opts: CellStepperOptions): CellStepper {
  const {
    accountGate,
    postureFor,
    onSizeResolutionSkip,
    onEntrySized,
    strategy,
    bars,
    paramOverrides = {},
    tickSize,
    tickValue,
    daySession,
    conflictResolution = "stop_loss",
    feePerSideUsd = 0,
    sizing,
    dailyPnl = NO_DAILY_PNL_LIMITS,
    onRiskBudgetSkip,
    onEntrySkip,
    startingBalance,
    subBars,
  } = opts;

  // One contract when the caller said nothing. It is the R basis every
  // admission number is quoted on, and the only honest answer now that no
  // operator surface carries a contract count.
  const fixedContracts = sizing?.mode === "fixed" ? sizing.contracts : 1;

  const { overrides, params } = resolveCellParams(strategy, paramOverrides);

  // An enabled exit filter on a timeframe this path cannot serve is refused,
  // not warned about. The map every context below is built with is empty, so
  // the filter returns false on every bar here and fires normally on the
  // engine — the run would report a bracket the deployment does not trade.
  // A warning left that result in the operator's hands to read; this does not.
  const crossTimeframeRefusal = crossTimeframeExitRefusalFor(params as unknown as AllFilterParams);
  if (crossTimeframeRefusal) throw new Error(crossTimeframeRefusal);

  const warnings: string[] = [];

  // Nothing here writes to `bars`, so the hooks' prior-session walks over it
  // can be kept rather than repeated on every bar of a session.
  markFixedSeries(bars);

  const indicatorConfigs =
    strategy.buildIndicators?.(params) ?? strategy.config.indicators;
  const indicators = calculateAll(indicatorConfigs, bars, daySession);
  const trades: BacktestTrade[] = [];

  const { sessionWindows, barLengthMs, flattenCanFallInside } = sessionClockFor(strategy, overrides, params);
  const intrabarBreakEven = breakevenChecksIntrabar(params as unknown as AllFilterParams);

  // TODO: Tick-level backtest precision is on the punchlist; bar-level
  // approximation is the v1 contract.
  let position: (OpenPosition & {
    entryBarIndex: number;
    /** Set once the breakeven exit filter has favorably ratcheted the SL —
     *  drives the post-close `breakeven_stop` attribution in `closeTrade`. */
    breakEvenMoved: boolean;
    /** Set once the trail exit filter has favorably ratcheted the SL —
     *  drives the post-close `trail_stop` attribution in `closeTrade`. */
    trailMoved: boolean;
    /** Resolved at entry — differs from params.takeProfitTicks when ATR
     * brackets are enabled. */
    tpTicks: number;
    slTicks: number;
    /** Current SL price after any registry-filter modifySl ratchets.
     *  Null until the first modify; downstream bracket-hit logic falls
     *  back to the entry-time slTicks formula when null. Mirrors
     *  `engine.ts:deplState.slCurrentPrice`. */
    slCurrentPrice: number | null;
    entryMeta?: StrategyMeta;
  }) | null = null;
  let lastExitBarIndex = -Infinity;
  /** SL ratchets refused by `isStopAtOrBeyondMarket` — surfaced in `warnings`
   *  so a P&L shift against an older artifact is explainable. */
  let stopsRefusedBeyondMarket = 0;
  /** Flattens inside a bar with no 1m bars to resolve it on — see
   *  `resolveFlattenInsideBar`; surfaced in `warnings`. */
  let flattensWithoutSubBars = 0;
  /** Bars an `intrabar` break-even had to check at their close for want of
   *  1m bars (every in-app run); surfaced in `warnings`. */
  let intrabarBreakEvenWithoutSubBars = 0;
  const cooldownBars = estimateCooldownBars(params, barLengthMs);

  // Session-bucketed gross realized P&L for the daily-PnL gate. Keyed by
  // currentCmeSessionStart() of each trade's exit bar, so the engine and
  // backtest produce the same gate decision for identical inputs. Each
  // closed trade's grossPnlDollars adds to its exit-session bucket.
  const grossRealizedBySession = new Map<string, number>();

  // Balance simulation state — only active when startingBalance is set.
  let runningEquity = startingBalance ?? 0;
  let highestBalance = startingBalance ?? 0;
  let lowestBalance = startingBalance ?? 0;
  let blowupTradeIndex: number | undefined = undefined;

  const recordTrade = (t: BacktestTrade): void => {
    trades.push(t);
    const sessionKey = currentCmeSessionStart(new Date(t.exitTimestamp));
    grossRealizedBySession.set(
      sessionKey,
      (grossRealizedBySession.get(sessionKey) ?? 0) + t.grossPnlDollars,
    );
    if (startingBalance != null) {
      runningEquity += t.pnlDollars;
      if (runningEquity > highestBalance) highestBalance = runningEquity;
      if (runningEquity < lowestBalance) lowestBalance = runningEquity;
      if (blowupTradeIndex === undefined && runningEquity <= 0) {
        blowupTradeIndex = trades.length - 1;
      }
    }
  };

  // Backtest-scoped mirror of the engine's session-entry latch. Strategies
  // that emit `EntrySignal.sessionKey` get capped at the simulator's "fill"
  // (we treat signal acceptance as the fill since backtest has no broker).
  // Bounded eviction to match engine semantics.
  const sessionLatch = new Map<string, Set<OrderSide>>();
  const hasEnteredThisSession = (sessionKey: string, side: OrderSide): boolean =>
    sessionLatch.get(sessionKey)?.has(side) ?? false;
  const markEnteredThisSession = (sessionKey: string, side: OrderSide): void => {
    let sides = sessionLatch.get(sessionKey);
    if (!sides) {
      sides = new Set();
      sessionLatch.set(sessionKey, sides);
      while (sessionLatch.size > BACKTEST_SESSION_LATCH_MAX_KEYS) {
        const oldest = sessionLatch.keys().next();
        if (oldest.done) break;
        sessionLatch.delete(oldest.value);
      }
    }
    sides.add(side);
  };

  // Warmup offset: bars before this index don't have stable indicator
  // values (the longest enabled period hasn't finished filling). Skip
  // shouldEnter evaluation for those bars so the backtest doesn't fire
  // entries on NaN/garbage indicators. Position management still runs
  // from bar 0 — anything already open must continue to evaluate exits,
  // brackets, and trail logic regardless of warmup state.
  const warmupBars = computeBacktestWarmup(indicatorConfigs, params);

  if (warmupBars >= bars.length) {
    warnings.push(
      `Backtest skipped all entry evaluation: warmup of ${warmupBars} bars exceeds the available bar count of ${bars.length}. Either supply more historical bars or lower the strategy/filter indicator periods.`,
    );
  }

  // Bars outside the calendar's span get a full session assumed for them, and
  // the reader has to know which of their trades that touches. A warning
  // rather than a throw: the run still produces the numbers it produced
  // before, and blocking research on a table edit buys nothing here — no
  // money moves on this path. The live half refuses out loud instead; see
  // `SessionEndGuard.reportCalendarHorizon`.
  const firstEtDate = etDateKey(new Date(bars[0].timestamp));
  const lastEtDate = etDateKey(new Date(bars[bars.length - 1].timestamp));
  if (isOutsideCalendarSpan(firstEtDate) || isOutsideCalendarSpan(lastEtDate)) {
    warnings.push(
      `Bars run ${firstEtDate}..${lastEtDate}, outside the exchange early-close calendar's span ` +
        `(${EARLY_CLOSE_CALENDAR_FROM}..${EARLY_CLOSE_CALENDAR_THROUGH}). Sessions outside it are assumed to close at their normal time, ` +
        "so any holiday half-day there is simulated as a full session and its trades are not comparable to live.",
    );
  }

  /**
   * Take the tightest favourable candidate among `results` as the stop, unless
   * it sits at or past `mark` — the engine's `modifyStopLossToPrice` refuses
   * that move, and taking it here would fill a lock the broker never held, at
   * a price not traded after the move. The bar-close ratchet and the intrabar
   * break-even both come through here, so the refusal and the flags are one rule.
   */
  const ratchetStop = (
    pos: NonNullable<typeof position>,
    results: ReadonlyArray<{ key: string; result: NonNullable<ExitFilterResult> }>,
    mark: number,
  ): "moved" | "refused" | "none" => {
    const slCandidates = results.flatMap((r) => (r.result.type === "modifySl" ? [r.result.newSlPrice] : []));
    if (slCandidates.length === 0) return "none";
    const tightest = pickTightestFavorableSl(pos.side, pos.slCurrentPrice, slCandidates);
    if (tightest == null) return "none";
    if (isStopAtOrBeyondMarket(pos.side, tightest, mark)) return "refused";
    pos.slCurrentPrice = tightest;
    // Flags are stamped through the engine's rule so closeTrade's label for
    // the eventual SL fill matches the live one.
    const attribution = attributeSlRatchet(pos.side, pos.entryPrice, tightest, results);
    if (attribution.breakEven) pos.breakEvenMoved = true;
    if (attribution.trail) pos.trailMoved = true;
    return "moved";
  };

  const bracketHitOn = (pos: NonNullable<typeof position>, b: BarData) =>
    checkBracketHit(b, pos, pos.tpTicks, pos.slTicks, tickSize, conflictResolution, pos.breakEvenMoved, pos.trailMoved, pos.slCurrentPrice);

  /**
   * Break-even checked inside bar `i`, on its 1m bars in order: the resting
   * bracket first (stop-first at 1m grain), then the arm on the range so far,
   * then the ratchet with that minute's close as the mark. Returns the index
   * of the minute the stop moved at, or null. A minute that touches the
   * bracket ends the walk unmoved, and the bar is then decided as at bar close.
   */
  const moveBreakEvenInsideBar = (pos: NonNullable<typeof position>, i: number, inside: readonly BarData[]): number | null => {
    let high = -Infinity;
    let low = Infinity;
    for (let k = 0; k < inside.length; k++) {
      const sub = inside[k];
      if (bracketHitOn(pos, sub) != null) return null;
      high = Math.max(high, sub.high);
      low = Math.min(low, sub.low);
      const newSlPrice = computeIntrabarBreakevenSlPrice({
        bars,
        barIndex: i,
        position: pos,
        tickSize,
        params: params as unknown as AllFilterParams,
        formingBar: { high, low },
      });
      if (newSlPrice == null) continue;
      const result = { type: "modifySl", newSlPrice } as const;
      if (ratchetStop(pos, [{ key: EXIT_FILTER_REGISTRY.breakeven.key, result }], sub.close) === "moved") return k;
    }
    return null;
  };

  const bracketPhase = (i: number): BracketOutcome => {
    if (!position) return "none";
    const bar = bars[i];
    position.barsSinceEntry++;

    // A bar that opens at or past the flatten (15:55 on 1m or 5m, or any bar
    // whose open is a window bound on its grid) is one the engine is already
    // flat for, so no bracket leg can fill on it; `barPhase` books the flatten
    // at its open (A106).
    const barOpenMs = Date.parse(bar.timestamp);
    if (!isInTradableSessionWindow(new Date(barOpenMs), sessionWindows)) return "none";

    // When the engine's clock flattens inside this bar (A105), nothing after
    // that minute may reach the bracket, and this bar's close is not
    // evaluated — live is already flat by then.
    const flattenAtMs = flattenCanFallInside
      ? flattenInstantInsideBar(barOpenMs, barLengthMs, sessionWindows)
      : null;
    if (flattenAtMs != null) {
      const inside = subBarsInside(subBars, barOpenMs, barOpenMs + barLengthMs);
      if (inside.length === 0) flattensWithoutSubBars++;
      const exit = resolveFlattenInsideBar(bar, inside, flattenAtMs, position, tickSize, conflictResolution);
      const trade = closeTrade(position, i, bar, exit.price, exit.reason, position.size, tickSize, tickValue, feePerSideUsd);
      // A bracket fill keeps the bar-open stamp every exit carries; the
      // flatten is stamped at the engine's instant, so a parity join on exit
      // time lines up.
      recordTrade(
        exit.reason === "time_window_close"
          ? { ...trade, exitTimestamp: new Date(flattenAtMs).toISOString() }
          : trade,
      );
      position = null;
      lastExitBarIndex = i;
      return "flattened";
    }

    // Once the stop moved at a minute inside the bar, only the minutes after
    // it can fill the moved bracket, walked in order: the first touch decides,
    // the conflict rule only within one minute.
    let hit: ReturnType<typeof bracketHitOn> | undefined;
    let fillSubBars = subBars;
    if (intrabarBreakEven && !position.breakEvenMoved) {
      const inside = subBarsInside(subBars, barOpenMs, barOpenMs + barLengthMs);
      if (inside.length === 0) intrabarBreakEvenWithoutSubBars++;
      const movedAt = moveBreakEvenInsideBar(position, i, inside);
      if (movedAt != null) {
        fillSubBars = inside.slice(movedAt + 1);
        hit = null;
        for (const sub of fillSubBars) {
          hit = bracketHitOn(position, sub);
          if (hit) break;
        }
      }
    }

    // Check TP/SL first — they take priority since they're resting orders.
    // Effective SL is the entry-time slTicks unless a registry-filter
    // modifySl has ratcheted it (slCurrentPrice).
    if (hit === undefined) hit = bracketHitOn(position, bar);
    if (hit) {
      const outcome = fillPlacedBeforeLastMinute(barOpenMs, barLengthMs, fillSubBars, position, tickSize, conflictResolution)
        ? "filled"
        : "filled_at_close";
      recordTrade(closeTrade(position, i, bar, hit.price, hit.reason, position.size, tickSize, tickValue, feePerSideUsd));
      position = null;
      lastExitBarIndex = i;
      return outcome;
    }
    return "none";
  };

  const barPhase = (i: number): void => {
    const bar = bars[i];
    const barOpen = new Date(bar.timestamp);
    // One call, deliberately: the window term reads the bar's open and the
    // calendar term reads its close, and that asymmetry lives inside
    // `isInTradableBar` rather than here. Composing the two terms at this
    // call site is what would let a future term added to the shared
    // predicate reach the engine and silently miss the backtest — A63's own
    // shape. See `exchange-calendar.ts`; the engine asks the instant-shaped
    // sibling off a wall clock that is already the close.
    const inWindow = isInTradableBar(barOpen, barLengthMs, sessionWindows);

    if (position) {
      // Force-exit at session close — takes priority over everything else at
      // this close. Live is flat by it, so no ratchet runs on this bar either:
      // one would stamp a stop move the broker never held onto the row (A107).
      if (!inWindow) {
        const exit = sessionEndExit(bar, barOpen, sessionWindows);
        const trade = closeTrade(position, i, bar, exit.price, "time_window_close", position.size, tickSize, tickValue, feePerSideUsd);
        // A flatten priced at the close is stamped there, as `bracketPhase`
        // stamps an inside-bar flatten at its minute: that close is the halt
        // term's start, the engine's instant (A111).
        recordTrade(
          exit.atBarOpen
            ? { ...trade, exitAtBarOpen: true }
            : { ...trade, exitTimestamp: new Date(barOpen.getTime() + barLengthMs).toISOString() },
        );
        position = null;
        lastExitBarIndex = i;
        return;
      }

      // Registry exit filters — modifySl pathway. Mirrors engine.ts: collect
      // every modifySl candidate, take the tightest favorable, ratchet
      // `position.slCurrentPrice` so the next bar's bracket-hit check sees
      // the new SL. Exit-type results are handled by the strategy's
      // `shouldExit` below (which calls `anyExitFilterTriggered`).
      const exitFilterCtx = {
        bars,
        barIndex: i,
        indicators,
        side: position.side,
        params: params as unknown as AllFilterParams,
        tickSize,
        crossTimeframeBars: new Map<string, BarData[]>(),
        position,
      };
      // The engine measures the refusal against this same close; on one the
      // position keeps its stop and the next bar retries.
      const exitFilterResults = collectExitFilterResults(exitFilterCtx);
      if (ratchetStop(position, exitFilterResults, bar.close) === "refused") stopsRefusedBeyondMarket++;

      // Strategy-defined exit (evaluated at bar close)
      const exitCtx = {
        bars,
        barIndex: i,
        indicators,
        position,
        params,
        tickSize,
        daySession,
        sessionWindows,
        // Empty, and it stays empty: the backtest runs one bar series. An
        // enabled exit filter that would read this map was refused before the
        // loop, so the only filters reaching it here are the `same`-timeframe
        // ones, which read the strategy's own indicator pipeline instead.
        crossTimeframeBars: new Map<string, BarData[]>(),
        hasEnteredThisSession,
      };
      const exitDecision = strategy.shouldExit(exitCtx);
      const exitTriggered =
        exitDecision === true ||
        (typeof exitDecision === "string" && exitDecision.length > 0) ||
        (typeof exitDecision === "object" && exitDecision.exit === true);
      if (exitTriggered) {
        const exitMeta =
          typeof exitDecision === "object" ? exitDecision.meta : undefined;
        // String result = registry exit-filter key (e.g. "time_stop",
        // "ema_exit"). The `anyExitFilterTriggered` return type is
        // `ExitReason | false`, so any string here is guaranteed to be a
        // valid ExitReason at the type level.
        const reason: ExitReason =
          typeof exitDecision === "string" ? (exitDecision as ExitReason) : "signal";
        recordTrade(closeTrade(position, i, bar, bar.close, reason, position.size, tickSize, tickValue, feePerSideUsd, exitMeta));
        position = null;
        lastExitBarIndex = i;
      }
      return;
    }

    // Flat → check entry
    if (i < warmupBars) return;
    // An entry is judged at the bar's close, the instant the engine evaluates
    // `shouldEnter` at, through its own composite. The flatten above keeps
    // `isInTradableBar`; judging the entry at the open let in the bar whose
    // close is past a window end and refused the one whose close reopens it
    // (A103).
    if (!isInTradableSessionWindow(new Date(barOpen.getTime() + barLengthMs), sessionWindows)) return;
    if (i - lastExitBarIndex < cooldownBars) return;

    const entryCtx = {
      bars,
      barIndex: i,
      indicators,
      position: null,
      params,
      tickSize,
      daySession,
      sessionWindows,
      // Entries never use cross-timeframe bars — only exits do.
      crossTimeframeBars: new Map<string, BarData[]>(),
      hasEnteredThisSession,
    };
    const signal = strategy.shouldEnter(entryCtx);
    if (!signal) {
      accountGate?.onNoSignal(i);
      return;
    }
    // Structured skip — same outcome as null in backtest (no entry), but it
    // is reported rather than discarded. The engine writes a `skipped_signals`
    // row here, so a run that swallowed it would have no counterpart to the
    // live evidence the soak is collecting.
    if ("skip" in signal) {
      onEntrySkip?.(signal, bar);
      return;
    }

    if (accountGate != null && accountGate.check(i) != null) return;

    // Daily-PnL money gate — same evaluator the engine uses, fed from the
    // backtest's session-bucketed gross realized tally so the two paths
    // produce identical decisions for identical bar/trade inputs. Backtest
    // is flat at this point (entry path), so unrealized = 0 even when the
    // include-unrealized flag is on.
    if (hasDailyPnlLimits(dailyPnl)) {
      const sessionKey = currentCmeSessionStart(new Date(bar.timestamp));
      const realizedGross = grossRealizedBySession.get(sessionKey) ?? 0;
      const gate = evaluateDailyPnlGate({
        ...dailyPnl,
        realizedGross,
        unrealized: 0,
      });
      if (gate.tripped) return;
    }

    // Bracket math mirrors engine.ts: both legs are the strategy's and the
    // platform collapses neither. The three paths share `isValidBracketTicks`
    // and nothing else, so the numbers match by construction.
    if (!isValidBracketTicks(signal.slTicks) || !isValidBracketTicks(signal.tpTicks)) return;
    const entryTp = signal.tpTicks;
    const entrySl = signal.slTicks;

    // Sizing. Under `risk` this is the engine's own resolver on the same
    // three inputs, so the count and the budget skip are the ones the engine
    // would have produced; otherwise it is the caller's fixed count, which is
    // what an admission run in R wants.
    let entrySize: number;
    if (postureFor != null || sizing?.mode === "risk") {
      let sized: RiskSizeResult;
      try {
        sized = resolveRiskSizedContracts({
          slTicks: entrySl,
          tickValue,
          feePerSideUsd,
          posture:
            postureFor != null
              ? postureFor(bar)
              : sizing?.mode === "risk"
                ? {
                    maxRiskPerTradeUsd: sizing.maxRiskPerTradeUsd,
                    maxContracts: sizing.maxContracts,
                  }
                : null,
          playbook: playbookSizingFrom(params),
          where: "backtest",
        });
      } catch (err) {
        // A flat `--risk-usd` the sizer cannot read is the caller's mistake and
        // ends the run. An account's posture failing is the engine's
        // `size_resolution` skip, so the book records it and moves on.
        if (postureFor == null) throw err;
        onSizeResolutionSkip?.(bar, {
          slTicks: entrySl,
          failure: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!sized.sized) {
        onRiskBudgetSkip?.(bar, {
          slTicks: entrySl,
          riskPerContractUsd: sized.riskPerContractUsd,
          maxRiskPerTradeUsd: sized.budgetUsd,
        });
        return;
      }
      entrySize = sized.contracts;
      onEntrySized?.(i, sized);
    } else {
      entrySize = fixedContracts;
    }

    position = {
      side: signal.side,
      entryPrice: bar.close,
      entryTimestamp: bar.timestamp,
      barsSinceEntry: 0,
      entryFilledAt: bar.timestamp,
      size: entrySize,
      entryBarIndex: i,
      breakEvenMoved: false,
      trailMoved: false,
      tpTicks: entryTp,
      slTicks: entrySl,
      slCurrentPrice: null,
      entryMeta: signal.meta,
    };

    // Backtest's "fill" = signal acceptance. Latch the engine-equivalent
    // session cap so subsequent `shouldEnter` calls on the same session
    // see the side as already taken. Strategies that don't emit
    // `sessionKey` opt out (no latch fires).
    if (signal.sessionKey != null) {
      markEnteredThisSession(signal.sessionKey, signal.side);
    }
  };

  const finish = (): BacktestResult => {
    // Close any still-open position at the last bar
    if (position) {
      const last = bars[bars.length - 1];
      recordTrade(
        closeTrade(
          position,
          bars.length - 1,
          last,
          last.close,
          "end_of_data",
          position.size,
          tickSize,
          tickValue,
          feePerSideUsd,
        ),
      );
    }

    const stats = computeStats(trades);
    const equityCurve = buildEquityCurve(trades);

    const indicatorSeries: IndicatorSeries[] = Array.from(indicators.values()).map((r) => ({
      id: r.id,
      type: r.type,
      values: r.values.map((v) => (Number.isFinite(v) ? v : null)),
      extra: r.extra
        ? Object.fromEntries(
            Object.entries(r.extra).map(([k, arr]) => [
              k,
              arr.map((v) => (Number.isFinite(v) ? v : null)),
            ]),
          )
        : undefined,
    }));

    const runWarnings = [
      ...warnings,
      ...(stopsRefusedBeyondMarket > 0
        ? [
            `${stopsRefusedBeyondMarket} stop move${stopsRefusedBeyondMarket === 1 ? " was" : "s were"} refused because the new stop sat at or past the bar's close; the stop stayed where it was, as it would live.`,
          ]
        : []),
      ...(flattensWithoutSubBars > 0
        ? [
            `${flattensWithoutSubBars} session flatten${flattensWithoutSubBars === 1 ? "" : "s"} fell inside a bar with no 1m bars to resolve it on. ` +
              "Those positions count a stop the bar touched, never a target, and are otherwise flattened at the bar's close, capped at the target.",
          ]
        : []),
      ...(intrabarBreakEvenWithoutSubBars > 0
        ? [
            intrabarBreakEvenWithoutSubBars === 1
              ? "1 bar was checked for break-even at its close, not minute by minute: this run has no 1m bars for it."
              : `${intrabarBreakEvenWithoutSubBars} bars were checked for break-even at their close, not minute by minute: this run has no 1m bars for them.`,
          ]
        : []),
    ];

    return {
      trades,
      stats,
      equityCurve,
      barsProcessed: bars.length,
      params,
      indicators: indicatorSeries,
      warnings: runWarnings.length > 0 ? runWarnings : undefined,
      ...(startingBalance != null ? { startingBalance, highestBalance, lowestBalance, blowupTradeIndex } : {}),
    };
  };

  return {
    bracketPhase,
    barPhase,
    finish,
    hasPosition: () => position != null,
    trades,
    barLengthMs,
  };
}

// ── Bracket hit detection ───────────────────────────────────────────

function checkBracketHit(
  bar: BarData,
  position: OpenPosition,
  tpTicks: number | null,
  slTicks: number | null,
  tickSize: number,
  conflictResolution: "stop_loss" | "take_profit",
  breakEvenMoved: boolean,
  trailMoved: boolean,
  slCurrentPrice: number | null,
): { price: number; reason: ExitReason } | null {
  const isLong = position.side === 0;

  const tpPrice = tpTicks != null ? targetPriceOf(position, tpTicks, tickSize) : null;
  // Registry-filter modifySl wins over the legacy slTicks-based formula.
  // The caller is responsible for ensuring slCurrentPrice only reflects
  // favorable ratchets (pickTightestFavorableSl rejects loosenings) so a
  // BE-moved position's slTicks-derived effective SL still applies when
  // no registry-filter ratchet has fired.
  const slPrice =
    slCurrentPrice != null
      ? slCurrentPrice
      : slTicks != null
        ? stopPriceOf(position, slTicks, tickSize)
        : null;

  const tpHit = tpPrice != null && (isLong ? bar.high >= tpPrice : bar.low <= tpPrice);
  const slHit = slPrice != null && (isLong ? bar.low <= slPrice : bar.high >= slPrice);
  // Attribute the SL bracket fill by which filter last ratcheted: BE
  // wins over trail (stricter intent), trail wins over the unmoved
  // original stop. Stats bucket purely on pnl sign, but the reason is
  // surfaced in trade rows / charts for diagnostics.
  const slReason: ExitReason = breakEvenMoved
    ? "breakeven_stop"
    : trailMoved
      ? "trail_stop"
      : "stop_loss";

  if (tpHit && slHit) {
    return conflictResolution === "stop_loss"
      ? { price: slPrice!, reason: slReason }
      : { price: tpPrice!, reason: "take_profit" };
  }
  if (tpHit) return { price: tpPrice!, reason: "take_profit" };
  if (slHit) return { price: slPrice!, reason: slReason };
  return null;
}

// On the tick grid through `priceFromTicks`, as the engine's live brackets
// are: on a 0.1 tick, `entry ± ticks * tickSize` in doubles lands past the
// tick it names and misses an exact touch (A110).
function targetPriceOf(position: OpenPosition, tpTicks: number, tickSize: number): number {
  return priceFromTicks(position.entryPrice, position.side === 0 ? tpTicks : -tpTicks, tickSize);
}

function stopPriceOf(position: OpenPosition, slTicks: number, tickSize: number): number {
  return priceFromTicks(position.entryPrice, position.side === 0 ? -slTicks : slTicks, tickSize);
}

// ── A cell's params and session clock ───────────────────────────────

function resolveCellParams(
  strategy: StrategyModule,
  paramOverrides: ParamValues,
): { overrides: ParamValues; params: CommonParams } {
  // Cast is safe: strategy.params is built via withCommonParams(), enforced
  // by validateStrategy() at registration time.
  const overrides = migrateLegacyParamOverrides(strategy.key ?? "", paramOverrides);
  const params = {
    ...defaultParamValues(strategy.params),
    ...overrides,
  } as CommonParams;
  return { overrides, params };
}

interface SessionClock {
  sessionWindows: SessionWindow[];
  barLengthMs: number;
  /** False when no bar of this length can hold a flatten minute, so the
   *  per-minute scan is skipped; see `flattenCanFallInside`. */
  flattenCanFallInside: boolean;
}

function sessionClockFor(
  strategy: StrategyModule,
  overrides: ParamValues,
  params: CommonParams,
): SessionClock {
  const sessionWindows = collectSessionWindows(strategy.config.session, params);

  /**
   * How long one bar is, in ms. Needed because `bar.timestamp` is the bar's
   * **open** and the exchange-calendar question is about its close: the
   * session's last bar on a 13:00 ET half-day is the one that *ends* at the
   * halt, and asking about its open would let it through and hand the
   * force-exit to the next bar the series holds — the 18:00 Globex reopen,
   * five hours later. That was the backtest half of A63.
   *
   * Read from the declared timeframe rather than from `bars[1] - bars[0]`,
   * for the reason `TIMEFRAME_SECONDS` states: the first pair can straddle a
   * session gap.
   *
   * **Resolved against the caller's overrides, not the merged param blob**,
   * which is how every other `resolveTimeframe` call site in the repo spells
   * it — including the bar fetcher that decides what timeframe these bars
   * actually are. `defaultParamValues` always carries `COMMON_PARAMS`'
   * `"5m"`, so the merged blob answers `"5m"` for every strategy whatever its
   * `config.timeframe` says.
   */
  const barLengthMs =
    (TIMEFRAME_SECONDS[
      resolveTimeframe(strategy.config, overrides) as import("@/lib/trading/domain").Timeframe
    ] ?? TIMEFRAME_SECONDS[strategy.config.timeframe]) * MS_PER_SECOND;

  return {
    sessionWindows,
    barLengthMs,
    flattenCanFallInside: flattenCanFallInside(barLengthMs, sessionWindows),
  };
}

// ── A flatten inside a bar ──────────────────────────────────────────

const MINUTE_MS = 60_000;

/** The ET minutes the calendar term turns false at: each early close less
 *  the cushion. Its other edge, the 18:00 reopen, is on every bar grid. */
const EARLY_CLOSE_FLATTEN_MINUTES: readonly number[] = [...new Set(CME_EARLY_CLOSES.values())].map(
  (close) => (parseHHMM(close) ?? 0) - EARLY_CLOSE_FLATTEN_CUSHION_MIN,
);

/**
 * Whether any bar of this length can hold a minute at which
 * `isInTradableSessionWindow` turns false. Bars open on their own grid in ET
 * minutes (a whole-hour UTC offset keeps them there), so when every bound the
 * predicate can change at — each window's start and end, each early-close
 * flatten minute — sits on that grid, no bar holds one. That is 1m always and
 * 5m against every shipped window, which makes "1m and 5m are unchanged"
 * structural. A pause window off the grid, or a bound that does not parse,
 * keeps the scan.
 */
function flattenCanFallInside(
  barLengthMs: number,
  sessionWindows: ReadonlyArray<SessionWindow>,
): boolean {
  if (barLengthMs <= MINUTE_MS) return false;
  const barMinutes = barLengthMs / MINUTE_MS;
  const bounds = sessionWindows.flatMap((w) => [parseHHMM(w.start), parseHHMM(w.end)]);
  return [...bounds, ...EARLY_CLOSE_FLATTEN_MINUTES].some((m) => m == null || m % barMinutes !== 0);
}

/** One playbook reading a bar series, as `straddleSubBars` needs it. */
export interface StraddleLeg {
  strategy: StrategyModule;
  paramOverrides?: ParamValues;
}

/**
 * The only 1m bars `runBacktest` reads: those inside a bar any of `legs`
 * flattens inside, on the same predicate `bracketPhase` asks, and, for a leg
 * that checks break-even intrabar (`breakevenChecksIntrabar`), those inside
 * every bar that opens in its session window — the bars `bracketPhase` can
 * hold a position on. Undefined when there are none — every 1m series, and
 * every 5m series against a shipped window with break-even at bar close — so
 * a caller hands over nothing rather than the whole 1m series it aggregated
 * from. All legs read `bars`, so they share its timeframe.
 */
export function straddleSubBars(
  bars: readonly BarData[],
  subBars: readonly BarData[],
  legs: readonly StraddleLeg[],
): BarData[] | undefined {
  const clocks = legs.map((leg) => {
    const { overrides, params } = resolveCellParams(leg.strategy, leg.paramOverrides ?? {});
    return {
      ...sessionClockFor(leg.strategy, overrides, params),
      intrabarBreakEven: breakevenChecksIntrabar(params as unknown as AllFilterParams),
    };
  });
  const flattenClocks = clocks.filter((clock) => clock.flattenCanFallInside);
  const intrabarClocks = clocks.filter((clock) => clock.intrabarBreakEven && clock.barLengthMs > MINUTE_MS);
  if (flattenClocks.length === 0 && intrabarClocks.length === 0) return undefined;

  const kept: BarData[] = [];
  for (const bar of bars) {
    const openMs = Date.parse(bar.timestamp);
    const clock =
      intrabarClocks.find((c) => isInTradableSessionWindow(new Date(openMs), c.sessionWindows)) ??
      flattenClocks.find((c) => flattenInstantInsideBar(openMs, c.barLengthMs, c.sessionWindows) != null);
    if (clock != null) kept.push(...subBarsInside(subBars, openMs, openMs + clock.barLengthMs));
  }
  return kept.length === 0 ? undefined : kept;
}

/**
 * The instant the engine's clock flattens inside a bar the session was still
 * open at: the first minute after the bar's open at which
 * `isInTradableSessionWindow` — the predicate every engine flatten actor
 * reads — is false. Null when the bar's open is already out (the flatten is
 * `barPhase`'s, at that open) or the session stays open to the bar's close.
 *
 * Minute steps are exact: a window bound and an early-close halt are both
 * whole minutes. On a timeframe whose bars align to the window end (1m, 5m
 * against 15:55) no bar has such a minute, so this is null on every bar and
 * those runs are unchanged.
 */
function flattenInstantInsideBar(
  barOpenMs: number,
  barLengthMs: number,
  sessionWindows: ReadonlyArray<SessionWindow>,
): number | null {
  if (barLengthMs <= MINUTE_MS) return null;
  if (!isInTradableSessionWindow(new Date(barOpenMs), sessionWindows)) return null;
  for (let t = barOpenMs + MINUTE_MS; t < barOpenMs + barLengthMs; t += MINUTE_MS) {
    if (!isInTradableSessionWindow(new Date(t), sessionWindows)) return t;
  }
  return null;
}

/** The 1m bars stamped in `[fromMs, toMs)`, by binary search over an
 *  ascending series. */
function subBarsInside(
  subBars: readonly BarData[] | undefined,
  fromMs: number,
  toMs: number,
): readonly BarData[] {
  if (subBars == null || subBars.length === 0) return [];
  const firstAtOrAfter = (ms: number): number => {
    let lo = 0;
    let hi = subBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Date.parse(subBars[mid].timestamp) < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return subBars.slice(firstAtOrAfter(fromMs), firstAtOrAfter(toMs));
}

/**
 * How a position open into a bar the flatten falls inside leaves it.
 *
 * **With the bar's 1m bars** it is what the engine does: the resting bracket
 * against each 1m bar before the flatten minute, under the run's conflict
 * rule, then the flatten at the open of the first 1m bar at or after it. A bar
 * with no print from the flatten minute to its close books the last print
 * before it.
 *
 * **Without them** (an in-app run, the prod pins' 30m fixture) the bar cannot
 * be split at the flatten, so the answer is approximate: stops pessimistic,
 * targets refused. A stop the bar touched counts, under either conflict rule,
 * because it may have filled before the flatten; a target never does, because
 * it may not have; and the flatten is the bar's close, capped at the target,
 * since live never exits better than a target that was still resting. The
 * close is not a bound on the price at the flatten minute in either direction.
 */
function resolveFlattenInsideBar(
  bar: BarData,
  inside: readonly BarData[],
  flattenAtMs: number,
  position: OpenPosition & {
    tpTicks: number;
    slTicks: number;
    breakEvenMoved: boolean;
    trailMoved: boolean;
    slCurrentPrice: number | null;
  },
  tickSize: number,
  conflictResolution: "stop_loss" | "take_profit",
): { price: number; reason: ExitReason } {
  const hitOn = (b: BarData) =>
    checkBracketHit(
      b,
      position,
      position.tpTicks,
      position.slTicks,
      tickSize,
      conflictResolution,
      position.breakEvenMoved,
      position.trailMoved,
      position.slCurrentPrice,
    );

  if (inside.length > 0) {
    for (const sub of inside) {
      if (Date.parse(sub.timestamp) >= flattenAtMs) {
        return { price: sub.open, reason: "time_window_close" };
      }
      const hit = hitOn(sub);
      if (hit) return hit;
    }
    return { price: inside[inside.length - 1].close, reason: "time_window_close" };
  }

  // No target leg, so a take-profit-first conflict rule cannot hide the stop.
  const stop = checkBracketHit(
    bar,
    position,
    null,
    position.slTicks,
    tickSize,
    conflictResolution,
    position.breakEvenMoved,
    position.trailMoved,
    position.slCurrentPrice,
  );
  if (stop) return stop;
  const isLong = position.side === 0;
  const tpPrice = targetPriceOf(position, position.tpTicks, tickSize);
  const price = isLong ? Math.min(bar.close, tpPrice) : Math.max(bar.close, tpPrice);
  return { price, reason: "time_window_close" };
}

/**
 * Whether a bar's 1m bars put its bracket fill before the bar's last minute,
 * by which live has reconciled it and is flat at the close. A 1m bar is all
 * last minute, and a bar with no 1m bars cannot say, so both answer false.
 */
function fillPlacedBeforeLastMinute(
  barOpenMs: number,
  barLengthMs: number,
  subBars: readonly BarData[] | undefined,
  position: Parameters<typeof resolveFlattenInsideBar>[3],
  tickSize: number,
  conflictResolution: "stop_loss" | "take_profit",
): boolean {
  if (barLengthMs <= MINUTE_MS) return false;
  return subBarsInside(subBars, barOpenMs, barOpenMs + barLengthMs - MINUTE_MS).some(
    (sub) =>
      checkBracketHit(
        sub,
        position,
        position.tpTicks,
        position.slTicks,
        tickSize,
        conflictResolution,
        position.breakEvenMoved,
        position.trailMoved,
        position.slCurrentPrice,
      ) != null,
  );
}

// ── Trade construction ─────────────────────────────────────────────

/**
 * The price a `time_window_close` books — the print nearest the instant the
 * engine's clock guard fires, which is not the same end of the bar in both of
 * the ways a bar can be out of session — and whether it is the bar's open, so
 * the trade record can leave a bar the position never held out of its
 * excursion (A107).
 *
 * The engine flattens the moment `isInTradableSessionWindow` turns false, so
 * this asks that same shared composite at the flatten bar's **open**:
 *
 * - **Already false at the open** — the ordinary window end. On a timeframe
 *   whose bars align to it the open *is* the window end (a 5m series against a
 *   `15:55` window opens its first out-of-window bar at 15:55), so `bar.open`
 *   is the engine's fill and the bar's close is one bar of movement the engine
 *   never saw. That close is what this booked until 2026-09-27.
 * - **Still true at the open** — the only way `isInTradableBar` refuses a bar
 *   whose open was tradable is the calendar term, which it asks at the bar's
 *   **close**: an exchange early close. The clock fires inside this bar, at the
 *   halt, so `bar.close` is the parity price and `bar.open` would flatten a
 *   whole bar early — which is why this is a branch and not the one
 *   unconditional `bar.open` the spec asked for.
 *
 * Both branches read a shared composite whole. Neither ANDs a window term and
 * a calendar term here, which is the A63 shape `exchange-calendar.ts` forbids
 * at a call site, and a future term the calendar adds at the close lands in the
 * second branch by construction.
 *
 * **Where the bars do not align to the window end** (15m or 30m against
 * `15:55`) a position never reaches this: the flatten falls inside the last
 * in-window bar and `bracketPhase` closes it there (A105), and that bar's
 * close takes no entry (A103).
 */
function sessionEndExit(
  bar: BarData,
  barOpen: Date,
  sessionWindows: ReadonlyArray<SessionWindow>,
): { price: number; atBarOpen: boolean } {
  return isInTradableSessionWindow(barOpen, sessionWindows)
    ? { price: bar.close, atBarOpen: false }
    : { price: bar.open, atBarOpen: true };
}

function closeTrade(
  position: OpenPosition & {
    entryBarIndex: number;
    tpTicks: number;
    slTicks: number;
    breakEvenMoved: boolean;
    trailMoved: boolean;
    slCurrentPrice: number | null;
    entryMeta?: StrategyMeta;
  },
  exitBarIndex: number,
  exitBar: BarData,
  exitPrice: number,
  reason: ExitReason,
  size: number,
  tickSize: number,
  tickValue: number,
  feePerSideUsd: number,
  exitMeta?: StrategyMeta,
): BacktestTrade {
  const isLong = position.side === 0;
  const priceDelta = isLong ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  // Fractional ticks: Topstep reports per-fill PnL without rounding to
  // whole ticks, so the backtest must match. Consumers that want whole
  // ticks should .toFixed() for display only.
  const pnlTicks = tickSize > 0 ? priceDelta / tickSize : 0;
  const grossPnlDollars = pnlTicks * tickValue * size;
  // Round-trip fee: per-side × 2 × contracts. Net pnl is gross minus fees;
  // when feePerSideUsd is 0, net == gross.
  const feesDollars = feePerSideUsd * 2 * size;
  const pnlDollars = grossPnlDollars - feesDollars;

  // Bracket prices for the finite-bracket renderer. TP is fixed for the
  // trade's lifetime; SL reflects the level *active at exit* — original
  // SL until a registry-filter modifySl ratcheted it (slCurrentPrice).
  const tpPrice = targetPriceOf(position, position.tpTicks, tickSize);
  const slPrice = position.slCurrentPrice ?? stopPriceOf(position, position.slTicks, tickSize);

  return {
    side: position.side,
    entryBarIndex: position.entryBarIndex,
    entryTimestamp: position.entryTimestamp,
    signalBarTs: position.entryTimestamp,
    entryPrice: position.entryPrice,
    exitBarIndex,
    exitTimestamp: exitBar.timestamp,
    exitPrice,
    exitReason: reason,
    pnlTicks,
    pnlDollars,
    grossPnlDollars,
    feesDollars,
    riskDollars: pnlDollarsFromTicks(position.slTicks, tickValue, size),
    slTicks: position.slTicks,
    tpTicks: position.tpTicks,
    tpPrice,
    slPrice,
    breakEvenMoved: position.breakEvenMoved,
    trailMoved: position.trailMoved,
    size,
    ...(position.entryMeta ? { entryMeta: position.entryMeta } : {}),
    ...(exitMeta ? { exitMeta } : {}),
  };
}

// ── Stats ──────────────────────────────────────────────────────────

/** Exported so the backtest CLI reports the same buckets the UI does. Any
 *  consumer re-deriving win/loss counts must call this, never restate it. */
export function computeStats(trades: BacktestTrade[]): BacktestStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakEven: 0,
      winRate: 0,
      totalPnlTicks: 0,
      totalPnlDollars: 0,
      totalGrossPnlDollars: 0,
      totalFeesDollars: 0,
      avgWinTicks: 0,
      avgLossTicks: 0,
      largestWinTicks: 0,
      largestLossTicks: 0,
      maxDrawdownDollars: 0,
      profitFactor: 0,
    };
  }

  let wins = 0, losses = 0, breakEven = 0;
  let totalPnlTicks = 0, totalPnlDollars = 0;
  let totalGrossPnlDollars = 0, totalFeesDollars = 0;
  let sumWinTicks = 0, sumLossTicks = 0;
  let largestWin = -Infinity, largestLoss = Infinity;
  // Profit factor uses NET pnl (post-fee) so the fee toggle actually moves
  // the number — gross PF would be insensitive to fees, defeating the
  // point of toggling them on.
  let grossProfit = 0, grossLoss = 0;

  for (const t of trades) {
    totalPnlTicks += t.pnlTicks;
    totalPnlDollars += t.pnlDollars;
    totalGrossPnlDollars += t.grossPnlDollars;
    totalFeesDollars += t.feesDollars;
    // Bucket purely on pnlTicks sign — exit reason does NOT decide. A
    // trail-stop exit that locked in +200 ticks is a win regardless of
    // its `exitReason` label. PF accumulators still use pnlDollars (net
    // of fees) so the fee toggle actually moves the number.
    if (t.pnlTicks > 0) {
      wins++;
      sumWinTicks += t.pnlTicks;
      grossProfit += t.pnlDollars;
      if (t.pnlTicks > largestWin) largestWin = t.pnlTicks;
    } else if (t.pnlTicks < 0) {
      losses++;
      sumLossTicks += t.pnlTicks;
      grossLoss += Math.abs(t.pnlDollars);
      if (t.pnlTicks < largestLoss) largestLoss = t.pnlTicks;
    } else {
      breakEven++;
    }
  }

  // Max drawdown from equity curve
  const curve = buildEquityCurve(trades);
  let peak = 0, maxDD = 0;
  for (const equity of curve) {
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    totalTrades: trades.length,
    wins,
    losses,
    breakEven,
    // Break-evens excluded from denominator so a "saved" trade doesn't
    // dilute signal quality the way a true loss would.
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    totalPnlTicks,
    totalPnlDollars,
    totalGrossPnlDollars,
    totalFeesDollars,
    avgWinTicks: wins > 0 ? sumWinTicks / wins : 0,
    avgLossTicks: losses > 0 ? sumLossTicks / losses : 0,
    largestWinTicks: wins > 0 ? largestWin : 0,
    largestLossTicks: losses > 0 ? largestLoss : 0,
    maxDrawdownDollars: maxDD,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
  };
}

function buildEquityCurve(trades: BacktestTrade[]): number[] {
  const curve = [0];
  let running = 0;
  for (const t of trades) {
    running += t.pnlDollars;
    curve.push(running);
  }
  return curve;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Bar length by declared timeframe. Read from the declaration rather than from
 * bars[0]→bars[1], which broke when the first pair straddled a session gap
 * (e.g. 16:00 close → 09:30 next-day open = 17.5h implied bar size, producing
 * a near-zero cooldown for the rest of the run).
 */
const MS_PER_SECOND = 1000;

const TIMEFRAME_SECONDS: Record<import("@/lib/trading/domain").Timeframe, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};

/**
 * Largest indicator/filter lookback window the backtest must wait through
 * before evaluating shouldEnter. Reads the same lookbacks as the replay and
 * snapshot windows (`warmup-lookback.ts`): each resolved indicator config's
 * and every registry filter's `warmupBars(params)`. Disabled filters
 * return 0 from their own hook so they drop out automatically. Used as
 * the starting bar index for entry evaluation only; position management
 * keeps running from bar 0.
 *
 * Exit-only filters do NOT contribute to entry warmup — by definition they
 * can't fire before a position exists, and their series stabilize naturally
 * by the time exits are checked. Exit-category registry entries simply omit
 * `warmupBars`, so iterating the registry is enough; no explicit category
 * filter is needed here.
 *
 * ADX uses Wilder smoothing: values exist after `period` bars but only
 * stabilize at ~2× period. EMA/SMA stabilize after 1× period, so the rest
 * of the indicators contribute their period as-is.
 */
function computeBacktestWarmup(
  indicatorConfigs: IndicatorConfig[],
  params: ParamValues,
): number {
  let max = entryFilterWarmupBars(params);
  for (const cfg of indicatorConfigs) {
    const rawPeriod = indicatorLookbackBars(cfg);
    const period = cfg.type === "ADX" ? rawPeriod * 2 : rawPeriod;
    if (period > max) max = period;
  }
  return max;
}

/**
 * A cooldown in whole bars of the run's own length — `sessionClockFor`'s,
 * resolved against the overrides. Resolving the timeframe off the merged
 * params answered COMMON_PARAMS' "5m" on every run (A80).
 */
function estimateCooldownBars(params: ParamValues, barLengthMs: number): number {
  const raw = params.cooldownSeconds;
  const cooldownSec = typeof raw === "number" ? raw : 0;
  if (cooldownSec <= 0) return 0;
  return Math.ceil((cooldownSec * MS_PER_SECOND) / barLengthMs);
}

function emptyResult(params: ParamValues): BacktestResult {
  return {
    trades: [],
    stats: computeStats([]),
    equityCurve: [0],
    barsProcessed: 0,
    params,
    indicators: [],
  };
}
