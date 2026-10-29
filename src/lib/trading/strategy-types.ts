import type {
  BarData,
  OrderSide,
  OrderType,
} from "@/lib/brokers/types";
import type { Timeframe, IndicatorConfig } from "@/lib/trading/domain";
import type { DaySessionWindow, SpecTicker } from "@/lib/trading/contracts/contract-specs";
import {
  contractSpecForTicker,
  daySessionForTicker,
  DEPLOYABLE_SPEC_TICKERS,
} from "@/lib/trading/contracts/contract-specs";
import type { IndicatorResult } from "./indicators";
import {
  FULL_RISK_PERCENT,
  NO_PLAYBOOK_CONTRACT_CAP,
  REVIEWED_MAX_CONTRACTS,
} from "./orders/risk-sizer";

// ── Parameter schema ────────────────────────────────────────────────

export type ParamType =
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "time"
  | "sessions"
  | "pauseWindows";

/** "HH:MM"–"HH:MM" half-open session window. */
export interface SessionWindow {
  start: string;
  end: string;
}

/** The single trading window a playbook owns, declared on its
 *  `StrategyConfig`. `timezone` is the window's wall-clock frame; pause
 *  windows inherit it. */
export interface MainSession {
  start: string;
  end: string;
  timezone: string;
}

/** "HH:MM"–"HH:MM" pause carved inside the playbook's session. Inherits
 *  `config.session.timezone` — no per-pause timezone field. */
export interface PauseWindow {
  start: string;
  end: string;
}

export interface ParamSchemaBase {
  label: string;
  description?: string;
  group?: string;
  /** Hide this field when another param's value doesn't match. Supports two shapes:
   *  - `{ key, value }` — show when `values[key] === value`
   *  - `{ key, values }` — show when `values[key]` is included in `values` */
  visibleWhen?:
    | { key: string; value: unknown }
    | { key: string; values: unknown[] };
}

export interface NumberParam extends ParamSchemaBase {
  type: "number" | "integer";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** When true and the live value is 0, render an "OFF" annotation
   *  after the input to signal the gate/feature is disabled.
   *  No-op when `min` is defined and `min > 0` (0 unreachable). */
  zeroMeansDisabled?: boolean;
  /**
   * Present when `min`/`max` come from a playbook's calibration constant: the
   * constant's own range object, which `min`/`max` cannot state when its off
   * value (spelled `0`) sits outside the band. Read by research surfaces only,
   * as `SelectParam.explore` is: *Try settings* drops the bounds and marks a
   * value outside the band, and the run header's `offCalibration` names it.
   */
  calibrated?: NumericCalibrationRange;
}

/** The calibration ranges a number param can carry. */
export type NumericCalibrationRange = Extract<CalibrationRange, { kind: "range" | "rangeOrOff" }>;

export interface BooleanParam extends ParamSchemaBase {
  type: "boolean";
  default: boolean;
  /** When true and rendered inside a `PlainParamRow`, this boolean is
   *  collected as one of the row's inputs instead of starting a new
   *  row. Use for sub-toggles that modify a sibling input's behavior
   *  (e.g. `trailUseSlDistance` gating `trailDistanceTicks`). */
  inline?: boolean;
}

export interface SelectParam extends ParamSchemaBase {
  type: "select";
  default: string;
  options: { value: string; label: string }[];
  /** Present when the options are calibrated points on an open domain, not
   *  every mode the code implements. See {@link ExploreDomain}. */
  explore?: ExploreDomain;
}

/**
 * The value type behind a select whose options are a calibration list — a
 * cutoff time, a period, a reward multiple — so a research surface can offer
 * any value of that type rather than only the measured ones. Absent means the
 * options are the whole set the hooks understand (a mode), and nothing may
 * offer another.
 *
 * **Read by research surfaces only**: *Try settings* and the backtest CLI under
 * `--explore`. The deployment editor, the deploy paths and the engine never
 * read it, so a live deployment keeps the calibration list. The bounds are the
 * ones the value type itself has — a period of at least 1, a multiple above 0
 * because the target resolver throws at 0 — never a calibrated range.
 */
export type ExploreDomain =
  | { type: "time" }
  | {
      type: "integer" | "number";
      min?: number;
      max?: number;
      /** Exclusive lower bound, for a value the hooks refuse at the bound itself. */
      exclusiveMin?: number;
      step?: number;
    };

/** "HH:MM" 24-hour clock string in TRADING_TIMEZONE. */
export interface TimeParam extends ParamSchemaBase {
  type: "time";
  default: string;
}

/** Array of `{start,end}` HH:MM windows. Rendered by a dedicated control
 *  in the deploy form. `maxItems` caps how many windows the UI lets the
 *  user add. Retained for back-compat with any consumer that still
 *  reads it; the active session schema uses `mainSession + pauseWindows`. */
export interface SessionsParam extends ParamSchemaBase {
  type: "sessions";
  default: SessionWindow[];
  maxItems?: number;
}

/** Array of `{start,end}` pauses inside the playbook's session. */
export interface PauseWindowsParam extends ParamSchemaBase {
  type: "pauseWindows";
  default: PauseWindow[];
  /** Optional cap on the number of pauses the form lets the user add.
   *  Unset → unlimited. */
  maxItems?: number;
}

export type ParamSchema =
  | NumberParam
  | BooleanParam
  | SelectParam
  | TimeParam
  | SessionsParam
  | PauseWindowsParam;

/**
 * Stored deployment params. Most keys are scalar (number/boolean/string),
 * but `additionalSessions` is an array of `{start,end}` HH:MM pairs — we
 * widen the value type so the index signature isn't violated by the typed
 * `CommonParams` struct that extends this. The DB persists everything as
 * JSON so the storage layer doesn't care about the union here.
 */
export type ParamValue =
  | number
  | boolean
  | string
  | SessionWindow[]
  | PauseWindow[];
export type ParamValues = Record<string, ParamValue>;

// ── Common params every strategy gets ──────────────────────────────
//
// Tunable risk + session controls the engine enforces centrally. Strategies
// merge these into their own `params` via `withCommonParams(...)` so the
// UI, backtest, and live engine all see the same schema.
//
// **Nothing here decides a bracket, a contract count, a day's budget or the
// window the playbook trades any more.** `size`, `stopLossOverrideTicks`,
// `minStopLossTicks`, `maxStopLossTicks` and `riskRewardRatio` are deleted —
// the strategy owns both legs of its bracket and the account's risk posture
// owns the size; `dailyMaxLossUsd`, `dailyMaxProfitUsd` and
// `dailyPnlIncludeUnrealized` moved to `account_brokers`, because a daily loss
// limit is the broker's rule about an account and every strategy on it spends
// one day's budget; and `mainSession` moved to `StrategyConfig.session`,
// because a playbook is an instrument plus a session plus a timeframe. Do not
// add a second opinion about any of them back onto this schema.
//
// The one carve-out (operator, 2026-10-21): `playbookMaxContracts` and
// `playbookRiskPercent` narrow the account's posture for one playbook. They
// are not a second opinion because they can only lower what the account's
// posture allows — the sizer takes the min, never the setting alone.

