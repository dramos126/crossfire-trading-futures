/**
 * The wording of `account_risk_settings_changed`, and the read of it back.
 *
 * A leaf on purpose: `account-brokers.ts` writes the line and the parity
 * check reads it off a snapshot's `engine_logs`, and the CLI must not import
 * a table module to do that. One file owns the sentence's shape, so the
 * writer and the reader cannot drift apart.
 */
import type { DailyPnlLimits } from "@/lib/trading/daily-pnl-gate";
import { usd } from "@/lib/trading/orders/account-phase-sizer";
import type { AccountRiskPosture } from "@/lib/trading/orders/risk-sizer";

export const ACCOUNT_RISK_SETTINGS_CHANGED = "account_risk_settings_changed";

/** Everything the operator sets on an account's risk row, read as one value so
 *  a write can be compared against what it replaced. */
export interface AccountRiskSettings {
  posture: AccountRiskPosture | null;
  dailyPnl: DailyPnlLimits;
  phase: { phase: string; mllUsd: number | null; startBalanceUsd: number | null; pressAtUsd: number | null } | null;
}

/** The three fields the daily P&L gate reads, as the line names them. */
const DAILY_LIMIT_LABELS = ["daily loss limit", "daily profit limit", "daily limits count open P&L"] as const;

/** Between the line's cause and its list of changes. */
const CHANGES_FROM = "): ";
const CHANGE_SEPARATOR = "; ";

const offOrUsd = (value: number): string => (value <= 0 ? "off" : usd(value));
const unsetOr = (value: number | null | undefined, format: (v: number) => string): string =>
  value == null ? "unset" : format(value);
const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * One `name before → after` clause per field that differs, in the form's
 * order. The payout stamp is the app's, not the operator's, so it is left out.
 */
export function describeAccountRiskChange(before: AccountRiskSettings, after: AccountRiskSettings): string[] {
  const [loss, profit, unrealized] = DAILY_LIMIT_LABELS;
  const fields: Array<[string, string, string]> = [
    ["risk per trade", unsetOr(before.posture?.maxRiskPerTradeUsd, usd), unsetOr(after.posture?.maxRiskPerTradeUsd, usd)],
    ["max contracts", unsetOr(before.posture?.maxContracts, String), unsetOr(after.posture?.maxContracts, String)],
    [loss, offOrUsd(before.dailyPnl.dailyMaxLossUsd), offOrUsd(after.dailyPnl.dailyMaxLossUsd)],
    [profit, offOrUsd(before.dailyPnl.dailyMaxProfitUsd), offOrUsd(after.dailyPnl.dailyMaxProfitUsd)],
    [unrealized, yesNo(before.dailyPnl.dailyPnlIncludeUnrealized), yesNo(after.dailyPnl.dailyPnlIncludeUnrealized)],
    ["account phase", before.phase?.phase ?? "off", after.phase?.phase ?? "off"],
    ["maximum loss limit", unsetOr(before.phase?.mllUsd, usd), unsetOr(after.phase?.mllUsd, usd)],
    ["starting balance", unsetOr(before.phase?.startBalanceUsd, usd), unsetOr(after.phase?.startBalanceUsd, usd)],
    ["press threshold", unsetOr(before.phase?.pressAtUsd, usd), unsetOr(after.phase?.pressAtUsd, usd)],
  ];
  return fields.filter(([, was, now]) => was !== now).map(([name, was, now]) => `${name} ${was} → ${now}`);
}

export function accountRiskChangeMessage(accountId: number, cause: string, changes: readonly string[]): string {
  return `account ${accountId} risk settings changed (${cause}${CHANGES_FROM}${changes.join(CHANGE_SEPARATOR)}`;
}

/** The change clauses of a logged line; the whole message when it is not in
 *  this shape, so an older or hand-written line is still shown, not dropped. */
export function accountRiskChangesOf(message: string): string[] {
  const at = message.indexOf(CHANGES_FROM);
  return at < 0 ? [message] : message.slice(at + CHANGES_FROM.length).split(CHANGE_SEPARATOR);
}

/** Whether a change clause is one the daily P&L gate reads. */
export function touchesDailyLimits(change: string): boolean {
  return DAILY_LIMIT_LABELS.some((label) => change.startsWith(`${label} `));
}
