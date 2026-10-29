/**
 * The exit-reason table — one owner for every way a live trade can end.
 *
 * The label strings used to be produced in `engine-notify.ts`, matched as
 * bare literals by a chip `switch` in the trades table, and matched as raw
 * SQL string literals by the relabel sweep, with nothing linking the three
 * at compile time. The sharp end was the SQL: `exit_reason = 'Bracket/Manual'`
 * read a value that came out of a `default:` arm, so a rename on either side
 * silently stopped the sweep finding rows.
 *
 * The code is now the owner. It is what the engine submits, what
 * `strategy_trades.exit_reason_code` stores, and what SQL matches; the label
 * and the Activity phrasing are *renderings* of it, produced here and nowhere
 * else.
 *
 * Lives beside the log vocabulary because that is where the Activity lane's
 * `{reason}` comes from, and it keeps this module a leaf: it imports nothing.
 *
 * Owned by docs/modules/logging/README.md.
 */

/**
 * Every reason a trade row can carry. Two families:
 *
 *  - **Bracket-derived** — decided at reconcile time from which bracket leg
 *    filled plus the row's BE/trail flags. Never submitted.
 *  - **Submitted** — the actor that placed the exit names one *before* the
 *    order goes on the wire, which is what makes the label truthful rather
 *    than inferred after the fact.
 *
 * Adding a member is a deliberate act: `EXIT_REASONS` below, the colour and
 * emoji maps in `engine-notify.ts`, and the chip map in
 * `deployment-trade-table.tsx` are all `Record<ExitReasonCode, …>`, so a new
 * code fails to compile until every surface has decided what to do with it.
 */
export type ExitReasonCode =
  // Bracket-derived
  | "take_profit"
  | "stop_loss"
  | "breakeven_stop"
  | "trail_stop"
  // Strategy-decided
  | "strategy_signal"
  | "realtime_exit"
  | "time_stop"
  | "ema_exit"
  // Clock, lifecycle and safety actors
  | "time_window_close"
  | "deployment_close"
  | "bracket_failure_force_close"
  | "engine_downtime"
  | "manual_position_close"
  | "flatten_all"
  | "flatten_deployment"
  | "manual"
  // The residual
  | "bracket_manual";

export interface ExitReasonSpec {
  /**
   * The chip and embed label. Trader-facing prose — most of these are the
   * exact strings rows have carried since before the codes existed, which
   * is what the migration's frozen label→code backfill matches on. Not all:
   * `Hand Position Close` arrived with its code and no row predates it. A
   * label added here is new prose, not a historical value, and the frozen
   * list in `db/trades.ts` is where that distinction is recorded.
   */
  label: string;
  /**
   * The Activity-lane `{reason}` fragment, written to slot into
   * *"Closed {ticker} {pnl} — {reason}"* and to survive the phone test:
   * read aloud by someone who does not understand it, it still tells the
   * operator what ended the trade.
   */
  activity: string;
}

/**
 * The residual arm. A reason string that parses to nothing lands here, and
 * it is the value the relabel sweep queries for — exported as a constant so
 * the SQL binds it rather than repeating the literal.
 */
export const EXIT_REASON_BRACKET_MANUAL = "bracket_manual" satisfies ExitReasonCode;

/**
 * The two codes that carry strategy-supplied prose after a colon
 * (`strategy_signal:EMA close-through`). Everything else is a bare code.
 */
const DETAIL_BEARING_CODES: ReadonlySet<string> = new Set(["strategy_signal", "realtime_exit"]);

export const EXIT_REASONS: Readonly<Record<ExitReasonCode, ExitReasonSpec>> = {
  take_profit: {
    label: "Take Profit",
    activity: "it hit the profit target",
  },
  stop_loss: {
    label: "Stop Loss",
    activity: "it hit the stop",
  },
  breakeven_stop: {
    label: "Breakeven Stop",
    activity: "it hit the stop, which had already been moved to breakeven",
  },
  trail_stop: {
    label: "Trail Stop",
    activity: "it hit the trailing stop",
  },
  strategy_signal: {
    label: "Strategy Exit",
    activity: "the strategy called the exit",
  },
  realtime_exit: {
    label: "Strategy Exit",
    activity: "the strategy called the exit on a live price tick",
  },
  time_stop: {
    label: "Strategy Exit · Time Stop",
    activity: "the trade ran out of time",
  },
  ema_exit: {
    label: "Strategy Exit · EMA Close-Through",
    activity: "price closed back through the moving average",
  },
  time_window_close: {
    label: "Time Window Close",
    activity: "the trading window closed",
  },
  deployment_close: {
    label: "Deployment Close",
    activity: "the deployment was stopped",
  },
  bracket_failure_force_close: {
    label: "Force Close (bracket failure)",
    activity: "the protective stop could not be placed, so the position was closed",
  },
  engine_downtime: {
    label: "Engine Downtime",
    activity: "the engine was offline past the safety limit, so the next start closed it",
  },
  manual_position_close: {
    label: "Hand Position Close",
    activity: "the engine closed a position it did not open",
  },
  flatten_all: {
    label: "Flatten All",
    activity: "Flatten All was used to close everything",
  },
  /**
   * Its own code rather than a reuse of `flatten_all`. The two are different
   * operator actions with different blast radii — one deployment against
   * every account — and a row that cannot tell them apart cannot answer
   * "what did I close and how much of it".
   */
  flatten_deployment: {
    label: "Flatten Deployment",
    activity: "the operator flattened this deployment",
  },
  manual: {
    label: "Manual",
    activity: "it was closed by hand",
  },
  bracket_manual: {
    label: "Bracket/Manual",
    activity: "it was closed outside the engine — a bracket fill, or a close placed at the broker",
  },
};