/** Hardcoded for now — flip this when we add multi-timezone support. */
export const TRADING_TIMEZONE = "America/New_York" as const;

/** Floor on warmup bars regardless of indicator periods — the least the live
 *  engine hands a hook. Matches the chart route's BARS_BEFORE_ENTRY so
 *  per-trade chart and replay see the same window when a strategy uses no
 *  parameterized indicators. Lives here rather than beside `computeWarmupBars`
 *  so a strategy module can read it without importing the bar-fetch graph. */
export const MIN_WARMUP_BARS = 300;

export interface CommonParams extends ParamValues {
  /** Bar timeframe to evaluate the strategy on. Defaults to whatever
   *  the strategy module declares in `config.timeframe`. The engine
   *  and backtest read `paramValues.timeframe ?? config.timeframe` so
   *  legacy deployments missing the key still resolve to the static
   *  default. */
  timeframe: string;
  /** Minimum seconds between exits and the next entry attempt. Cooldown is
   *  exit-anchored: counted from when this deployment's position closes,
   *  not from entry. Only gates this strategy. */
  cooldownSeconds: number;
  /** Zero or more `{start,end}` pauses carved inside the playbook's own
   *  `config.session`. Validated at deploy/edit time against that window:
   *  strictly inside it (wraparound-aware) and non-overlapping among
   *  themselves. */
  pauseWindows: PauseWindow[];
  /** A third contract ceiling for this playbook, beside the account's. 0 is
   *  none. Read by the sizer through `playbookSizingFrom`, never by a hook. */
  playbookMaxContracts: number;
  /** Whole percent of the account's risk budget this playbook sizes from. */
  playbookRiskPercent: number;
}

export const COMMON_PARAMS: Record<keyof CommonParams, ParamSchema> = {
  timeframe: {
    type: "select",
    label: "Timeframe",
    // Strategies override this default at registration to whatever
    // they declared in `config.timeframe`. The fallback "5m" is only
    // used if a strategy somehow loads without a config timeframe.
    default: "5m",
    options: [
      { value: "1m", label: "1 Minute" },
      { value: "3m", label: "3 Minutes" },
      { value: "5m", label: "5 Minutes" },
      { value: "15m", label: "15 Minutes" },
      { value: "30m", label: "30 Minutes" },
      { value: "1h", label: "1 Hour" },
      { value: "4h", label: "4 Hours" },
      { value: "1d", label: "1 Day" },
    ],
    group: "Execution",
    description: "Bar size the strategy evaluates on.",
  },
  cooldownSeconds: {
    type: "integer",
    label: "Cooldown (seconds)",
    default: 0,
    min: 0,
    group: "Execution",
    zeroMeansDisabled: true,
    description: "0 = disabled. Counted from when this deployment's position closes, not from entry. Only gates this strategy.",
  },
  pauseWindows: {
    type: "pauseWindows",
    label: "Pause windows",
    default: [],
    group: "Session",
    description: "Optional pauses carved inside the playbook's own session. No new entries during pauses; open positions exit at pause start.",
  },
  // The two playbook-level narrowings of the account's risk posture
  // (operator, 2026-10-21). They only lower a size; the sizer owns both.
  playbookMaxContracts: {
    type: "integer",
    label: "Playbook max contracts",
    default: NO_PLAYBOOK_CONTRACT_CAP,
    min: NO_PLAYBOOK_CONTRACT_CAP,
    max: REVIEWED_MAX_CONTRACTS,
    group: "Risk",
    zeroMeansDisabled: true,
    description:
      "Most contracts this playbook takes on one entry. 0 = no limit for this playbook.\n\n" +
      "The account's own max contracts and risk per trade still apply, so this only ever lowers the size.",
  },
  playbookRiskPercent: {
    type: "integer",
    label: "Share of account risk (%)",
    default: FULL_RISK_PERCENT,
    min: 1,
    max: FULL_RISK_PERCENT,
    group: "Risk",
    description:
      "How much of the account's risk per trade this playbook sizes from. 100 = the full amount.\n\n" +
      "At 50%, with the account's risk per trade at $350, the playbook risks up to $175 a trade. If one contract costs more than that at the stop, the entry is skipped.",
  },
};

/**
 * The window every playbook traded before the session became a playbook
 * constant — the retired `mainSession` common param's default.
 *
 * Every module that shipped before the move declares it verbatim, so its
 * recorded calibration stays valid. **It is not a fallback**: `config.session`
 * is required, so a module that wants a different window states one and a
 * module that forgets does not compile. A new playbook has no reason to reach
 * for this constant — it declares the window its research measured.
 */
export const LEGACY_DAY_SESSION: MainSession = {
  start: "09:30",
  end: "15:55",
  timezone: TRADING_TIMEZONE,
};

/**
 * Merge strategy-specific params with the common risk + session params.
 * Strategy-specific keys win on collision so a strategy can tighten a
 * default (e.g. a higher min SL) while keeping the common control visible.
 */
export function withCommonParams(
  extra: Record<string, ParamSchema>,
): Record<string, ParamSchema> {
  return { ...COMMON_PARAMS, ...extra };
}

/**
 * Resolve the effective timeframe for a deployment. Reads
 * `paramValues.timeframe` when present (the user picked one in the UI),
 * else falls back to the strategy's static `config.timeframe`. Centralized
 * so engine + backtest + chart route stay in sync.
 */
export function resolveTimeframe(
  config: { timeframe: string },
  paramValues: ParamValues | undefined,
): string {
  const fromParams = paramValues?.timeframe;
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;
  return config.timeframe;
}

// ── Strategy context (passed to shouldEnter / shouldExit) ──────────

export interface OpenPosition {
  side: OrderSide;
  entryPrice: number;
  entryTimestamp: string;
  barsSinceEntry: number;
  /** Null until the reconciler confirms the fill on Topstep and rewrites
   * entryPrice to the real fill price. Guards features (like breakeven)
   * whose math must use the real entry, not the provisional bar-close
   * we seed with at submit-time. */
  entryFilledAt: string | null;
  /** Position size in contracts. Mirrors the broker's reported size so the
   * ghost-position reconciler can detect partial fills / manual flattens
   * that drift the engine's view from reality. Seeded at entry-arming time
   * from the risk sizer's answer, corrected to broker truth on entry
   * confirmation, and resynced on every user-hub position event with
   * size>0. */
  size: number;
  /** Original SL tick distance from entry — what the strategy emitted, and
   *  what was sent to the broker.
   *  Set at every position-construction site (engine entry-arming, DB
   *  rehydrate, backtest synthetic open, replay) so exit-side logic can
   *  compute R-relative progress (`barsSinceEntry` against a fraction of
   *  `slTicks`, BE/trail arm thresholds in R-space rather than %-of-TP).
   *
   *  `null` only when the value isn't recoverable — e.g. legacy DB rows
   *  written before this field was persisted, or a force-close path where
   *  the underlying trade row never recorded a desired SL. Consumers must
   *  null-check and fall back gracefully. */
  slTicks: number | null;
}

