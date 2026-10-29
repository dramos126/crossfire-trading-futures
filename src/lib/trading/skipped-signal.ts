/**
 * The one shape a skipped entry is recorded in, and the constructors that
 * build it.
 *
 * `orb` fires about five times a month, so the question a soak has to answer
 * is *why didn't it trade today* — and a session that took no trade used to
 * leave no row at all, on the engine or in the backtest. This module is the
 * seam that keeps the two answers the same one: the engine persists the
 * result into `skipped_signals` and the backtest CLI writes it to
 * `skips.jsonl`, but **both build the row here**, so the gate vocabulary, the
 * session bucketing and the `detail` serialisation cannot drift between them.
 *
 * It is deliberately a leaf — no `db/`, no `strategies/` — because the engine,
 * `backtest.ts` and the CLI all import it and only the first of those can open
 * a database.
 *
 * **The vocabulary is `EntrySkip`'s and is not extended here.** A strategy's
 * gate id crosses verbatim; the platform's own refusals get ids in this file
 * so there is one list rather than one per caller.
 *
 * **Every constructor here can throw**, and a caller on the tick path has to
 * assume it: `sessionDateOf` reaches `Intl.DateTimeFormat.formatToParts`,
 * which raises `RangeError` on a bar timestamp it cannot parse. The engine
 * therefore builds the row *inside* its best-effort `try`, through a thunk —
 * a diagnostic row must not be able to fail a tick the strategy already
 * decided correctly.
 */
import type { EntrySkip } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";
import type { AccountGateRefusal } from "@/lib/trading/backtest";
import type { DailyPnlGateSide } from "@/lib/trading/daily-pnl-gate";
import { sessionDateOf } from "@/lib/trading/regime/session-dates";
import { roundToCents } from "@/lib/trading/orders/pnl-math";

/**
 * The platform's own gate id for an entry whose stop the account's per-trade
 * budget could not fit a single contract on. Shared with the backtest CLI's
 * `skipReasonCounts` key, which is what makes a live skip and a backtest skip
 * count under the same name.
 */
export const RISK_BUDGET_GATE = "risk_budget";

/**
 * The platform's own gate id for an entry whose contract count could not be
 * resolved at all — a missing risk posture, or an input the sizer refuses.
 * Engine-only: the backtest supplies its posture from `--risk-usd` and lets
 * the same throw end the run, so there is no CLI counterpart to count under.
 */
export const SIZE_RESOLUTION_GATE = "size_resolution";

/**
 * Who refused. `strategy` is an `EntrySkip` the playbook returned; `platform`
 * is an entry the playbook wanted and the platform declined. The split matters
 * because a run of the first is a strategy question and a run of the second is
 * an account question — and the log severities already differ for the same
 * reason (`entry_skipped` at info, `entry_risk_budget` at warn).
 */
export type SkippedSignalSource = "strategy" | "platform";

/** Everything about a skip that is not about *which* deployment took it. */
export interface SkippedSignal {
  /** The bar whose close produced the skip — the same instant
   *  `strategy_trades.signal_bar_ts` carries for an entry that did fire, so a
   *  skip and a trade join on one column. */
  signalBarTs: string;
  /** The CME session day the bar falls in, so "why was this day quiet" is one
   *  indexed lookup rather than an ET-aware scan. Computed here rather than at
   *  either writer: the boundary is 18:00 ET and no SQL expression finds it. */
  sessionDate: string;
  source: SkippedSignalSource;
  /** `EntrySkip.gate` verbatim, or one of this file's platform ids. */
  gate: string;
  /** The one-line human reason, as it reads in the engine log. */
  reason: string;
  detail: Record<string, string | number | boolean> | null;
}

/** A skip the playbook itself returned. */
export function strategySkip(skip: EntrySkip, bar: BarData): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "strategy",
    gate: skip.gate,
    reason: skip.skip,
    detail: skip.detail ?? null,
  };
}

/** The three numbers the refusal was made on. */
export interface RiskBudgetNumbers {
  slTicks: number;
  riskPerContractUsd: number;
  maxRiskPerTradeUsd: number;
}

/**
 * The one sentence a budget refusal is described in. Exported because the
 * engine's `entry_risk_budget` line says the same thing to the operator that
 * the row says to the review, and two spellings of one refusal drift.
 */
