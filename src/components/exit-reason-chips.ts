/**
 * The exit-reason short-code vocabulary, in one place.
 *
 * The three-letter codes started in `deployment-trade-table.tsx` as that
 * table's private chip map. They stopped being private when the chart's
 * exit label needed the same words: `exitLabel` in `trade-markers.ts`
 * rendered `TP` / `SL` / `EXIT`, so a session-close flatten, a strategy
 * signal exit and a time stop were one indistinguishable `EXIT` — which is
 * the discrimination a trader reading a chart most needs. Copying the codes
 * into the chart would have been a second table free to drift from this one,
 * which is the failure `EXIT_REASONS` itself exists to prevent one layer
 * down.
 *
 * **Two maps, one vocabulary of codes.** The live union
 * (`ExitReasonCode`, from the logging leaf) and the simulated union
 * (`ExitReason`, from `strategy-types`) are genuinely different sets — a
 * backtest has no `flatten_all` and the engine has no `end_of_data` — so
 * each gets its own exhaustive `Record`. What they share is the code
 * strings: a reason that exists on both sides renders the same three
 * letters on a trade row and on a chart.
 *
 * Both imports are type-only, so nothing server-side is pulled into the
 * browser bundle.
 *
 * Owned by docs/modules/ui/design-language.md.
 */
import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import { exitReasonCodeForLabel, exitReasonCodeOf } from "@/lib/logging/exit-reasons";
import type { ExitReason } from "@/lib/trading/strategy-types";

export type ChipGroup = "profit" | "loss" | "neutral" | "strategy" | "ops";

export interface ChipMapping {
  code: string;
  group: ChipGroup;
}

/**
 * The live vocabulary. A `Record<ExitReasonCode, …>`, so a code added to
 * `EXIT_REASONS` without a chip fails to compile.
 */
export const EXIT_REASON_CHIPS: Readonly<Record<ExitReasonCode, ChipMapping>> = {
  take_profit: { code: "TP", group: "profit" },
  stop_loss: { code: "SL", group: "loss" },
  breakeven_stop: { code: "BE", group: "neutral" },
  trail_stop: { code: "TR", group: "profit" },
  strategy_signal: { code: "STR", group: "strategy" },
  realtime_exit: { code: "STR", group: "strategy" },
  time_stop: { code: "STR", group: "strategy" },
  ema_exit: { code: "STR", group: "strategy" },
  time_window_close: { code: "TWC", group: "ops" },
  deployment_close: { code: "DEP", group: "ops" },
  bracket_failure_force_close: { code: "FRC", group: "ops" },
  engine_downtime: { code: "DWN", group: "ops" },
  manual_position_close: { code: "HND", group: "ops" },
  flatten_all: { code: "FLT", group: "ops" },
  flatten_deployment: { code: "FLD", group: "ops" },
  manual: { code: "MAN", group: "ops" },
  bracket_manual: { code: "BRK", group: "ops" },
};

/**
 * The simulated vocabulary — `backtest.ts` and `replay.ts`'s `ExitReason`.
 * Exhaustive over that union for the reason the live map is exhaustive over
 * its own.
 *
 * Six of the nine reuse a live code verbatim, which is the point. Three do
 * not, and each is a deliberate reading:
 *
 *  - `signal` is the simulated twin of `strategy_signal` / `realtime_exit`,
 *    and takes their `STR`.
 *  - `time_stop` and `ema_exit` are `STR` here for the reason they are `STR`
 *    live: both are the strategy calling its own exit, and the distinction
 *    between *which* strategy rule fired belongs in the tooltip, not in a
 *    three-letter code.
 *  - `end_of_data` has no live counterpart at all — the engine never runs
 *    out of bars — so it takes a code of its own rather than borrowing one.
 *    It is an artifact of the measurement, not an outcome, and reading it as
 *    a `TWC` would credit the run with a session close that never happened.
 */
export const BACKTEST_EXIT_CHIPS: Readonly<Record<ExitReason, ChipMapping>> = {
  take_profit: { code: "TP", group: "profit" },
  stop_loss: { code: "SL", group: "loss" },
  breakeven_stop: { code: "BE", group: "neutral" },
  trail_stop: { code: "TR", group: "profit" },
  signal: { code: "STR", group: "strategy" },
  time_stop: { code: "STR", group: "strategy" },
  ema_exit: { code: "STR", group: "strategy" },
  time_window_close: { code: "TWC", group: "ops" },
  end_of_data: { code: "EOD", group: "ops" },
};

/** The residual arm, shared by both classifiers so they cannot disagree. */
const UNCLASSIFIED: ChipMapping = { code: "STR", group: "strategy" };

/**
 * Live path: code first, then the reverse label index for a row written
 * before `exit_reason_code` existed. Only a label the table has never
 * carried lands on the residual arm.
 */
export function classifyExitReason(code: string | null, label: string): ChipMapping {
  const resolved = exitReasonCodeOf(code) ?? exitReasonCodeForLabel(label);
  return resolved == null ? UNCLASSIFIED : EXIT_REASON_CHIPS[resolved];
}

/**
 * Any recorded exit reason → its chip, or **null when nothing recognises
 * it**.
 *
 * Takes a bare `string` rather than either union because the input is a
 * line of JSONL written by some earlier build of the CLI, or a label off a
 * row that predates `exit_reason_code`. A value this build does not name is
 * an older file, not a type error.
 *
 * Three tables in order — simulated codes, live codes, then the live
 * reverse-label index — so a value that is a code in either vocabulary
 * renders its own letters wherever it turns up. **Null rather than the
 * residual `STR` arm** is the difference from `classifyExitReason`: a chip
 * in a table cell must render *something*, because a trade always ended
 * somehow, but a chart label has a truthful fallback (`EXIT`) and stamping
 * `STR` on a string nobody recognises would claim the strategy called an
 * exit it may not have. The caller picks which it needs.
 */
export function chipForExitReason(raw: string | null | undefined): ChipMapping | null {
  if (raw == null || raw.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(BACKTEST_EXIT_CHIPS, raw)) {
    return BACKTEST_EXIT_CHIPS[raw as ExitReason];
  }
  const resolved = exitReasonCodeOf(raw) ?? exitReasonCodeForLabel(raw);
  return resolved == null ? null : EXIT_REASON_CHIPS[resolved];
}

/**
 * Simulated path with the residual arm applied — the chip for a run
 * artifact's row, for a surface that must render one.
 */
export function chipForBacktestExitReason(raw: string | null | undefined): ChipMapping {
  return chipForExitReason(raw) ?? UNCLASSIFIED;
}

/**
 * 15% tint behind a full-strength border and text. An inline pill inherits
 * its parent's text context, so the styling is self-contained.
 */
export const CHIP_TONE: Readonly<Record<ChipGroup, string>> = {
  profit: "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]",
  loss: "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]",
  neutral: "bg-[var(--muted)]/15 text-[var(--muted)] border-[var(--muted)]",
  strategy: "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]",
  ops: "bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]",
};

/** The chip's own class string, so a second surface cannot restyle it. */
export const CHIP_CLASS =
  "inline-flex items-center align-baseline rounded-sm border px-[3px] font-mono text-[10px] font-semibold uppercase leading-[14px] tracking-wide";
