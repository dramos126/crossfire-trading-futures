/**
 * What `/books` shows, and which of its controls may be pressed — the pure
 * half.
 *
 * Eleventh pure module on the `deployment-status.ts` / `trade-markers.ts` /
 * `board-model.ts` / `board-view.ts` pattern, and it exists for the reason
 * `board-view.ts` does: every decision below compiles, renders and lies if it
 * is written in JSX. A cell that says a playbook *is running* on a book whose
 * switch is off, a held box that can be pressed into a write the reconciler will
 * refuse, a risk figure on a row the live-account block refuses — each is one
 * ternary in a component and none of them is visible in a screenshot.
 *
 * **One section per book, one card per account running it.** A book is
 * defined in code — a name and its playbooks. Each account's card carries that
 * account's own switch, risk, stamps and on/off per playbook — a playbook runs
 * on an account only when its book carries it **and** it is on for that
 * account. Accounts not on a book are grouped in a section of their own.
 *
 * **It renders nothing and it decides nothing about arming.** The refusals it
 * can state are all read back off the payload (`GET /api/books` carries the
 * verdict, the account-state gate, the conflict and the close-in-flight
 * answers); this module never derives one. `autoTradeVerdict` is not called
 * here and must not be — the route already asked the one predicate, and a
 * second reader on the client would be a second predicate wearing a rendering
 * hat ([brokers/README.md](../../../docs/modules/brokers/README.md)).
 *
 * **Two fields the payload deliberately does not carry** are joined here
 * instead: a playbook's display name and shelf label, read from the
 * client-side registry the way `playbook-detail-model.ts` reads it, and the
 * account's per-entry risk budget, read through `boardRisk` so the grid, the
 * board and Settings cannot disagree about which ending an account is in.
 */

import type { BookPayload, BookPlaybookCell, CodeBookPayload } from "@/app/api/books/route";
import type { MoveLine } from "@/lib/trading/books/move";
import { accountHasBookRefusal } from "@/lib/trading/books/refusals";
import type { DeployAccountRow } from "@/components/playbook/playbook-deploy-model";
import { contractLabel, type BoardLegRisk } from "@/components/board/board-model";
import { DETACHED_RECOVER_LABEL } from "@/components/board/board-view";
import { splitAccountName } from "@/components/deployment/deployment-detail-model";
import { minimumRiskNotice, type MinimumRisk } from "@/components/playbook/playbook-minimum-risk";
import { FULL_RISK_PERCENT } from "@/lib/trading/orders/risk-sizer";
import {
  RESTORE_WOULD_RETRACT_A_CLOSE,
  turnOnWouldRetractACloseRefusal,
  type TickerSymbol,
} from "@/lib/trading/domain";
import type { StrategyIntent } from "@/lib/trading/strategy-types";
import { PLAYBOOK_NOT_IN_BUILD } from "@/lib/trading/strategies/prod-playbooks";
import { MIGRATION_BOOK_KEY, bookNotInBuild } from "@/lib/trading/books/code-books";

// ── Copy ────────────────────────────────────────────────────────────────

/** The stamp on an `unavailable` cell, in the `held` / `idle` stamp's shape. */
export const BOOK_CELL_NOT_IN_BUILD_STAMP = "not in build";

export const BOOKS_SUBTITLE =
  "A book is a set of playbooks the platform defines. Deploy one to an account, then switch " +
  "it on there; every account keeps its own switch, risk and playbook choices.";

/** No book in this build: the page has no card to draw. */
export const BOOKS_EMPTY = "This build of the platform defines no books.";

/** A book or a line with no playbook to draw. */
export const BOOK_NO_PLAYBOOKS = "No playbook in this book can run in this build.";

/** A book no account runs: its section draws the empty card. */
export const BOOK_NO_ACCOUNTS = "No account runs this book yet.";

/** The section of accounts not on a book, and what it says. */
export const UNBOOKED_TITLE = "Not on a book";

/**
 * The switch's title on an account not on a book, while it is off: the page
 * does not switch it on, and the sentence names the move that puts it on one.
 * An on switch keeps its ordinary title, since turning it off is the wind-down.
 */
export function unbookedSwitchTitle(books: readonly string[]): string {
  return (
    "This account is not on a book, so it is not switched on here. Use " +
    `${books.map(moveToLabel).join(" or ")} in its actions to put it on one.`
  );
}

/**
 * What the card of accounts not on a book says, per reason an account is
 * there — each sentence only when one of its accounts is. `migrationBook` is
 * the name of the book the one-time migration put accounts on; `books` every
 * book's name, all from code; `registered` the books this build registers.
 */
export function unbookedNote(
  accounts: ReadonlyArray<Pick<BookGridRow, "bookKey">>,
  migrationBook: string,
  books: readonly string[],
  registered: ReadonlyArray<Pick<CodeBookPayload, "key">>,
): string {
  const parts: string[] = [];
  if (accounts.some((a) => a.bookKey == null)) {
    parts.push(
      "These accounts kept the playbooks they had before books were set by the platform, because " +
        `one of them is on and no book includes it. Use ${moveToLabel(migrationBook)} in an account's ` +
        "actions to put it on a book; the move lists what stops.",
    );
  }
  const notInBuild = (a: Pick<BookGridRow, "bookKey">) => bookNotInBuild(a.bookKey, registered);
  if (accounts.some((a) => a.bookKey != null && !notInBuild(a))) {
    parts.push(
      "These accounts run a book this build of the platform no longer includes, so none of their " +
        `playbooks runs. Use ${books.map(moveToLabel).join(" or ")} in an account's actions to put ` +
        "it on a book; the move lists what starts.",
    );
  }
  // The reconciler leaves such a book's rows as they are (reconcile.ts), so "none runs" would be false here.
  if (accounts.some(notInBuild)) {
    parts.push(
      "These accounts run a book only the staging build of the platform includes, so this build starts " +
        "none of their playbooks and leaves the running ones as they are until the account's switch is " +
        `turned off. Use ${books.map(moveToLabel).join(" or ")} in an account's actions to put it on a ` +
        "book; the move lists what starts and what stops.",
    );
  }
  return parts.join(" ");
}

