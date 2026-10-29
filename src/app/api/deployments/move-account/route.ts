import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  carryRiskSettings,
  getAccountRiskSettings,
  logAccountRiskChange,
  screenAccountsForAutoTrade,
  type CarriedRiskSettings,
} from "@/lib/db/account-brokers";
import { getBookByAccount, listBooks, listDerivedRows, setBookAccount } from "@/lib/db/books";
import { getDb } from "@/lib/db/connection";
import {
  clearOrphaned,
  listDeployments,
  updateDeployment,
} from "@/lib/db/deployments";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { readAccountGates } from "@/lib/trading/books/account-gates";
import { runBookReconcileAndAnnounce } from "@/lib/trading/books/reconcile";
import { isClosingStatus } from "@/lib/trading/domain";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import {
  MOVE_DID_NOT_LAND,
  MOVE_NEEDS_A_DEAD_ACCOUNT,
  MOVE_TARGET_NOT_A_REPLACEMENT,
  MOVE_WAITS_FOR_OPEN_TRADE,
} from "@/lib/trading/broker-access/account-state-gate";

const handle = engineHandle();

/**
 * *Move to replacement*: re-point everything on a dead account — its live book
 * and every deployment leg not soft-deleted, except a removed book's — onto a
 * new account on the same program. One press, by the operator, never automatic.
 *
 * **Every refusal is decided before any write**, in the order a fix exists:
 * the new account's deploy screen (the live-account block, then the
 * account-state gate — the same screen every create runs), then the pairing
 * (`readAccountGates` names the old account dead and this one among its
 * replacements: `ok`, same `templateId` and starting balance, unused), then
 * anything still open on the old account.
 *
 * **A leg with an open trade row or a close in flight refuses the whole move.**
 * The closing guard flattens whatever account a row names, so moving a row
 * that still owes a close would leave the old position unmanaged — the reason
 * `PATCH /api/deployments/[id]` refuses a move off anything but a settled
 * `Paused` leg. Here the trade row stands in for "settled": the old account is
 * dead, so nothing new can open on it, and a leg with no open trade has nothing
 * to close. Each leg keeps its status, so an `Active` one is `Active` on the
 * new account — the operator's own arming, carried over, as a book's on does.
 * Orphan markers are cleared: they named the old account. **A leg the status
 * check orphan-paused under a book that is on, on a playbook that is on, comes
 * back `Active`**: it was running when its account went missing, the new
 * account has passed the whole deploy screen above, and left `Paused` it is a
 * stood-down row in an on book that nothing resumes and nothing names.
 *
 * The operator's risk settings come along where the new account has none
 * (`carryRiskSettings`) — otherwise every `Active` leg's entry throws in the
 * sizer — but never the maximum loss limit or starting balance, which a reset
 * changes and the Risk prefill suggests.
 *
 * The writes are one transaction. Then the book reconciler runs (an armed
 * cell with no row now materialises on an account that passes), and the
 * route owes the sync and the `deploymentsChanged` every binding mutation does.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input = body as { fromAccountId?: unknown; toAccountId?: unknown };
  if (typeof input?.fromAccountId !== "number" || typeof input?.toAccountId !== "number") {
    return NextResponse.json(
      { error: "A move names fromAccountId and toAccountId." },
      { status: 400 },
    );
  }
  const from = input.fromAccountId;
  const to = input.toAccountId;

  const refusal = screenAccountsForAutoTrade([to]);
  if (refusal) return NextResponse.json({ error: refusal.message }, { status: 403 });

  const gate = readAccountGates().find((g) => g.accountId === from);
  if (gate?.refusal?.kind !== "dead") {
    return NextResponse.json({ error: MOVE_NEEDS_A_DEAD_ACCOUNT }, { status: 409 });
  }
  if (!gate.replacements.some((r) => r.accountId === to)) {
    return NextResponse.json({ error: MOVE_TARGET_NOT_A_REPLACEMENT }, { status: 409 });
  }

  // A removed book's legs stay on the dead account: they are history, and moved
  // they would sit on the new account while a re-added book's slot check asks
  // about the old one — two Active rows on one slot once it is switched back on.
  const derived = listDerivedRows();
  const retiredBooks = new Set(listBooks().filter((b) => b.retiredAt != null).map((b) => b.id));
  const retiredGroups = new Set(
    derived.filter((row) => retiredBooks.has(row.bookId)).map((row) => row.groupId),
  );
  const legs = listDeployments().filter(
    (d) => d.accountId === from && !retiredGroups.has(d.groupId),
  );
  if (legs.some((d) => isClosingStatus(d.status) || getOpenTradeForDeployment(d.id) != null)) {
    return NextResponse.json({ error: MOVE_WAITS_FOR_OPEN_TRADE }, { status: 409 });
  }
  const book = getBookByAccount(from);
  const runningParents = new Set(
    book?.enabled
      ? derived
          .filter((row) => row.bookId === book.id && row.enabled)
          .map((row) => row.groupId)
      : [],
  );
  const resumed = legs
    .filter((leg) => leg.orphanReason != null && runningParents.has(leg.groupId))
    .map((leg) => leg.id);

  let carried: CarriedRiskSettings | null = null;
  const targetBefore = getAccountRiskSettings(to);
  // A throw rolls every write back — the target gaining a book since the pairing
  // was read hits `setBookAccount`'s unique index after the legs have moved.
  try {
    getDb().transaction(() => {
      for (const leg of legs) {
        updateDeployment(
          leg.id,
          resumed.includes(leg.id) ? { accountId: to, status: "Active" } : { accountId: to },
        );
        if (leg.orphanReason != null) clearOrphaned(leg.id);
      }
      carried = carryRiskSettings(from, to);
      if (book) setBookAccount(book.id, to);
    })();
  } catch (err) {
    return NextResponse.json(
      { error: MOVE_DID_NOT_LAND, detail: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }

  logAccountRiskChange(to, targetBefore, "carried over by Move to replacement");
  await runBookReconcileAndAnnounce({ inPosition: (leg) => getOpenTradeForDeployment(leg.id) != null });
  await handle.syncIfRunning();
  await handle.emitDeploymentsChanged();

  return NextResponse.json({
    moved: { legs: legs.map((d) => d.id), resumed, bookId: book?.id ?? null, carried },
  });
}
