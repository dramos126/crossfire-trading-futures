/**
 * Bracket helpers — pure functions shared by the engine, the backtest and
 * replay so the three cannot disagree about where a bracket sits.
 *
 * **Both legs are the strategy's, and the platform now collapses neither.**
 * `EntrySignal` carries `slTicks` and `tpTicks`; the platform validates them
 * through `isValidBracketTicks` and sends what it was given.
 * `resolveEffectiveSlTicks` — the deployment's Override / Min / Max
 * collapse — is **deleted with the three params behind it**. A floor against
 * a degenerate stop is a playbook constant (`orb`'s `minStopTicks`), which
 * *widens* the stop rather than dropping the trade; a ceiling is the account's
 * risk budget declining to fund the entry, which is a `risk_budget` skip with
 * a dollar figure behind it rather than a tick count the operator guessed.
 * Do not reintroduce a platform-side stop gate.
 */

/**
 * The one rule for "is this a bracket distance the platform may send to a
 * broker": finite and strictly positive.
 *
 * It is a shared predicate rather than three inline comparisons because the
 * engine, the backtest and replay each refuse a bad bracket in their own
 * vocabulary — an `entry_blocked` event, a `continue`, a `signal_drift` — and
 * the *test* has to be one thing or the backtest stops previewing live. Ticks
 * are deliberately not required to be integers: a stop anchored off an
 * indicator has a genuinely fractional distance and rounding it here would be
 * a second opinion about the strategy's geometry.
 */
export function isValidBracketTicks(ticks: number): boolean {
  return Number.isFinite(ticks) && ticks > 0;
}

/**
 * An R-multiple target in ticks — a **strategy-side** helper, not a platform
 * step.
 *
 * Every module in this build derives its target this way, so the arithmetic
 * lives in one place rather than eleven; a playbook that owns its target
 * outright (a range projection, a measured move) simply does not call it. The
 * platform never calls it at all: since `EntrySignal.tpTicks` landed, the
 * target reaching the broker is whatever the strategy emitted.
 *
 * `rewardR` is the *strategy's* own constant now — `riskRewardRatio` is
 * deleted — so the throw is a guard on a calibration file, not on a form.
 */
export function resolveEffectiveTpTicks(
  slTicks: number,
  rewardR: number,
): number {
  if (!Number.isFinite(rewardR) || rewardR <= 0) {
    throw new Error(`reward multiple must be > 0, got ${rewardR}`);
  }
  return Math.max(1, Math.round(slTicks * rewardR));
}

/**
 * Full deployment chip row.
 *
 * Every chip is conditional and omitted when the underlying param is
 * 0 / disabled, so a deployment with none of them set renders an empty
 * string — which is the ordinary state, not a gap. Reads defensively with
 * `?? 0` at the caller so this runs correctly whether or not the paramValues
 * blob carries every key.
 *
 * **Four chips have come off this row rather than being re-pointed, and for
 * one reason.** `Size N` went with the risk sizer: a contract count is
 * answered per entry from the account's budget and *that signal's* stop, so
 * any number here would be invented. The SL chip went with the Override /
 * Min / Max params: with nothing left to collapse it could only have printed
 * `Auto SL`, a check the row does not perform. `DL` and `DP` went with the
 * daily P&L gate's move to the account: the limit is one number the whole
 * account spends, so printing it per deployment says each row has its own.
 * **A chip states what was checked, never what was assumed**
 * ([copy.md](../../../../docs/modules/ui/copy.md)), and that is also why there
 * has never been an RR chip. The account's own numbers live in Settings;
 * whether the board grows an account-scoped strip is the board's question.
 *
 * @param cooldown   cooldownSeconds (0 = disabled, omit chip)
 */
export function formatDeploymentChips(params: { cooldown: number }): string {
  const chips: string[] = [];
  if (params.cooldown > 0) chips.push(`CD: ${params.cooldown}s`);
  return chips.join(" · ");
}
