import { riskPerContractCents, toCents } from "./pnl-math";

/**
 * The risk sizer — how many contracts an entry gets.
 *
 * The operator states a dollar budget per trade on the account; the platform
 * sizes each entry down to the largest contract count whose stop fits that
 * budget, and skips the entry when even one contract does not. It replaces
 * `resolveDeploymentSize`, which read a contract count the operator typed.
 *
 * Pure and dependency-light on purpose: the engine and the backtest CLI both
 * call it, so a run at `--risk-usd` is a preview of what the engine would
 * have placed rather than an approximation of it.
 *
 * `resolveDeploymentSize`'s two rules survive under it. **No order is placed
 * on an undefined size** — every input this cannot make sense of throws,
 * and the engine's per-leg catch releases the contract lock, logs and skips
 * the tick. And it **never defaults**: there is no "assume one contract"
 * arm, because a plausible number on the field that says how much is at risk
 * is the one thing this must not invent.
 */

/**
 * The most contracts one entry may take, on any account and any playbook.
 *
 * **It is a reviewed constant, not a setting.** A fixed dollar budget divided
 * by the stop hands the largest position to the tightest stop, and on a
 * playbook whose stop is anchored to a wick that is the worst trade in the
 * book. Measured on a wick-anchored playbook held out on MNQ: the handful of
 * trades the sizer gave 6–20 lots lost more than the rest of the run made,
 * and capping at 3 raised the net while cutting the max drawdown by a third.
 * That is **one module on one instrument**, and what carries it to the rest
 * of the shelf is the arithmetic rather than the sample — every wick-anchored
 * stop concentrates size exactly where the stop is least able to carry it.
 *
 * **What it costs where it binds, measured rather than assumed.** On a
 * playbook with ordinary stops at the same budget it is not inert: it binds on
 * about 2% of held-out trades (all with stops under 105 ticks), costs a small
 * fraction of the net across four years, and leaves the max drawdown and the
 * expectancy in R untouched — a cap moves dollars, never R.
 *
 * **Raising it takes a measurement, not an argument**, on the standard a
 * playbook constant is re-specified under: a held-out run at the account's real
 * budget, a pre-registered rule stated before the numbers are read, and the
 * drawdown consequence quantified beside the net — because the whole finding
 * here is a net that improved while the drawdown improved further. Lowering the
 * ceiling on one account is a form edit and needs none of that.
 *
 * Two surfaces read it and neither restates it: `PUT /api/accounts/risk`
 * refuses a posture above it, and the backtest CLI defaults `--max-contracts`
 * to it so an unstated cap is what the engine would place rather than the
 * widest available.
 */
export const REVIEWED_MAX_CONTRACTS = 3;

/**
 * What every surface says when a ceiling above the reviewed one is asked for.
 *
 * One wording interpolating the one constant, so the sentence and the number
 * cannot drift apart: the settings route answers it and the form refuses at the
 * field with it. It names the ceiling, the value and the standard, because
 * *"size limit exceeded"* sends the operator looking for the setting that
 * raises it.
 */
export const MAX_CONTRACTS_REFUSAL =
  `Maximum contracts is capped at ${REVIEWED_MAX_CONTRACTS}. That ceiling is set in code and ` +
  `reviewed against a measured run, so raising it takes new evidence rather than a form edit. ` +
  `Set ${REVIEWED_MAX_CONTRACTS} or fewer.`;

/** What the operator set on the account. Both fields are required together:
 *  a budget with no ceiling is a position size decided entirely by how tight
 *  today's stop happens to be. */
export interface AccountRiskPosture {
  /** Loss at the stop, fees included, that one entry may expose. */
  maxRiskPerTradeUsd: number;
  /** Hard ceiling regardless of budget. The operator may set it lower per
   *  account; `REVIEWED_MAX_CONTRACTS` is as high as it goes. */
  maxContracts: number;
}

/**
 * Either a contract count, or a refusal that the *next* bar may not have.
 *
 * `sized: false` rather than a throw, and rather than `null`: the stop varies
 * per setup, so a stop too wide for the budget on this bar is an ordinary,
 * transient miss and the same playbook may fit two bars later. It is the
 * `EntrySkip` shape's reason for existing, and it is why the CLI breaks
 * `risk_budget` out of `skipReasonCounts` — a playbook that skips half its
 * signals at the operator's budget has a geometry problem, and that is only
 * visible if the skips are counted rather than silently absent.
 *
 * **The refusal carries no gate id.** It used to carry `skip: "risk_budget"`,
 * which nothing read and which was a second definition of an id that belongs
 * to `RISK_BUDGET_GATE` in [`skipped-signal.ts`](../skipped-signal.ts) — one
 * of them would have been renamed alone. The discriminant is `sized`.
 */
