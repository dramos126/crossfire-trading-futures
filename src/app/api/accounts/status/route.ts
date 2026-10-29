import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { listAccountBalances } from "@/lib/db/account-brokers";
import { readAccountGates, type AccountGateWire } from "@/lib/trading/books/account-gates";

const handle = engineHandle();

/** One catalogued account as the Dashboard's book card reads it. */
export interface AccountStatusWire {
  accountId: number;
  broker: "topstep" | "tradovate" | "unknown";
  /** The broker search's last balance; null is unknown. */
  balanceUsd: number | null;
  /** When the search that reported `balanceUsd` answered. */
  balanceAt: string | null;
  /** When the account's status was last answered. */
  checkedAt: string | null;
  /** The account-state gate's refusal, as `readAccountGates` answers it. */
  refusal: AccountGateWire["refusal"];
}

/**
 * What the account-status check last stored, per account: the balance and its
 * stamp, and the account-state gate's verdict — `readAccountGates`' own, so no
 * surface derives a second one. Reads storage only; it never asks a broker.
 * A failed check shows here as an old stamp, not as a missing row.
 */
export function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  const gates = new Map(readAccountGates().map((g) => [g.accountId, g.refusal]));
  const accounts: AccountStatusWire[] = listAccountBalances().map((b) => ({
    accountId: b.accountId,
    broker: b.broker,
    balanceUsd: b.balanceUsd,
    balanceAt: b.balanceAt,
    checkedAt: b.checkedAt,
    refusal: gates.get(b.accountId) ?? null,
  }));
  return NextResponse.json({ accounts });
}

/**
 * Check every configured broker now for which accounts are still active, and
 * record the answer on `account_brokers` — the Settings page, the Books screen
 * and the Playbook Deploy picker each fire this once when they open, and
 * re-read what they show after it settles. The Dashboard does not: it reads
 * `GET` only.
 *
 * It goes through the engine's own check rather than a fan-out of its own, so
 * the page and the daily job are one implementation with one notion of "a
 * broker answered", and a call that lands while a check is running joins it.
 * **A broker that did not answer writes nothing**, so a failure here leaves
 * every account on the status it had: the answer carries `failed` for the page
 * to say so, with HTTP 200, and only a check that threw outright is a 502.
 */
export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await handle.checkAccountStatuses());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Account status check failed" },
      { status: 502 },
    );
  }
}
