import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getBook, type Book } from "@/lib/db/books";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { getStrategy } from "@/lib/trading/strategies";
import { announceBookResults, reportBookPlan } from "@/lib/trading/books/reconcile";
import {
  moveCloseRefusal,
  moveUnregisteredRefusal,
  readMovePlan,
  runBookMove,
  type MoveLine,
} from "@/lib/trading/books/move";
import { BOOK_REMOVED_REFUSAL } from "@/lib/trading/books/retire";
import { codeBook } from "@/lib/trading/books/code-books";
import { UNKNOWN_BOOK_REFUSAL } from "@/lib/trading/books/refusals";
import { log } from "@/lib/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET`'s body: what the move would do per playbook, and the refusal if it would be refused. */
export interface MovePreview {
  lines: MoveLine[];
  /** The `POST`'s refusal sentence, verbatim, or null when it would go through. */
  refusal: string | null;
}

type Refused = { status: number; error: string; refusedAccounts?: unknown };

function playbookName(strategyKey: string): string {
  return getStrategy(strategyKey)?.config.name ?? strategyKey;
}

/**
 * Every refusal a move has, in the routes' order: what no edit fixes first
 * (missing, removed, unknown book, the same book), then the account screen —
 * the live-account block and the account-state gate, so a dead or locked
 * account is refused here and *Remove from account* is its move — then the
 * close in flight, which clears by waiting. The `GET` and the `POST` both ask
 * it, so the confirmation cannot promise a move the write refuses.
 */
function refusalFor(book: Book | null, targetKey: string | null): Refused | null {
  if (!book) return { status: 404, error: "Not found" };
  if (book.retiredAt != null) return { status: 409, error: BOOK_REMOVED_REFUSAL };
  if (targetKey == null || codeBook(targetKey) == null) return { status: 404, error: UNKNOWN_BOOK_REFUSAL };
  if (book.bookKey === targetKey) return { status: 400, error: "This account already runs that book." };
  const screen = screenAccountsForAutoTrade([book.accountId]);
  if (screen) return { status: 403, error: screen.message, refusedAccounts: screen.refused };
  const plan = readMovePlan(book, targetKey);
  // Ahead of the close in flight: waiting does not clear it.
  const unregistered = moveUnregisteredRefusal(plan);
  if (unregistered) return { status: 409, error: unregistered };
  const closing = moveCloseRefusal(plan, playbookName);
  if (closing) return { status: 409, error: closing };
  return null;
}

/**
 * GET /api/books/[id]/move?to=<book key> — the confirmation's content: per
 * playbook *keeps*, *stops* (naming a position that *will be closed*) or
 * *starts*, and the refusal the `POST` would answer. Writes nothing.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const to = request.nextUrl.searchParams.get("to");
  const book = getBook(id);
  if (!book) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (to == null || codeBook(to) == null) {
    return NextResponse.json({ error: UNKNOWN_BOOK_REFUSAL }, { status: 404 });
  }

  const refused = refusalFor(book, to);
  const lines = book.retiredAt == null ? readMovePlan(book, to).lines : [];
  const body: MovePreview = { lines, refusal: refused?.error ?? null };
  return NextResponse.json(body);
}

/**
 * POST /api/books/[id]/move `{ to }` — *Move to <book>*, in place and in one
 * transaction (`runBookMove`). Refused whole, before any write, by every
 * refusal above; what the new book drops (*stops*) is never itself a reason
 * to refuse. Reports and announces once, after the transaction committed.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const to = (body as { to?: unknown } | null)?.to;
  const target = typeof to === "string" ? to : null;
  const refused = refusalFor(getBook(id), target);
  if (refused || target == null) {
    const { status, ...rest } = refused ?? { status: 400, error: UNKNOWN_BOOK_REFUSAL };
    return NextResponse.json(rest, { status });
  }

  let moved: ReturnType<typeof runBookMove>;
  try {
    moved = runBookMove(id, target, {
      inPosition: (leg) => getOpenTradeForDeployment(leg.id) != null,
    });
  } catch (err) {
    log.event(
      "db_error",
      "api.books",
      `move book failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Could not move this account to that book." }, { status: 500 });
  }
  // After the commit: a line naming a plan that rolled back would describe
  // something that did not happen.
  reportBookPlan(moved.result.plan);
  await announceBookResults([moved.result]);

  const by = (step: MoveLine["step"]) =>
    moved.lines
      .filter((l) => l.step === step)
      .map((l) => `${l.strategyKey} on ${l.ticker}${l.willClose ? " (position closing)" : ""}`)
      .join(", ") || "none";
  log.event(
    "book_moved",
    "db",
    `Account ${moved.book.accountId}'s book ${id} moved to ${target} — keeps: ${by("keeps")}; ` +
      `stops: ${by("stops")}; starts: ${by("starts")}`,
  );
  return NextResponse.json({ book: moved.book, lines: moved.lines });
}
