import type { Account } from "@/lib/brokers/types";
import {
  UNVERIFIED_ACCOUNT_REFUSAL,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";

/**
 * One `/api/accounts` row: the broker's account plus the server's auto-trade
 * verdict for it.
 *
 * **`autoTrade` is the server's answer, never recomputed here.** The route
 * asks `autoTradeVerdictsForAccountIds` — the predicate the deploy routes and
 * the engine ask — after seeding the catalog, so the one refusal the client
 * could never see (an `account_brokers` row the seed failed to write) reaches
 * the chip too (bugs.md A38). A client surface reads this field; it does not
 * call `autoTradeVerdict`.
 */
export interface AccountRow extends Account {
  autoTrade: AutoTradeVerdict;
}

/** What an account the client catalogue does not hold answers: refused, as
 *  the server refuses an account with no catalog row. */
const UNVERIFIED: AutoTradeVerdict = { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL };

/** The verdict for an account the surface may or may not hold a row for. */
export function accountAutoTrade(row: { autoTrade: AutoTradeVerdict } | null | undefined): AutoTradeVerdict {
  return row?.autoTrade ?? UNVERIFIED;
}

/** A wire `autoTrade` narrowed: anything but a well-formed verdict is the
 *  unverified refusal, since a truthy `permitted: 1` must not read permitted. */
export function toVerdict(raw: unknown): AutoTradeVerdict {
  if (typeof raw !== "object" || raw === null) return UNVERIFIED;
  const v = raw as Record<string, unknown>;
  if (v.permitted === true) return { permitted: true };
  if (v.permitted === false && typeof v.reason === "string" && v.reason.trim() !== "") {
    return { permitted: false, reason: v.reason };
  }
  return UNVERIFIED;
}

/**
 * The route's rows with the verdict narrowed. A missing or malformed
 * `autoTrade` reads as refused — a server one deploy behind, or a body that
 * does not parse, must never come out permitted.
 */
export function toAccountRows(raw: readonly unknown[]): AccountRow[] {
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({ ...(r as unknown as Account), autoTrade: toVerdict(r.autoTrade) }));
}
