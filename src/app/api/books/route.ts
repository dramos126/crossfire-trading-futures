import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { listBookLinks, listBooksWithPlaybooks, listDerivedRows } from "@/lib/db/books";
import {
  autoTradeVerdictsForAccountIds,
  getAccountTradingIdentity,
} from "@/lib/db/account-brokers";
import { UNVERIFIED_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import {
  findConflictingDeployment,
  listGroupLegs,
  sessionForStrategyKey,
} from "@/lib/db/deployments";
import { armedLookup, closingOnTurnOn, type TurnOnState } from "@/lib/trading/books/closing";
import { bookShelf } from "@/lib/trading/books/seed";
import { readAccountGates, type AccountGateWire } from "@/lib/trading/books/account-gates";
import { removeBookRefusal } from "@/lib/trading/books/retire";
import { CODE_BOOKS, codeBook } from "@/lib/trading/books/code-books";
import { isClosingStatus, type Deployment, type TickerSymbol } from "@/lib/trading/domain";
import {
  FULL_RISK_PERCENT,
  PLAYBOOK_RISK_PERCENT_PARAM,
  playbookSizingRefusal,
} from "@/lib/trading/orders/risk-sizer";

/** One cell of an account's line: a playbook on one instrument, on that account. */
export interface BookPlaybookCell {
  ticker: TickerSymbol;
  strategyKey: string;
  /**
   * What runs once the account's switch is on: the account's book carries the
   * cell **and** it is on for this account. The Playbook Deploy picker reads
   * this as *a book on this account also runs this cell*.
   */
  armed: boolean;
  /** The account's book carries the cell. The route always sets it; absent
   *  reads as `armed`, so a fixture may omit it. */
  armedInBook?: boolean;
  /** The account's own switch for the cell. The route always sets it; absent
   *  reads as `armed`. */
  on?: boolean;
  /** The derived row this cell materialised, or `null` when it has none. */
  groupId: string | null;
  /** A hand-made deployment holds the slot and wins; the cell is not pressable. */
  conflict: { deploymentId: string; deploymentName: string | null } | null;
  /**
   * The derived row's parent is enabled and one of its legs is `Active` — the
   * rows' half of the engine's entry condition. The engine's in-memory
   * refusals and the staging allowlist are not read. Armed is what the
   * operator asked for; this is what the rows say. They part when a hand-made
   * holder is deleted and nothing brings the book's copy back
   * ([bugs.md](../../../../docs/bugs.md) A83).
   */
  running: boolean;
  /** The derived row's parent is enabled; false when there is no derived row. */
  parentEnabled: boolean;
  /**
   * A derived leg carries `orphanReason`, and which recovery applies.
   * Off-and-on does not clear the marker; the board's Restore and arm does —
   * but `clearOrphanedAndReEnable` leaves a disabled group disabled, so under
   * one the leg would come back `Active`, untraded, and holding its own slot.
   * The parent has to be turned on by the book's off-and-on first.
   */
  detached: "restore" | "toggle-then-restore" | null;
  /**
   * A derived leg is `Pausing` or `Destroying` (`isClosingStatus`) and still
   * owes a close. `markOrphaned` keeps a closing status, so this can be true of
   * a detached leg. It is `clear-orphan`'s predicate, which writes the leg
   * itself and so refuses both with `RESTORE_WOULD_RETRACT_A_CLOSE`. Wider than
   * the book's on-refusal (`closingOnArm`, `closingOnSwitchOn`), which is
   * `Pausing` alone; on a `Destroying` leg waiting is still the move, because
   * the row is reaped once flat and off-and-on resumes nothing on it.
   */
  closing: boolean;
  /**
   * Turning this cell on for this account would be refused 409 because it
   * would resume a derived leg still `Pausing` (`closingOnTurnOn`, the routes'
   * own predicate). False on a cell that already runs, whose on is not a
   * transition.
   */
  closingOnArm: boolean;
  /**
   * This build registers the cell's playbook. False only on an **armed** cell
   * whose playbook is not registered — a prod build registers only
   * `strategies/prod-playbooks.ts`'s allowlist, and a book armed before that
   * keeps its arming. Drawn so it can be turned off. The route always sets it;
   * only `false` is read, so a fixture may omit it.
   */
  inBuild?: boolean;
  /**
   * The derived row's *Share of account risk* — what its minimum-risk warning
   * scales the account's budget by. 100 with no row or no setting; null when
   * the stored value is one the sizer would refuse, so the grid warns about no
   * guessed figure. The route always sets it; absent reads as 100.
   */
  playbookRiskPercent?: number | null;
}

/** One account running a book: the account's book. */
export interface BookPayload {
  id: string;
  accountId: number;
  /** The code book this account runs, or null when it is not on one (the
   *  migration left it on its own links). The route always sets it; absent
   *  reads as null, so a fixture may omit it. */
  bookKey?: string | null;
  enabled: boolean;
  /**
   * The playbooks whose `Pausing` legs turning this book on would resume — the
   * book switch's 409, by strategy key. Empty on an on book, whose on is not a
   * transition.
   */
  closingOnSwitchOn: string[];
  /**
   * `DELETE /api/books/[id]`'s 409 sentence, or null when *Remove from
   * account* would go through — the route's own predicate. The route always
   * sets it; absent draws no control, so a fixture may omit it.
   */
  removeRefusal?: string | null;
  account: {
    name: string | null;
    broker: "topstep" | "tradovate" | null;
    autoTrade: { permitted: true } | { permitted: false; reason: string };
    /** The account-state gate (dead, locked, Topstep OCO), its auto-bracket
     *  warning and any replacement — null when the catalogue has no row, which
     *  the live-account verdict already refuses. The route always sets it;
     *  absent reads as null, so a fixture may omit it. */
    state?: AccountGateWire | null;
  };
  playbooks: BookPlaybookCell[];
}

/** A book defined in code, as the page draws its card. */
export interface CodeBookPayload {
  key: string;
  name: string;
  cells: Array<{ ticker: TickerSymbol; strategyKey: string; inBuild: boolean }>;
}

/** `GET /api/books`' whole body. `books` is every live account's book;
 *  `codeBooks` every book defined in code; `accounts` every catalogued
 *  account's gate, for the surfaces that offer an account no book row carries
 *  — Deploy a book and the Playbook Deploy picker. */
export interface BooksResponse {
  books: BookPayload[];
  codeBooks: CodeBookPayload[];
  accounts: AccountGateWire[];
}

/**
 * The cells a book not on a code book draws: the shelf over every platform
 * ticker and any ticker it holds a cell on, then any **armed** cell this build
 * does not register, so it can still be turned off.
 */
function drawnCells(
  held: ReadonlyArray<{ ticker: TickerSymbol; strategyKey: string; armed: boolean }>,
): Array<{ ticker: TickerSymbol; strategyKey: string; inBuild: boolean }> {
  return [
    ...bookShelf(held.map((p) => p.ticker)).map((cell) => ({ ...cell, inBuild: true })),
    ...held
      .filter((p) => p.armed && sessionForStrategyKey(p.strategyKey) == null)
      .map((p) => ({ ticker: p.ticker, strategyKey: p.strategyKey, inBuild: false })),
  ];
}

/**
 * Every live account's book with its cells, its derived row ids, its conflict
 * refusals, whether anything runs each cell, and the account fields the grid
 * renders; every code book — one payload, so the grid mounts no second fetch.
 * **It is a read and repairs nothing**: an armed cell nothing runs is
 * reported, not resumed.
 *
 * An account on a code book draws that book's cells, and nothing else — a
 * link for a cell the book does not carry is standing down and has no box. An
 * account not on one draws its shelf, as before books were in code.
 *
 * **The account catalogue is read unfiltered**, through `account_brokers` and
 * the one verdict predicate. The risk cell is deliberately **not** here: it is
 * `boardRisk`'s, over `/api/accounts/risk`, so a copy here would be a second
 * producer of a number the board, Settings and this grid must not disagree about.
 */
export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  // A removed book leaves the page. Its rows stay, readable from the Dashboard.
  const books = listBooksWithPlaybooks().filter((b) => b.retiredAt == null);
  const derived = listDerivedRows();
  const verdicts = autoTradeVerdictsForAccountIds(books.map((b) => b.accountId));
  const derivedFor = new Map(derived.map((r) => [`${r.bookId} ${r.ticker} ${r.strategyKey}`, r]));
  const gates = readAccountGates();
  const gateFor = new Map(gates.map((g) => [g.accountId, g]));

  const payload: BookPayload[] = books.map((book) => {
    // The map answers for every id it was asked about, through the one
    // predicate — an account with no catalogue row lands on
    // `UNVERIFIED_ACCOUNT_REFUSAL` inside `autoTradeVerdict`. The `??` is the
    // type's, not a second refusal, so it says the same sentence.
    const verdict = verdicts.get(book.accountId) ?? {
      permitted: false as const,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    };
    const identity = getAccountTradingIdentity(book.accountId);
    const armedFor = armedLookup(book.playbooks);
    const onBook = codeBook(book.bookKey);
    const links = listBookLinks(book.id);
    const onFor = (cell: { ticker: TickerSymbol; strategyKey: string }): boolean =>
      links.find((l) => l.ticker === cell.ticker && l.strategyKey === cell.strategyKey)?.on ?? true;
    const legsOf = new Map<string, Deployment[]>();
    const legsFor = (groupId: string): Deployment[] => {
      const cached = legsOf.get(groupId);
      if (cached) return cached;
      const legs = listGroupLegs(groupId);
      legsOf.set(groupId, legs);
      return legs;
    };
    const turnOn: TurnOnState = {
      bookEnabled: book.enabled,
      armed: armedFor,
      derived: derived.filter((r) => r.bookId === book.id),
      legStatuses: (groupId) => legsFor(groupId).map((l) => l.status),
    };
    const cells =
      onBook == null
        ? drawnCells(book.playbooks)
        : onBook.cells.map((c) => ({ ...c, inBuild: sessionForStrategyKey(c.strategyKey) != null }));

    return {
      id: book.id,
      accountId: book.accountId,
      bookKey: book.bookKey,
      enabled: book.enabled,
      closingOnSwitchOn: book.enabled ? [] : closingOnTurnOn(turnOn, {}),
      removeRefusal: removeBookRefusal(book, derived),
      account: {
        name: identity?.name ?? null,
        broker: identity?.broker ?? null,
        autoTrade: verdict,
        state: gateFor.get(book.accountId) ?? null,
      },
      playbooks: cells.map((cell) => {
        const { ticker, strategyKey, inBuild } = cell;
        const row = derivedFor.get(`${book.id} ${ticker} ${strategyKey}`) ?? null;
        const legs = row ? legsFor(row.groupId) : [];
        const armed = armedFor(cell);
        return {
          ticker,
          strategyKey,
          armed,
          armedInBook: onBook == null ? armed : true,
          on: onBook == null ? armed : onFor(cell),
          groupId: row?.groupId ?? null,
          // Asked wherever materialisation is the next thing that could
          // happen, which is a cell with no derived row **and** one whose row
          // is stood down: a hand-made deployment can take the slot while the
          // playbook is off, and the resume is refused on it, so the grid has
          // to be able to say so before the operator presses. A *live* derived
          // row is not asked, because its own leg is an `Active` row on the
          // same triple and would report as its own holder; a refused account
          // renders no cells at all.
          conflict:
            (row == null || !row.enabled) && verdict.permitted
              ? holderOf(book.accountId, ticker, strategyKey)
              : null,
          // Read from the rows, never from the event that led here, so every
          // route into "armed and nothing runs it" reads the same way.
          running: row != null && row.enabled && legs.some((l) => l.status === "Active"),
          parentEnabled: row?.enabled ?? false,
          detached: legs.some((l) => l.orphanReason != null)
            ? row?.enabled
              ? "restore"
              : "toggle-then-restore"
            : null,
          closing: legs.some((l) => isClosingStatus(l.status)),
          closingOnArm: !armed && closingOnTurnOn(turnOn, { cell }).length > 0,
          inBuild,
          // A leg's `paramValues` are its parent's, so any leg answers.
          playbookRiskPercent: playbookRiskPercentOf(legs[0]?.paramValues ?? {}),
        };
      }),
    };
  });

  const codeBooks: CodeBookPayload[] = CODE_BOOKS.map((b) => ({
    key: b.key,
    name: b.name,
    cells: b.cells.map((c) => ({ ...c, inBuild: sessionForStrategyKey(c.strategyKey) != null })),
  }));

  const body: BooksResponse = { books: payload, codeBooks, accounts: gates };
  return NextResponse.json(body);
}

function playbookRiskPercentOf(params: Readonly<Record<string, unknown>>): number | null {
  const value = params[PLAYBOOK_RISK_PERCENT_PARAM];
  if (value === undefined) return FULL_RISK_PERCENT;
  return playbookSizingRefusal({ [PLAYBOOK_RISK_PERCENT_PARAM]: value }) == null ? (value as number) : null;
}

/** The same check the reconciler runs before it materialises, read-only. */
function holderOf(
  accountId: number,
  ticker: TickerSymbol,
  strategyKey: string,
): { deploymentId: string; deploymentName: string | null } | null {
  const session = sessionForStrategyKey(strategyKey);
  if (!session) return null;
  const holder = findConflictingDeployment(accountId, ticker, strategyKey, session);
  return holder ? { deploymentId: holder.id, deploymentName: holder.name } : null;
}