export interface StrategyContext<P extends CommonParams = CommonParams> {
  bars: BarData[];
  barIndex: number;
  indicators: Map<string, IndicatorResult>;
  position: OpenPosition | null;
  params: P;
  /** Tick size of the contract being traded. Used by filters that measure
   * moves in price (e.g. slope filter's min-ticks threshold). */
  tickSize: number;
  /**
   * ET wall-clock bounds of the instrument's cash session, resolved from
   * `CONTRACT_SPECS` by the engine, the backtest and replay. Any quantity a
   * strategy calls a *session* one — a session VWAP, a prior-session range —
   * is measured over these bars and no others; grouping by ET calendar date
   * measures the 24-hour Globex day instead.
   *
   * `null` when the deployment's ticker has no contract-spec row. A strategy
   * that needs it passes it through `requireDaySession` and throws rather
   * than falling back to the calendar day.
   */
  daySession: DaySessionWindow | null;
  /**
   * The intervals this leg may enter in: the playbook's own `config.session`
   * minus the deployment's pause windows, already resolved by whichever caller
   * built the context.
   *
   * Handed down rather than recomputed in the hook, because the hook can no
   * longer derive it — the session is the module's and the pauses are the
   * deployment's, and only the caller holds both. The one consumer is
   * `isFirstEvaluableBarOfSession`, whose whole job is to answer *would the
   * platform have called me on an earlier bar today*; a strategy computing its
   * own answer to that is the second source of truth the day-session rule
   * already forbids one door down.
   */
  sessionWindows: SessionWindow[];
  /**
   * Pre-fetched bars on timeframes the exit filters need (e.g. a 5m
   * strategy running a 15m EMA exit). Populated by the engine before
   * `shouldExit` based on `getExitFilterTimeframes(params)`. Keyed by
   * timeframe string ("15m", "1h", etc.). Empty map when no cross-
   * timeframe exit filters are enabled. Not populated for `shouldEnter`
   * — entries evaluate on the strategy's own timeframe only.
   */
  crossTimeframeBars: Map<string, BarData[]>;
  /**
   * Engine-authoritative per-session entry latch. Strategies that enforce
   * "one entry per side per session" semantics call this in `shouldEnter`
   * to check whether a real fill has already opened the requested side
   * for the given `sessionKey`. The strategy is responsible for computing
   * `sessionKey` (its own session-day notion) and emitting the same key on
   * the resulting `EntrySignal.sessionKey` so the engine/backtest can
   * latch the flag at fill confirmation.
   *
   * Live: backed by the engine's per-deployment session-entry map, set
   * when `markEntryFilled` confirms a real fill (not on signal). Backtest:
   * backed by the simulator's per-run session map, set when a synthetic
   * entry opens. Replay: always returns false (single-trigger drift check).
   *
   * Strategies that don't need cap semantics ignore this — no contract
   * change required.
   */
  hasEnteredThisSession(sessionKey: string, side: OrderSide): boolean;
}

/** Optional diagnostic payload strategies can attach to entry/exit signals.
 *  Schema is owned by the strategy — keys are arbitrary scalars. Flows through
 *  the backtest engine onto `BacktestTrade.entryMeta` / `exitMeta` and is
 *  emitted by the JSON exporter. The live engine doesn't yet persist this
 *  field; the type slot exists for forward-compat. */
export type StrategyMeta = Record<string, number | string | boolean>;

export interface EntrySignal {
  side: OrderSide;
  /**
   * Strategy-emitted stop-loss in ticks. Mandatory — the engine refuses to
   * arm an entry if this is missing or non-positive, through the same
   * `isValidBracketTicks` the backtest and replay call.
   *
   * **Nothing collapses it on the way to the broker.** The deployment-level
   * Override / Min / Max knobs are deleted: a floor against a degenerate
   * stop is the playbook's own constant (`orb`'s `minStopTicks`), and a
   * ceiling is the account's risk budget refusing to fund the entry.
   */
  slTicks: number;
  /**
   * Strategy-emitted take-profit in ticks. Mandatory, and the platform
   * derives nothing from it: what the strategy emits is what reaches the
   * broker, validated only for being finite and positive.
   *
   * A strategy owns both legs of its bracket because a target is a claim
   * about where the trade is going, and the platform has no view on that.
   * An R-multiple target is the common case and `resolveEffectiveTpTicks`
   * in [`orders/brackets.ts`](./orders/brackets.ts) is the shared helper for
   * it — but it is the *strategy* that calls it, on its own reward constant
   * and its own emitted stop, so the two legs describe one geometry.
   */
  tpTicks: number;
  /**
   * Strategy-computed session-day key. When set, the engine latches the
   * per-deployment session-entry flag at fill confirmation so the strategy's
   * next `ctx.hasEnteredThisSession(sessionKey, side)` read returns true for
   * the rest of that session. Strategies that don't need cap semantics omit
   * this. Schema is opaque to the engine — it's only stored and replayed.
   */
  sessionKey?: string;
  /** Strategy-owned diagnostic payload — see `StrategyMeta`. */
  meta?: StrategyMeta;
}

/**
 * Closed union of backtest / replay exit reason codes. Exit filter keys
 * registered in `EXIT_FILTER_REGISTRY` must be members of this union;
 * `anyExitFilterTriggered` returns `ExitReason | false`, which forces a
 * compile-time error if a filter is registered with a key absent from
 * this list.
 */
export type ExitReason =
  | "take_profit"
  | "stop_loss"
  | "breakeven_stop"
  | "trail_stop"
  | "signal"
  | "time_stop"
  | "ema_exit"
  | "time_window_close"
  | "end_of_data";

/** Structured `shouldExit` return — pairs the exit decision with a
 *  strategy-specific reason string that surfaces on the trade row and
 *  Discord embed (e.g. "EMA close-through"). Engine prefixes with
 *  "Strategy Exit · " when rendering. */
export interface StrategyExitDecision {
  exit: true;
  reason: string;
  /** Strategy-owned diagnostic payload — see `StrategyMeta`. */
  meta?: StrategyMeta;
}

/**
 * Structured `shouldEnter` skip — strategy considered an entry, walked through
 * its gates, and a downstream gate rejected. The engine emits a `trade-skip`
 * log line so silent no-fires are auditable; backtest + replay treat this
 * as "no signal" (same as returning `null`).
 *
 * Use only when the bar was a real entry candidate (e.g. for ORB, the bar
 * closed past the buffered range edge). Don't emit for "outside session
 * window" / "no range built yet" — those return plain `null`. The volume
 * guard is on the strategy author.
 *
 * Strategies that don't opt in keep returning `EntrySignal | null`.
 */
