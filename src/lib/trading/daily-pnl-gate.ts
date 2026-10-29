/**
 * Per-**account** daily-PnL entry gate.
 *
 * Behavior (locked spec):
 *   - Block new entries when realized P&L for the session reaches
 *     `pnl <= -dailyMaxLossUsd` (when > 0) OR
 *     `pnl >= +dailyMaxProfitUsd` (when > 0). Inclusive thresholds.
 *   - `pnl` = gross realized only by default; gross realized + open-position
 *     unrealized when `dailyPnlIncludeUnrealized = true`.
 *   - NEVER force-flatten. The gate only blocks new entries.
 *   - Session window = the global futures session (currentCmeSessionStart,
 *     6pm → 4pm ET, with rollover handled there).
 *   - **Account scope, since phase 1 of the playbooks proposal.** The three
 *     numbers come from `account_brokers` and the counter is implicit in
 *     `strategy_trades` filtered by `account_id` + `datetime(COALESCE(
 *     exit_filled_at, exit_detected_at)) >= datetime(sessionStart)`, so engine
 *     restarts don't wipe it. **Every part of that predicate is load-bearing**
 *     — an approximated exit carries a real `pnl_dollars` with a null fill
 *     timestamp until the heal pass lands, `updated_at` cannot stand in for
 *     the close because three healers move it, and the two timestamp formats
 *     do not compare as raw text. See `persistence/README.md`.
 *   - No skip log emitted by the gate itself (spec).
 *
 * **Why the account and not the deployment.** Topstep's daily loss is an
 * account rule: two playbooks on one account share the drawdown they are
 * measured against, and a per-deployment limit of $X on each of them is a $2X
 * account limit wearing the operator's number. Per-deployment scoping was an
 * artifact of the deployment being the only config object there was. The
 * machinery — the evaluator, the inclusive thresholds, the session window, the
 * never-force-flatten rule — is unchanged.
 *
 * Engine and backtest call the same evaluator, so the *decision* is one
 * function. **The inputs are not identical and the difference is bounded but
 * real**, in two ways now. The engine reads `getAccountRealizedSinceGross`, an
 * open-ended `>=` over a session anchor, while the backtest buckets each trade
 * by `currentCmeSessionStart(exitTimestamp)` and reads back an exact
 * session-key match; they agree on any trade with a real fill timestamp and can
 * differ on an approximated exit, which the engine places by when it was
 * *detected* and the backtest by its exit bar. And a backtest runs one playbook,
 * so its counter is that playbook's alone where the engine's is the account's —
 * a run at `--daily-loss-usd` previews the gate for a single-playbook account
 * and under-counts for a shelf. Do not strengthen either into a guarantee.
 */

export type DailyPnlGateSide = "loss" | "profit";

/** The three numbers, wherever they come from: `account_brokers` on the engine
 *  and replay, a CLI flag in the backtest. `0` disables a side. */
export interface DailyPnlLimits {
  dailyMaxLossUsd: number;
  dailyMaxProfitUsd: number;
  dailyPnlIncludeUnrealized: boolean;
}

export interface DailyPnlGateInputs extends DailyPnlLimits {
  /** Realized gross P&L for the account over the current session
   *  (already filtered by sessionStart). */
  realizedGross: number;
  /** Open-position unrealized P&L, or 0 when flat / unknown. Caller passes 0
   *  if `dailyPnlIncludeUnrealized` is false to keep the math transparent
   *  (the evaluator also enforces that). */
  unrealized: number;
}

export interface DailyPnlGateResult {
  /** True when at least one threshold is breached and entries are blocked. */
  tripped: boolean;
  /** Which side is currently breached. Null when not tripped. */
  side: DailyPnlGateSide | null;
  /** The threshold dollars (positive number) that fired. Null when not
   *  tripped. */
  thresholdUsd: number | null;
  /** Effective P&L the evaluator compared against the threshold. Equals
   *  `realizedGross + (unrealized when include flag is on, else 0)`. */
  effectivePnl: number;
}

/**
 * Pure evaluator. Inclusive thresholds: `pnl <= -loss` or `pnl >= +profit`.
 * Disabled side (threshold = 0 or non-positive) is skipped.
 */
export function evaluateDailyPnlGate(input: DailyPnlGateInputs): DailyPnlGateResult {
  const lossThreshold =
    Number.isFinite(input.dailyMaxLossUsd) && input.dailyMaxLossUsd > 0
      ? input.dailyMaxLossUsd
      : 0;
  const profitThreshold =
    Number.isFinite(input.dailyMaxProfitUsd) && input.dailyMaxProfitUsd > 0
      ? input.dailyMaxProfitUsd
      : 0;

  const includeUnrealized = input.dailyPnlIncludeUnrealized === true;
  const unrealized =
    includeUnrealized && Number.isFinite(input.unrealized) ? input.unrealized : 0;
  const effective = (Number.isFinite(input.realizedGross) ? input.realizedGross : 0) + unrealized;

  if (lossThreshold > 0 && effective <= -lossThreshold) {
    return {
      tripped: true,
      side: "loss",
      thresholdUsd: lossThreshold,
      effectivePnl: effective,
    };
  }
  if (profitThreshold > 0 && effective >= profitThreshold) {
    return {
      tripped: true,
      side: "profit",
      thresholdUsd: profitThreshold,
      effectivePnl: effective,
    };
  }
  return { tripped: false, side: null, thresholdUsd: null, effectivePnl: effective };
}

/** No gate at all — every side disabled. The backtest's default and the shape
 *  an account with nothing set reads as. **Frozen**: it is exported and shared
 *  by every caller that defaults to it, so one caller mutating a field would
 *  arm a gate in all of them. */
export const NO_DAILY_PNL_LIMITS: Readonly<DailyPnlLimits> = Object.freeze({
  dailyMaxLossUsd: 0,
  dailyMaxProfitUsd: 0,
  dailyPnlIncludeUnrealized: false,
});

/**
 * Is either side of the gate armed?
 *
 * **A value test, not `limits !== NO_DAILY_PNL_LIMITS`.** Reference identity
 * against the exported constant reads as a value comparison and answers "armed"
 * for any structurally-identical object a caller happened to build itself — the
 * two agree today only because the one caller takes the constant as its
 * parameter default. The evaluator skips a non-positive threshold anyway, so
 * this is a "can this be skipped entirely" question and nothing else.
 */
export function hasDailyPnlLimits(limits: DailyPnlLimits): boolean {
  return limits.dailyMaxLossUsd > 0 || limits.dailyMaxProfitUsd > 0;
}