const ALL_CODES = Object.keys(EXIT_REASONS) as ExitReasonCode[];

export function isExitReasonCode(value: string): value is ExitReasonCode {
  return Object.prototype.hasOwnProperty.call(EXIT_REASONS, value);
}

/** A reason code plus whatever the actor rendered from it. */
export interface ResolvedExitReason {
  code: ExitReasonCode;
  /** Strategy-supplied prose from a `code:detail` reason, else null. */
  detail: string | null;
  /** `EXIT_REASONS[code].label`, with the detail appended when there is one. */
  label: string;
}

/**
 * Render a code + detail as the persisted label.
 *
 * The detail suffix only ever hangs off a strategy exit, which is why the
 * separator lives here rather than at the two call sites that used to build
 * `Strategy Exit · …` by hand.
 */
export function exitReasonLabel(code: ExitReasonCode, detail: string | null = null): string {
  const base = EXIT_REASONS[code].label;
  return detail != null && detail.length > 0 ? `${base} · ${detail}` : base;
}

/** The Activity-lane fragment. The detail rides along for the same reason. */
export function exitReasonActivity(code: ExitReasonCode, detail: string | null = null): string {
  const base = EXIT_REASONS[code].activity;
  return detail != null && detail.length > 0 ? `${base} (${detail})` : base;
}

/**
 * Read a stored or submitted reason. Accepts the bare code and the
 * `code:detail` form; anything else — including a value from before the
 * column existed — resolves to the residual arm, which is what the sweep
 * then retries.
 */
export function resolveExitReason(raw: string | null | undefined): ResolvedExitReason {
  if (raw != null) {
    const sep = raw.indexOf(":");
    if (sep > 0) {
      const head = raw.slice(0, sep);
      if (DETAIL_BEARING_CODES.has(head) && isExitReasonCode(head)) {
        const detail = raw.slice(sep + 1);
        return { code: head, detail: detail.length > 0 ? detail : null, label: exitReasonLabel(head, detail) };
      }
    } else if (isExitReasonCode(raw)) {
      return { code: raw, detail: null, label: exitReasonLabel(raw) };
    }
  }
  return {
    code: EXIT_REASON_BRACKET_MANUAL,
    detail: null,
    label: exitReasonLabel(EXIT_REASON_BRACKET_MANUAL),
  };
}

/**
 * The code half of a stored reason, or null when the value is not one.
 *
 * `resolveExitReason` answers the residual arm for an unrecognised value
 * because a *trade* always ended somehow; a surface that needs to tell "this
 * is the residual reason" apart from "this row has no reason" wants the null.
 */
export function exitReasonCodeOf(raw: string | null | undefined): ExitReasonCode | null {
  if (raw == null) return null;
  const sep = raw.indexOf(":");
  const head = sep > 0 ? raw.slice(0, sep) : raw;
  if (sep > 0 && !DETAIL_BEARING_CODES.has(head)) return null;
  return isExitReasonCode(head) ? head : null;
}

/** Bracket-derived resolutions never carry a detail. */
export function bracketExitReason(code: ExitReasonCode): ResolvedExitReason {
  return { code, detail: null, label: exitReasonLabel(code) };
}

/**
 * Label → code, for rows written before `exit_reason_code` existed.
 *
 * Two labels map from more than one code (`Strategy Exit` is both
 * `strategy_signal` and `realtime_exit`), so this answers the code the
 * migration backfills — the *rendering* is identical either way, and no
 * surface distinguishes them. Detail suffixes (`Strategy Exit · …`) resolve
 * to the base code by prefix.
 */
export function exitReasonCodeForLabel(label: string | null | undefined): ExitReasonCode | null {
  if (label == null || label.length === 0) return null;
  for (const code of ALL_CODES) {
    if (EXIT_REASONS[code].label === label) return code;
  }
  const strategyPrefix = `${EXIT_REASONS.strategy_signal.label} · `;
  if (label.startsWith(strategyPrefix)) return "strategy_signal";
  return null;
}