export type RiskSizeResult =
  | {
      sized: true;
      contracts: number;
      riskPerContractUsd: number;
      posture: AccountRiskPosture;
      /** The budget the count was divided out of: the account's, scaled by
       *  the playbook's share. Equal to `posture.maxRiskPerTradeUsd` at 100%. */
      budgetUsd: number;
      playbook: PlaybookSizing;
    }
  | {
      sized: false;
      riskPerContractUsd: number;
      posture: AccountRiskPosture;
      budgetUsd: number;
      playbook: PlaybookSizing;
    };

/**
 * The two deployment settings that narrow the account's posture for one
 * playbook (operator, 2026-10-21). Both only ever lower the size: the cap is a
 * third ceiling beside the account's, and the share scales the account's
 * budget down before the division. Neither can raise anything.
 */
export const PLAYBOOK_MAX_CONTRACTS_PARAM = "playbookMaxContracts";
export const PLAYBOOK_RISK_PERCENT_PARAM = "playbookRiskPercent";
/** The setting's off value, the form's `0 = OFF` idiom. */
export const NO_PLAYBOOK_CONTRACT_CAP = 0;
export const FULL_RISK_PERCENT = 100;

export interface PlaybookSizing {
  /** `null` is no playbook cap; otherwise a whole number in 1..`REVIEWED_MAX_CONTRACTS`. */
  maxContracts: number | null;
  /** Whole percent of the account's budget, 1..100. */
  riskPercent: number;
}

export const NO_PLAYBOOK_LIMITS: Readonly<PlaybookSizing> = Object.freeze({
  maxContracts: null,
  riskPercent: FULL_RISK_PERCENT,
});

/**
 * Read the two settings off a deployment's resolved params, for the engine and
 * the backtest alike. Only an absent key and the cap's `0` mean "no limit";
 * anything else is handed to the sizer as stored, and the sizer throws on what
 * it cannot use. A value that is not a number is not coerced here: the API
 * coerces at write, and a text value that got past it is a refusal.
 *
 * A stored `null` cap throws here rather than in the sizer, because `null` is
 * this type's own "no cap" and handing it on would read as exactly that. Both
 * callers call this inside the sizer's `try`, so it lands in the same catch.
 */
export function playbookSizingFrom(params: Readonly<Record<string, unknown>>): PlaybookSizing {
  const cap = params[PLAYBOOK_MAX_CONTRACTS_PARAM];
  const pct = params[PLAYBOOK_RISK_PERCENT_PARAM];
  if (cap === null) throw new Error(playbookCapFailure("playbook settings", cap));
  return {
    maxContracts: cap === undefined || cap === NO_PLAYBOOK_CONTRACT_CAP ? null : (cap as number),
    riskPercent: pct === undefined ? FULL_RISK_PERCENT : (pct as number),
  };
}

function playbookCapFailure(where: string, cap: unknown): string {
  return `${where}: playbook max contracts must be a whole number from 1 to ${REVIEWED_MAX_CONTRACTS}, got ${String(cap)}`;
}

/**
 * The account's budget scaled by a playbook's share, in whole cents: integer
 * cents times a whole percent, floored, so a share never rounds a budget up
 * past what the account allowed. The sizer divides by this, and the
 * minimum-risk notices compare against it, so the two cannot disagree.
 */
export function playbookBudgetCents(maxRiskPerTradeUsd: number, riskPercent: number): number {
  return Math.floor((toCents(maxRiskPerTradeUsd) * riskPercent) / FULL_RISK_PERCENT);
}

/** What the API and the CLI say when the cap is outside its range. */
export const PLAYBOOK_MAX_CONTRACTS_REFUSAL =
  `Playbook max contracts is a whole number from 1 to ${REVIEWED_MAX_CONTRACTS}, or 0 for no ` +
  `playbook limit. It only lowers the account's own limit, never raises it.`;

/** What the API and the CLI say when the share is outside its range. */
export const PLAYBOOK_RISK_PERCENT_REFUSAL =
  `Share of the account's risk is a whole percent from 1 to ${FULL_RISK_PERCENT}. ` +
  `It only lowers the account's risk per trade for this playbook, never raises it.`;