export interface EntrySkip {
  /** One-line human-readable reason. Surfaces in the engine log message. */
  skip: string;
  /** Stable gate identifier for filtering / categorization (e.g. `"cap"`,
   *  `"bodyClose"`, `"momentum"`, `"filter:adx"`). */
  gate: string;
  /** Optional structured payload appended to the log line in `k=v` form so
   *  the /logs search box can find it. Keep keys terse. */
  detail?: Record<string, string | number | boolean>;
}

/** `StrategyModule.setupStatus`'s answer: the setup is formed, and `note` says
 *  what it is waiting on, in one sentence a trader reads on hover. */
export interface SetupReading {
  note: string;
}

// ── Strategy module ─────────────────────────────────────────────────

/**
 * The two admission shelves `config.intent` may name. `growth` is `trader`'s
 * shelf — durable-bar playbooks admitted for cash accounts that compound;
 * `speed` is `prop-trader`'s — combine and funded-account playbooks admitted
 * on the speed bar. See {@link StrategyConfig.intent}.
 */
export type StrategyIntent = "growth" | "speed";

/**
 * The one wording for an `intent` badge. **Every surface renders from this
 * map rather than writing its own string** — the "a vocabulary has one
 * owner" rule in [ui/copy.md](../../../docs/modules/ui/copy.md), applied to
 * a label pair instead of a three-letter code.
 */
export const INTENT_LABELS: Record<StrategyIntent, string> = {
  growth: "Cash · growth",
  speed: "Combine · speed",
};

/**
 * A calibration constant's declared "allowed range", in a shape a check
 * against the landed value can read rather than parse out of prose.
 *
 * Lives here rather than beside one playbook's constants because the readers
 * are outside the module: the reviewer's range check, the param schema's
 * `min`/`max`, and the read-only playbook display that renders a range beside
 * its value.
 */
export type CalibrationRange =
  /** `null` is admissible as an option: it is how a constant whose off value is
   *  not a number — a clock time — declares that off is one of its two cells. */
  | { kind: "choice"; options: readonly (string | number | boolean | null)[] }
  | { kind: "range"; min: number; max: number }
  /** `null` is off; the bounds apply only when the constant is set. */
  | { kind: "rangeOrOff"; min: number; max: number }
  | { kind: "clockRange"; earliestEt: string; latestEt: string };

export interface CalibrationConstant<T> {
  value: T;
  range: CalibrationRange;
  rationale: string;
}

/** One bar the playbook was measured against, and what it measured. */
export interface AdmissionCriterion {
  name: string;
  /** The bar as it was written *before* the measurement ran. */
  bar: string;
  measured: string;
  verdict: "pass" | "fail" | "open";
}

/** One held-out fold, on the same set {@link PlaybookAdmission.basis} names. */
export interface AdmissionFold {
  label: string;
  n: number;
  expectancyR: number;
  t?: number;
}

/** One regime cell the playbook claims, and its held-out count. */
export interface AdmissionCell {
  cell: string;
  n: number;
}

/** One measurement run, including the ones that failed. */
export interface AdmissionRun {
  id: string;
  what: string;
  verdict: string;
}

/**
 * The bar a playbook had to clear before it was allowed on a shelf, and what
 * it measured against that bar. Numbers and one-sentence strings only,
 * hand-carried by the trader from the module README's *Admission gate*
 * section at the moment the entry is written.
 *
 * **Why a typed export and not the README:** filling a table by string-matching
 * a 1,700-line research document makes a reword a data migration, and the
 * README carries blockers, failure modes and open questions — research, not
 * cockpit. The README stays the authority these numbers cite, and a number
 * wanted here that it does not state is a change to that README first.
 *
 * **A bar that was missed is recorded as missed.** `orb` is admitted with its
 * drawdown criterion failed by 0.15% under the operator's 2026-09-07 ruling
 * that the $2,000 limit applies to the summed curve; hiding that, or refusing
 * the `admitted` status over it, would be the platform overruling a decision
 * the operator recorded.
 */
export interface PlaybookAdmission {
  status: "candidate" | "admitted" | "retired";
  /** ISO date the status was decided on — the fact a reading's age is checked
   *  against, and the only date on the page. */
  decidedOn: string;
  /** One sentence: the budget, the fees, and which trade set. */
  basis: string;
  /** The walk-forward span and the fold shape. */
  window: string;
  criteria: readonly AdmissionCriterion[];
  /**
   * Optional, and absent means *not published on this basis* rather than
   * zero folds: `orb`'s README states its fold count and its pooled numbers on
   * the sizer-taken set but publishes no per-fold table for it, and the
   * per-fold table it does publish is a different trade set. Two bases on one
   * screen with one `basis` sentence between them is the misreading this
   * omission avoids.
   */
  folds?: readonly AdmissionFold[];
  cells?: readonly AdmissionCell[];
  runs: readonly AdmissionRun[];
}

