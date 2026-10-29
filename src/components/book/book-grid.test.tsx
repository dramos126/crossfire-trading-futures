// @vitest-environment jsdom
/**
 * The handler re-check, and the half of it the DOM can see.
 *
 * **The devtools path is not testable through the DOM, and that is a fact
 * about React rather than a gap here.** A mouse event on a control React
 * rendered with `disabled` is dropped by its own listener lookup, which reads
 * the *props* and not the attribute — so stripping the attribute and
 * dispatching passes identically against a handler with no guard in it. That
 * was verified by injection before this file was written the other way round.
 *
 * So each half is asserted where it can be: the render's `disabled` in the
 * DOM, the handler's refusal at `pressCell` / `pressBook` / `pressRemove`,
 * and the positive path through a real click so the JSX is shown to consult
 * them.
 *
 * The rows come from `buildBookGrid` / `buildBookCards`, not from a
 * hand-built literal: a helper that reimplements the builder asserts the copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BookGrid } from "./book-grid";
import {
  AccountCard,
  pressBook,
  pressCell,
  pressRemove,
  type AccountCardProps,
  type CellPatch,
} from "./book-account-card";
import { BookSection, type BookSectionProps } from "./book-section";
import { MoveDialog, moveIntent, type MoveDialogProps } from "./book-move-dialog";
import {
  buildBookCards,
  buildBookGrid,
  deployBookToLabel,
  fitWarning,
  moveToLabel,
  morePlaybooksLabel,
  unbookedSwitchTitle,
  ACCOUNT_MENU_LABEL,
  BOOK_DEPLOYED_HINT,
  BOOK_NO_ACCOUNTS,
  BOOK_RESTORED_HINT,
  BOOK_SWITCH_ARMED,
  BOOK_SWITCH_DISARMED,
  BOOKS_EMPTY,
  COLLAPSE_ALL_LABEL,
  EXPAND_ALL_LABEL,
  CONTRACT_COLLAPSE_ABOVE,
  CONTRACT_COLLAPSED_SHOWS,
  DEPLOY_BOOK_LABEL,
  DEPLOY_CONFIRM,
  FEWER_PLAYBOOKS_LABEL,
  MOVE_CONFIRM,
  MOVE_PREVIEW_CHANGED,
  MOVE_WILL_CLOSE,
  REMOVE_BOOK_CONFIRM,
  REMOVE_BOOK_LABEL,
  REMOVE_BOOK_TITLE,
  UNBOOKED_TITLE,
  WHATS_IN_BOOK_LABEL,
  type BookCard as BookCardModel,
  type BookGridRow,
} from "./book-grid-model";
import type { MovePreview } from "@/app/api/books/[id]/move/route";
import { accountHasBookRefusal } from "@/lib/trading/books/refusals";
import { NO_BROKER_COPY } from "@/lib/hooks/use-trading/auth-answer";

// Any sentence: the grid renders the payload's verbatim. The real constant's
// module reads the database, which this jsdom file does not load.
const REMOVE_BOOK_REFUSAL = "The route's remove refusal.";
import type { BookPayload, BookPlaybookCell, CodeBookPayload } from "@/app/api/books/route";
import { ARM_MS } from "@/components/account/account-risk-block";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import { turnOnWouldRetractACloseRefusal } from "@/lib/trading/domain";
import {
  ACCOUNT_DEAD_REFUSAL,
  AUTO_OCO_OFF_REFUSAL,
  AUTO_OCO_UNKNOWN_REFUSAL,
  MOVE_TO_REPLACEMENT_LABEL,
  autoBracketWarning,
  lockedRefusal,
} from "@/lib/trading/broker-access/account-state-gate";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import { describeNoAccounts } from "@/components/playbook/playbook-deploy-model";
import { PrivacyProvider } from "@/components/privacy/privacy-provider";
import { HIDE_ACCOUNT_IDS_KEY, HIDE_BALANCES_KEY, MASKED_USD } from "@/components/privacy/privacy-model";

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md). The card
// under test takes rows and never asks the registry — this is the container's
// import, reached through the module.
vi.mock("@/lib/trading/strategies", () => ({ getStrategy: () => null }));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

const trading = vi.hoisted(() => ({
  reloadAccounts: vi.fn(async () => {}),
  deployments: [],
  accounts: [] as unknown[],
  accountCatalogWarning: null as string | null,
  noBroker: false,
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({
    token: "test-token",
    accounts: trading.accounts,
    reloadAccounts: trading.reloadAccounts,
    accountCatalogWarning: trading.accountCatalogWarning,
    noBroker: trading.noBroker,
  }),
}));

// The container's refetch key. One stable array, so the effect keyed on it
// runs once per mount rather than once per render.
vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({ deployments: trading.deployments }),
}));

// `autoTradeVerdict` is deliberately **not** mocked: the refusal this file
// asserts is the shipped constant, and a stubbed predicate would assert the
// stub.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRAC_NAME = "PRAC-V2-100200-90012114";

const bookWrites: Array<{ id: string; enabled: boolean }> = [];
const cellWrites: Array<{ id: string } & CellPatch> = [];

const recordBook = (row: BookGridRow, next: { enabled: boolean }) => bookWrites.push({ id: row.id, ...next });
const recordCell = (row: BookGridRow, next: CellPatch) => cellWrites.push({ id: row.id, ...next });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const REFUSED_ACCOUNT = {
  name: PRAC_NAME,
  broker: "topstep" as const,
  autoTrade: { permitted: false as const, reason: LIVE_ACCOUNT_REFUSAL },
};

/** Armed in the book, off for this account. */
const OFF_CELL: BookPlaybookCell = {
  ticker: "/MNQ", strategyKey: "orb", armed: false, armedInBook: true, on: false, groupId: null, conflict: null,
  running: false, parentEnabled: false, detached: null, closing: false, closingOnArm: false,
};
const ARMED_CELL: BookPlaybookCell = { ...OFF_CELL, armed: true, on: true, groupId: "g1", running: true, parentEnabled: true };

function book(over: Partial<BookPayload> = {}): BookPayload {
  return {
    id: "book-1",
    accountId: 1,
    bookKey: "cash",
    enabled: true,
    closingOnSwitchOn: [],
    account: { name: PRAC_NAME, broker: "topstep", autoTrade: { permitted: true } },
    playbooks: [ARMED_CELL],
    ...over,
  };
}

const CASH: CodeBookPayload = {
  key: "cash",
  name: "Cash",
  cells: [{ ticker: "/MNQ", strategyKey: "orb", inBuild: true }],
};

const ORB = () => ({ name: "Opening Range Breakout", calibratedFor: "MNQ", intent: ["speed" as const] });
const RISK = () => ({ kind: "budget" as const, amount: "$500", note: "Combine", tone: "muted" as const, detail: "d" });

function rowFor(payload: BookPayload): BookGridRow {
  return buildBookGrid({ books: [payload], playbook: ORB, risk: RISK })[0];
}

function cardsFor(books: BookPayload[]): BookCardModel[] {
  return buildBookCards({ codeBooks: [CASH], books, playbook: ORB, risk: RISK });
}

function line(row: BookGridRow, over: Partial<AccountCardProps> = {}): ReactElement {
  return <AccountCard row={row} busy={false} onToggleBook={recordBook} onToggleCell={recordCell} {...over} />;
}

function card(model: BookCardModel, over: Partial<BookSectionProps> = {}): ReactElement {
  return (
    <BookSection
      card={model}
      busy={false}
      onDeploy={() => {}}
      expanded={new Set()}
      account={{ busy: false, onToggleBook: recordBook, onToggleCell: recordCell }}
      {...over}
    />
  );
}

