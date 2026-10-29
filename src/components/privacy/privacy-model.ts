/**
 * Display privacy: account IDs read `Account 1, 2, 3…` and balances read
 * `$xx,xxx.xx`, so a screen can be shared. A screenshot shield, not a
 * permission — nothing server-side changes and P&L is never masked.
 */

import { truncatedAccount } from "@/lib/logging/scrub";

/** localStorage keys, beside the `trading_*` keys in `account-selection.ts`. */
export const HIDE_ACCOUNT_IDS_KEY = "display_hide_account_ids";
export const HIDE_BALANCES_KEY = "display_hide_balances";

export const MASKED_USD = "$xx,xxx.xx";

/** What an account the catalogue does not name reads as while IDs are hidden — never its raw name. */
export const UNKNOWN_ACCOUNT_ALIAS = "Account ?";

const ALIAS_PREFIX = "Account";

export interface AccountAliases {
  /** Alias by account name and by `String(id)`. */
  readonly byKey: ReadonlyMap<string, string>;
  /** One pattern over every name (longest first) and every id as a whole token; null when there are none. */
  readonly pattern: RegExp | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Numbers the **full** catalogue by ascending id, so an account keeps its
 * number whatever the practice filter shows and however the API orders the
 * list.
 */
export function accountAliases(accounts: ReadonlyArray<{ id: number; name: string }>): AccountAliases {
  const sorted = [...accounts].sort((a, b) => a.id - b.id);
  const byKey = new Map<string, string>();
  sorted.forEach((a, i) => {
    const alias = `${ALIAS_PREFIX} ${i + 1}`;
    byKey.set(String(a.id), alias);
    byKey.set(truncatedAccount(a.id), alias);
    if (a.name) byKey.set(a.name, alias);
  });
  // Longest name first, so a name that is a prefix of another cannot match
  // first and leave the longer one's tail on screen. One alternation, one
  // pass, so an alias just written (`Account 1`) is never re-scanned for an id.
  const names = sorted.map((a) => a.name).filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  // An id is a whole token only when no word character, decimal point,
  // thousands comma, `$` or sign touches it — `21345` is not an id inside
  // `21345.25` or `$21,345` — and never an alias's own number, so masking
  // text twice leaves it as it was.
  const ids = sorted.map((a) => `(?<![\\w.,$-])(?<!${ALIAS_PREFIX} )${a.id}(?!\\w|[.,]\\d)`);
  // The log pipe's one rendering of an account number is `…{last4}`
  // (`scrubDisplay`), which a whole-id token can never match; two accounts
  // sharing a tail are ambiguous, so the tail resolves only when it is one
  // account's.
  const tails = sorted.map((a) => truncatedAccount(a.id)).filter((t, _, all) => all.indexOf(t) === all.lastIndexOf(t));
  const parts = [...names.map(escapeRegExp), ...ids, ...tails.map((t) => `${escapeRegExp(t)}(?!\\d)`)];
  return { byKey, pattern: parts.length > 0 ? new RegExp(parts.join("|"), "g") : null };
}

/** A bare account name or id: its alias when on, unchanged when off, `Account ?` when on and unknown. */
export function maskAccountName(name: string | null | undefined, aliases: AccountAliases, on: boolean): string {
  if (!on) return name ?? "";
  if (name == null) return UNKNOWN_ACCOUNT_ALIAS;
  return aliases.byKey.get(name) ?? UNKNOWN_ACCOUNT_ALIAS;
}

/** Free text that may embed account names or ids — log lines, titles, aria-labels, sentences. */
export function maskText(text: string, aliases: AccountAliases, on: boolean): string {
  if (!on || aliases.pattern == null) return text;
  return text.replace(aliases.pattern, (m) => aliases.byKey.get(m) ?? UNKNOWN_ACCOUNT_ALIAS);
}

// Thousands groups are matched as groups, so a comma that follows the figure
// (`$50,750, at or below`) is punctuation and stays.
const USD_FIGURE = /-?\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

/**
 * Masks **every** `$` figure in the string. Only for balance-derived sentences
 * — a P&L string must never be passed to it; the call sites are pinned by a
 * source scan in `privacy-model.test.ts`.
 */
export function maskUsdFigures(text: string, on: boolean): string {
  return on ? text.replace(USD_FIGURE, MASKED_USD) : text;
}