export interface StrategyConfig {
  /** Human-readable name shown in the UI */
  name: string;
  /** Short description of what the strategy does */
  description?: string;
  /** Default timeframe; can be overridden per deployment */
  timeframe: Timeframe;
  /**
   * The trading window this playbook owns: entries are blocked outside the
   * active interval (this window minus the deployment's pauses) and an open
   * position force-exits at the pause start or the window end via
   * `time_window_close`.
   *
   * **Required, and the only source.** It was a `CommonParams` key until the
   * regime-playbooks proposal's phase 1, which is why a gold playbook could
   * not express the 13:30 settlement and rode to a 15:55 flatten that means
   * nothing for that instrument, and why the backtest CLI could measure no
   * window outside 09:30–15:55 ET. A deployment carries no session; there is
   * nothing to override and nothing to disagree with.
   *
   * Distinct from `CONTRACT_SPECS[ticker].daySession`, which is the
   * instrument's cash session and the anchor for session VWAP and the
   * prior-session range. This is the window the *playbook* trades, which may
   * be a slice of that or may sit outside it entirely.
   */
  session: MainSession;
  /**
   * The instrument this playbook's numbers were measured on. Declaring it
   * refuses the module on every other instrument — at activation, at the
   * deploy surface and in the backtest CLI.
   *
   * **Optional, and a module that declares nothing is unrestricted**, exactly
   * as every module was before this field existed. The ten pre-playbook
   * modules are genuinely instrument-agnostic and stay that way; declaring one
   * on a module whose evidence does not name an instrument would be inventing
   * a claim the calibration cannot back.
   *
   * **Singular.** Wave 1 of the playbooks proposal gives MES and MGC their own
   * READMEs rather than ports of the MNQ shelf, so a playbook is calibrated for
   * one instrument by design. A second instrument is a second playbook with its
   * own research, not a second entry here.
   *
   * Same class of fact as {@link session}: the frame a measurement was taken
   * in. `orb` was deployed on `/NQ` on 2026-09-08 and was refused only
   * incidentally — `/NQ` has no `CONTRACT_SPECS` row and `orb` needs a day
   * session. `/MES` has a row, so the same mistake there would have started
   * cleanly and traded an MNQ calibration on a different instrument.
   */
  calibratedFor?: SpecTicker;
  /** Default entry order type (1=Limit, 2=Market, 4=Stop, 5=TrailingStop) */
  entryType: OrderType;
  /** Indicators this strategy needs calculated before each evaluation */
  indicators: IndicatorConfig[];
  /**
   * CommonParams keys that this strategy doesn't honor and should not render
   * in the UI. Used for strategies whose exit semantics make a common control
   * meaningless (e.g. ORB hides `breakEvenAtPct` because range-relative
   * exits manage themselves). Listing here keeps the form free of trust-bug
   * knobs while leaving the underlying field intact for strategies that
   * consume it.
   */
  hiddenCommonParams?: (keyof CommonParams)[];
  /**
   * The strategy's own hooks call `requireDaySession`, so it cannot evaluate
   * on a ticker `CONTRACT_SPECS` has no row for.
   *
   * A `SESSION_VWAP` or `SESSION_VWAP_BANDS` in `indicators` / `buildIndicators` says the same thing
   * and the platform can see it; a `requireDaySession` inside `shouldEnter`
   * is invisible to any scan, which is why it is declared. The engine reads
   * both at activation and refuses the deployment rather than discovering it
   * as a throw on every tick.
   */
  requiresDaySession?: boolean;
  /**
   * Keep this module out of `listStrategies()` — the operator's picker — in
   * every environment. It is a UI flag and nothing else: `getStrategy(key)`
   * and the CLI's `load-node.ts` both ignore it, so a hidden module still
   * deploys, backtests, replays and runs from `--playbook`.
   *
   * Every module except `orb` and `ema-bounce`, plus the three unhidden ones
   * under `test/`, carries it while the platform migrates to playbooks.
   * `opening-range-breakout-v2` is `orb`'s comparison baseline and the `test/`
   * fixtures are dev tools; both must stay runnable. A few modules are
   * unhidden but under `test/`, so only staging's picker lists them — each
   * has a measurement that needs a deployment. The strategies catalog lists
   * the unhidden modules outside `test/`.
   */
  hidden?: boolean;
  /**
   * Which admission shelf this playbook has cleared — operator guidance for
   * the picker, rendered as a badge. **Never read by any gate, filter,
   * deploy check or account-type comparison.** The account-class rule that
   * actually decides where a deployment may trade live is
   * `autoTradeVerdict` in `broker-access/account-trading-policy.ts`
   * ([brokers/README](../../../docs/modules/brokers/README.md)); this field
   * sits nowhere near it and nothing may branch on it — see
   * `strategy-types.test.ts`, which pins that no module outside
   * `INTENT_LABELS` and the display surfaces reads `config.intent`.
   *
   * `growth` — admitted by `trader` on the durable bar, for cash accounts
   * that compound. `speed` — admitted by `prop-trader` on the speed bar,
   * for combines and funded accounts. A playbook may carry both. Absent
   * means not admitted on either shelf.
   */
  intent?: ReadonlyArray<StrategyIntent>;
  /**
   * This playbook's calibration constants — the same `calibration.ts` object
   * its hooks take their param defaults from, declared here so a display
   * surface can reach it. Nothing else changes: the constants are still read
   * through the module's own params.
   *
   * **Same footing as {@link hidden} and {@link intent}: display only.** No
   * gate, filter, sizer or deploy check reads `config.calibration`, so adding
   * or removing it is not a behaviour change and takes **no version bump and
   * no CHANGELOG entry**. `strategy-types.test.ts` pins the reader set.
   */
  calibration?: Record<string, CalibrationConstant<unknown>>;
  /**
   * What this playbook had to clear to reach a shelf, and what it measured —
   * see {@link PlaybookAdmission}. Declaring nothing means no admission has
   * been written, which is the honest state of a probe and of every module
   * that has measured nothing.
   *
   * Display only, on the same footing as {@link calibration} above: no gate
   * reads `config.admission`, and `status: "retired"` refuses nothing — a
   * retired playbook still runs where it is armed.
   */
  admission?: PlaybookAdmission;
  /**
   * The stop, in ticks, that every entry places at this playbook's defaults —
   * declared by a playbook whose stop is wide enough that a small risk budget
   * buys no contract at all, so the Playbooks page and the book grid can say
   * the smallest risk per trade that takes one (`playbook-minimum-risk.ts`
   * prices it on `calibratedFor` through the sizer's own denominator).
   *
   * Display only, on the same footing as {@link calibration}: the hook's
   * `slTicks` is what the sizer reads, and no gate, filter, sizer or deploy
   * check reads `config.fixedStopTicks`. Take it from the same calibration
   * constant the stop param defaults from, so the two cannot drift.
   */
  fixedStopTicks?: number;
}

/**
 * The instrument `config.calibratedFor` names, when `ticker` is not it.
 *
 * `null` is "run it" and covers both admissible cases: the module declares no
 * instrument, or the ticker resolves to the one it declares. A ticker with no
 * `CONTRACT_SPECS` row resolves to nothing and so mismatches every declaration
 * — which is the `/NQ` case, and the right answer for it.
 *
 * The comparison goes through `contractSpecForTicker` rather than a string
 * equality, because the engine spells an instrument `/MNQ` and the CLI spells
 * it `MNQ`, and a second normalisation would be a second source of truth about
 * what "the same instrument" means.
 *
 * Module-private: `instrumentRefusalFor` is the only door onto it, so no
 * surface can take the bare verdict and write its own wording for it.
 */
function instrumentMismatch(config: StrategyConfig, ticker: string): SpecTicker | null {
  const declared = config.calibratedFor;
  if (declared == null) return null;
  return contractSpecForTicker(ticker)?.ticker === declared ? null : declared;
}

/**
 * `spec` spelled to match `ticker`'s own convention — `/MNQ` beside a `/NQ`
 * the deploy routes and the deploy page always pass, bare `MNQ` beside the
 * bare `MNQ` the CLI's `--ticker` always is. `contractSpecForTicker` accepts
 * both, so the mismatch check does not care; the sentence does, because a
 * declared instrument and the offending ticker read as two different things
 * side by side when only one of them carries the slash the ticker select
 * shows on every option.
 */
function displayTicker(ticker: string, spec: SpecTicker): string {
  return ticker.startsWith("/") ? `/${spec}` : spec;
}