/**
 * The empty list's other reading, and it is not {@link BOOKS_EMPTY}.
 *
 * A read that settled without answering renders no rows either, and *"No books
 * yet"* over it tells the operator their configuration is gone — the same
 * class of lie as a plausible zero. The em-dash rule in wording form: what
 * cannot be read, then what would fix it.
 */
export const BOOKS_UNREADABLE =
  "The book list could not be read, so this screen cannot say what is configured. Reload " +
  "to try again.";

/**
 * An account line's switch, its two titles.
 *
 * **Neither of them is what a refused line says.** Both assert something about
 * what the engine will do with this account, so on a line the live-account
 * block refuses the switch carries `verdict.reason` verbatim instead — see
 * {@link buildBookGrid}. That is the both-gates rule from
 * [design-language.md](../../../docs/modules/ui/design-language.md) applied to
 * a sentence rather than to a dot.
 */
export const BOOK_SWITCH_ON_TITLE =
  "This book is on for this account. Every playbook switched on here is running on this account.";
export const BOOK_SWITCH_OFF_TITLE =
  "This book is off for this account. Nothing on it takes an entry here, and open positions are closed first.";

/**
 * Shown after a deploy: the book lands switched off, so the deploy itself
 * starts nothing, and the switch is the press that does.
 */
export const BOOK_DEPLOYED_HINT =
  "The book is on this account, switched off, with every playbook on. Nothing runs until you switch it on.";

/**
 * Shown when a deploy brought back the account's earlier copy of this book: it
 * comes back switched off, as it was.
 */
export const BOOK_RESTORED_HINT =
  "This account's earlier copy of the book is back, switched off and with its playbooks as they were. " +
  "Nothing runs until you switch it on.";

/** The deploy press's title, and the Deploy dialog's last line: what it does and that it starts nothing. */
export const DEPLOY_TITLE =
  "Puts this book on the account switched off, with every playbook on. Nothing runs until you switch it on.";

/** The control that retires an account's book: the proposal's name for it, in the line's ⋯ menu. */
export const REMOVE_BOOK_LABEL = "Remove from account";

/** What a destructive menu item morphs to: the press that does it. */
export const REMOVE_BOOK_CONFIRM = "Confirm?";

/** An account line's ⋯: its accessible name, since the glyph says nothing. */
export const ACCOUNT_MENU_LABEL = "Account actions";

/** An account line's switch label, and its two readings. */
export const BOOK_SWITCH_LABEL = "Book";
export const BOOK_SWITCH_ARMED = "Armed";
export const BOOK_SWITCH_DISARMED = "Disarmed";

/** The risk value's label on an account line — the board's *risk/trade*, spaced. */
export const BOOK_RISK_LABEL = "Risk / trade";

/** The page's one deploy control, which opens the Deploy dialog, and the dialog's own words. */
export const DEPLOY_BOOK_LABEL = "Deploy a book";
export const DEPLOY_CONFIRM = "Deploy";
export const DEPLOY_PICK_BOOK = "Book";
export const DEPLOY_PICK_ACCOUNT = "Account";
export const DEPLOY_SUMMARY_LABEL = "What will be on";

/** The empty card's way into the Deploy dialog, with its book already picked. */
export function deployBookToLabel(bookName: string): string {
  return `Deploy ${bookName} to an account`;
}

/** The section heading's toggle for the book's read-only definition. */
export const WHATS_IN_BOOK_LABEL = "What's in this book";

/** The view cluster's fold segment, on Books and the Dashboard: its tooltip and accessible name, never visible text. */
export const EXPAND_ALL_LABEL = "Expand all";
export const COLLAPSE_ALL_LABEL = "Collapse all";

/** *Move to <book>*, in an account card's ⋯ menu; it opens the Move dialog on that book. */
export function moveToLabel(bookName: string): string {
  return `Move to ${bookName}`;
}
export const MOVE_DIALOG_TITLE = "Move to another book";
export const MOVE_CONFIRM = "Move";
/** The press re-read the move and it no longer matched the lists on screen, so nothing moved. */
export const MOVE_PREVIEW_CHANGED =
  "What this move does changed since the lists were read, so nothing moved. Check the lists again, then press Move.";
export const CANCEL_LABEL = "Cancel";

/** An account card's *Risk / trade* label goes to the page that sets it. */
export const RISK_PAGE_HREF = "/settings/risk";

/** A collapsed column's expander, and its way back. */
export function morePlaybooksLabel(hidden: number): string {
  return `+${hidden} more`;
}
export const FEWER_PLAYBOOKS_LABEL = "Show fewer";

/**
 * *Remove from account*'s title when the press would go through. It says
 * *nothing is deleted*, because a line that vanishes reads as history that was
 * lost, and names the control that brings it back.
 */
export const REMOVE_BOOK_TITLE =
  "Takes this book off this account, so the account can take another book. Nothing is " +
  "deleted: its playbooks stay switched off here and their trade history is kept.\n\nUse " +
  `${DEPLOY_BOOK_LABEL} with this book and account to bring it back, switched off and with its ` +
  "playbooks as they were.";

// ── An account line ─────────────────────────────────────────────────────

/**
 * What the registry knows about a playbook that the payload does not.
 *
 * Passed in rather than looked up, for `BoardInput.strategy`'s reason: the
 * strategy registry is a build-time `require.context` with no test-environment
 * equivalent, so a module that imported it could not be tested at all.
 */