const PLAYBOOK_SIZING_RANGES: ReadonlyArray<readonly [key: string, min: number, max: number, refusal: string]> = [
  [PLAYBOOK_MAX_CONTRACTS_PARAM, NO_PLAYBOOK_CONTRACT_CAP, REVIEWED_MAX_CONTRACTS, PLAYBOOK_MAX_CONTRACTS_REFUSAL],
  [PLAYBOOK_RISK_PERCENT_PARAM, 1, FULL_RISK_PERCENT, PLAYBOOK_RISK_PERCENT_REFUSAL],
];

/**
 * The settings check on stored or merged values, numbers only: what the CLI
 * runs on every param set it executes, and what the API runs after converting
 * text (`checkDeploymentSettings`), since the engine does not coerce either.
 * Absent keys pass.
 */
export function playbookSizingRefusal(values: Readonly<Record<string, unknown>>): string | null {
  for (const [key, min, max, refusal] of PLAYBOOK_SIZING_RANGES) {
    if (!(key in values)) continue;
    const v = values[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return refusal;
  }
  return null;
}

export function resolveRiskSizedContracts(args: {
  /** The bracket's stop distance, after Override / Min / Max. */
  slTicks: number;
  tickValue: number;
  feePerSideUsd: number;
  posture: AccountRiskPosture | null;
  /** The playbook's own narrowing of the posture: `playbookSizingFrom(params)`
   *  from the engine and the backtest, `NO_PLAYBOOK_LIMITS` from a caller with
   *  no playbook settings. Required, so no caller drops it by omission. */
  playbook: PlaybookSizing;
  /** Names the caller in the throw — a deployment id, "backtest", a fold. */
  where: string;
}): RiskSizeResult {
  const { slTicks, tickValue, feePerSideUsd, posture, playbook, where } = args;

  // A missing posture is the unclassified-account case, one field over: the
  // app cannot say what this account may risk, so it refuses rather than
  // picking a number. Same direction as the live-account block's refusal of
  // an account it cannot classify.
  if (posture == null) {
    throw new Error(`${where}: no risk posture is set for this account`);
  }
  assertPositiveFinite(posture.maxRiskPerTradeUsd, `${where}: maxRiskPerTradeUsd`);
  assertPositiveInt(posture.maxContracts, `${where}: maxContracts`);
  assertPositiveFinite(slTicks, `${where}: slTicks`);
  assertPositiveFinite(tickValue, `${where}: tickValue`);
  if (!Number.isFinite(feePerSideUsd) || feePerSideUsd < 0) {
    throw new Error(`${where}: feePerSideUsd must be a non-negative number, got ${feePerSideUsd}`);
  }
  if (playbook.maxContracts !== null) {
    const cap = playbook.maxContracts;
    if (!Number.isInteger(cap) || cap < 1 || cap > REVIEWED_MAX_CONTRACTS) {
      throw new Error(playbookCapFailure(where, cap));
    }
  }
  if (!Number.isInteger(playbook.riskPercent) || playbook.riskPercent < 1 || playbook.riskPercent > FULL_RISK_PERCENT) {
    throw new Error(
      `${where}: playbook risk percent must be a whole number from 1 to ${FULL_RISK_PERCENT}, got ${String(playbook.riskPercent)}`,
    );
  }

  const riskCents = riskPerContractCents(slTicks, tickValue, feePerSideUsd);
  // Reachable without a bad input: a sub-cent stop on a cheap tick with fees
  // off rounds to zero, and dividing by it would answer Infinity contracts.
  if (riskCents <= 0) {
    throw new Error(
      `${where}: one contract's loss at the stop rounds to zero (slTicks=${slTicks}, tickValue=${tickValue})`,
    );
  }
  const riskPerContractUsd = riskCents / 100;

  const budgetCents = playbookBudgetCents(posture.maxRiskPerTradeUsd, playbook.riskPercent);
  const budgetUsd = budgetCents / 100;
  const affordable = Math.floor(budgetCents / riskCents);
  if (affordable < 1) {
    return { sized: false, riskPerContractUsd, posture, budgetUsd, playbook };
  }

  return {
    sized: true,
    contracts: Math.min(posture.maxContracts, playbook.maxContracts ?? posture.maxContracts, affordable),
    riskPerContractUsd,
    budgetUsd,
    playbook,
    // The posture is handed back rather than re-read by the caller: it is
    // what this answer was computed from, and it goes onto the trade row's
    // `paramSnapshot`. A second read could see a posture the operator
    // changed between the two.
    posture,
  };
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number, got ${value}`);
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}