/**
 * The one sentence every surface says about a cross-instrument refusal —
 * the engine's activation line, the deploy routes' 400, the deploy modal and
 * the backtest CLI — passed through verbatim rather than re-worded per
 * surface (ui/copy.md, *A refusal the operator cannot retry*). Each surface
 * appends its own consequence and nothing else.
 *
 * Subject-neutral on purpose: a deployment and a backtest run are refused for
 * the same reason, and a sentence naming one of them cannot be reused by the
 * other without being rewritten. It is a permanent refusal in the deploy
 * flow's sense — the instrument is pinned at creation, so there is nothing to
 * wait for — which is why it names what was measured and the operator's two
 * moves rather than reading as an error.
 */
export function instrumentRefusalFor(config: StrategyConfig, ticker: string): string | null {
  const declared = instrumentMismatch(config, ticker);
  if (declared == null) return null;
  const declaredDisplay = displayTicker(ticker, declared);
  return (
    `${config.name} is calibrated for ${declaredDisplay}, not ${ticker}. ` +
    `Its numbers were measured on ${declaredDisplay} alone, so they say nothing about ${ticker} — ` +
    `run it on ${declaredDisplay}, or use a playbook calibrated for ${ticker}.`
  );
}

/**
 * The one sentence every surface says about an instrument that is on file for
 * research only — a `CONTRACT_SPECS` row outside `DEPLOYABLE_SPEC_TICKERS` —
 * or `null` when `ticker` may be deployed on. The Playbook page's Deploy, both
 * create routes' 400 and the engine's activation line all pass it through
 * verbatim.
 *
 * Needs no module: whether the live path has been checked for an instrument
 * is the platform's fact, not a playbook's. A ticker with no spec row answers
 * `null` — it is not a research row, and the instrument and day-session
 * refusals already answer for it where it matters.
 */
export function undeployableInstrumentRefusal(ticker: string): string | null {
  const spec = contractSpecForTicker(ticker);
  if (spec == null || DEPLOYABLE_SPEC_TICKERS.includes(spec.ticker)) return null;
  const options = DEPLOYABLE_SPEC_TICKERS.map((t) => displayTicker(ticker, t)).join(", ");
  return (
    `${ticker} is on file for research only: the platform has not checked live trading on it, ` +
    `so nothing is deployed there. Deploy on an instrument that is open for live trading — ${options}.`
  );
}

/**
 * Whether `config`'s hooks need the instrument's day-session window and
 * `ticker` has none on file.
 *
 * Reads `config.requiresDaySession` alone — the declared half of
 * `strategyNeedsDaySession` ([session-utils.ts](./session/session-utils.ts)),
 * which also scans `buildIndicators(params)` for a session-VWAP indicator and is what
 * the engine's activation refusal actually asks. This half needs no params
 * and is true or false the moment the module registers, which is what lets a
 * create route — which has no running deployment to merge params for — ask
 * it before one exists.
 *
 * Module-private for the same reason `instrumentMismatch` is: one door onto
 * the verdict, so no surface can take the bare boolean and word the refusal
 * itself.
 */
function daySessionMismatch(config: StrategyConfig, ticker: string): boolean {
  return Boolean(config.requiresDaySession) && daySessionForTicker(ticker) == null;
}

/**
 * The one sentence every surface says about a day-session refusal — same
 * shape as `instrumentRefusalFor` above, and the reason this one exists at
 * all: `config.requiresDaySession` used to be read only inside
 * `strategyNeedsDaySession`, so a deployment on a ticker with no cash
 * session — `opening-range-breakout-v2` on `/NQ` — created cleanly and died
 * at activation instead of being refused where it was entered.
 *
 * Subject-neutral for the same reason `instrumentRefusalFor` is: a create
 * route and the deploy page refuse the same `(strategy, ticker)` pair. It is
 * a permanent refusal in the deploy flow's sense — the ticker is pinned at
 * creation — so it names the rule and the operator's two remedies rather
 * than reading as an error.
 */
export function daySessionRefusalFor(config: StrategyConfig, ticker: string): string | null {
  if (!daySessionMismatch(config, ticker)) return null;
  const options = DEPLOYABLE_SPEC_TICKERS.map((t) => displayTicker(ticker, t)).join(", ");
  return (
    `${config.name} measures its signals against ${ticker}'s cash session, and ${ticker} has none on file. ` +
    `Deploy it on an instrument with one — ${options} — or use a playbook that does not need the day session.`
  );
}