export interface BookPlaybookFacts {
  name: string;
  /** `config.calibratedFor`, or null for a playbook that declares none —
   *  unrestricted, not unknown. */
  calibratedFor: string | null;
  /** `config.intent`, verbatim. Named in a tooltip, never enforced. */
  intent: ReadonlyArray<StrategyIntent>;
  /** `minimumRiskOf(config)`: the smallest risk per trade that takes one
   *  contract, for a playbook that declares a fixed stop; else null. Optional,
   *  and absent reads as null. */
  minimumRisk?: MinimumRisk | null;
}

/**
 * One playbook line in a contract column of an account line: a checkbox for
 * this account's own on/off, and its label. Only playbooks the book arms are
 * drawn there, so checked means *runs here once the switch is on*.
 *
 * **Four kinds, and a refused line is none of them.** A line the live-account
 * block refuses is the *absence* of cells rather than a kind of cell: the stamp
 * takes the body, because *which playbooks would run here* does not arise on
 * an account where none ever will.
 *
 * `idle` is on, on an on book, with no holder and nothing running it — the
 * state a deleted hand-made holder leaves behind ([bugs.md](../../../docs/bugs.md)
 * A83). It is read off the payload's `running`, not off any event.
 */
export interface BookGridCell {
  /** The cell's instrument. One playbook on two contracts is two cells. */
  ticker: TickerSymbol;
  strategyKey: string;
  /** The registry's display name, or the key when nothing is registered under
   *  it. A key is what a log line prints, so it is never wrong — only terse.
   *  The tooltips say this one. */
  name: string;
  /** `name` without its own contract's ` — MNQ` suffix: the cell sits under
   *  that contract's header, so the suffix only repeats it. What the line shows. */
  label: string;
  /**
   * `unavailable` is an armed cell whose playbook this build does not register
   * (the payload's `inBuild: false`). It is drawn only so it can be turned off,
   * and it outranks the other four: with no module there is no window to hold
   * a slot over and nothing to run, so neither `held` nor `idle` describes it.
   */
  kind: "armed" | "idle" | "off" | "held" | "unavailable";
  /**
   * The checked state: on for this account (and, being drawn, armed in the
   * book). `kind` does not carry it — a `held` cell may be on and materialising
   * nothing. The toggle direction is read from here so that state stays
   * clearable — see {@link cellToggleIntent}.
   */
  armed: boolean;
  /**
   * **A fill is a claim that the engine will take an entry here**, so `live`
   * needs the cell on *and* the account's book switched on. A checked cell
   * under an off switch is an ordinary, deliberate state — it is what the
   * operator's next on will start — and colouring it as running would make a
   * stood-down account read as a trading one.
   */
  tone: "live" | "muted" | "warn";
  title: string;
  /**
   * Turning it on would be refused because it would resume a derived leg still
   * `Pausing` — the payload's `closingOnArm`, never derived here. The cell is
   * inert and `title` is the route's sentence.
   */
  armWaitsForClose: boolean;
  /**
   * {@link fitWarning}'s sentence when the playbook declares a minimum and this
   * account's budget is known and under it — the sizer will refuse every
   * entry, so an armed cell here takes none. Printed under the playbook in the
   * warn tone; it moves nothing about `kind`, `tone` or the toggle.
   */
  fitWarning: string | null;
  /**
   * The cell's own sentence, printed under it, when its toggle is inert on a
   * ground of its own — a holder, a close in flight. Null when it is pressable,
   * and on an account the state gate refuses, whose card says that once.
   */
  inlineRefusal: string | null;
}

/** One contract's column, under its label (`MNQ`). */
export interface BookGridContract<C extends { ticker: TickerSymbol; armed: boolean } = BookGridCell> {
  ticker: TickerSymbol;
  label: string;
  /** Every cell, in payload order. */
  cells: C[];
  /** Checked cells, over all of `cells` — never over what is shown. */
  armedCount: number;
  /** Every cell off: the header recedes with them. */
  allOff: boolean;
  /**
   * What a collapsed column draws: the first {@link CONTRACT_COLLAPSED_SHOWS}
   * cells once there are more than {@link CONTRACT_COLLAPSE_ABOVE}, else all.
   */
  shown: C[];
  /** `cells.length - shown.length`: the `+N more` count, 0 when not collapsed. */
  hiddenCount: number;
}

/** One account running a book: its line on the book's card. */
export interface BookGridRow {
  /** The account's book. */
  id: string;
  accountId: number;
  /** The code book this account runs, or null when it is not on one. */
  bookKey: string | null;
  /** The account's name, or its id when the catalogue has none. */
  title: string;
  /** Head-truncatable prefix and the suffix that identifies the account —
   *  the suffix is what tells two accounts apart. */
  account: { head: string; tail: string };
  enabled: boolean;
  /** `verdict.reason` verbatim when the live-account block refuses this
   *  account, else null. Read off the payload; never derived here. */
  refusal: string | null;
  /**
   * The account-state gate's refusal (dead, locked, Topstep OCO off or
   * unknown), off the payload, when the live-account block permits. Unlike
   * {@link refusal} it keeps the cells: the book may be on with rows running,
   * and off / disarm are the moves left, so only the on direction is inert.
   */
  stateRefusal: { stamp: string; reason: string } | null;
  /** Topstep's auto bracket is on for this account; blocks nothing. */
  warning: string | null;
  /** A dead account's replacements; empty otherwise. */
  replacements: Array<{ accountId: number; name: string | null }>;
  /** The cells the book arms (and any armed one this build lacks), in payload
   *  order. Empty when `refusal` is set. */
  cells: BookGridCell[];
  /** The same cells grouped by contract, sorted by symbol — the line's
   *  columns. A contract with no cell has no group. */
  contracts: BookGridContract[];
  /** `boardRisk`'s answer for this account, unchanged — except that a refused
   *  line is `silent`, which is decided here for `buildBoard`'s reason: it is
   *  the gate rather than a reading, so the selector is never asked. */
  risk: BoardLegRisk;
  /** The account's resolved risk per trade today, or null — the fit warnings' budget. */
  budgetUsd: number | null;
  /** The switch's tooltip. The refusal wins both directions on a refused
   *  line — see {@link BOOK_SWITCH_ON_TITLE}. */
  switchTitle: string;
  /** The switch-on 409's sentence while switching on would resume a leg still
   *  `Pausing` (the payload's `closingOnSwitchOn`); null on an on book. */
  switchWaitsForClose: string | null;
  /**
   * The account is not on a book in code. Its switch is not turned on from
   * this page — the move to a book is — and stays turnable off.
   */
  offBook: boolean;
  /**
   * *Remove from account*. `refusal` is the payload's `removeRefusal`, the
   * route's own 409 sentence, never derived here; null when the press would go
   * through. Null when the payload did not answer, which draws no control.
   * Drawn on a refused account too: a remove only winds down, so the
   * live-account block does not reach it.
   */
  remove: { refusal: string | null } | null;
}

