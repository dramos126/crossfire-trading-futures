import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getBook, retireBook, setBookEnabled } from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { runBookReconcileAndAnnounce, type BookScope } from "@/lib/trading/books/reconcile";
import { turnOnCloseRefusal } from "@/lib/trading/books/closing";
import { BOOK_REMOVED_REFUSAL, removeBookRefusal } from "@/lib/trading/books/retire";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The book switch reaches the engine and the browser, whatever the caller sees.
 *
 * `runBookReconcileAndAnnounce` owns the sync, the emit and the nudge, and fires none of
 * them on an inert plan; the gates above it have mutated nothing and return a
 * plain `NextResponse`. `resumed` is what makes an off→on a *transition*: the
 * plan is never computed from resting state, so without it a book turned back
 * on would leave its stood-down rows `Paused`.
 */
async function respondSynced(
  body: unknown,
  opts: { resumed?: readonly BookScope[]; status?: number } = {},
): Promise<NextResponse> {
  await runBookReconcileAndAnnounce({
    inPosition: (leg) => getOpenTradeForDeployment(leg.id) != null,
    resumed: opts.resumed,
  });
  return NextResponse.json(body, opts.status == null ? undefined : { status: opts.status });
}

/**
 * The body sets the switch and nothing else. The name belongs to the shared
 * book (`PATCH /api/books/shared/[id]`), which every account running it shares.
 */
const BOOK_PATCH_SHAPE = "A book patch sets `enabled`.";

/**
 * PATCH /api/books/[id] — the account's own switch for the book it runs,
 * which cascades to every playbook armed in the book and on for the account.
 *
 * A body that is not a transition writes nothing and announces nothing: a frame
 * is a claim that the deployment set changed, and re-sending `enabled: true` is
 * not one. The live-account screen runs on the `false → true` transition only —
 * the same scope `PATCH /api/groups/[id]` uses for its 0→1 enable, and the same
 * reason the grid's refusal ground carries `&& !enabled`: a book on an account
 * that has since been classified live must still be turnable **off**, or the
 * refusal becomes the hazard on the wind-down path.
 *
 * An off → on that would resume a derived leg still `Pausing`/`Destroying` is
 * refused whole (409, `turnOnWouldRetractACloseRefusal`): no partial resume, and
 * the off direction is never refused, because it is the wind-down.
 *
 * A refused book is **not** auto-disabled. The operator's switch is the
 * operator's, the refusal is the platform's, and the reconciler materialises
 * nothing for it either way.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body == null) {
    return NextResponse.json({ error: BOOK_PATCH_SHAPE }, { status: 400 });
  }
  const patch = body as { enabled?: unknown };
  if (typeof patch.enabled !== "boolean") {
    return NextResponse.json({ error: BOOK_PATCH_SHAPE }, { status: 400 });
  }
  const enabled = patch.enabled;

  const existing = getBook(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.enabled === enabled) return NextResponse.json({ book: existing });

  // A removed book is off, so only the on reaches here. It would read ON over a
  // book the reconciler skips; the off is never refused.
  if (enabled && existing.retiredAt != null) {
    return NextResponse.json({ error: BOOK_REMOVED_REFUSAL }, { status: 409 });
  }

  if (enabled) {
    const refusal = screenAccountsForAutoTrade([existing.accountId]);
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, refusedAccounts: refusal.refused },
        { status: 403 },
      );
    }
  }

  // After the live-account screen, which never clears by waiting and so must
  // not hide behind a refusal that says to wait. Decided before any write: a
  // refused switch leaves the book, its cells and every row as they were.
  if (enabled) {
    const closing = turnOnCloseRefusal(existing, {});
    if (closing) return NextResponse.json({ error: closing }, { status: 409 });
  }

  const updated = setBookEnabled(id, enabled);
  if (!updated) return respondSynced({ error: "Toggle failed" }, { status: 500 });

  return respondSynced({ book: updated }, { resumed: enabled ? [{ bookId: id }] : [] });
}

/**
 * DELETE /api/books/[id] — *Remove from account*. **Writes a stamp, not a
 * delete**: `retired_at` on the book, and nothing else. The derived rows stay
 * `Paused` and keep their `book_id`, so every derived-row refusal still holds
 * on them and `strategy_trades.deployment_id` still points at their legs.
 *
 * Refused (409, `REMOVE_BOOK_REFUSAL`) unless the book is off and every derived
 * leg is settled `Paused` with no open trade row. **The live-account block and
 * the account-state gate are not asked**: a remove only winds down, like off,
 * and the account it is most often pressed on is dead.
 *
 * It owes no sync and no `deploymentsChanged`: no deployment row is written,
 * and the Dashboard already leaves the off book's card out. A repeat on a book
 * already removed answers it unchanged, so a retried press is not an error.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  const existing = getBook(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.retiredAt != null) return NextResponse.json({ book: existing });

  const refusal = removeBookRefusal(existing);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  const retired = retireBook(id);
  if (!retired) return NextResponse.json({ error: "Could not remove this book." }, { status: 500 });
  return NextResponse.json({ book: retired });
}