export interface StrategyModule<P extends CommonParams = CommonParams> {
  /** Stable identifier used in deployments. Derived from filename by default. */
  key?: string;
  /**
   * Loaded from `strategies/test/`, which only the staging-gated context
   * pulls in.
   *
   * **Stamped by the loader, never inferred from the key.** The keys happen
   * to end in `.test` because they come from `*.test.strategy.ts`, and a
   * surface that pattern-matched the name would keep working right up until
   * someone named a real strategy badly. The loader is the one place that
   * knows which context a module came from, so it is the one place that
   * says so.
   *
   * Absent on every production strategy. It is not `config.hidden`: that
   * flag hides a module from `listStrategies()` in prod, while this records
   * where it came from — the two happen to overlap today and answer
   * different questions.
   */
  isTest?: boolean;
  /**
   * Strategy version. Bumped by hand alongside the colocated `CHANGELOG.md`
   * any time entry/exit/indicator logic, the param schema, or default values
   * change. Used by the strategy config export/import feature to enforce a
   * deterministic round-trip between environments — an imported file's
   * `strategy.version` must exact-match the env's value or the import is
   * rejected. Format is semver-like (`MAJOR.MINOR.PATCH`); the comparison
   * is string-equality, not range-based.
   */
  version: string;
  config: StrategyConfig;
  /**
   * Tunable parameters exposed to the UI and passed into hooks.
   * Every key here must be consumed by `shouldEnter`, `shouldExit`, or
   * `buildIndicators` — otherwise the UI shows a control that does nothing.
   */
  params: Record<string, ParamSchema>;
  /**
   * Optional: rebuild the indicator list from current params so period/length
   * overrides actually affect the indicator calculation. If omitted,
   * `config.indicators` is used verbatim (appropriate for strategies whose
   * indicators are not parameterized, e.g. VWAP-only).
   */
  buildIndicators?(params: P): import("@/lib/trading/domain").IndicatorConfig[];
  /**
   * Optional: how many **completed day sessions** of history the hooks need
   * before their first evaluation can answer, at these params.
   *
   * `buildIndicators` declares the same thing in bars, and the engine's warmup
   * fetch takes the greater of the two. A session-scoped quantity — a prior-
   * session range, a multi-session average — cannot be expressed as a bar count
   * without knowing the timeframe and the instrument's calendar, and nothing in
   * the indicator list can see it, so a hook that walks back over prior sessions
   * declares it here. Count the current, incomplete session in the number: the
   * walk-back starts inside it.
   *
   * Undeclared means none, which is right for every module whose hooks read only
   * the current session. The engine converts the count to a bar depth on the
   * deployment's timeframe; the backtest CLI refuses a `--warmup-days` below it.
   */
  warmupDaySessions?(params: P): number;
  /**
   * Optional: why these settings leave the hooks no entry to take — one
   * sentence naming the settings and the move — or null. A setting like that
   * fails closed to no entry rather than throwing, so a run on it reads as a
   * playbook that found no signals; each refusal is a rule the module's README
   * states first. It also refuses settings whose entries the live engine could
   * not place (a trigger past what its 1m window can see), so a backtest never
   * takes a trade the engine would miss.
   *
   * **Read by the research surfaces and the deployment write routes, never
   * the engine**: *Try settings* disables Run with the sentence, the backtest
   * CLI throws it at every param set it would execute, and the create and
   * group-edit routes answer it as a 400 (`checkDeploymentSettings`), so a
   * hand-made row cannot store what a run would refuse. A deployment from the
   * app holds only calibrated values, which a module declaring this must pass
   * at every combination — its test pins that.
   */
  settingsRefusal?(params: P, daySession: DaySessionWindow | null): string | null;
  /**
   * Called each time a new bar closes. Returns:
   * - `EntrySignal` to enter
   * - `null` for "no decision, nothing to log" (outside session, no setup yet)
   * - `EntrySkip` for "I considered entering and a gate rejected" — the
   *   engine emits a `trade-skip` log line; backtest + replay treat it as
   *   `null`. Strategies opt in by returning the structured shape only at
   *   meaningful candidate-bar gate failures (volume guard is on the author).
   *
   * Strategies that don't opt in keep returning `EntrySignal | null`; the
   * union accepts that without changes at the call site.
   */
  shouldEnter(ctx: StrategyContext<P>): EntrySignal | EntrySkip | null;
  /**
   * Optional, display only: whether this playbook's setup has formed and is
   * waiting on its final trigger, as of the bar `ctx` is at. The dashboard
   * reads a non-null answer as the `ARMED` chip and `note` as its tooltip — one
   * plain sentence.
   *
   * The live engine calls it on a flat leg after `shouldEnter` returned no
   * signal, and on no other path; the backtest never calls it. **Pure, and
   * built from the module's own entry helpers** — a second copy of the entry
   * logic here is a second answer to "would this enter", and the two drift.
   * Nothing reads the answer but the chip, so it can never move a trade.
   */
  setupStatus?(ctx: StrategyContext<P>): SetupReading | null;
  /**
   * Called each new bar while a position is open. Return `true` to exit with
   * a generic "Strategy Exit" label, or `{ exit: true, reason }` to surface
   * a strategy-specific reason on the trade row + Discord embed (e.g.
   * "EMA close-through"). `false` (or `{ exit: false }`-equivalent) keeps the
   * position open. The boolean form is preserved for back-compat — existing
   * strategies returning a plain bool keep working.
   *
   * A non-empty `string` is also accepted: it's the exit-filter registry key
   * propagated when a strategy returns `anyExitFilterTriggered(ctx)` directly
   * (the helper now returns `string | false` to attribute the firing filter).
   * Engine + backtest treat the string as the exit reason; empty string is
   * treated as "no exit".
   */
  shouldExit(ctx: StrategyContext<P>): boolean | string | StrategyExitDecision;
  /**
   * Optional tick-evaluated exit. Receives only the current tick price + the
   * open position + params — NOT indicators or in-progress bar OHLC. Use for
   * price-level exits (trails, structure breaks) where backtest evaluates
   * `bar.high`/`bar.low` against the same level. Strategies whose exits
   * require closed-bar conditions (EMA close-through, RSI, etc.) should leave
   * this undefined and rely on `shouldExit`.
   */
  shouldExitRealtime?(args: {
    position: OpenPosition;
    price: number;
    params: P;
    tickSize: number;
  }): boolean;
  /**
   * Default bar window around each loser when exporting losing trades for
   * review. Falls back to `{ preBars: 30, postBars: 15 }` if not declared.
   * Metadata only — does not affect entry/exit/bracket logic.
   */
  exportWindow?: { preBars: number; postBars: number };
}

// ── Helpers ─────────────────────────────────────────────────────────

export function defaultParamValues(schema: Record<string, ParamSchema>): ParamValues {
  const out: ParamValues = {};
  for (const [k, p] of Object.entries(schema)) out[k] = p.default;
  return out;
}

/**
 * `CommonParams` keys phase 1 of the regime-playbooks proposal retired, each
 * with **no current equivalent to translate into**: the bracket and its reward
 * multiple are the strategy's, the contract count is the account's risk
 * posture, the daily P&L gate is the account's three columns on
 * `account_brokers`, and the trading window is the playbook's
 * `config.session`.
 *
 * `mainSession` is the one whose saved value could still be *read* as an
 * instruction, which is why it is dropped here rather than left inert: a blob
 * carrying `09:30–16:00` beside a playbook declaring `08:20–13:30` is two
 * answers to one question, and the stale one is the plausible-looking one.
 *
 * They are dropped from a saved blob rather than converted, and the drop is
 * announced — the rule in [filters.md](../../../docs/modules/trading/filters.md).
 * Left in place they would survive every param-load site, render on the
 * deployment editor as live controls and export into a config file that a
 * future import would accept.
 */
const RETIRED_PARAM_KEYS = [
  "mainSession",
  "size",
  "riskRewardRatio",
  "stopLossOverrideTicks",
  "minStopLossTicks",
  "maxStopLossTicks",
  "dailyMaxLossUsd",
  "dailyMaxProfitUsd",
  "dailyPnlIncludeUnrealized",
] as const;

/**
 * One-shot translation of legacy `paramOverrides` keys into their current
 * equivalents on load, and the drop of the ones that have no current
 * equivalent. Mutates a copy and returns it; logs once per call when a
 * migration or a drop fires so the legacy values are visible in dev/staging.
 *
 * Strategy-specific. Dispatches on `strategyKey` so future renames can
 * stack under the same helper without bloating the call sites.
 *
 * Cleanup target: drop the maxRangePoints / stopRangePercent shims a few
 * releases after the 2026-04-30 ORB tune-up has been deployed everywhere.
 */
