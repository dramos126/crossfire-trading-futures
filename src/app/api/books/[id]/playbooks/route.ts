import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getBook, listBookLinks, listDerivedRows, setAccountCellOn } from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { sessionForStrategyKey } from "@/lib/db/deployments";
import {
  daySessionRefusalForStrategyKey,
  instrumentRefusalForStrategyKey,
} from "@/lib/trading/strategies";
import { runBookReconcileAndAnnounce, type BookScope } from "@/lib/trading/books/reconcile";
import { turnOnCloseRefusal } from "@/lib/trading/books/closing";
import { BOOK_REMOVED_REFUSAL } from "@/lib/trading/books/retire";
import { bookShelf, offShelfRefusal } from "@/lib/trading/books/seed";
import { CELL_NOT_IN_BOOK_REFUSAL } from "@/lib/trading/books/refusals";
import { bookCarries, codeBook } from "@/lib/trading/books/code-books";
import { TICKER_OPTIONS, type TickerSymbol } from "@/lib/trading/domain";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The cell's write reaches the engine and the browser. See the book PATCH. */
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
 * PATCH /api/books/[id]/playbooks — one cell **on this account**,
 * `{ ticker, strategyKey, on }`. A cell runs on an account only when the
 * account's book carries it and it is on here; this writes the second half.
 *
 * The three 400s are the deploy routes' own sentences, verbatim and in the same
 * order: an unregistered key declares no window to check, and the other two
 * answer `null` for one, so it is asked first.
 *
 * All three, and the live-account screen above them, run on an **on** only.
 * Off is the operator's wind-down path and is never refused — the same
 * carve-out the grid's refusal ground and the book switch carry, and it is
 * load-bearing here rather than tidy: a module that changed its `calibratedFor`
 * or its day-session declaration after the cell was armed would otherwise leave
 * a materialised row with no control that can turn it off.
 *
 * One more follows them, on an on only: on a code book, a 409 for a cell the
 * book does not carry (`CELL_NOT_IN_BOOK_REFUSAL`) — it would run nothing, and
 * a book's cells change only in code; on a book not on one, a 400 for a cell
 * `bookShelf` does not carry.
 *
 * A body that is not a transition writes nothing and announces nothing — save
 * an on over a cell already on whose derived row is stood down under an on
 * book, which resumes that row.
 *
 * An on that would resume this cell's derived leg while it is still `Pausing`
 * 409s — `enableGroupAndRestore` would write it back to `Active` and drop the
 * close. Off is never refused.
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
  const patch = body as { ticker?: unknown; strategyKey?: unknown; on?: unknown };
  if (
    !isTickerSymbol(patch?.ticker) ||
    typeof patch?.strategyKey !== "string" ||
    typeof patch?.on !== "boolean"
  ) {
    return NextResponse.json(
      { error: "A playbook patch names a ticker and a strategyKey and sets `on`." },
      { status: 400 },
    );
  }
  const { ticker, strategyKey, on } = patch;
  const cell = { ticker, strategyKey };

  const book = getBook(id);
  if (!book) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (on) {
    // First: the book is no longer on its account, which no other answer fixes.
    if (book.retiredAt != null) {
      return NextResponse.json({ error: BOOK_REMOVED_REFUSAL }, { status: 409 });
    }
    const refusal = screenAccountsForAutoTrade([book.accountId]);
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, refusedAccounts: refusal.refused },
        { status: 403 },
      );
    }

    if (!sessionForStrategyKey(strategyKey)) {
      return NextResponse.json(
        { error: `Strategy ${strategyKey} is not registered, so it declares no session.` },
        { status: 400 },
      );
    }
    // On the cell's ticker: the book spans instruments, the cell is one.
    const instrumentError = instrumentRefusalForStrategyKey(strategyKey, ticker);
    if (instrumentError) return NextResponse.json({ error: instrumentError }, { status: 400 });
    const daySessionError = daySessionRefusalForStrategyKey(strategyKey, ticker);
    if (daySessionError) return NextResponse.json({ error: daySessionError }, { status: 400 });
  }

  const links = listBookLinks(id);
  const onBook = codeBook(book.bookKey);
  // After the three 400s, which say *why* more precisely when one applies: on a
  // code book, the book is the authority on which cells exist; on a book not
  // on one, the shelf the grid draws is.
  if (on && book.bookKey != null && (onBook == null || !bookCarries(onBook, cell))) {
    return NextResponse.json({ error: CELL_NOT_IN_BOOK_REFUSAL }, { status: 409 });
  }
  if (
    on &&
    book.bookKey == null &&
    !bookShelf(links.map((l) => l.ticker)).some((c) => c.ticker === ticker && c.strategyKey === strategyKey)
  ) {
    return NextResponse.json({ error: offShelfRefusal(ticker) }, { status: 400 });
  }

  // An absent row reads as the grid renders it: on, for a cell the account's
  // code book carries; off, otherwise. Without that, a press that matched it
  // wrote a row and announced a transition that did not happen.
  const current = links.find((l) => l.ticker === ticker && l.strategyKey === strategyKey);
  const carried = onBook != null && bookCarries(onBook, cell);
  const reads = current?.on ?? carried;
  // One exception: an on over a cell already on whose derived row is stood
  // down under an on book is a resume of that row, not a no-op — the switch
  // reads on, so off-and-on would otherwise be the only way to start it.
  const resumesRow =
    on &&
    book.enabled &&
    listDerivedRows().some(
      (r) => r.bookId === id && r.ticker === ticker && r.strategyKey === strategyKey && !r.enabled,
    );
  if (reads === on && !resumesRow) {
    return NextResponse.json({ book, link: current ?? null });
  }

  // Last of the refusals and before the write: the live-account 403 and the
  // 400s never clear by waiting, so they answer first.
  if (on) {
    const closing = turnOnCloseRefusal(book, { cell });
    if (closing) return NextResponse.json({ error: closing }, { status: 409 });
  }

  const link = setAccountCellOn(id, ticker, strategyKey, on);

  return respondSynced({ book, link }, { resumed: on ? [{ bookId: id, cell }] : [] });
}

function isTickerSymbol(value: unknown): value is TickerSymbol {
  return TICKER_OPTIONS.some((option) => option.symbol === value);
}
