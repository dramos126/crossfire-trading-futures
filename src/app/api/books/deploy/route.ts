import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  getBookByAccount,
  getRetiredBookFor,
  insertBook,
  setAccountCellOn,
  unretireBook,
  type Book,
} from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { getDb } from "@/lib/db/connection";
import { codeBook } from "@/lib/trading/books/code-books";
import { accountHasBookRefusal, UNKNOWN_BOOK_REFUSAL } from "@/lib/trading/books/refusals";
import { log } from "@/lib/logger";

/** The book an account already runs, by its name. */
function alreadyRuns(existing: Book, targetName: string): NextResponse {
  const current = codeBook(existing.bookKey)?.name ?? "a book";
  return NextResponse.json(
    { error: accountHasBookRefusal(current, targetName), book: existing },
    { status: 409 },
  );
}

/**
 * POST /api/books/deploy `{ book, accountId }` — *Deploy to account*: put a
 * code book on an account.
 *
 * Screened through `screenAccountsForAutoTrade` first, whatever the book —
 * the live-account block refuses a funded Topstep account like any other, and
 * a book reaches no gate of its own. Then one live book per account: an
 * account running a book answers 409 naming *Move to*, and a create that raced
 * the read throws on the partial index and gets the same sentence.
 *
 * **It writes the account's book off, and touches nothing that trades**
 * (operator, 2026-10-19): the account's own switch is the press that starts
 * it, under the account screen and the close-in-flight refusal. A new book's
 * every playbook is on for the account; an account this book was removed from
 * gets that row back instead, with its own switches as they were. No row is
 * created, so nothing reconciles and nothing is announced.
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
  const input = body as { book?: unknown; accountId?: unknown } | null;
  if (typeof input?.accountId !== "number" || typeof input?.book !== "string") {
    return NextResponse.json({ error: "A deploy names a book and an accountId." }, { status: 400 });
  }
  const accountId = input.accountId;
  const book = codeBook(input.book);
  if (!book) return NextResponse.json({ error: UNKNOWN_BOOK_REFUSAL }, { status: 404 });

  // The live-account block and then the account-state gate, first: a refusal
  // no rearranging of the payload fixes belongs above the ones that can be
  // answered by editing it.
  const refusal = screenAccountsForAutoTrade([accountId]);
  if (refusal) {
    return NextResponse.json({ error: refusal.message, refusedAccounts: refusal.refused }, { status: 403 });
  }

  const existing = getBookByAccount(accountId);
  if (existing) return alreadyRuns(existing, book.name);

  let deployed: { book: Book; restored: boolean };
  try {
    deployed = getDb().transaction(() => {
      const retired = getRetiredBookFor(accountId, book.key);
      const back = retired ? unretireBook(retired.id) : null;
      if (back) return { book: back, restored: true };
      const created = insertBook({ accountId, enabled: false, bookKey: book.key });
      for (const cell of book.cells) setAccountCellOn(created.id, cell.ticker, cell.strategyKey, true);
      return { book: created, restored: false };
    })();
  } catch (err) {
    // Asked of the database, not read off the driver's message: a row that is
    // there now is the raced duplicate; anything else is a write that failed.
    const raced = getBookByAccount(accountId);
    if (raced) return alreadyRuns(raced, book.name);
    log.event(
      "db_error",
      "api.books",
      `deploy book failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Could not deploy this book." }, { status: 500 });
  }

  return NextResponse.json(
    deployed.restored ? { book: deployed.book, restored: true } : { book: deployed.book },
  );
}