export interface BookGridInput {
  books: readonly BookPayload[];
  playbook: (strategyKey: string) => BookPlaybookFacts | null;
  /** `boardRisk({ rows, failed, now })`. Keyed by account, because the budget
   *  is the account's and this line is the surface that names it. */
  risk: (accountId: number) => BoardLegRisk;
  /**
   * The account's resolved risk per trade today, in dollars, or null when it
   * is not known (unread, unset, refused). Read through `readAccountRisk`, the
   * reader `risk` goes through. Optional: absent means no budget is known,
   * which gives a playbook's minimum-risk callout its informational reading.
   */
  budgetUsd?: (accountId: number) => number | null;
}

/**
 * Drawn on an account line: every cell its code book carries; on a book not on
 * one, what is on — so it can be turned off — and an armed cell this build lacks.
 */
function drawnOnLine(cell: BookPlaybookCell): boolean {
  if (cell.inBuild === false) return cell.armed;
  return cell.armedInBook ?? cell.armed;
}

/**
 * Every account's book as a line, sorted by account.
 *
 * **The risk figure belongs on this line by the existing rule rather than by
 * an exception** — the line names the account. There is no per-cell copy of it
 * and no card or page total: every contract on the book spends the one account
 * budget, and two accounts never spend theirs together.
 */
export function buildBookGrid(input: BookGridInput): BookGridRow[] {
  const rows = input.books.map((book): BookGridRow => {
    const refusal = book.account.autoTrade.permitted ? null : book.account.autoTrade.reason;
    const gate = refusal == null ? (book.account.state ?? null) : null;
    const stateRefusal = gate?.refusal
      ? { stamp: gate.refusal.stamp, reason: gate.refusal.reason }
      : null;
    // The route answers the live-account 403 first, then the account-state
    // gate's, so their sentences win the switch's title here too.
    const switchWaitsForClose =
      refusal == null && stateRefusal == null && !book.enabled && book.closingOnSwitchOn.length > 0
        ? turnOnWouldRetractACloseRefusal(
            book.closingOnSwitchOn.map((key) => input.playbook(key)?.name ?? key),
            "book",
          )
        : null;
    const budgetUsd = input.budgetUsd?.(book.accountId) ?? null;
    const cells =
      refusal != null
        ? []
        : book.playbooks.filter(drawnOnLine).map((cell) => {
            const facts = input.playbook(cell.strategyKey);
            const built = buildCell(cell, {
              bookEnabled: book.enabled,
              facts,
              stateRefusal: stateRefusal?.reason ?? null,
            });
            const inert = cellToggleIntent({ refusal, stateRefusal }, built).kind === "inert";
            // An unreadable share leaves the cell's budget unknown: the
            // informational reading, never a warning about a guessed figure.
            const share = cell.playbookRiskPercent === undefined ? FULL_RISK_PERCENT : cell.playbookRiskPercent;
            return withMinimumRisk(
              { ...built, inlineRefusal: inert && stateRefusal == null ? built.title : null },
              facts?.minimumRisk ?? null,
              share == null ? null : budgetUsd,
              share ?? FULL_RISK_PERCENT,
            );
          });
    const accountName = book.account.name ?? String(book.accountId);
    return {
      id: book.id,
      accountId: book.accountId,
      bookKey: book.bookKey ?? null,
      title: accountName,
      account: splitAccountName(accountName),
      enabled: book.enabled,
      refusal,
      stateRefusal,
      warning: gate?.warning ?? null,
      replacements: gate?.replacements ?? [],
      cells,
      contracts: groupByContract(cells),
      risk: refusal != null ? { kind: "silent" } : input.risk(book.accountId),
      budgetUsd,
      switchTitle:
        refusal ??
        stateRefusal?.reason ??
        switchWaitsForClose ??
        (book.enabled ? BOOK_SWITCH_ON_TITLE : BOOK_SWITCH_OFF_TITLE),
      switchWaitsForClose,
      offBook: false,
      remove: book.removeRefusal === undefined ? null : { refusal: book.removeRefusal },
    };
  });
  return rows.sort((a, b) =>
    `${a.account.head}${a.account.tail}`.localeCompare(`${b.account.head}${b.account.tail}`),
  );
}

/** A column collapses once it holds more cells than this… */
export const CONTRACT_COLLAPSE_ABOVE = 6;
/** …and then draws this many, with `+N more` for the rest. */
export const CONTRACT_COLLAPSED_SHOWS = 5;

/**
 * The cells under their contract label, sorted by symbol so a card's columns
 * hold their places whatever order the shelf or a migration produced. Within
 * a column the payload's order holds.
 */