async function mount(el: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
  await act(async () => {});
}

async function settle(n = 6) {
  for (let i = 0; i < n; i += 1) await act(async () => {});
}

function buttonWith(text: string): HTMLButtonElement {
  const buttons = Array.from(container!.querySelectorAll("button"));
  return buttons.find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
}

/** The playbook line whose label reads `text`, and its checkbox. */
function lineFor(text: string): HTMLLabelElement {
  const labels = Array.from(container!.querySelectorAll("label"));
  return labels.find((l) => l.textContent?.includes(text)) as HTMLLabelElement;
}
function boxFor(text: string): HTMLInputElement {
  return lineFor(text).querySelector("input[type='checkbox']") as HTMLInputElement;
}

function bookSwitch(): HTMLButtonElement {
  return container!.querySelector("[role='switch']") as HTMLButtonElement;
}

function menuButton(label = ACCOUNT_MENU_LABEL): HTMLButtonElement | null {
  return container!.querySelector(`button[aria-label='${label}']`);
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  bookWrites.length = 0;
  cellWrites.length = 0;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("the handler refuses what the render refused", () => {
  it("writes nothing when a refused, switched-off account's book is pressed", () => {
    const row = rowFor(book({ enabled: false, account: REFUSED_ACCOUNT }));

    pressBook(row, recordBook);

    expect(bookWrites).toEqual([]);
  });

  it("writes nothing when a held cell is pressed", () => {
    const row = rowFor(
      book({ playbooks: [{ ...OFF_CELL, conflict: { deploymentId: "d9", deploymentName: "Morning MNQ" } }] }),
    );

    pressCell(row, row.cells[0], recordCell);

    expect(cellWrites).toEqual([]);
  });

  it("still writes on the lines that are controls", () => {
    // The control for both cases above: a blanket refusal would pass them and
    // ship a line whose every control is dead.
    const row = rowFor(book({ enabled: true }));

    pressBook(row, recordBook);
    pressCell(row, row.cells[0], recordCell);

    expect(bookWrites).toEqual([{ id: "book-1", enabled: false }]);
    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MNQ", strategyKey: "orb", on: false }]);
  });
});

describe("an account's line", () => {
  it("draws a column per contract, sorted by symbol, and sends the pressed box's own contract", async () => {
    await mount(line(rowFor(book({ playbooks: [ARMED_CELL, { ...OFF_CELL, ticker: "/MES", strategyKey: "relay" }] }))));

    const headers = Array.from(container!.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headers).toEqual(["MES0 of 1 on", "MNQ1 of 1 on"]);

    const boxes = Array.from(container!.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
    await click(boxes[0]);
    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MES", strategyKey: "relay", on: true }]);
  });

  it("makes the whole label the hit area, and routes the switch through its handler", async () => {
    await mount(line(rowFor(book({ enabled: true }))));

    await click(lineFor("Opening Range Breakout").querySelector("span")!);
    await click(bookSwitch());

    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MNQ", strategyKey: "orb", on: false }]);
    expect(bookWrites).toEqual([{ id: "book-1", enabled: false }]);
  });

  it("reads Armed or Disarmed on the account's switch", async () => {
    await mount(line(rowFor(book({ enabled: true }))));
    expect(bookSwitch().getAttribute("aria-checked")).toBe("true");
    expect(bookSwitch().textContent).toContain(BOOK_SWITCH_ARMED);

    await act(async () => root!.render(line(rowFor(book({ enabled: false })))));
    expect(bookSwitch().getAttribute("aria-checked")).toBe("false");
    expect(bookSwitch().textContent).toContain(BOOK_SWITCH_DISARMED);
  });

  it("disables the switch the model calls inert, titled with the refusal", async () => {
    await mount(line(rowFor(book({ enabled: false, account: REFUSED_ACCOUNT }))));

    expect(bookSwitch().disabled).toBe(true);
    expect(bookSwitch().title).toBe(LIVE_ACCOUNT_REFUSAL);
  });

  it("disables a held box and leaves its sibling pressable", async () => {
    await mount(
      line(
        rowFor(
          book({
            playbooks: [
              { ...OFF_CELL, conflict: { deploymentId: "d9", deploymentName: "Morning MNQ" } },
              { ...OFF_CELL, strategyKey: "ema-bounce" },
            ],
          }),
        ),
      ),
    );

    const lines = Array.from(container!.querySelectorAll("label"));
    expect(lines[0].querySelector("input")!.disabled).toBe(true);
    expect(lines[0].textContent).toContain("held");
    expect(lines[0].title).toContain("Morning MNQ");
    expect(lines[1].querySelector("input")!.disabled).toBe(false);
  });

  it("stamps an on box nothing runs as idle, pressable toward off (bugs.md A83)", async () => {
    await mount(line(rowFor(book({ playbooks: [{ ...ARMED_CELL, running: false, parentEnabled: false }] }))));

    const l = lineFor("Opening Range Breakout");
    expect(l.textContent).toContain("idle");
    expect(boxFor("Opening Range Breakout").disabled).toBe(false);
    expect(l.title).toContain("nothing is running it");
    await click(boxFor("Opening Range Breakout"));
    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MNQ", strategyKey: "orb", on: false }]);
  });

  it("mutes an unchecked line and adds no off text to it", async () => {
    await mount(line(rowFor(book({ playbooks: [ARMED_CELL, { ...OFF_CELL, strategyKey: "ema-bounce" }] }))));

    const [on, off] = Array.from(container!.querySelectorAll("label"));
    expect(boxFor("Opening Range Breakout").checked).toBe(true);
    expect(off.querySelector("input")!.checked).toBe(false);
    expect(off.textContent).toBe("Opening Range Breakout");
    expect(off.querySelector("span > span")!.className).toContain("text-[var(--muted)]");
    expect(on.querySelector("span > span")!.className).not.toContain("text-[var(--muted)]");
  });

  it("subtitles the card N of M on · N contracts, and adds the warnings only when there are some", async () => {
    await mount(line(rowFor(book({ playbooks: [ARMED_CELL, { ...OFF_CELL, ticker: "/MES", strategyKey: "relay" }] }))));
    expect(container!.textContent).toContain("1 of 2 on · 2 contracts");
    expect(container!.textContent).not.toContain("warning");
  });

  it("prints a fit warning under the playbook it is about, in a box that still turns off", async () => {
    const facts = {
      name: "Zeta Breakout 30m — MNQ",
      calibratedFor: "MNQ",
      intent: ["growth" as const],
      minimumRisk: { stopTicks: 695, cents: 34874, wholeUsd: 349 },
    };
    const under = buildBookGrid({ books: [book()], playbook: () => facts, risk: RISK, budgetUsd: () => 300 })[0];
    await mount(line(under));

    const l = lineFor("Zeta Breakout 30m");
    expect(l.textContent).not.toContain("— MNQ");
    expect(l.textContent).toContain(fitWarning(facts.minimumRisk, 300, 100)!);
    expect(container!.textContent).toContain("1 of 1 on · 1 contract · 1 warning");
    // A warning, not a refusal.
    expect(boxFor("Zeta Breakout 30m").disabled).toBe(false);
  });

  it("prints a refused box's sentence under it, not only in its title", async () => {
    await mount(
      line(rowFor(book({ playbooks: [{ ...OFF_CELL, conflict: { deploymentId: "d9", deploymentName: "Morning MNQ" } }] }))),
    );
    const l = lineFor("Opening Range Breakout");
    expect(boxFor("Opening Range Breakout").disabled).toBe(true);
    expect(l.textContent).toContain("Morning MNQ already trades /MNQ on this account over the same hours.");
  });

  it("links the risk label to the Risk page", async () => {
    await mount(line(rowFor(book())));
    const link = Array.from(container!.querySelectorAll("a")).find((a) => a.textContent === "Risk / trade")!;
    expect(link.getAttribute("href")).toBe("/settings/risk");
  });

  it("collapses a long column to the first few with +N more, and the header still counts them all", async () => {
    const n = CONTRACT_COLLAPSE_ABOVE + 2;
    const playbooks = Array.from({ length: n }, (_, i) => ({ ...ARMED_CELL, strategyKey: `p${i}` }));
    await mount(line(rowFor(book({ playbooks }))));

    expect(container!.querySelectorAll("label")).toHaveLength(CONTRACT_COLLAPSED_SHOWS);
    expect(container!.querySelector("h3")!.textContent).toContain(`${n} of ${n} on`);

    await click(buttonWith(morePlaybooksLabel(n - CONTRACT_COLLAPSED_SHOWS)));
    expect(container!.querySelectorAll("label")).toHaveLength(n);
    await click(buttonWith(FEWER_PLAYBOOKS_LABEL));
    expect(container!.querySelectorAll("label")).toHaveLength(CONTRACT_COLLAPSED_SHOWS);
  });

  it("disables the switch's on and an off box's on while a leg is closing, with the 409's sentence", async () => {
    const offCell: BookPlaybookCell = { ...OFF_CELL, groupId: "g1", closing: true, closingOnArm: true };
    const offBook = rowFor(book({ enabled: false, closingOnSwitchOn: ["orb"], playbooks: [offCell] }));
    await mount(line(offBook));

    expect(bookSwitch().disabled).toBe(true);
    expect(bookSwitch().title).toBe(turnOnWouldRetractACloseRefusal(["Opening Range Breakout"], "book"));
    expect(boxFor("Opening Range Breakout").disabled).toBe(true);
    expect(lineFor("Opening Range Breakout").title).toBe(
      turnOnWouldRetractACloseRefusal([`Opening Range Breakout on ${offCell.ticker}`], "playbook"),
    );

    pressBook(offBook, recordBook);
    pressCell(offBook, offBook.cells[0], recordCell);
    expect(bookWrites).toEqual([]);
    expect(cellWrites).toEqual([]);
  });

  it("leaves the wind-down direction pressable while a leg is closing", () => {
    const row = rowFor(
      book({ enabled: true, playbooks: [{ ...ARMED_CELL, running: false, parentEnabled: false, closing: true }] }),
    );

    pressBook(row, recordBook);
    pressCell(row, row.cells[0], recordCell);

    expect(bookWrites).toEqual([{ id: "book-1", enabled: false }]);
    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MNQ", strategyKey: "orb", on: false }]);
  });

  it("renders the stamp, no boxes and no risk on a refused account", async () => {
    await mount(line(rowFor(book({ account: REFUSED_ACCOUNT }))));

    const stamp = Array.from(container!.querySelectorAll("span")).find((s) => s.textContent === "no auto-trade")!;
    expect(stamp.title).toBe(LIVE_ACCOUNT_REFUSAL);
    expect(container!.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
    expect(container!.textContent).not.toContain("$500");
  });

});

// ── The phone layout (below `sm`) ──────────────────────────────────────
// jsdom applies no media query, so these pin the classes and the DOM order
// that make the phone layout, and that every phone rule is `sm:`-gated.

function classesOf(el: Element | null | undefined): string[] {
  return el?.className.split(/\s+/) ?? [];
}

describe("the phone layout", () => {
  it("gives an account card's left block the whole row below sm and its flex-1 back from sm", async () => {
    await mount(line(rowFor(book()), { expanded: false, onToggleExpanded: () => {} }));
    const left = container!.querySelector("header")!.firstElementChild!;
    expect(classesOf(left)).toEqual(expect.arrayContaining(["min-w-0", "basis-full", "sm:flex-1"]));
    expect(classesOf(left)).not.toContain("flex-1");
  });

  it("draws the switch on the id's line before the summary on a phone, and in the right cluster from sm", async () => {
    await mount(line(rowFor(book({ enabled: false })), { expanded: false, onToggleExpanded: () => {} }));
    const [phone, desk] = Array.from(container!.querySelectorAll<HTMLButtonElement>("[role='switch']"));
    const id = container!.querySelector("button[aria-expanded]")!;

    expect(classesOf(phone.parentElement)).toContain("sm:hidden");
    expect(classesOf(desk.parentElement)).toEqual(expect.arrayContaining(["hidden", "sm:contents"]));
    // One line: the id and the phone switch share a row that dissolves from sm.
    expect(phone.parentElement!.parentElement).toBe(id.parentElement);
    expect(classesOf(id.parentElement)).toEqual(expect.arrayContaining(["basis-full", "sm:contents"]));
    const summary = Array.from(container!.querySelectorAll("p")).find((p) => p.textContent?.includes("of 1 on"))!;
    expect(phone.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Both copies are the one control: same title, same state, same press.
    expect(phone.title).toBe(desk.title);
    expect(phone.getAttribute("aria-checked")).toBe(desk.getAttribute("aria-checked"));
    await click(phone);
    expect(bookWrites).toEqual([{ id: "book-1", enabled: true }]);
  });

  it("puts the stamps on their own line under the id on a phone", async () => {
    const row = rowFor(gated({ refusal: { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL } }));
    await mount(line(row));
    const stamp = Array.from(container!.querySelectorAll("span")).find((s) => s.textContent === "Dead")!;
    const idRow = container!.querySelector("[role='switch']")!.parentElement!.parentElement!;
    // Siblings in the wrapping line, after a row that takes the full basis.
    expect(stamp.parentElement).toBe(idRow.parentElement);
    expect(classesOf(idRow)).toContain("basis-full");
  });

  it("ends the card header with the risk at the left and the ⋯ at the right on a phone", async () => {
    await mount(line(rowFor(book({ enabled: false, removeRefusal: null })), { onRemove: () => {} }));
    const riskLink = Array.from(container!.querySelectorAll("a")).find((a) => a.textContent === "Risk / trade")!;
    const cluster = menuButton()!.parentElement!.parentElement!;
    expect(cluster.contains(riskLink)).toBe(true);
    expect(classesOf(cluster)).toEqual(expect.arrayContaining(["w-full", "sm:w-auto", "justify-end"]));
    expect(classesOf(riskLink.parentElement)).toEqual(expect.arrayContaining(["mr-auto", "sm:mr-0"]));
  });

  it("makes each playbook line a 44px target below sm and its desk size from sm", async () => {
    await mount(line(rowFor(book())));
    const l = lineFor("Opening Range Breakout");
    expect(classesOf(l)).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0", "sm:block"]));
    expect(classesOf(l.querySelector("span > span"))).toContain("text-sm");
  });

  it("gives +N more a 44px target below sm, wording unchanged", async () => {
    const n = CONTRACT_COLLAPSE_ABOVE + 1;
    const playbooks = Array.from({ length: n }, (_, i) => ({ ...ARMED_CELL, strategyKey: `p${i}` }));
    await mount(line(rowFor(book({ playbooks }))));
    const more = buttonWith(morePlaybooksLabel(n - CONTRACT_COLLAPSED_SHOWS));
    expect(more.textContent).toBe(morePlaybooksLabel(n - CONTRACT_COLLAPSED_SHOWS));
    expect(classesOf(more)).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0"]));
  });

  it("drops What's in this book to its own line, left-aligned, below sm", async () => {
    await mount(card(cardsFor([book()])[0]));
    const toggle = buttonWith(WHATS_IN_BOOK_LABEL);
    expect(classesOf(toggle)).toContain("sm:ml-auto");
    expect(classesOf(toggle)).not.toContain("ml-auto");
    const brk = toggle.previousElementSibling!;
    expect(classesOf(brk)).toEqual(expect.arrayContaining(["basis-full", "sm:hidden"]));
  });
});

describe("a book's section", () => {
  const TWO = () =>
    cardsFor([
      book({ id: "a", accountId: 1 }),
      book({ id: "b", accountId: 2, account: { name: "PRAC-V2-1-2", broker: "topstep", autoTrade: { permitted: true } } }),
    ])[0];

  it("heads the section with the book's counts and draws one card per account, the list only on the cards", async () => {
    await mount(card(TWO()));

    expect(container!.querySelector("h2")!.textContent).toBe("Cash");
    expect(container!.querySelector("header")!.textContent).toContain("1 playbook · MNQ · 2 accounts");
    // A switch per account at each breakpoint: the phone copy and the desk one.
    expect(container!.querySelectorAll(".hidden [role='switch']")).toHaveLength(2);
    expect(container!.querySelectorAll("[role='switch']")).toHaveLength(4);
    // One box per account; the section draws no list of its own.
    expect(container!.querySelectorAll("input[type='checkbox']")).toHaveLength(2);
    // No name to edit, nothing to arm in the book.
    expect(container!.querySelector("h2 button")).toBeNull();
    expect(buttonWith("New Book")).toBeUndefined();
  });

  it("expands the read-only definition from What's in this book, and folds it back", async () => {
    const model = buildBookCards({
      codeBooks: [{ key: "cash", name: "Cash", cells: [
        { ticker: "/MNQ", strategyKey: "orb", inBuild: true },
        { ticker: "/MNQ", strategyKey: "noise", inBuild: true },
      ] }],
      books: [book({ playbooks: [ARMED_CELL] })],
      playbook: (k) => (k === "orb" ? ORB() : { name: "Zeta Breakout 30m", calibratedFor: "MNQ", intent: [] }),
      risk: RISK,
    })[0];
    await mount(card(model));
    const toggle = buttonWith(WHATS_IN_BOOK_LABEL);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container!.textContent).not.toContain("Zeta Breakout 30m");

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const chip = Array.from(container!.querySelectorAll<HTMLElement>("span[title]")).find(
      (s) => s.textContent === "Zeta Breakout 30m",
    );
    expect(chip).toBeDefined();
    // Read-only: the definition adds no box.
    expect(container!.querySelectorAll("input[type='checkbox']")).toHaveLength(1);

    await click(toggle);
    expect(container!.textContent).not.toContain("Zeta Breakout 30m");
  });

  it("draws a book no account runs as the empty card: its chips by contract and a deploy link with the book picked", async () => {
    const opened: string[] = [];
    await mount(card(cardsFor([])[0], { onDeploy: (key) => opened.push(key) }));

    expect(container!.textContent).toContain(BOOK_NO_ACCOUNTS);
    expect(container!.querySelector("header")!.textContent).toContain("1 playbook · MNQ · no accounts");
    expect(container!.textContent).toContain("MNQ");
    expect(container!.querySelector("span[title]")!.textContent).toBe("Opening Range Breakout");
    expect(buttonWith(WHATS_IN_BOOK_LABEL)).toBeUndefined();

    await click(buttonWith(deployBookToLabel("Cash")));
    expect(opened).toEqual(["cash"]);
  });

  it("puts accounts not on a book in a section of their own that says why, with no deploy and no definition", async () => {
    const cards = cardsFor([book({ id: "x", bookKey: null, enabled: false })]);
    await mount(card(cards[1]));

    expect(container!.querySelector("h2")!.textContent).toBe(UNBOOKED_TITLE);
    expect(cards[1].note).toMatch(/kept the playbooks they had/);
    expect(container!.textContent).toContain(cards[1].note);
    expect(buttonWith(deployBookToLabel(UNBOOKED_TITLE))).toBeUndefined();
    expect(buttonWith(WHATS_IN_BOOK_LABEL)).toBeUndefined();
    // Its switch is not turned on here; the move to a book is.
    expect(bookSwitch().disabled).toBe(true);
    expect(bookSwitch().title).toBe(unbookedSwitchTitle(["Cash"]));
  });

  it("offers Move to <book> in the ⋯ of an account not on a book", async () => {
    const cards = cardsFor([book({ id: "x", bookKey: null })]);
    const opened: Array<{ id: string; to: string }> = [];
    await mount(
      card(cards[1], {
        account: {
          busy: false,
          onToggleBook: recordBook,
          onToggleCell: recordCell,
          moveTo: { targets: [{ id: "cash", name: "Cash" }], onOpen: (row, to) => opened.push({ id: row.id, to }) },
        },
      }),
    );
    await click(menuButton()!);
    await click(buttonWith(moveToLabel("Cash")));
    expect(opened).toEqual([{ id: "x", to: "cash" }]);
  });
});

// ── The account-state gate ─────────────────────────────────────────────

function gated(state: Partial<AccountGateWire>, over: Partial<BookPayload> = {}): BookPayload {
  return book({
    account: {
      name: PRAC_NAME,
      broker: "topstep",
      autoTrade: { permitted: true },
      state: { accountId: 1, name: PRAC_NAME, refusal: null, warning: null, replacements: [], ...state },
    },
    ...over,
  });
}

describe.each([
  { kind: "dead" as const, stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
  { kind: "locked" as const, stamp: "Locked", reason: lockedRefusal(null, null) },
  { kind: "oco-off" as const, stamp: "OCO Off", reason: AUTO_OCO_OFF_REFUSAL },
  { kind: "oco-unknown" as const, stamp: "OCO Unknown", reason: AUTO_OCO_UNKNOWN_REFUSAL },
  { kind: "locked" as const, stamp: "DLL", reason: lockedRefusal("daily loss limit reached", null) },
  { kind: "locked" as const, stamp: "Profit Target", reason: lockedRefusal("daily profit target reached", null) },
  { kind: "dead" as const, stamp: "Max Loss", reason: "This account can no longer trade (maximum loss limit reached)." },
])("an account the state gate refuses as $kind, stamped $stamp", (refusal) => {
  it("greys the on direction with the server's sentence and stamps the account", async () => {
    const row = rowFor(gated({ refusal }, { enabled: false, playbooks: [OFF_CELL] }));
    await mount(line(row));

    expect(bookSwitch().disabled).toBe(true);
    expect(bookSwitch().title).toBe(refusal.reason);
    expect(boxFor("Opening Range Breakout").disabled).toBe(true);
    expect(lineFor("Opening Range Breakout").title).toBe(refusal.reason);
    expect(container!.textContent).toContain(refusal.stamp);
    // Rendered in the casing the string carries, not upper-cased by its class.
    const stamp = Array.from(container!.querySelectorAll("span")).find((s) => s.textContent === refusal.stamp);
    expect(stamp?.className.split(/\s+/)).not.toContain("uppercase");
    expect(stamp?.className.split(/\s+/)).toContain("text-[var(--danger)]");
    expect(stamp?.title).toBe(refusal.reason);

    pressBook(row, recordBook);
    pressCell(row, row.cells[0], recordCell);
    expect(bookWrites).toEqual([]);
    expect(cellWrites).toEqual([]);
  });

  it("leaves the wind-down live: an on book turns off and an on box turns off", () => {
    const row = rowFor(gated({ refusal }, { enabled: true, playbooks: [ARMED_CELL] }));
    pressBook(row, recordBook);
    pressCell(row, row.cells[0], recordCell);
    expect(bookWrites).toEqual([{ id: "book-1", enabled: false }]);
    expect(cellWrites).toEqual([{ id: "book-1", ticker: "/MNQ", strategyKey: "orb", on: false }]);
  });
});

describe("Topstep's auto bracket on an account", () => {
  it("is stamped with the warning and leaves every control live", async () => {
    const warning = autoBracketWarning(300, 600);
    const row = rowFor(gated({ warning }, { enabled: false, playbooks: [OFF_CELL] }));
    await mount(line(row));

    const stamp = Array.from(container!.querySelectorAll<HTMLElement>("[title]")).find((el) => el.title === warning);
    expect(stamp).toBeDefined();
    expect(bookSwitch().disabled).toBe(false);
    expect(boxFor("Opening Range Breakout").disabled).toBe(false);
  });
});

describe("Move to replacement on an account's line", () => {
  let posts: Array<{ url: string; body: unknown }>;
  beforeEach(() => {
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posts.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) });
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("re-points the account's book on one press, and not before", async () => {
    const onMoved = vi.fn();
    const row = rowFor(
      gated({
        refusal: { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
        replacements: [{ accountId: 7, name: "PRAC-V2-100200-77777777" }],
      }),
    );
    await mount(line(row, { move: { token: "test-token", onMoved } }));
    expect(posts).toEqual([]);

    await click(buttonWith(MOVE_TO_REPLACEMENT_LABEL));

    expect(posts).toEqual([{ url: "/api/deployments/move-account", body: { fromAccountId: 1, toAccountId: 7 } }]);
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  it("is not drawn on a dead account with no replacement", async () => {
    const row = rowFor(gated({ refusal: { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL } }));
    await mount(line(row, { move: { token: "test-token", onMoved: () => {} } }));
    expect(buttonWith(MOVE_TO_REPLACEMENT_LABEL)).toBeUndefined();
  });
});

describe("display privacy on an account's line", () => {
  const REPLACEMENT = "PRAC-V2-100200-77777777";
  /** The shape `maxLossReason` writes inside `deadRefusal` (copy.md, *A lock reason the app writes*). */
  const MAX_LOSS =
    "This account can no longer trade (maximum loss limit reached: balance $47,999.99 is at or under its $48,000.00 floor). Use another account.";

  beforeEach(() => {
    localStorage.clear();
    trading.accounts = [
      { id: 1, name: PRAC_NAME },
      { id: 7, name: REPLACEMENT },
    ];
  });
  afterEach(() => {
    trading.accounts = [];
  });

  const deadRow = () =>
    rowFor(
      gated({
        refusal: { kind: "dead", stamp: "Dead", reason: MAX_LOSS },
        replacements: [{ accountId: 7, name: REPLACEMENT }],
      }),
    );

  it("reads the whole alias with account IDs hidden, the replacement included", async () => {
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    await mount(<PrivacyProvider>{line(deadRow(), { move: { token: "test-token", onMoved: () => {} } })}</PrivacyProvider>);

    expect(container!.querySelector("section")?.getAttribute("aria-label")).toBe("Account 1");
    expect(container!.querySelector("header .font-mono")?.textContent).toBe("Account 1");
    expect(buttonWith(MOVE_TO_REPLACEMENT_LABEL).textContent).toContain("→ Account 2");
    expect(container!.innerHTML).not.toContain(PRAC_NAME);
    expect(container!.innerHTML).not.toContain(REPLACEMENT);
  });

  it("masks the balance a dead account's reason states, with balances hidden", async () => {
    localStorage.setItem(HIDE_BALANCES_KEY, "true");
    await mount(<PrivacyProvider>{line(deadRow())}</PrivacyProvider>);

    expect(container!.textContent).toContain(`balance ${MASKED_USD} is at or under its ${MASKED_USD} floor`);
    expect(container!.innerHTML).not.toContain("$47,999.99");
    // IDs were not asked to hide.
    expect(container!.textContent).toContain(PRAC_NAME);
  });

  it("is the line as before with both switches off", async () => {
    await mount(<PrivacyProvider>{line(deadRow())}</PrivacyProvider>);
    expect(container!.querySelector("section")?.getAttribute("aria-label")).toBe(PRAC_NAME);
    expect(container!.textContent).toContain("$47,999.99");
  });
});

describe("the Move dialog", () => {
  const NAMES: Record<string, string> = { orb: "Opening Range Breakout", noise: "Zeta Breakout 30m", relay: "Relay" };
  const LINES: MovePreview = {
    lines: [
      { ticker: "/MNQ", strategyKey: "orb", step: "keeps", willClose: false },
      { ticker: "/MNQ", strategyKey: "noise", step: "stops", willClose: true },
      { ticker: "/MES", strategyKey: "relay", step: "starts", willClose: false },
    ],
    refusal: null,
  };

  function dialog(over: Partial<MoveDialogProps> = {}): ReactElement {
    return (
      <MoveDialog
        row={rowFor(book())}
        targets={[{ id: "combine", name: "Combine" }, { id: "growth", name: "Growth" }]}
        initialTarget="combine"
        preview={async () => LINES}
        nameOf={(k) => NAMES[k] ?? k}
        busy={false}
        refusal={null}
        onMove={async () => true}
        onClose={() => {}}
        {...over}
      />
    );
  }

  function dialogText(): string {
    return container!.querySelector("[role='dialog']")!.textContent ?? "";
  }

  /** The text of each group — its heading, then its lines — skipping the book list, which is radios. */
  function groups(): string[] {
    return Array.from(container!.querySelectorAll("[role='dialog'] ul"))
      .filter((ul) => ul.querySelector("input") == null)
      .map((ul) => `${ul.previousElementSibling?.textContent} | ${ul.textContent}`);
  }

  it("lists what keeps running, what stops — naming the position it closes — and what starts, then moves on the press", async () => {
    const moves: Array<{ id: string; to: string }> = [];
    const preview = vi.fn(async () => LINES);
    const onClose = vi.fn();
    await mount(
      dialog({
        preview,
        onClose,
        onMove: async (row, to) => {
          moves.push({ id: row.id, to });
          return true;
        },
      }),
    );
    await settle(2);

    expect(preview).toHaveBeenCalledWith("book-1", "combine");
    expect(groups()).toEqual([
      "Keeps running | Opening Range Breakout/MNQ",
      `Stops | Zeta Breakout 30m/MNQ${MOVE_WILL_CLOSE}`,
      "Starts | Relay/MES",
    ]);
    expect(moves).toEqual([]);

    await click(buttonWith(MOVE_CONFIRM));
    await settle(2);
    // The press re-read the move before writing it.
    expect(preview).toHaveBeenCalledTimes(2);
    expect(moves).toEqual([{ id: "book-1", to: "combine" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a refused write, and prints the refusal it is handed", async () => {
    const onClose = vi.fn();
    const onMove = vi.fn(async () => false);
    await mount(dialog({ onClose, onMove, refusal: "The route's move refusal." }));
    await settle(2);
    await click(buttonWith(MOVE_CONFIRM));
    await settle(2);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogText()).toContain("The route's move refusal.");
  });

  it("moves nothing when the press's re-read no longer matches the lists, and draws the new ones", async () => {
    const STOPS_MORE: MovePreview = {
      lines: [...LINES.lines.slice(0, 2), { ticker: "/MES", strategyKey: "relay", step: "stops", willClose: true }],
      refusal: null,
    };
    let answer = LINES;
    const preview = vi.fn(async () => answer);
    const onMove = vi.fn(async () => true);
    const onClose = vi.fn();
    await mount(dialog({ preview, onMove, onClose }));
    await settle(2);
    expect(groups()).toContain("Starts | Relay/MES");

    answer = STOPS_MORE;
    await click(buttonWith(MOVE_CONFIRM));
    await settle(2);

    expect(onMove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogText()).toContain(MOVE_PREVIEW_CHANGED);
    expect(groups()).toEqual([
      "Keeps running | Opening Range Breakout/MNQ",
      `Stops | Zeta Breakout 30m/MNQ${MOVE_WILL_CLOSE}Relay/MES${MOVE_WILL_CLOSE}`,
    ]);

    // A second press over the lists now on screen goes through.
    await click(buttonWith(MOVE_CONFIRM));
    await settle(2);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reads the move again for another book picked in the dialog, and moves there", async () => {
    const moves: string[] = [];
    const preview = vi.fn(async () => LINES);
    await mount(
      dialog({
        preview,
        onMove: async (_row, to) => {
          moves.push(to);
          return true;
        },
      }),
    );
    await settle(2);

    const growth = Array.from(container!.querySelectorAll<HTMLLabelElement>("label")).find(
      (l) => l.textContent === "Growth",
    )!;
    await click(growth.querySelector("input")!);
    await settle(2);

    expect(preview).toHaveBeenLastCalledWith("book-1", "growth");
    await click(buttonWith(MOVE_CONFIRM));
    await settle(2);
    expect(moves).toEqual(["growth"]);
  });

  it("blocks the whole move on a refusal, printing the route's sentence", async () => {
    const moves: string[] = [];
    await mount(
      dialog({
        preview: async () => ({ lines: LINES.lines, refusal: "Relay is still closing a position." }),
        onMove: async (_row, to) => {
          moves.push(to);
          return true;
        },
      }),
    );
    await settle(2);

    expect(buttonWith(MOVE_CONFIRM).disabled).toBe(true);
    expect(container!.querySelector("[role='dialog']")!.textContent).toContain("Relay is still closing a position.");
    expect(moveIntent({ lines: [], refusal: "x" })).toBe("inert");
    expect(moveIntent(null)).toBe("inert");
    expect(moves).toEqual([]);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    await mount(dialog({ onClose }));
    await key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape, the backdrop and Cancel while a write is out", async () => {
    const onClose = vi.fn();
    await mount(dialog({ onClose, busy: true }));
    await settle(2);

    await key(document.body, "Escape");
    const backdrop = container!.querySelector("[role='dialog']")!.parentElement!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(buttonWith("Cancel").disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // The same gestures close it once the write has answered.
    await act(async () => root!.render(dialog({ onClose, busy: false })));
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus in on open, keeps Tab inside, and returns focus to the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      await mount(dialog());
      await settle(2);
      const panel = container!.querySelector<HTMLElement>("[role='dialog']")!;
      // The first stop is the picked book's radio.
      expect(document.activeElement).toBe(panel.querySelector("input[type='radio']:checked"));

      const move = buttonWith(MOVE_CONFIRM);
      move.focus();
      await key(move, "Tab");
      expect(document.activeElement).toBe(panel.querySelector("input[type='radio']:checked"));
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
      });
      expect(document.activeElement).toBe(move);

      await act(async () => root!.unmount());
      root = null;
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });
});

describe("Remove from account, in an account's ⋯ menu", () => {
  const removes: string[] = [];
  const recordRemove = (row: BookGridRow) => removes.push(row.id);
  beforeEach(() => {
    removes.length = 0;
  });

  it("is reachable only through the menu, and removes on the second press, not the first", async () => {
    const row = rowFor(book({ enabled: false, playbooks: [OFF_CELL], removeRefusal: null }));
    await mount(line(row, { onRemove: recordRemove }));

    expect(buttonWith(REMOVE_BOOK_LABEL)).toBeUndefined();
    await click(menuButton()!);
    const remove = buttonWith(REMOVE_BOOK_LABEL);
    expect(remove.disabled).toBe(false);
    expect(remove.title).toBe(REMOVE_BOOK_TITLE);

    await click(remove);
    expect(removes).toEqual([]);
    await click(buttonWith(REMOVE_BOOK_CONFIRM));
    expect(removes).toEqual(["book-1"]);
  });

  it("forgets a half-made confirm when the menu closes", async () => {
    const row = rowFor(book({ enabled: false, playbooks: [OFF_CELL], removeRefusal: null }));
    await mount(line(row, { onRemove: recordRemove }));

    await click(menuButton()!);
    await click(buttonWith(REMOVE_BOOK_LABEL));
    await key(document.body, "Escape");
    expect(buttonWith(REMOVE_BOOK_CONFIRM)).toBeUndefined();

    await click(menuButton()!);
    await click(buttonWith(REMOVE_BOOK_LABEL));
    expect(removes).toEqual([]);
  });

  it("disarms a Confirm? left showing on the Risk page's Clear timer", async () => {
    vi.useFakeTimers();
    try {
      const row = rowFor(book({ enabled: false, playbooks: [OFF_CELL], removeRefusal: null }));
      await mount(line(row, { onRemove: recordRemove }));
      await click(menuButton()!);
      await click(buttonWith(REMOVE_BOOK_LABEL));

      await act(async () => {
        vi.advanceTimersByTime(ARM_MS - 1);
      });
      expect(buttonWith(REMOVE_BOOK_CONFIRM)).toBeDefined();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(buttonWith(REMOVE_BOOK_CONFIRM)).toBeUndefined();

      await click(buttonWith(REMOVE_BOOK_LABEL));
      expect(removes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is inert while the book is on or a playbook has not closed, and says why in the menu", async () => {
    const row = rowFor(book({ enabled: true, removeRefusal: REMOVE_BOOK_REFUSAL }));
    await mount(line(row, { onRemove: recordRemove }));

    await click(menuButton()!);
    const remove = buttonWith(REMOVE_BOOK_LABEL);
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe(REMOVE_BOOK_REFUSAL);
    expect(container!.querySelector("[role='menu']")!.textContent).toContain(REMOVE_BOOK_REFUSAL);
    pressRemove(row, recordRemove);
    expect(removes).toEqual([]);
  });

  it("is offered on an account the live-account block refuses — a remove only winds down", async () => {
    const row = rowFor(book({ enabled: false, account: REFUSED_ACCOUNT, removeRefusal: null }));
    await mount(line(row, { onRemove: recordRemove }));

    await click(menuButton()!);
    expect(buttonWith(REMOVE_BOOK_LABEL).disabled).toBe(false);
  });

  it("draws no menu when there is nothing in it", async () => {
    await mount(line(rowFor(book()), { onRemove: recordRemove }));
    expect(menuButton()).toBeNull();
  });
});

// ── The screen ─────────────────────────────────────────────────────────

/** A route's refusal: `stubBooks` answers it non-ok with `{ error }`, as the routes do. */
class Refused {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}

function stubBooks(
  respond: (url: string, method: string, body: unknown) => unknown,
): Array<{ url: string; method: string; body: unknown }> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body == null ? null : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      const answer = respond(url, method, body);
      if (answer instanceof Refused) {
        return { ok: false, status: answer.status, json: async () => ({ error: answer.error }) } as Response;
      }
      return { ok: true, json: async () => answer ?? {} } as Response;
    }),
  );
  return calls;
}

describe("the Books screen", () => {
  afterEach(() => {
    trading.accounts = [];
    trading.accountCatalogWarning = null;
    trading.noBroker = false;
    vi.unstubAllGlobals();
  });

  it("with no broker, still draws the code books and their playbooks, and disables both deploys with the sentence", async () => {
    trading.noBroker = true;
    stubBooks((url) => (url === "/api/books" ? { books: [], codeBooks: [CASH], accounts: [] } : {}));

    await mount(<BookGrid />);
    await settle();

    expect(container!.querySelector("section[aria-label='Cash'] header")!.textContent).toContain("1 playbook");
    expect(container!.textContent).toContain("MNQ");
    for (const label of [DEPLOY_BOOK_LABEL, deployBookToLabel("Cash")]) {
      const button = buttonWith(label)!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(NO_BROKER_COPY);
    }
    // Said on screen, not only in the tooltips.
    expect(container!.textContent!.split(NO_BROKER_COPY).length - 1).toBe(2);
    expect(container!.querySelector("[role='dialog']")).toBeNull();
  });

  it("says when a broker did not answer, on the page and above the Deploy dialog's account list", async () => {
    const WARNING = "Tradovate accounts could not be loaded — fetch failed";
    trading.accountCatalogWarning = WARNING;
    stubBooks((url) =>
      url === "/api/books" ? { books: [book()], codeBooks: [CASH], accounts: [] } : {},
    );

    await mount(<BookGrid />);
    await settle();

    const page = container!.querySelector("[role='alert']");
    expect(page?.textContent).toContain(WARNING);

    await click(buttonWith(DEPLOY_BOOK_LABEL));
    const dialog = container!.querySelector("[role='dialog']")!;
    expect(dialog.textContent).toContain(WARNING);
  });

  it("renders no catalogue warning when every broker answered", async () => {
    stubBooks((url) =>
      url === "/api/books" ? { books: [book()], codeBooks: [CASH], accounts: [] } : {},
    );

    await mount(<BookGrid />);
    await settle();

    expect(container!.querySelector("[role='alert']")).toBeNull();
  });

  it("runs one account-status check on open, then re-reads the accounts and the books", async () => {
    const calls = stubBooks((url) => (url === "/api/books" ? { books: [], codeBooks: [], accounts: [] } : {}));
    trading.reloadAccounts.mockClear();

    await mount(<BookGrid />);
    await settle();

    expect(calls.filter((c) => c.url === "/api/accounts/status").map((c) => c.method)).toEqual(["POST"]);
    expect(trading.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === "/api/books")).toHaveLength(2);
    expect(container!.textContent).toContain(BOOKS_EMPTY);
  });

  it("removes an account's book on the confirmed press, and its line leaves the card once the server stops listing it", async () => {
    let removed = false;
    const calls = stubBooks((url, method) => {
      if (method === "DELETE") removed = true;
      return url === "/api/books"
        ? {
            books: removed ? [] : [book({ enabled: false, playbooks: [OFF_CELL], removeRefusal: null })],
            codeBooks: [CASH],
            accounts: [],
          }
        : {};
    });

    await mount(<BookGrid />);
    await settle();
    await click(menuButton()!);
    await click(buttonWith(REMOVE_BOOK_LABEL));
    await click(buttonWith(REMOVE_BOOK_CONFIRM));
    await settle(3);

    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/books/book-1"]);
    expect(container!.textContent).toContain(BOOK_NO_ACCOUNTS);
  });

  const SECOND = "PRAC-V2-100200-22222222";
  const account = (id: number, name: string) => ({
    id, name, balance: 0, canTrade: true, isVisible: true, broker: "topstep" as const, practice: true,
    autoTrade: { permitted: true as const },
  });
  const COMBINE: CodeBookPayload = { key: "combine", name: "Combine", cells: [{ ticker: "/MNQ", strategyKey: "orb", inBuild: true }] };

  /** The dialog's radio for the row whose text includes `text`. */
  function radioFor(text: string): HTMLInputElement {
    const rows = Array.from(container!.querySelectorAll<HTMLLabelElement>("[role='dialog'] label"));
    return rows.find((l) => l.textContent?.includes(text))!.querySelector("input")!;
  }
  function deployPress(): HTMLButtonElement {
    return Array.from(container!.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find(
      (b) => b.textContent === DEPLOY_CONFIRM,
    )!;
  }

  it("has exactly one Deploy control on the page, and no deploy on any section", async () => {
    stubBooks((url) =>
      url === "/api/books"
        ? {
            books: [book({ id: "a", accountId: 1 }), book({ id: "b", accountId: 2, bookKey: "combine" })],
            codeBooks: [CASH, COMBINE],
            accounts: [],
          }
        : {},
    );
    await mount(<BookGrid />);
    await settle();

    const deploys = Array.from(container!.querySelectorAll("button")).filter((b) => /^Deploy/.test(b.textContent ?? ""));
    expect(deploys.map((b) => b.textContent)).toEqual([DEPLOY_BOOK_LABEL]);
    expect(container!.querySelector("select")).toBeNull();
  });

  it("stacks the page header on a phone: title and view cluster on one line, the subtitle under it, Deploy full width", async () => {
    stubBooks((url) => (url === "/api/books" ? { books: [book()], codeBooks: [CASH], accounts: [] } : {}));
    await mount(<BookGrid title={<h1>Books</h1>} subtitle={<p>The subtitle.</p>} />);
    await settle();

    const h1 = container!.querySelector("h1")!;
    const titleLine = h1.parentElement!;
    expect(classesOf(titleLine)).toEqual(expect.arrayContaining(["flex", "sm:block"]));
    const [phoneFold, deskFold] = Array.from(
      container!.querySelectorAll<HTMLButtonElement>(`button[aria-label='${EXPAND_ALL_LABEL}']`),
    );
    expect(titleLine.contains(phoneFold)).toBe(true);
    expect(classesOf(titleLine.lastElementChild)).toContain("sm:hidden");
    expect(deskFold.closest(".hidden")).not.toBeNull();
    expect(classesOf(deskFold.closest(".hidden"))).toContain("sm:contents");
    expect(titleLine.nextElementSibling?.textContent).toBe("The subtitle.");

    const deploy = buttonWith(DEPLOY_BOOK_LABEL);
    expect(classesOf(deploy)).toEqual(
      expect.arrayContaining(["btn-emerald", "w-full", "min-h-9", "sm:w-auto", "sm:min-h-0"]),
    );
    expect(classesOf(deploy.parentElement)).toEqual(expect.arrayContaining(["basis-full", "sm:basis-auto"]));
  });

  it("folds every account card onto its header on load, and opens one or all of them", async () => {
    stubBooks((url) =>
      url === "/api/books"
        ? {
            books: [book({ id: "a", accountId: 1 }), book({ id: "b", accountId: 2, bookKey: "combine" })],
            codeBooks: [CASH, COMBINE],
            accounts: [],
          }
        : {},
    );
    await mount(<BookGrid />);
    await settle();

    const boxes = () => container!.querySelectorAll("input[type='checkbox']").length;
    const chevrons = () => Array.from(container!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))
      .filter((b) => b.querySelector(".font-mono") != null);
    expect(boxes()).toBe(0);
    expect(chevrons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);

    // The view cluster's fold segment: a glyph, named by its tooltip.
    const fold = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!;
    await click(chevrons()[0]);
    expect(boxes()).toBe(1);
    expect(fold(EXPAND_ALL_LABEL).title).toBe(EXPAND_ALL_LABEL);

    await click(fold(EXPAND_ALL_LABEL));
    expect(boxes()).toBe(2);
    await click(fold(COLLAPSE_ALL_LABEL));
    expect(boxes()).toBe(0);
  });

  it("greys each refused account in the Deploy dialog with the server's reason, and offers the rest", async () => {
    trading.accounts = [account(1, PRAC_NAME), account(2, SECOND), account(3, "PRAC-V2-100200-33333333")];
    const gates: AccountGateWire[] = [
      { accountId: 1, name: PRAC_NAME, refusal: { kind: "oco-off", stamp: "OCO Off", reason: AUTO_OCO_OFF_REFUSAL }, warning: null, replacements: [] },
      { accountId: 2, name: SECOND, refusal: null, warning: null, replacements: [] },
    ];
    stubBooks((url) =>
      url === "/api/books"
        ? { books: [book({ id: "c", accountId: 3, bookKey: "combine" })], codeBooks: [CASH, COMBINE], accounts: gates }
        : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    await click(radioFor("Cash"));

    const dialog = container!.querySelector("[role='dialog']")!;
    expect(radioFor(PRAC_NAME).disabled).toBe(true);
    expect(dialog.textContent).toContain("OCO Off");
    expect(dialog.textContent).toContain(AUTO_OCO_OFF_REFUSAL);
    // Already on a book: the deploy route's own sentence, naming the picked book.
    expect(radioFor("33333333").disabled).toBe(true);
    expect(dialog.textContent).toContain("on Combine");
    expect(dialog.textContent).toContain(accountHasBookRefusal("Combine", "Cash"));
    expect(radioFor(SECOND).disabled).toBe(false);
  });

  it("keeps Deploy disabled until both a book and an account are picked", async () => {
    trading.accounts = [account(2, SECOND)];
    const calls = stubBooks((url) => (url === "/api/books" ? { books: [], codeBooks: [CASH, COMBINE], accounts: [] } : {}));

    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    expect(deployPress().disabled).toBe(true);
    await click(radioFor(SECOND));
    expect(deployPress().disabled).toBe(true);
    await click(radioFor("Combine"));
    expect(deployPress().disabled).toBe(false);
    // The summary: what will be on, and that it arrives switched off.
    expect(container!.querySelector("[role='dialog']")!.textContent).toContain("What will be on");
    expect(container!.querySelector("[role='dialog']")!.textContent).toContain("Nothing runs until you switch it on.");
    expect(calls.some((c) => c.url === "/api/books/deploy")).toBe(false);
  });

  it("opens the Deploy dialog from the empty card's link with that book already picked", async () => {
    trading.accounts = [account(2, SECOND)];
    const calls = stubBooks((url, method) =>
      url === "/api/books"
        ? { books: [book({ id: "b", accountId: 9, bookKey: "combine" })], codeBooks: [CASH, COMBINE], accounts: [] }
        : method === "POST"
          ? { book: { id: "acct-2" } }
          : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(deployBookToLabel("Cash")));

    expect(radioFor("Cash").checked).toBe(true);
    expect(radioFor("Combine").checked).toBe(false);
    await click(radioFor(SECOND));
    await click(deployPress());
    await settle(3);
    expect(calls.filter((c) => c.url === "/api/books/deploy").map((c) => c.body)).toEqual([{ book: "cash", accountId: 2 }]);
  });

  it.each([
    [{ book: { id: "acct-2" } }, BOOK_DEPLOYED_HINT],
    [{ book: { id: "acct-2" }, restored: true }, BOOK_RESTORED_HINT],
  ])("deploys the picked book to the picked account, closes, and says it landed switched off (%#)", async (answer, hint) => {
    trading.accounts = [account(2, SECOND)];
    const calls = stubBooks((url, method) =>
      url === "/api/books" ? { books: [], codeBooks: [CASH], accounts: [] } : method === "POST" ? answer : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    await click(radioFor("Cash"));
    await click(radioFor(SECOND));
    await click(deployPress());
    await settle(3);

    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/books/deploy")).toEqual([
      { url: "/api/books/deploy", method: "POST", body: { book: "cash", accountId: 2 } },
    ]);
    expect(container!.querySelector("[role='dialog']")).toBeNull();
    expect(container!.textContent).toContain(hint);
  });

  it("keeps the Deploy dialog open on a refused deploy, with the route's sentence in it", async () => {
    trading.accounts = [account(2, SECOND)];
    const sentence = accountHasBookRefusal("Combine", "Cash");
    stubBooks((url, method) =>
      url === "/api/books"
        ? { books: [], codeBooks: [CASH], accounts: [] }
        : method === "POST" && url === "/api/books/deploy"
          ? new Refused(409, sentence)
          : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    await click(radioFor("Cash"));
    await click(radioFor(SECOND));
    await click(deployPress());
    await settle(3);

    const dialog = container!.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(sentence);
    // Printed once, in the dialog — not again in the page's band behind it.
    expect(container!.textContent!.split(sentence)).toHaveLength(2);
  });

  it("closes the Deploy dialog on Escape", async () => {
    stubBooks((url) => (url === "/api/books" ? { books: [], codeBooks: [CASH], accounts: [] } : {}));
    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    expect(container!.querySelector("[role='dialog']")).not.toBeNull();

    await key(document.body, "Escape");
    expect(container!.querySelector("[role='dialog']")).toBeNull();
  });

  it("says there are no accounts in the Deploy dialog once the books are read and none is connected", async () => {
    stubBooks((url) => (url === "/api/books" ? { books: [], codeBooks: [CASH], accounts: [] } : {}));
    await mount(<BookGrid />);
    await settle();
    await click(buttonWith(DEPLOY_BOOK_LABEL));
    expect(container!.querySelector("[role='dialog']")!.textContent).toContain(describeNoAccounts(false));
  });

  it("keeps the Move dialog open on a refused move, with the route's sentence in it", async () => {
    const sentence = "Relay is still closing a position on this account.";
    stubBooks((url, method) =>
      url === "/api/books"
        ? { books: [book()], codeBooks: [CASH, COMBINE], accounts: [] }
        : url.includes("/move?to=")
          ? { lines: [{ ticker: "/MNQ", strategyKey: "orb", step: "keeps", willClose: false }], refusal: null }
          : method === "POST" && url.endsWith("/move")
            ? new Refused(409, sentence)
            : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(menuButton()!);
    await click(buttonWith(moveToLabel("Combine")));
    await settle(3);
    await click(Array.from(container!.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent === MOVE_CONFIRM)!);
    await settle(3);

    const dialog = container!.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(sentence);
    expect(container!.textContent!.split(sentence)).toHaveLength(2);
  });

  it("opens the Move dialog from an account's ⋯ and posts the existing move route on the press", async () => {
    const calls = stubBooks((url) =>
      url === "/api/books"
        ? { books: [book()], codeBooks: [CASH, COMBINE], accounts: [] }
        : url.includes("/move?to=")
          ? { lines: [{ ticker: "/MNQ", strategyKey: "orb", step: "keeps", willClose: false }], refusal: null }
          : {},
    );

    await mount(<BookGrid />);
    await settle();
    await click(menuButton()!);
    await click(buttonWith(moveToLabel("Combine")));
    await settle(3);

    expect(container!.querySelector("[role='dialog']")!.textContent).toContain("Keeps running");
    await click(Array.from(container!.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent === MOVE_CONFIRM)!);
    await settle(3);
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body])).toContainEqual([
      "/api/books/book-1/move",
      { to: "combine" },
    ]);
  });

  it("offers no way to make, rename or delete a book — books are defined in code", async () => {
    stubBooks((url) => (url === "/api/books" ? { books: [book()], codeBooks: [CASH], accounts: [] } : {}));

    await mount(<BookGrid />);
    await settle();

    expect(buttonWith("New Book")).toBeUndefined();
    expect(container!.querySelector("h2 button")).toBeNull();
    expect(container!.querySelector("input[aria-label='Book name']")).toBeNull();
  });
});
