/**
 * The one rule deciding whether an account may be auto-traded.
 *
 * Topstep's terms of service prohibit automated trading on live (funded)
 * accounts. On prod, PRAC-, Combine and ExpressFunded accounts are
 * permitted and a live account is not; staging narrows that to practice
 * accounts only, for every broker. This module holds the predicate, the
 * environment branch included; every gate that enforces it — the
 * deployment routes, `listManagedDeployments()`, the deploy modal —
 * calls in here rather than re-deriving the comparison.
 * Four copy-pasted comparisons is how the open-position gate spent its
 * whole life with one arm that never ran (docs/bugs.md).
 *
 * Deliberately free of `@/lib/db/*` imports so the deploy modal can
 * import it: the persisted-state adapter lives beside the table it reads,
 * in `src/lib/db/account-brokers.ts`, and calls `autoTradeVerdict` for
 * the rule itself.
 *
 * Per broker, on prod:
 *   - Topstep: `classifyAccount()` over the account name. There is no
 *     live/practice field on the wire.
 *   - Tradovate: **permitted unconditionally**, live host included. Those
 *     are cash accounts — the operator's own brokerage, not a prop firm's
 *     — so no third party's TOS governs them. The reasoning rests on one
 *     external fact: Tradovate excludes prop and evaluation accounts from
 *     its individual API program, so the operator cannot hold credentials
 *     that reach one. An approved NinjaTrader Ecosystem app, which carries
 *     the entitlement on the app rather than the account, would falsify
 *     that — and those accounts arrive on the demo host, not the live one.
 *     The 2026-08-24 Decisions entry in docs/modules/brokers/brokers-history.md
 *     says what has to change with it.
 *
 * Staging narrows all of that to **practice accounts only**, asked per
 * broker against that broker's own practice notion, with no arm meaning
 * refused. Staging is unattended and deploys freely, so the accounts it
 * may reach are the ones whose losses are not real money.
 */

import type { Account } from "@/lib/brokers/types";
import { classifyAccount, isPracticeAccount } from "@/lib/brokers/topstep/account-classification";
import { isStagingEnv } from "@/lib/env";

/**
 * What the rule needs to know about an account. `Account` satisfies it
 * structurally, so a UI holding a broker-supplied account passes it
 * straight through; the DB adapter builds one from persisted columns.
 */
export interface AccountTradingIdentity {
  name: string;
  broker: Account["broker"];
  practice: boolean;
}

export type AutoTradeVerdict =
  | { permitted: true }
  | { permitted: false; reason: string };

/** Topstep-name-classified live account. Wording is operator-facing. */
export const LIVE_ACCOUNT_REFUSAL =
  "Auto-trading is not permitted on live accounts per Topstep TOS.";

/**
 * Refused because this build is staging, not because the account is
 * live. An operator staring at a Combine on staging must not be told
 * their Combine is a live account — that sends them to Topstep support
 * over a rule this app made. Wording per docs/modules/ui/copy.md: name
 * the authority, state the rule, give the operator's move.
 */
export const STAGING_PRACTICE_ONLY_REFUSAL =
  "This is a staging build, which auto-trades practice accounts only. Use the production build to trade this account.";

/**
 * No row, or a row seeded before the account name was stored. Not proof
 * of anything, so it is refused — see `autoTradeVerdict`.
 */
export const UNVERIFIED_ACCOUNT_REFUSAL =
  "This account has not been confirmed as a practice or evaluation account. Reload the dashboard so the app can refresh its account list, then try again.";

/**
 * The TOS rule, which holds in every environment. Unchanged since
 * 2026-08-24 and deliberately so — the prod path is exactly what the
 * operator wants and staging only narrows it further, below.
 */
function tosVerdict(identity: AccountTradingIdentity): AutoTradeVerdict {
  // Broker arm first, and it still has to be first even though it now
  // always permits: `classifyAccount` reads a *Topstep* naming convention,
  // so a Tradovate account named "50KTC-…" or "PRAC-…" would otherwise be
  // classified by a rule that has no authority over it. Permitting it for
  // the right reason and permitting it by accident are different, and only
  // one of them survives someone tightening `classifyAccount`.
  //
  // Tradovate accounts are cash accounts — the operator's own brokerage.
  // No prop firm's TOS governs them, because Tradovate excludes prop and
  // evaluation accounts from its individual API program; this install's
  // credentials cannot reach one. A NinjaTrader Ecosystem app (or the
  // multi-credentials work) is what ends that, and the refusal it needs
  // is per credential, not per host — prop accounts sit on demo.
  if (identity.broker === "tradovate") return { permitted: true };

  return classifyAccount(identity) === "LIVE"
    ? { permitted: false, reason: LIVE_ACCOUNT_REFUSAL }
    : { permitted: true };
}

/**
 * Staging trades practice accounts and nothing else, asked per broker
 * against that broker's own practice notion — Topstep's `PRAC-` class,
 * Tradovate's demo host. Both answers come from the existing classifiers,
 * so there is no second prefix or host comparison here.
 *
 * **The switch is exhaustive with a refusing default, and that is the
 * rule rather than a formality.** A broker with no practice notion has no
 * account staging may trade, so it is refused — a third `BrokerKind` gets
 * an arm written for it deliberately or gets nothing, and nothing means
 * no. Permitting by omission is the direction that costs an account.
 */
function stagingPracticeVerdict(identity: AccountTradingIdentity): AutoTradeVerdict {
  const refused: AutoTradeVerdict = { permitted: false, reason: STAGING_PRACTICE_ONLY_REFUSAL };
  switch (identity.broker) {
    case "topstep":
      return classifyAccount(identity) === "PRAC" ? { permitted: true } : refused;
    case "tradovate":
      // The flag the Tradovate translator stamps from the host it fetched
      // the account off, read through the broker-agnostic predicate.
      return isPracticeAccount(identity) ? { permitted: true } : refused;
    default:
      return refused;
  }
}

/**
 * `null` is refused on purpose. An account the app cannot classify is not
 * an account it has proven safe, and the cost of guessing wrong here is a
 * terminated funded account — the same reasoning that keeps the
 * open-position gate off `getAccountBrokerOrTopstep`. Do not add a
 * permissive default.
 *
 * The environment branch asks `isStagingEnv()`, never a raw compare on
 * `NEXT_PUBLIC_APP_ENV`: that helper is "anything that is not exactly
 * prod", so an unset or mistyped variable lands on the narrower staging
 * rule. Do not invert it into `if (isProductionEnv()) … else …` — same
 * truth table today, opposite failure direction the day the helper pair
 * changes.
 *
 * The TOS refusal is answered first, so a genuinely live account on
 * staging is still told it is live rather than being told about staging.
 */
export function autoTradeVerdict(identity: AccountTradingIdentity | null): AutoTradeVerdict {
  if (!identity) return { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL };

  const tos = tosVerdict(identity);
  if (!tos.permitted) return tos;
  return isStagingEnv() ? stagingPracticeVerdict(identity) : tos;
}
