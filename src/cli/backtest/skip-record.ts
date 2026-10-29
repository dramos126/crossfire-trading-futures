/**
 * The `skips.jsonl` record — an entry the run considered and did not take,
 * with the reason on the row.
 *
 * It is the backtest half of the engine's `skipped_signals` table, and the
 * two are deliberately built from the same constructors in
 * [`skipped-signal.ts`](../../lib/trading/skipped-signal.ts): a gate visible
 * in one path and not the other is the parity defect this file exists to
 * prevent. What the file carries and the table does not is the fold, the
 * sample and the regime label; what the table carries and the file does not
 * is the deployment, the account and the group, because a backtest has no
 * account — the same asymmetry `dailyPnl` already lives with. The playbook and
 * the ticker are on `run.json`'s header rather than repeated per row, exactly
 * as `trades.jsonl` leaves them.
 *
 * **Its scope is exactly what the engine persists.** The CLI's own regime gate
 * stands entries down too and is reported in `skipReasonCounts.regime`, but
 * the engine records nothing for it — `withRegimeGate` returns `null` on a
 * stood-down bar and a bare `null` is persisted nowhere on either path. Phase
 * 3 lifting the wrapper into the platform does not change that by itself; it
 * changes when `onSkip` is wired to the engine's writer, which is the line
 * that makes a row here parity rather than a live/backtest disagreement
 * wearing the shape of evidence. See [regime.md](../../../docs/modules/trading/regime.md).
 */
import type { RegimeResult } from "@/lib/trading/regime/classify-regime";
import type { SkippedSignal } from "@/lib/trading/skipped-signal";
import type { FoldSample } from "@/lib/trading/backtest-trade-record";

/**
 * The most skip rows one output file carries. Truncation is reported; the
 * gate *counts* in `skipReasonCounts` are exact regardless, so the bound
 * costs detail and never a number the summary reports.
 *
 * There is a bound because the per-session ceiling quoted for `orb` is
 * `orb`'s: "only emit a skip on a real entry candidate" is an authoring rule
 * with no enforcement, a misconfigured module emits `configError` on every
 * bar, and widening `entryWindowEndEt` alone takes `orb` past 70 a session. A
 * multi-year 1m run of a per-bar skipper is half a million rows held in
 * memory and written to disk, on a shared VM where a backtest already has to
 * be run one at a time.
 */
export const MAX_SKIP_RECORDS = 50_000;

/** Appends what fits under the cap; answers how many rows it dropped. */
export function appendSkips(into: CliSkipRecord[], rows: readonly CliSkipRecord[]): number {
  const room = Math.max(0, MAX_SKIP_RECORDS - into.length);
  const taken = Math.min(room, rows.length);
  for (let i = 0; i < taken; i++) into.push(rows[i]);
  return rows.length - taken;
}

/** One wording for the truncation, wherever it is reported. */
export function skipTruncationWarning(dropped: number): string {
  return (
    `skips.jsonl truncated at ${MAX_SKIP_RECORDS} rows; ${dropped} further skips were not ` +
    `written. skipReasonCounts is complete — the counts are exact and only the rows are cut.`
  );
}

export interface CliSkipRecord extends SkippedSignal {
  foldId: number | null;
  sample: FoldSample | null;
  /** The label of the skipped bar's session, or null when no classifier ran.
   *  It is what makes "G1 stood down on N sessions" answerable per cell. */
  regime: RegimeResult | null;
}
