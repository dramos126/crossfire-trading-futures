/**
 * The smallest risk per trade that buys a playbook one contract, and the
 * callout that says so — the pure half, shared by the Playbooks page and the
 * book grid.
 *
 * **Derived, never typed.** The playbook declares the stop every entry places
 * at its defaults (`config.fixedStopTicks`), and the figure is that stop
 * through the sizer's own denominator, `riskPerContractCents`, on the
 * instrument it is calibrated for — so the number on screen is the one the
 * sizer refuses below, to the cent, and moves with the stop.
 *
 * **Display only.** Nothing here gates, sizes or refuses: the sizer already
 * refuses every entry under this figure, and these strings exist because that
 * refusal is a skip in the log while the cell still reads armed.
 */

import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { usd } from "@/lib/trading/orders/account-phase-sizer";
import { riskPerContractCents } from "@/lib/trading/orders/pnl-math";
import { FULL_RISK_PERCENT, playbookBudgetCents } from "@/lib/trading/orders/risk-sizer";
import type { StrategyConfig } from "@/lib/trading/strategy-types";

export interface MinimumRisk {
  stopTicks: number;
  /** One contract's loss at the stop, fees included — the sizer's own figure. */
  cents: number;
  /** That loss rounded up to whole dollars: the smallest round budget that
   *  fits it, which is the number the operator types. */
  wholeUsd: number;
}

/**
 * Null for a playbook that declares no fixed stop, or no instrument to price
 * one on — a stop in ticks is not a dollar figure until it has a tick value.
 */
export function minimumRiskOf(
  config: Pick<StrategyConfig, "fixedStopTicks" | "calibratedFor">,
): MinimumRisk | null {
  const stopTicks = config.fixedStopTicks;
  if (stopTicks == null || config.calibratedFor == null) return null;
  const spec = CONTRACT_SPECS[config.calibratedFor];
  const cents = riskPerContractCents(stopTicks, spec.tickValue, spec.feePerSide);
  return { stopTicks, cents, wholeUsd: Math.ceil(cents / 100) };
}

/** The stamp beside the playbook — the list row's chip, and the book grid
 *  cell's warn stamp when the account's budget is under it. */
export function minimumRiskStamp(min: MinimumRisk): string {
  return `needs ${usd(min.wholeUsd)} risk/trade`;
}

/**
 * The shared-account half. It is the same on every surface, because it is a
 * fact about the account's settings rather than about any one account: the
 * budget and the ceiling are the account's upper limit, a playbook's own two
 * settings can only lower it, so fitting this playbook by raising the
 * account's moves every other playbook on it. Names each field by its label.
 */
export const MINIMUM_RISK_SHARED_ACCOUNT =
  "Risk per trade and Max contracts are set for the whole account on the Risk page, and they " +
  "are the upper limit for every playbook on it. A playbook's own Playbook max contracts and " +
  "Share of account risk can only lower that limit, never raise it. So on an account this " +
  "playbook shares, raising Risk per trade to fit it lets the other playbooks take more " +
  "contracts too, unless their own settings hold them back.";

export interface MinimumRiskNotice {
  tone: "info" | "warn";
  /** Blocks split on `\n\n`, per the tooltip rule. */
  text: string;
  /** Set only on the warn reading — the account's budget is known and under it. */
  stamp: string | null;
}

/**
 * The callout. **Warn only when the account's budget is known and below the
 * minimum**; a surface with no account, or a budget it could not read, gets
 * the informational reading, because a warning about a number nobody read
 * would name a cause nobody checked.
 *
 * `budgetUsd` is the account's resolved risk per trade for today and
 * `riskPercent` the playbook's share of it; the compare is against the
 * sizer's own scaled budget (`playbookBudgetCents`), in whole cents, so a
 * playbook at 50% of $350 warns where the account's $350 alone would not.
 */
export function minimumRiskNotice(
  min: MinimumRisk,
  budgetUsd: number | null,
  riskPercent: number,
): MinimumRiskNotice {
  const stop = `${min.stopTicks.toLocaleString("en-US")}-tick stop`;
  const effect =
    "it takes no entries: it stays flat and logs a skip on each signal, even while it shows as armed.";
  const scaledCents = budgetUsd == null ? null : playbookBudgetCents(budgetUsd, riskPercent);
  if (budgetUsd != null && scaledCents != null && scaledCents < min.cents) {
    const budget =
      riskPercent === FULL_RISK_PERCENT
        ? `This account's risk per trade today is ${usd(budgetUsd)}`
        : `This playbook sizes from ${riskPercent}% of this account's ${usd(budgetUsd)} risk per ` +
          `trade today, which is ${usd(scaledCents / 100)}`;
    return {
      tone: "warn",
      text:
        `${budget}, under the ` +
        `${usd(min.wholeUsd)} one contract needs at this playbook's ${stop}, so here ${effect}` +
        `\n\n${MINIMUM_RISK_SHARED_ACCOUNT}`,
      stamp: minimumRiskStamp(min),
    };
  }
  return {
    tone: "info",
    text:
      `Needs a risk per trade of at least ${usd(min.wholeUsd)} to take one contract: one ` +
      `contract's loss at its ${stop} is ${usd(min.cents / 100)}, fees included. Below that ${effect}` +
      `\n\n${MINIMUM_RISK_SHARED_ACCOUNT}`,
    stamp: null,
  };
}
