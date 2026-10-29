import type { Account } from "@/lib/brokers/types";

// Broker-agnostic practice-account predicate. Reads the
// server-computed `practice` flag stamped at each broker's translator
// boundary. Each broker owns its own rule:
//   - Topstep: `name.startsWith(PRACTICE_PREFIX)` (Topstep's account-
//     naming convention; the wire response carries no live/practice
//     discriminator field).
//   - Tradovate: `isStagingEnv()` (host-level — Tradovate has no per-
//     account live/demo flag either).
//
// The prefix carries its hyphen. Real issued names are `PRAC-V2-…`
// (observed: `PRAC-V2-100200-90012114`, docs/bugs.md), and the eval
// prefixes share that `<token>-` shape. A bare `"PRAC"` was three
// characters wider than any account Topstep issues, and width is the
// permissive direction here: this flag is what `classifyAccount` reads
// to answer PRAC, and PRAC is auto-tradable. A name that misses the
// prefix falls through to LIVE and is refused — visible and reportable.
// Do not drop the hyphen to "be lenient".
//
// Adding a new broker means stamping `practice` in its translator; this
// predicate stays unchanged. NEVER inline name-prefix checks at call
// sites — they will misclassify non-Topstep brokers.
//
// Lives in lib/topstep/ (server-safe) so both the client hook and the
// engine boot guard can share one source of truth without dragging
// "use client" into a server module.
//
// The live-account auto-trade block is NOT here, despite being the
// obvious neighbour and despite `classifyAccount` — its Topstep arm —
// living below: the block is cross-broker (Tradovate's answer is
// host-level, and the staging branch asks every broker), and this
// directory is Topstep's. See trading/account-trading-policy.ts.
export const PRACTICE_PREFIX = "PRAC-";

export function isPracticeAccount(a: Pick<Account, "practice">): boolean {
  return a.practice;
}

/** Coarse account classification — the Topstep arm of the auto-trade
 *  permission rule in `account-trading-policy.ts`. `UNKNOWN` is the answer
 *  a caller gives when it has no account to classify. */
export type AccountClass = "PRAC" | "COMBINE" | "XFA" | "LIVE" | "UNKNOWN";

// ── Account classification ────────────────────────────────────────

/**
 * Topstep's real evaluation-account prefixes, confirmed by the operator
 * against their own accounts 2026-08-22.
 *
 * A Trading Combine is `<size>KTC-…` — `50KTC-98765`, `100KTC-11111`.
 * **It does not contain the word "COMBINE".** The previous predicate
 * matched `.includes("COMBINE")`, so every real Combine account fell
 * through to LIVE. That was invisible while this function only picked an
 * export filename; the moment it became the auto-trade block's Topstep
 * arm it would have refused every account the operator actually trades.
 *
 * Anchored at the start, not substring-matched. Substring is the
 * permissive direction — a funded account whose name happens to carry a
 * token anywhere would be auto-traded — and the cost of that is a
 * terminated account. A real eval account whose name does not match falls
 * through to LIVE and is refused, which is visible, reportable and
 * fixable; the other error is not. Widen these only against an account
 * name actually observed, and record it here.
 *
 * `EXPRESS_FUNDED_PREFIX` is the only one of these that permits a *funded*
 * account, per the project decision in CLAUDE.md. What would falsify it:
 * a fully-live Topstep funded account observed carrying an `EXPRESS-`
 * name. The predicate has nothing but the name, so it could not tell the
 * two apart — the branch would have to be narrowed or dropped, not
 * patched with a second heuristic. See docs/modules/brokers/topstep.md.
 */
const COMBINE_PREFIX = /^\d+KTC-/;
const EXPRESS_FUNDED_PREFIX = "EXPRESS-";

/**
 * Coarse classification of an account. PRAC is broker-agnostic via
 * `isPracticeAccount` (Topstep PRAC- prefix OR Tradovate demo host both
 * classify as PRAC). XFA and COMBINE remain Topstep-name-pattern-specific
 * — Tradovate accounts have no equivalent eval naming convention, so a
 * Tradovate live account classifies as LIVE.
 *
 * This is no longer labeling-only. `autoTradeVerdict` in
 * `account-trading-policy.ts` refuses to trade a Topstep account that
 * lands on LIVE, per Topstep's TOS ban on automated trading on funded
 * accounts — this function is that hard block's Topstep arm. Falling
 * through to LIVE is therefore the fail-closed answer as well as the
 * honest label: widen a branch above only for a naming pattern Topstep
 * actually uses for evaluation accounts.
 *
 * Takes the classified fields rather than a whole `Account` so the DB
 * adapter can pass an identity rebuilt from persisted columns.
 */
export function classifyAccount(account: Pick<Account, "name" | "practice">): AccountClass {
  if (isPracticeAccount(account)) return "PRAC";
  // Trimmed because whitespace is not part of any account name — this
  // normalises the input, it does not widen the pattern. No token is
  // accepted that was not accepted before; a leading space on a wire name
  // simply stops making all three checks miss at once.
  const upper = account.name.trim().toUpperCase();
  if (upper.startsWith(EXPRESS_FUNDED_PREFIX)) return "XFA";
  if (COMBINE_PREFIX.test(upper)) return "COMBINE";
  return "LIVE";
}