export function migrateLegacyParamOverrides(
  strategyKey: string,
  overrides: ParamValues | undefined,
  context?: { deploymentId?: string },
): ParamValues {
  if (!overrides) return {};
  // Shallow clone — caller's object is not mutated.
  const next: ParamValues = { ...overrides };
  const tag = context?.deploymentId ?? strategyKey;

  if (strategyKey === "opening-range-breakout") {
    // maxRangePoints (legacy) → maxRangeTicks (current). The * tickSize math
    // at the consumption site already treated the old value as ticks despite
    // the misleading name, so the numeric value is preserved as-is. Renamed
    // to match the codebase's tick-everywhere convention (commit 2026-04-30).
    if ("maxRangePoints" in next) {
      if (!("maxRangeTicks" in next)) {
        next.maxRangeTicks = next.maxRangePoints;
      }
      delete next.maxRangePoints;
      console.warn(
        `[migrateLegacyParamOverrides] Migrated maxRangePoints → maxRangeTicks for ${tag}; ` +
          `old key removed. This migration shim should be cleaned up in a future release.`,
      );
    }

    // stopRangePercent < 25 → 25 (foot-gun guard added 2026-04-30; HTML min:
    // only validates new typed input, this enforces it on already-stored
    // overrides too).
    if ("stopRangePercent" in next) {
      const v = Number(next.stopRangePercent);
      if (Number.isFinite(v) && v < 25) {
        console.warn(
          `[migrateLegacyParamOverrides] stopRangePercent ${v} is below the new min 25 ` +
            `(daily-loss-limit foot-gun guard, commit 2026-04-30). Clamped to 25 for ${tag}.`,
        );
        next.stopRangePercent = 25;
      }
    }
  }

  // Step 4 of the exit-filter registry refactor: legacy CommonParam BE/trail
  // keys removed. Translate any saved deployment that still has them into the
  // new registry-filter equivalents so behavior carries over without the
  // user re-touching the form.
  //
  // Translation faithfulness: the legacy %-of-TP arm point is **no longer
  // representable and is dropped**, not approximated. It mapped onto the BE
  // filter's `pct` mode, whose arm distance was `slTicks × riskRewardRatio`;
  // that param is deleted and the target is a number the strategy emits, so
  // the mode went with it. A migrated deployment keeps its BE *enable* and its
  // offset and arms at the `r`-mode default instead, which is a different arm
  // point — the warning below says so. Converting `pct` to an equivalent `r`
  // would need the ratio the row no longer carries, and inventing one is
  // exactly the guess this shim exists to avoid.
  //
  // Trail's `trailUseSlDistance` has no equivalent in the new bracket-modify
  // trail filter (which is ATR/ticks-only) and is dropped silently — saved
  // deployments using it lose the SL-mirroring behavior. Documented in the
  // strategy CHANGELOGs for v2.0.3 / equivalents.
  //
  // Trail's `trailArmAtPct` is the *same* case as BE's `%-of-TP` and is dropped
  // with it: the legacy arm point was a percentage of the TP distance, TP
  // distance in R-space was the deployment's `riskRewardRatio`, and that param
  // is deleted. It used to substitute 2 for a missing ratio, which is the
  // approximation this shim exists to avoid — one policy, both keys.
  let migratedBE = false;
  let migratedTrail = false;
  if ("breakEvenEnabled" in next) {
    const enabled = Boolean(next.breakEvenEnabled);
    if (enabled) {
      if (!("breakEvenFilterEnabled" in next)) next.breakEvenFilterEnabled = true;
      if ("breakEvenOffsetTicks" in next && !("breakEvenFilterOffsetTicks" in next)) {
        const v = Number(next.breakEvenOffsetTicks);
        if (Number.isFinite(v)) next.breakEvenFilterOffsetTicks = v;
      }
      migratedBE = true;
    }
    delete next.breakEvenEnabled;
    delete next.breakEvenAtPct;
    delete next.breakEvenOffsetTicks;
  } else if ("breakEvenAtPct" in next || "breakEvenOffsetTicks" in next) {
    // Disabled BE — strip the residual keys so they don't leak through as
    // dead form state on subsequent edits.
    delete next.breakEvenAtPct;
    delete next.breakEvenOffsetTicks;
  }

  if ("trailEnabled" in next) {
    const enabled = Boolean(next.trailEnabled);
    if (enabled) {
      if (!("trailFilterEnabled" in next)) next.trailFilterEnabled = true;
      if (!("trailFilterMode" in next)) next.trailFilterMode = "ticks";
      if (!("trailFilterDistanceTicks" in next) && "trailDistanceTicks" in next) {
        const v = Number(next.trailDistanceTicks);
        if (Number.isFinite(v) && v > 0) next.trailFilterDistanceTicks = v;
      }
      migratedTrail = true;
    }
    delete next.trailEnabled;
    delete next.trailArmAtPct;
    delete next.trailDistanceTicks;
    delete next.trailUseSlDistance;
  } else if (
    "trailArmAtPct" in next ||
    "trailDistanceTicks" in next ||
    "trailUseSlDistance" in next
  ) {
    delete next.trailArmAtPct;
    delete next.trailDistanceTicks;
    delete next.trailUseSlDistance;
  }

  if (migratedBE || migratedTrail) {
    const parts: string[] = [];
    if (migratedBE) {
      parts.push(
        "legacy BE → breakEvenFilter (enable + offset only; the %-of-TP arm point " +
          "is not representable since riskRewardRatio was deleted, so BE now arms at " +
          "breakEvenFilterAtR's default)",
      );
    }
    if (migratedTrail) {
      parts.push(
        "legacy trail → trailFilter (enable + distance only, ticks mode; the %-of-TP arm " +
          "point is not representable since riskRewardRatio was deleted, so the trail now " +
          "arms at trailFilterArmAtR's default)",
      );
    }
    console.warn(
      `[migrateLegacyParamOverrides] ${tag}: ${parts.join(", ")}. ` +
        `Step 4 of the exit-filter registry refactor retired the legacy CommonParam BE/trail; ` +
        `saved values translated to the new registry-filter keys.`,
    );
  }

  const dropped = RETIRED_PARAM_KEYS.filter((k) => k in next);
  for (const k of dropped) delete next[k];
  if (dropped.length > 0) {
    console.warn(
      `[migrateLegacyParamOverrides] ${tag}: dropped ${dropped.join(", ")}. ` +
        `Phase 1 of the regime-playbooks proposal moved the bracket and the reward multiple ` +
        `onto the strategy, the contract count onto the account's risk posture, the daily ` +
        `P&L gate onto the account and the trading window onto the playbook's ` +
        `config.session, so none of these keys has a target to translate into. ` +
        `The saved values are dropped, not approximated.`,
    );
  }

  return next;
}

/**
 * Resolve a deployment's params for evaluation: schema defaults overlaid
 * with the deployment's saved overrides (after legacy-key migration).
 * Single source of truth for the merge — engine, backtest, and read-only
 * API routes all consume this so a future schema default flip can't make
 * one site disagree with another. Cast is safe because every strategy's
 * schema is built via `withCommonParams()` (validateStrategy enforces it
 * at registration), so `defaultParamValues` produces every CommonParams
 * key.
 */
export function resolveDeploymentParams(
  strategy: Pick<StrategyModule, "params">,
  paramValues: ParamValues | undefined,
  context: { strategyKey: string; deploymentId?: string },
): CommonParams {
  return {
    ...defaultParamValues(strategy.params),
    ...migrateLegacyParamOverrides(context.strategyKey, paramValues, {
      deploymentId: context.deploymentId,
    }),
  } as CommonParams;
}