function groupByContract<C extends { ticker: TickerSymbol; armed: boolean }>(
  cells: readonly C[],
): BookGridContract<C>[] {
  const byTicker = new Map<TickerSymbol, C[]>();
  for (const cell of cells) {
    const list = byTicker.get(cell.ticker);
    if (list) list.push(cell);
    else byTicker.set(cell.ticker, [cell]);
  }
  return [...byTicker.entries()]
    .map(([ticker, list]): BookGridContract<C> => {
      const armedCount = list.filter((c) => c.armed).length;
      const shown = list.length > CONTRACT_COLLAPSE_ABOVE ? list.slice(0, CONTRACT_COLLAPSED_SHOWS) : list;
      return {
        ticker,
        label: contractLabel(ticker),
        cells: list,
        armedCount,
        allOff: armedCount === 0,
        shown,
        hiddenCount: list.length - shown.length,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function identityOf(
  cell: { ticker: TickerSymbol; strategyKey: string },
  facts: BookPlaybookFacts | null,
): Pick<BookGridCell, "ticker" | "strategyKey" | "name" | "label"> {
  const name = facts?.name ?? cell.strategyKey;
  return {
    ticker: cell.ticker,
    strategyKey: cell.strategyKey,
    name,
    label: withoutContractSuffix(name, contractLabel(cell.ticker)),
  };
}

function buildCell(
  cell: BookPlaybookCell,
  ctx: {
    bookEnabled: boolean;
    facts: BookPlaybookFacts | null;
    /** The account-state gate's sentence; an off cell is titled with it,
     *  since turning it on is refused on that ground first. */
    stateRefusal: string | null;
  },
): Omit<BookGridCell, "fitWarning" | "inlineRefusal"> {
  const identity = identityOf(cell, ctx.facts);
  const { name, ticker } = identity;
  if (cell.inBuild === false) {
    return {
      ...identity,
      kind: "unavailable",
      armed: cell.armed,
      // The platform declining to run something, which is this screen's warn.
      tone: "warn",
      title:
        `${name} is armed on this book. ${PLAYBOOK_NOT_IN_BUILD} ` +
        `Turn it off; it cannot be turned back on in this build.`,
      armWaitsForClose: false,
    };
  }
  if (cell.conflict != null) {
    return {
      ...identity,
      kind: "held",
      armed: cell.armed,
      // Nothing is broken and the platform is declining to do something,
      // which is the warn tone every refusal in this app uses.
      tone: "warn",
      title: heldTitle(cell.conflict, ticker, cell.armed),
      armWaitsForClose: cell.closingOnArm,
    };
  }
  // Under an off switch the armed arm below already says it takes no entries,
  // which is true; only an on switch makes a checked box a claim that something runs.
  if (cell.armed && ctx.bookEnabled && !cell.running) {
    return {
      ...identity,
      kind: "idle",
      armed: true,
      tone: "warn",
      title: idleTitle(name, cell),
      armWaitsForClose: false,
    };
  }
  if (cell.armed) {
    return {
      ...identity,
      kind: "armed",
      armed: true,
      tone: ctx.bookEnabled ? "live" : "muted",
      title: ctx.bookEnabled
        ? `${name} is running on this account. Turn it off and it stops taking entries; ` +
          `anything open is closed first.`
        : `${name} is armed on this book. The book is off, so it takes no entries until ` +
          `the book is switched on.`,
      armWaitsForClose: false,
    };
  }
  return {
    ...identity,
    kind: "off",
    armed: false,
    tone: "muted",
    // The route's refusal, said before the press, as every inert control here
    // does — the account's 403 ahead of the close 409, in the route's order,
    // and the close naming the contract as the route does.
    title:
      ctx.stateRefusal ??
      (cell.closingOnArm
        ? turnOnWouldRetractACloseRefusal([`${name} on ${ticker}`], "playbook")
        : `${name} is armed in this book and off on this account. Turn it on to run it here.`),
    armWaitsForClose: cell.closingOnArm,
  };
}

/**
 * `Bar Close Pulse — MNQ` → `Bar Close Pulse` under the MNQ
 * header. Only the cell's own contract is stripped, and only as the whole last
 * segment: `— MNQ probe` says something the header does not, and a suffix
 * naming another contract would be a fact the header contradicts.
 */
function withoutContractSuffix(name: string, contract: string): string {
  const suffix = ` — ${contract}`;
  return name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name;
}

/**
 * A playbook's minimum-risk callout, appended to the cell's own sentence as
 * its own blocks — the cell's state first, because that is what the press
 * changes.
 *
 * **Not on an `unavailable` cell**, which has no module to size, and **no
 * fit warning on a `held` one**, whose stamp and move come first: freeing the
 * slot is the operator's next step there, and a budget only matters once
 * something can run. The warn reading needs a known budget, scaled by the
 * cell's share, under the minimum; anything else is the informational one
 * (`minimumRiskNotice`).
 */
function withMinimumRisk(
  cell: Omit<BookGridCell, "fitWarning">,
  min: MinimumRisk | null,
  budgetUsd: number | null,
  riskPercent: number,
): BookGridCell {
  if (min == null || cell.kind === "unavailable") return { ...cell, fitWarning: null };
  const notice = minimumRiskNotice(min, budgetUsd, riskPercent);
  return {
    ...cell,
    title: `${cell.title}\n\n${notice.text}`,
    fitWarning: cell.kind === "held" ? null : fitWarning(min, budgetUsd, riskPercent),
  };
}

/**
 * A hand-made deployment holds the slot and wins.
 *
 * The sentence ends in the operator's move, and **which move differs with the
 * cell's own state**: an armed cell that materialised nothing is a state to
 * clear, an off one is a state to leave alone. A conflict is transient by
 * design — the hand-made row going away is what the subtractive phase is for —
 * so neither ending implies the operator is stuck.
 *
 * A deployment row with no name states the fact without one rather than
 * printing an id: the id is not what the operator would recognise it by.
 */
function heldTitle(
  conflict: { deploymentId: string; deploymentName: string | null },
  ticker: TickerSymbol,
  armed: boolean,
): string {
  const holder = conflict.deploymentName ?? "A hand-made deployment";
  return armed
    ? `${holder} already trades ${ticker} on this account over the same hours, so this ` +
        `playbook is armed and running nothing. Delete that deployment, or turn this ` +
        `playbook off.`
    : `${holder} already trades ${ticker} on this account over the same hours. Delete that ` +
        `deployment, or leave this playbook off.`;
}

/**
 * On, on an on switch, unheld, and nothing runs it.
 *
 * **It ends in the move that works, and which move that is depends on the
 * parent.** With no derived row, or a disabled one, off-and-on is the move —
 * the reconciler creates or resumes on a transition, which the operator's own
 * two presses are. With the parent enabled it is not: the stand-down snapshots
 * a non-`Active` leg and the resume restores it the same way. So:
 *
 * - detached, parent enabled: {@link DETACHED_RECOVER_LABEL}, by its own label.
 * - detached, parent disabled: off-and-on **first**, then Restore and arm.
 *   `clearOrphanedAndReEnable` leaves a disabled group disabled, so
 *   `clear-orphan` refuses that order with `RESTORE_NEEDS_PLAYBOOK_ON`
 *   (bugs.md A85) and the card disables its button with the same sentence.
 * - not detached, parent enabled: no press here starts it, and it says so.
 *
 * **A leg still closing outranks all of them.** `markOrphaned` keeps a
 * `Pausing` / `Destroying` status, so a leg can be detached mid-close.
 * `clear-orphan` 409s on either with `RESTORE_WOULD_RETRACT_A_CLOSE`, and the
 * on half of off-and-on is refused over a `Pausing` one; a `Destroying` one is
 * reaped once flat, so waiting is the move there too.
 *
 * **The platform does not bring it back by itself, on purpose**: that would
 * start trading on an account with nobody pressing anything (bugs.md A83).
 */
function idleTitle(
  name: string,
  cell: Pick<BookPlaybookCell, "parentEnabled" | "detached" | "closing">,
): string {
  if (cell.closing) {
    return (
      `${name} is armed on this book, but nothing is running it. ` + RESTORE_WOULD_RETRACT_A_CLOSE
    );
  }
  if (cell.detached === "restore") {
    return (
      `${name} is armed on this book, but its deployment is detached, so nothing is running ` +
      `it. Use ${DETACHED_RECOVER_LABEL} on its Dashboard card; that re-arms it for entries.`
    );
  }
  if (cell.detached === "toggle-then-restore") {
    return (
      `${name} is armed on this book, but its deployment is detached and switched off, so ` +
      `nothing is running it. Turn this playbook off and on again first, then use ` +
      `${DETACHED_RECOVER_LABEL} on its Dashboard card. ${DETACHED_RECOVER_LABEL} is refused ` +
      `until then.`
    );
  }
  if (cell.parentEnabled) {
    return (
      `${name} is armed on this book and its deployment is on, but none of its legs is ` +
      `Active, so nothing is running it. Turning it off and on again brings back the same ` +
      `state rather than starting it. Its Dashboard card shows each leg's status.`
    );
  }
  return (
    `${name} is armed on this book, but nothing is running it on this account. Turn it off ` +
    `and on again to start it.`
  );
}

/** The two shelves, in one order, so a two-shelf playbook reads the same way
 *  on every book. */
const SHELVES: readonly StrategyIntent[] = ["growth", "speed"];

/**
 * A book's playbook, as its card lists it. **The shelf is named, never
 * enforced**: it says which shelf the playbook cleared and nothing about
 * whether an account *should* run it. Both clauses are omitted when the module
 * declares nothing, rather than rendered as *unrestricted* or *no shelf*.
 */
function bookCellTitle(name: string, facts: BookPlaybookFacts | null): string {
  const clauses: string[] = [];
  if (facts?.calibratedFor) clauses.push(`calibrated for ${facts.calibratedFor}`);
  const shelves = SHELVES.filter((s) => facts?.intent.includes(s));
  if (shelves.length > 0) {
    clauses.push(
      `admitted on the ${shelves.join(" and ")} ${shelves.length > 1 ? "shelves" : "shelf"}`,
    );
  }
  const head = `${name} is in this book.`;
  const shelf = clauses.length > 0 ? ` It was ${clauses.join(" and ")}.` : "";
  return `${head}${shelf} Each account turns it on or off on its own line.`;
}

// ── A book's card ───────────────────────────────────────────────────────

/**
 * One playbook in a book, as its card lists it: read-only, since a book's
 * playbooks change in code. `armed` is always true — the book carries it —
 * and the card's columns print no count.
 */
export interface BookLevelCell {
  ticker: TickerSymbol;
  strategyKey: string;
  name: string;
  label: string;
  armed: true;
  /** This build registers the playbook. */
  inBuild: boolean;
  title: string;
  /** For the deploy's fit warning — a declared minimum, never computed. */
  minimumRisk: MinimumRisk | null;
}

/** One book's section of the page (the name predates the sections). */
export interface BookCard {
  /** The code book's key, or null on the section of accounts not on a book. */
  key: string | null;
  name: string;
  /** What the section of accounts not on a book says ({@link unbookedNote}); null on a book's. */
  note: string | null;
  cells: BookLevelCell[];
  contracts: BookGridContract<BookLevelCell>[];
  /** The accounts running the book, one card each. */
  accounts: BookGridRow[];
}

export interface BookCardsInput extends BookGridInput {
  codeBooks: readonly CodeBookPayload[];
}

/**
 * Every code book as a card, in code's order, each holding the lines of the
 * accounts that run it; then, only when there are any, one card of the
 * accounts not on a book (left there by the migration, or on a key no longer
 * in code).
 */
export function buildBookCards(input: BookCardsInput): BookCard[] {
  const rows = buildBookGrid(input);
  const keys = new Set(input.codeBooks.map((b) => b.key));
  const cards = input.codeBooks.map((book): BookCard => {
    const cells = book.cells.map((cell) => buildBookLevelCell(cell, input.playbook(cell.strategyKey)));
    return {
      key: book.key,
      name: book.name,
      note: null,
      cells,
      contracts: groupByContract(cells),
      accounts: rows.filter((r) => r.bookKey === book.key),
    };
  });
  const names = input.codeBooks.map((b) => b.name);
  const unbooked = rows
    .filter((r) => r.bookKey == null || !keys.has(r.bookKey))
    .map((r): BookGridRow => ({
      ...r,
      offBook: true,
      // The account's own refusals keep the title, in the route's order; this
      // one is the page's, and only the on direction reaches it.
      switchTitle:
        r.enabled || r.refusal != null || r.stateRefusal != null ? r.switchTitle : unbookedSwitchTitle(names),
    }));
  if (unbooked.length > 0) {
    const migration = input.codeBooks.find((b) => b.key === MIGRATION_BOOK_KEY)?.name ?? names[0] ?? "";
    cards.push({
      key: null,
      name: UNBOOKED_TITLE,
      note: unbookedNote(unbooked, migration, names, input.codeBooks),
      cells: [],
      contracts: [],
      accounts: unbooked,
    });
  }
  return cards;
}

function buildBookLevelCell(
  cell: CodeBookPayload["cells"][number],
  facts: BookPlaybookFacts | null,
): BookLevelCell {
  const identity = identityOf(cell, facts);
  return {
    ...identity,
    armed: true,
    inBuild: cell.inBuild,
    title: cell.inBuild
      ? bookCellTitle(identity.name, facts)
      : `${identity.name} is in this book. ${PLAYBOOK_NOT_IN_BUILD}`,
    minimumRisk: facts?.minimumRisk ?? null,
  };
}

/**
 * A book section's heading line: `7 playbooks · MES, MNQ · 2 accounts`, or
 * `no accounts` for a book no account runs.
 */
export function describeBookHeading(
  card: Pick<BookCard, "cells" | "contracts" | "accounts">,
): string {
  return [
    plural(card.cells.length, "playbook", "playbooks"),
    ...(card.contracts.length > 0 ? [card.contracts.map((c) => c.label).join(", ")] : []),
    card.accounts.length === 0 ? "no accounts" : plural(card.accounts.length, "account", "accounts"),
  ].join(" · ");
}

/**
 * An account card's subtitle: `5 of 7 on · 2 contracts · 1 warning`, the
 * warnings only when there are some.
 *
 * **`on` is the account's own switches — the checked boxes — and claims
 * nothing about what runs.** Whether any of it runs is the card's switch and
 * the boxes' tone; a count folding both gates in would disagree with the
 * boxes it sits above. A warning is a playbook's fit warning, printed under it.
 */
export function describeAccountSummary(
  row: { cells: ReadonlyArray<{ armed: boolean; fitWarning: string | null }>; contracts: readonly unknown[] },
): string {
  const on = row.cells.filter((c) => c.armed).length;
  const warnings = row.cells.filter((c) => c.fitWarning != null).length;
  return [
    `${on} of ${row.cells.length} on`,
    plural(row.contracts.length, "contract", "contracts"),
    ...(warnings > 0 ? [plural(warnings, "warning", "warnings")] : []),
  ].join(" · ");
}

/** A column header's count, `3 of 4 on` — over every cell, collapsed or not. */
export function describeContractCount(
  contract: { armedCount: number; cells: readonly unknown[] },
): string {
  return `${contract.armedCount} of ${contract.cells.length} on`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── What may be pressed ─────────────────────────────────────────────────

/**
 * **An inert intent carries no reason, deliberately.** Every control on this
 * screen already has a tooltip that states its own state in full — the line's
 * `switchTitle`, the cell's `title` — and both of them say more than a second
 * sentence here could.
 */
export type BookSwitchIntent = { kind: "write"; enabled: boolean } | { kind: "inert" };

/**
 * An account line's switch.
 *
 * **The refusal ground carries `&& !enabled`, and that carve-out is
 * load-bearing** — a book on an account that has since been classified live
 * must still be turnable *off*, or the refusal becomes the hazard on exactly
 * the wind-down path the operator needs most.
 *
 * **It is called in the render *and* in the handler**, with the same operands.
 * A `disabled` attribute is one keystroke of devtools away and a stale render
 * can hand a click to a line the current props would block.
 *
 * **A close in flight is inert on the same carve-out**, and so is an account
 * the account-state gate refuses — dead, locked, OCO — and an account not on a
 * book, whose move is to a book first.
 */
export function bookSwitchIntent(
  row: Pick<BookGridRow, "enabled" | "refusal" | "stateRefusal" | "switchWaitsForClose" | "offBook">,
): BookSwitchIntent {
  if (row.refusal != null && !row.enabled) return { kind: "inert" };
  if (row.stateRefusal != null && !row.enabled) return { kind: "inert" };
  if (row.switchWaitsForClose != null && !row.enabled) return { kind: "inert" };
  if (row.offBook && !row.enabled) return { kind: "inert" };
  return { kind: "write", enabled: !row.enabled };
}

/**
 * *Remove from account*: `none` draws nothing, `inert` draws it disabled with
 * the route's sentence as its title, `write` sends `DELETE /api/books/[id]`.
 * The press handler refuses from the same answer the render disables from.
 */
export function removeBookIntent(
  row: Pick<BookGridRow, "remove">,
): { kind: "none" } | { kind: "inert"; title: string } | { kind: "write"; title: string } {
  if (row.remove == null) return { kind: "none" };
  if (row.remove.refusal != null) return { kind: "inert", title: row.remove.refusal };
  return { kind: "write", title: REMOVE_BOOK_TITLE };
}

export type CellToggleIntent =
  | { kind: "write"; ticker: TickerSymbol; strategyKey: string; on: boolean }
  | { kind: "inert" };

/**
 * One cell on an account line: this account's own on/off.
 *
 * **`held` is inert in the on direction and live in the off one**: turning on
 * a cell that cannot produce a row is a control that looks like it worked and
 * did not, while an on cell the conflict refuses is a state the operator has
 * to be able to clear.
 *
 * On over a close in flight is inert (the route 409s), off never is. So is an
 * on for an account the account-state gate refuses (the route 403s), with its
 * off left live; and an on of an `unavailable` cell (the route 400s).
 */
export function cellToggleIntent(
  row: Pick<BookGridRow, "refusal" | "stateRefusal">,
  cell: Pick<BookGridCell, "ticker" | "strategyKey" | "kind" | "armed" | "armWaitsForClose">,
): CellToggleIntent {
  if (row.refusal != null) return { kind: "inert" };
  if (row.stateRefusal != null && !cell.armed) return { kind: "inert" };
  if (cell.kind === "held" && !cell.armed) return { kind: "inert" };
  if (cell.kind === "unavailable" && !cell.armed) return { kind: "inert" };
  if (cell.armWaitsForClose && !cell.armed) return { kind: "inert" };
  return { kind: "write", ticker: cell.ticker, strategyKey: cell.strategyKey, on: !cell.armed };
}

// ── The confirmations ───────────────────────────────────────────────────

/**
 * The warn reading of a playbook's minimum-risk callout, first block only —
 * **from a declared minimum and a known budget, never computed from a stop**.
 * Null for a playbook that declares none, or a budget that fits or was not read.
 */
export function fitWarning(
  min: MinimumRisk | null,
  budgetUsd: number | null,
  riskPercent: number,
): string | null {
  if (min == null) return null;
  const notice = minimumRiskNotice(min, budgetUsd, riskPercent);
  return notice.tone === "warn" ? notice.text.split("\n\n")[0] : null;
}

/**
 * The deploy's confirmation: one fit warning per playbook in the book the
 * account's budget is short for. At the full share, because a deploy creates
 * each playbook's row with its default settings.
 */
export function deployFitWarnings(
  card: Pick<BookCard, "cells">,
  budgetUsd: number | null,
): Array<{ name: string; text: string }> {
  return card.cells.flatMap((cell) => {
    const text = fitWarning(cell.minimumRisk, budgetUsd, FULL_RISK_PERCENT);
    return text == null ? [] : [{ name: cell.name, text }];
  });
}

/** A *stops* line whose row holds a position, or is still closing one. */
export const MOVE_WILL_CLOSE = "its open position will be closed";

/** One group of the Move dialog: the playbooks a move treats one way, under what it does. */
export interface MoveGroup {
  step: MoveLine["step"];
  heading: string;
  lines: Array<Pick<MoveLine, "ticker" | "strategyKey" | "willClose">>;
}

/**
 * The Move dialog's lists: *Keeps running*, *Stops*, *Starts*, each only when
 * it holds a playbook, in that order. A start under a switched-off book says
 * when it starts; a stop that closes a position is named per line
 * ({@link MOVE_WILL_CLOSE}).
 */
export function moveGroups(lines: ReadonlyArray<MoveLine>, bookOn: boolean): MoveGroup[] {
  const heading: Record<MoveLine["step"], string> = {
    keeps: "Keeps running",
    stops: "Stops",
    starts: bookOn ? "Starts" : "Starts when this account's book is switched on",
  };
  const steps: ReadonlyArray<MoveLine["step"]> = ["keeps", "stops", "starts"];
  return steps.flatMap((step) => {
    const of = lines.filter((l) => l.step === step);
    return of.length === 0 ? [] : [{ step, heading: heading[step], lines: of }];
  });
}

/** The books an account may move to: every code book but its own. */
export function moveTargets(
  cards: ReadonlyArray<Pick<BookCard, "key" | "name">>,
  row: Pick<BookGridRow, "bookKey">,
): Array<{ id: string; name: string }> {
  return cards.flatMap((c) => (c.key != null && c.key !== row.bookKey ? [{ id: c.key, name: c.name }] : []));
}

// ── The Deploy dialog ───────────────────────────────────────────────────

/**
 * The Deploy dialog's accounts: the Playbook Deploy picker's rows
 * (`buildDeployAccountRows` — the live-account block, then the account-state
 * gate off the server's answer), then the deploy route's third refusal, **an
 * account that already runs a book**, in the route's own sentence
 * (`accountHasBookRefusal`) under an `on <book>` stamp. Shown, disabled and
 * stamped, never dropped.
 *
 * The route's sentence names the book being deployed and the move that works;
 * before a book is picked it names the other book in code the account's ⋯
 * offers, so it never names a control that is not there.
 *
 * Before the books have been read nothing is offered, because which accounts
 * already run one is not known yet.
 */
export function deployAccountRows(
  rows: readonly DeployAccountRow[],
  books: ReadonlyArray<Pick<BookPayload, "accountId" | "bookKey">> | null,
  codeBooks: ReadonlyArray<Pick<CodeBookPayload, "key" | "name">>,
  target: string | null,
): DeployAccountRow[] {
  if (books == null) return [];
  const bookOf = new Map(books.map((b) => [b.accountId, b.bookKey ?? null]));
  return rows.map((row) => {
    if (row.refusal != null || !bookOf.has(row.id)) return row;
    const key = bookOf.get(row.id);
    const current = codeBooks.find((b) => b.key === key)?.name ?? ACCOUNT_BOOK_FALLBACK;
    const move = target ?? codeBooks.find((b) => b.key !== key)?.name ?? current;
    return {
      ...row,
      stamp: `on ${current}`,
      stampFromStateGate: false,
      refusal: accountHasBookRefusal(current, move),
    };
  });
}

/** The deploy route's name for an account's book that is not in code. */
const ACCOUNT_BOOK_FALLBACK = "a book";

/**
 * The Deploy press: both picked, and the account not refused. Called in the
 * render and in the handler with the same operands.
 */
export function deployBookIntent(
  book: string | null,
  account: Pick<DeployAccountRow, "id" | "refusal"> | null,
): { kind: "write"; book: string; accountId: number } | { kind: "inert" } {
  if (book == null || account == null || account.refusal != null) return { kind: "inert" };
  return { kind: "write", book, accountId: account.id };
}