export function riskBudgetReason(numbers: RiskBudgetNumbers): string {
  return (
    `a ${numbers.slTicks}t stop risks $${numbers.riskPerContractUsd.toFixed(2)} on one ` +
    `contract, over the $${numbers.maxRiskPerTradeUsd.toFixed(2)} per-trade budget`
  );
}

/**
 * A signal the playbook emitted and the risk sizer declined to fund. The three
 * numbers are on the row because a run of these is a stop-geometry problem and
 * the geometry is the thing the trader moves.
 */
export function riskBudgetSkip(bar: BarData, numbers: RiskBudgetNumbers): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "platform",
    gate: RISK_BUDGET_GATE,
    reason: riskBudgetReason(numbers),
    detail: {
      slTicks: numbers.slTicks,
      riskPerContractUsd: numbers.riskPerContractUsd,
      maxRiskPerTradeUsd: numbers.maxRiskPerTradeUsd,
    },
  };
}

/** The same, for a sizer that could not answer a count at all. */
export function sizeResolutionReason(failure: string): string {
  return `size resolution failed — ${failure}`;
}

/**
 * A signal the playbook emitted and the sizer refused to price. Distinct from
 * `riskBudgetSkip` because the budget refusal is transient — the next setup's
 * stop may fit — while this one is the account's configuration and stands
 * every entry down until the operator changes something.
 */
export function sizeResolutionSkip(
  bar: BarData,
  args: { slTicks: number; failure: string },
): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "platform",
    gate: SIZE_RESOLUTION_GATE,
    reason: sizeResolutionReason(args.failure),
    detail: { slTicks: args.slTicks },
  };
}

// ── The account's three cross-leg refusals ──────────────────────────────────
//
// The ids are the book's (`AccountGateRefusal`, `backtest-book.ts`), checked by
// `satisfies`, because the daily parity check joins a live row against a book
// `blocked` row on `(deployment, signal bar, gate)` and a second spelling of
// one refusal would read as a disagreement.

/** Another deployment holds or is entering the account's position on this contract. */
export const CONTRACT_HELD_GATE = "contract_held" satisfies AccountGateRefusal;
/** The signal was set aside while the contract was held and has not reset since. */
export const STALE_LATCH_GATE = "stale_latch" satisfies AccountGateRefusal;
/** The account's daily P&L limit is reached for this session. */
export const DAILY_PNL_GATE = "daily_pnl" satisfies AccountGateRefusal;

/** Who holds the contract, as the engine log names them. */
export interface ContractHolder {
  /** Null when the lock map names no holder — reachable only in a race. */
  deploymentId: string | null;
  /** The holder's playbook by its app name, with a short id. */
  label: string;
}

/** One sentence for the log line and the row, so the two cannot drift. */
export function contractHeldReason(ticker: string, holder: ContractHolder): string {
  return `${ticker} is held by deployment ${holder.label}`;
}

export function contractHeldSkip(bar: BarData, ticker: string, holder: ContractHolder): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "platform",
    gate: CONTRACT_HELD_GATE,
    reason: contractHeldReason(ticker, holder),
    detail: holder.deploymentId == null ? null : { holderDeploymentId: holder.deploymentId },
  };
}

export const STALE_LATCH_REASON =
  "the signal was set aside while another deployment held the contract, and the setup has not reset since";

export function staleLatchSkip(bar: BarData): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "platform",
    gate: STALE_LATCH_GATE,
    reason: STALE_LATCH_REASON,
    detail: null,
  };
}

/** What the daily gate tripped on. */
export interface DailyPnlNumbers {
  side: DailyPnlGateSide;
  thresholdUsd: number;
  effectivePnlUsd: number;
}

export function dailyPnlReason(numbers: DailyPnlNumbers): string {
  const pnl = roundToCents(numbers.effectivePnlUsd);
  return (
    `the account's daily ${numbers.side} limit of $${numbers.thresholdUsd.toFixed(2)} is reached ` +
    `(${pnl < 0 ? "-" : ""}$${Math.abs(pnl).toFixed(2)} this session)`
  );
}

export function dailyPnlSkip(bar: BarData, numbers: DailyPnlNumbers): SkippedSignal {
  return {
    signalBarTs: bar.timestamp,
    sessionDate: sessionDateOf(new Date(bar.timestamp)),
    source: "platform",
    gate: DAILY_PNL_GATE,
    reason: dailyPnlReason(numbers),
    detail: {
      side: numbers.side,
      thresholdUsd: numbers.thresholdUsd,
      effectivePnlUsd: roundToCents(numbers.effectivePnlUsd),
    },
  };
}
